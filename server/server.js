const mongoose = require("mongoose");
const config = require("./src/config");
const { createApp } = require("./src/app");
const { logger } = require("./src/lib/logger");
const { connectRedis } = require("./src/lib/redis");
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
        logger.warn("RESEND_API_KEY is not set: emails (including reset links) will be written to the log, not sent");
    }
};

const start = async () => {
    warnAboutConfig();

    await mongoose.connect(config.mongoUri);
    logger.info({ event: "mongo.connected" }, "Connected to MongoDB");

    // Brings indexes in line with the schemas, e.g. replacing Phase 1's TTL
    // index on expiresAt, which would otherwise delete owned shares' history.
    await Promise.all([Share.syncIndexes(), User.syncIndexes(), RefreshToken.syncIndexes()]);

    // Redis is optional, but if it's configured and unreachable at startup we
    // fail fast (the platform restarts us) rather than silently run without it.
    const redis = config.redisUrl ? await connectRedis(config.redisUrl) : null;
    if (!redis) logger.info("REDIS_URL not set: rate limits and lockouts are kept in memory");

    const cleanupTimer = startCleanupJob(config.cleanupIntervalMs);
    const app = createApp({ redis });
    const server = app.listen(config.port, () => {
        logger.info({ event: "server.started", port: config.port }, `Listening on port ${config.port}`);
    });

    // Graceful shutdown: stop taking new connections, let in-flight requests
    // finish (up to shutdownTimeoutMs), then close database connections.
    let shuttingDown = false;
    const shutdown = (signal) => {
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

        server.close(async () => {
            try {
                await mongoose.disconnect();
                if (redis) await redis.close();
                logger.info({ event: "server.stopped" }, "Shutdown complete");
                process.exit(0);
            } catch (err) {
                logger.error({ err }, "Error during shutdown");
                process.exit(1);
            }
        });
        server.closeIdleConnections();
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
