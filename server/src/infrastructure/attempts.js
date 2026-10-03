const crypto = require("crypto");
const config = require("../config");
const { logger } = require("./logger");
const { HttpError } = require("../shared/errors");

// Counts failed attempts against one target (a share's password, an account's
// login) and locks it once there are too many in the window. Per-IP rate
// limits don't stop an attacker who rotates IPs; this does.
//
// Counters live in Redis when available, otherwise in memory.

// Atomically count a failure; the first one starts the window.
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`;

const GET_SCRIPT = `
local count = redis.call('GET', KEYS[1])
if not count then return nil end
return {tonumber(count), redis.call('PTTL', KEYS[1])}
`;

const redisStore = (client) => {
    const toEntry = (reply, windowMs) =>
        reply ? { count: Number(reply[0]), ttlMs: Number(reply[1]) > 0 ? Number(reply[1]) : windowMs } : null;
    return {
        get: async (key, windowMs) => toEntry(await client.sendCommand(["EVAL", GET_SCRIPT, "1", key]), windowMs),
        increment: async (key, windowMs) =>
            toEntry(await client.sendCommand(["EVAL", INCREMENT_SCRIPT, "1", key, String(windowMs)]), windowMs),
        reset: (key) => client.sendCommand(["DEL", key]),
    };
};

const memoryStore = () => {
    const entries = new Map();
    const live = (key) => {
        const entry = entries.get(key);
        if (entry && entry.expiresAt <= Date.now()) {
            entries.delete(key);
            return null;
        }
        return entry ?? null;
    };
    const prune = () => {
        for (const key of entries.keys()) live(key);
    };
    return {
        get: async (key) => {
            const entry = live(key);
            return entry ? { count: entry.count, ttlMs: entry.expiresAt - Date.now() } : null;
        },
        increment: async (key, windowMs) => {
            if (entries.size > 10_000) prune();
            const entry = live(key) ?? { count: 0, expiresAt: Date.now() + windowMs };
            entry.count += 1;
            entries.set(key, entry);
            return { count: entry.count, ttlMs: entry.expiresAt - Date.now() };
        },
        reset: async (key) => entries.delete(key),
    };
};

const createAttemptTracker = (redis) => {
    const store = redis ? redisStore(redis) : memoryStore();
    const { maxFailedAttempts, windowSeconds } = config.lockout;
    const windowMs = windowSeconds * 1000;

    // Hashed so keys don't hold emails or share IDs in plain text.
    const keyFor = (scope, id) => `lock:${scope}:${crypto.createHash("sha256").update(String(id)).digest("hex")}`;

    // If the store is down, don't lock anyone out of the site; per-IP rate
    // limits still apply (and fail open the same way).
    const failOpen = (action) => (err) => {
        logger.warn({ err, event: "lockout.store_error" }, `Lockout store unavailable; ${action}`);
        return null;
    };

    return {
        // Throws 429 if the target is locked.
        async assertNotLocked(scope, id, message) {
            const entry = await store.get(keyFor(scope, id), windowMs).catch(failOpen("skipping lockout check"));
            if (entry && entry.count >= maxFailedAttempts) {
                const retryAfterSeconds = Math.max(1, Math.ceil(entry.ttlMs / 1000));
                const minutes = Math.ceil(retryAfterSeconds / 60);
                throw new HttpError(429, `${message} Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`, {
                    retryAfterSeconds,
                });
            }
        },

        // Returns true if this failure is the one that locked the target.
        async recordFailure(scope, id) {
            const entry = await store.increment(keyFor(scope, id), windowMs).catch(failOpen("failure not counted"));
            return entry?.count === maxFailedAttempts;
        },

        async reset(scope, id) {
            await store.reset(keyFor(scope, id)).catch(failOpen("counter not reset"));
        },
    };
};

module.exports = { createAttemptTracker };
