const { getBus } = require("../infrastructure/queue");
const { createKeyValueStore } = require("../infrastructure/kv");
const { createLocks } = require("../infrastructure/locks");
const { logger } = require("../infrastructure/logger");
const { startScheduler } = require("./scheduler");

// Background workers. Run in their own process (server/worker.js) when
// RabbitMQ is used, or inside the API process otherwise.
const WORKERS = [
    require("./cleanup.worker"),
    require("./notification.worker"),
    require("./processing.worker"),
    require("./analytics.worker"),
];

const PROCESSED_TTL_SECONDS = 24 * 60 * 60;

// Wraps a handler: logs each job, and skips messages already handled (queues
// deliver at least once, so the same message can arrive twice).
const asJob = ({ queue, handle }, ctx) => async (message, { attempt }) => {
    const doneKey = `job:${queue}:${message.id}`;
    if (await ctx.kv.get(doneKey).catch(() => null)) return;

    const log = ctx.log.child({ queue, messageId: message.id, type: message.type, attempt });
    const started = Date.now();
    try {
        await handle(message, { ...ctx, log });
    } catch (err) {
        log.warn({ err, event: "job.failed", durationMs: Date.now() - started }, "Job failed");
        throw err;
    }
    await ctx.kv.set(doneKey, "1", PROCESSED_TTL_SECONDS).catch(() => {});
    log.debug({ event: "job.completed", durationMs: Date.now() - started }, "Job completed");
};

const startWorkers = async ({ redis = null, scheduler = true } = {}) => {
    const bus = getBus();
    const ctx = {
        bus,
        kv: createKeyValueStore(redis),
        locks: createLocks(redis),
        log: logger.child({ component: "worker" }),
    };
    for (const worker of WORKERS) await bus.consume(worker.queue, asJob(worker, ctx));
    const stopScheduler = scheduler ? startScheduler(ctx) : () => {};
    ctx.log.info({ event: "workers.started", queues: WORKERS.map((w) => w.queue), scheduler }, "Workers started");
    return { stop: stopScheduler };
};

module.exports = { startWorkers, WORKERS };
