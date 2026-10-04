const express = require("express");
const config = require("../../config");
const User = require("../users/user.model");
const schemas = require("./auth.schemas");
const { requestEmail } = require("../notifications/emails");
const { publish } = require("../../infrastructure/queue");
const { HttpError } = require("../../shared/errors");
const { validateBody } = require("../../shared/validate");
const { limiter } = require("../../shared/rateLimit");
const { baseUrl } = require("../../shared/urls");
const { hashToken, randomToken } = require("../../shared/crypto");
const { hashPassword, verifyPassword, needsRehash, dummyHash } = require("../../shared/passwords");
const { requireAuth } = require("./middleware");
const { createRealtimeToken } = require("../realtime/realtimeTokens");
const { startSession, clearSession, rotateSession, revokeSession, revokeAllSessions } = require("./sessions");

const VERIFY_EMAIL = "verify-email";

// Emails a fresh verification code (through the queue). Throws 429 during
// the resend cooldown.
const sendVerificationCode = async (ctx, user) => {
    const { code, expiresInSeconds, resendAfterSeconds } = await ctx.otp.issue(VERIFY_EMAIL, user._id);
    await requestEmail("verify-email", user.email, { name: user.name, code, minutes: Math.round(expiresInSeconds / 60) });
    return { resendAfterSeconds };
};

const FORGOT_PASSWORD_MESSAGE =
    "If an account exists for that email, we've sent a link to reset the password.";

