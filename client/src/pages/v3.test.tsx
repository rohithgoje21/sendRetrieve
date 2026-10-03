import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appSocket } from "@/test/fakeSocket";
import { guestSession, inHours, mockApi, renderApp, testConfig, testUser } from "@/test/utils";
import type { AdminStats, AdminUser } from "@/lib/types";

const readyShare = {
    code: "ABCD2345",
    url: "http://localhost/s/ABCD2345",
    expiresAt: inHours(24),
    maxViews: 5,
    passwordProtected: false,
    fileCount: 0,
    owned: false,
    manageToken: "manage-token",
    status: "ready",
    uploads: [],
    uploadExpiresAt: null,
};

describe("after sending", () => {
    test("shows a QR code and live activity, even to guests", async () => {
        mockApi({
            "GET /api/auth/me": guestSession,
            "GET /api/config": [200, testConfig],
            "POST /api/shares": [201, readyShare],
        });
        const user = userEvent.setup();
        renderApp("/");

        await user.type(await screen.findByLabelText(/^Message/), "hello");
        await user.click(screen.getByRole("button", { name: "Create share" }));
        expect(await screen.findByTestId("share-code")).toHaveTextContent("ABCD-2345");

        // QR code in a dialog
        await user.click(screen.getByRole("button", { name: "QR code" }));
        const dialog = await screen.findByRole("dialog", { name: "Share ABCD-2345" });
        expect(await within(dialog).findByRole("img", { name: /QR code for share ABCD-2345/ })).toHaveAttribute(
            "src",
            expect.stringMatching(/^data:image\/png/)
        );
        await user.click(within(dialog).getByRole("button", { name: "Close" }));

        // Watching the share with its manage token...
        const socket = appSocket();
        expect(socket.emitted).toContainEqual({ event: "share:watch", payload: { code: "ABCD2345", manageToken: "manage-token" } });
        const activity = screen.getByRole("region", { name: "Live activity" });
        expect(within(activity).getByText(/Nothing yet/)).toBeInTheDocument();
        expect(within(activity).getByText("Watching")).toBeInTheDocument();

        // ...so opens and downloads appear as they happen.
        act(() => socket.fire("share:opened", { code: "ABCD2345", views: 1, maxViews: 5, viewsRemaining: 4, at: new Date().toISOString() }));
        expect(await within(activity).findByText("Someone opened the share")).toBeInTheDocument();
        expect(within(activity).getByText(/1 of 5 views/)).toBeInTheDocument();
        act(() => socket.fire("file:downloaded", { code: "ABCD2345", fileId: "f", fileName: "notes.txt", downloads: 1, at: new Date().toISOString() }));
        expect(await within(activity).findByText('"notes.txt" was downloaded')).toBeInTheDocument();
        // Events about other shares are ignored.
        act(() => socket.fire("share:opened", { code: "OTHER234", views: 9, maxViews: null, viewsRemaining: null, at: new Date().toISOString() }));
        expect(within(activity).queryByText(/9 so far/)).not.toBeInTheDocument();
    });
});

