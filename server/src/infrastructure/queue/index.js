const config = require("../../config");
const { logger } = require("../logger");
const { MemoryBus } = require("./memoryBus");
const { RabbitBus } = require("./rabbitBus");
const { QUEUES } = require("./topology");

// The event bus for this process. Modules publish domain events
// ("share.ended", "file.downloaded"...) with publish(); workers consume them.
// RabbitMQ when AMQP_URL is set, otherwise the in-process MemoryBus.

const log = logger.child({ component: "queue" });

let bus = new MemoryBus({ retryDelaysMs: config.queue.retryDelaysMs, logger: log });

const initBus = async () => {
    if (config.queue.url) {
        bus = new RabbitBus({
            url: config.queue.url,
            retryDelaysMs: config.queue.retryDelaysMs,
            prefetch: config.queue.prefetch,
            logger,
        });
        await bus.connect();
    }
    return bus;
};

const getBus = () => bus;

// Publishes an event. A failure is logged, not thrown: the request that
// caused the event has already succeeded, and the scheduler's sweeps catch
// up on anything that depends on a lost event (e.g. files left to delete).
const publish = async (type, data) => {
    try {
        return await bus.publish(type, data);
    } catch (err) {
        log.error({ err, event: "queue.publish_failed", type }, "Couldn't publish event");
        return null;
    }
};

const isQueue = (name) => Object.hasOwn(QUEUES, name);

module.exports = { initBus, getBus, publish, isQueue };
