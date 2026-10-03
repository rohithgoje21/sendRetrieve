import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { guestSession, mockApi, renderApp, testConfig } from "@/test/utils";
import { FakeXHR } from "@/test/fakeXhr";
import { uploadSettings, type PendingUpload } from "@/lib/upload";

const KEY = "sendretrieve:pending-upload";
const MODIFIED = 1700000000000;
const report = () => new File(["quarterly numbers"], "report.txt", { type: "text/plain", lastModified: MODIFIED });

const share = {
    code: "ABCD2345",
    url: "http://localhost/s/ABCD2345",
    expiresAt: "2030-01-01T01:00:00.000Z",
    maxViews: null,
    passwordProtected: false,
    fileCount: 1,
    owned: false,
    manageToken: "manage-token",
};
const upload = { fileId: "f0", multipart: null, method: "PUT", url: "http://storage.example/f0?sig=1", headers: { "Content-Type": "text/plain" } };
const created = { ...share, status: "uploading", uploadExpiresAt: "2030-01-01T01:00:00.000Z", uploads: [upload] };
const resumed = (uploaded: boolean) => ({
    code: "ABCD2345",
    status: "uploading",
    uploadExpiresAt: "2030-01-01T02:00:00.000Z",
    files: [{ ...upload, name: "report.txt", size: 17, uploaded }],
});
const completed = { ...share, status: "ready", manageToken: undefined };

const saved = (): PendingUpload | null => JSON.parse(localStorage.getItem(KEY) ?? "null");

const retryDelays = uploadSettings.retryDelaysMs;

beforeEach(() => {
    localStorage.clear();
    FakeXHR.reset();
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    uploadSettings.retryDelaysMs = [5, 5, 5];
});

afterEach(() => {
    uploadSettings.retryDelaysMs = retryDelays;
});

const startSending = async () => {
    const user = userEvent.setup();
    renderApp("/");
    await user.upload(await screen.findByLabelText("Choose files"), report());
    await user.click(screen.getByRole("button", { name: "Create share" }));
    return user;
};

test("an upload can be paused and resumed; it's remembered meanwhile", async () => {
    const { calls } = mockApi({
        "GET /api/auth/me": guestSession,
        "GET /api/config": [200, testConfig],
        "POST /api/shares": [201, created],
        "POST /api/shares/ABCD2345/resume": [200, resumed(false)],
        "POST /api/shares/ABCD2345/complete": [200, completed],
    });
    FakeXHR.respond = () => "hold";
    const user = await startSending();

    await user.click(await screen.findByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Paused at 0%");
    expect(saved()).toMatchObject({ code: "ABCD2345", manageToken: "manage-token", files: [{ name: "report.txt", size: 17 }] });
    // The form belongs to this share now.
    expect(screen.getByLabelText(/^Message/)).toBeDisabled();

    FakeXHR.respond = () => 200;
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByRole("heading", { name: "Your share is ready" })).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toContain("/api/shares/ABCD2345/resume");
    expect(saved()).toBeNull();
});

test("an upload that keeps failing stops without losing progress; cancel throws it away", async () => {
    const { calls } = mockApi({
        "GET /api/auth/me": guestSession,
        "GET /api/config": [200, testConfig],
        "POST /api/shares": [201, created],
        "POST /api/shares/ABCD2345/cancel": [204],
    });
    FakeXHR.respond = () => 503;
    const user = await startSending();

    // (after its retries)
    expect(await screen.findByText(/What's uploaded so far is kept/)).toHaveTextContent(
        'Uploading "report.txt" failed (503).'
    );
    expect(screen.getByRole("status")).toHaveTextContent("Upload stopped");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls.map((c) => c.path)).toContain("/api/shares/ABCD2345/cancel"));
    expect(screen.getByRole("button", { name: "Create share" })).toBeInTheDocument();
    expect(saved()).toBeNull();
});

