const { CircuitBreaker, CircuitOpenError, retryWithBackoff, backoffDelay } = require("../src/shared/circuitBreaker");
const { MemoryBus } = require("../src/infrastructure/queue/memoryBus");
const { createLocks } = require("../src/infrastructure/locks");
const { queuesFor } = require("../src/infrastructure/queue/topology");

const silent = { warn() {}, error() {}, info() {}, child() { return this; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("topology", () => {
    test("each event goes to the queues of the workers that handle it", () => {
        expect(queuesFor("share.ended").sort()).toEqual(["sr.cleanup", "sr.notifications"]);
        expect(queuesFor("file.downloaded").sort()).toEqual(["sr.analytics", "sr.notifications"]);
        expect(queuesFor("nobody.listens")).toEqual([]);
    });
});

describe("in-memory bus (RabbitMQ stand-in)", () => {
    const newBus = () => new MemoryBus({ retryDelaysMs: [5, 10, 15], logger: silent });

    test("routes events to bound queues; messages published before a consumer wait for it", async () => {
        const bus = newBus();
        const seen = [];
        await bus.publish("share.ended", { n: 1 });
        await bus.consume("sr.cleanup", async (m) => seen.push(`cleanup:${m.type}`));
        await bus.consume("sr.analytics", async (m) => seen.push(`analytics:${m.type}`));
        await bus.publish("share.opened", { n: 2 });
        await bus.whenIdle();
        expect(seen.sort()).toEqual(["analytics:share.opened", "cleanup:share.ended"]);
    });

    test("a failing job is retried with the configured delays, then dead-lettered", async () => {
        const bus = newBus();
        const attempts = [];
        await bus.consume("sr.cleanup", async (m, { attempt }) => {
            attempts.push(attempt);
            throw new Error("storage unavailable");
        });
        const started = Date.now();
        await bus.publish("share.discarded", { keys: ["a"] });
        await bus.whenIdle();
        expect(attempts).toEqual([0, 1, 2, 3]);
        expect(Date.now() - started).toBeGreaterThanOrEqual(5 + 10 + 15);

        const [dead] = await bus.peekDeadLetters("sr.cleanup");
        expect(dead).toMatchObject({ attempts: 4, error: "storage unavailable", message: { type: "share.discarded" } });
        expect((await bus.stats()).find((q) => q.name === "sr.cleanup").deadLettered).toBe(1);
    });

    test("a job that fails once succeeds on retry and isn't dead-lettered", async () => {
        const bus = newBus();
        let calls = 0;
        await bus.consume("sr.cleanup", async () => {
            if (++calls === 1) throw new Error("blip");
        });
        await bus.publish("share.discarded", {});
        await bus.whenIdle();
        expect(calls).toBe(2);
        expect(await bus.peekDeadLetters("sr.cleanup")).toEqual([]);
    });

    test("dead letters can be replayed after the cause is fixed, or purged", async () => {
        const bus = newBus();
        let broken = true;
        const handled = [];
        await bus.consume("sr.cleanup", async (m) => {
            if (broken) throw new Error("down");
            handled.push(m.data.n);
        });
        await bus.publish("share.discarded", { n: 1 });
        await bus.publish("share.discarded", { n: 2 });
        await bus.whenIdle();
        expect((await bus.peekDeadLetters("sr.cleanup")).length).toBe(2);

        broken = false;
        expect(await bus.replayDeadLetters("sr.cleanup")).toBe(2);
        await bus.whenIdle();
        expect(handled.sort()).toEqual([1, 2]);

        broken = true;
        await bus.publish("share.discarded", { n: 3 });
        await bus.whenIdle();
        expect(await bus.purgeDeadLetters("sr.cleanup")).toBe(1);
        expect(await bus.peekDeadLetters("sr.cleanup")).toEqual([]);
    });
});

describe("circuit breaker", () => {
    const failing = () => Promise.reject(new Error("provider down"));

    test("opens after consecutive failures, then fails fast without calling the service", async () => {
        const breaker = new CircuitBreaker("email", { failureThreshold: 3, resetTimeoutMs: 1000, callTimeoutMs: 1000 });
        const service = jest.fn(failing);
        for (let i = 0; i < 3; i++) await expect(breaker.exec(service)).rejects.toThrow("provider down");
        expect(breaker.state).toBe("open");

        await expect(breaker.exec(service)).rejects.toBeInstanceOf(CircuitOpenError);
        expect(service).toHaveBeenCalledTimes(3);
    });

    test("after the cool-down one trial call goes through: success closes, failure re-opens", async () => {
        const changes = [];
        const breaker = new CircuitBreaker("scanner", {
            failureThreshold: 1,
            resetTimeoutMs: 30,
            callTimeoutMs: 1000,
            onStateChange: (state) => changes.push(state),
        });
        await expect(breaker.exec(failing)).rejects.toThrow();
        await sleep(40);
        await expect(breaker.exec(failing)).rejects.toThrow("provider down"); // the trial, failed
        expect(breaker.state).toBe("open");
        await sleep(40);
        await expect(breaker.exec(async () => "ok")).resolves.toBe("ok");
        expect(breaker.state).toBe("closed");
        expect(changes).toEqual(["open", "half_open", "open", "half_open", "closed"]);
    });

    test("a call that hangs counts as a failure (timeout)", async () => {
        const breaker = new CircuitBreaker("slow", { failureThreshold: 1, resetTimeoutMs: 1000, callTimeoutMs: 20 });
        await expect(breaker.exec(() => new Promise(() => {}))).rejects.toThrow("didn't respond within 20ms");
        expect(breaker.state).toBe("open");
    });

    test("successes reset the failure count", async () => {
        const breaker = new CircuitBreaker("flaky", { failureThreshold: 2, resetTimeoutMs: 1000, callTimeoutMs: 1000 });
        await expect(breaker.exec(failing)).rejects.toThrow();
        await breaker.exec(async () => "ok");
        await expect(breaker.exec(failing)).rejects.toThrow();
        expect(breaker.state).toBe("closed");
    });
});

describe("retry with backoff", () => {
    test("retries until success, waiting longer each time", async () => {
        let calls = 0;
        const result = await retryWithBackoff(
            async () => {
                if (++calls < 3) throw new Error("transient");
                return "done";
            },
            { attempts: 3, baseMs: 1 }
        );
        expect(result).toBe("done");
        expect(calls).toBe(3);
    });

    test("gives up after the last attempt, or at once for errors that won't go away", async () => {
        await expect(retryWithBackoff(() => Promise.reject(new Error("nope")), { attempts: 2, baseMs: 1 })).rejects.toThrow("nope");
        let calls = 0;
        await expect(
            retryWithBackoff(
                () => {
                    calls++;
                    return Promise.reject(new Error("forbidden"));
                },
                { attempts: 5, baseMs: 1, shouldRetry: () => false }
            )
        ).rejects.toThrow();
        expect(calls).toBe(1);
    });

    test("delays grow exponentially, with jitter, up to a cap", () => {
        expect(backoffDelay(0, 100)).toBeGreaterThanOrEqual(80);
        expect(backoffDelay(0, 100)).toBeLessThanOrEqual(120);
        expect(backoffDelay(3, 100)).toBeGreaterThanOrEqual(640);
        expect(backoffDelay(20, 100, 5000)).toBeLessThanOrEqual(6000);
    });
});

describe("locks", () => {
    test("only one holder at a time; expired locks can be taken over", async () => {
        const locks = createLocks(null);
        const token = await locks.acquire("sweep", 30);
        expect(token).toBeTruthy();
        expect(await locks.acquire("sweep", 30)).toBeNull();
        await sleep(40);
        expect(await locks.acquire("sweep", 30)).toBeTruthy();
    });

    test("runExclusive skips while another run holds the lock", async () => {
        const locks = createLocks(null);
        let release;
        const first = locks.runExclusive("job", 1000, () => new Promise((r) => (release = r)));
        expect(await locks.runExclusive("job", 1000, async () => {})).toBe(false);
        release();
        expect(await first).toBe(true);
        expect(await locks.runExclusive("job", 1000, async () => {})).toBe(true);
    });
});
