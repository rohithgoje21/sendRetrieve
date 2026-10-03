const net = require("net");
const config = require("../config");
const { logger } = require("./logger");
const { CircuitBreaker } = require("../shared/circuitBreaker");

// Client for clamd, ClamAV's scanning daemon, over its TCP protocol:
//
//   INSTREAM   send "zINSTREAM\0", then the file as chunks, each prefixed
//              with its length (4-byte big-endian), then a zero-length chunk.
//              clamd answers "stream: OK", "stream: <signature> FOUND" or an
//              error (e.g. "INSTREAM size limit exceeded").
//   PING       "zPING\0" -> "PONG"
//
// Calls go through a circuit breaker: while clamd is down, scans fail fast
// and the jobs are retried by the queue.

const log = logger.child({ component: "scanner" });

const breaker = new CircuitBreaker("virus-scanner", {
    callTimeoutMs: config.scanner.timeoutMs,
    onStateChange: (state, previous) =>
        log[state === "open" ? "error" : "info"]({ event: "scanner.circuit", state, previous }, `Scanner circuit ${state}`),
});

const MAX_CHUNK = 64 * 1024;

const connect = () =>
    new Promise((resolve, reject) => {
        const socket = net.connect({ host: config.scanner.host, port: config.scanner.port });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
    });

// Collects clamd's reply (terminated by \0 or the connection closing).
const readReply = (socket) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8").replace(/\0/g, "").trim()));
        socket.once("error", reject);
    });

const writeChunk = (socket, chunk) =>
    new Promise((resolve, reject) => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length);
        socket.write(Buffer.concat([header, chunk]), (err) => (err ? reject(err) : resolve()));
    });

// Interprets clamd's answer to a scan.
const parseScanReply = (reply) => {
    if (/: OK$/.test(reply)) return { infected: false };
    const found = reply.match(/: (.+) FOUND$/);
    if (found) return { infected: true, signature: found[1] };
    throw new Error(`Scanner error: ${reply || "no reply"}`);
};

// Scans a readable stream. Resolves { infected, signature? }; rejects if the
// file couldn't be scanned (scanner down, file too big...), which must never
// be treated as clean.
const scanStream = (stream) =>
    breaker.exec(async () => {
        const socket = await connect();
        try {
            const reply = readReply(socket);
            socket.write("zINSTREAM\0");
            for await (const data of stream) {
                for (let offset = 0; offset < data.length; offset += MAX_CHUNK) {
                    await writeChunk(socket, data.subarray(offset, offset + MAX_CHUNK));
                }
            }
            await writeChunk(socket, Buffer.alloc(0));
            return parseScanReply(await reply);
        } finally {
            socket.destroy();
            stream.destroy?.();
        }
    });

const ping = async () => {
    const socket = await connect();
    try {
        const reply = readReply(socket);
        socket.write("zPING\0");
        return (await reply) === "PONG";
    } finally {
        socket.destroy();
    }
};

const enabled = () => Boolean(config.scanner.host);

const health = async () => {
    if (!enabled()) return "disabled";
    try {
        let timer;
        const result = await Promise.race([
            ping(),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), 2000);
            }),
        ]);
        clearTimeout(timer);
        return result ? "up" : "down";
    } catch {
        return "down";
    }
};

module.exports = { scanStream, ping, health, enabled, parseScanReply, scannerBreaker: breaker };
