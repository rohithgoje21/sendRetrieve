const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const config = require("../config");
const User = require("../models/User");
const RefreshToken = require("../models/RefreshToken");
const { HttpError } = require("./errors");

// Sessions use two httpOnly cookies:
//   sr_at: short-lived JWT access token, sent with every request
//   sr_rt: long-lived random refresh token, sent only to /api/auth, rotated on use
// Being httpOnly, neither is readable by page scripts; SameSite=Strict keeps
// them off cross-site requests.

const ACCESS_COOKIE = "sr_at";
const REFRESH_COOKIE = "sr_rt";
const REFRESH_PATH = "/api/auth";

// Two tabs can refresh at the same moment with the same token. Within this
// window a reused token is treated as that race, not as theft.
const REUSE_GRACE_MS = 30 * 1000;

const jwtSecret = crypto.createHmac("sha256", config.tokenSecret).update("access-token").digest();

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");

const cookieOptions = (req, path) => ({
    httpOnly: true,
    secure: req.secure,
    sameSite: "strict",
    path,
    // The access cookie deliberately outlives the JWT inside it, so an expired
    // token is reported as "token_expired" (and refreshed) instead of the
    // request quietly being treated as logged out.
    maxAge: config.auth.refreshTokenTtlSeconds * 1000,
});

const issueSession = async (req, res, user, familyId = crypto.randomUUID()) => {
    const accessToken = jwt.sign({ v: user.sessionVersion }, jwtSecret, {
        subject: String(user._id),
        expiresIn: config.auth.accessTokenTtlSeconds,
        algorithm: "HS256",
    });
    const refreshToken = randomToken();
    await RefreshToken.create({
        userId: user._id,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + config.auth.refreshTokenTtlSeconds * 1000),
    });

    res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(req, "/"));
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(req, REFRESH_PATH));
};

const clearSession = (req, res) => {
    res.clearCookie(ACCESS_COOKIE, cookieOptions(req, "/"));
    res.clearCookie(REFRESH_COOKIE, cookieOptions(req, REFRESH_PATH));
};

// Exchanges the refresh cookie for a new session. Returns the user, or null if
// the token is missing, expired, revoked or reused.
const rotateSession = async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) return null;

    const tokenHash = hashToken(token);
    const now = new Date();
    const current = await RefreshToken.findOneAndUpdate(
        { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
        { revokedAt: now }
    );

    if (!current) {
        const used = await RefreshToken.findOne({ tokenHash });
        if (used?.revokedAt && now - used.revokedAt > REUSE_GRACE_MS) {
            // A token that was already rotated away is being replayed: assume
            // it leaked and log out every session descended from that login.
            await RefreshToken.updateMany({ familyId: used.familyId, revokedAt: null }, { revokedAt: now });
            req.log.warn(
                { event: "auth.refresh_token_reuse", userId: used.userId, familyId: used.familyId },
                "Refresh token reused; revoked that login on all devices"
            );
        }
        return null;
    }

    const user = await User.findById(current.userId);
    if (!user) return null;
    await issueSession(req, res, user, current.familyId);
    return user;
};

const revokeSession = async (req) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) {
        await RefreshToken.updateOne({ tokenHash: hashToken(token), revokedAt: null }, { revokedAt: new Date() });
    }
};

// Logs the user out everywhere: bumps the version baked into access tokens
// and revokes every refresh token. Call after saving the new password.
const revokeAllSessions = async (user) => {
    await User.updateOne({ _id: user._id }, { $inc: { sessionVersion: 1 } });
    user.sessionVersion += 1;
    await RefreshToken.updateMany({ userId: user._id, revokedAt: null }, { revokedAt: new Date() });
};

// Resolves the access cookie to { user } or { user: null, reason }.
const readSession = async (req) => {
    const token = req.cookies?.[ACCESS_COOKIE];
    if (!token) return { user: null, reason: "auth_required" };

    let claims;
    try {
        claims = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
    } catch (err) {
        return { user: null, reason: err.name === "TokenExpiredError" ? "token_expired" : "auth_required" };
    }

    const user = await User.findById(claims.sub);
    if (!user) return { user: null, reason: "auth_required" };

    // Tokens issued before the last password change are no longer valid.
    if (claims.v !== user.sessionVersion) {
        return { user: null, reason: "auth_required" };
    }
    return { user };
};

const sessionError = (reason) =>
    new HttpError(401, reason === "token_expired" ? "Your session has expired" : "Please log in", { code: reason });

const requireAuth = async (req, res, next) => {
    const { user, reason } = await readSession(req);
    if (!user) throw sessionError(reason);
    req.user = user;
    next();
};

// For endpoints that work for guests too. An expired token still fails, so
// the client refreshes and retries instead of acting as a guest by mistake.
const optionalAuth = async (req, res, next) => {
    const { user, reason } = await readSession(req);
    if (!user && reason === "token_expired") throw sessionError(reason);
    req.user = user;
    next();
};

module.exports = {
    hashToken,
    randomToken,
    issueSession,
    clearSession,
    rotateSession,
    revokeSession,
    revokeAllSessions,
    requireAuth,
    optionalAuth,
};
