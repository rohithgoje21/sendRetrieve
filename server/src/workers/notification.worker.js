const config = require("../config");
const mailer = require("../infrastructure/mailer");
const { renderEmail } = require("../modules/notifications/emailTemplates");
const { notify, appLink } = require("../modules/notifications/notify");
const { summarizeWeek } = require("../modules/notifications/weeklySummary");
const { deviceLabel } = require("../modules/auth/devices");

// sr.notifications: emails requested by the API (verification codes,
// password resets), and notifications about events, delivered in-app, by
// email and by browser push as each user prefers (modules/notifications).
// A failing email or push service makes the job fail; the queue retries it
// with backoff, and circuit breakers keep retries from hammering a service
// that's down.

const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const { downloadCoalesceSeconds, downloadEmailCooldownSeconds, downloadPushCooldownSeconds } = config.notifications;

const ENDED_TITLES = {
    expired: (code) => `Share ${code} expired`,
    used_up: (code) => `Share ${code} was used up`,
    removed: (code) => `Share ${code} was removed by an administrator`,
};

const handlers = {
    "email.requested": async (message, { log }) => {
        const { template, to, data } = message.data;
        await mailer.sendMail({ to, ...renderEmail(template, data) });
        log.info({ event: "email.sent", template }, "Email sent");
    },

    // Owned shares only; downloads of one share within an hour are merged
    // into one in-app notification, and emailed at most once an hour.
    "file.downloaded": async (message, ctx) => {
        const { ownerId, shareId, code, fileName, downloads } = message.data;
        if (!ownerId) return;
        const shown = formatCode(code);
        await notify(ctx, message, {
            userId: ownerId,
            event: "fileDownloaded",
            content: {
                title: `"${fileName}" was downloaded`,
                body: `Share ${shown} · ${plural(downloads, "download")} of this file so far`,
                link: "/shares",
                tag: `download:${code}`,
                data: { code, count: 1 },
            },
            group: {
                key: `download:${shareId}`,
                windowSeconds: downloadCoalesceSeconds,
                merge: (existing) => {
                    const count = (existing.data?.count ?? 1) + 1;
                    return {
                        title: `Files from share ${shown} were downloaded ${count} times`,
                        body: `Latest: "${fileName}"`,
                        data: { ...existing.data, count },
                    };
                },
            },
            email: { template: "file-downloaded", data: { fileName, code: shown, downloads, sharesUrl: appLink("/shares") } },
            cooldowns: {
                email: { key: `email:download:${shareId}`, seconds: downloadEmailCooldownSeconds },
                push: { key: `push:download:${shareId}`, seconds: downloadPushCooldownSeconds },
            },
        });
    },

    // Expired, used up or removed by an admin. Not when the owner deleted it
    // (they know), nor malware (share.blocked says more).
    "share.ended": async (message, ctx) => {
        const { ownerId, code, reason, requeued } = message.data;
        if (!ownerId || requeued || !ENDED_TITLES[reason]) return;
        const shown = formatCode(code);
        await notify(ctx, message, {
            userId: ownerId,
            event: "shareEnded",
            content: { title: ENDED_TITLES[reason](shown), body: "Its files have been deleted.", link: "/shares", tag: `ended:${code}` },
            email: { template: "share-ended", data: { code: shown, reason, sharesUrl: appLink("/shares") } },
        });
    },

    "share.blocked": async (message, ctx) => {
        const { ownerId, code, fileName, signature } = message.data;
        if (!ownerId) return;
        const shown = formatCode(code);
        await notify(ctx, message, {
            userId: ownerId,
            event: "shareBlocked",
            content: {
                title: `Share ${shown} was blocked`,
                body: `"${fileName}" contains malware (${signature}). The share was removed and its files deleted.`,
                link: "/shares",
                tag: `blocked:${code}`,
            },
            email: { template: "share-blocked", data: { code: shown, fileName, signature, sharesUrl: appLink("/shares") } },
        });
    },

    // A login from a browser this account hasn't used before.
    "auth.login": async (message, ctx) => {
        const { userId, newDevice, device, ipHint, at, accountUrl } = message.data;
        if (!newDevice) return;
        const label = deviceLabel(device);
        await notify(ctx, message, {
            userId,
            event: "newDevice",
            content: {
                title: `New login from ${label}`,
                body: `${ipHint ? `Network ${ipHint}. ` : ""}If this wasn't you, log that device out and change your password.`,
                link: "/account",
                tag: "new-device",
            },
            email: { template: "new-device-login", data: { device: label, ipHint, at, accountUrl: accountUrl ?? appLink("/account") } },
        });
    },

    "summary.weekly": async (message, ctx) => {
        const { userId, from, to, week } = message.data;
        const summary = await summarizeWeek(userId, new Date(from), new Date(to));
        if (!summary.sharesCreated && !summary.activeShares && !summary.views) return; // nothing to tell
        const parts = [
            plural(summary.sharesCreated, "new share"),
            plural(summary.views, "view"),
            ...(summary.visitors ? [`~${plural(summary.visitors, "visitor")}`] : []),
            plural(summary.downloads, "download"),
            `${summary.activeShares} active`,
        ];
        await notify(ctx, message, {
            userId,
            event: "weeklySummary",
            content: { title: "Your week on sendRetrieve", body: parts.join(" · "), link: "/shares", tag: "weekly-summary" },
            email: { template: "weekly-summary", data: { ...summary, sharesUrl: appLink("/shares") } },
            // Once per user and week, even if the week's jobs were queued twice.
            dedupeKey: `weekly:${userId}:${week}`,
        });
    },
};

const handle = async (message, ctx) => {
    const handler = handlers[message.type];
    if (handler) await handler(message, ctx);
};

module.exports = { queue: "sr.notifications", handle };
