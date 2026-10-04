const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const config = require("./config");
const { createSharesRouter } = require("./modules/shares/shares.routes");
const { createAuthRouter } = require("./modules/auth/auth.routes");
const { createUsersRouter } = require("./modules/users/users.routes");
const { createMySharesRouter } = require("./modules/shares/myShares.routes");
const { createDownloadsRouter } = require("./modules/files/downloads.routes");
const { createHealthRouter } = require("./modules/system/health.routes");
const { createConfigRouter } = require("./modules/system/config.routes");
const { createAdminRouter } = require("./modules/admin/admin.routes");
const { createNotificationsRouter } = require("./modules/notifications/notifications.routes");
const { createAnalyticsRouter } = require("./modules/analytics/analytics.routes");
const { httpMetrics } = require("./infrastructure/metrics");
const { createUploadsRouter } = require("./modules/files/uploads.routes");
const { storage } = require("./infrastructure/storage");
const { createKeyValueStore } = require("./infrastructure/kv");
const { createOtpService } = require("./modules/auth/otp");
const { createRequestLogger } = require("./shared/requestLogging");
const { createAttemptTracker } = require("./infrastructure/attempts");
const { HttpError, errorHandler } = require("./shared/errors");

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
    // index.html is served from memory: it's requested for every page load,
    // and reading it from disk each time goes through libuv's thread pool,
    // which password hashing also uses (the load tests showed page loads
    // queueing behind logins). Read again if the file changes (a new build).
    let page = null;
    const loadIndex = () => {
        const stats = fs.statSync(indexHtml, { throwIfNoEntry: false });
        if (!stats) return null;
        if (page?.mtimeMs !== stats.mtimeMs) page = { mtimeMs: stats.mtimeMs, html: fs.readFileSync(indexHtml) };
        return page.html;
    };
    let checkedAt = 0;
    app.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        if (path.extname(req.path)) return next();
        // Look at the file at most once a second.
        if (!page || Date.now() - checkedAt > 1000) {
            checkedAt = Date.now();
            loadIndex();
        }
        if (!page) return res.status(503).type("text").send(CLIENT_NOT_BUILT);
        res.set("Cache-Control", "no-cache").type("html").send(page.html);
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
    for (const url of [config.appUrl, ...config.corsOrigins].filter(Boolean)) allowed.add(new URL(url).host);

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
//   redis      connected node-redis client, or null for in-memory limits and codes
//   logger     pino logger for request logs (tests pass one to capture output)
const createApp = ({ rateLimit = true, redis = null, logger } = {}) => {
    const app = express();
    const ctx = {
        rateLimit,
        redis,
        storage,
        attempts: createAttemptTracker(redis),
        otp: createOtpService(createKeyValueStore(redis)),
    };
    // Files are fetched from (and uploaded to) object storage directly, so the
    // page must be allowed to load media from and send requests to it.
    const storageOrigins = storage.publicOrigin ? [storage.publicOrigin] : [];
    // Helmet asks browsers to upgrade http:// requests to https://. Good in
    // production, but it would also rewrite redirects to a local MinIO at
    // http://localhost:9000, which has no HTTPS, so it's left out then.
    const httpStorage = storageOrigins.some((origin) => origin.startsWith("http:"));

    app.set("trust proxy", config.trustProxy);
    app.disable("x-powered-by");

    // First, so every request has an ID and a logger.
    app.use(httpMetrics);
    app.use(createRequestLogger(logger));
    app.use(
        helmet({
            contentSecurityPolicy: {
                directives: {
                    "img-src": ["'self'", "data:", ...storageOrigins],
                    "media-src": ["'self'", ...storageOrigins],
                    "connect-src": ["'self'", ...storageOrigins],
                    "upgrade-insecure-requests": httpStorage ? null : [],
                },
            },
        })
    );
    app.use(createHealthRouter(ctx));
    app.use(cookieParser());

    app.use("/api", sameOriginOnly);
    // Raw file bodies (disk storage only); before the JSON parser on purpose.
    if (storage.receiveUpload) app.use("/api/uploads", createUploadsRouter(ctx, storage));
    // Room for a share's message (up to 100,000 characters) plus file details.
    app.use(express.json({ limit: "512kb" }));

    app.use("/api/auth", createAuthRouter(ctx));
    app.use("/api/me/shares", createMySharesRouter(ctx));
    app.use("/api/me/analytics", createAnalyticsRouter(ctx));
    app.use("/api/me", createUsersRouter(ctx));
    app.use("/api/admin", createAdminRouter(ctx));
    app.use("/api/notifications", createNotificationsRouter(ctx));
    app.use("/api", createConfigRouter());
    app.use("/api", createSharesRouter(ctx));
    app.use("/api", createDownloadsRouter(ctx));
    app.use("/api", () => {
        throw new HttpError(404, "Not found");
    });

    serveClient(app);

    app.use(errorHandler);
    return app;
};

module.exports = { createApp };
