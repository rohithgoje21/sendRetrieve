const { rateLimit } = require("express-rate-limit");

// Per-IP limiter. `enabled` lets tests turn limits off.
const limiter = (enabled, { limit, windowMinutes = 15, error }) =>
    rateLimit({
        windowMs: windowMinutes * 60 * 1000,
        limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        message: { error },
        skip: () => !enabled,
    });

module.exports = { limiter };
