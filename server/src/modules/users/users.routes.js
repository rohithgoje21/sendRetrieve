const express = require("express");
const bcrypt = require("bcryptjs");
const config = require("../../config");
const Share = require("../shares/share.model");
const User = require("./user.model");
const RefreshToken = require("../auth/refreshToken.model");
const Session = require("../auth/session.model");
const Notification = require("../notifications/notification.model");
const PushSubscription = require("../notifications/pushSubscription.model");
const { deviceLabel } = require("../auth/devices");
const schemas = require("./users.schemas");
const { HttpError } = require("../../shared/errors");
const { validateBody } = require("../../shared/validate");
const { limiter } = require("../../shared/rateLimit");
const { publish } = require("../../infrastructure/queue");
const { fileKeys, pendingUploads } = require("../shares/shares.service");
const { requireAuth } = require("../auth/middleware");
const { startSession, clearSession, revokeAllSessions, revokeOtherSessions, revokeSessions } = require("../auth/sessions");

// Throws 401 (blaming `field`) unless `password` is the user's password.
const verifyPassword = async (req, password, { field, message }) => {
    if (!(await bcrypt.compare(password, req.user.passwordHash))) {
        req.log.warn({ event: "account.password_check_failed", field }, "Wrong current password");
        throw new HttpError(401, message, { field });
    }
};

const serializeSession = (session, currentId) => ({
    id: session.familyId,
    current: session.familyId === currentId,
    device: { ...session.device, label: deviceLabel(session.device) },
    ipHint: session.ipHint,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
});

// /api/me: the signed-in user's profile, password, devices and account.
const createUsersRouter = (ctx) => {
    const router = express.Router();
    router.use(requireAuth);

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
            await revokeAllSessions(req.user, "password_changed");
            req.log.info({ event: "account.password_changed" }, "Password changed");
            await startSession(req, res, req.user);
            res.json({ user: req.user.toPublic() });
        }
    );

    /* ---------- Devices (login sessions) ---------- */

    // Where this account is logged in: this browser first, then by last use.
    router.get("/sessions", async (req, res) => {
        const sessions = await Session.find({ userId: req.user._id, revokedAt: null, expiresAt: { $gt: new Date() } })
            .sort({ lastSeenAt: -1 })
            .lean();
        const list = sessions.map((s) => serializeSession(s, req.sessionId));
        res.set("Cache-Control", "no-store");
        res.json({ sessions: [...list.filter((s) => s.current), ...list.filter((s) => !s.current)] });
    });

    // Logs out one device (this one too, if it's the current session).
    router.delete("/sessions/:id", async (req, res) => {
        const revoked = await revokeSessions({ userId: req.user._id, familyId: String(req.params.id) }, "revoked");
        if (!revoked) throw new HttpError(404, "That device isn't logged in");
        req.log.info({ event: "auth.session_revoked", current: req.params.id === req.sessionId }, "Logged out a device");
        if (req.params.id === req.sessionId) clearSession(req, res);
        res.status(204).end();
    });

    // Logs out every other device; this one stays logged in.
    router.post("/sessions/revoke-others", async (req, res) => {
        const revoked = await revokeOtherSessions(req.user, req.sessionId);
        req.log.info({ event: "auth.other_sessions_revoked", revoked }, "Logged out other devices");
        res.json({ revoked });
    });

    // Logs out everywhere, this browser included.
    router.post("/sessions/revoke-all", async (req, res) => {
        await revokeAllSessions(req.user, "logout_all");
        req.log.info({ event: "auth.all_sessions_revoked" }, "Logged out everywhere");
        clearSession(req, res);
        res.status(204).end();
    });

    router.delete(
        "/",
        limiter(ctx, { name: "delete-account", limit: 10, error: "Too many attempts. Please wait a few minutes." }),
        validateBody(schemas.deleteAccount),
        async (req, res) => {
            await verifyPassword(req, req.body.password, { field: "password", message: "Incorrect password" });

            // Live shares stop working at once; the cleanup worker deletes their files.
            const shares = await Share.find({ ownerId: req.user._id }, { files: 1, filesState: 1 }).lean();
            await Share.deleteMany({ ownerId: req.user._id });
            const keys = fileKeys(shares.filter((s) => s.filesState !== "deleted"));
            const uploads = pendingUploads(shares);
            if (keys.length || uploads.length) {
                await publish("share.discarded", { shareIds: shares.map((s) => String(s._id)), keys, uploads });
            }
            await RefreshToken.deleteMany({ userId: req.user._id });
            await Session.deleteMany({ userId: req.user._id });
            await Notification.deleteMany({ userId: req.user._id });
            await PushSubscription.deleteMany({ userId: req.user._id });
            await User.deleteOne({ _id: req.user._id });
            req.log.info({ event: "account.deleted", sharesDeleted: shares.length }, "Account deleted");

            clearSession(req, res);
            res.status(204).end();
        }
    );

    return router;
};

module.exports = { createUsersRouter };
