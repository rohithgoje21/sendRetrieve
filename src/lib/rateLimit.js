const { rateLimit } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { logger } = require("./logger");

const storeLogger = logger.child({ component: "rate-limit" });

// Per-IP limiter. `ctx.rateLimit` lets tests turn limits off; with
// `ctx.redis`, counts are shared between instances and survive restarts.
// `name` must be unique per limiter (it namespaces the Redis keys).
const limiter = (ctx, { name, limit, windowMinutes = 15, error }) =>
    rateLimit({
        windowMs: windowMinutes * 60 * 1000,
        limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        skip: () => !ctx.rateLimit,
        store: ctx.redis
            ? new RedisStore({ sendCommand: (...args) => ctx.redis.sendCommand(args), prefix: `rl:${name}:` })
            : undefined,
        // If Redis is unreachable, let requests through rather than take the
        // whole site down with it.
        passOnStoreError: true,
        logger: storeLogger,
        handler: (req, res, next, options) => {
            req.log.warn({ event: "rate_limit.exceeded", limiter: name }, "Rate limit exceeded");
            res.status(options.statusCode).json({ error });
        },
    });

module.exports = { limiter };