const createAuthRouter = (ctx) => {
    const router = express.Router();

    router.post(
        "/register",
        limiter(ctx, { name: "register", limit: 10, windowMinutes: 60, error: "Too many sign-ups. Please try again later." }),
        validateBody(schemas.register),
        async (req, res) => {
            const { name, email, password } = req.body;
            let user;
            try {
                user = await User.create({
                    name,
                    email,
                    passwordHash: await hashPassword(password),
                });
            } catch (err) {
                if (err.code === 11000) throw new HttpError(409, "An account with this email already exists");
                throw err;
            }
            req.log.info({ event: "auth.registered", userId: user._id }, "Account created");
            // Best effort: the account works without it, and the user can ask
            // for another code.
            await sendVerificationCode(ctx, user).catch((err) =>
                req.log.error({ err, event: "email.failed", userId: user._id }, "Failed to send verification code")
            );
            await startSession(req, res, user);
            res.status(201).json({ user: user.toPublic() });
        }
    );

    router.post(
        "/login",
        limiter(ctx, { name: "login", limit: 20, error: "Too many login attempts. Please wait a few minutes." }),
        validateBody(schemas.login),
        async (req, res) => {
            const { email, password } = req.body;
            // Counted per email whether or not the account exists, so a
            // lockout doesn't reveal which emails are registered.
            await ctx.attempts.assertNotLocked("login", email, "Too many failed login attempts for this account.");

            const user = await User.findOne({ email });
            const valid = await verifyPassword(password, user?.passwordHash ?? (await dummyHash()));
            if (!user || !valid) {
                const locked = await ctx.attempts.recordFailure("login", email);
                const userId = user?._id ?? null;
                req.log.warn({ event: "auth.login_failed", userId }, "Login failed");
                if (locked) req.log.warn({ event: "auth.locked", userId }, "Login locked after repeated failures");
                throw new HttpError(401, "Incorrect email or password");
            }

            await ctx.attempts.reset("login", email);
            // Hashed with an older scheme (bcrypt) or weaker settings: upgrade it now.
            if (needsRehash(user.passwordHash)) {
                user.passwordHash = await hashPassword(password);
                await user.save();
            }
            // Only after the password check, so it doesn't reveal disabled accounts.
            if (user.disabledAt) {
                req.log.warn({ event: "auth.login_disabled", userId: user._id }, "Login to a disabled account");
                throw new HttpError(403, "This account has been disabled. Contact the site's administrator.", {
                    code: "account_disabled",
                });
            }
            const { session, newDevice } = await startSession(req, res, user);
            req.log.info({ event: "auth.login", userId: user._id, newDevice }, "Logged in");
            // The notification worker alerts the user to logins from new devices.
            await publish("auth.login", {
                userId: String(user._id),
                sessionId: session.familyId,
                newDevice,
                device: session.device,
                ipHint: session.ipHint,
                at: session.createdAt,
                accountUrl: `${baseUrl(req)}/account`,
            });
            res.json({ user: user.toPublic() });
        }
    );

    router.post(
        "/refresh",
        limiter(ctx, { name: "refresh", limit: 120, error: "Too many requests. Please wait a few minutes." }),
        async (req, res) => {
            const user = await rotateSession(req, res);
            if (!user) {
                clearSession(req, res);
                throw new HttpError(401, "Please log in", { code: "auth_required" });
            }
            res.json({ user: user.toPublic() });
        }
    );

    // Logs out this browser (other devices: /api/me/sessions).
    router.post("/logout", async (req, res) => {
        await revokeSession(req);
        clearSession(req, res);
        res.status(204).end();
    });

    router.get("/me", requireAuth, (req, res) => {
        res.json({ user: req.user.toPublic() });
    });

    // A short-lived token for the Socket.IO connection, which may go to a
    // different origin where the session cookies aren't sent.
    router.get("/realtime-token", requireAuth, (req, res) => {
        res.set("Cache-Control", "no-store");
        res.json({ token: createRealtimeToken(req.user), expiresInSeconds: config.realtime.tokenTtlSeconds });
    });

    router.post(
        "/verify-email/send",
        requireAuth,
        limiter(ctx, { name: "verify-email-send", limit: 10, windowMinutes: 60, error: "Too many codes requested. Please try again later." }),
        async (req, res) => {
            if (req.user.emailVerifiedAt) throw new HttpError(400, "Your email is already verified");
            const { resendAfterSeconds } = await sendVerificationCode(ctx, req.user);
            req.log.info({ event: "auth.verification_sent" }, "Verification code sent");
            res.json({ message: `We sent a code to ${req.user.email}.`, resendAfterSeconds });
        }
    );

    router.post(
        "/verify-email",
        requireAuth,
        limiter(ctx, { name: "verify-email", limit: 30, error: "Too many attempts. Please wait a few minutes." }),
        validateBody(schemas.verifyEmail),
        async (req, res) => {
            if (req.user.emailVerifiedAt) return res.json({ user: req.user.toPublic() });
            try {
                await ctx.otp.verify(VERIFY_EMAIL, req.user._id, req.body.code);
            } catch (err) {
                req.log.warn({ event: "auth.verification_failed" }, "Wrong or expired verification code");
                throw err;
            }
            req.user.emailVerifiedAt = new Date();
            await req.user.save();
            req.log.info({ event: "auth.email_verified" }, "Email verified");
            res.json({ user: req.user.toPublic() });
        }
    );

    router.post(
        "/forgot-password",
        limiter(ctx, { name: "forgot-password", limit: 5, windowMinutes: 60, error: "Too many reset requests. Please try again later." }),
        validateBody(schemas.forgotPassword),
        async (req, res) => {
            const user = await User.findOne({ email: req.body.email });
            req.log.info({ event: "auth.password_reset_requested", userId: user?._id ?? null }, "Password reset requested");
            if (user) {
                const token = randomToken();
                user.passwordResetTokenHash = hashToken(token);
                user.passwordResetExpiresAt = new Date(Date.now() + config.auth.passwordResetTtlSeconds * 1000);
                await user.save();

                const link = `${baseUrl(req)}/reset-password?token=${token}`;
                // Same response either way, so this endpoint can't be used to
                // check whether an email has an account.
                await requestEmail("password-reset", user.email, {
                    name: user.name,
                    link,
                    minutes: Math.round(config.auth.passwordResetTtlSeconds / 60),
                });
            }
            res.json({ message: FORGOT_PASSWORD_MESSAGE });
        }
    );

    router.post(
        "/reset-password",
        limiter(ctx, { name: "reset-password", limit: 10, error: "Too many attempts. Please wait a few minutes." }),
        validateBody(schemas.resetPassword),
        async (req, res) => {
            const user = await User.findOne({
                passwordResetTokenHash: hashToken(req.body.token),
                passwordResetExpiresAt: { $gt: new Date() },
            });
            if (!user) {
                req.log.warn({ event: "auth.password_reset_invalid" }, "Invalid or expired reset token");
                throw new HttpError(400, "This reset link is invalid or has expired. Request a new one.");
            }

            user.passwordHash = await hashPassword(req.body.password);
            user.passwordResetTokenHash = null;
            user.passwordResetExpiresAt = null;
            await user.save();

            await revokeAllSessions(user, "password_changed");
            req.log.info({ event: "auth.password_reset", userId: user._id }, "Password reset");
            await startSession(req, res, user);
            res.json({ user: user.toPublic() });
        }
    );

    return router;
};

module.exports = { createAuthRouter };
