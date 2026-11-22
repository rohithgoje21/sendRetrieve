const User = require("../users/user.model");
const { getSiteStats } = require("../admin/admin.service");
const { siteAnalytics } = require("../analytics/analytics.service");
const { getBus, isQueue } = require("../../infrastructure/queue");

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Read-only tools over site-wide data, for the admin "ask" assistant
// (server/src/modules/agent/agent.routes.js, POST /api/agent/admin/ask).
// Deliberately no mutating tools (no disable/logout/replay/purge): those stay
// manual admin-panel actions, not something a model can trigger.
const buildAdminTools = () => [
    {
        name: "get_site_stats",
        description: "Overall site stats right now: user counts, active/uploading shares, storage used, total views and downloads.",
        input_schema: { type: "object", properties: {}, required: [] },
        handler: async () => JSON.stringify(await getSiteStats()),
    },
    {
        name: "get_site_analytics",
        description: "Site-wide activity over a period: views, downloads, bandwidth, shares created, file types, compared to the previous period.",
        input_schema: {
            type: "object",
            properties: { days: { type: "integer", enum: [7, 30, 90], description: "Period length in days" } },
            required: [],
        },
        handler: async (input) => JSON.stringify(await siteAnalytics([7, 30, 90].includes(input.days) ? input.days : 30)),
    },
    {
        name: "search_users",
        description: "Find users by name or email; returns a small page of matches with their role and account status.",
        input_schema: {
            type: "object",
            properties: {
                search: { type: "string", description: "Text to match against name or email" },
                limit: { type: "integer", minimum: 1, maximum: 20 },
            },
            required: [],
        },
        handler: async (input) => {
            const search = typeof input.search === "string" ? input.search.trim().slice(0, 100) : "";
            const limit = Math.min(20, Math.max(1, Number.parseInt(input.limit, 10) || 10));
            const filter = search
                ? { $or: [{ email: { $regex: escapeRegex(search), $options: "i" } }, { name: { $regex: escapeRegex(search), $options: "i" } }] }
                : {};
            const users = await User.find(filter).sort({ createdAt: -1 }).limit(limit);
            return JSON.stringify(
                users.map((u) => ({ name: u.name, email: u.email, role: u.role, disabled: Boolean(u.disabledAt) }))
            );
        },
    },
    {
        name: "get_queue_overview",
        description: "Background job queue depths (ready, retrying, dead-lettered) and circuit breaker states.",
        input_schema: { type: "object", properties: {}, required: [] },
        handler: async () => JSON.stringify(await getBus().stats()),
    },
    {
        name: "get_dead_letters",
        description: "Messages that failed every retry on a given queue, with their last error. Queue names: sr.cleanup, sr.processing, sr.notifications, sr.analytics.",
        input_schema: {
            type: "object",
            properties: {
                queue: { type: "string", description: "Queue name, e.g. sr.notifications" },
                limit: { type: "integer", minimum: 1, maximum: 20 },
            },
            required: ["queue"],
        },
        handler: async (input) => {
            if (!isQueue(input.queue)) return `Unknown queue "${input.queue}"`;
            const limit = Math.min(20, Math.max(1, Number.parseInt(input.limit, 10) || 10));
            return JSON.stringify(await getBus().peekDeadLetters(input.queue, limit));
        },
    },
];

module.exports = { buildAdminTools };
