const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const config = require("../../config");
const User = require("../users/user.model");
const RefreshToken = require("./refreshToken.model");
const Session = require("./session.model");
const { describeDevice, maskIp } = require("./devices");
const { hashToken, randomToken, deriveKey } = require("../../shared/crypto");

// Login sessions. Guards that use them are in middleware.js.
//
// Each login is a Session (one per browser or device), listed on the account
// page, where it can be logged out. Sessions use two httpOnly cookies:
//   sr_at: short-lived JWT access token, sent with every request; names its
//          session ("sid"), which is checked on every request, so logging a
//          device out takes effect at once
//   sr_rt: long-lived random refresh token, sent only to /api/auth, rotated on use
// A third, sr_dev, holds a random device ID for a year, to recognize browsers
// that have logged in before (new-device alerts).
// Being httpOnly, none is readable by page scripts; SameSite=Strict keeps
// them off cross-site requests.

const ACCESS_COOKIE = "sr_at";
const REFRESH_COOKIE = "sr_rt";
const DEVICE_COOKIE = "sr_dev";
const REFRESH_PATH = "/api/auth";
const DEVICE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// Two tabs can refresh at the same moment with the same token. Within this
// window a reused token is treated as that race, not as theft.
const REUSE_GRACE_MS = 30 * 1000;

const jwtSecret = deriveKey(config.tokenSecret, "access-token");

const cookieOptions = (req, path, maxAge = config.auth.refreshTokenTtlSeconds * 1000) => ({
    httpOnly: true,
    secure: req.secure,
    sameSite: "strict",
    path,
    // The access cookie deliberately outlives the JWT inside it, so an expired
    // token is reported as "token_expired" (and refreshed) instead of the
    // request quietly being treated as logged out.
    maxAge,
});

const refreshExpiry = () => new Date(Date.now() + config.auth.refreshTokenTtlSeconds * 1000);

// Sets fresh access and refresh tokens for the session `familyId`.
const issueTokens = async (req, res, user, familyId) => {
    const accessToken = jwt.sign({ v: user.sessionVersion, sid: familyId }, jwtSecret, {
        subject: String(user._id),
        expiresIn: config.auth.accessTokenTtlSeconds,
        algorithm: "HS256",
    });
    const refreshToken = randomToken();
    await RefreshToken.create({ userId: user._id, tokenHash: hashToken(refreshToken), familyId, expiresAt: refreshExpiry() });

    res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(req, "/"));
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(req, REFRESH_PATH));
};

const deviceIdOf = (req) => {
    const id = req.cookies?.[DEVICE_COOKIE];
    return typeof id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : null;
};

const sessionDetails = (req) => ({
    device: describeDevice(req.get("user-agent")),
    ipHint: maskIp(req.ip),
    lastSeenAt: new Date(),
    expiresAt: refreshExpiry(),
});

// Starts a new session (a login) in this browser. Returns { session,
// newDevice }: newDevice when the account has logged in before, but never
// from this browser.
const startSession = async (req, res, user) => {
    const knownId = deviceIdOf(req);
    const deviceId = knownId ?? randomToken();
    const [seenHere, seenAnywhere] = await Promise.all([
        knownId ? Session.exists({ userId: user._id, deviceId }) : null,
        Session.exists({ userId: user._id }),
    ]);
    const session = await Session.create({ userId: user._id, familyId: crypto.randomUUID(), deviceId, ...sessionDetails(req) });

    res.cookie(DEVICE_COOKIE, deviceId, cookieOptions(req, REFRESH_PATH, DEVICE_COOKIE_MAX_AGE_MS));
    await issueTokens(req, res, user, session.familyId);
    return { session, newDevice: Boolean(seenAnywhere) && !seenHere };
};

const clearSession = (req, res) => {
    res.clearCookie(ACCESS_COOKIE, cookieOptions(req, "/"));
    res.clearCookie(REFRESH_COOKIE, cookieOptions(req, REFRESH_PATH));
};

