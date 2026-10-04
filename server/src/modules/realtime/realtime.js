const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { Emitter } = require("@socket.io/redis-emitter");
const config = require("../../config");
const Share = require("../shares/share.model");
const { normalizeCode } = require("../shares/codes");
const { verifyRealtimeToken } = require("./realtimeTokens");
const { manageTokenMatches } = require("../shares/manageToken");
const { logger } = require("../../infrastructure/logger");

// Live updates over Socket.IO: tells a share's owner (and whoever holds its
// manage token, such as a guest sender's browser) when the share is opened,
// a file is downloaded, or the share ends.
//
// Rooms:
//   user:<id>    every socket of a signed-in user (sees all their shares)
//   share:<id>   sockets watching one share (proved with its manage token)
//
// With Redis, events are relayed between server instances (Redis adapter),
// so a download handled by one instance reaches a browser connected to another.
// Processes without a Socket.IO server (the worker) send events the same way,
// through a Redis emitter.

const log = logger.child({ component: "realtime" });
let io = null;
let emitter = null;
let adapterClients = [];

// Same rule as the API's same-origin check: the page's own origin, APP_URL,
// or CORS_ORIGINS. WebSockets aren't covered by CORS, so this is checked for
// every connection, not just polling requests.
const allowedOrigin = (origin, host) => {
    if (!origin) return true; // not a browser; a token is still needed for user rooms
    try {
        const { host: originHost, origin: normalized } = new URL(origin);
        return (
            originHost === host ||
            (config.appUrl && normalized === new URL(config.appUrl).origin) ||
            config.corsOrigins.includes(normalized)
        );
    } catch {
        return false;
    }
};

const initRealtime = async (httpServer, { redis = null } = {}) => {
    io = new Server(httpServer, {
        serveClient: false,
        cors: { origin: [config.appUrl, ...config.corsOrigins].filter(Boolean), methods: ["GET", "POST"] },
        allowRequest: (req, callback) => callback(null, allowedOrigin(req.headers.origin, req.headers.host)),
    });

    if (redis) {
        const pub = redis.duplicate();
        const sub = redis.duplicate();
        for (const client of [pub, sub]) client.on("error", (err) => log.error({ err }, "Realtime Redis error"));
        await Promise.all([pub.connect(), sub.connect()]);
        adapterClients = [pub, sub];
        io.adapter(createAdapter(pub, sub));
    }

    // Signed-in browsers send a short-lived token from /api/auth/realtime-token.
    // Without one, a socket can still watch shares it has the manage token for.
    io.use((socket, next) => {
        const token = socket.handshake.auth?.token;
        if (!token) return next();
        const userId = verifyRealtimeToken(token);
        if (!userId) return next(new Error("unauthorized"));
        socket.data.userId = userId;
        next();
    });

    io.on("connection", (socket) => {
        if (socket.data.userId) socket.join(`user:${socket.data.userId}`);

        socket.on("share:watch", async (payload, ack) => {
            const respond = typeof ack === "function" ? ack : () => {};
            try {
                const code = normalizeCode(payload?.code);
                const share = code && (await Share.findOne({ code }, { manageTokenHash: 1 }));
                if (!share || !manageTokenMatches(share, payload?.manageToken)) {
                    return respond({ ok: false, error: "Share not found" });
                }
                socket.join(`share:${share._id}`);
                // Its state now (read after joining, so no event falls in
                // between): e.g. a scan may have finished before the watch.
                const current = await Share.findById(share._id, { uploadPending: 1, processing: 1, endedAt: 1, endedReason: 1 }).lean();
                let status = "ready";
                if (!current || current.endedAt) status = "ended";
                else if (current.uploadPending) status = "uploading";
                else if (current.processing) status = "processing";
                respond({ ok: true, share: { status, endedReason: current?.endedReason ?? null } });
            } catch (err) {
                log.error({ err }, "share:watch failed");
                respond({ ok: false, error: "Something went wrong" });
            }
        });
    });

    log.info({ event: "realtime.ready", redisAdapter: Boolean(redis) }, "Real-time updates ready");
    return io;
};

// Sends `event` to every browser the user is signed in on (e.g. a new
// in-app notification). Does nothing when real-time isn't running.
const notifyUser = (userId, event, payload = {}) => {
    const target = io ?? emitter;
    if (!target) return;
    target.to(`user:${userId}`).emit(event, { ...payload, at: new Date().toISOString() });
};

// For the worker process: its events go through Redis to the API instances,
// which deliver them to the browsers connected there.
const initRealtimeEmitter = (redis) => {
    emitter = new Emitter(redis);
};

// Sends `event` about `share` to its owner and anyone watching it. Safe to
// call when real-time isn't running (tests, scripts): it does nothing.
const notifyShare = (share, event, payload = {}) => {
    const target = io ?? emitter;
    if (!target) return;
    const rooms = [`share:${share._id}`];
    if (share.ownerId) rooms.push(`user:${share.ownerId}`);
    target.to(rooms).emit(event, { code: share.code, ...payload, at: new Date().toISOString() });
};

// Disconnects every socket and closes the HTTP server Socket.IO is attached
// to; resolves once in-flight requests have finished.
const closeRealtime = async () => {
    emitter = null;
    if (!io) return;
    const server = io;
    io = null;
    await new Promise((resolve, reject) => {
        server.close((err) => (err && err.code !== "ERR_SERVER_NOT_RUNNING" ? reject(err) : resolve()));
    });
    const clients = adapterClients;
    adapterClients = [];
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
};

module.exports = { initRealtime, initRealtimeEmitter, notifyShare, notifyUser, closeRealtime };
