// The upload/download flow against real S3-compatible storage. Runs only
// when one is available, e.g. the MinIO from docker compose:
//
//   docker compose up -d minio
//   TEST_S3_ENDPOINT=http://localhost:9000 npm test -w server
//
// (TEST_S3_ACCESS_KEY_ID / TEST_S3_SECRET_ACCESS_KEY default to the compose
// file's MinIO credentials.)

const TEST_S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;
if (TEST_S3_ENDPOINT) {
    Object.assign(process.env, {
        STORAGE_DRIVER: "s3",
        S3_ENDPOINT: TEST_S3_ENDPOINT,
        S3_BUCKET: "sendretrieve-test",
        S3_CREATE_BUCKET: "true",
        S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID || "sendretrieve",
        S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY || "sendretrieve-dev-secret",
    });
}

const { app, createShare, PNG, settle, useTestDatabase } = require("./helpers");
const request = require("supertest");
const Share = require("../src/modules/shares/share.model");
const { storage } = require("../src/infrastructure/storage");
const { deleteExpiredShares, deleteOrphanFiles } = require("../src/workers/scheduler");

const bucketKeys = async () => {
    const keys = [];
    for await (const { key } of storage.list()) keys.push(key);
    return keys.sort();
};

(TEST_S3_ENDPOINT ? describe : describe.skip)("S3 storage (MinIO)", () => {
    useTestDatabase();

    beforeAll(() => storage.init());
    beforeEach(async () => storage.delete(await bucketKeys()));

    const openShare = (code, body = {}) => request(app).post(`/api/shares/${code}/open`).send(body);

    test("browsers get signed upload URLs pointing at storage", async () => {
        const { created } = await createShare(app, {}, [{ name: "a.txt", content: "hello" }], { upload: false });
        const [target] = created.body.uploads;
        const url = new URL(target.url);
        expect(url.origin).toBe(new URL(TEST_S3_ENDPOINT).origin);
        expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
        expect(target).toMatchObject({ method: "PUT", headers: { "Content-Type": "text/plain" } });
    });

    test("storage itself refuses a different size or type than was signed", async () => {
        const { created } = await createShare(app, {}, [{ name: "a.txt", content: "hello" }], { upload: false });
        const [target] = created.body.uploads;
        const put = (body, type) => fetch(target.url, { method: "PUT", body, headers: { "Content-Type": type } });
        expect((await put("hello!", "text/plain")).status).toBe(403);
        expect((await put("hello", "text/html")).status).toBe(403);
        expect((await put("hello", "text/plain")).status).toBe(200);
    });

    test("full flow: upload straight to storage, complete, open, download via redirect", async () => {
        const { res, code } = await createShare(app, { text: "files inside" }, [
            { name: "report.txt", content: "quarterly numbers" },
            { name: "photo.png", content: PNG },
        ]);
        expect(res.status).toBe(200);
        await settle();
        // the two files, and the image's thumbnail (made by the processing worker)
        expect(await bucketKeys()).toHaveLength(3);

        const opened = await openShare(code).expect(200);
        const [text, image] = opened.body.files;
        expect(image).toMatchObject({ mimeType: "image/png", previewUrl: expect.any(String) });

        // Downloads redirect to a short-lived signed URL; storage serves the
        // file with the name and type we chose.
        const download = await request(app).get(text.downloadUrl).expect(302);
        expect(download.headers["cache-control"]).toBe("no-store");
        const file = await fetch(download.headers.location);
        expect(file.status).toBe(200);
        expect(await file.text()).toBe("quarterly numbers");
        expect(file.headers.get("content-type")).toBe("application/octet-stream");
        expect(file.headers.get("content-disposition")).toBe('attachment; filename="report.txt"');

        const preview = await request(app).get(image.previewUrl).expect(302);
        const shown = await fetch(preview.headers.location);
        expect(shown.headers.get("content-type")).toBe("image/png");
        expect(shown.headers.get("content-disposition")).toMatch(/^inline/);
        expect(Buffer.from(await shown.arrayBuffer()).equals(PNG)).toBe(true);
    });

    test("workers read and write objects: thumbnails are served via a signed URL", async () => {
        await storage.put("probe/hello.txt", Buffer.from("hi there"), "text/plain");
        const chunks = [];
        for await (const chunk of await storage.openStream("probe/hello.txt")) chunks.push(chunk);
        expect(Buffer.concat(chunks).toString()).toBe("hi there");

        const { code } = await createShare(app, {}, [{ name: "photo.png", content: PNG }]);
        await settle();
        const [image] = (await openShare(code).expect(200)).body.files;
        const thumb = await request(app).get(image.thumbnailUrl).expect(302);
        const shown = await fetch(thumb.headers.location);
        expect(shown.status).toBe(200);
        expect(shown.headers.get("content-type")).toBe("image/webp");
    });

        test("complete reads the start of each object to detect executables, then deletes them", async () => {
        const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100)]);
        const { res } = await createShare(app, {}, [{ name: "setup.pdf", content: exe, type: "application/pdf" }]);
        expect(res.status).toBe(422);
        await settle();
        expect(await bucketKeys()).toEqual([]);
    });

    test("cancel, expiry and the orphan sweep delete objects from the bucket", async () => {
        const cancelled = await createShare(app, {}, [{ name: "a.txt", content: "a" }], { complete: false });
        await request(app).post(`/api/shares/${cancelled.code}/cancel`).send({ manageToken: cancelled.manageToken }).expect(204);

        const expired = await createShare(app, {}, [{ name: "b.txt", content: "b" }]);
        await Share.updateOne({ code: expired.code }, { expiresAt: new Date(Date.now() - 1000) });
        await deleteExpiredShares();
        await settle();
        expect(await bucketKeys()).toEqual([]);

        // An object nothing references (e.g. uploaded after its share was discarded)
        await createShare(app, {}, [{ name: "c.txt", content: "c" }], { complete: false });
        await Share.deleteMany({});
        expect(await deleteOrphanFiles()).toBe(0); // too recent to be sure
        expect(await deleteOrphanFiles({ minAgeMs: 0 })).toBe(1);
        expect(await bucketKeys()).toEqual([]);
    });

    test("the page's CSP allows loading media from storage, and health checks it", async () => {
        const res = await request(app).get("/").expect(200);
        const origin = new URL(TEST_S3_ENDPOINT).origin;
        expect(res.headers["content-security-policy"]).toContain(`img-src 'self' data: ${origin}`);
        expect(res.headers["content-security-policy"]).toContain(`connect-src 'self' ${origin}`);
        // Plain-HTTP storage (local MinIO): browsers must not be told to upgrade
        // requests to HTTPS, or redirects to it would break.
        if (origin.startsWith("http:")) {
            expect(res.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
        }
        expect((await request(app).get("/healthz").expect(200)).body.storage).toBe("up");
    });
});
