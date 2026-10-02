import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { guestSession, mockApi, renderApp, testConfig, testUser } from "@/test/utils";

const file = (name: string, bytes: number) => new File(["x".repeat(bytes)], name, { type: "text/plain" });

test("options come from the server's config", async () => {
    mockApi({ "GET /api/auth/me": guestSession, "GET /api/config": [200, testConfig] });
    renderApp("/");

    const expiry = await screen.findByLabelText("Expires after");
    expect(expiry).toHaveValue("24h");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(
        expect.arrayContaining(["1 hour", "24 hours", "Unlimited times", "Once", "5 times"])
    );
    expect(screen.getByText("Up to 3 files, 1.0 KB each")).toBeInTheDocument();
});

test("an empty share is rejected with a message", async () => {
    mockApi({ "GET /api/auth/me": guestSession, "GET /api/config": [200, testConfig] });
    const user = userEvent.setup();
    renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Create share" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a message or at least one file.");
});

test("files over the size limit are refused; others can be added and removed", async () => {
    mockApi({ "GET /api/auth/me": guestSession, "GET /api/config": [200, testConfig] });
    const user = userEvent.setup();
    renderApp("/");

    const input = await screen.findByLabelText("Choose files");
    await user.upload(input, [file("big.bin", 2048), file("small.txt", 10)]);

    expect(screen.getByText("big.bin is larger than 1.0 KB.")).toBeInTheDocument();
    expect(screen.getByText("small.txt")).toBeInTheDocument();
    expect(screen.queryByText("big.bin")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove small.txt" }));
    expect(screen.queryByText("small.txt")).not.toBeInTheDocument();
});

test("a share password that's too short is caught before sending", async () => {
    mockApi({ "GET /api/auth/me": guestSession, "GET /api/config": [200, testConfig] });
    const user = userEvent.setup();
    renderApp("/");

    await user.type(await screen.findByLabelText(/^Message/), "hello");
    await user.type(screen.getByLabelText(/^Password/), "abc");
    await user.click(screen.getByRole("button", { name: "Create share" }));
    expect(await screen.findByText("Use at least 4 characters")).toBeInTheDocument();
});

test("guests are invited to log in; signed-in users are told where the share goes", async () => {
    mockApi({ "GET /api/auth/me": [200, { user: testUser }], "GET /api/config": [200, testConfig] });
    renderApp("/");
    expect(await screen.findByText(/this share will appear in/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
});
