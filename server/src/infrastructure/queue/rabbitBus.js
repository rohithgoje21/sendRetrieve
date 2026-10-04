const amqplib = require("amqplib");
const { EXCHANGE, QUEUES, queuesFor, retryQueue, deadLetterQueue, envelope } = require("./topology");

// RabbitMQ event bus.
//
//   publish   persistent messages through a confirm channel: publish()
//             resolves only once the broker has stored the message
//   consume   manual acks, prefetch limit; a failed job is moved to the next
//             retry queue (delayed by TTL) and finally to the dead-letter
//             queue, with the error in its headers
//   recovery  amqplib reconnects automatically; topology, the publish channel
//             and consumers are recreated after every reconnect

class RabbitBus {
    constructor({ url, retryDelaysMs, prefetch, logger }) {
        this.kind = "rabbitmq";
        this.url = url;
        this.retryDelaysMs = retryDelaysMs;
        this.prefetch = prefetch;
        this.log = logger.child({ component: "queue" });
        this.consumers = new Map(); // queue -> handler, re-registered after reconnects
        this.model = null;
        this.publishChannel = null;
        this.connected = false;
    }

    async connect() {
        this.connection = await amqplib.connect(this.url, {
            recovery: {
                initialDelay: 500,
                maxDelay: 10_000,
                // Fail the deployment fast if the broker is unreachable at
                // startup, but never give up once we've been connected.
                initialMaxRetries: 5,
                maxRetries: Infinity,
                setup: (model) => this.setup(model),
            },
        });
        this.connection.on("disconnect", (err) => {
            this.connected = false;
            this.log.warn({ event: "queue.disconnected", err }, "Lost connection to RabbitMQ; reconnecting");
        });
        this.connection.on("connect", () => this.log.info({ event: "queue.connected" }, "Connected to RabbitMQ"));
        // Without a listener, an "error" event would crash the process.
        this.connection.on("error", (err) => this.log.error({ event: "queue.error", err }, "RabbitMQ connection error"));
    }

    // Runs after every (re)connect.
    async setup(model) {
        const channel = await model.createConfirmChannel();
        await this.assertTopology(channel);
        this.model = model;
        this.publishChannel = channel;
        for (const [queue, handler] of this.consumers) await this.startConsumer(queue, handler);
        this.connected = true;
    }

    async assertTopology(channel) {
        await channel.assertExchange(EXCHANGE, "topic", { durable: true });
        for (const [queue, { events }] of Object.entries(QUEUES)) {
            await channel.assertQueue(queue, { durable: true });
            for (const event of events) await channel.bindQueue(queue, EXCHANGE, event);
            for (const delay of new Set(this.retryDelaysMs)) {
                await channel.assertQueue(retryQueue(queue, delay), {
                    durable: true,
                    // When the wait is over, the message goes back to the main queue.
                    arguments: {
                        "x-message-ttl": delay,
                        "x-dead-letter-exchange": "",
                        "x-dead-letter-routing-key": queue,
                    },
                });
            }
            await channel.assertQueue(deadLetterQueue(queue), { durable: true });
        }
    }

    async health() {
        return this.connected ? "up" : "down";
    }

    async publish(type, data) {
        if (!this.publishChannel || !this.connected) throw new Error("Not connected to RabbitMQ");
        const message = envelope(type, data);
        this.publishChannel.publish(EXCHANGE, type, Buffer.from(JSON.stringify(message)), {
            persistent: true,
            contentType: "application/json",
            messageId: message.id,
            type,
            timestamp: Math.floor(Date.now() / 1000),
        });
        await this.publishChannel.waitForConfirms();
        if (queuesFor(type).length === 0) this.log.warn({ event: "queue.unrouted", type }, "No queue receives this event");
        return message;
    }

    async consume(queue, handler) {
        this.consumers.set(queue, handler);
        if (this.model) await this.startConsumer(queue, handler);
    }

