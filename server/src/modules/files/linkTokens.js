const crypto = require("crypto");
const config = require("../../config");

// Signed, expiring tokens for links the server hands out:
//   download  /api/files/:token, for someone who just opened a share (and
//             passed its password and view-limit checks)
//   upload    /api/uploads/:token, disk storage's stand-in for a signed S3
//             upload URL
// Each token names its purpose, so one kind can't be used as the other.

const sign = (data) => crypto.createHmac("sha256", config.tokenSecret).update(data).digest("base64url");

const createToken = (purpose, claims, ttlSeconds) => {
    const payload = Buffer.from(
        JSON.stringify({ ...claims, p: purpose, e: Math.floor(Date.now() / 1000) + ttlSeconds })
    ).toString("base64url");
    return `${payload}.${sign(payload)}`;
};

// Returns the token's claims, or null if it's malformed, forged, expired or
// for another purpose.
const verifyToken = (purpose, token) => {
    if (typeof token !== "string") return null;
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;

    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

    try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (claims.p !== purpose || typeof claims.e !== "number" || claims.e < Date.now() / 1000) return null;
        return claims;
    } catch {
        return null;
    }
};

const createDownloadToken = ({ code, fileId }) =>
    createToken("download", { c: code, f: String(fileId) }, config.downloadWindowSeconds);

const verifyDownloadToken = (token) => {
    const claims = verifyToken("download", token);
    return claims && { code: claims.c, fileId: claims.f };
};

const createUploadToken = ({ key, size }) => createToken("upload", { k: key, s: size }, config.uploadWindowSeconds);

const verifyUploadToken = (token) => {
    const claims = verifyToken("upload", token);
    return claims && { key: claims.k, size: claims.s };
};

module.exports = { createDownloadToken, verifyDownloadToken, createUploadToken, verifyUploadToken };
