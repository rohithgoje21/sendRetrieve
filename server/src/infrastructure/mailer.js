const config = require("../config");
const { logger } = require("./logger");
const { CircuitBreaker } = require("../shared/circuitBreaker");

// Sends email through Resend's HTTP API. Without RESEND_API_KEY the message is
// written to the log instead, which is enough for local development (the
// server warns about this at startup in production).
//
// Called by the notification worker, never directly by a request: a slow or
// failing email provider delays a queued job, not a user. The circuit breaker
// stops hammering the provider while it's down; the failed jobs are retried
// later by the queue.

const log = logger.child({ component: "mailer" });

const breaker = new CircuitBreaker("email", {
    onStateChange: (state, previous) =>
        log[state === "open" ? "error" : "info"]({ event: "email.circuit", state, previous }, `Email circuit ${state}`),
});

const deliver = async ({ to, subject, text, html }) => {
    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.email.resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: config.email.from, to, subject, text, html }),
    });
    if (!res.ok) throw new Error(`Resend returned ${res.status}: ${await res.text()}`);
};

const sendMail = async (message) => {
    if (!config.email.resendApiKey) {
        log.info({ event: "email.logged", to: message.to, subject: message.subject }, `Email not sent (no RESEND_API_KEY):\n${message.text}`);
        return;
    }
    await breaker.exec(() => deliver(message));
};

module.exports = { sendMail, emailBreaker: breaker };
