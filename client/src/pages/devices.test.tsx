import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { inHours, mockApi, renderApp, testUser } from "@/test/utils";
import { ADMIN_PERMISSIONS, SUPERADMIN_PERMISSIONS } from "@/lib/permissions";
import type { AdminUser, DeviceSession } from "@/lib/types";

const session = (id: string, overrides: Partial<DeviceSession> = {}): DeviceSession => ({
    id,
    current: false,
    device: { browser: "Edge", os: "Windows", type: "desktop", label: "Edge on Windows" },
    ipHint: "203.0.113.*",
    createdAt: inHours(-48),
    lastSeenAt: inHours(-2),
    ...overrides,
});

const thisLaptop = session("s1", { current: true, lastSeenAt: inHours(0) });
const phone = session("s2", {
    device: { browser: "Safari", os: "iOS", type: "mobile", label: "Safari on iOS" },
    ipHint: "198.51.100.*",
});
const tablet = session("s3", { device: { browser: "Chrome", os: "Android", type: "tablet", label: "Chrome on Android" } });

describe("devices on the account page", () => {
    const api = (sessions: DeviceSession[]) => ({
        "GET /api/auth/me": [200, { user: testUser }] as [number, unknown],
        "GET /api/auth/realtime-token": [200, { token: "t" }] as [number, unknown],
        "GET /api/me/sessions": () => [200, { sessions }] as [number, unknown],
        "GET /api/notifications": [200, { notifications: [], unread: 0, hasMore: false }] as [number, unknown],
        "GET /api/notifications/preferences": [404, {}] as [number, unknown],
    });

    test("lists where the account is logged in, this device first", async () => {
        mockApi(api([thisLaptop, phone, tablet]));
        renderApp("/account");
        const list = await screen.findByRole("list", { name: "Logged-in devices" });
        const items = within(list).getAllByRole("listitem");
        expect(items).toHaveLength(3);
        expect(items[0]).toHaveTextContent("Edge on Windows");
        expect(within(items[0]).getByText("This device")).toBeInTheDocument();
        expect(items[0]).toHaveTextContent("Active now");
        expect(within(items[0]).queryByRole("button")).not.toBeInTheDocument();
        expect(items[1]).toHaveTextContent(/Safari on iOS.*Last active 2 hours ago.*network 198\.51\.100\.\*/);
    });

    test("one device, or every other one, can be logged out", async () => {
        let sessions = [thisLaptop, phone, tablet];
        const { calls } = mockApi({
            ...api([]),
            "GET /api/me/sessions": () => [200, { sessions }],
            "DELETE /api/me/sessions/s2": () => {
                sessions = sessions.filter((s) => s.id !== "s2");
                return [204];
            },
            "POST /api/me/sessions/revoke-others": () => {
                sessions = [thisLaptop];
                return [200, { revoked: 1 }];
            },
        });
        const user = userEvent.setup();
        renderApp("/account");

        await user.click(await screen.findByRole("button", { name: "Log out Safari on iOS" }));
        await waitFor(() => expect(screen.queryByText("Safari on iOS")).not.toBeInTheDocument());
        expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("DELETE /api/me/sessions/s2");

        await user.click(screen.getByRole("button", { name: "Log out other devices" }));
        await waitFor(() => expect(screen.queryByText("Chrome on Android")).not.toBeInTheDocument());
        expect(await screen.findByText("Logged out 1 other device")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Log out other devices" })).toBeDisabled();
    });

    test("logging out everywhere asks first, then ends this session too", async () => {
        const { calls } = mockApi({ ...api([thisLaptop, phone]), "POST /api/me/sessions/revoke-all": [204] });
        const user = userEvent.setup();
        renderApp("/account");

        await user.click(await screen.findByRole("button", { name: "Log out everywhere" }));
        const dialog = await screen.findByRole("dialog", { name: "Log out everywhere?" });
        await user.click(within(dialog).getByRole("button", { name: "Log out everywhere" }));
        expect(await screen.findByRole("heading", { name: /log in/i })).toBeInTheDocument();
        expect(calls.map((c) => c.path)).toContain("/api/me/sessions/revoke-all");
    });
});

describe("admin roles", () => {
    const stats = {
        users: { total: 4, verified: 4, disabled: 0, admins: 2, newThisWeek: 0 },
        shares: { active: 0, uploading: 0, createdToday: 0 },
        storage: { bytes: 0, files: 0 },
        activity: { views: 0, downloads: 0 },
    };
    const person = (id: string, email: string, role: AdminUser["role"]): AdminUser => ({
        id,
        email,
        name: email.split("@")[0],
        role,
        permissions: role === "superadmin" ? SUPERADMIN_PERMISSIONS : role === "admin" ? ADMIN_PERMISSIONS : [],
        emailVerified: true,
        createdAt: inHours(-48),
        disabled: false,
        activeShares: 0,
    });
    const users = [
        person("u2", "grace@example.com", "user"),
        person("u3", "alan@example.com", "admin"),
        person("u4", "root@example.com", "superadmin"),
    ];
    const renderAs = (me: AdminUser) => {
        const mocks = mockApi({
            "GET /api/auth/me": [200, { user: me }],
            "GET /api/auth/realtime-token": [200, { token: "t" }],
            "GET /api/admin/stats": [200, stats],
            "GET /api/admin/users": [200, { page: 1, total: 4, hasMore: false, users: [me, ...users] }],
            "POST /api/admin/users/u2/logout": [204],
        });
        renderApp("/admin");
        return mocks;
    };
    const row = async (email: string) => (await screen.findByText(email)).closest("li")!;

    test("an admin manages regular users only, and can't change roles", async () => {
        const { calls } = renderAs(person("u1", "boss@example.com", "admin"));
        const grace = await row("grace@example.com");
        expect(within(grace).getByRole("button", { name: "Disable" })).toBeInTheDocument();
        expect(within(grace).queryByRole("button", { name: "Make admin" })).not.toBeInTheDocument();
        expect(within(await row("alan@example.com")).queryByRole("button")).not.toBeInTheDocument();
        const root = await row("root@example.com");
        expect(within(root).getByText("Superadmin")).toBeInTheDocument();
        expect(within(root).queryByRole("button")).not.toBeInTheDocument();

        const user = userEvent.setup();
        await user.click(within(grace).getByRole("button", { name: "Log out" }));
        const dialog = await screen.findByRole("dialog", { name: "Log grace@example.com out everywhere?" });
        await user.click(within(dialog).getByRole("button", { name: "Log out everywhere" }));
        await waitFor(() => expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("POST /api/admin/users/u2/logout"));
    });

    test("a superadmin also manages admins and roles, but not other superadmins", async () => {
        renderAs(person("u1", "boss@example.com", "superadmin"));
        expect(within(await row("grace@example.com")).getByRole("button", { name: "Make admin" })).toBeInTheDocument();
        const alan = await row("alan@example.com");
        expect(within(alan).getByRole("button", { name: "Remove admin" })).toBeInTheDocument();
        expect(within(alan).getByRole("button", { name: "Disable" })).toBeInTheDocument();
        expect(within(await row("root@example.com")).queryByRole("button")).not.toBeInTheDocument();
    });
});
