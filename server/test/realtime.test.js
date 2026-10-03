const http = require("http");
const { app, createShare, useTestDatabase } = require("./helpers");
const request = require("supertest");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { io: connectClient } = require("socket.io-client");
const { initRealtime, closeRealtime, notifyShare } = require("../src/realtime");
const { connectRedis } = require("../src/lib/redis");

useTestDatabase();

let server;
let baseUrl;
const sockets = [];

beforeAll(async () => {
    server = http.createServer(app);
    await initRealtime(server);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
});

afterEach(() => {
    while (sockets.length) sockets.pop().disconnect();
});

afterAll(() => closeRealtime());

// Resolves with a connected socket, or rejects with the connection error.
const connect = (options = {}, url = baseUrl) =>
    new Promise((resolve, reject) => {
        const socket = connectClient(url, { transports: ["websocket"], reconnection: false, ...options });
        sockets.push(socket);
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", reject);
    });

const nextEvent = (socket, name, timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No "${name}" event within ${timeoutMs}ms`)), timeoutMs);
        socket.once(name, (payload) => {
            clearTimeout(timer);
            resolve(payload);
        });
    });

const noEvent = (socket, name, waitMs = 300) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, waitMs);
        socket.once(name, () => {
            clearTimeout(timer);
            reject(new Error(`Unexpected "${name}" event`));
        });
    });

const watch = (socket, code, manageToken) => socket.emitWithAck("share:watch", { code, manageToken });

const http_ = () => request(server);

describe("watching a share with its manage token (any sender, guests included)", () => {
    test("sees each open and download as it happens", async () => {
        const { code, manageToken } = await createShare(http_(), { maxViews: 5 }, [{ name: "notes.txt", content: "hi" }]);
        const socket = await connect();
        expect(await watch(socket, code, manageToken)).toEqual({ ok: true });

        const opened = nextEvent(socket, "share:opened");
        const res = await http_().post(`/api/shares/${code}/open`).expect(200);
        expect(await opened).toMatchObject({ code, views: 1, maxViews: 5, viewsRemaining: 4, at: expect.any(String) });

        const downloaded = nextEvent(socket, "file:downloaded");
        await http_().get(res.body.files[0].downloadUrl).expect(200);
        expect(await downloaded).toMatchObject({ code, fileName: "notes.txt", downloads: 1 });
    });

    test("a wrong manage token is refused and sees nothing", async () => {
        const { code } = await createShare(http_(), { text: "secret activity" });
        const socket = await connect();
        expect(await watch(socket, code, "wrong")).toEqual({ ok: false, error: "Share not found" });
        expect(await watch(socket, "NOPE", "x")).toEqual({ ok: false, error: "Share not found" });

        const quiet = noEvent(socket, "share:opened");
        await http_().post(`/api/shares/${code}/open`).expect(200);
        await quiet;
    });
});

describe("signed-in owners", () => {
    const signIn = async () => {
        const agent = request.agent(server);
        await agent.post("/api/auth/register").send({ name: "Owen", email: `owner-${Date.now()}@example.com`, password: "correct-horse" }).expect(201);
        const { body } = await agent.get("/api/auth/realtime-token").expect(200);
        return { agent, token: body.token };
    };

    test("get events for all their shares without watching each one", async () => {
        const { agent, token } = await signIn();
        const socket = await connect({ auth: { token } });

        const created = nextEvent(socket, "share:created");
        const { code } = await createShare(agent, { text: "hello" });
        expect(await created).toMatchObject({ code });

        const opened = nextEvent(socket, "share:opened");
        await http_().post(`/api/shares/${code}/open`).expect(200);
        expect(await opened).toMatchObject({ code, views: 1, maxViews: null });

        const ended = nextEvent(socket, "share:ended");
        await agent.delete(`/api/me/shares/${code}`).expect(204);
        expect(await ended).toMatchObject({ code, reason: "deleted" });
    });

    test("don't see other people's shares", async () => {
        const { token } = await signIn();
        const socket = await connect({ auth: { token } });
        const quiet = noEvent(socket, "share:opened");
        const { code } = await createShare(http_(), { text: "someone else's" });
        await http_().post(`/api/shares/${code}/open`).expect(200);
        await quiet;
    });

    test("the realtime token needs a session, and forged tokens are refused", async () => {
        await http_().get("/api/auth/realtime-token").expect(401);
        await expect(connect({ auth: { token: "forged.token.value" } })).rejects.toThrow("unauthorized");
    });
});

test("connections from other sites are refused", async () => {
    await expect(connect({ extraHeaders: { origin: "https://evil.example" } })).rejects.toThrow();
    // The page's own origin is fine.
    await connect({ extraHeaders: { origin: baseUrl } });
});

// Runs only with a Redis to talk to (see infrastructure.test.js).
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
(TEST_REDIS_URL ? test : test.skip)("with the Redis adapter, events reach sockets on other instances", async () => {
    const redis = await connectRedis(TEST_REDIS_URL);
    const pub = redis.duplicate();
    const sub = redis.duplicate();
    await Promise.all([pub.connect(), sub.connect()]);

    // A second instance: its own Socket.IO server, sharing the adapter.
    const otherHttp = http.createServer();
    const other = new Server(otherHttp);
    other.adapter(createAdapter(pub, sub));
    other.on("connection", (socket) => socket.join("user:watcher"));
    await new Promise((resolve) => otherHttp.listen(0, resolve));

    // This app's instance must use Redis too, so restart it with an adapter.
    await closeRealtime();
    server = http.createServer(app);
    await initRealtime(server, { redis });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    try {
        const socket = await connect({}, `http://localhost:${otherHttp.address().port}`);
        const received = nextEvent(socket, "share:opened");
        notifyShare({ _id: "abc", code: "CODE2345", ownerId: "watcher" }, "share:opened", { views: 1 });
        expect(await received).toMatchObject({ code: "CODE2345", views: 1 });
    } finally {
        await new Promise((resolve) => other.close(resolve));
        await redis.close();
    }
});
