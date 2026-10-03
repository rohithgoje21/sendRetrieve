// A tiny key-value store with expiry, for short-lived data such as email
// verification codes. Redis when configured (shared between instances,
// survives restarts), otherwise process memory.

// Atomically count; the first increment starts the expiry window.
const INCREMENT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

const redisStore = (client) => ({
    get: (key) => client.sendCommand(["GET", key]),
    set: (key, value, ttlSeconds) => client.sendCommand(["SET", key, String(value), "EX", String(ttlSeconds)]),
    del: (...keys) => client.sendCommand(["DEL", ...keys]),
    // Seconds until `key` expires, or 0 if it doesn't exist.
    ttl: async (key) => Math.max(0, Number(await client.sendCommand(["TTL", key]))),
    incr: async (key, ttlSeconds) =>
        Number(await client.sendCommand(["EVAL", INCREMENT_SCRIPT, "1", key, String(ttlSeconds)])),
});

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
        if (entries.size > 10_000) for (const key of entries.keys()) live(key);
    };
    return {
        get: async (key) => live(key)?.value ?? null,
        set: async (key, value, ttlSeconds) => {
            prune();
            entries.set(key, { value: String(value), expiresAt: Date.now() + ttlSeconds * 1000 });
        },
        del: async (...keys) => keys.forEach((key) => entries.delete(key)),
        ttl: async (key) => {
            const entry = live(key);
            return entry ? Math.ceil((entry.expiresAt - Date.now()) / 1000) : 0;
        },
        incr: async (key, ttlSeconds) => {
            prune();
            const entry = live(key) ?? { value: "0", expiresAt: Date.now() + ttlSeconds * 1000 };
            entry.value = String(Number(entry.value) + 1);
            entries.set(key, entry);
            return Number(entry.value);
        },
    };
};

const createKeyValueStore = (redis) => (redis ? redisStore(redis) : memoryStore());

module.exports = { createKeyValueStore };
