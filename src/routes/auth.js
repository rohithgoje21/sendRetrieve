const express = require("express");
const bcrypt = require("bcryptjs");
const config = require("../config");
const User = require("../models/User");
const schemas = require("../lib/schemas");
const mailer = require("../lib/mailer");
const { HttpError } = require("../lib/errors");
const { validateBody } = require("../lib/validate");
const { limiter } = require("../lib/rateLimit");
const { baseUrl } = require("../lib/urls");
const {
    hashToken,
    randomToken,
    issueSession,
    clearSession,
    rotateSession,
    revokeSession,
    revokeAllSessions,
    requireAuth,
} = require("../lib/auth");

// Compared against when the email doesn't exist, so a login for an unknown
// account takes as long as one with a wrong password.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", config.bcryptRounds);

const FORGOT_PASSWORD_MESSAGE =
    "If an account exists for that email, we've sent a link to reset the password.";

const createAuthRouter = ({ rateLimit = true } = {}) => {
    const router = express.Router();

    router.post(
        "/register",
        limiter(rateLimit, { limit: 10, windowMinutes: 60, error: "Too many sign-ups. Please try again later." }),
        validateBody(schemas.register),
        async (req, res) => {
            const { name, email, password } = req.body;
            let user;
            try {
                user = await User.create({
                    name,
                    email,
                    passwordHash: await bcrypt.hash(password, config.bcryptRounds),
                });
            } catch (err) {
                if (err.code === 11000) throw new HttpError(409, "An account with this email already exists");
                throw err;
            }
            await issueSession(req, res, user);
            res.status(201).json({ user: user.toPublic() });
        }
    );

    router.post(
        "/login",
        limiter(rateLimit, { limit: 20, error: "Too many login attempts. Please wait a few minutes." }),
        validateBody(schemas.login),
        async (req, res) => {
            const { email, password } = req.body;
            const user = await User.findOne({ email });
            const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
            if (!user || !valid) throw new HttpError(401, "Incorrect email or password");

            await issueSession(req, res, user);
            res.json({ user: user.toPublic() });
        }
    );

    router.post(
        "/refresh",
        limiter(rateLimit, { limit: 120, error: "Too many requests. Please wait a few minutes." }),
        async (req, res) => {
            const user = await rotateSession(req, res);
            if (!user) {
                clearSession(req, res);
                throw new HttpError(401, "Please log in", { code: "auth_required" });
            }
            res.json({ user: user.toPublic() });
        }
    );

    router.post("/logout", async (req, res) => {
        await revokeSession(req);
        clearSession(req, res);
        res.status(204).end();
    });

    router.get("/me", requireAuth, (req, res) => {
        res.json({ user: req.user.toPublic() });
    });

    router.post(
        "/forgot-password",
        limiter(rateLimit, { limit: 5, windowMinutes: 60, error: "Too many reset requests. Please try again later." }),
        validateBody(schemas.forgotPassword),
        async (req, res) => {
            const user = await User.findOne({ email: req.body.email });
            if (user) {
                const token = randomToken();
                user.passwordResetTokenHash = hashToken(token);
                user.passwordResetExpiresAt = new Date(Date.now() + config.auth.passwordResetTtlSeconds * 1000);
                await user.save();

                const link = `${baseUrl(req)}/reset-password?token=${token}`;
                // Same response either way, so this endpoint can't be used to
                // check whether an email has an account.
                await mailer.sendPasswordResetEmail(user, link).catch((err) => {
                    console.error("Failed to send password reset email:", err);
                });
            }
            res.json({ message: FORGOT_PASSWORD_MESSAGE });
        }
    );

    router.post(
        "/reset-password",
        limiter(rateLimit, { limit: 10, error: "Too many attempts. Please wait a few minutes." }),
        validateBody(schemas.resetPassword),
        async (req, res) => {
            const user = await User.findOne({
                passwordResetTokenHash: hashToken(req.body.token),
                passwordResetExpiresAt: { $gt: new Date() },
            });
            if (!user) throw new HttpError(400, "This reset link is invalid or has expired. Request a new one.");

            user.passwordHash = await bcrypt.hash(req.body.password, config.bcryptRounds);
            user.passwordResetTokenHash = null;
            user.passwordResetExpiresAt = null;
            await user.save();

            await revokeAllSessions(user);
            await issueSession(req, res, user);
            res.json({ user: user.toPublic() });
        }
    );

    return router;
};

module.exports = { createAuthRouter };
