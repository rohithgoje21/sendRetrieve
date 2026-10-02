const { createClient } = require("redis");
const { logger } = require("./logger");

const ERROR_LOG_INTERVAL_MS = 30 * 1000;

// Connects to Redis, or throws if it can't within `timeoutMs`. Once connected,
// the client reconnects by itself if Redis goes away; while it's down,
// commands fail immediately (no offline queue) so callers can fail open
// instead of hanging requests.
const connectRedis = async (url, { timeoutMs = 10 * 1000 } = {}) => {
    const client = createClient({
        url,
        disableOfflineQueue: true,
        socket: {
            connectTimeout: 5000,
            reconnectStrategy: (retries) => Math.min(250 * 2 ** retries, 5000),
        },
    });

    // node-redis emits an error for every failed reconnect; log at most one
    // every 30 seconds.
    let lastErrorLoggedAt = 0;
    client.on("error", (err) => {
        if (Date.now() - lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) return;
        lastErrorLoggedAt = Date.now();
        logger.error({ err, event: "redis.error" }, "Redis connection error");
    });
    client.on("ready", () => logger.info({ event: "redis.ready" }, "Connected to Redis"));

    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Could not connect to Redis within ${timeoutMs / 1000}s`)),
            timeoutMs
        );
    });
    try {
        await Promise.race([client.connect(), timeout]);
        return client;
    } catch (err) {
        client.destroy();
        throw err;
    } finally {
        clearTimeout(timer);
    }
};

module.exports = { connectRedis };
