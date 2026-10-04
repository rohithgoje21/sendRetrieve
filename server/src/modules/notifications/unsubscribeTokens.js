const crypto = require("crypto");
const config = require("../../config");
const { deriveKey } = require("../../shared/crypto");

// The "turn off these emails" link in notification emails: a signed token
// meaning "stop emailing this user about this event". It can only ever turn
// one kind of email off, so it doesn't expire (unsubscribe links should keep
// working in old emails).

const key = deriveKey(config.tokenSecret, "unsubscribe");
const sign = (payload) => crypto.createHmac("sha256", key).update(payload).digest("base64url");

const createUnsubscribeToken = (userId, event) => {
    const payload = Buffer.from(JSON.stringify({ u: String(userId), e: event })).toString("base64url");
    return `${payload}.${sign(payload)}`;
};

// { userId, event }, or null if the token is malformed or forged.
const verifyUnsubscribeToken = (token) => {
    if (typeof token !== "string") return null;
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    try {
        const { u, e } = JSON.parse(Buffer.from(payload, "base64url").toString());
        return typeof u === "string" && typeof e === "string" ? { userId: u, event: e } : null;
    } catch {
        return null;
    }
};

module.exports = { createUnsubscribeToken, verifyUnsubscribeToken };
