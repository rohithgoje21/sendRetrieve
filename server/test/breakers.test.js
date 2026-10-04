const { CircuitBreaker } = require("../src/shared/circuitBreaker");
const { mergeWorst, breakerStates, reportBreakers } = require("../src/infrastructure/breakerStatus");
const { connectRedis } = require("../src/infrastructure/redis");

test("each breaker shows its worst state across processes", () => {
    expect(
        mergeWorst([
            { name: "virus-scanner", state: "closed", failures: 0 },
            { name: "email", state: "closed", failures: 1 },
            { name: "virus-scanner", state: "open", failures: 5 },
            { name: "email", state: "closed", failures: 3 },
            { name: "web-push", state: "half_open", failures: 5 },
        ])
    ).toEqual([
        { name: "email", state: "closed", failures: 3 },
        { name: "virus-scanner", state: "open", failures: 5 },
        { name: "web-push", state: "half_open", failures: 5 },
    ]);
});

test("without Redis, this process's breakers are the whole picture", async () => {
    const breaker = new CircuitBreaker("test-local", { failureThreshold: 1, resetTimeoutMs: 60_000 });
    await expect(breaker.exec(() => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await breakerStates(null)).toContainEqual(expect.objectContaining({ name: "test-local", state: "open" }));
});

// Runs only with a Redis to talk to (see infrastructure.test.js).
(process.env.TEST_REDIS_URL ? test : test.skip)("a breaker opened in another process (the worker) shows up", async () => {
    const redis = await connectRedis(process.env.TEST_REDIS_URL);
    const stop = reportBreakers(redis, { intervalMs: 60_000 });
    try {
        // Another process reports its scanner breaker open.
        await redis.sendCommand(["SET", "breakers:worker-host:42", JSON.stringify([{ name: "virus-scanner", state: "open", failures: 5 }]), "EX", "60"]);
        const states = await breakerStates(redis);
        expect(states).toContainEqual({ name: "virus-scanner", state: "open", failures: 5 });
        // This process reported its own too.
        const own = await redis.sendCommand(["KEYS", "breakers:*"]);
        expect(own.length).toBeGreaterThanOrEqual(2);
    } finally {
        stop();
        await redis.sendCommand(["DEL", "breakers:worker-host:42"]);
        await redis.close();
    }
});
