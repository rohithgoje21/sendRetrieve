const crypto = require("crypto");
const config = require("../../config");
const { HttpError } = require("../../shared/errors");

// One-time codes (e.g. "verify your email: 482913"), kept in the key-value
// store (Redis when available) with an expiry, never stored in plain text.
//
// Keys, per purpose and subject (e.g. "verify-email" + user ID):
//   otp:<purpose>:<id>           hash of the current code    (expires with the code)
//   otp:<purpose>:<id>:attempts  wrong guesses so far        (same lifetime)
//   otp:<purpose>:<id>:cooldown  set while a new code can't be sent yet

const { length, ttlSeconds, maxAttempts, resendCooldownSeconds } = config.otp;

const hashCode = (purpose, id, code) =>
    crypto.createHmac("sha256", config.tokenSecret).update(`otp:${purpose}:${id}:${code}`).digest("hex");

const generateCode = () => String(crypto.randomInt(0, 10 ** length)).padStart(length, "0");

const unavailable = (err) => {
    throw Object.assign(new HttpError(503, "Verification codes are temporarily unavailable. Try again shortly."), {
        cause: err,
    });
};

const createOtpService = (kv) => {
    const keys = (purpose, id) => {
        const base = `otp:${purpose}:${id}`;
        return { code: base, attempts: `${base}:attempts`, cooldown: `${base}:cooldown` };
    };

    return {
        // Creates a new code (replacing any previous one) and returns it, or
        // throws 429 if one was sent too recently.
        async issue(purpose, id) {
            const k = keys(purpose, id);
            const wait = await kv.ttl(k.cooldown).catch(unavailable);
            if (wait > 0) {
                throw new HttpError(429, `Please wait ${wait} seconds before requesting another code.`, {
                    retryAfterSeconds: wait,
                });
            }
            const code = generateCode();
            await Promise.all([
                kv.set(k.code, hashCode(purpose, id, code), ttlSeconds),
                kv.set(k.cooldown, "1", resendCooldownSeconds),
                kv.del(k.attempts),
            ]).catch(unavailable);
            return { code, expiresInSeconds: ttlSeconds, resendAfterSeconds: resendCooldownSeconds };
        },

        // Throws 400 unless `code` is the current code. After maxAttempts wrong
        // guesses the code is discarded and a new one must be requested.
        async verify(purpose, id, code) {
            const k = keys(purpose, id);
            const stored = await kv.get(k.code).catch(unavailable);
            if (!stored) throw new HttpError(400, "That code has expired. Request a new one.", { field: "code" });

            const attempts = await kv.incr(k.attempts, ttlSeconds).catch(unavailable);
            if (attempts > maxAttempts) {
                await kv.del(k.code, k.attempts).catch(unavailable);
                throw new HttpError(429, "Too many wrong codes. Request a new one.", { field: "code" });
            }

            const expected = Buffer.from(stored);
            const actual = Buffer.from(hashCode(purpose, id, code));
            if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
                const left = maxAttempts - attempts;
                throw new HttpError(
                    400,
                    left > 0
                        ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`
                        : "That code isn't right. Request a new one.",
                    { field: "code" }
                );
            }
            await kv.del(k.code, k.attempts).catch(unavailable);
        },
    };
};

module.exports = { createOtpService };
