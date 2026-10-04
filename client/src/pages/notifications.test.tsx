import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appSocket } from "@/test/fakeSocket";
import { inHours, mockApi, renderApp, testUser } from "@/test/utils";
import type { AppNotification, NotificationSettings } from "@/lib/types";

const notification = (id: string, overrides: Partial<AppNotification> = {}): AppNotification => ({
    id,
    event: "fileDownloaded",
    title: '"report.pdf" was downloaded',
    body: "Share ABCD-2345 · 1 download of this file so far",
    link: "/shares",
    read: false,
    createdAt: inHours(-1),
    updatedAt: inHours(-1),
    ...overrides,
});

const settings = (overrides: Partial<NotificationSettings["channels"]> = {}): NotificationSettings => ({
    preferences: {
        fileDownloaded: { inApp: true, email: false, push: true },
        shareEnded: { inApp: true, email: false, push: false },
        shareBlocked: { inApp: true, email: true, push: true },
        newDevice: { inApp: true, email: true, push: true },
        weeklySummary: { inApp: true, email: true, push: false },
    },
    events: [
        { key: "fileDownloaded", label: "A file from one of your shares is downloaded", security: false },
        { key: "shareEnded", label: "A share expires, is used up or is removed by an administrator", security: false },
        { key: "shareBlocked", label: "A share is blocked because a file contains malware", security: false },
        { key: "newDevice", label: "Your account is logged in to from a new device", security: true },
        { key: "weeklySummary", label: "Weekly summary of your shares", security: false },
    ],
    channels: { email: { verified: true }, push: { available: true, publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" }, ...overrides },
});

const signedIn: Record<string, [number, unknown]> = {
    "GET /api/auth/me": [200, { user: testUser }],
    "GET /api/auth/realtime-token": [200, { token: "t" }],
};

describe("the bell", () => {
    test("shows the unread count; opening a notification marks it read and goes to its page", async () => {
        const { calls } = mockApi({
            ...signedIn,
            "GET /api/notifications": [200, { notifications: [notification("n1"), notification("n2", { read: true, title: "Share ABCD-2345 expired", event: "shareEnded" })], unread: 1, hasMore: false }],
            "POST /api/notifications/read": [200, { unread: 0 }],
            "GET /api/me/shares": [200, { status: "active", page: 1, hasMore: false, shares: [], counts: { active: 0, expired: 0, deleted: 0 } }],
        });
        const user = userEvent.setup();
        renderApp("/account");

        const bell = await screen.findByRole("button", { name: "Notifications, 1 unread" });
        await user.click(bell);
        const panel = screen.getByRole("dialog", { name: "Notifications" });
        expect(within(panel).getByText('"report.pdf" was downloaded')).toBeInTheDocument();
        expect(within(panel).getByText("Share ABCD-2345 expired")).toBeInTheDocument();

        await user.click(within(panel).getByText('"report.pdf" was downloaded'));
        await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ path: "/api/notifications/read", body: { ids: ["n1"] } })));
        expect(await screen.findByRole("heading", { name: "My shares" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument(); // no unread left
    });

    test("new notifications arrive live; merged ones replace the old copy; all can be marked read", async () => {
        const { calls } = mockApi({
            ...signedIn,
            "GET /api/notifications": [200, { notifications: [notification("n1")], unread: 1, hasMore: false }],
            "POST /api/notifications/read": [200, { unread: 0 }],
        });
        const user = userEvent.setup();
        renderApp("/account");
        await screen.findByRole("button", { name: "Notifications, 1 unread" });

        act(() =>
            appSocket().fire("notification", {
                notification: notification("n1", { title: "Files from share ABCD-2345 were downloaded 2 times", updatedAt: inHours(0) }),
                unread: 1,
            })
        );
        act(() =>
            appSocket().fire("notification", {
                notification: notification("n3", { event: "newDevice", title: "New login from Safari on iOS", link: "/account" }),
                unread: 2,
            })
        );
        await user.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
        const items = within(screen.getByRole("dialog", { name: "Notifications" })).getAllByRole("listitem");
        expect(items.map((i) => i.textContent)).toEqual([
            expect.stringContaining("New login from Safari on iOS"),
            expect.stringContaining("were downloaded 2 times"),
        ]);

        await user.click(screen.getByRole("button", { name: "Mark all as read" }));
        await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ path: "/api/notifications/read", body: { all: true } })));
        expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
    });
});

