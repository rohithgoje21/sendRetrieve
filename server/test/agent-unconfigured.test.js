// No ANTHROPIC_API_KEY set here (unlike agent.test.js): confirms the
// assistant reports itself unavailable, rather than crashing or silently
// answering, when the feature isn't configured.
delete process.env.ANTHROPIC_API_KEY;

const request = require("supertest");
const { app, useTestDatabase } = require("./helpers");

useTestDatabase();

test("the assistant reports itself unavailable without an API key", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ name: "Ada", email: "ada@example.com", password: "correct-horse" }).expect(201);
    const { body } = await agent.post("/api/agent/me/ask").send({ question: "hi" }).expect(503);
    expect(body.error).toMatch(/isn't available/);
});
