const fs = require("fs");
const path = require("path");
const { app, uploadDir, storedFiles, useTestDatabase } = require("./helpers");
const request = require("supertest");
const Share = require("../src/models/Share");
const { deleteExpiredShares, deleteOrphanFiles } = require("../src/lib/cleanup");

useTestDatabase();

const createShare = (fields = {}, files = []) => {
    const req = request(app).post("/api/shares");
    for (const [key, value] of Object.entries(fields)) req.field(key, value);
    for (const file of files) req.attach("files", file.content, file.name);
    return req;
};

const openShare = (code, body = {}) => request(app).post(`/api/shares/${code}/open`).send(body);

describe("creating shares", () => {
    test("text share returns an 8-character code and link", async () => {
        const res = await createShare({ text: "hello" }).expect(201);
        expect(res.body.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
        expect(res.body.url).toMatch(new RegExp(`/s/${res.body.code}$`));
    });

    test("rejects an empty share", async () => {
        const res = await createShare({ text: "   " }).expect(400);
        expect(res.body.error).toMatch(/text or at least one file/);
    });

    test("rejects unknown expiry and view-limit values", async () => {
        await createShare({ text: "x", expiresIn: "100y" }).expect(400);
        await createShare({ text: "x", maxViews: "3" }).expect(400);
    });

    test("applies the chosen expiry", async () => {
        const res = await createShare({ text: "x", expiresIn: "1h" }).expect(201);
        const ms = new Date(res.body.expiresAt) - Date.now();
        expect(ms).toBeGreaterThan(59 * 60 * 1000);
        expect(ms).toBeLessThanOrEqual(60 * 60 * 1000);
    });

    test("never stores the password in plain text", async () => {
        const res = await createShare({ text: "x", password: "hunter22" }).expect(201);
        const share = await Share.findOne({ code: res.body.code }).lean();
        expect(share.passwordHash).toBeTruthy();
        expect(JSON.stringify(share)).not.toContain("hunter22");
    });

    test("files get random names on disk, so same-name uploads don't collide", async () => {
        const file = { name: "photo.png", content: Buffer.from("a") };
        await createShare({}, [file]).expect(201);
        await createShare({}, [{ ...file, content: Buffer.from("b") }]).expect(201);
        const names = storedFiles();
        expect(names).toHaveLength(2);
        expect(names).not.toContain("photo.png");
    });

    test("removes uploaded files when validation fails", async () => {
        await createShare({ expiresIn: "bad" }, [{ name: "a.txt", content: Buffer.from("a") }]).expect(400);
        expect(storedFiles()).toHaveLength(0);
    });
});

describe("opening shares", () => {
    test("returns text and files; code is case- and dash-insensitive", async () => {
        const { body } = await createShare({ text: "hello" }, [
            { name: "résumé.pdf", content: Buffer.from("pdf") },
        ]);
        const pretty = `${body.code.slice(0, 4)}-${body.code.slice(4)}`.toLowerCase();
        const res = await openShare(pretty).expect(200);
        expect(res.body.text).toBe("hello");
        expect(res.body.files).toHaveLength(1);
        expect(res.body.files[0]).toMatchObject({ name: "résumé.pdf", size: 3 });
        expect(res.body.files[0].previewUrl).toBeNull();
    });

    test("unknown and malformed codes are 404", async () => {
        await openShare("ABCDEFGH").expect(404);
        await openShare("1234").expect(404);
    });

    test("old uploads are not reachable as static files", async () => {
        await createShare({}, [{ name: "secret.txt", content: Buffer.from("s") }]);
        await request(app).get("/uploads/secret.txt").expect(404);
    });

    test("expired shares are not returned even before cleanup runs", async () => {
        const { body } = await createShare({ text: "x" });
        await Share.updateOne({ code: body.code }, { expiresAt: new Date(Date.now() - 1000) });
        await openShare(body.code).expect(404);
    });

    test("password protection", async () => {
        const { body } = await createShare({ text: "secret", password: "hunter22" });

        const missing = await openShare(body.code).expect(401);
        expect(missing.body.passwordRequired).toBe(true);
        expect(missing.body.text).toBeUndefined();

        await openShare(body.code, { password: "wrong" }).expect(401);
        const ok = await openShare(body.code, { password: "hunter22" }).expect(200);
        expect(ok.body.text).toBe("secret");
    });

    test("wrong passwords don't use up views", async () => {
        const { body } = await createShare({ text: "x", password: "hunter22", maxViews: "1" });
        await openShare(body.code, { password: "nope" }).expect(401);
        await openShare(body.code, { password: "hunter22" }).expect(200);
    });

    test("one-time share can only be opened once", async () => {
        const { body } = await createShare({ text: "once", maxViews: "1" });
        const first = await openShare(body.code).expect(200);
        expect(first.body.viewsRemaining).toBe(0);
        await openShare(body.code).expect(404);
    });

    test("concurrent opens of a one-time share: exactly one succeeds", async () => {
        const { body } = await createShare({ text: "once", maxViews: "1" });
        const results = await Promise.all(Array.from({ length: 8 }, () => openShare(body.code)));
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    });

    test("after the last view, the share is kept only for the download window", async () => {
        const { body } = await createShare({ text: "x", maxViews: "5", expiresIn: "7d" });
        for (let i = 0; i < 4; i++) await openShare(body.code).expect(200);
        const last = await openShare(body.code).expect(200);
        const ms = new Date(last.body.expiresAt) - Date.now();
        expect(ms).toBeLessThanOrEqual(10 * 60 * 1000);
    });
});

describe("downloading files", () => {
    const openWithFile = async (name, content) => {
        const { body } = await createShare({}, [{ name, content: Buffer.from(content) }]);
        return (await openShare(body.code)).body.files[0];
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
        const file = await openWithFile("pic.png", "png-bytes");
        expect(file.previewUrl).toBeTruthy();
        const res = await request(app).get(file.previewUrl).expect(200);
        expect(res.headers["content-type"]).toBe("image/png");
        expect(res.headers["content-disposition"]).toMatch(/^inline/);
    });

    test("HTML and SVG are never served inline", async () => {
        for (const name of ["page.html", "image.svg"]) {
            const file = await openWithFile(name, "<script>alert(1)</script>");
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
        const file = await openWithFile("pic.png", "png");
        await request(app).get(file.previewUrl).expect(200);
        await request(app).get(file.downloadUrl).expect(200);
        const share = await Share.findOne().lean();
        expect(share.files[0].downloads).toBe(1);
    });
});

describe("cleanup", () => {
    test("deletes expired shares together with their files", async () => {
        const { body } = await createShare({}, [{ name: "a.txt", content: Buffer.from("a") }]);
        await createShare({ text: "still active" });
        await Share.updateOne({ code: body.code }, { expiresAt: new Date(Date.now() - 1000) });

        expect(await deleteExpiredShares()).toBe(1);
        expect(await Share.countDocuments()).toBe(1);
        expect(storedFiles()).toHaveLength(0);
    });

    test("deletes old files no share references, but not recent or referenced ones", async () => {
        await createShare({}, [{ name: "kept.txt", content: Buffer.from("k") }]);
        const old = path.join(uploadDir, "orphan-old");
        const recent = path.join(uploadDir, "orphan-recent");
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
        expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
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
        });
        expect(res.body.expiryOptions).toContainEqual({ value: "7d", label: "7 days" });
    });
});
