// Shared test setup. Require this before any src/ module: config reads these
// environment variables when it is first loaded.
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "sendretrieve-test-"));
process.env.TOKEN_SECRET = "test-secret";
// Quick retries, so tests of failing jobs don't wait 36 seconds.
process.env.QUEUE_RETRY_DELAYS_MS = process.env.QUEUE_RETRY_DELAYS_MS || "10,20,30";
// Small parts (64 KB), so tests exercise multipart uploads with small files.
process.env.UPLOAD_PART_SIZE_MB = process.env.UPLOAD_PART_SIZE_MB || String(64 / 1024);

// A stand-in for the React build (client/dist), so the server tests don't
// depend on the frontend having been built.
const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendretrieve-client-"));
fs.mkdirSync(path.join(clientDir, "assets"));
fs.writeFileSync(path.join(clientDir, "index.html"), '<!doctype html><title>sendRetrieve</title><div id="root"></div>');
fs.writeFileSync(path.join(clientDir, "assets", "index-abc123.js"), "console.log('app');");
fs.writeFileSync(path.join(clientDir, "favicon.svg"), "<svg></svg>");
process.env.CLIENT_DIR = clientDir;

const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { createApp } = require("../src/app");
const { startWorkers } = require("../src/workers");
const { getBus } = require("../src/infrastructure/queue");

const uploadDir = process.env.UPLOAD_DIR;

// Background jobs (file cleanup, emails...) run in this process on the
// in-memory queue. settle() waits until every queued job has finished.
const settle = () => getBus().whenIdle();
const app = createApp({ rateLimit: false });

// Every stored file, as storage keys ("shares/<shareId>/<fileId>").
const storedFiles = () =>
    fs
        .readdirSync(uploadDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(uploadDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));

// A real 1x1 PNG, for tests that need content detected as an image.
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);

const TYPES = { png: "image/png", jpg: "image/jpeg", txt: "text/plain", pdf: "application/pdf", html: "text/html", svg: "image/svg+xml", json: "application/json" };
const typeFor = (name) => TYPES[name.split(".").pop()] ?? "";

// Uploads a file to the URL the API handed out: our own /api/uploads (disk
// storage) or a signed object-storage URL (S3/MinIO).
const uploadTo = async (client, target, content) => {
    if (/^https?:/.test(target.url)) {
        const res = await fetch(target.url, { method: target.method, headers: target.headers, body: content });
        return res.status;
    }
    // Raw bytes, as a browser sends them (supertest would JSON-encode a Buffer
    // sent with a JSON content type).
    return (await client.put(target.url).set(target.headers).serialize((body) => body).send(content)).status;
};

// Uploads parts of a big file the way the browser does: asks for signed part
// URLs (in batches), then PUTs each slice. `partNumbers` defaults to all.
const uploadInParts = async (client, { code, manageToken }, target, content, partNumbers = null) => {
    const { partSize, partCount } = target.multipart;
    const wanted = partNumbers ?? Array.from({ length: partCount }, (_, i) => i + 1);
    for (let i = 0; i < wanted.length; i += 50) {
        const res = await client
            .post(`/api/shares/${code}/uploads/${target.fileId}/parts`)
            .send({ manageToken, partNumbers: wanted.slice(i, i + 50) });
        if (res.status !== 200) throw new Error(`Part URLs failed with ${res.status}: ${JSON.stringify(res.body)}`);
        for (const part of res.body.parts) {
            const start = (part.partNumber - 1) * partSize;
            const status = await uploadTo(client, part, content.subarray(start, start + partSize));
            if (status !== 200) throw new Error(`Part ${part.partNumber} failed with ${status}`);
        }
    }
};

// Creates a share the way the browser does: announce it with file details,
// upload each file to its upload URL (big files in parts), then complete it.
//   target   an Express app or a supertest agent (to send its cookies)
//   files    [{ name, content (string or Buffer), type? }]
//   options  { upload: false } stops after creating; { complete: false } after uploading
// Returns { res, body, code, manageToken, created }: res/body are the last
// response (complete's, or create's for text-only shares and early stops).
const createShare = async (target, fields = {}, files = [], { upload = true, complete = true } = {}) => {
    const client = typeof target === "function" ? request(target) : target;
    const contents = files.map((f) => (Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content)));

    const created = await client.post("/api/shares").send({
        ...fields,
        files: files.map((f, i) => ({ name: f.name, size: contents[i].length, type: f.type ?? typeFor(f.name) })),
    });
    const result = (res) => ({ res, body: res.body, code: created.body.code, manageToken: created.body.manageToken, created });
    if (created.status !== 201 || files.length === 0 || !upload) return result(created);

    for (const [i, uploadTarget] of created.body.uploads.entries()) {
        if (uploadTarget.multipart) {
            await uploadInParts(client, created.body, uploadTarget, contents[i]);
            continue;
        }
        const status = await uploadTo(client, uploadTarget, contents[i]);
        if (status !== 200) throw new Error(`Upload of ${files[i].name} failed with ${status}`);
    }
    if (!complete) return result(created);

    return result(await client.post(`/api/shares/${created.body.code}/complete`).send({ manageToken: created.body.manageToken }));
};

// Registers beforeAll/afterEach/afterAll hooks for an isolated database.
const useTestDatabase = () => {
    let mongo;

    beforeAll(async () => {
        mongo = await MongoMemoryServer.create();
        await mongoose.connect(mongo.getUri());
        await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
        // Workers without the scheduler: tests run the sweeps themselves.
        await startWorkers({ scheduler: false });
    });

    afterEach(async () => {
        await settle();
        await Promise.all(Object.values(mongoose.models).map((m) => m.deleteMany({})));
        for (const entry of fs.readdirSync(uploadDir)) fs.rmSync(path.join(uploadDir, entry), { recursive: true, force: true });
    });

    afterAll(async () => {
        await mongoose.disconnect();
        await mongo.stop();
        fs.rmSync(uploadDir, { recursive: true, force: true });
    });
};

module.exports = { app, uploadDir, storedFiles, createShare, uploadTo, uploadInParts, typeFor, PNG, settle, useTestDatabase };
