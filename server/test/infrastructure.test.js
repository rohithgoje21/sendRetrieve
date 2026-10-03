const { Writable } = require("stream");
const { app, createShare, useTestDatabase } = require("./helpers");
const request = require("supertest");
const config = require("../src/config");
const Share = require("../src/modules/shares/share.model");
const { createApp } = require("../src/app");
const { createLogger } = require("../src/infrastructure/logger");
const { connectRedis } = require("../src/infrastructure/redis");
const { redactPath } = require("../src/shared/requestLogging");

useTestDatabase();

const MAX_ATTEMPTS = config.lockout.maxFailedAttempts;
const PASSWORD = "correct-horse";

const openShare = (target, code, password) => request(target).post(`/api/shares/${code}/open`).send({ password });
const login = (target, email, password) => request(target).post("/api/auth/login").send({ email, password });
const register = (target, email) =>
    request(target).post("/api/auth/register").send({ name: "Test", email, password: PASSWORD }).expect(201);

// An app whose request logs are captured as parsed JSON lines.
const createLoggedApp = (options = {}) => {
    const lines = [];
    const stream = new Writable({
        write(chunk, encoding, callback) {
            lines.push(...chunk.toString().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
            callback();
        },
    });
    return { app: createApp({ rateLimit: false, logger: createLogger(stream, { level: "info" }), ...options }), lines };
};

describe("health check", () => {
    test("reports MongoDB up and Redis disabled", async () => {
        const res = await request(app).get("/healthz").expect(200);
        expect(res.body).toMatchObject({ status: "ok", mongo: "up", redis: "disabled" });
    });

    test("returns 503 while shutting down, so traffic drains", async () => {
        app.locals.shuttingDown = true;
        try {
            const res = await request(app).get("/healthz").expect(503);
            expect(res.body.status).toBe("shutting_down");
        } finally {
            delete app.locals.shuttingDown;
        }
    });
});

describe("request IDs", () => {
    test("every response carries an X-Request-Id", async () => {
        const res = await request(app).get("/").expect(200);
        expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    test("a sane incoming ID is reused; junk is replaced", async () => {
        const kept = await request(app).get("/").set("X-Request-Id", "proxy-id-12345").expect(200);
        expect(kept.headers["x-request-id"]).toBe("proxy-id-12345");
        const replaced = await request(app).get("/").set("X-Request-Id", "<script>").expect(200);
        expect(replaced.headers["x-request-id"]).not.toBe("<script>");
    });

    test("500 responses include the request ID but not the error details", async () => {
        const spy = jest.spyOn(Share, "findOne").mockRejectedValueOnce(new Error("database exploded"));
        try {
            const res = await openShare(app, "ABCD2345").expect(500);
            expect(res.body.requestId).toBe(res.headers["x-request-id"]);
            expect(JSON.stringify(res.body)).not.toContain("exploded");
        } finally {
            spy.mockRestore();
        }
    });
});

describe("logging", () => {
    test("redactPath hides codes and tokens and drops query strings", () => {
        expect(redactPath("/api/shares/ABCD2345/open")).toBe("/api/shares/:code/open");
        expect(redactPath("/api/files/abc.def?inline=1")).toBe("/api/files/:token");
        expect(redactPath("/api/me/shares/ABCD2345")).toBe("/api/me/shares/:code");
        expect(redactPath("/api/me/shares?status=expired")).toBe("/api/me/shares");
        expect(redactPath("/s/ABCD-2345")).toBe("/s/:code");
        expect(redactPath("/reset-password?token=secret")).toBe("/reset-password");
    });

    test("one structured line per request, events tied to it, and no secrets", async () => {
        const { app: logged, lines } = createLoggedApp();
        const agent = request.agent(logged);
        await agent.post("/api/auth/register").send({ name: "Log", email: "log@example.com", password: PASSWORD }).expect(201);
        const { code, manageToken, created } = await createShare(
            agent,
            { text: "top secret message", password: "share-pass" },
            [{ name: "private-name.txt", content: "x" }]
        );
        const uploadToken = created.body.uploads[0].url.split("/").pop();
        const opened = await openShare(logged, code, "share-pass").expect(200);
        const downloadToken = opened.body.files[0].downloadUrl.split("/").pop();
        await request(logged).get(`/api/files/${downloadToken}`).expect(200);
        await request(logged).get("/reset-password?token=reset-secret-123").expect(200);
        await request(logged).get("/assets/index-abc123.js").expect(200);
        await request(logged).get("/healthz").expect(200);

        const output = JSON.stringify(lines);
        const secrets = [code, manageToken, uploadToken, downloadToken, "top secret message", "share-pass", PASSWORD, "private-name.txt", "reset-secret-123", "sr_at", "sr_rt"];
        for (const secret of secrets) {
            expect(output).not.toContain(secret);
        }

        const requestLines = lines.filter((l) => l.req);
        expect(requestLines.map((l) => l.req.path)).toEqual([
            "/api/auth/register",
            "/api/shares",
            "/api/uploads/:token",
            "/api/shares/:code/complete",
            "/api/shares/:code/open",
            "/api/files/:token",
            "/reset-password",
        ]); // static assets and /healthz aren't logged

        const createLine = requestLines[1];
        expect(createLine).toMatchObject({ level: 30, res: { statusCode: 201 }, userId: expect.any(String) });
        expect(createLine.responseTime).toEqual(expect.any(Number));

        const events = lines.filter((l) => l.event).map((l) => l.event);
        expect(events).toEqual(["auth.registered", "share.created", "share.opened", "file.downloaded"]);
        // The share counts as created once its upload completes.
        const completeLine = requestLines[3];
        const createdEvent = lines.find((l) => l.event === "share.created");
        expect(createdEvent).toMatchObject({ reqId: completeLine.reqId, fileCount: 1, passwordProtected: true, owned: true });
    });

    test("unexpected errors are logged with their stack on the request line", async () => {
        const { app: logged, lines } = createLoggedApp();
        const spy = jest.spyOn(Share, "findOne").mockRejectedValueOnce(new Error("database exploded"));
        try {
            await openShare(logged, "ABCD2345").expect(500);
        } finally {
            spy.mockRestore();
        }
        const line = lines.find((l) => l.req);
        expect(line).toMatchObject({ level: 50, res: { statusCode: 500 } });
        expect(line.err.stack).toContain("database exploded");
    });
});

describe("brute-force lockouts", () => {
    test("a share locks after repeated wrong passwords, even for the right password", async () => {
        const { code } = await createShare(app, { text: "x", password: "right-pass" });
        const other = await createShare(app, { text: "y", password: "right-pass" });

        for (let i = 0; i < MAX_ATTEMPTS; i++) await openShare(app, code, "wrong-pass").expect(401);
        const locked = await openShare(app, code, "right-pass").expect(429);
        expect(locked.body.error).toMatch(/Too many wrong passwords/);
        expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
        expect((await Share.findOne({ code }).lean()).views).toBe(0);

        await openShare(app, other.code, "right-pass").expect(200); // other shares unaffected
    });

    test("the right password resets the count", async () => {
        const { code } = await createShare(app, { text: "x", password: "right-pass" });
        for (let i = 0; i < MAX_ATTEMPTS - 1; i++) await openShare(app, code, "wrong-pass").expect(401);
        await openShare(app, code, "right-pass").expect(200);
        for (let i = 0; i < MAX_ATTEMPTS - 1; i++) await openShare(app, code, "wrong-pass").expect(401);
        await openShare(app, code, "right-pass").expect(200);
    });

    test("the lock lifts when the window passes", async () => {
        const { code } = await createShare(app, { text: "x", password: "right-pass" });
        for (let i = 0; i < MAX_ATTEMPTS; i++) await openShare(app, code, "wrong-pass").expect(401);
        await openShare(app, code, "right-pass").expect(429);

        const later = Date.now() + (config.lockout.windowSeconds + 1) * 1000;
        const spy = jest.spyOn(Date, "now").mockReturnValue(later);
        try {
            await openShare(app, code, "right-pass").expect(200);
        } finally {
            spy.mockRestore();
        }
    });

    test("login locks per email, for real and unknown accounts alike", async () => {
        await register(app, "lock-me@example.com");
        await register(app, "bystander@example.com");

        for (let i = 0; i < MAX_ATTEMPTS; i++) await login(app, "lock-me@example.com", "wrong-pass").expect(401);
        const locked = await login(app, "LOCK-ME@example.com", PASSWORD).expect(429);
        expect(locked.body.error).toMatch(/Too many failed login attempts/);

        await login(app, "bystander@example.com", PASSWORD).expect(200);

        for (let i = 0; i < MAX_ATTEMPTS; i++) await login(app, "nobody@example.com", "wrong-pass").expect(401);
        await login(app, "nobody@example.com", "wrong-pass").expect(429);
    });
});

// Runs only with a Redis to talk to, e.g.:
//   docker run -d -p 6390:6379 redis:8-alpine
//   TEST_REDIS_URL=redis://localhost:6390 npm test
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
(TEST_REDIS_URL ? describe : describe.skip)("with Redis", () => {
    let redis;

    beforeAll(async () => {
        redis = await connectRedis(TEST_REDIS_URL);
    });
    beforeEach(() => redis.sendCommand(["FLUSHDB"]));
    afterAll(() => redis?.close());

    test("health check reports Redis up", async () => {
        const res = await request(createApp({ redis })).get("/healthz").expect(200);
        expect(res.body).toMatchObject({ status: "ok", redis: "up" });
    });

    test("rate limits are shared between instances (and so survive a restart)", async () => {
        const first = createApp({ redis });
        const second = createApp({ redis });
        // Login allows 20 requests per IP per window; invalid bodies still count.
        for (let i = 0; i < 10; i++) await request(first).post("/api/auth/login").send({}).expect(400);
        for (let i = 0; i < 10; i++) await request(second).post("/api/auth/login").send({}).expect(400);
        const limited = await request(first).post("/api/auth/login").send({}).expect(429);
        expect(limited.body.error).toMatch(/Too many login attempts/);
    });

    test("lockouts are shared between instances", async () => {
        const first = createApp({ redis, rateLimit: false });
        const second = createApp({ redis, rateLimit: false });
        const { code } = await createShare(first, { text: "x", password: "right-pass" });
        for (let i = 0; i < MAX_ATTEMPTS; i++) await openShare(i % 2 ? first : second, code, "wrong-pass").expect(401);
        await openShare(second, code, "right-pass").expect(429);
        // Keys are hashed: no share IDs in Redis.
        const keys = await redis.sendCommand(["KEYS", "lock:*"]);
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/^lock:share:[0-9a-f]{64}$/);
    });

    test("if Redis goes down, the site keeps working (limits fail open)", async () => {
        const dead = await connectRedis(TEST_REDIS_URL);
        const { app: degraded } = createLoggedApp({ redis: dead, rateLimit: true });
        await dead.close();

        const res = await request(degraded).get("/healthz").expect(200);
        expect(res.body).toMatchObject({ status: "degraded", redis: "down" });

        const { code } = await createShare(degraded, { text: "still works", password: "right-pass" });
        await openShare(degraded, code, "wrong-pass").expect(401);
        await openShare(degraded, code, "right-pass").expect(200);
    });
});
