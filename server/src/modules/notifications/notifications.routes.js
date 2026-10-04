const express = require("express");
const mongoose = require("mongoose");
const { z } = require("zod");
const Notification = require("./notification.model");
const PushSubscription = require("./pushSubscription.model");
const User = require("../users/user.model");
const webPush = require("../../infrastructure/webPush");
const { EVENTS, resolvePreferences, preferencesSchema } = require("./preferences");
const { verifyUnsubscribeToken } = require("./unsubscribeTokens");
const { HttpError } = require("../../shared/errors");
const { validateBody } = require("../../shared/validate");
const { limiter } = require("../../shared/rateLimit");
const { requireAuth } = require("../auth/middleware");
const { describeDevice, deviceLabel } = require("../auth/devices");
const { notifyUser } = require("../realtime/realtime");

const PAGE_SIZE = 20;

const markRead = z
    .object({
        ids: z.array(z.string()).max(100).optional(),
        all: z.literal(true).optional(),
    })
    .refine((v) => v.ids || v.all, { message: "Say which notifications to mark as read" });

// What browsers send from PushManager.subscribe(), as JSON.
const pushSubscription = z.object({
    endpoint: z.url({ protocol: /^https$/, error: "endpoint must be an https URL" }).max(2048),
    keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
});

const preferencesResponse = (user) => ({
    preferences: resolvePreferences(user),
    events: Object.entries(EVENTS).map(([key, { label, security }]) => ({ key, label, security: Boolean(security) })),
    channels: {
        // Unverified addresses only get security alerts by email.
        email: { verified: Boolean(user.emailVerifiedAt) },
        push: { available: webPush.enabled(), publicKey: webPush.publicKey() },
    },
});

// /api/notifications: the bell (in-app notifications), notification
// preferences, browser push subscriptions, and unsubscribing from emails.
const createNotificationsRouter = (ctx) => {
    const router = express.Router();

    // Unsubscribe links in emails work without logging in: the signed token
    // says who and what. Mail apps' one-click unsubscribe POSTs here with the
    // token in the query string (RFC 8058); our page sends it in the body.
    router.post(
        "/unsubscribe",
        limiter(ctx, { name: "unsubscribe", limit: 30, error: "Too many requests. Please wait a few minutes." }),
        async (req, res) => {
            const claims = verifyUnsubscribeToken(req.body?.token ?? req.query.token);
            if (!claims || !EVENTS[claims.event] || !mongoose.isValidObjectId(claims.userId)) {
                throw new HttpError(400, "This unsubscribe link isn't valid.");
            }
            const user = await User.findById(claims.userId);
            if (!user) throw new HttpError(404, "This account no longer exists.");
            user.notificationPreferences = {
                ...(user.notificationPreferences ?? {}),
                [claims.event]: { ...resolvePreferences(user)[claims.event], email: false },
            };
            user.markModified("notificationPreferences");
            await user.save();
            req.log.info({ event: "notifications.unsubscribed", userId: user._id, type: claims.event }, "Unsubscribed from emails");
            res.json({ event: claims.event, label: EVENTS[claims.event].label });
        }
    );

    router.use(requireAuth);

    // Newest first; `before` (an ISO date from the last page) for more.
    router.get("/", async (req, res) => {
        const before = req.query.before ? new Date(req.query.before) : null;
        const filter = { userId: req.user._id, ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { $lt: before } } : {}) };
        const [items, unread] = await Promise.all([
            Notification.find(filter).sort({ createdAt: -1 }).limit(PAGE_SIZE + 1),
            Notification.countDocuments({ userId: req.user._id, readAt: null }),
        ]);
        res.set("Cache-Control", "no-store");
        res.json({
            notifications: items.slice(0, PAGE_SIZE).map((n) => n.toPublic()),
            unread,
            hasMore: items.length > PAGE_SIZE,
        });
    });

    router.post("/read", validateBody(markRead), async (req, res) => {
        const ids = (req.body.ids ?? []).filter((id) => mongoose.isValidObjectId(id));
        await Notification.updateMany(
            { userId: req.user._id, readAt: null, ...(req.body.all ? {} : { _id: { $in: ids } }) },
            { readAt: new Date() }
        );
        const unread = await Notification.countDocuments({ userId: req.user._id, readAt: null });
        // Other open tabs update their badge too.
        notifyUser(req.user._id, "notifications:read", { unread });
        res.json({ unread });
    });

    router.get("/preferences", (req, res) => {
        res.set("Cache-Control", "no-store");
        res.json(preferencesResponse(req.user));
    });

    router.put("/preferences", validateBody(preferencesSchema), async (req, res) => {
        const current = resolvePreferences(req.user);
        req.user.notificationPreferences = Object.fromEntries(
            Object.keys(EVENTS).map((event) => [event, { ...current[event], ...req.body.preferences[event] }])
        );
        req.user.markModified("notificationPreferences");
        await req.user.save();
        res.json(preferencesResponse(req.user));
    });

    // This browser agreed to push notifications (or renewed its subscription).
    router.post("/push-subscriptions", validateBody(pushSubscription), async (req, res) => {
        if (!webPush.enabled()) throw new HttpError(404, "Browser notifications aren't available on this server");
        const { endpoint, keys } = req.body;
        await PushSubscription.findOneAndUpdate(
            { endpoint },
            { userId: req.user._id, keys, deviceLabel: deviceLabel(describeDevice(req.get("user-agent"))) },
            { upsert: true }
        );
        req.log.info({ event: "notifications.push_subscribed" }, "Browser notifications turned on");
        res.status(201).json({ subscribed: true });
    });

    router.delete("/push-subscriptions", validateBody(z.object({ endpoint: z.string().max(2048) })), async (req, res) => {
        await PushSubscription.deleteOne({ userId: req.user._id, endpoint: req.body.endpoint });
        res.status(204).end();
    });

    return router;
};

module.exports = { createNotificationsRouter };
