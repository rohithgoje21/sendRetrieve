import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { guestSession, mockApi, renderApp, testUser } from "@/test/utils";

const emptyShares = {
    status: "active",
    page: 1,
    hasMore: false,
    shares: [],
    counts: { active: 0, expired: 0, deleted: 0 },
};

test("login validates input, shows server errors, then goes where the user was headed", async () => {
    const { calls } = mockApi({
        "GET /api/auth/me": guestSession,
        "POST /api/auth/login": ({ body }) =>
            (body as { password: string }).password === "right-password"
                ? [200, { user: testUser }]
                : [401, { error: "Incorrect email or password" }],
        "GET /api/me/shares": [200, emptyShares],
    });
    const user = userEvent.setup();
    renderApp("/login?next=/shares");

    const email = await screen.findByLabelText("Email");
    const password = screen.getByLabelText("Password");
    const submit = screen.getByRole("button", { name: "Log in" });

    await user.type(email, "not-an-email");
    await user.click(submit);
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/auth/login")).toBe(false);

    await user.clear(email);
    await user.type(email, "ada@example.com");
    await user.type(password, "wrong-password");
    await user.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password");

    await user.clear(password);
    await user.type(password, "right-password");
    await user.click(submit);
    expect(await screen.findByRole("heading", { name: "My shares" })).toBeInTheDocument();
});

test("protected pages send guests to login, remembering where they were going", async () => {
    mockApi({ "GET /api/auth/me": guestSession });
    const { router } = renderApp("/account");
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("?next=%2Faccount");
});

test("a ?next= pointing at another site is ignored", async () => {
    mockApi({ "GET /api/auth/me": [200, { user: testUser }], "GET /api/me/shares": [200, emptyShares] });
    const { router } = renderApp("/login?next=//evil.example");
    expect(await screen.findByRole("heading", { name: "My shares" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/shares");
});

test("sign-up puts the server's field error on the right field", async () => {
    mockApi({
        "GET /api/auth/me": guestSession,
        "POST /api/auth/register": [409, { error: "An account with this email already exists", field: "email" }],
    });
    const user = userEvent.setup();
    renderApp("/signup");

    await user.type(await screen.findByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    const message = await screen.findByText("An account with this email already exists");
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-describedby", expect.stringContaining(message.id));
});

test("the reset token is taken out of the address bar", async () => {
    mockApi({ "GET /api/auth/me": guestSession });
    const { router } = renderApp("/reset-password?token=secret-token");
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(router.state.location.search).toBe("");
});
