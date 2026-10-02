const crypto = require("crypto");
const config = require("../config");

// Download links carry a signed, expiring token instead of the file's path, so
// a file can only be fetched by someone who just opened the share (and passed
// its password and view-limit checks).

const sign = (data) =>
    crypto.createHmac("sha256", config.tokenSecret).update(data).digest("base64url");

const createDownloadToken = ({ code, fileId }) => {
    const payload = Buffer.from(
        JSON.stringify({
            c: code,
            f: String(fileId),
            e: Math.floor(Date.now() / 1000) + config.downloadWindowSeconds,
        })
    ).toString("base64url");
    return `${payload}.${sign(payload)}`;
};

// Returns { code, fileId } or null if the token is malformed, forged or expired.
const verifyDownloadToken = (token) => {
    if (typeof token !== "string") return null;
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;

    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return null;
    }

    try {
        const { c, f, e } = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (typeof e !== "number" || e < Date.now() / 1000) return null;
        return { code: c, fileId: f };
    } catch {
        return null;
    }
};

module.exports = { createDownloadToken, verifyDownloadToken };
