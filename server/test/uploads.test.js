const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { app, uploadDir, storedFiles, uploadTo, uploadInParts, settle, useTestDatabase } = require("./helpers");
const Share = require("../src/modules/shares/share.model");
const config = require("../src/config");
const { storage } = require("../src/infrastructure/storage");
const { deleteExpiredShares, deleteOrphanFiles } = require("../src/workers/scheduler");

useTestDatabase();

// 64 KB in tests (see helpers.js); 8 MB by default.
const PART = config.uploads.partSize;
const HOUR = 60 * 60 * 1000;

// Random bytes, so a part landing in the wrong place would show.
const blob = (size) => {
    const bytes = crypto.randomBytes(size);
    bytes.write("DATA", 0);
    return bytes;
};
const BIG = PART * 3 + 1000; // 4 parts, the last one 1000 bytes

const multipartDir = path.join(uploadDir, ".multipart");
const uploadsInProgress = () => (fs.existsSync(multipartDir) ? fs.readdirSync(multipartDir) : []);

const binary = (res, done) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => done(null, Buffer.concat(chunks)));
};

// Announces a share; returns the API's answer (code, manageToken, uploads...).
const announce = async (files, client = request(app)) => {
    const res = await client.post("/api/shares").send({
        files: files.map((f) => ({ name: f.name, size: f.content.length, type: f.type ?? "application/octet-stream" })),
    });
    expect(res.status).toBe(201);
    return res.body;
};
const complete = (created) => request(app).post(`/api/shares/${created.code}/complete`).send({ manageToken: created.manageToken });
const resume = (created) => request(app).post(`/api/shares/${created.code}/resume`).send({ manageToken: created.manageToken });
const partUrls = (created, fileId, partNumbers, manageToken = created.manageToken) =>
    request(app).post(`/api/shares/${created.code}/uploads/${fileId}/parts`).send({ manageToken, partNumbers });

const download = async (code, index = 0) => {
    const opened = await request(app).post(`/api/shares/${code}/open`).send({}).expect(200);
    return (await request(app).get(opened.body.files[index].downloadUrl).buffer(true).parse(binary).expect(200)).body;
};

const storedUpload = async (code, index = 0) => (await Share.findOne({ code })).files[index];

