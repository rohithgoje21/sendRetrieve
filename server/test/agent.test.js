// A real ANTHROPIC_API_KEY so the route doesn't short-circuit as unconfigured;
// the actual API client is mocked below, so nothing ever leaves the process.
process.env.ANTHROPIC_API_KEY = "test-key";

jest.mock("@anthropic-ai/sdk", () => {
    const create = jest.fn();
    const Anthropic = jest.fn().mockImplementation(() => ({ messages: { create } }));
    Anthropic.__create = create;
    return Anthropic;
});

const request = require("supertest");
const { app, createShare, useTestDatabase } = require("./helpers");
const Anthropic = require("@anthropic-ai/sdk");
const User = require("../src/modules/users/user.model");

useTestDatabase();

const mockCreate = Anthropic.__create;
afterEach(() => mockCreate.mockReset());

const PASSWORD = "correct-horse";
const register = async (email, { role } = {}) => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ name: email.split("@")[0], email, password: PASSWORD }).expect(201);
    if (role) await User.updateOne({ email }, { role });
    return agent;
};

// Simulates the model calling one tool, then answering from its result.
const toolThenAnswer = (toolName, toolInput, answerText) => {
    mockCreate
        .mockResolvedValueOnce({
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "t1", name: toolName, input: toolInput }],
        })
        .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: answerText }] });
};

describe("POST /api/agent/me/ask", () => {
    test("requires sign-in", async () => {
        await request(app).post("/api/agent/me/ask").send({ question: "hi" }).expect(401);
    });

    test("rejects an empty or missing question", async () => {
        const agent = await register("ada@example.com");
        await agent.post("/api/agent/me/ask").send({ question: "" }).expect(400);
        await agent.post("/api/agent/me/ask").send({}).expect(400);
    });

    test("answers using a tool, and reports which tool it used", async () => {
        const agent = await register("ada@example.com");
        toolThenAnswer("list_my_shares", { status: "active" }, "You have no active shares.");

        const { body } = await agent.post("/api/agent/me/ask").send({ question: "what are my active shares?" }).expect(200);
        expect(body).toEqual({ answer: "You have no active shares.", toolCalls: [{ name: "list_my_shares", input: { status: "active" }, resultSummary: "[]" }] });
    });

    test("a user's tool can only ever see that user's own shares", async () => {
        const ada = await register("ada@example.com");
        const bob = await register("bob@example.com");
        await createShare(bob, { text: "bob's secret" });

        toolThenAnswer("list_my_shares", {}, "placeholder");
        const { body } = await ada.post("/api/agent/me/ask").send({ question: "list my shares" }).expect(200);
        expect(JSON.parse(body.toolCalls[0].resultSummary)).toEqual([]);
    });

    test("a tool result is returned even for the share's own owner", async () => {
        const ada = await register("ada@example.com");
        await createShare(ada, { text: "hello" });

        toolThenAnswer("list_my_shares", {}, "You have one share.");
        const { body } = await ada.post("/api/agent/me/ask").send({ question: "list my shares" }).expect(200);
        const results = JSON.parse(body.toolCalls[0].resultSummary);
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ hasText: true });
    });

    test("the assistant is reported unavailable, not guessed, when the API call fails", async () => {
        const agent = await register("ada@example.com");
        mockCreate.mockRejectedValue(new Error("network down"));
        const { body } = await agent.post("/api/agent/me/ask").send({ question: "hi" }).expect(503);
        expect(body.error).toMatch(/isn't available/);
    });
});

describe("POST /api/agent/admin/ask", () => {
    test("403s for a regular user, works for an admin", async () => {
        const user = await register("user@example.com");
        mockCreate.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "n/a" }] });
        await user.post("/api/agent/admin/ask").send({ question: "site stats?" }).expect(403);

        const admin = await register("boss@example.com", { role: "admin" });
        const { body } = await admin.post("/api/agent/admin/ask").send({ question: "site stats?" }).expect(200);
        expect(body.answer).toBe("n/a");
    });

    test("can read site-wide stats via its tool", async () => {
        const admin = await register("boss@example.com", { role: "admin" });
        toolThenAnswer("get_site_stats", {}, "There is 1 user.");
        const { body } = await admin.post("/api/agent/admin/ask").send({ question: "how many users?" }).expect(200);
        const stats = JSON.parse(body.toolCalls[0].resultSummary);
        expect(stats.users.total).toBe(1);
        expect(body.answer).toBe("There is 1 user.");
    });
});
