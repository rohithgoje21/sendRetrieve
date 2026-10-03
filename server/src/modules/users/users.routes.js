const express = require("express");
const bcrypt = require("bcryptjs");
const config = require("../../config");
const Share = require("../shares/share.model");
const User = require("./user.model");
const RefreshToken = require("../auth/refreshToken.model");
const schemas = require("./users.schemas");
const { HttpError } = require("../../shared/errors");
const { validateBody } = require("../../shared/validate");
const { limiter } = require("../../shared/rateLimit");
const { storage } = require("../../infrastructure/storage");
const { requireAuth } = require("../auth/middleware");
const { issueSession, clearSession, revokeAllSessions } = require("../auth/sessions");

// Throws 401 (blaming `field`) unless `password` is the user's password.
const verifyPassword = async (req, password, { field, message }) => {
    if (!(await bcrypt.compare(password, req.user.passwordHash))) {
        req.log.warn({ event: "account.password_check_failed", field }, "Wrong current password");
        throw new HttpError(401, message, { field });
    }
};

// /api/me: the signed-in user's profile, password and account.
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

    return router;
};

module.exports = { createUsersRouter };
