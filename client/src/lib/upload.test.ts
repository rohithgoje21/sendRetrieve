import { createShare, isResumable, matchFiles, resumeUpload, uploadSettings, type PendingUpload, type UploadProgress } from "./upload";
import { ApiError } from "./api";
import { mockApi } from "@/test/utils";
import { FakeXHR } from "@/test/fakeXhr";

// Content where every byte's position shows: "0123456789abcdefghij..." repeated.
const content = (size: number) => Array.from({ length: size }, (_, i) => "0123456789abcdefghijklmnopqrstuvwxyz"[i % 36]).join("");
const file = (name: string, size: number, type = "text/plain") => new File([content(size)], name, { type, lastModified: 1700000000000 });

const input = (files: File[], overrides = {}) => ({ text: "", expiresIn: "24h", maxViews: null, password: "", files, ...overrides });

const share = {
    code: "ABCD2345",
    url: "http://localhost/s/ABCD2345",
    expiresAt: "2030-01-01T01:00:00.000Z",
    maxViews: null,
    passwordProtected: false,
    owned: false,
    manageToken: "manage-token",
};

const single = (i: number) => ({
    fileId: `f${i}`,
    multipart: null,
    method: "PUT",
    url: `http://storage.example/bucket/shares/s/f${i}?X-Amz-Signature=sig${i}`,
    headers: { "Content-Type": "text/plain" },
});
const inParts = (i: number, partSize: number, partCount: number) => ({ fileId: `f${i}`, multipart: { partSize, partCount } });

const created = (uploads: unknown[]) => ({
    ...share,
    fileCount: uploads.length,
    status: "uploading",
    uploadExpiresAt: "2030-01-01T01:00:00.000Z",
    uploads,
});
const completed = [200, { ...share, fileCount: 1, status: "ready", manageToken: undefined }] as [number, unknown];

// Signs whatever parts are asked for.
const signParts = (fileId: string) => (request: { body: unknown }) => {
    const { partNumbers } = request.body as { partNumbers: number[] };
    return [
        200,
        {
            parts: partNumbers.map((n) => ({ partNumber: n, method: "PUT", url: `http://storage.example/${fileId}?partNumber=${n}`, headers: {} })),
            uploadExpiresAt: "2030-01-01T01:00:00.000Z",
        },
    ] as [number, unknown];
};

const partOf = (url: string) => Number(new URL(url).searchParams.get("partNumber"));

const defaults = { ...uploadSettings, retryDelaysMs: [...uploadSettings.retryDelaysMs] };

beforeEach(() => {
    FakeXHR.reset();
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    Object.assign(uploadSettings, defaults, { retryDelaysMs: [5, 5, 5] });
});

test("a text-only share is created in one request", async () => {
    const { calls } = mockApi({ "POST /api/shares": [201, { ...created([]), status: "ready", uploadExpiresAt: null }] });
    const result = await createShare(input([], { text: "hello", maxViews: 5, password: "pw12" }));
    expect(result.code).toBe("ABCD2345");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ text: "hello", expiresIn: "24h", maxViews: 5, password: "pw12", files: [] });
    expect(FakeXHR.sent).toHaveLength(0);
});

test("small files go straight to their signed URLs, then the share is completed", async () => {
    const { calls } = mockApi({
        "POST /api/shares": [201, created([single(0), single(1)])],
        "POST /api/shares/ABCD2345/complete": completed,
    });
    const progress: number[] = [];
    const pending: PendingUpload[] = [];
    const files = [file("a.txt", 100), file("b.txt", 300)];

    const result = await createShare(input(files), {
        onProgress: (p) => progress.push(p.loaded / p.total),
        onPending: (p) => pending.push(p),
    });

    expect(calls[0].body).toMatchObject({ files: [{ name: "a.txt", size: 100, type: "text/plain" }, { name: "b.txt", size: 300 }] });
    expect(FakeXHR.sent.map((s) => [s.method, s.url, s.headers["Content-Type"], s.body.size])).toEqual([
        ["PUT", single(0).url, "text/plain", 100],
        ["PUT", single(1).url, "text/plain", 300],
    ]);
    expect(calls.at(-1)).toMatchObject({ path: "/api/shares/ABCD2345/complete", body: { manageToken: "manage-token" } });
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b)); // only ever goes up
    expect(result.manageToken).toBe("manage-token");
    // Enough to resume after a reload.
    expect(pending).toEqual([
        {
            code: "ABCD2345",
            manageToken: "manage-token",
            owned: false,
            startedAt: expect.any(String),
            uploadExpiresAt: "2030-01-01T01:00:00.000Z",
            files: [
                { name: "a.txt", size: 100, type: "text/plain", lastModified: 1700000000000 },
                { name: "b.txt", size: 300, type: "text/plain", lastModified: 1700000000000 },
            ],
        },
    ]);
});