describe("big files are uploaded in parts", () => {
    test("files over the part size get a part layout instead of a single URL", async () => {
        const created = await announce([
            { name: "small.txt", content: Buffer.from("hi"), type: "text/plain" },
            { name: "big.bin", content: blob(BIG) },
        ]);
        const [small, big] = created.uploads;
        expect(small).toMatchObject({ multipart: null, method: "PUT", url: expect.any(String) });
        expect(big).toEqual({ fileId: expect.any(String), multipart: { partSize: PART, partCount: 4 } });
        expect(uploadsInProgress()).toHaveLength(1);
    });

    test("parts can arrive in any order; complete joins them into the original file", async () => {
        const content = blob(BIG);
        const created = await announce([{ name: "big.bin", content }]);
        await uploadInParts(request(app), created, created.uploads[0], content, [3, 1, 4, 2]);

        expect((await complete(created)).status).toBe(200);
        expect((await download(created.code)).equals(content)).toBe(true);
        expect(uploadsInProgress()).toEqual([]);
        expect((await storedUpload(created.code)).upload).toBeNull();
    });

    test("each part URL accepts exactly that part's size", async () => {
        const created = await announce([{ name: "big.bin", content: blob(BIG) }]);
        const { body } = await partUrls(created, created.uploads[0].fileId, [1, 4]).expect(200);
        const [first, last] = body.parts;
        expect(await uploadTo(request(app), first, blob(PART - 1))).toBe(400);
        expect(await uploadTo(request(app), last, blob(1001))).toBe(413);
        expect(await uploadTo(request(app), last, blob(1000))).toBe(200);
    });

    test("complete says which parts are still missing", async () => {
        const content = blob(BIG);
        const created = await announce([{ name: "big.bin", content }]);
        const target = created.uploads[0];
        await uploadInParts(request(app), created, target, content, [1, 2]);

        const early = await complete(created);
        expect(early.status).toBe(409);
        expect(early.body).toMatchObject({ error: '"big.bin" hasn\'t finished uploading.', fileId: target.fileId, missingParts: [3, 4] });

        await uploadInParts(request(app), created, target, content, [3, 4]);
        expect((await complete(created)).status).toBe(200);
        expect((await download(created.code)).equals(content)).toBe(true);
    });

    test("part URLs are only handed out for real parts of a multipart file, with the manage token", async () => {
        const created = await announce([
            { name: "small.txt", content: Buffer.from("hi"), type: "text/plain" },
            { name: "big.bin", content: blob(BIG) },
        ]);
        const [small, big] = created.uploads;
        await partUrls(created, big.fileId, [1], "wrong-token").expect(404);
        expect((await partUrls(created, big.fileId, [5]).expect(400)).body.error).toBe("This file has 4 parts.");
        await partUrls(created, big.fileId, Array.from({ length: 51 }, (_, i) => i + 1)).expect(400);
        await partUrls(created, big.fileId, []).expect(400);
        await partUrls(created, small.fileId, [1]).expect(404);
        await partUrls(created, "not-an-id", [1]).expect(404);
        // Duplicates are dropped, and parts come back in order.
        const { body } = await partUrls(created, big.fileId, [2, 2, 1]).expect(200);
        expect(body.parts.map((p) => p.partNumber)).toEqual([1, 2]);
        expect(body.parts[0]).toMatchObject({ method: "PUT", url: expect.stringMatching(/^\/api\/uploads\//) });
    });
});

describe("resuming an interrupted upload", () => {
    test("resume reports what's stored and hands out fresh URLs for the rest", async () => {
        const small = Buffer.from("small file");
        const big = blob(BIG);
        const created = await announce([
            { name: "small.txt", content: small, type: "text/plain" },
            { name: "big.bin", content: big },
        ]);
        await uploadInParts(request(app), created, created.uploads[1], big, [1, 3]);

        // ...the tab was closed. Later:
        const first = (await resume(created).expect(200)).body;
        expect(first).toMatchObject({ code: created.code, status: "uploading", uploadExpiresAt: expect.any(String) });
        const [smallState, bigState] = first.files;
        expect(smallState).toMatchObject({ name: "small.txt", size: small.length, uploaded: false, multipart: null, method: "PUT" });
        expect(bigState).toMatchObject({
            name: "big.bin",
            size: BIG,
            uploaded: false,
            multipart: { partSize: PART, partCount: 4, uploadedParts: [1, 3] },
        });

        expect(await uploadTo(request(app), smallState, small)).toBe(200);
        await uploadInParts(request(app), created, bigState, big, [2, 4]);

        const second = (await resume(created).expect(200)).body;
        expect(second.files.map((f) => f.uploaded)).toEqual([true, true]);
        expect(second.files[1].multipart.uploadedParts).toEqual([1, 2, 3, 4]);

        expect((await complete(created)).status).toBe(200);
        expect((await download(created.code, 1)).equals(big)).toBe(true);
    });

    test("upload activity pushes the deadline out, up to 24 hours after the share was created", async () => {
        const created = await announce([{ name: "big.bin", content: blob(BIG) }]);
        const soon = new Date(Date.now() + 5 * 60 * 1000);
        await Share.updateOne({ code: created.code }, { expiresAt: soon });

        const extended = new Date((await resume(created).expect(200)).body.uploadExpiresAt);
        expect(Math.abs(extended - (Date.now() + HOUR))).toBeLessThan(5000);

        // Started almost a day ago: the deadline can't pass the 24-hour mark.
        const createdAt = new Date(Date.now() - 23.5 * HOUR);
        await Share.collection.updateOne({ code: created.code }, { $set: { createdAt, expiresAt: soon } });
        const { body } = await partUrls(created, created.uploads[0].fileId, [1]).expect(200);
        expect(new Date(body.uploadExpiresAt).getTime()).toBe(createdAt.getTime() + 24 * HOUR);
        expect((await Share.findOne({ code: created.code })).expiresAt.getTime()).toBe(createdAt.getTime() + 24 * HOUR);
    });

    test("if the storage upload was lost, that file starts over", async () => {
        const content = blob(BIG);
        const created = await announce([{ name: "big.bin", content }]);
        await uploadInParts(request(app), created, created.uploads[0], content, [1, 2]);
        const lost = await storedUpload(created.code);
        await storage.abortMultipartUpload({ key: lost.storedName, uploadId: lost.upload.uploadId });

        const [state] = (await resume(created).expect(200)).body.files;
        expect(state.multipart.uploadedParts).toEqual([]);
        expect((await storedUpload(created.code)).upload.uploadId).not.toBe(lost.upload.uploadId);

        await uploadInParts(request(app), created, state, content);
        expect((await complete(created)).status).toBe(200);
        expect((await download(created.code)).equals(content)).toBe(true);
    });

    test("a retried complete still succeeds when the parts were already joined", async () => {
        const content = blob(BIG);
        const created = await announce([{ name: "big.bin", content }]);
        await uploadInParts(request(app), created, created.uploads[0], content);
        // An earlier /complete joined the parts, then the connection dropped.
        const file = await storedUpload(created.code);
        const parts = await storage.listUploadedParts({ key: file.storedName, uploadId: file.upload.uploadId });
        await storage.completeMultipartUpload({ key: file.storedName, uploadId: file.upload.uploadId, parts });

        expect((await complete(created)).status).toBe(200);
        expect((await download(created.code)).equals(content)).toBe(true);
    });
});

describe("abandoned uploads are cleaned up", () => {
    test("cancelling aborts the upload and deletes its parts", async () => {
        const content = blob(BIG);
        const created = await announce([{ name: "big.bin", content }]);
        await uploadInParts(request(app), created, created.uploads[0], content, [1]);
        await request(app).post(`/api/shares/${created.code}/cancel`).send({ manageToken: created.manageToken }).expect(204);
        await settle();
        expect(uploadsInProgress()).toEqual([]);
        expect(storedFiles()).toEqual([]);
    });

    test("an upload that runs out of time is aborted by the sweep", async () => {
        const content = blob(BIG);
        const created = await announce([{ name: "big.bin", content }]);
        await uploadInParts(request(app), created, created.uploads[0], content, [1, 2]);
        await Share.updateOne({ code: created.code }, { expiresAt: new Date(Date.now() - 1000) });
        await deleteExpiredShares();
        await settle();
        expect(uploadsInProgress()).toEqual([]);
        expect(await Share.countDocuments()).toBe(0);
    });

    test("a big executable is refused once uploaded, and nothing of it is kept", async () => {
        const exe = blob(BIG);
        exe.write("MZ", 0);
        const created = await announce([{ name: "tool.dat", content: exe }]);
        await uploadInParts(request(app), created, created.uploads[0], exe);
        expect((await complete(created)).status).toBe(422);
        await settle();
        expect(uploadsInProgress()).toEqual([]);
        expect(storedFiles()).toEqual([]);
    });

    test("deleting an account aborts its uploads in progress", async () => {
        const agent = request.agent(app);
        await agent.post("/api/auth/register").send({ name: "Ada", email: "ada@example.com", password: "correct-horse" }).expect(201);
        const content = blob(BIG);
        const created = await announce([{ name: "big.bin", content }], agent);
        await uploadInParts(agent, created, created.uploads[0], content, [1]);

        await agent.delete("/api/me").send({ password: "correct-horse" }).expect(204);
        await settle();
        expect(uploadsInProgress()).toEqual([]);
    });

    test("the orphan sweep leaves uploads in progress alone; parts untouched for over a day are removed", async () => {
        const content = blob(BIG);
        const created = await announce([{ name: "big.bin", content }]);
        await uploadInParts(request(app), created, created.uploads[0], content, [1]);

        expect(await deleteOrphanFiles({ minAgeMs: 0 })).toBe(0);
        expect(await storage.abortStaleUploads(25 * HOUR)).toBe(0);
        expect(uploadsInProgress()).toHaveLength(1);

        const [id] = uploadsInProgress();
        const old = new Date(Date.now() - 26 * HOUR);
        fs.utimesSync(path.join(multipartDir, id), old, old);
        expect(await storage.abortStaleUploads(25 * HOUR)).toBe(1);
        expect(uploadsInProgress()).toEqual([]);
    });
});
