import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { inHours, mockApi, renderApp, testUser } from "@/test/utils";
import { ADMIN_PERMISSIONS, SUPERADMIN_PERMISSIONS } from "@/lib/permissions";
import type { QueuesOverview, User } from "@/lib/types";

const overview: QueuesOverview = {
    broker: "rabbitmq",
    queues: [
        { name: "sr.notifications", description: "Emails and in-app notifications", ready: 2, retrying: 1, consumers: 3, deadLettered: 1 },
        { name: "sr.cleanup", description: "Deletes files", ready: 0, retrying: 0, consumers: 3, deadLettered: 0 },
    ],
    circuitBreakers: [
        { name: "email", state: "open", failures: 5 },
        { name: "virus-scanner", state: "closed", failures: 0 },
    ],
};

const renderAs = (role: User["role"]) => {
    const me = { ...testUser, role, permissions: role === "superadmin" ? SUPERADMIN_PERMISSIONS : ADMIN_PERMISSIONS };
    const mocks = mockApi({
        "GET /api/auth/me": [200, { user: me }],
        "GET /api/auth/realtime-token": [200, { token: "t" }],
        "GET /api/notifications": [200, { notifications: [], unread: 0, hasMore: false }],
        "GET /api/admin/stats": [404, {}],
        "GET /api/admin/analytics": [404, {}],
        "GET /api/admin/users": [200, { page: 1, total: 0, hasMore: false, users: [] }],
        "GET /api/admin/queues": [200, overview],
        "GET /api/admin/queues/sr.notifications/dead-letters": [
            200,
            { messages: [{ message: { id: "m1", type: "email.requested" }, attempts: 4, error: "invalid API key", failedAt: inHours(-1) }] },
        ],
        "POST /api/admin/queues/sr.notifications/dead-letters/replay": [200, { replayed: 1 }],
        "DELETE /api/admin/queues/sr.notifications/dead-letters": [200, { purged: 1 }],
    });
    renderApp("/admin");
    return mocks;
};

test("admins see queue depths, failed messages and outside services, and can replay", async () => {
    const { calls } = renderAs("admin");
    const user = userEvent.setup();
    const row = (await screen.findByText("sr.notifications")).closest("tr")!;
    expect(row).toHaveTextContent(/2\s*1\s*1\s*3/);
    expect(screen.getByRole("list", { name: "Circuit breakers" })).toHaveTextContent(/email: Open.*virus-scanner: Closed/);

    await user.click(within(row).getByRole("button", { name: "View" }));
    const dead = await screen.findByRole("list", { name: "Dead letters in sr.notifications" });
    expect(dead).toHaveTextContent(/email\.requested.*4 attempts.*invalid API key/);

    await user.click(within(row).getByRole("button", { name: "Replay" }));
    await waitFor(() => expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("POST /api/admin/queues/sr.notifications/dead-letters/replay"));
    // Deleting failed messages is for superadmins.
    expect(within(row).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
});

test("superadmins can delete failed messages, after confirming", async () => {
    const { calls } = renderAs("superadmin");
    const user = userEvent.setup();
    const row = (await screen.findByText("sr.notifications")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete the failed messages in sr.notifications?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete messages" }));
    await waitFor(() => expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("DELETE /api/admin/queues/sr.notifications/dead-letters"));
});
