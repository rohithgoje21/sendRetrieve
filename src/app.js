const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const config = require("./config");
const { createSharesRouter } = require("./routes/shares");
const { createAuthRouter } = require("./routes/auth");
const { createMeRouter } = require("./routes/me");
const { createHealthRouter } = require("./routes/health");
const { createRequestLogger } = require("./lib/requestLogging");
const { createAttemptTracker } = require("./lib/attempts");
const { HttpError, errorHandler } = require("./lib/errors");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF defense on top of SameSite=Strict cookies: reject state-changing
// requests that a browser marks as coming from another site.
const sameOriginOnly = (req, res, next) => {
    const origin = req.get("origin");
    if (SAFE_METHODS.has(req.method) || !origin) return next();

    const allowed = new Set([req.get("host"), req.get("x-forwarded-host")]);
    if (config.appUrl) allowed.add(new URL(config.appUrl).host);

    let originHost = null;
    try {
        originHost = new URL(origin).host;
    } catch {
        // malformed Origin: rejected below
    }
    if (!allowed.has(originHost)) throw new HttpError(403, "Cross-site request blocked");
    next();
};

// Options:
//   rateLimit  per-IP rate limits on/off (tests turn them off)
//   redis      connected node-redis client, or null for in-memory limits
//   logger     pino logger for request logs (tests pass one to capture output)
const createApp = ({ rateLimit = true, redis = null, logger } = {}) => {
    const app = express();
    const ctx = { rateLimit, redis, attempts: createAttemptTracker(redis) };

    app.set("trust proxy", config.trustProxy);
    app.disable("x-powered-by");

    // First, so every request has an ID and a logger.
    app.use(createRequestLogger(logger));
    app.use(helmet());
    app.use(createHealthRouter(ctx));
    app.use(cookieParser());
    app.use(express.json({ limit: "10kb" }));

    app.use("/api", sameOriginOnly);
    app.use("/api/auth", createAuthRouter(ctx));
    app.use("/api/me", createMeRouter(ctx));
    app.use("/api", createSharesRouter(ctx));
    app.use("/api", () => {
        throw new HttpError(404, "Not found");
    });

    // /login serves login.html, /shares serves shares.html, etc.
    app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
    // Share links: the page reads the code from the URL and pre-fills it.
    app.get("/s/:code", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

    app.use(errorHandler);
    return app;
};

module.exports = { createApp };