// Revokes sessions (and every refresh token they have) matching `filter`.
const revokeSessions = async (filter, reason) => {
    const now = new Date();
    const sessions = await Session.find({ ...filter, revokedAt: null }, { familyId: 1 }).lean();
    const familyIds = sessions.map((s) => s.familyId);
    await Session.updateMany({ familyId: { $in: familyIds }, revokedAt: null }, { revokedAt: now, revokedReason: reason });
    await RefreshToken.updateMany({ familyId: { $in: familyIds }, revokedAt: null }, { revokedAt: now });
    return familyIds.length;
};

// Exchanges the refresh cookie for new tokens. Returns the user, or null if
// the token is missing, expired, revoked or reused, or its session was
// logged out.
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
            // it leaked and log out that session.
            await revokeSessions({ familyId: used.familyId }, "token_reuse");
            await RefreshToken.updateMany({ familyId: used.familyId, revokedAt: null }, { revokedAt: now });
            req.log.warn(
                { event: "auth.refresh_token_reuse", userId: used.userId, familyId: used.familyId },
                "Refresh token reused; logged that session out"
            );
        }
        return null;
    }

    const user = await User.findById(current.userId);
    if (!user || user.disabledAt) return null;

    let session = await Session.findOne({ familyId: current.familyId });
    if (session?.revokedAt) return null;
    if (session) {
        Object.assign(session, sessionDetails(req));
        await session.save();
    } else {
        // A login from before sessions were recorded: record it now.
        session = await Session.create({
            userId: user._id,
            familyId: current.familyId,
            deviceId: deviceIdOf(req) ?? randomToken(),
            ...sessionDetails(req),
        });
    }
    await issueTokens(req, res, user, current.familyId);
    return user;
};

// Logs out this browser's session (from its refresh or access token).
const revokeSession = async (req) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    const refresh = token ? await RefreshToken.findOne({ tokenHash: hashToken(token) }, { familyId: 1 }) : null;
    const familyId = refresh?.familyId ?? req.sessionId;
    if (familyId) await revokeSessions({ familyId }, "logout");
};

// Logs the user out everywhere: bumps the version baked into access tokens
// and revokes every session. Call after saving the new password (then start
// a new session for this browser), or when disabling the account.
const revokeAllSessions = async (user, reason = "logout_all") => {
    await User.updateOne({ _id: user._id }, { $inc: { sessionVersion: 1 } });
    user.sessionVersion += 1;
    await revokeSessions({ userId: user._id }, reason);
    // Tokens of logins from before sessions were recorded.
    await RefreshToken.updateMany({ userId: user._id, revokedAt: null }, { revokedAt: new Date() });
};

// Logs out every session of the user except `familyId` (this browser's).
const revokeOtherSessions = (user, familyId) => revokeSessions({ userId: user._id, familyId: { $ne: familyId } }, "revoked");

// Resolves the access cookie to { user, sessionId } or { user: null, reason }.
const readSession = async (req) => {
    const token = req.cookies?.[ACCESS_COOKIE];
    if (!token) return { user: null, reason: "auth_required" };

    let claims;
    try {
        claims = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
    } catch (err) {
        return { user: null, reason: err.name === "TokenExpiredError" ? "token_expired" : "auth_required" };
    }

    const [user, sessionActive] = await Promise.all([
        User.findById(claims.sub),
        // Tokens from before sessions were recorded have no "sid"; they run
        // out within minutes.
        claims.sid ? Session.exists({ familyId: claims.sid, revokedAt: null }) : true,
    ]);
    if (!user || user.disabledAt || !sessionActive) return { user: null, reason: "auth_required" };

    // Tokens issued before the last password change are no longer valid.
    if (claims.v !== user.sessionVersion) {
        return { user: null, reason: "auth_required" };
    }
    return { user, sessionId: claims.sid ?? null };
};

module.exports = {
    startSession,
    clearSession,
    rotateSession,
    revokeSession,
    revokeSessions,
    revokeAllSessions,
    revokeOtherSessions,
    readSession,
};
