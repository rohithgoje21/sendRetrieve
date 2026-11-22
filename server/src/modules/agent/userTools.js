const Share = require("../shares/share.model");
const Notification = require("../notifications/notification.model");
const { ownerAnalytics } = require("../analytics/analytics.service");

const SORTS = {
    newest: { createdAt: -1 },
    expiring: { expiresAt: 1 },
    views: { views: -1 },
    downloads: { totalDownloads: -1 },
};

// Read-only tools scoped to one signed-in user's own data, for the "ask"
// assistant (server/src/modules/agent/agent.routes.js, POST /api/agent/me/ask).
// A small, self-contained query, not a reuse of myShares.routes.js's fuller
// search/filter/counts API: that route is more complex and already live, and
// duplicating ~10 lines here is safer than forcing a shared abstraction onto it.
const buildUserTools = (userId) => [
    {
        name: "list_my_shares",
        description: "Lists the signed-in user's own shares (not other users'): code, status, expiry, views, downloads.",
        input_schema: {
            type: "object",
            properties: {
                status: { type: "string", enum: ["active", "expired", "deleted"] },
                sort: { type: "string", enum: ["newest", "expiring", "views", "downloads"] },
                limit: { type: "integer", minimum: 1, maximum: 20 },
            },
            required: [],
        },
        handler: async (input) => {
            const now = new Date();
            const status = ["active", "expired", "deleted"].includes(input.status) ? input.status : "active";
            const sort = SORTS[input.sort] ?? SORTS.newest;
            const limit = Math.min(20, Math.max(1, Number.parseInt(input.limit, 10) || 10));
            const base = { ownerId: userId, uploadPending: { $ne: true } };
            const match =
                status === "active"
                    ? { ...base, endedAt: null, expiresAt: { $gt: now } }
                    : status === "expired"
                      ? { ...base, $or: [{ endedReason: { $in: ["expired", "used_up"] } }, { endedAt: null, expiresAt: { $lte: now } }] }
                      : { ...base, endedReason: { $in: ["deleted", "removed"] } };

            const shares = await Share.aggregate([
                { $match: match },
                { $addFields: { totalDownloads: { $sum: "$files.downloads" } } },
                { $sort: sort },
                { $limit: limit },
            ]);
            return JSON.stringify(
                shares.map((s) => ({
                    code: s.code,
                    hasText: Boolean(s.text),
                    fileCount: s.files.length,
                    views: s.views,
                    downloads: s.totalDownloads,
                    expiresAt: s.expiresAt,
                    passwordProtected: Boolean(s.passwordHash),
                }))
            );
        },
    },
    {
        name: "get_my_analytics",
        description: "The signed-in user's own activity over a period: views, downloads, bandwidth, shares created, top shares.",
        input_schema: {
            type: "object",
            properties: { days: { type: "integer", enum: [7, 30, 90], description: "Period length in days" } },
            required: [],
        },
        handler: async (input) => JSON.stringify(await ownerAnalytics(userId, [7, 30, 90].includes(input.days) ? input.days : 30)),
    },
    {
        name: "get_my_notifications_summary",
        description: "How many unread notifications the user has, and a few of the most recent.",
        input_schema: { type: "object", properties: {}, required: [] },
        handler: async () => {
            const [unread, recent] = await Promise.all([
                Notification.countDocuments({ userId, readAt: null }),
                Notification.find({ userId }).sort({ createdAt: -1 }).limit(5),
            ]);
            return JSON.stringify({ unread, recent: recent.map((n) => ({ title: n.title, createdAt: n.createdAt, read: Boolean(n.readAt) })) });
        },
    },
];

module.exports = { buildUserTools };