describe("notification settings", () => {
    test("a checkbox per event and channel; changes are saved", async () => {
        const { calls } = mockApi({
            ...signedIn,
            "GET /api/notifications": [200, { notifications: [], unread: 0, hasMore: false }],
            "GET /api/me/sessions": [200, { sessions: [] }],
            "GET /api/notifications/preferences": [200, settings()],
            "PUT /api/notifications/preferences": (req) => {
                const s = settings();
                s.preferences.fileDownloaded.email = (req.body as { preferences: { fileDownloaded: { email: boolean } } }).preferences.fileDownloaded.email;
                return [200, s];
            },
        });
        const user = userEvent.setup();
        renderApp("/account#notifications");

        const email = await screen.findByRole("checkbox", { name: "Email: A file from one of your shares is downloaded" });
        expect(email).not.toBeChecked();
        expect(screen.getByRole("checkbox", { name: "Browser: Weekly summary of your shares" })).not.toBeChecked();
        expect(screen.getByText("Security")).toBeInTheDocument();

        await user.click(email);
        await waitFor(() =>
            expect(calls).toContainEqual(expect.objectContaining({ method: "PUT", body: { preferences: { fileDownloaded: { email: true } } } }))
        );
        expect(email).toBeChecked();
    });

    test("unverified addresses only get security emails; no browser column without push", async () => {
        mockApi({
            ...signedIn,
            "GET /api/notifications": [200, { notifications: [], unread: 0, hasMore: false }],
            "GET /api/me/sessions": [200, { sessions: [] }],
            "GET /api/notifications/preferences": [200, settings({ email: { verified: false }, push: { available: false, publicKey: null } })],
        });
        renderApp("/account");
        const blocked = await screen.findByRole("checkbox", { name: "Email: A share is blocked because a file contains malware" });
        expect(blocked).toBeDisabled();
        expect(blocked).not.toBeChecked();
        expect(screen.getByRole("checkbox", { name: "Email: Your account is logged in to from a new device" })).toBeEnabled();
        expect(screen.queryByRole("checkbox", { name: /^Browser:/ })).not.toBeInTheDocument();
        expect(screen.getByText(/Only security alerts are emailed until you/)).toBeInTheDocument();
    });

    test("browser notifications are turned on per browser", async () => {
        const subscription = {
            endpoint: "https://push.example.com/send/xyz",
            toJSON: () => ({ endpoint: "https://push.example.com/send/xyz", keys: { p256dh: "p", auth: "a" } }),
            unsubscribe: vi.fn().mockResolvedValue(true),
        };
        const pushManager = { getSubscription: vi.fn().mockResolvedValue(null), subscribe: vi.fn().mockResolvedValue(subscription) };
        const registration = { pushManager };
        vi.stubGlobal("PushManager", function PushManager() {});
        vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn().mockResolvedValue("granted") });
        Object.defineProperty(navigator, "serviceWorker", {
            configurable: true,
            value: { register: vi.fn().mockResolvedValue(registration), ready: Promise.resolve(registration), getRegistration: vi.fn().mockResolvedValue(undefined) },
        });

        const { calls } = mockApi({
            ...signedIn,
            "GET /api/notifications": [200, { notifications: [], unread: 0, hasMore: false }],
            "GET /api/me/sessions": [200, { sessions: [] }],
            "GET /api/notifications/preferences": [200, settings()],
            "POST /api/notifications/push-subscriptions": [201, { subscribed: true }],
        });
        const user = userEvent.setup();
        renderApp("/account");

        await user.click(await screen.findByRole("button", { name: "Turn on for this browser" }));
        expect(await screen.findByText("Browser notifications are on for this browser.")).toBeInTheDocument();
        expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/sw.js");
        expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
        expect(calls).toContainEqual(
            expect.objectContaining({ path: "/api/notifications/push-subscriptions", body: { endpoint: subscription.endpoint, keys: { p256dh: "p", auth: "a" } } })
        );
        // @ts-expect-error -- remove the stub
        delete navigator.serviceWorker;
    });
});

describe("unsubscribing from an email link", () => {
    test("asks first, then turns that kind of email off", async () => {
        const { calls } = mockApi({
            "GET /api/auth/me": [401, { error: "Please log in", code: "auth_required" }],
            "POST /api/notifications/unsubscribe": [200, { event: "fileDownloaded", label: "A file from one of your shares is downloaded" }],
        });
        const user = userEvent.setup();
        renderApp("/unsubscribe?token=abc.def");
        await user.click(await screen.findByRole("button", { name: "Turn off these emails" }));
        expect(await screen.findByRole("heading", { name: "You won't get these emails anymore" })).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent("emails when a file from one of your shares is downloaded");
        expect(calls).toContainEqual(expect.objectContaining({ path: "/api/notifications/unsubscribe", body: { token: "abc.def" } }));
    });

    test("an incomplete link can't do anything", async () => {
        mockApi({ "GET /api/auth/me": [401, { error: "Please log in", code: "auth_required" }] });
        renderApp("/unsubscribe");
        expect(await screen.findByRole("button", { name: "Turn off these emails" })).toBeDisabled();
        expect(screen.getByRole("alert")).toHaveTextContent("This link is incomplete");
    });
});
