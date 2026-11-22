const express = require("express");
const { z } = require("zod");
const { HttpError } = require("../../shared/errors");
const { validateBody } = require("../../shared/validate");
const { limiter } = require("../../shared/rateLimit");
const { requireAuth, authorize } = require("../auth/middleware");
const { runAgent } = require("../../infrastructure/llmAgent");
const { buildUserTools } = require("./userTools");
const { buildAdminTools } = require("./adminTools");

const askSchema = z.object({ question: z.string().trim().min(1).max(500) });

const USER_SYSTEM_PROMPT =
    "You answer a signed-in user's questions about their own sendRetrieve account (their shares, " +
    "their activity, their notifications) using only the tools given to you. Never guess or make up " +
    "numbers: if no tool covers the question, say so plainly. Keep answers to a few sentences.";

const ADMIN_SYSTEM_PROMPT =
    "You answer a sendRetrieve administrator's questions about site-wide activity (stats, analytics, " +
    "users, background job queues) using only the tools given to you. Never guess or make up numbers: " +
    "if no tool covers the question, say so plainly. Keep answers to a few sentences.";

const ask = (systemPrompt, buildTools) => async (req, res) => {
    try {
        const result = await runAgent({ systemPrompt, question: req.body.question, tools: buildTools(req) });
        res.json(result);
    } catch (err) {
        req.log.error({ err, event: "agent.ask_failed" }, "The assistant couldn't answer");
        throw new HttpError(503, "The assistant isn't available right now. Please try again shortly.");
    }
};

// /api/agent: the "ask" assistant, read-only tool-calling over the app's own
// data. /me/ask is scoped to the signed-in user's own account; /admin/ask to
// site-wide data, gated the same way the rest of the admin panel is.
const createAgentRouter = (ctx) => {
    const router = express.Router();

    router.post(
        "/me/ask",
        requireAuth,
        limiter(ctx, { name: "agent-ask", limit: 20, windowMinutes: 60, error: "Too many questions. Please wait a while." }),
        validateBody(askSchema),
        ask(USER_SYSTEM_PROMPT, (req) => buildUserTools(req.user._id))
    );

    router.post(
        "/admin/ask",
        requireAuth,
        authorize("admin.access"),
        limiter(ctx, { name: "agent-ask-admin", limit: 20, windowMinutes: 60, error: "Too many questions. Please wait a while." }),
        validateBody(askSchema),
        ask(ADMIN_SYSTEM_PROMPT, () => buildAdminTools())
    );

    return router;
};

module.exports = { createAgentRouter };
