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
const { deleteFiles } = require("../lib/storage");
const { baseUrl } = require("../lib/urls");
const { requireAuth, issueSession, clearSession, revokeAllSessions } = require("../lib/auth");
const { serializeOwnedShare, shareStatus, endShares } = require("../lib/shares");

const PAGE_SIZE = 20;
const STATUSES = ["active", "expired", "deleted"];

const statusFilter = (ownerId, status) => {
    const now = new Date();
    switch (status) {
        case "active":
            return { ownerId, endedAt: null, expiresAt: { $gt: now } };
        case "expired":
            return {
                ownerId,
                $or: [{ endedReason: { $in: ["expired", "used_up"] } }, { endedAt: null, expiresAt: { $lte: now } }],
            };
        case "deleted":
            return { ownerId, endedReason: "deleted" };
    }
};

const verifyPassword = async (user, password) => {
    if (!(await bcrypt.compare(password, user.passwordHash))) {
        throw new HttpError(401, "Incorrect password", { field: "password" });
    }
};

const createMeRouter = ({ rateLimit = true } = {}) => {
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
        limiter(rateLimit, { limit: 10, error: "Too many attempts. Please wait a few minutes." }),
        validateBody(schemas.changePassword),
        async (req, res) => {
            const { currentPassword, newPassword } = req.body;
            await verifyPassword(req.user, currentPassword).catch(() => {
                throw new HttpError(401, "Current password is incorrect", { field: "currentPassword" });
            });

            req.user.passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
            await req.user.save();

            // Log out everywhere else; keep this browser signed in.
            await revokeAllSessions(req.user);
            await issueSession(req, res, req.user);
            res.json({ user: req.user.toPublic() });
        }
    );

    router.delete(
        "/",
        limiter(rateLimit, { limit: 10, error: "Too many attempts. Please wait a few minutes." }),
        validateBody(schemas.deleteAccount),
        async (req, res) => {
            await verifyPassword(req.user, req.body.password);

            const shares = await Share.find({ ownerId: req.user._id }, { files: 1 }).lean();
            await deleteFiles(shares.flatMap((s) => s.files.map((f) => f.storedName)));
            await Share.deleteMany({ ownerId: req.user._id });
            await RefreshToken.deleteMany({ userId: req.user._id });
            await User.deleteOne({ _id: req.user._id });

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
        const share = code && (await Share.findOne({ code, ownerId: req.user._id }));
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
        if (shareStatus(share) === "active") {
            await endShares([share], "deleted");
        } else {
            await deleteFiles(share.files.map((f) => f.storedName));
            await Share.deleteOne({ _id: share._id });
        }
        res.status(204).end();
    });

    return router;
};

module.exports = { createMeRouter };
