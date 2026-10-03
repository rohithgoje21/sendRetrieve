const crypto = require("crypto");

// A lock shared by every instance (Redis), so a job that must run on one
// instance at a time (the cleanup sweep) does. Falls back to an in-process
// lock without Redis. Locks expire after `ttlMs` in case the holder dies.

// Delete the key only if it's still ours.
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

const createLocks = (redis) => {
    const local = new Map();

    const acquire = async (name, ttlMs) => {
        const key = `lock:${name}`;
        const token = crypto.randomUUID();
        if (redis) {
            const ok = await redis.sendCommand(["SET", key, token, "NX", "PX", String(ttlMs)]);
            return ok === "OK" ? token : null;
        }
        const held = local.get(key);
        if (held && held.expiresAt > Date.now()) return null;
        local.set(key, { token, expiresAt: Date.now() + ttlMs });
        return token;
    };

    const release = async (name, token) => {
        const key = `lock:${name}`;
        if (redis) return redis.sendCommand(["EVAL", RELEASE_SCRIPT, "1", key, token]);
        if (local.get(key)?.token === token) local.delete(key);
    };

    // Runs `fn` if the lock is free; otherwise skips. Returns whether it ran.
    const runExclusive = async (name, ttlMs, fn) => {
        const token = await acquire(name, ttlMs);
        if (!token) return false;
        try {
            await fn();
        } finally {
            await release(name, token).catch(() => {});
        }
        return true;
    };

    return { acquire, release, runExclusive };
};

module.exports = { createLocks };
