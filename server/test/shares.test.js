const fs = require("fs");
const path = require("path");
const { app, uploadDir, storedFiles, createShare, PNG, useTestDatabase } = require("./helpers");
const request = require("supertest");
const Share = require("../src/modules/shares/share.model");
const { deleteExpiredShares, deleteOrphanFiles } = require("../src/workers/cleanup");

useTestDatabase();

const openShare = (code, body = {}) => request(app).post(`/api/shares/${code}/open`).send(body);
const share = (fields, files, options) => createShare(app, fields, files, options);

describe("creating shares", () => {
    test("text share returns an 8-character code and link, ready at once", async () => {
        const { res } = await share({ text: "hello" });
        expect(res.status).toBe(201);
        expect(res.body.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
        expect(res.body.url).toMatch(new RegExp(`/s/${res.body.code}$`));
        expect(res.body).toMatchObject({ status: "ready", uploads: [] });
        await openShare(res.body.code).expect(200);
    });

    test("rejects an empty share", async () => {
        const { res } = await share({ text: "   " });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/text or at least one file/);
    });

    test("rejects unknown expiry and view-limit values", async () => {
        expect((await share({ text: "x", expiresIn: "100y" })).res.status).toBe(400);
        expect((await share({ text: "x", maxViews: 3 })).res.status).toBe(400);
    });

    test("rejects too many or too large files before anything is uploaded", async () => {
        const many = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, content: "x" }));
        const tooMany = await share({}, many);
        expect(tooMany.res.status).toBe(400);
        expect(tooMany.body.error).toMatch(/up to 10 files/);

        const tooLarge = await request(app)
            .post("/api/shares")
            .send({ files: [{ name: "big.bin", size: 51 * 1024 * 1024 }] })
            .expect(400);
        expect(tooLarge.body).toMatchObject({ field: "files.0.size", error: expect.stringMatching(/50 MB/) });
        expect(await Share.countDocuments()).toBe(0);
    });

    test("applies the chosen expiry", async () => {
        const { body } = await share({ text: "x", expiresIn: "1h" });
        const ms = new Date(body.expiresAt) - Date.now();
        expect(ms).toBeGreaterThan(59 * 60 * 1000);
        expect(ms).toBeLessThanOrEqual(60 * 60 * 1000);
    });

    test("never stores the password or manage token in plain text", async () => {
        const { code, manageToken } = await share({ text: "x", password: "hunter22" });
        const stored = JSON.stringify(await Share.findOne({ code }).lean());
        expect(stored).not.toContain("hunter22");
        expect(stored).not.toContain(manageToken);
    });
});

