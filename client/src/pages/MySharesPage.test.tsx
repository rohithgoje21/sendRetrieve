import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { inHours, mockApi, renderApp, testUser } from "@/test/utils";
import type { OwnedShare } from "@/lib/types";

const share: OwnedShare = {
    code: "ABCD2345",
    url: "http://localhost/s/ABCD2345",
    status: "active",
    endedReason: null,
    hasText: true,
    textPreview: "Quarterly numbers attached",
    files: [{ id: "f1", name: "report.pdf", size: 2048, mimeType: "application/pdf", downloads: 4, scanStatus: "clean" }],
    processing: false,
    totalSize: 2048,
    passwordProtected: true,
    maxViews: 5,
    viewsRemaining: 2,
    views: 3,
    createdAt: inHours(-1),
    expiresAt: inHours(23),
    endedAt: null,
};

const page = (shares: OwnedShare[], counts = { active: shares.length, expired: 0, deleted: 0 }) => ({
    status: "active",
    page: 1,
    hasMore: false,
    shares,
    counts,
});

test("lists shares with their stats, and deleting one asks first", async () => {
    let deleted = false;
    const { calls } = mockApi({
        "GET /api/auth/me": [200, { user: testUser }],
        "GET /api/me/shares": () => [200, deleted ? page([], { active: 0, expired: 0, deleted: 1 }) : page([share])],
        "DELETE /api/me/shares/ABCD2345": () => {
            deleted = true;
            return [204];
        },
    });
    const user = userEvent.setup();
    renderApp("/shares");

    const card = await screen.findByRole("article", { name: "Share ABCD-2345" });
    expect(within(card).getByText("Active")).toBeInTheDocument();
    expect(within(card).getByText("Quarterly numbers attached")).toBeInTheDocument();
    expect(within(card).getByText("3 of 5 views")).toBeInTheDocument();
    expect(within(card).getByText("4 downloads")).toBeInTheDocument();
    expect(within(card).getByText(/Expires in 23 hours/)).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete share ABCD-2345?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete share" }));

    expect(await screen.findByText("No active shares")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
});

test("the tab is kept in the URL and loads that status", async () => {
    const { calls } = mockApi({
        "GET /api/auth/me": [200, { user: testUser }],
        "GET /api/me/shares": [200, page([], { active: 1, expired: 2, deleted: 0 })],
    });
    const user = userEvent.setup();
    const { router } = renderApp("/shares");

    await user.click(await screen.findByRole("button", { name: /Expired/ }));
    expect(router.state.location.search).toBe("?status=expired");
    expect(await screen.findByText("No expired shares")).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toContain("/api/me/shares?status=expired&page=1");
});
