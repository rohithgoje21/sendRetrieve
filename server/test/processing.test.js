const { app, createShare, storedFiles, PNG, settle, useTestDatabase } = require("./helpers");
const request = require("supertest");
const sharp = require("sharp");
const Share = require("../src/modules/shares/share.model");
const scanner = require("../src/infrastructure/clamav");
const { getBus } = require("../src/infrastructure/queue");
const { requeueStuckProcessing } = require("../src/workers/scheduler");

useTestDatabase();

afterEach(() => jest.restoreAllMocks());

const openShare = (code) => request(app).post(`/api/shares/${code}/open`).send({});
const share = (fields, files, options) => createShare(app, fields, files, options);

const register = async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ name: "Ada", email: `ada-${Date.now()}@example.com`, password: "correct-horse" }).expect(201);
    return agent;
};

// Pretends a scanner is configured; `scan` stands in for clamd.
const withScanner = (scan) => {
    jest.spyOn(scanner, "enabled").mockReturnValue(true);
    return jest.spyOn(scanner, "scanStream").mockImplementation(async (stream) => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return scan(Buffer.concat(chunks).toString("utf8"));
    });
};

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

describe("dangerous file types", () => {
    test("programs and scripts are refused before anything is uploaded", async () => {
        const { res } = await share({}, [
            { name: "notes.txt", content: "fine" },
            { name: "Setup.EXE", content: "MZ...", type: "application/octet-stream" },
        ]);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/"Setup.EXE" can't be shared: \.exe files/);
        expect(res.body.field).toBe("files.1.name");
        expect(await Share.countDocuments()).toBe(0);
    });

    test.each(["run.ps1", "script.vbs", "autorun.bat", "shortcut.lnk", "tool.jar"])("%s is refused", async (name) => {
        expect((await share({}, [{ name, content: "x", type: "application/octet-stream" }])).res.status).toBe(400);
    });
});

describe("without a scanner", () => {
    test("shares go live as soon as the upload completes; files are marked unscanned", async () => {
        const { res, code } = await share({}, [{ name: "a.txt", content: "hello" }]);
        expect(res.body.status).toBe("ready");
        await openShare(code).expect(200);
        expect((await Share.findOne({ code })).files[0].scanStatus).toBe("skipped");
    });
});

describe("malware scanning", () => {
    test("a share is held back until every file has been scanned clean", async () => {
        let release;
        const scanned = new Promise((resolve) => {
            release = resolve;
        });
        const scan = withScanner(async () => {
            await scanned;
            return { infected: false };
        });

        const { res, code } = await share({}, [
            { name: "a.txt", content: "hello" },
            { name: "b.txt", content: "world" },
        ]);
        expect(res.body.status).toBe("processing");
        await openShare(code).expect(404);
        expect(await Share.findOne({ code })).toMatchObject({ processing: true });

        release();
        await settle();
        expect(scan).toHaveBeenCalledTimes(2);
        const stored = await Share.findOne({ code });
        expect(stored.processing).toBe(false);
        expect(stored.files.map((f) => f.scanStatus)).toEqual(["clean", "clean"]);
        await openShare(code).expect(200);
    });

    test("one infected file blocks the whole share and deletes its files", async () => {
        withScanner((content) => (content.includes("EICAR") ? { infected: true, signature: "Eicar-Test-Signature" } : { infected: false }));
        const agent = await register();

        const { code } = await createShare(agent, {}, [
            { name: "clean.txt", content: "hello" },
            { name: "eicar.txt", content: EICAR },
        ]);
        await settle();

        await openShare(code).expect(404);
        const stored = await Share.findOne({ code });
        expect(stored).toMatchObject({ endedReason: "malware", filesState: "deleted" });
        expect(stored.files.map((f) => f.scanStatus)).toEqual(["clean", "infected"]);
        expect(storedFiles()).toHaveLength(0);

        const { body } = await agent.get(`/api/me/shares/${code}`).expect(200);
        expect(body.share).toMatchObject({ status: "expired", endedReason: "malware", processing: false });
        expect(body.share.files.find((f) => f.name === "eicar.txt").scanStatus).toBe("infected");
    });

    test("if the scanner is down the share stays unavailable (fail closed) and the job is retried", async () => {
        let down = true;
        const scan = withScanner(async () => {
            if (down) throw new Error("connect ECONNREFUSED");
            return { infected: false };
        });

        const { code } = await share({}, [{ name: "a.txt", content: "hello" }]);
        await settle();
        expect(scan).toHaveBeenCalledTimes(4); // first try + 3 retries, then dead-lettered
        await openShare(code).expect(404);
        expect((await getBus().stats()).find((q) => q.name === "sr.processing").deadLettered).toBe(1);

        down = false; // scanner back: replaying the dead letter finishes the job
        expect(await getBus().replayDeadLetters("sr.processing")).toBe(1);
        await settle();
        await openShare(code).expect(200);
        expect((await Share.findOne({ code })).files[0].scanStatus).toBe("clean");
    });

    test("a scan stuck for a while is re-queued once the scanner is reachable", async () => {
        let down = true;
        withScanner(async () => {
            if (down) throw new Error("connect ECONNREFUSED");
            return { infected: false };
        });
        const health = jest.spyOn(scanner, "health").mockResolvedValue("down");
        const { code } = await share({}, [{ name: "a.txt", content: "hello" }]);
        await settle(); // gave up: dead-lettered

        expect(await requeueStuckProcessing()).toBe(0); // not stuck long enough yet
        await Share.collection.updateOne({ code }, { $set: { updatedAt: new Date(Date.now() - 11 * 60 * 1000) } });
        expect(await requeueStuckProcessing()).toBe(0); // scanner still down

        down = false;
        health.mockResolvedValue("up");
        expect(await requeueStuckProcessing()).toBe(1);
        await settle();
        await openShare(code).expect(200);
    });

    test("a share deleted while it is being scanned stays deleted", async () => {
        let release;
        const scanned = new Promise((resolve) => {
            release = resolve;
        });
        withScanner(async () => {
            await scanned;
            return { infected: false };
        });
        const agent = await register();
        const { code } = await createShare(agent, {}, [{ name: "a.txt", content: "hello" }]);
        await agent.delete(`/api/me/shares/${code}`).expect(204);
        release();
        await settle();
        expect(await Share.findOne({ code })).toMatchObject({ endedReason: "deleted", processing: false });
        await openShare(code).expect(404);
    });
});

