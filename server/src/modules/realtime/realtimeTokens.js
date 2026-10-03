const jwt = require("jsonwebtoken");
const config = require("../../config");
const { deriveKey } = require("../../shared/crypto");

// The Socket.IO connection may go to another origin (frontend on Vercel, API
// on Render), where the session cookies aren't sent. The browser fetches this
// short-lived token over the API and hands it to the socket instead.

const secret = deriveKey(config.tokenSecret, "realtime-token");

const createRealtimeToken = (user) =>
    jwt.sign({}, secret, {
        subject: String(user._id),
        audience: "realtime",
        expiresIn: config.realtime.tokenTtlSeconds,
        algorithm: "HS256",
    });

// Returns the user ID, or null for a bad or expired token.
const verifyRealtimeToken = (token) => {
    try {
        return jwt.verify(token, secret, { algorithms: ["HS256"], audience: "realtime" }).sub;
    } catch {
        return null;
    }
};

module.exports = { createRealtimeToken, verifyRealtimeToken };
