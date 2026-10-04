const { QUEUES, queuesFor, envelope } = require("./topology");

// An in-process stand-in for RabbitMQ with the same behavior: routing by
// event type, retries with delays, and a dead-letter queue per queue. Used
// when AMQP_URL isn't set (a single server, local development, tests).
// Messages don't survive a restart; the scheduler's sweeps make up for that.

class MemoryBus {
    constructor({ retryDelaysMs, logger }) {
        this.kind = "memory";
        this.retryDelaysMs = retryDelaysMs;
        this.log = logger;
        this.handlers = new Map(); // queue -> handler
        this.waiting = new Map(); // queue -> messages published before a consumer existed
        this.deadLetters = new Map(); // queue -> failed messages
        this.retrying = new Map(); // queue -> messages waiting for a retry
        this.inFlight = 0;
        this.timers = new Set();
        this.idleWaiters = [];
        for (const queue of Object.keys(QUEUES)) {
            this.waiting.set(queue, []);
            this.deadLetters.set(queue, []);
            this.retrying.set(queue, 0);
        }
    }

    async connect() {}

    async health() {
        return "memory";
    }

    async publish(type, data) {
        const message = envelope(type, data);
        for (const queue of queuesFor(type)) this.deliver(queue, message, 0, 0);
        return message;
    }

    async consume(queue, handler) {
        this.handlers.set(queue, handler);
        const waiting = this.waiting.get(queue) ?? [];
        this.waiting.set(queue, []);
        for (const { message, attempt } of waiting) this.deliver(queue, message, attempt, 0);
    }

    deliver(queue, message, attempt, delayMs) {
        const handler = this.handlers.get(queue);
        if (!handler) {
            this.waiting.get(queue)?.push({ message, attempt });
            return;
        }
        this.inFlight++;
        if (delayMs > 0) this.retrying.set(queue, this.retrying.get(queue) + 1);
        const timer = setTimeout(async () => {
            this.timers.delete(timer);
            if (delayMs > 0) this.retrying.set(queue, this.retrying.get(queue) - 1);
            try {
                await handler(message, { attempt, queue });
            } catch (err) {
                this.fail(queue, message, attempt, err);
            } finally {
                this.inFlight--;
                this.checkIdle();
            }
        }, delayMs);
        this.timers.add(timer);
    }

    fail(queue, message, attempt, err) {
        if (attempt < this.retryDelaysMs.length) {
            this.log.warn(
                { event: "queue.retry", queue, type: message.type, attempt: attempt + 1, err },
                "Job failed; will retry"
            );
            this.deliver(queue, message, attempt + 1, this.retryDelaysMs[attempt]);
        } else {
            this.log.error({ event: "queue.dead_lettered", queue, type: message.type, err }, "Job failed every retry");
            this.deadLetters.get(queue).push({
                message,
                attempts: attempt + 1,
                error: err.message,
                failedAt: new Date().toISOString(),
            });
        }
    }

    async stats() {
        return Object.keys(QUEUES).map((name) => ({
            name,
            description: QUEUES[name].description,
            ready: this.waiting.get(name).length,
            retrying: this.retrying.get(name),
            consumers: this.handlers.has(name) ? 1 : 0,
            deadLettered: this.deadLetters.get(name).length,
        }));
    }

    async peekDeadLetters(queue, limit = 20) {
        return (this.deadLetters.get(queue) ?? []).slice(0, limit);
    }

    async replayDeadLetters(queue) {
        const messages = this.deadLetters.get(queue) ?? [];
        this.deadLetters.set(queue, []);
        for (const { message } of messages) this.deliver(queue, message, 0, 0);
        return messages.length;
    }

    async purgeDeadLetters(queue) {
        const count = (this.deadLetters.get(queue) ?? []).length;
        this.deadLetters.set(queue, []);
        return count;
    }

    // Resolves once every published message has been handled (tests).
    whenIdle() {
        return new Promise((resolve) => {
            this.idleWaiters.push(resolve);
            this.checkIdle();
        });
    }

    checkIdle() {
        if (this.inFlight > 0) return;
        setImmediate(() => {
            if (this.inFlight > 0) return;
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            waiters.forEach((resolve) => resolve());
        });
    }

    async close() {
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.handlers.clear();
    }
}

module.exports = { MemoryBus };
