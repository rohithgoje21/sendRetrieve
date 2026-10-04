const os = require("os");
const { allBreakers, onBreakerChange } = require("../shared/circuitBreaker");

// A circuit breaker lives in the process that calls the service: with
// RabbitMQ, the scanner's and push's breakers are in the worker, not the API.
// So every process publishes its breakers' states to Redis (on every change,
// and every few seconds as a heartbeat that expires), and the admin dashboard
// shows each breaker's worst state across processes. Without Redis there's
// one process, and its own breakers are the whole picture.

const PREFIX = "breakers:";
const TTL_SECONDS = 60;
const SEVERITY = { closed: 0, half_open: 1, open: 2 };

// One entry per breaker name: the worst state any process reports.
const mergeWorst = (snapshots) => {
    const byName = new Map();
    for (const s of snapshots) {
        const seen = byName.get(s.name);
        if (!seen || (SEVERITY[s.state] ?? 0) > (SEVERITY[seen.state] ?? 0)) byName.set(s.name, { ...s });
        else if (seen.state === s.state) seen.failures = Math.max(seen.failures ?? 0, s.failures ?? 0);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};

const reportBreakers = (redis, { intervalMs = 10_000 } = {}) => {
    const key = `${PREFIX}${os.hostname()}:${process.pid}`;
    const write = () =>
        redis
            .sendCommand(["SET", key, JSON.stringify(allBreakers().map((b) => b.snapshot())), "EX", String(TTL_SECONDS)])
            .catch(() => {});
    write();
    const stopListening = onBreakerChange(write);
    const timer = setInterval(write, intervalMs);
    timer.unref();
    return () => {
        clearInterval(timer);
        stopListening();
    };
};

const scan = async (redis, pattern) => {
    const keys = [];
    let cursor = "0";
    do {
        const [next, batch] = await redis.sendCommand(["SCAN", cursor, "MATCH", pattern, "COUNT", "100"]);
        cursor = String(next);
        keys.push(...batch);
    } while (cursor !== "0");
    return keys;
};

const breakerStates = async (redis) => {
    const local = allBreakers().map((b) => b.snapshot());
    if (!redis) return mergeWorst(local);
    try {
        const keys = await scan(redis, `${PREFIX}*`);
        const values = keys.length ? await redis.sendCommand(["MGET", ...keys]) : [];
        const remote = values.flatMap((v) => {
            try {
                return JSON.parse(v ?? "[]");
            } catch {
                return [];
            }
        });
        return mergeWorst([...local, ...remote]);
    } catch {
        return mergeWorst(local);
    }
};

module.exports = { reportBreakers, breakerStates, mergeWorst };