describe("coming back to an unfinished upload", () => {
    const pending: PendingUpload = {
        code: "ABCD2345",
        manageToken: "manage-token",
        owned: false,
        startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        uploadExpiresAt: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
        files: [{ name: "report.txt", size: 17, type: "text/plain", lastModified: MODIFIED }],
    };

    beforeEach(() => localStorage.setItem(KEY, JSON.stringify(pending)));

    test("asks for the same files, refuses others, and finishes the upload", async () => {
        const { calls } = mockApi({
            "GET /api/auth/me": guestSession,
            "GET /api/config": [200, testConfig],
            "POST /api/shares/ABCD2345/resume": [200, resumed(false)],
            "POST /api/shares/ABCD2345/complete": [200, completed],
        });
        const user = userEvent.setup();
        renderApp("/");

        expect(await screen.findByRole("heading", { name: "Finish your upload" })).toBeInTheDocument();
        expect(screen.getByText(/Share ABCD-2345 · started 10 minutes ago/)).toBeInTheDocument();
        expect(screen.getByRole("list", { name: "Files in this upload" })).toHaveTextContent("report.txt");

        const picker = screen.getByLabelText("Choose the same files");
        await user.upload(picker, new File(["something else"], "other.txt", { lastModified: MODIFIED }));
        expect(screen.getByRole("alert")).toHaveTextContent("Choose the same files you started with. Missing: report.txt.");
        expect(calls.map((c) => c.path)).not.toContain("/api/shares/ABCD2345/resume");

        await user.upload(picker, report());
        expect(await screen.findByRole("heading", { name: "Your share is ready" })).toBeInTheDocument();
        expect(FakeXHR.sent.map((s) => s.url)).toEqual([upload.url]);
        expect(saved()).toBeNull();
    });

    test("files already uploaded aren't sent again", async () => {
        mockApi({
            "GET /api/auth/me": guestSession,
            "GET /api/config": [200, testConfig],
            "POST /api/shares/ABCD2345/resume": [200, resumed(true)],
            "POST /api/shares/ABCD2345/complete": [200, completed],
        });
        const user = userEvent.setup();
        renderApp("/");
        await user.upload(await screen.findByLabelText("Choose the same files"), report());
        expect(await screen.findByRole("heading", { name: "Your share is ready" })).toBeInTheDocument();
        expect(FakeXHR.sent).toHaveLength(0);
    });

    test("can be discarded instead", async () => {
        const { calls } = mockApi({
            "GET /api/auth/me": guestSession,
            "GET /api/config": [200, testConfig],
            "POST /api/shares/ABCD2345/cancel": [204],
        });
        const user = userEvent.setup();
        renderApp("/");
        await user.click(await screen.findByRole("button", { name: "Discard" }));
        expect(await screen.findByRole("button", { name: "Create share" })).toBeInTheDocument();
        await waitFor(() => expect(calls.map((c) => c.path)).toContain("/api/shares/ABCD2345/cancel"));
        expect(saved()).toBeNull();
    });

    test("an upload the server no longer has leads back to the form", async () => {
        mockApi({
            "GET /api/auth/me": guestSession,
            "GET /api/config": [200, testConfig],
            "POST /api/shares/ABCD2345/resume": [404, { error: "This upload has expired or was already completed." }],
        });
        const user = userEvent.setup();
        renderApp("/");
        await user.upload(await screen.findByLabelText("Choose the same files"), report());
        expect(await screen.findByRole("button", { name: "Create share" })).toBeInTheDocument();
        expect(saved()).toBeNull();
    });

    test("an upload past its deadline is forgotten", async () => {
        localStorage.setItem(KEY, JSON.stringify({ ...pending, uploadExpiresAt: new Date(Date.now() - 1000).toISOString() }));
        mockApi({ "GET /api/auth/me": guestSession, "GET /api/config": [200, testConfig] });
        renderApp("/");
        expect(await screen.findByRole("button", { name: "Create share" })).toBeInTheDocument();
        expect(saved()).toBeNull();
    });
});
