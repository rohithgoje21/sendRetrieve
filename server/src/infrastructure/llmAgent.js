const Anthropic = require("@anthropic-ai/sdk");
const config = require("../config");
const { logger } = require("./logger");
const { CircuitBreaker } = require("../shared/circuitBreaker");

// A small, bounded tool-use loop for the "ask" assistant (server/src/modules/agent):
// the model answers only by calling the tools it's given (thin wrappers around
// the app's own read endpoints/service functions), never the database
// directly. Unlike the other optional integrations in this app (email,
// push), there's no fallback when it's unavailable: the breaker wraps the
// whole loop and any failure (no API key, timeout, API error, breaker open)
// surfaces as a clean error to the route, which reports the assistant as
// unavailable rather than guessing an answer.

const log = logger.child({ component: "llm-agent" });

const breaker = new CircuitBreaker("agent-llm", {
    callTimeoutMs: config.agent.callTimeoutMs,
    onStateChange: (state, previous) =>
        log[state === "open" ? "error" : "info"]({ event: "agent.circuit", state, previous }, `Agent circuit ${state}`),
});

let client = null;
const getClient = () => (client ??= new Anthropic({ apiKey: config.agent.anthropicApiKey }));

const MAX_ROUNDS = 5;
const MAX_TOKENS = 1024;

// `tools`: [{ name, description, input_schema, handler(input) => Promise<string> }]
const runLoop = async ({ systemPrompt, question, tools }) => {
    const byName = new Map(tools.map((t) => [t.name, t]));
    const toolDefs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
    const messages = [{ role: "user", content: question }];
    const toolCalls = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
        const response = await getClient().messages.create({
            model: config.agent.model,
            max_tokens: MAX_TOKENS,
            system: systemPrompt,
            output_config: { effort: "low" },
            tools: toolDefs,
            messages,
        });

        if (response.stop_reason === "refusal") {
            return { answer: "I can't help with that question.", toolCalls };
        }

        const toolUses = response.content.filter((b) => b.type === "tool_use");
        if (toolUses.length === 0) {
            const text = response.content.find((b) => b.type === "text");
            return { answer: text?.text ?? "I don't have an answer for that.", toolCalls };
        }

        messages.push({ role: "assistant", content: response.content });
        const results = [];
        for (const use of toolUses) {
            const tool = byName.get(use.name);
            let content;
            try {
                content = tool ? await tool.handler(use.input ?? {}) : `Unknown tool: ${use.name}`;
            } catch (err) {
                content = `Tool failed: ${err.message}`;
            }
            toolCalls.push({ name: use.name, input: use.input ?? {}, resultSummary: String(content).slice(0, 300) });
            results.push({ type: "tool_result", tool_use_id: use.id, content: String(content) });
        }
        messages.push({ role: "user", content: results });
    }

    return { answer: "I wasn't able to finish answering that within the time I'm given. Try a narrower question.", toolCalls };
};

const runAgent = async ({ systemPrompt, question, tools }) => {
    if (!config.agent.anthropicApiKey) throw new Error("The assistant isn't configured (no ANTHROPIC_API_KEY)");
    return breaker.exec(() => runLoop({ systemPrompt, question, tools }));
};

module.exports = { runAgent, agentBreaker: breaker };
