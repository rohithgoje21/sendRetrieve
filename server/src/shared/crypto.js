const crypto = require("crypto");

// Long random tokens (reset links, refresh tokens, manage tokens) are stored
// only as hashes, so a database leak doesn't hand out working tokens.
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");

// Compares a token with a stored hash in constant time.
const tokenMatchesHash = (token, hash) => {
    if (typeof token !== "string" || !token || typeof hash !== "string" || !hash) return false;
    const expected = Buffer.from(hash);
    const actual = Buffer.from(hashToken(token));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

// A key for one purpose, derived from the app secret, so one leaked key
// can't be used for another purpose.
const deriveKey = (secret, label) => crypto.createHmac("sha256", secret).update(label).digest();

module.exports = { hashToken, randomToken, tokenMatchesHash, deriveKey };
