const { z } = require("zod");

// What users can be notified about, and how. Each event goes out on the
// channels the user has turned on for it:
//   inApp   the bell in the app (kept for a while, live over Socket.IO)
//   email   to the account's address (verified addresses only, except
//           security alerts, which always go out)
//   push    browser notifications (Web Push), on browsers the user enabled
//
// Defaults favor what matters: security alerts everywhere, downloads in the
// app and browser, email only for what's rare or important.
const EVENTS = {
    fileDownloaded: {
        label: "A file from one of your shares is downloaded",
        defaults: { inApp: true, email: false, push: true },
    },
    shareEnded: {
        label: "A share expires, is used up or is removed by an administrator",
        defaults: { inApp: true, email: false, push: false },
    },
    shareBlocked: {
        label: "A share is blocked because a file contains malware",
        defaults: { inApp: true, email: true, push: true },
    },
    newDevice: {
        label: "Your account is logged in to from a new device",
        defaults: { inApp: true, email: true, push: true },
        security: true,
    },
    weeklySummary: {
        label: "Weekly summary of your shares",
        defaults: { inApp: true, email: true, push: false },
    },
};

const CHANNELS = ["inApp", "email", "push"];

// The user's choices, with defaults for anything they haven't set.
const resolvePreferences = (user) => {
    const saved = user?.notificationPreferences ?? {};
    return Object.fromEntries(
        Object.entries(EVENTS).map(([event, { defaults }]) => [
            event,
            Object.fromEntries(CHANNELS.map((c) => [c, typeof saved[event]?.[c] === "boolean" ? saved[event][c] : defaults[c]])),
        ])
    );
};

// PUT /api/notifications/preferences: any subset of events and channels.
const preferencesSchema = z.object({
    preferences: z
        .object(
            Object.fromEntries(
                Object.keys(EVENTS).map((event) => [
                    event,
                    z.object(Object.fromEntries(CHANNELS.map((c) => [c, z.boolean().optional()]))).strict().optional(),
                ])
            )
        )
        .strict(),
});

module.exports = { EVENTS, CHANNELS, resolvePreferences, preferencesSchema };
