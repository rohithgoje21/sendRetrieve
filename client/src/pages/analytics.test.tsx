import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { inHours, mockApi, renderApp, testUser } from "@/test/utils";
import { niceByteTicks, niceTicks } from "@/lib/analytics";
import type { MyAnalytics, OwnedShare } from "@/lib/types";

const days = (n: number, values: (i: number) => Partial<MyAnalytics["daily"][number]> = () => ({})) =>
    Array.from({ length: n }, (_, i) => ({
        day: new Date(Date.UTC(2030, 0, 1 + i)).toISOString().slice(0, 10),
        views: 0,
        downloads: 0,
        bytes: 0,
        visitors: 0,
        ...values(i),
    }));

const analytics = (n = 30): MyAnalytics => ({
    days: n,
    from: "2030-01-01",
    to: "2030-01-30",
    totals: { views: 120, downloads: 30, bytes: 5 * 1024 * 1024, visitors: 80, sharesCreated: 4 },
    previous: { views: 100, downloads: 40, bytes: 0, visitors: 80 },
    daily: days(n, (i) => (i === n - 1 ? { views: 12, downloads: 3, visitors: 9, bytes: 2048 } : {})),
    downloadsByType: { image: 20, video: 0, audio: 0, document: 10, archive: 0, other: 0 },
    fileTypes: {
        image: { files: 3, bytes: 3000 },
        video: { files: 0, bytes: 0 },
        audio: { files: 0, bytes: 0 },
        document: { files: 1, bytes: 500 },
        archive: { files: 0, bytes: 0 },
        other: { files: 0, bytes: 0 },
    },
    topShares: [{ code: "ABCD2345", label: "photo.png", views: 90, downloads: 20, bytes: 4096, visitors: 60 }],
});

const signedIn = { "GET /api/auth/me": [200, { user: testUser }], "GET /api/auth/realtime-token": [200, { token: "t" }] } as Record<string, [number, unknown]>;
const bell = { "GET /api/notifications": [200, { notifications: [], unread: 0, hasMore: false }] } as Record<string, [number, unknown]>;

test("round axis ticks", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(1234)).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks(9000)).toEqual([0, 2500, 5000, 7500, 10000]);
    // Bytes: round in the unit shown (here KB), not in raw bytes.
    expect(niceByteTicks(120 * 1024).map((t) => t / 1024)).toEqual([0, 50, 100, 150]);
    expect(niceByteTicks(500)).toEqual([0, 200, 400, 600]);
});

describe("analytics page", () => {
    test("headline numbers with their change, charts with a table view, and the top shares", async () => {
        mockApi({ ...signedIn, ...bell, "GET /api/me/analytics": [200, analytics()] });
        renderApp("/analytics");

        expect(await screen.findByText("120")).toBeInTheDocument();
        expect(screen.getByText(/\+20%/)).toBeInTheDocument(); // views 100 -> 120
        expect(screen.getByText(/-25%/)).toBeInTheDocument(); // downloads 40 -> 30
        expect(screen.getByText("new this period")).toBeInTheDocument(); // bandwidth from 0
        expect(screen.getByText("5.0 MB")).toBeInTheDocument();

        // Two or more series: a legend, and every value in the table view.
        const activity = screen.getByRole("figure", { name: /Views, visitors and downloads per day/ });
        expect(within(activity).getByRole("list", { name: "Legend" })).toHaveTextContent(/Views.*Visitors.*Downloads/);
        const table = within(activity).getByRole("table");
        expect(within(table).getAllByRole("row")).toHaveLength(31);
        expect(within(table).getAllByRole("row").at(-1)).toHaveTextContent(/12\s*9\s*3/);

        expect(screen.getByRole("list", { name: "Files shared, by type" })).toHaveTextContent(/Images\s*3 · 2.9 KB.*Documents\s*1/);
        expect(screen.getByRole("link", { name: "ABCD-2345" })).toHaveAttribute("href", "/shares?q=ABCD2345");
    });

    test("the keyboard reads the chart day by day", async () => {
        mockApi({ ...signedIn, ...bell, "GET /api/me/analytics": [200, analytics(7)] });
        renderApp("/analytics?days=7");
        const chart = await screen.findByLabelText(/Views, visitors and downloads per day, last 7 days\. Use the left and right arrow keys/);
        fireEvent.focus(chart);
        expect(within(chart).getByRole("status")).toHaveTextContent(/(Jan 7|7 Jan).*12\s*Views.*9\s*Visitors.*3\s*Downloads/);
        fireEvent.keyDown(chart, { key: "ArrowLeft" });
        expect(within(chart).getByRole("status")).toHaveTextContent(/(Jan 6|6 Jan).*0\s*Views/);
    });

    test("switching the period asks for that period", async () => {
        const { calls } = mockApi({ ...signedIn, ...bell, "GET /api/me/analytics": (req) => [200, analytics(req.path.includes("days=7") ? 7 : 30)] });
        const user = userEvent.setup();
        renderApp("/analytics");
        await screen.findByText("120");
        await user.click(screen.getByRole("button", { name: "7 days" }));
        await waitFor(() => expect(calls.map((c) => c.path)).toContain("/api/me/analytics?days=7"));
    });
});

describe("searching my shares", () => {
    const share: OwnedShare = {
        code: "ABCD2345",
        url: "http://localhost/s/ABCD2345",
        status: "active",
        endedReason: null,
        hasText: false,
        textPreview: null,
        files: [{ id: "f1", name: "report.pdf", size: 2048, mimeType: "application/pdf", downloads: 0, scanStatus: "clean" }],
        processing: false,
        totalSize: 2048,
        passwordProtected: false,
        maxViews: null,
        viewsRemaining: null,
        views: 0,
        createdAt: inHours(-1),
        expiresAt: inHours(23),
        endedAt: null,
    };

    test("typing searches; filters and sort go into the request and the URL; no match offers to clear", async () => {
        const { calls } = mockApi({
            ...signedIn,
            ...bell,
            "GET /api/me/shares": (req) => {
                const matches = !req.path.includes("q=") || req.path.includes("q=report");
                const shares = matches && !req.path.includes("kind=text") ? [share] : [];
                return [200, { status: "active", sort: "newest", page: 1, hasMore: false, shares, counts: { active: shares.length, expired: 0, deleted: 0 } }];
            },
        });
        const user = userEvent.setup();
        const { router } = renderApp("/shares");
        await screen.findByText("report.pdf");

        await user.type(screen.getByRole("textbox", { name: "Search shares" }), "report");
        await waitFor(() => expect(calls.map((c) => c.path)).toContainEqual(expect.stringContaining("q=report")));
        await waitFor(() => expect(router.state.location.search).toContain("q=report"));

        await user.selectOptions(screen.getByRole("combobox", { name: "Sort by" }), "downloads");
        await waitFor(() => expect(calls.at(-1)?.path).toMatch(/q=report.*sort=downloads|sort=downloads.*q=report/));

        await user.selectOptions(screen.getByRole("combobox", { name: "Filter by content" }), "text");
        expect(await screen.findByText("No shares match")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Clear search and filters" }));
        expect(await screen.findByText("report.pdf")).toBeInTheDocument();
        expect(screen.getByRole("textbox", { name: "Search shares" })).toHaveValue("");
    });
});
