const webpush = require("web-push");
const config = require("../config");
const { logger } = require("./logger");
const { CircuitBreaker } = require("../shared/circuitBreaker");

// Web Push: sends notifications to browsers through their vendor's push
// service (Google, Mozilla, Apple, Microsoft), signed with this site's VAPID
// key and encrypted so only the subscribed browser can read them. Works
// even when the site isn't open. Off unless VAPID keys are configured.

const log = logger.child({ component: "push" });
const { publicKey, privateKey, subject } = config.notifications.vapid;

let configured = false;
if (publicKey && privateKey) {
    try {
        webpush.setVapidDetails(subject, publicKey, privateKey);
        configured = true;
    } catch (err) {
        log.error({ err, event: "push.misconfigured" }, "Invalid VAPID keys; browser notifications are off");
    }
}

const enabled = () => configured;

const breaker = new CircuitBreaker("web-push", {
    onStateChange: (state, previous) =>
        log[state === "open" ? "error" : "info"]({ event: "push.circuit", state, previous }, `Push circuit ${state}`),
});

// Sends `payload` to one browser. Resolves:
//   "sent"     delivered to the push service
//   "gone"     the browser unsubscribed or the service forgot it: delete it
//   "refused"  the service rejected this message (e.g. too big): drop it
// Throws when worth retrying (push service down, rate limited).
const sendPush = (subscription, payload) =>
    breaker.exec(async () => {
        try {
            await webpush.sendNotification(
                { endpoint: subscription.endpoint, keys: subscription.keys },
                JSON.stringify(payload),
                { TTL: 24 * 60 * 60, urgency: "normal", timeout: 10_000 }
            );
            return "sent";
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) return "gone";
            if (err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429) {
                log.warn({ event: "push.refused", status: err.statusCode, body: err.body }, "Push service refused a message");
                return "refused";
            }
            throw err;
        }
    });

module.exports = { enabled, publicKey: () => (configured ? publicKey : null), sendPush, pushBreaker: breaker };
