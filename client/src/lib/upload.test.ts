import { createShare } from "./upload";
import { mockApi } from "@/test/utils";

// Records uploads instead of sending them. `statusFor(url)` decides each
// upload's outcome; progress is reported in two halves.
class FakeXHR {
    static sent: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
    static statusFor: (url: string) => number = () => 200;
    static aborted = 0;
    // When set, uploads never finish (until aborted).
    static hold = false;

    upload: { onprogress: ((e: { loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    private method = "";
    private url = "";
    private headers: Record<string, string> = {};
    private done = false;

    open(method: string, url: string) {
        this.method = method;
        this.url = url;
    }
    setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
    }
    send(body: File) {
        FakeXHR.sent.push({ method: this.method, url: this.url, headers: this.headers, body });
        if (FakeXHR.hold) return;
        setTimeout(() => {
            if (this.done) return;
            this.upload.onprogress?.({ loaded: body.size / 2, total: body.size });
            this.upload.onprogress?.({ loaded: body.size, total: body.size });
            this.status = FakeXHR.statusFor(this.url);
            this.done = true;
            this.onload?.();
        }, 5);
    }
    abort() {
        if (this.done) return;
        this.done = true;
        FakeXHR.aborted++;
        this.onabort?.();
    }
}

const file = (name: string, size: number, type = "text/plain") => new File(["x".repeat(size)], name, { type });

const input = (files: File[], overrides = {}) => ({
    text: "",
    expiresIn: "24h",
    maxViews: null,
    password: "",
    files,
    ...overrides,
});

const uploadingResponse = (count: number) => ({
    code: "ABCD2345",
    url: "http://localhost/s/ABCD2345",
    expiresAt: "2026-01-01T01:00:00.000Z",
    maxViews: null,
    passwordProtected: false,
    fileCount: count,
    owned: false,
    manageToken: "manage-token",
    status: "uploading",
    uploadExpiresAt: "2026-01-01T01:00:00.000Z",
    uploads: Array.from({ length: count }, (_, i) => ({
        fileId: `f${i}`,
        method: "PUT",
        url: `http://storage.example/bucket/shares/s/f${i}?X-Amz-Signature=sig${i}`,
        headers: { "Content-Type": "text/plain" },
    })),
});

beforeEach(() => {
    FakeXHR.sent = [];
    FakeXHR.statusFor = () => 200;
    FakeXHR.aborted = 0;
    FakeXHR.hold = false;
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

test("a text-only share is created in one request", async () => {
    const { calls } = mockApi({
        "POST /api/shares": [201, { ...uploadingResponse(0), status: "ready", uploads: [], uploadExpiresAt: null }],
    });
    const share = await createShare(input([], { text: "hello", maxViews: 5, password: "pw12" }));
    expect(share.code).toBe("ABCD2345");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ text: "hello", expiresIn: "24h", maxViews: 5, password: "pw12", files: [] });
    expect(FakeXHR.sent).toHaveLength(0);
});

test("files go straight to their signed URLs, then the share is completed", async () => {
    const { calls } = mockApi({
        "POST /api/shares": [201, uploadingResponse(2)],
        "POST /api/shares/ABCD2345/complete": [200, { ...uploadingResponse(2), status: "ready", manageToken: undefined }],
    });
    const progress: number[] = [];
    const files = [file("a.txt", 100), file("b.txt", 300)];

    const share = await createShare(input(files), { onProgress: (loaded, total) => progress.push(loaded / total) });

    expect(calls[0].body).toMatchObject({
        files: [
            { name: "a.txt", size: 100, type: "text/plain" },
            { name: "b.txt", size: 300, type: "text/plain" },
        ],
    });
    expect(FakeXHR.sent.map((s) => [s.method, s.url, s.headers["Content-Type"], s.body])).toEqual([
        ["PUT", uploadingResponse(2).uploads[0].url, "text/plain", files[0]],
        ["PUT", uploadingResponse(2).uploads[1].url, "text/plain", files[1]],
    ]);
    expect(calls[1]).toMatchObject({ path: "/api/shares/ABCD2345/complete", body: { manageToken: "manage-token" } });
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b)); // only ever goes up
    // The manage token is kept, for watching the share live.
    expect(share.manageToken).toBe("manage-token");
});

test("a failed upload cancels the share and names the file", async () => {
    const { calls } = mockApi({
        "POST /api/shares": [201, uploadingResponse(2)],
        "POST /api/shares/ABCD2345/cancel": [204],
    });
    FakeXHR.statusFor = (url) => (url.includes("f1") ? 403 : 200);

    await expect(createShare(input([file("a.txt", 10), file("b.txt", 10)]))).rejects.toThrow('Uploading "b.txt" failed (403)');
    await vi.waitFor(() => expect(calls.map((c) => c.path)).toContain("/api/shares/ABCD2345/cancel"));
    expect(calls.some((c) => c.path.endsWith("/complete"))).toBe(false);
});

test("the server's verdict on completion (e.g. an executable) is passed on", async () => {
    const { calls } = mockApi({
        "POST /api/shares": [201, uploadingResponse(1)],
        "POST /api/shares/ABCD2345/complete": [422, { error: '"setup.pdf" is a program (executable). Executable files can\'t be shared.' }],
    });
    await expect(createShare(input([file("setup.pdf", 10)]))).rejects.toThrow(/is a program/);
    // The server already deleted it, so there's nothing to cancel.
    expect(calls.map((c) => c.path)).not.toContain("/api/shares/ABCD2345/cancel");
});

test("cancelling aborts the uploads and the share", async () => {
    const { calls } = mockApi({
        "POST /api/shares": [201, uploadingResponse(1)],
        "POST /api/shares/ABCD2345/cancel": [204],
    });
    FakeXHR.hold = true;
    const controller = new AbortController();
    const pending = createShare(input([file("a.txt", 10)]), { signal: controller.signal });
    await vi.waitFor(() => expect(FakeXHR.sent).toHaveLength(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXHR.aborted).toBe(1);
    await vi.waitFor(() => expect(calls.map((c) => c.path)).toContain("/api/shares/ABCD2345/cancel"));
});
