const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const config = require("./config");
const { createSharesRouter } = require("./routes/shares");
const { createAuthRouter } = require("./routes/auth");
const { createMeRouter } = require("./routes/me");
const { createHealthRouter } = require("./routes/health");
const { createConfigRouter } = require("./routes/config");
const { createRequestLogger } = require("./lib/requestLogging");
const { createAttemptTracker } = require("./lib/attempts");
const { HttpError, errorHandler } = require("./lib/errors");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const CLIENT_NOT_BUILT =
    "The React app hasn't been built. Run `npm run build` in the repo root, " +
    "or use the dev server (`npm run dev`) at http://localhost:5173.";

// Serves the built React app. Hashed files under /assets never change, so
// browsers may cache them for a year; index.html is revalidated every time so
// a new deploy is picked up. Other page paths (/, /shares, /s/CODE...) get
// index.html and React Router renders the page. Paths that look like files
// (/missing.png, /uploads/x.pdf) get a real 404 instead.
const serveClient = (app) => {
    const indexHtml = path.join(config.clientDir, "index.html");

    app.use(
        "/assets",
        express.static(path.join(config.clientDir, "assets"), { immutable: true, maxAge: "1y", fallthrough: false })
    );
    app.use(express.static(config.clientDir, { index: false }));
    app.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        if (path.extname(req.path)) return next();
        if (!fs.existsSync(indexHtml)) return res.status(503).type("text").send(CLIENT_NOT_BUILT);
        res.sendFile(indexHtml, { headers: { "Cache-Control": "no-cache" } });
    });
    app.use(() => {
        throw new HttpError(404, "Not found");
    });
};

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
    app.use("/api", createConfigRouter());
    app.use("/api", createSharesRouter(ctx));
    app.use("/api", () => {
        throw new HttpError(404, "Not found");
    });

    serveClient(app);

    app.use(errorHandler);
    return app;
};

module.exports = { createApp };
