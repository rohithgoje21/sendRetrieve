const crypto = require("crypto");
const mongoose = require("mongoose");
const request = require("supertest");
const { app, createShare, PNG, settle, useTestDatabase } = require("./helpers");
const User = require("../src/modules/users/user.model");
const { ShareStat, SiteStat } = require("../src/modules/analytics/stats.models");
const { recordView } = require("../src/modules/analytics/analytics.service");
const { visitorToken, dayOf } = require("../src/modules/analytics/visitors");
const { categoryOf } = require("../src/modules/analytics/fileCategories");
const { registerOf, merge, estimate } = require("../src/shared/hyperloglog");

useTestDatabase();

const PASSWORD = "correct-horse";
const register = async (email = "ada@example.com", role) => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ name: "Ada", email, password: PASSWORD }).expect(201);
    if (role) await User.updateOne({ email }, { role });
    return agent;
};

// A visitor: their own browser (User-Agent) opening and downloading.
const visit = async (code, browser, { download = true } = {}) => {
    const opened = await request(app).post(`/api/shares/${code}/open`).set("User-Agent", browser).send({}).expect(200);
    if (download) await request(app).get(opened.body.files[0].downloadUrl).set("User-Agent", browser).expect(200);
};

const sketchOf = (n, prefix = "v") => {
    const s = {};
    for (let i = 0; i < n; i++) {
        const { index, rank } = registerOf(crypto.createHash("sha256").update(`${prefix}${i}`).digest("hex"));
        if (!(s[index] >= rank)) s[index] = rank;
    }
    return s;
};

describe("HyperLogLog", () => {
    // 1024 registers: a standard error of about 3%, so allow three of those.
    test("small counts are exact, large ones within a few percent", () => {
        expect(estimate({})).toBe(0);
        expect(estimate(sketchOf(1))).toBe(1);
        expect(estimate(sketchOf(25))).toBe(25);
        const big = estimate(sketchOf(20000));
        expect(Math.abs(big - 20000) / 20000).toBeLessThan(0.1);
    });

    test("sketches merge without counting overlaps twice", () => {
        const union = estimate(merge(sketchOf(1000, "a"), sketchOf(1000, "a"), sketchOf(500, "b")));
        expect(Math.abs(union - 1500) / 1500).toBeLessThan(0.1);
    });

    test("the same item always lands in the same register", () => {
        expect(registerOf("0123456789abcdef")).toEqual(registerOf("0123456789abcdef"));
        expect(registerOf("ffffffffffffffff")).toEqual({ index: 1023, rank: 1 });
        expect(registerOf("0000000000000000")).toEqual({ index: 0, rank: 55 });
    });
});

describe("collecting statistics", () => {
    test("views, downloads, bandwidth and unique visitors per share, per day", async () => {
        const owner = await register();
        const { code } = await createShare(owner, {}, [{ name: "photo.png", content: PNG }]);
        await visit(code, "Browser A");
        await visit(code, "Browser A"); // same visitor again
        await visit(code, "Browser B", { download: false });
        await settle();

        const [stat] = await ShareStat.find().lean();
        expect(stat).toMatchObject({ views: 3, downloads: 2, bytes: 2 * PNG.length, downloadsByType: { image: 2 } });
        expect(stat.day).toEqual(dayOf(new Date()));
        expect(estimate(stat.visitors)).toBe(2);

        const [site] = await SiteStat.find().lean();
        expect(site).toMatchObject({ views: 3, downloads: 2, sharesCreated: 1, filesUploaded: 1, uploadsByType: { image: { files: 1, bytes: PNG.length } } });
    });

    test("nothing personal is stored: no addresses, no visitor tokens", async () => {
        const owner = await register();
        const { code } = await createShare(owner, {}, [{ name: "a.txt", content: "a" }]);
        await visit(code, "Browser A");
        await settle();
        const stored = JSON.stringify([await ShareStat.find().lean(), await SiteStat.find().lean()]);
        expect(stored).not.toMatch(/127\.0\.0\.1|Browser A/);
        const token = visitorToken({ ip: "::ffff:127.0.0.1", get: () => "Browser A" });
        expect(stored).not.toContain(token);
        // Visitor sketches are register numbers and ranks only.
        const [stat] = await ShareStat.find().lean();
        for (const [index, rank] of Object.entries(stat.visitors)) {
            expect(Number(index)).toBeLessThan(1024);
            expect(rank).toBeLessThanOrEqual(55);
        }
    });

    test("visitor tokens change every day, so nobody is followed across days", () => {
        const req = { ip: "203.0.113.9", get: () => "Browser A" };
        const monday = visitorToken(req, new Date("2030-01-07T10:00:00Z"));
        expect(visitorToken(req, new Date("2030-01-07T23:59:00Z"))).toBe(monday);
        expect(visitorToken(req, new Date("2030-01-08T00:01:00Z"))).not.toBe(monday);
        expect(visitorToken({ ...req, ip: "203.0.113.10" }, new Date("2030-01-07T10:00:00Z"))).not.toBe(monday);
    });

    test("an event counts on the day it happened, even if processed later", async () => {
        const at = new Date("2030-01-05T23:30:00Z");
        await recordView({ shareId: new mongoose.Types.ObjectId(), ownerId: null, visitor: "aaaaaaaaaaaaaaaa", at });
        expect((await SiteStat.findOne({ day: new Date("2030-01-05T00:00:00Z") })).views).toBe(1);
    });

    test.each([
        ["image/png", "image"],
        ["video/mp4", "video"],
        ["audio/mpeg", "audio"],
        ["application/pdf", "document"],
        ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
        ["text/plain", "document"],
        ["application/zip", "archive"],
        ["application/octet-stream", "other"],
    ])("%s is %s", (mime, category) => expect(categoryOf(mime)).toBe(category));
});

