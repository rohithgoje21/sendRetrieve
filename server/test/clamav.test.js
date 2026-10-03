// Malware scanning against a real ClamAV daemon. Runs only when one is
// available (it takes a minute or two to load its signatures), e.g. from the
// repository root:
//
//   docker run -d --name clamav-test -p 3311:3310 \
//     -v ./docker/clamav/clamd.conf:/etc/clamav/clamd.conf:ro clamav/clamav:stable
//   TEST_CLAMAV_HOST=localhost TEST_CLAMAV_PORT=3311 npm test -w server

const TEST_CLAMAV_HOST = process.env.TEST_CLAMAV_HOST;
if (TEST_CLAMAV_HOST) {
    process.env.CLAMAV_HOST = TEST_CLAMAV_HOST;
    process.env.CLAMAV_PORT = process.env.TEST_CLAMAV_PORT || "3310";
}

const { Readable } = require("stream");
const request = require("supertest");
const { app, createShare, storedFiles, settle, useTestDatabase } = require("./helpers");
const Share = require("../src/modules/shares/share.model");
const scanner = require("../src/infrastructure/clamav");

// The industry-standard antivirus test file: harmless, detected by every scanner.
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

(TEST_CLAMAV_HOST ? describe : describe.skip)("ClamAV", () => {
    useTestDatabase();

    test("the daemon answers and reports healthy", async () => {
        expect(await scanner.ping()).toBe(true);
        expect(await scanner.health()).toBe("up");
        expect((await request(app).get("/healthz")).body.scanner).toBe("up");
    });

    test("scans streams: clean content passes, EICAR is detected", async () => {
        expect(await scanner.scanStream(Readable.from([Buffer.from("just some text")]))).toEqual({ infected: false });
        expect(await scanner.scanStream(Readable.from([Buffer.from(EICAR)]))).toEqual({
            infected: true,
            signature: expect.stringMatching(/Eicar/i),
        });
    });

    test("large files are streamed in chunks", async () => {
        const chunks = Array.from({ length: 40 }, () => Buffer.alloc(256 * 1024, 0x61)); // 10 MB
        expect(await scanner.scanStream(Readable.from(chunks))).toEqual({ infected: false });
    });

    test("a clean share goes live after its scan; an infected one is blocked", async () => {
        const clean = await createShare(app, {}, [{ name: "notes.txt", content: "hello" }]);
        const infected = await createShare(app, {}, [{ name: "eicar.com.txt", content: EICAR }]);
        expect(clean.body.status).toBe("processing");
        expect(infected.body.status).toBe("processing");
        await settle();

        await request(app).post(`/api/shares/${clean.code}/open`).send({}).expect(200);
        await request(app).post(`/api/shares/${infected.code}/open`).send({}).expect(404);
        expect((await Share.findOne({ code: clean.code })).files[0].scanStatus).toBe("clean");
        // Guest share: its record goes along with its files.
        expect(await Share.findOne({ code: infected.code })).toBeNull();
        expect(storedFiles()).toHaveLength(1);
    });
});
