import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appSocket } from "@/test/fakeSocket";
import { guestSession, inHours, mockApi, renderApp, testConfig, testUser } from "@/test/utils";
import { getSocket } from "@/lib/realtime";
import { createShare } from "@/lib/upload";
import type { CreatedShare, OwnedShare } from "@/lib/types";

// Uploading is covered elsewhere; here the share comes back as the server
// left it after the upload: being scanned for malware.
vi.mock("@/lib/upload", () => ({ createShare: vi.fn() }));

const scanningShare: CreatedShare = {
    code: "ABCD2345",
    url: "http://localhost/s/ABCD2345",
    expiresAt: inHours(24),
    maxViews: null,
    passwordProtected: false,
    fileCount: 1,
    owned: false,
    manageToken: "manage-token",
    status: "processing",
};

const send = async () => {
    mockApi({ "GET /api/auth/me": guestSession, "GET /api/config": [200, testConfig] });
    vi.mocked(createShare).mockResolvedValue(scanningShare);
    const user = userEvent.setup();
    renderApp("/");
    await user.type(await screen.findByLabelText(/^Message/), "see attached");
    await user.click(screen.getByRole("button", { name: "Create share" }));
};

beforeEach(() => {
    getSocket();
    appSocket().reset();
});

test("the code is shown while the files are scanned; the share turns ready when the scan passes", async () => {
    await send();
    expect(await screen.findByRole("heading", { name: "Checking your files…" })).toBeInTheDocument();
    expect(screen.getByTestId("share-code")).toHaveTextContent("ABCD-2345");

    act(() => appSocket().fire("share:ready", { code: "ABCD2345", at: new Date().toISOString() }));
    expect(await screen.findByRole("heading", { name: "Your share is ready" })).toBeInTheDocument();
});

test("a file with malware blocks the share: the code is withdrawn and the sender told why", async () => {
    await send();
    await screen.findByRole("heading", { name: "Checking your files…" });

    act(() => {
        appSocket().fire("share:blocked", { code: "ABCD2345", fileName: "invoice.pdf", signature: "Eicar-Test-Signature", at: new Date().toISOString() });
        appSocket().fire("share:ended", { code: "ABCD2345", reason: "malware", at: new Date().toISOString() });
    });
    expect(await screen.findByRole("heading", { name: "Share blocked" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent('"invoice.pdf" contains malware (Eicar-Test-Signature)');
    expect(screen.queryByTestId("share-code")).not.toBeInTheDocument();
});

test("a scan that finished before the page started watching isn't missed", async () => {
    appSocket().replies.set("share:watch", { ok: true, share: { status: "ready", endedReason: null } });
    await send();
    expect(await screen.findByRole("heading", { name: "Your share is ready" })).toBeInTheDocument();
});

test("events about other shares don't change the result", async () => {
    await send();
    await screen.findByRole("heading", { name: "Checking your files…" });
    act(() => appSocket().fire("share:blocked", { code: "OTHER234", fileName: "x.exe", signature: "Bad", at: new Date().toISOString() }));
    expect(screen.getByRole("heading", { name: "Checking your files…" })).toBeInTheDocument();
});

test("My shares marks shares being scanned and shares blocked for malware", async () => {
    const base: OwnedShare = {
        code: "SCAN2345",
        url: "http://localhost/s/SCAN2345",
        status: "active",
        endedReason: null,
        hasText: false,
        textPreview: null,
        files: [{ id: "f1", name: "photo.png", size: 10, mimeType: "image/png", downloads: 0, scanStatus: "pending" }],
        processing: true,
        totalSize: 10,
        passwordProtected: false,
        maxViews: null,
        viewsRemaining: null,
        views: 0,
        createdAt: inHours(-1),
        expiresAt: inHours(23),
        endedAt: null,
    };
    const blocked: OwnedShare = { ...base, code: "BLOK2345", status: "expired", endedReason: "malware", processing: false, endedAt: inHours(0) };
    mockApi({
        "GET /api/auth/me": [200, { user: testUser }],
        "GET /api/auth/realtime-token": [200, { token: "t" }],
        "GET /api/me/shares": [200, { status: "active", page: 1, hasMore: false, shares: [base, blocked], counts: { active: 1, expired: 1, deleted: 0 } }],
    });
    renderApp("/shares");
    const scanning = await screen.findByRole("article", { name: "Share SCAN-2345" });
    expect(within(scanning).getByText("Scanning…")).toBeInTheDocument();
    const malware = screen.getByRole("article", { name: "Share BLOK-2345" });
    expect(within(malware).getByText("Blocked: malware")).toBeInTheDocument();
});