describe("my analytics", () => {
    test("totals, a value per day, compared with the period before", async () => {
        const owner = await register();
        const { code } = await createShare(owner, {}, [{ name: "report.pdf", content: "%PDF-1.7 numbers", type: "application/pdf" }]);
        await visit(code, "Browser A");
        await visit(code, "Browser B");
        await settle();
        // Some activity 10 days ago: in the previous 7-day period.
        const share = await ShareStat.findOne().lean();
        const earlier = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        await recordView({ shareId: share.shareId, ownerId: share.ownerId, visitor: "aaaaaaaaaaaaaaaa", at: earlier });

        const { body } = await owner.get("/api/me/analytics?days=7").expect(200);
        expect(body.days).toBe(7);
        expect(body.totals).toMatchObject({ views: 2, downloads: 2, visitors: 2, sharesCreated: 1 });
        expect(body.totals.bytes).toBe(2 * "%PDF-1.7 numbers".length);
        expect(body.previous).toMatchObject({ views: 1, downloads: 0, visitors: 1 });
        expect(body.daily).toHaveLength(7);
        expect(body.daily.at(-1)).toMatchObject({ day: new Date().toISOString().slice(0, 10), views: 2, downloads: 2 });
        expect(body.daily[0]).toMatchObject({ views: 0, downloads: 0, visitors: 0 });
        expect(body.fileTypes.document).toEqual({ files: 1, bytes: "%PDF-1.7 numbers".length });
        expect(body.downloadsByType.document).toBe(2);
        expect(body.topShares).toEqual([expect.objectContaining({ code, label: "report.pdf", views: 2, downloads: 2 })]);
    });

    test("one share's activity, and only your own", async () => {
        const owner = await register();
        const other = await register("bob@example.com");
        const { code } = await createShare(owner, {}, [{ name: "a.txt", content: "abc" }]);
        await visit(code, "Browser A");
        await settle();

        const { body } = await owner.get(`/api/me/analytics/shares/${code}?days=30`).expect(200);
        expect(body.daily).toHaveLength(30);
        expect(body.totals).toMatchObject({ views: 1, downloads: 1, bytes: 3, visitors: 1 });
        expect(body.files).toEqual([expect.objectContaining({ name: "a.txt", downloads: 1, size: 3 })]);
        await other.get(`/api/me/analytics/shares/${code}`).expect(404);
        expect((await other.get("/api/me/analytics").expect(200)).body.totals).toMatchObject({ views: 0, downloads: 0 });
        await request(app).get("/api/me/analytics").expect(401);
    });

    test("periods are 7, 30 or 90 days (30 otherwise)", async () => {
        const owner = await register();
        expect((await owner.get("/api/me/analytics?days=90").expect(200)).body.daily).toHaveLength(90);
        expect((await owner.get("/api/me/analytics?days=12").expect(200)).body.days).toBe(30);
    });

    test("deleting the account deletes its statistics", async () => {
        const owner = await register();
        const { code } = await createShare(owner, {}, [{ name: "a.txt", content: "a" }]);
        await visit(code, "Browser A");
        await settle();
        await owner.delete("/api/me").send({ password: PASSWORD }).expect(204);
        expect(await ShareStat.countDocuments()).toBe(0);
        expect(await SiteStat.countDocuments()).toBe(1); // site totals stay (they're anonymous)
    });
});

describe("site analytics (admins)", () => {
    test("every share counts, guests' too; only admins can see it", async () => {
        const admin = await register("boss@example.com", "admin");
        const user = await register("user@example.com");
        const { code } = await createShare(app, { text: "guest" });
        await request(app).post(`/api/shares/${code}/open`).send({}).expect(200);
        await createShare(user, {}, [{ name: "clip.mp4", content: "....ftypisom", type: "video/mp4" }]);
        await settle();

        const { body } = await admin.get("/api/admin/analytics?days=7").expect(200);
        expect(body.totals).toMatchObject({ views: 1, sharesCreated: 2, filesUploaded: 1, visitors: 1 });
        expect(body.daily).toHaveLength(7);
        expect(body.daily.at(-1)).toMatchObject({ views: 1, sharesCreated: 2 });
        expect(Object.values(body.uploadsByType).reduce((n, t) => n + t.files, 0)).toBe(1);
        await user.get("/api/admin/analytics").expect(403);
    });
});
