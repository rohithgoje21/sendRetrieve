const crypto = require("crypto");
const config = require("../../config");
const { deriveKey } = require("../../shared/crypto");

// Unique visitors without tracking anyone.
//
// For each view or download the API computes an anonymous visitor token: a
// keyed hash of the IP address and browser, with a key that changes every
// day. Only the token goes into the analytics event; the IP address is
// neither stored nor sent. The analytics worker uses the token to update a
// HyperLogLog sketch and then forgets it. Since the key changes daily, the
// same person on two days counts as two visitors: the price of not being able
// to follow anyone across days.

// Midnight UTC of `date`: the day a statistic belongs to.
const dayOf = (date = new Date()) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const dayKey = (date) => dayOf(date).toISOString().slice(0, 10);

const visitorToken = (req, now = new Date()) =>
    crypto
        .createHmac("sha256", deriveKey(config.tokenSecret, `visitor:${dayKey(now)}`))
        .update(`${req.ip}|${req.get("user-agent") ?? ""}`)
        .digest("hex")
        .slice(0, 16);

module.exports = { visitorToken, dayOf, dayKey };
