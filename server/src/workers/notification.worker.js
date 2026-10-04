const mailer = require("../infrastructure/mailer");
const User = require("../modules/users/user.model");
const { renderEmail } = require("../modules/notifications/emailTemplates");
const { deviceLabel } = require("../modules/auth/devices");

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
        // A login from a browser this account hasn't used before.
        case "auth.login": {
            const { userId, newDevice, device, ipHint, at, accountUrl } = message.data;
            if (!newDevice) return;
            const user = await User.findById(userId, { email: 1, name: 1 }).lean();
            if (!user) return;
            await mailer.sendMail({
                to: user.email,
                ...renderEmail("new-device-login", { name: user.name, device: deviceLabel(device), ipHint, at, accountUrl }),
            });
            log.info({ event: "email.sent", template: "new-device-login" }, "Email sent");
            return;
        }
        default:
            return;
    }
};

module.exports = { queue: "sr.notifications", handle };
