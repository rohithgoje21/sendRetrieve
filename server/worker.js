// The background worker process: consumes RabbitMQ queues (file cleanup,
// notifications...) and runs the scheduled sweeps. Start with `npm run worker`
// (or the "worker" service in docker-compose). Without RabbitMQ the API runs
// the workers itself and this process isn't needed.

const mongoose = require("mongoose");
const config = require("./src/config");
const { logger } = require("./src/infrastructure/logger");
const { connectRedis } = require("./src/infrastructure/redis");
const { storage } = require("./src/infrastructure/storage");
const { initBus, getBus } = require("./src/infrastructure/queue");
const { startWorkers } = require("./src/workers");

const start = async () => {
    await mongoose.connect(config.mongoUri);
    await storage.init();
    const redis = config.redisUrl ? await connectRedis(config.redisUrl) : null;
    await initBus();
    if (getBus().kind !== "rabbitmq") {
        logger.warn("AMQP_URL isn't set: with the in-process queue, the API runs the workers itself");
    }
    const workers = await startWorkers({ redis });

    let stopping = false;
    const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        logger.info({ event: "worker.stopping", signal }, "Worker shutting down");
        setTimeout(() => process.exit(1), config.shutdownTimeoutMs).unref();
        workers.stop();
        // Unacknowledged jobs go back to the queue for another worker.
        await getBus().close();
        await mongoose.disconnect();
        if (redis) await redis.close();
        process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
};

process.on("unhandledRejection", (err) => logger.error({ err, event: "process.unhandled_rejection" }, "Unhandled promise rejection"));

start().catch((err) => {
    logger.fatal({ err, event: "worker.start_failed" }, "Worker failed to start");
    process.exit(1);
});
