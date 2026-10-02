import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { guestSession, inHours, mockApi, renderApp } from "@/test/utils";

const openedShare = {
    code: "ABCD2345",
    text: "Hello there",
    files: [{ id: "f1", name: "notes.txt", size: 2048, mimeType: "text/plain", downloadUrl: "/api/files/t1", previewUrl: null }],
    createdAt: new Date().toISOString(),
    expiresAt: inHours(5),
    viewsRemaining: 2,
    downloadWindowSeconds: 600,
};

test("typing a code formats it", async () => {
    mockApi({ "GET /api/auth/me": guestSession });
    const user = userEvent.setup();
    renderApp("/open");

    const input = await screen.findByLabelText("Share code");
    await user.type(input, "abcd2345");
    expect(input).toHaveValue("ABCD-2345");
});

test("a short code is rejected before calling the API", async () => {
    const { calls } = mockApi({ "GET /api/auth/me": guestSession });
    const user = userEvent.setup();
    renderApp("/open");

    await user.type(await screen.findByLabelText("Share code"), "ABC");
    await user.click(screen.getByRole("button", { name: "Open share" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/8 characters/);
    expect(calls.some((c) => c.path.includes("/open"))).toBe(false);
});

test("a share link pre-fills the code; the password is asked for only when needed", async () => {
    const { calls } = mockApi({
        "GET /api/auth/me": guestSession,
        "POST /api/shares/ABCD2345/open": ({ body }) => {
            const { password } = body as { password?: string };
            if (!password) return [401, { error: "This share is password protected", passwordRequired: true }];
            if (password !== "letmein") return [401, { error: "Incorrect password", passwordRequired: true }];
            return [200, openedShare];
        },
    });
    const user = userEvent.setup();
    renderApp("/s/abcd2345");

    expect(await screen.findByLabelText("Share code")).toHaveValue("ABCD-2345");
    await user.click(screen.getByRole("button", { name: "Open share" }));

    // First response: a prompt, not an error
    const password = await screen.findByLabelText("Password");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.type(password, "wrong");
    await user.click(screen.getByRole("button", { name: "Open share" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect password");

    await user.clear(password);
    await user.type(password, "letmein");
    await user.click(screen.getByRole("button", { name: "Open share" }));

    expect(await screen.findByText("Hello there")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/files/t1");
    expect(screen.getByText("2 more opens allowed")).toBeInTheDocument();

    const opens = calls.filter((c) => c.path.endsWith("/open")).map((c) => c.body);
    expect(opens).toEqual([{}, { password: "wrong" }, { password: "letmein" }]);
});

test("the last allowed view says the share is now closed", async () => {
    mockApi({
        "GET /api/auth/me": guestSession,
        "POST /api/shares/ABCD2345/open": [200, { ...openedShare, viewsRemaining: 0 }],
    });
    const user = userEvent.setup();
    renderApp("/s/ABCD2345");

    await user.click(await screen.findByRole("button", { name: "Open share" }));
    expect(await screen.findByText(/last allowed view/)).toHaveTextContent("within 10 minutes");
});