    async startConsumer(queue, handler) {
        const channel = await this.model.createChannel();
        await channel.prefetch(this.prefetch);
        await channel.consume(queue, async (raw) => {
            if (!raw) return; // consumer cancelled by the broker
            const attempt = Number(raw.properties.headers?.["x-attempt"] ?? 0);
            let message;
            try {
                message = JSON.parse(raw.content.toString());
            } catch (err) {
                // Unreadable: no retry will fix it.
                return this.moveTo(channel, raw, deadLetterQueue(queue), attempt, err);
            }
            try {
                await handler(message, { attempt, queue });
                channel.ack(raw);
            } catch (err) {
                if (attempt < this.retryDelaysMs.length) {
                    this.log.warn({ event: "queue.retry", queue, type: message.type, attempt: attempt + 1, err }, "Job failed; will retry");
                    this.moveTo(channel, raw, retryQueue(queue, this.retryDelaysMs[attempt]), attempt + 1, err);
                } else {
                    this.log.error({ event: "queue.dead_lettered", queue, type: message.type, err }, "Job failed every retry");
                    this.moveTo(channel, raw, deadLetterQueue(queue), attempt + 1, err);
                }
            }
        });
    }

    // Re-publishes a message to another queue, then acks the original. (If the
    // process dies in between, the original is redelivered: consumers are
    // idempotent, so at worst a job runs twice.)
    moveTo(channel, raw, target, attempt, err) {
        channel.sendToQueue(target, raw.content, {
            ...raw.properties,
            headers: {
                ...raw.properties.headers,
                "x-attempt": attempt,
                "x-last-error": String(err?.message ?? err).slice(0, 500),
                "x-failed-at": new Date().toISOString(),
            },
        });
        channel.ack(raw);
    }

    async withChannel(fn) {
        if (!this.model) throw new Error("Not connected to RabbitMQ");
        const channel = await this.model.createChannel();
        try {
            return await fn(channel);
        } finally {
            await channel.close().catch(() => {});
        }
    }

    async stats() {
        return this.withChannel(async (channel) => {
            const result = [];
            for (const [name, { description }] of Object.entries(QUEUES)) {
                const main = await channel.checkQueue(name);
                const dlq = await channel.checkQueue(deadLetterQueue(name));
                let retrying = 0;
                for (const delay of this.retryDelaysMs) retrying += (await channel.checkQueue(retryQueue(name, delay))).messageCount;
                result.push({
                    name,
                    description,
                    ready: main.messageCount,
                    retrying,
                    consumers: main.consumerCount,
                    deadLettered: dlq.messageCount,
                });
            }
            return result;
        });
    }

    // Reads dead-lettered messages without removing them.
    async peekDeadLetters(queue, limit = 20) {
        return this.withChannel(async (channel) => {
            const items = [];
            for (let i = 0; i < limit; i++) {
                const raw = await channel.get(deadLetterQueue(queue), { noAck: false });
                if (!raw) break;
                const headers = raw.properties.headers ?? {};
                let message;
                try {
                    message = JSON.parse(raw.content.toString());
                } catch {
                    message = { id: raw.properties.messageId, type: raw.properties.type, data: raw.content.toString().slice(0, 200) };
                }
                items.push({
                    message,
                    attempts: headers["x-attempt"] ?? null,
                    error: headers["x-last-error"] ?? null,
                    failedAt: headers["x-failed-at"] ?? null,
                });
            }
            channel.nackAll(true); // put them all back, in order
            return items;
        });
    }

    // Moves every dead-lettered message back to its queue for another go.
    async replayDeadLetters(queue) {
        return this.withChannel(async (channel) => {
            let count = 0;
            for (;;) {
                const raw = await channel.get(deadLetterQueue(queue), { noAck: false });
                if (!raw) break;
                const { "x-attempt": _attempt, "x-last-error": _error, "x-failed-at": _failed, ...headers } = raw.properties.headers ?? {};
                channel.sendToQueue(queue, raw.content, { ...raw.properties, headers });
                channel.ack(raw);
                count++;
            }
            return count;
        });
    }

    async purgeDeadLetters(queue) {
        return this.withChannel(async (channel) => (await channel.purgeQueue(deadLetterQueue(queue))).messageCount);
    }

    async close() {
        this.connected = false;
        await this.connection?.close().catch(() => {});
    }
}

module.exports = { RabbitBus };
