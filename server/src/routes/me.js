const express = require("express");
const bcrypt = require("bcryptjs");
const config = require("../config");
const Share = require("../models/Share");
const User = require("../models/User");
const RefreshToken = require("../models/RefreshToken");
const schemas = require("../lib/schemas");
const { HttpError } = require("../lib/errors");
const { validateBody } = require("../lib/validate");
const { limiter } = require("../lib/rateLimit");
const { normalizeCode } = require("../lib/codes");
const { storage } = require("../lib/storage");
const { baseUrl } = require("../lib/urls");
const { requireAuth, issueSession, clearSession, revokeAllSessions } = require("../lib/auth");
const { serializeOwnedShare, shareStatus, endShares } = require("../lib/shares");

const PAGE_SIZE = 20;
const STATUSES = ["active", "expired", "deleted"];

// Shares still uploading aren't listed: they appear once the upload completes
// (or are cleaned up if it never does).
const statusFilter = (ownerId, status) => {
    const now = new Date();
    const base = { ownerId, uploadPending: { $ne: true } };
    switch (status) {
        case "active":
            return { ...base, endedAt: null, expiresAt: { $gt: now } };
        case "expired":
            return {
                ...base,
                $or: [{ endedReason: { $in: ["expired", "used_up"] } }, { endedAt: null, expiresAt: { $lte: now } }],
            };
        case "deleted":
            return { ...base, endedReason: { $in: ["deleted", "removed"] } };
    }
};

// Throws 401 (blaming `field`) unless `password` is the user's password.
const verifyPassword = async (req, password, { field, message }) => {
    if (!(await bcrypt.compare(password, req.user.passwordHash))) {
        req.log.warn({ event: "account.password_check_failed", field }, "Wrong current password");
        throw new HttpError(401, message, { field });
    }
};

const createMeRouter = (ctx) => {
    const router = express.Router();
    router.use(requireAuth);

    /* ---------- Profile ---------- */

    router.patch("/", validateBody(schemas.updateProfile), async (req, res) => {
        req.user.name = req.body.name;
        await req.user.save();
        res.json({ user: req.user.toPublic() });
    });

    router.post(
        "/password",
        limiter(ctx, { name: "change-password", limit: 10, error: "Too many attempts. Please wait a few minutes." }),
        validateBody(schemas.changePassword),
        async (req, res) => {
            const { currentPassword, newPassword } = req.body;
            await verifyPassword(req, currentPassword, {
                field: "currentPassword",
                message: "Current password is incorrect",
            });

            req.user.passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
            await req.user.save();

            // Log out everywhere else; keep this browser signed in.
            await revokeAllSessions(req.user);
            req.log.info({ event: "account.password_changed" }, "Password changed");
            await issueSession(req, res, req.user);
            res.json({ user: req.user.toPublic() });
        }
    );

    router.delete(
        "/",
        limiter(ctx, { name: "delete-account", limit: 10, error: "Too many attempts. Please wait a few minutes." }),
        validateBody(schemas.deleteAccount),
        async (req, res) => {
            await verifyPassword(req, req.body.password, { field: "password", message: "Incorrect password" });

            const shares = await Share.find({ ownerId: req.user._id }, { files: 1 }).lean();
            await storage.delete(shares.flatMap((s) => s.files.map((f) => f.storedName)));
            await Share.deleteMany({ ownerId: req.user._id });
            await RefreshToken.deleteMany({ userId: req.user._id });
            await User.deleteOne({ _id: req.user._id });
            req.log.info({ event: "account.deleted", sharesDeleted: shares.length }, "Account deleted");

            clearSession(req, res);
            res.status(204).end();
        }
    );

    /* ---------- My shares ---------- */

    router.get("/shares", async (req, res) => {
        const status = STATUSES.includes(req.query.status) ? req.query.status : "active";
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

        const [shares, ...counts] = await Promise.all([
            Share.find(statusFilter(req.user._id, status))
                .sort({ createdAt: -1 })
                .skip((page - 1) * PAGE_SIZE)
                .limit(PAGE_SIZE + 1),
            ...STATUSES.map((s) => Share.countDocuments(statusFilter(req.user._id, s))),
        ]);

        const base = baseUrl(req);
        res.set("Cache-Control", "no-store");
        res.json({
            status,
            page,
            hasMore: shares.length > PAGE_SIZE,
            shares: shares.slice(0, PAGE_SIZE).map((s) => serializeOwnedShare(s, base)),
            counts: Object.fromEntries(STATUSES.map((s, i) => [s, counts[i]])),
        });
    });

    const findOwnedShare = async (req) => {
        const code = normalizeCode(req.params.code);
        const share = code && (await Share.findOne({ code, ownerId: req.user._id, uploadPending: { $ne: true } }));
        // 404 rather than 403 for other people's shares: don't confirm they exist.
        if (!share) throw new HttpError(404, "Share not found");
        return share;
    };

    // The owner can see their own share's content without using up a view.
    router.get("/shares/:code", async (req, res) => {
        const share = await findOwnedShare(req);
        res.set("Cache-Control", "no-store");
        res.json({
            share: serializeOwnedShare(share, baseUrl(req), { includeContent: true }),
            downloadWindowSeconds: config.downloadWindowSeconds,
        });
    });

    // Active share: stop it now (it moves to "Deleted").
    // Ended share: remove it from history for good.
    router.delete("/shares/:code", async (req, res) => {
        const share = await findOwnedShare(req);
        const wasActive = shareStatus(share) === "active";
        if (wasActive) {
            await endShares([share], "deleted");
        } else {
            await storage.delete(share.files.map((f) => f.storedName));
            await Share.deleteOne({ _id: share._id });
        }
        req.log.info(
            { event: wasActive ? "share.deleted" : "share.removed_from_history", shareId: share._id },
            wasActive ? "Share deleted by owner" : "Ended share removed from history"
        );
        res.status(204).end();
    });

    return router;
};

module.exports = { createMeRouter };
