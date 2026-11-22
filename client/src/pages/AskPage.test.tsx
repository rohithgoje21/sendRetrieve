import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockApi, renderApp, testUser } from "@/test/utils";
import type { AgentAskResponse } from "@/lib/types";

const signedIn = { "GET /api/auth/me": [200, { user: testUser }], "GET /api/auth/realtime-token": [200, { token: "t" }] } as Record<string, [number, unknown]>;
const bell = { "GET /api/notifications": [200, { notifications: [], unread: 0, hasMore: false }] } as Record<string, [number, unknown]>;

test("asking a question shows the answer and which tools it used", async () => {
    const answer: AgentAskResponse = {
        answer: "You have no active shares.",
        toolCalls: [{ name: "list_my_shares", input: { status: "active" }, resultSummary: "[]" }],
    };
    const { calls } = mockApi({ ...signedIn, ...bell, "POST /api/agent/me/ask": [200, answer] });
    const user = userEvent.setup();
    renderApp("/ask");

    const input = await screen.findByLabelText("Ask a question");
    await user.type(input, "what are my active shares?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("You have no active shares.")).toBeInTheDocument();
    expect(screen.getByText(/Looked at: list my shares/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/agent/me/ask")?.body).toEqual({ question: "what are my active shares?" });
    // The box clears and is ready for another question.
    expect(input).toHaveValue("");
});

test("an error from the assistant is shown, not swallowed", async () => {
    mockApi({ ...signedIn, ...bell, "POST /api/agent/me/ask": [503, { error: "The assistant isn't available right now." }] });
    const user = userEvent.setup();
    renderApp("/ask");

    await user.type(await screen.findByLabelText("Ask a question"), "hi");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("The assistant isn't available right now.")).toBeInTheDocument();
});