test("a big file goes up in parts: each slice to its own URL, fetched in batches", async () => {
    uploadSettings.partBatch = 3;
    const { calls } = mockApi({
        "POST /api/shares": [201, created([inParts(0, 10, 4)])],
        "POST /api/shares/ABCD2345/uploads/f0/parts": signParts("f0"),
        "POST /api/shares/ABCD2345/complete": completed,
    });
    const big = file("big.txt", 35);
    await createShare(input([big]));

    const bodies = await FakeXHR.bodies();
    const byPart = Object.fromEntries(FakeXHR.sent.map((s, i) => [partOf(s.url), bodies[i]]));
    expect(byPart).toEqual({ 1: content(35).slice(0, 10), 2: content(35).slice(10, 20), 3: content(35).slice(20, 30), 4: content(35).slice(30) });
    const partRequests = calls.filter((c) => c.path.endsWith("/parts")).map((c) => (c.body as { partNumbers: number[] }).partNumbers);
    expect(partRequests).toEqual([[1, 2, 3], [4]]);
    expect(calls.at(-1)?.path).toBe("/api/shares/ABCD2345/complete");
});

test("failed requests are retried; a 403 (expired URL) gets a freshly signed one", async () => {
    const { calls } = mockApi({
        "POST /api/shares": [201, created([inParts(0, 10, 2)])],
        "POST /api/shares/ABCD2345/uploads/f0/parts": signParts("f0"),
        "POST /api/shares/ABCD2345/complete": completed,
    });
    const tries = new Map<number, number>();
    FakeXHR.respond = (request) => {
        const part = partOf(request.url);
        const n = (tries.get(part) ?? 0) + 1;
        tries.set(part, n);
        if (part === 1 && n <= 2) return n === 1 ? "error" : 503;
        if (part === 2 && n === 1) return 403;
        return 200;
    };
    const states: UploadProgress["state"][] = [];
    await createShare(input([file("big.txt", 20)]), { onProgress: (p) => states.push(p.state) });

    expect(tries).toEqual(new Map([[1, 3], [2, 2]]));
    expect(states).toContain("retrying");
    expect(states.at(-1)).toBe("uploading");
    // Part 2's URL was signed again after the 403.
    const partRequests = calls.filter((c) => c.path.endsWith("/parts")).map((c) => (c.body as { partNumbers: number[] }).partNumbers);
    expect(partRequests).toEqual([[1, 2], [2]]);
});

test("when retries don't help, the upload stops, can be resumed, and isn't thrown away", async () => {
    const { calls } = mockApi({
        "POST /api/shares": [201, created([single(0), single(1)])],
        "POST /api/shares/ABCD2345/cancel": [204],
    });
    FakeXHR.respond = (request) => (request.url.includes("f1") ? 500 : 200);

    const failure = await createShare(input([file("a.txt", 10), file("b.txt", 10)])).catch((err) => err);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.message).toBe('Uploading "b.txt" failed (500).');
    expect(isResumable(failure)).toBe(true);
    expect(FakeXHR.sent.filter((s) => s.url.includes("f1"))).toHaveLength(4); // 1 try + 3 retries
    expect(calls.map((c) => c.path)).not.toContain("/api/shares/ABCD2345/cancel");
    expect(calls.map((c) => c.path)).not.toContain("/api/shares/ABCD2345/complete");
});

test("while offline, the upload waits for the connection instead of using up retries", async () => {
    mockApi({ "POST /api/shares": [201, created([single(0)])], "POST /api/shares/ABCD2345/complete": completed });
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    let attempts = 0;
    FakeXHR.respond = () => (++attempts <= 4 ? "error" : 200);
    const states: UploadProgress["state"][] = [];

    const done = createShare(input([file("a.txt", 10)]), { onProgress: (p) => states.push(p.state) });
    await vi.waitFor(() => expect(states).toContain("offline"));
    expect(attempts).toBe(1);

    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    // 3 more failures, then success on the 5th try: within the 3 retries only
    // because the failure while offline didn't count.
    await expect(done).resolves.toMatchObject({ code: "ABCD2345" });
    expect(attempts).toBe(5);
    online.mockRestore();
});

