const { HttpError } = require("../../shared/errors");
const { readSession } = require("./sessions");

// Request guards. Typical chain:  requireAuth -> requireRole("admin") -> handler

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

// After requireAuth: only users with this role (e.g. "admin") get through.
const requireRole = (role) => (req, res, next) => {
    if (req.user?.role !== role) throw new HttpError(403, "You don't have permission to do that");
    next();
};

module.exports = { requireAuth, optionalAuth, requireRole };
