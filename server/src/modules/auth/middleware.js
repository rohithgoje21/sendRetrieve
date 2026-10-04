const { HttpError } = require("../../shared/errors");
const { readSession } = require("./sessions");
const { can } = require("./permissions");

// Request guards. Typical chain:  requireAuth -> authorize("users.read") -> handler

const sessionError = (reason) =>
    new HttpError(401, reason === "token_expired" ? "Your session has expired" : "Please log in", { code: reason });

const requireAuth = async (req, res, next) => {
    const { user, sessionId, reason } = await readSession(req);
    if (!user) throw sessionError(reason);
    req.user = user;
    req.sessionId = sessionId;
    next();
};

// For endpoints that work for guests too. An expired token still fails, so
// the client refreshes and retries instead of acting as a guest by mistake.
const optionalAuth = async (req, res, next) => {
    const { user, sessionId, reason } = await readSession(req);
    if (!user && reason === "token_expired") throw sessionError(reason);
    req.user = user;
    req.sessionId = sessionId ?? null;
    next();
};

// After requireAuth: only users whose role grants every one of these
// permissions get through (see permissions.js).
const authorize =
    (...permissions) =>
    (req, res, next) => {
        if (!permissions.every((p) => can(req.user, p))) {
            req.log.warn({ event: "auth.forbidden", permissions, role: req.user?.role }, "Permission denied");
            throw new HttpError(403, "You don't have permission to do that");
        }
        next();
    };

module.exports = { requireAuth, optionalAuth, authorize };
