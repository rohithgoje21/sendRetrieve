const config = require("../../config");
const User = require("../users/user.model");
const Notification = require("./notification.model");
const PushSubscription = require("./pushSubscription.model");
const mailer = require("../../infrastructure/mailer");
const webPush = require("../../infrastructure/webPush");
const { renderEmail } = require("./emailTemplates");
const { EVENTS, resolvePreferences } = require("./preferences");
const { createUnsubscribeToken } = require("./unsubscribeTokens");
const { notifyUser } = require("../realtime/realtime");

// Delivers one notification to a user, on each channel they've turned on for
// the event (see preferences.js). Called by the notification worker.
//
// Each channel is a separate step that runs at most once per `dedupeKey`
// (by default the queue message's ID): if email fails and the job is
// retried, the in-app notification isn't created twice.

const STEP_TTL_SECONDS = 7 * 24 * 60 * 60;

// An absolute link for emails (the worker has no request to take it from).
const appLink = (path) => (config.appUrl ? new URL(path, config.appUrl).href : path);

const once = async (kv, key, fn) => {
    const doneKey = `notified:${key}`;
    if (await kv.get(doneKey).catch(() => null)) return;
    await fn();
    await kv.set(doneKey, "1", STEP_TTL_SECONDS).catch(() => {});
};

// Runs `fn` unless it already ran for `cooldown.key` in the last
// `cooldown.seconds` (e.g. one email per share per hour).
const withCooldown = async (kv, cooldown, fn) => {
    if (!cooldown) return fn();
    if ((await kv.incr(`cooldown:${cooldown.key}`, cooldown.seconds)) > 1) return;
    try {
        await fn();
    } catch (err) {
        await kv.del(`cooldown:${cooldown.key}`).catch(() => {});
        throw err;
    }
};

// Creates the in-app notification, or merges it into a recent unread one in
// the same group (e.g. downloads of one share), and tells the user's open tabs.
const deliverInApp = async (user, event, content, group) => {
    let notification = null;
    if (group) {
        const recent = await Notification.findOne({
            userId: user._id,
            event,
            "data.group": group.key,
            readAt: null,
            createdAt: { $gte: new Date(Date.now() - group.windowSeconds * 1000) },
        });
        if (recent) {
            Object.assign(recent, group.merge(recent));
            recent.markModified("data");
            notification = await recent.save();
        }
    }
    notification ??= await Notification.create({
        userId: user._id,
        event,
        title: content.title,
        body: content.body ?? null,
        link: content.link ?? null,
        data: { ...content.data, ...(group ? { group: group.key } : {}) },
    });
    const unread = await Notification.countDocuments({ userId: user._id, readAt: null });
    notifyUser(user._id, "notification", { notification: notification.toPublic(), unread });
};

const deliverEmail = async (user, event, { template, data }) => {
    const token = createUnsubscribeToken(user._id, event);
    const rendered = renderEmail(template, { ...data, name: user.name, unsubscribeUrl: appLink(`/unsubscribe?token=${token}`) });
    await mailer.sendMail({
        to: user.email,
        ...rendered,
        // One-click unsubscribe in mail apps (RFC 8058).
        headers: {
            "List-Unsubscribe": `<${appLink(`/api/notifications/unsubscribe?token=${token}`)}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
    });
};

// To every browser the user turned push on in; forgets browsers that have
// since unsubscribed.
const deliverPush = async (user, event, content) => {
    const subscriptions = await PushSubscription.find({ userId: user._id });
    const payload = { title: content.title, body: content.body ?? "", url: content.link ?? "/", tag: content.tag ?? event };
    for (const subscription of subscriptions) {
        const result = await webPush.sendPush(subscription, payload);
        if (result === "gone") await PushSubscription.deleteOne({ _id: subscription._id });
        else if (result === "sent") await PushSubscription.updateOne({ _id: subscription._id }, { lastSuccessAt: new Date() });
    }
};

// Options:
//   userId, event      who, and which event in preferences.js
//   content            { title, body, link, tag, data } for in-app and push
//   email              { template, data }, if this event can be emailed
//   group              { key, windowSeconds, merge(existing) -> { title, body, data } }:
//                      merge into a recent unread in-app notification
//   cooldowns          { email, push }: { key, seconds } rate limits
//   dedupeKey          what makes delivery "the same" (default: the message ID)
const notify = async (ctx, message, { userId, event, content, email, group, cooldowns = {}, dedupeKey = message.id }) => {
    const user = await User.findById(userId, { email: 1, name: 1, emailVerifiedAt: 1, disabledAt: 1, notificationPreferences: 1 });
    if (!user || user.disabledAt) return;
    const wants = resolvePreferences(user)[event];
    const step = (channel, fn) => once(ctx.kv, `${dedupeKey}:${channel}`, fn);

    if (wants.inApp) await step("inApp", () => deliverInApp(user, event, content, group));
    // Unverified addresses only get security alerts: the address may not be theirs.
    if (wants.email && email && (user.emailVerifiedAt || EVENTS[event].security)) {
        await step("email", () => withCooldown(ctx.kv, cooldowns.email, () => deliverEmail(user, event, email)));
    }
    if (wants.push && webPush.enabled()) {
        await step("push", () => withCooldown(ctx.kv, cooldowns.push, () => deliverPush(user, event, content)));
    }
    ctx.log.info({ event: "notification.delivered", type: event, userId: String(user._id), channels: wants }, "Notification delivered");
};

module.exports = { notify, appLink };
