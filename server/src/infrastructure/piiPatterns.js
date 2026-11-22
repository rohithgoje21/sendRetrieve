// Pattern-based detectors for commonly-leaked secrets. Local and synchronous:
// nothing here ever leaves the process. Not exhaustive — these catch
// well-known shapes, not every possible secret.

const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

const luhnValid = (digits) => {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = Number(digits[i]);
        if (double) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
        double = !double;
    }
    return sum % 10 === 0;
};

const hasCreditCard = (text) => {
    const matches = text.match(CARD_CANDIDATE) ?? [];
    return matches.some((m) => {
        const digits = m.replace(/[ -]/g, "");
        return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    });
};

const hasAwsAccessKey = (text) => /\bAKIA[0-9A-Z]{16}\b/.test(text);

const hasPrivateKeyBlock = (text) => /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/.test(text);

const hasApiToken = (text) =>
    /\bBearer\s+[A-Za-z0-9._-]{20,}\b/.test(text) ||
    /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._-]{20,}["']?/i.test(text);

module.exports = { hasCreditCard, hasAwsAccessKey, hasPrivateKeyBlock, hasApiToken };
