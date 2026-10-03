const mailer = require("../infrastructure/mailer");
const { renderEmail } = require("../modules/notifications/emailTemplates");

// sr.notifications: sends emails (and, from the notifications module,
// in-app notifications). A failing email provider makes the job fail; the
// queue retries it with backoff, and the mailer's circuit breaker keeps the
// retries from hammering a provider that's down.
const handle = async (message, { log }) => {
    switch (message.type) {
        case "email.requested": {
            const { template, to, data } = message.data;
            await mailer.sendMail({ to, ...renderEmail(template, data) });
            log.info({ event: "email.sent", template }, "Email sent");
            return;
        }
        default:
            return;
    }
};

module.exports = { queue: "sr.notifications", handle };
