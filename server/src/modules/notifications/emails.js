const { publish } = require("../../infrastructure/queue");

// Asks for an email to be sent. The notification worker renders the template
// and sends it, with retries if the email provider is having trouble, so the
// request doesn't wait on (or fail because of) the provider.
const requestEmail = (template, to, data) => publish("email.requested", { template, to, data });

module.exports = { requestEmail };
