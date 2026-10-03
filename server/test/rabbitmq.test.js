// The RabbitMQ event bus against a real broker. Runs only when one is
// available, e.g.:
//
//   docker run -d --name rabbit-test -p 5673:5672 rabbitmq:4
//   TEST_AMQP_URL=amqp://guest:guest@localhost:5673 npm test -w server

const { RabbitBus } = require("../src/infrastructure/queue/rabbitBus");
const { QUEUES, retryQueue, deadLetterQueue } = require("../src/infrastructure/queue/topology");

const TEST_AMQP_URL = process.env.TEST_AMQP_URL;
const silent = { warn() {}, error() {}, info() {}, debug() {}, child() { return silent; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until `check` passes (RabbitMQ delivers asynchronously).
const eventually = async (check, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            return await check();
        } catch (err) {
            if (Date.now() > deadline) throw err;
            await sleep(50);
        }
    }
};

(TEST_AMQP_URL ? describe : describe.skip)("RabbitMQ bus", () => {
    let bus;
    const newBus = async () => {
        const b = new RabbitBus({ url: TEST_AMQP_URL, retryDelaysMs: [100, 200], prefetch: 5, logger: silent });
        await b.connect();
        return b;
    };

    beforeEach(async () => {
        bus = await newBus();
        // Start each test from empty queues.
        await bus.withChannel(async (channel) => {
            for (const queue of Object.keys(QUEUES)) {
                for (const name of [queue, retryQueue(queue, 100), retryQueue(queue, 200), deadLetterQueue(queue)]) {
                    await channel.purgeQueue(name);
                }
            }
        });
    });

    afterEach(() => bus?.close());

    test("declares the topology and routes events to the bound queues", async () => {
        await bus.publish("share.opened", { n: 1 });
        await bus.publish("share.ended", { n: 2 });
        await eventually(async () => {
            const stats = Object.fromEntries((await bus.stats()).map((q) => [q.name, q.ready]));
            expect(stats).toMatchObject({ "sr.analytics": 1, "sr.cleanup": 1, "sr.notifications": 1, "sr.processing": 0 });
        });
    });

    test("messages are persistent: published before a consumer exists, delivered once it starts", async () => {
        await bus.publish("share.discarded", { n: 1 });
        const seen = [];
        await bus.consume("sr.cleanup", async (m) => seen.push(m.data.n));
        await eventually(() => expect(seen).toEqual([1]));
    });

    test("failed jobs go through the delayed retry queues, then to the dead-letter queue", async () => {
        const attempts = [];
        await bus.consume("sr.cleanup", async (m, { attempt }) => {
            attempts.push({ attempt, at: Date.now() });
            throw new Error("storage unavailable");
        });
        await bus.publish("share.discarded", { keys: ["a"] });

        await eventually(async () => expect((await bus.stats()).find((q) => q.name === "sr.cleanup").deadLettered).toBe(1));
        expect(attempts.map((a) => a.attempt)).toEqual([0, 1, 2]);
        // The retry queues' TTLs delayed each attempt.
        expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(90);
        expect(attempts[2].at - attempts[1].at).toBeGreaterThanOrEqual(190);

        const [dead] = await bus.peekDeadLetters("sr.cleanup");
        expect(dead).toMatchObject({ attempts: 3, error: "storage unavailable", message: { type: "share.discarded" } });
        // Peeking doesn't remove it.
        expect((await bus.stats()).find((q) => q.name === "sr.cleanup").deadLettered).toBe(1);
    });

    test("dead letters can be replayed (handled again from scratch) or purged", async () => {
        let broken = true;
        const handled = [];
        await bus.consume("sr.cleanup", async (m, { attempt }) => {
            if (broken) throw new Error("down");
            handled.push({ n: m.data.n, attempt });
        });
        await bus.publish("share.discarded", { n: 7 });
        await eventually(async () => expect((await bus.stats()).find((q) => q.name === "sr.cleanup").deadLettered).toBe(1));

        broken = false;
        expect(await bus.replayDeadLetters("sr.cleanup")).toBe(1);
        await eventually(() => expect(handled).toEqual([{ n: 7, attempt: 0 }]));

        broken = true;
        await bus.publish("share.discarded", { n: 8 });
        await eventually(async () => expect((await bus.stats()).find((q) => q.name === "sr.cleanup").deadLettered).toBe(1));
        expect(await bus.purgeDeadLetters("sr.cleanup")).toBe(1);
    });

    test("an unacknowledged job goes back to the queue when its worker dies", async () => {
        const doomed = await newBus();
        await doomed.consume("sr.cleanup", () => new Promise(() => {})); // never finishes
        await bus.publish("share.discarded", { n: 9 });
        await eventually(async () => expect((await bus.stats()).find((q) => q.name === "sr.cleanup").consumers).toBe(1));
        await sleep(200);
        await doomed.close(); // the worker "crashes" mid-job

        const seen = [];
        await bus.consume("sr.cleanup", async (m) => seen.push(m.data.n));
        await eventually(() => expect(seen).toEqual([9]));
    });

    test("health reports the connection", async () => {
        expect(await bus.health()).toBe("up");
        await bus.close();
        expect(await bus.health()).toBe("down");
    });
});
