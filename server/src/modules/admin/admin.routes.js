const express = require("express");
const mongoose = require("mongoose");
const Share = require("../shares/share.model");
const User = require("../users/user.model");
const schemas = require("./admin.schemas");
const { HttpError } = require("../../shared/errors");
const { validateBody } = require("../../shared/validate");
const { normalizeCode } = require("../shares/codes");
const { baseUrl } = require("../../shared/urls");
const { requireAuth, authorize } = require("../auth/middleware");
const { can } = require("../auth/permissions");
const { revokeAllSessions } = require("../auth/sessions");
const { liveFilter, serializeOwnedShare, shareStatus, endShares, discardShares } = require("../shares/shares.service");
const { getBus, isQueue } = require("../../infrastructure/queue");
const { siteAnalytics } = require("../analytics/analytics.service");
const { periodParam } = require("../analytics/analytics.routes");
const { breakerStates } = require("../../infrastructure/breakerStatus");
// (loaded so their breakers exist in this process, and are listed)
require("../../infrastructure/mailer");
require("../../infrastructure/clamav");
require("../../infrastructure/webPush");

const PAGE_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const serializeUser = (user, activeShares = 0) => ({
    ...user.toPublic(),
    disabled: Boolean(user.disabledAt),
    activeShares,
});

// /api/admin: site-wide stats, user management, share moderation and
// background jobs, for admins and superadmins (each route names the
// permission it needs; see auth/permissions.js). Make the first superadmin
// with: npm run set-role -w server -- <email> superadmin
const createAdminRouter = (ctx = {}) => {
    const router = express.Router();
    router.use(requireAuth, authorize("admin.access"));

    router.get("/stats", async (req, res) => {
        const now = Date.now();
        const live = liveFilter();
        const [users, verified, disabled, admins, newUsers, activeShares, uploading, sharesToday, storageTotals, activity] =
            await Promise.all([
                User.countDocuments(),
                User.countDocuments({ emailVerifiedAt: { $ne: null } }),
                User.countDocuments({ disabledAt: { $ne: null } }),
                User.countDocuments({ role: { $in: ["admin", "superadmin"] } }),
                User.countDocuments({ createdAt: { $gte: new Date(now - 7 * DAY_MS) } }),
                Share.countDocuments(live),
                Share.countDocuments({ uploadPending: true }),
                Share.countDocuments({ uploadPending: { $ne: true }, createdAt: { $gte: new Date(now - DAY_MS) } }),
                // Files currently held in storage: live shares and uploads in progress.
                Share.aggregate([
                    { $match: { endedAt: null } },
                    { $unwind: "$files" },
                    { $group: { _id: null, bytes: { $sum: "$files.size" }, files: { $sum: 1 } } },
                ]),
                Share.aggregate([
                    { $match: { uploadPending: { $ne: true } } },
                    {
                        $group: {
                            _id: null,
                            views: { $sum: "$views" },
                            downloads: { $sum: { $sum: "$files.downloads" } },
                        },
                    },
                ]),
            ]);

        res.set("Cache-Control", "no-store");
        res.json({
            users: { total: users, verified, disabled, admins, newThisWeek: newUsers },
            shares: { active: activeShares, uploading, createdToday: sharesToday },
            storage: { bytes: storageTotals[0]?.bytes ?? 0, files: storageTotals[0]?.files ?? 0 },
            // Totals across shares still in the database (guest shares are
            // deleted when they end, so this undercounts older activity).
            activity: { views: activity[0]?.views ?? 0, downloads: activity[0]?.downloads ?? 0 },
        });
    });

    // Site-wide statistics over 7, 30 or 90 days.
    router.get("/analytics", async (req, res) => {
        res.set("Cache-Control", "no-store");
        res.json(await siteAnalytics(periodParam(req)));
    });

    router.get("/users", authorize("users.read"), async (req, res) => {
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
        const filter = search
            ? { $or: [{ email: { $regex: escapeRegex(search), $options: "i" } }, { name: { $regex: escapeRegex(search), $options: "i" } }] }
            : {};

        const [users, total] = await Promise.all([
            User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE),
            User.countDocuments(filter),
        ]);
        const counts = await Share.aggregate([
            { $match: { ownerId: { $in: users.map((u) => u._id) }, ...liveFilter() } },
            { $group: { _id: "$ownerId", count: { $sum: 1 } } },
        ]);
        const countFor = new Map(counts.map((c) => [String(c._id), c.count]));

        res.set("Cache-Control", "no-store");
        res.json({
            page,
            total,
            hasMore: page * PAGE_SIZE < total,
            users: users.map((u) => serializeUser(u, countFor.get(String(u._id)) ?? 0)),
        });
    });

    // Who may change whom: admins manage regular users; superadmins also
    // manage admins and roles; superadmins themselves only change through
    // scripts/set-role.js.
    const findManageableUser = async (req) => {
        if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, "User not found");
        if (req.user._id.equals(req.params.id)) {
            // Guards against an admin locking everyone (themselves included) out.
            throw new HttpError(400, "You can't change your own role or disable your own account");
        }
        const user = await User.findById(req.params.id);
        if (!user) throw new HttpError(404, "User not found");
        if (user.role === "superadmin") throw new HttpError(403, "Superadmin accounts can't be changed here");
        if (user.role === "admin" && !can(req.user, "users.roles")) {
            throw new HttpError(403, "Only a superadmin can manage admins");
        }
        return user;
    };

    router.patch("/users/:id", authorize("users.disable"), validateBody(schemas.updateUser), async (req, res) => {
        const { role, disabled } = req.body;
        if (role !== undefined && !can(req.user, "users.roles")) throw new HttpError(403, "Only a superadmin can change roles");
        const user = await findManageableUser(req);

        if (role !== undefined) user.role = role;
        if (disabled !== undefined) user.disabledAt = disabled ? (user.disabledAt ?? new Date()) : null;
        await user.save();
        // Disabling logs them out everywhere, right away.
        if (disabled) await revokeAllSessions(user, "disabled");

        req.log.info(
            { event: "admin.user_updated", targetUserId: user._id, changes: { role, disabled } },
            "Admin updated a user"
        );
        res.json({ user: serializeUser(user) });
    });

    // Logs a user out on every device (e.g. a compromised account).
    router.post("/users/:id/logout", authorize("users.logout"), async (req, res) => {
        const user = await findManageableUser(req);
        await revokeAllSessions(user, "revoked");
        req.log.info({ event: "admin.user_logged_out", targetUserId: user._id }, "Admin logged a user out everywhere");
        res.status(204).end();
    });

    // Look up any share by code, for moderation. Metadata only: an admin
    // never sees a share's message or files.
    const findShare = async (req) => {
        const code = normalizeCode(req.params.code);
        const share = code && (await Share.findOne({ code }));
        if (!share) throw new HttpError(404, "Share not found");
        return share;
    };

    router.get("/shares/:code", authorize("shares.moderate"), async (req, res) => {
        const share = await findShare(req);
        const owner = share.ownerId ? await User.findById(share.ownerId) : null;
        const { textPreview: _textPreview, ...summary } = serializeOwnedShare(share, baseUrl(req));
        res.set("Cache-Control", "no-store");
        res.json({
            share: {
                ...summary,
                uploading: Boolean(share.uploadPending),
                owner: owner ? { id: owner._id, name: owner.name, email: owner.email } : null,
            },
        });
    });

    // Takes a share down immediately. The owner sees it as "removed".
    router.delete("/shares/:code", authorize("shares.moderate"), async (req, res) => {
        const share = await findShare(req);
        if (share.uploadPending) await discardShares([share]);
        else if (shareStatus(share) === "active") await endShares([share], "removed");
        else throw new HttpError(409, "This share has already ended");

        req.log.info({ event: "admin.share_removed", shareId: share._id }, "Admin removed a share");
        res.status(204).end();
    });

    /* ---------- Background jobs ---------- */

    // Queue depths, consumers and dead-lettered messages, plus the state of
    // the circuit breakers in front of outside services.
    router.get("/queues", authorize("queues.read"), async (req, res) => {
        const bus = getBus();
        res.set("Cache-Control", "no-store");
        // Breakers from every process (with RabbitMQ, the worker's matter most).
        res.json({ broker: bus.kind, queues: await bus.stats(), circuitBreakers: await breakerStates(ctx.redis) });
    });

    const queueParam = (req) => {
        if (!isQueue(req.params.queue)) throw new HttpError(404, "Unknown queue");
        return req.params.queue;
    };

    // Messages that failed every retry, with their last error.
    router.get("/queues/:queue/dead-letters", authorize("queues.read"), async (req, res) => {
        const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
        res.set("Cache-Control", "no-store");
        res.json({ messages: await getBus().peekDeadLetters(queueParam(req), limit) });
    });

    // After fixing the cause (e.g. the email provider is back), send the
    // dead-lettered messages through again.
    router.post("/queues/:queue/dead-letters/replay", authorize("queues.replay"), async (req, res) => {
        const queue = queueParam(req);
        const replayed = await getBus().replayDeadLetters(queue);
        req.log.info({ event: "admin.dead_letters_replayed", queue, replayed }, "Dead letters replayed");
        res.json({ replayed });
    });

    router.delete("/queues/:queue/dead-letters", authorize("queues.purge"), async (req, res) => {
        const queue = queueParam(req);
        const purged = await getBus().purgeDeadLetters(queue);
        req.log.warn({ event: "admin.dead_letters_purged", queue, purged }, "Dead letters purged");
        res.json({ purged });
    });

    return router;
};

module.exports = { createAdminRouter };