describe("uploading files", () => {
    test("a share with files waits for its upload before it can be opened", async () => {
        const { res, code } = await share({ text: "x" }, [{ name: "a.txt", content: "hello" }], { upload: false });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe("uploading");
        expect(res.body.uploads).toEqual([
            { fileId: expect.any(String), method: "PUT", url: expect.stringMatching(/^\/api\/uploads\//), headers: { "Content-Type": "text/plain" } },
        ]);
        await openShare(code).expect(404);
    });

    test("files are stored under IDs, not their names, so same-name uploads don't collide", async () => {
        await share({}, [{ name: "photo.png", content: PNG }]);
        await share({}, [{ name: "photo.png", content: PNG }]);
        const keys = storedFiles();
        expect(keys).toHaveLength(2);
        for (const key of keys) expect(key).toMatch(/^shares\/[0-9a-f]{24}\/[0-9a-f]{24}$/);
    });

    test("complete fails until every file has arrived, then succeeds", async () => {
        const files = [{ name: "a.txt", content: "aaa" }, { name: "b.txt", content: "bbb" }];
        const { created, manageToken, code } = await share({}, files, { upload: false });
        const [first, second] = created.body.uploads;

        await request(app).put(first.url).set(first.headers).send("aaa").expect(200);
        const early = await request(app).post(`/api/shares/${code}/complete`).send({ manageToken }).expect(409);
        expect(early.body.error).toMatch(/"b.txt" hasn't finished uploading/);

        await request(app).put(second.url).set(second.headers).send("bbb").expect(200);
        const done = await request(app).post(`/api/shares/${code}/complete`).send({ manageToken }).expect(200);
        expect(done.body.status).toBe("ready");
        expect((await openShare(code).expect(200)).body.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    });

    test("the upload endpoint takes exactly the announced size", async () => {
        const { created } = await share({}, [{ name: "a.txt", content: "12345" }], { upload: false });
        const [target] = created.body.uploads;
        await request(app).put(target.url).set(target.headers).send("123456").expect(413);
        await request(app).put(target.url).set(target.headers).send("1234").expect(400);
        expect(storedFiles()).toHaveLength(0);
    });

    test("upload links can't be forged", async () => {
        const { created } = await share({}, [{ name: "a.txt", content: "abc" }], { upload: false });
        const [payload, signature] = created.body.uploads[0].url.split("/").pop().split(".");
        const claims = JSON.parse(Buffer.from(payload, "base64url"));
        const forged = Buffer.from(JSON.stringify({ ...claims, k: "../../escape", s: 999 })).toString("base64url");
        await request(app).put(`/api/uploads/${forged}.${signature}`).send("abc").expect(403);
        await request(app).put("/api/uploads/garbage").send("abc").expect(403);
    });

    test("a download token can't be used as an upload token", async () => {
        const { code } = await share({}, [{ name: "a.txt", content: "abc" }]);
        const downloadUrl = (await openShare(code)).body.files[0].downloadUrl;
        await request(app).put(`/api/uploads/${downloadUrl.split("/").pop()}`).send("abc").expect(403);
    });

    test("a .json file is stored byte for byte, not parsed as a request body", async () => {
        const content = '{"looks":"like an API request"}';
        const { code } = await share({}, [{ name: "data.json", content }]);
        const file = (await openShare(code)).body.files[0];
        const res = await request(app).get(file.downloadUrl).buffer(true).expect(200);
        expect(res.body.toString()).toBe(content);
    });

    test("complete and cancel need the share's manage token", async () => {
        const { code } = await share({}, [{ name: "a.txt", content: "a" }], { complete: false });
        await request(app).post(`/api/shares/${code}/complete`).send({ manageToken: "wrong" }).expect(404);
        await request(app).post(`/api/shares/${code}/cancel`).send({ manageToken: "wrong" }).expect(404);
        await request(app).post(`/api/shares/${code}/complete`).send({}).expect(400);
    });

    test("cancelling deletes the uploaded files and the share", async () => {
        const { code, manageToken } = await share({}, [{ name: "a.txt", content: "a" }], { complete: false });
        expect(storedFiles()).toHaveLength(1);
        await request(app).post(`/api/shares/${code}/cancel`).send({ manageToken }).expect(204);
        expect(storedFiles()).toHaveLength(0);
        expect(await Share.countDocuments()).toBe(0);
    });

    test("a share can't be completed twice", async () => {
        const { code, manageToken } = await share({}, [{ name: "a.txt", content: "a" }]);
        await request(app).post(`/api/shares/${code}/complete`).send({ manageToken }).expect(404);
    });

    test("the expiry clock starts when the upload completes", async () => {
        const { code, manageToken } = await share({ expiresIn: "1h" }, [{ name: "a.txt", content: "a" }], { complete: false });
        expect((await Share.findOne({ code }).lean()).uploadPending).toBe(true);

        // Pretend the upload took 50 minutes (10 left of the upload window):
        // the share still gets its full hour from completion.
        await Share.updateOne({ code }, { expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
        const done = await request(app).post(`/api/shares/${code}/complete`).send({ manageToken }).expect(200);
        const ms = new Date(done.body.expiresAt) - Date.now();
        expect(ms).toBeGreaterThan(59 * 60 * 1000);
    });
});

describe("file contents decide the file type", () => {
    const uploadAndOpen = async (name, content, type) => {
        const { code } = await share({}, [{ name, content, type }]);
        return (await openShare(code).expect(200)).body.files[0];
    };

    test("a real PNG is previewable, whatever its name or claimed type", async () => {
        const file = await uploadAndOpen("photo.jpg", PNG, "image/jpeg");
        expect(file).toMatchObject({ mimeType: "image/png", previewUrl: expect.stringContaining("inline=1") });
    });

    test("HTML pretending to be an image is never shown inline", async () => {
        const file = await uploadAndOpen("pic.png", "<html><script>alert(1)</script></html>", "image/png");
        expect(file).toMatchObject({ mimeType: "application/octet-stream", previewUrl: null });
        const res = await request(app).get(`${file.downloadUrl}?inline=1`).expect(200);
        expect(res.headers["content-disposition"]).toMatch(/^attachment/);
    });

    test("executables are refused, and everything uploaded is deleted", async () => {
        const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);
        const { res, code } = await share({ text: "here's the invoice" }, [
            { name: "notes.txt", content: "fine" },
            { name: "invoice.pdf", content: exe, type: "application/pdf" },
        ]);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/"invoice.pdf" is a program/);
        expect(storedFiles()).toHaveLength(0);
        await openShare(code).expect(404);
        expect(await Share.countDocuments()).toBe(0);
    });

    test("other types keep the browser's label (used only for the file icon)", async () => {
        const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        const file = await uploadAndOpen("report.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), docx);
        expect(file).toMatchObject({ mimeType: docx, previewUrl: null });
    });
});

describe("opening shares", () => {
    test("returns text and files; code is case- and dash-insensitive", async () => {
        const { code } = await share({ text: "hello" }, [{ name: "résumé.pdf", content: "%PDF-1.7" }]);
        const pretty = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
        const res = await openShare(pretty).expect(200);
        expect(res.body.text).toBe("hello");
        expect(res.body.files).toHaveLength(1);
        expect(res.body.files[0]).toMatchObject({ name: "résumé.pdf", size: 8, mimeType: "application/pdf" });
        expect(res.body.files[0].previewUrl).toBeNull();
    });

    test("unknown and malformed codes are 404", async () => {
        await openShare("ABCDEFGH").expect(404);
        await openShare("1234").expect(404);
    });

    test("stored files are not reachable as static files", async () => {
        await share({}, [{ name: "secret.txt", content: "secret-content-123" }]);
        const [key] = storedFiles();
        for (const url of [`/uploads/${key}`, `/${key}`, `/api/${key}`]) {
            expect((await request(app).get(url)).text).not.toContain("secret-content-123");
        }
    });

    test("expired shares are not returned even before cleanup runs", async () => {
        const { code } = await share({ text: "x" });
        await Share.updateOne({ code }, { expiresAt: new Date(Date.now() - 1000) });
        await openShare(code).expect(404);
    });

    test("password protection", async () => {
        const { code } = await share({ text: "secret", password: "hunter22" });

        const missing = await openShare(code).expect(401);
        expect(missing.body.passwordRequired).toBe(true);
        expect(missing.body.text).toBeUndefined();

        await openShare(code, { password: "wrong" }).expect(401);
        const ok = await openShare(code, { password: "hunter22" }).expect(200);
        expect(ok.body.text).toBe("secret");
    });

    test("wrong passwords don't use up views", async () => {
        const { code } = await share({ text: "x", password: "hunter22", maxViews: 1 });
        await openShare(code, { password: "nope" }).expect(401);
        await openShare(code, { password: "hunter22" }).expect(200);
    });

    test("one-time share can only be opened once", async () => {
        const { code } = await share({ text: "once", maxViews: 1 });
        const first = await openShare(code).expect(200);
        expect(first.body.viewsRemaining).toBe(0);
        await openShare(code).expect(404);
    });

    test("concurrent opens of a one-time share: exactly one succeeds", async () => {
        const { code } = await share({ text: "once", maxViews: 1 });
        const results = await Promise.all(Array.from({ length: 8 }, () => openShare(code)));
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    });

    test("after the last view, the share is kept only for the download window", async () => {
        const { code } = await share({ text: "x", maxViews: 5, expiresIn: "7d" });
        for (let i = 0; i < 4; i++) await openShare(code).expect(200);
        const last = await openShare(code).expect(200);
        const ms = new Date(last.body.expiresAt) - Date.now();
        expect(ms).toBeLessThanOrEqual(10 * 60 * 1000);
    });
});

describe("downloading files", () => {
    const openWithFile = async (name, content) => {
        const { code } = await share({}, [{ name, content }]);
        return (await openShare(code)).body.files[0];
    };

    test("downloads with the original filename, as an attachment", async () => {
        const file = await openWithFile("notes.txt", "file contents");
        const res = await request(app).get(file.downloadUrl).buffer(true).expect(200);
        expect(res.body.toString()).toBe("file contents");
        expect(res.headers["content-type"]).toBe("application/octet-stream");
        expect(res.headers["content-disposition"]).toBe('attachment; filename="notes.txt"');
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    test("images can be previewed inline", async () => {
        const file = await openWithFile("pic.png", PNG);
        expect(file.previewUrl).toBeTruthy();
        const res = await request(app).get(file.previewUrl).expect(200);
        expect(res.headers["content-type"]).toBe("image/png");
        expect(res.headers["content-disposition"]).toMatch(/^inline/);
    });

    test("HTML and SVG are never served inline", async () => {
        for (const name of ["page.html", "image.svg"]) {
            const file = await openWithFile(name, "<svg><script>alert(1)</script></svg>");
            expect(file.previewUrl).toBeNull();
            const res = await request(app).get(`${file.downloadUrl}?inline=1`).expect(200);
            expect(res.headers["content-type"]).toBe("application/octet-stream");
            expect(res.headers["content-disposition"]).toMatch(/^attachment/);
        }
    });

    test("tampered tokens are rejected", async () => {
        const file = await openWithFile("a.txt", "a");
        const [payload, sig] = file.downloadUrl.split("/").pop().split(".");
        const forged = Buffer.from(
            JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), e: 9999999999 })
        ).toString("base64url");
        await request(app).get(`/api/files/${forged}.${sig}`).expect(404);
        await request(app).get("/api/files/garbage").expect(404);
    });

    test("links stop working once the share expires", async () => {
        const file = await openWithFile("a.txt", "a");
        await Share.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
        await request(app).get(file.downloadUrl).expect(404);
    });

    test("counts downloads but not previews", async () => {
        const file = await openWithFile("pic.png", PNG);
        await request(app).get(file.previewUrl).expect(200);
        await request(app).get(file.downloadUrl).expect(200);
        const stored = await Share.findOne().lean();
        expect(stored.files[0].downloads).toBe(1);
    });
});

describe("cleanup", () => {
    test("deletes expired shares together with their files", async () => {
        const { code } = await share({}, [{ name: "a.txt", content: "a" }]);
        await share({ text: "still active" });
        await Share.updateOne({ code }, { expiresAt: new Date(Date.now() - 1000) });

        expect(await deleteExpiredShares()).toBe(1);
        expect(await Share.countDocuments()).toBe(1);
        expect(storedFiles()).toHaveLength(0);
    });

    test("discards uploads that were never completed", async () => {
        const { code } = await share({}, [{ name: "a.txt", content: "a" }], { complete: false });
        await Share.updateOne({ code }, { expiresAt: new Date(Date.now() - 1000) });

        expect(await deleteExpiredShares()).toBe(1);
        expect(await Share.countDocuments()).toBe(0);
        expect(storedFiles()).toHaveLength(0);
    });

    test("deletes old files no share references, but not recent or referenced ones", async () => {
        await share({}, [{ name: "kept.txt", content: "k" }]);
        const orphanDir = path.join(uploadDir, "shares", "000000000000000000000000");
        fs.mkdirSync(orphanDir, { recursive: true });
        const old = path.join(orphanDir, "old");
        const recent = path.join(orphanDir, "recent");
        fs.writeFileSync(old, "x");
        fs.writeFileSync(recent, "x");
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(old, twoHoursAgo, twoHoursAgo);

        expect(await deleteOrphanFiles()).toBe(1);
        expect(storedFiles()).toHaveLength(2);
        expect(fs.existsSync(old)).toBe(false);
    });
});

describe("serving the React app", () => {
    test("every page path gets index.html, for client-side routing", async () => {
        for (const page of ["/", "/s/ABCD2345", "/open", "/shares", "/reset-password?token=x", "/no/such/page"]) {
            const res = await request(app).get(page).expect(200);
            expect(res.text).toContain('<div id="root">');
            expect(res.headers["cache-control"]).toBe("no-cache");
        }
    });

    test("hashed assets are cached for a year; missing ones are 404", async () => {
        const res = await request(app).get("/assets/index-abc123.js").expect(200);
        expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        await request(app).get("/assets/missing.js").expect(404);
        await request(app).get("/favicon.svg").expect(200);
        await request(app).get("/missing.png").expect(404); // file-like paths don't get the app
    });

    test("without a build, pages explain how to build or run the dev server", async () => {
        const config = require("../src/config");
        const original = config.clientDir;
        config.clientDir = path.join(original, "does-not-exist");
        try {
            const res = await request(require("../src/app").createApp({ rateLimit: false })).get("/").expect(503);
            expect(res.text).toMatch(/npm run build/);
        } finally {
            config.clientDir = original;
        }
    });

    test("the page is served with a strict Content-Security-Policy", async () => {
        const res = await request(app).get("/").expect(200);
        const csp = res.headers["content-security-policy"];
        expect(csp).toContain("script-src 'self'");
        // Disk storage: files come from this server, so no other origin is allowed.
        expect(csp).toContain("img-src 'self' data:;");
        expect(csp).toContain("upgrade-insecure-requests");
    });

    test("unknown API routes return JSON 404, not the app", async () => {
        const res = await request(app).get("/api/nope").expect(404);
        expect(res.body.error).toBe("Not found");
    });
});

describe("GET /api/config", () => {
    test("exposes the limits and options the frontend needs", async () => {
        const res = await request(app).get("/api/config").expect(200);
        expect(res.body).toMatchObject({
            maxFiles: 10,
            maxFileSizeBytes: 50 * 1024 * 1024,
            defaultExpiry: "24h",
            viewLimitOptions: [1, 5, 10],
            sharePassword: { min: 4, max: 72 },
            accountPassword: { min: 8, max: 72 },
            uploadWindowSeconds: 3600,
            storage: "disk",
        });
        expect(res.body.expiryOptions).toContainEqual({ value: "7d", label: "7 days" });
    });
});