describe("thumbnails", () => {
    const photo = () =>
        sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 80, b: 40 } } })
            .jpeg()
            .toBuffer();

    test("images get a small webp thumbnail and their dimensions", async () => {
        const { code } = await share({}, [
            { name: "photo.jpg", content: await photo() },
            { name: "notes.txt", content: "not an image" },
        ]);
        await settle();

        const { body } = await openShare(code).expect(200);
        const [image, text] = body.files;
        expect(image).toMatchObject({ width: 1200, height: 800, thumbnailUrl: expect.stringMatching(/\?thumb=1$/) });
        expect(text.thumbnailUrl).toBeNull();

        const thumb = await request(app).get(new URL(image.thumbnailUrl, "http://x").pathname + "?thumb=1").buffer(true).parse((res, done) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => done(null, Buffer.concat(chunks)));
        });
        expect(thumb.status).toBe(200);
        expect(thumb.headers["content-type"]).toBe("image/webp");
        expect(await sharp(thumb.body).metadata()).toMatchObject({ format: "webp", width: 480, height: 320 });

        // Fetching the thumbnail isn't a download.
        expect((await Share.findOne({ code })).files[0].downloads).toBe(0);
        await request(app)
            .get(new URL(text.downloadUrl, "http://x").pathname + "?thumb=1")
            .expect(404);
    });

    test("small images aren't enlarged", async () => {
        const { code } = await share({}, [{ name: "dot.png", content: PNG }]);
        await settle();
        expect((await openShare(code).expect(200)).body.files[0]).toMatchObject({ width: 1, height: 1 });
    });

    test("an image that can't be decoded just gets no thumbnail", async () => {
        const broken = Buffer.concat([PNG.subarray(0, 40), Buffer.alloc(20)]);
        const { code } = await share({}, [{ name: "broken.png", content: broken }]);
        await settle();
        const { body } = await openShare(code).expect(200);
        expect(body.files[0].thumbnailUrl).toBeNull();
    });

    test("thumbnails are deleted with the share", async () => {
        const agent = await register();
        const { code } = await createShare(agent, {}, [{ name: "photo.jpg", content: await photo() }]);
        await settle();
        expect(storedFiles()).toHaveLength(2);
        await agent.delete(`/api/me/shares/${code}`).expect(204);
        await settle();
        expect(storedFiles()).toHaveLength(0);
    });
});

describe("reading clamd's replies", () => {
    test.each([
        ["stream: OK", { infected: false }],
        ["stream: Win.Test.EICAR_HDB-1 FOUND", { infected: true, signature: "Win.Test.EICAR_HDB-1" }],
    ])("%s", (reply, expected) => expect(scanner.parseScanReply(reply)).toEqual(expected));

    test("anything else is an error, never \"clean\"", () => {
        expect(() => scanner.parseScanReply("INSTREAM size limit exceeded. ERROR")).toThrow(/Scanner error/);
        expect(() => scanner.parseScanReply("")).toThrow(/no reply/);
    });
});