describe("signed-in users", () => {
    test("get a toast when one of their shares is opened, and the connection carries their token", async () => {
        mockApi({
            "GET /api/auth/me": [200, { user: testUser }],
            "GET /api/config": [200, testConfig],
            "GET /api/auth/realtime-token": [200, { token: "rt-token", expiresInSeconds: 120 }],
        });
        renderApp("/");
        await screen.findByRole("button", { name: "Account menu" });

        const socket = appSocket();
        await vi.waitFor(() => expect(socket.connected).toBe(true));
        expect(socket.lastAuth).toEqual({ token: "rt-token" });

        act(() => socket.fire("share:opened", { code: "WXYZ2345", views: 2, maxViews: null, viewsRemaining: null, at: new Date().toISOString() }));
        expect(await screen.findByText("Share WXYZ-2345 was just opened")).toBeInTheDocument();
        expect(screen.getByText("2 views so far")).toBeInTheDocument();
    });

    test("unverified users see a banner pointing to email verification", async () => {
        mockApi({
            "GET /api/auth/me": [200, { user: { ...testUser, emailVerified: false } }],
            "GET /api/config": [200, testConfig],
            "GET /api/auth/realtime-token": [200, { token: "t" }],
        });
        renderApp("/");
        expect(await screen.findByText(/Please verify your email address/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Verify now" })).toHaveAttribute("href", "/verify-email?next=%2F");
    });
});

describe("email verification", () => {
    test("sign-up continues to email verification, not straight into the app", async () => {
        mockApi({
            "GET /api/auth/me": guestSession,
            "POST /api/auth/register": [201, { user: { ...testUser, emailVerified: false } }],
            "GET /api/auth/realtime-token": [200, { token: "t" }],
        });
        const user = userEvent.setup();
        const { router } = renderApp("/signup?next=/account");
        await user.type(await screen.findByLabelText("Name"), "Ada");
        await user.type(screen.getByLabelText("Email"), "ada@example.com");
        await user.type(screen.getByLabelText("Password"), "correct-horse");
        await user.click(screen.getByRole("button", { name: "Create account" }));

        expect(await screen.findByLabelText("Verification code")).toBeInTheDocument();
        expect(router.state.location.pathname).toBe("/verify-email");
        expect(router.state.location.search).toBe("?new=1&next=%2Faccount");
    });


    test("enter the code to verify; wrong codes show the server's message", async () => {
        const { calls } = mockApi({
            "GET /api/auth/me": [200, { user: { ...testUser, emailVerified: false } }],
            "GET /api/auth/realtime-token": [200, { token: "t" }],
            "POST /api/auth/verify-email": ({ body }) =>
                (body as { code: string }).code === "123456"
                    ? [200, { user: testUser }]
                    : [400, { error: "That code isn't right. 4 tries left.", field: "code" }],
            "GET /api/me/shares": [200, { status: "active", page: 1, hasMore: false, shares: [], counts: { active: 0, expired: 0, deleted: 0 } }],
        });
        const user = userEvent.setup();
        const { router } = renderApp("/verify-email?new=1&next=/shares");

        const input = await screen.findByLabelText("Verification code");
        expect(screen.getByText(testUser.email)).toBeInTheDocument();
        // Just signed up: a code was sent, so resending waits a minute.
        expect(screen.getByRole("button", { name: /Send a new code in \d+s/ })).toBeDisabled();

        await user.type(input, "12a345x6"); // only digits are kept
        expect(input).toHaveValue("123456");
        await user.clear(input);
        await user.type(input, "999999");
        await user.click(screen.getByRole("button", { name: "Verify email" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("4 tries left");

        await user.clear(input);
        await user.type(input, "123456");
        await user.click(screen.getByRole("button", { name: "Verify email" }));
        await vi.waitFor(() => expect(router.state.location.pathname).toBe("/shares"));
        expect(calls.filter((c) => c.path === "/api/auth/verify-email").map((c) => c.body)).toEqual([{ code: "999999" }, { code: "123456" }]);
    });

    test("already verified users are sent on their way", async () => {
        mockApi({
            "GET /api/auth/me": [200, { user: testUser }],
            "GET /api/auth/realtime-token": [200, { token: "t" }],
            "GET /api/config": [200, testConfig],
        });
        const { router } = renderApp("/verify-email?next=/");
        await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    });
});

describe("admin", () => {
    const stats: AdminStats = {
        users: { total: 12, verified: 9, disabled: 1, admins: 2, newThisWeek: 3 },
        shares: { active: 7, uploading: 1, createdToday: 4 },
        storage: { bytes: 5 * 1024 * 1024, files: 6 },
        activity: { views: 40, downloads: 15 },
    };
    const grace: AdminUser = { id: "u2", email: "grace@example.com", name: "Grace", role: "user", emailVerified: true, createdAt: inHours(-48), disabled: false, activeShares: 3 };
    const admin = { ...testUser, role: "admin" as const };

    test("regular users can't see the admin page", async () => {
        mockApi({ "GET /api/auth/me": [200, { user: testUser }], "GET /api/auth/realtime-token": [200, { token: "t" }] });
        renderApp("/admin");
        expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument();
    });

    test("shows stats and lets an admin disable a user after confirming", async () => {
        const { calls } = mockApi({
            "GET /api/auth/me": [200, { user: admin }],
            "GET /api/auth/realtime-token": [200, { token: "t" }],
            "GET /api/admin/stats": [200, stats],
            "GET /api/admin/users": [200, { page: 1, total: 2, hasMore: false, users: [{ ...admin, disabled: false, activeShares: 0 }, grace] }],
            "PATCH /api/admin/users/u2": [200, { user: { ...grace, disabled: true } }],
        });
        const user = userEvent.setup();
        renderApp("/admin");

        expect(await screen.findByText("5.0 MB")).toBeInTheDocument();
        expect(screen.getByText("3 new this week · 9 verified")).toBeInTheDocument();

        const row = (await screen.findByText("grace@example.com")).closest("li")!;
        expect(within(row).getByText("3 active shares")).toBeInTheDocument();
        expect(screen.getByText("0 active shares")).toBeInTheDocument();
        // Admins can't act on their own account.
        const myRow = screen.getByText("You").closest("li")!;
        expect(within(myRow).queryByRole("button")).not.toBeInTheDocument();

        await user.click(within(row).getByRole("button", { name: "Disable" }));
        const dialog = await screen.findByRole("dialog", { name: "Disable grace@example.com?" });
        await user.click(within(dialog).getByRole("button", { name: "Disable account" }));
        await vi.waitFor(() =>
            expect(calls).toContainEqual(expect.objectContaining({ method: "PATCH", path: "/api/admin/users/u2", body: { disabled: true } }))
        );
    });
});
