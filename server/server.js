const http = require("http");
const mongoose = require("mongoose");
const config = require("./src/config");
const { createApp } = require("./src/app");
const { initRealtime, closeRealtime } = require("./src/realtime");
const { logger } = require("./src/lib/logger");
const { connectRedis } = require("./src/lib/redis");
const { storage } = require("./src/lib/storage");
const { startCleanupJob } = require("./src/lib/cleanup");
const Share = require("./src/models/Share");
const User = require("./src/models/User");
const RefreshToken = require("./src/models/RefreshToken");

const warnAboutConfig = () => {
    if (config.env !== "production") return;
    if (!process.env.TOKEN_SECRET) {
        logger.warn("TOKEN_SECRET is not set: sessions and download links will break on every restart");
    }
    if (!config.appUrl) logger.warn("APP_URL is not set: emailed links will use the request's Host header");
    if (!config.email.resendApiKey) {
        logger.warn("RESEND_API_KEY is not set: emails (reset links, verification codes) will be written to the log, not sent");
    }
    if (config.storage.driver === "disk") {
        logger.warn("STORAGE_DRIVER is disk: uploaded files are lost whenever this server's disk is wiped (e.g. redeploys)");
    }
};

const start = async () => {
    warnAboutConfig();

    await mongoose.connect(config.mongoUri);
    logger.info({ event: "mongo.connected" }, "Connected to MongoDB");

    // Brings indexes in line with the schemas, e.g. replacing Phase 1's TTL
    // index on expiresAt, which would otherwise delete owned shares' history.
    await Promise.all([Share.syncIndexes(), User.syncIndexes(), RefreshToken.syncIndexes()]);

    // Fail fast if the bucket is missing or the credentials are wrong.
    await storage.init();

    // Redis is optional, but if it's configured and unreachable at startup we
    // fail fast (the platform restarts us) rather than silently run without it.
    const redis = config.redisUrl ? await connectRedis(config.redisUrl) : null;
    if (!redis) logger.info("REDIS_URL not set: rate limits, lockouts and codes are kept in memory");

    const cleanupTimer = startCleanupJob(config.cleanupIntervalMs);
    const app = createApp({ redis });
    // One HTTP server for both the API and Socket.IO (which handles /socket.io).
    const server = http.createServer(app);
    await initRealtime(server, { redis });
    server.listen(config.port, () => {
        logger.info({ event: "server.started", port: config.port }, `Listening on port ${config.port}`);
    });

    // Graceful shutdown: stop taking new connections, disconnect sockets, let
    // in-flight requests finish (up to shutdownTimeoutMs), then close the
    // database connections.
    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        app.locals.shuttingDown = true; // /healthz starts returning 503
        logger.info({ event: "server.stopping", signal }, "Shutting down");
        clearInterval(cleanupTimer);

        const forceExit = setTimeout(() => {
            logger.warn("Requests still running after timeout; forcing shutdown");
            server.closeAllConnections();
            process.exit(1);
        }, config.shutdownTimeoutMs);
        forceExit.unref();

        try {
            // Closes Socket.IO and the HTTP server; resolves once requests finish.
            const closed = closeRealtime();
            server.closeIdleConnections();
            await closed;
            await mongoose.disconnect();
            if (redis) await redis.close();
            logger.info({ event: "server.stopped" }, "Shutdown complete");
            process.exit(0);
        } catch (err) {
            logger.error({ err }, "Error during shutdown");
            process.exit(1);
        }
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
};

process.on("unhandledRejection", (err) => {
    logger.error({ err, event: "process.unhandled_rejection" }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
    logger.fatal({ err, event: "process.uncaught_exception" }, "Uncaught exception; exiting");
    process.exit(1);
});

start().catch((err) => {
    logger.fatal({ err, event: "server.start_failed" }, "Failed to start server");
    process.exit(1);
});