test("aborting stops every upload; the share is left to be resumed or discarded", async () => {
    const { calls } = mockApi({ "POST /api/shares": [201, created([single(0), single(1)])] });
    FakeXHR.respond = () => "hold";
    const controller = new AbortController();
    const pending = createShare(input([file("a.txt", 10), file("b.txt", 10)]), { signal: controller.signal });
    await vi.waitFor(() => expect(FakeXHR.sent).toHaveLength(2));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXHR.aborted).toBe(2);
    expect(calls.map((c) => c.path)).toEqual(["/api/shares"]);
});

test("the server's verdict on completion (e.g. an executable) is passed on", async () => {
    mockApi({
        "POST /api/shares": [201, created([single(0)])],
        "POST /api/shares/ABCD2345/complete": [422, { error: '"setup.pdf" is a program (executable). Executable files can\'t be shared.' }],
    });
    const failure = await createShare(input([file("setup.pdf", 10)])).catch((err) => err);
    expect(failure.message).toMatch(/is a program/);
    expect(isResumable(failure)).toBe(false);
});

test("completing is retried too, including after going offline", async () => {
    let tries = 0;
    mockApi({
        "POST /api/shares": [201, created([single(0)])],
        "POST /api/shares/ABCD2345/complete": () => (++tries === 1 ? [502, { error: "Bad gateway" }] : completed),
    });
    const states: UploadProgress["state"][] = [];
    await createShare(input([file("a.txt", 10)]), { onProgress: (p) => states.push(p.state) });
    expect(tries).toBe(2);
    expect(states).toContain("retrying");
});

describe("resuming", () => {
    const pending: PendingUpload = {
        code: "ABCD2345",
        manageToken: "manage-token",
        owned: false,
        startedAt: "2030-01-01T00:00:00.000Z",
        uploadExpiresAt: "2030-01-01T01:00:00.000Z",
        files: [
            { name: "small.txt", size: 10, type: "text/plain", lastModified: 1700000000000 },
            { name: "notes.txt", size: 10, type: "text/plain", lastModified: 1700000000000 },
            { name: "big.txt", size: 35, type: "text/plain", lastModified: 1700000000000 },
        ],
    };

    test("only what the server doesn't have yet is sent", async () => {
        const { calls } = mockApi({
            "POST /api/shares/ABCD2345/resume": [
                200,
                {
                    code: "ABCD2345",
                    status: "uploading",
                    uploadExpiresAt: "2030-01-01T02:00:00.000Z",
                    files: [
                        { fileId: "f0", name: "small.txt", size: 10, uploaded: true, multipart: null },
                        { ...single(1), name: "notes.txt", size: 10, uploaded: false },
                        { fileId: "f2", name: "big.txt", size: 35, uploaded: false, multipart: { partSize: 10, partCount: 4, uploadedParts: [1, 3] } },
                    ],
                },
            ],
            "POST /api/shares/ABCD2345/uploads/f2/parts": signParts("f2"),
            "POST /api/shares/ABCD2345/complete": completed,
        });
        const progress: UploadProgress[] = [];
        const saved: PendingUpload[] = [];
        const files = [file("small.txt", 10), file("notes.txt", 10), file("big.txt", 35)];

        await resumeUpload(pending, files, { onProgress: (p) => progress.push(p), onPending: (p) => saved.push(p) });

        expect(FakeXHR.sent.map((s) => (s.url.includes("partNumber") ? `part ${partOf(s.url)}` : s.url))).toEqual(
            expect.arrayContaining([single(1).url, "part 2", "part 4"])
        );
        expect(FakeXHR.sent).toHaveLength(3);
        // Starts from what's already there: small.txt and parts 1 and 3.
        expect(progress[0]).toMatchObject({ loaded: 30, total: 55 });
        expect(progress.at(-1)).toMatchObject({ loaded: 55, total: 55 });
        expect(saved[0].uploadExpiresAt).toBe("2030-01-01T02:00:00.000Z");
        expect(calls.at(-1)?.path).toBe("/api/shares/ABCD2345/complete");
    });

    test("the same files are recognized by name, size and modification time", () => {
        const files = [file("big.txt", 35), file("notes.txt", 10), file("small.txt", 10), file("other.txt", 3)];
        const match = matchFiles(pending, files);
        expect("files" in match && match.files.map((f) => f.name)).toEqual(["small.txt", "notes.txt", "big.txt"]);

        const edited = new File([content(35)], "big.txt", { lastModified: 1800000000000 });
        expect(matchFiles(pending, [files[1], files[2], edited])).toEqual({ missing: ["big.txt"] });
    });
});
