const crypto = require("crypto");

// Message topology, declared by every process at startup (API and workers),
// so no event is published before the queue meant to receive it exists.
//
//   exchange sr.events (topic)
//     routing key = event type, e.g. "share.ended"
//     -> one queue per worker, bound to the events it handles
//
// Each queue also has:
//   <queue>.retry.<delay>ms  holding queues: a failed message waits there for
//                      the retry delay (queue TTL), then dead-letters back to
//                      <queue>. The delay is in the name because RabbitMQ
//                      can't change an existing queue's TTL: new delays get
//                      new queues instead of failing at startup.
//   <queue>.dlq        dead-letter queue: messages that failed every retry,
//                      kept for inspection and replay (admin dashboard)

const EXCHANGE = "sr.events";

const QUEUES = {
    "sr.cleanup": {
        description: "Deletes files from storage once their share has ended",
        events: ["share.ended", "share.discarded"],
    },
    "sr.processing": {
        description: "Scans uploaded files for malware and makes thumbnails",
        events: ["share.uploaded"],
    },
    "sr.notifications": {
        description: "Emails and in-app notifications",
        events: ["email.requested", "file.downloaded", "share.ended", "share.blocked", "auth.login"],
    },
    "sr.analytics": {
        description: "Daily statistics per share",
        events: ["share.created", "share.opened", "file.downloaded"],
    },
};

const queuesFor = (eventType) =>
    Object.entries(QUEUES)
        .filter(([, q]) => q.events.includes(eventType))
        .map(([name]) => name);

const retryQueue = (queue, delayMs) => `${queue}.retry.${delayMs}ms`;
const deadLetterQueue = (queue) => `${queue}.dlq`;

// Every message is a JSON envelope; `id` lets consumers ignore redeliveries.
const envelope = (type, data) => ({ id: crypto.randomUUID(), type, occurredAt: new Date().toISOString(), data });

module.exports = { EXCHANGE, QUEUES, queuesFor, retryQueue, deadLetterQueue, envelope };
