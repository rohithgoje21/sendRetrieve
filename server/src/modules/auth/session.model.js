const mongoose = require("mongoose");

// One document per login: a browser or app signed in to an account. Lists
// "where you're logged in" and lets one be logged out. Every refresh token of
// the login carries its familyId (see refreshToken.model.js), and access
// tokens carry it too ("sid"), so revoking a session takes effect at once.
const sessionSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
        familyId: { type: String, required: true, unique: true },
        // A random ID kept in a long-lived cookie, to recognize a browser that
        // has logged in before (for new-device alerts).
        deviceId: { type: String, required: true },
        device: {
            browser: { type: String, default: null },
            os: { type: String, default: null },
            type: { type: String, enum: ["desktop", "mobile", "tablet", "unknown"], default: "unknown" },
        },
        // Network part of the address only (see devices.js).
        ipHint: { type: String, default: null },
        lastSeenAt: { type: Date, default: Date.now },
        // When the session's refresh token runs out, unless it's used again.
        expiresAt: { type: Date, required: true },
        revokedAt: { type: Date, default: null },
        revokedReason: {
            type: String,
            enum: ["logout", "revoked", "logout_all", "password_changed", "disabled", "token_reuse", null],
            default: null,
        },
    },
    { timestamps: true }
);

sessionSchema.index({ userId: 1, deviceId: 1 });
// Kept for 90 days after last use (device history, recognizing known
// devices), then removed.
sessionSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model("Session", sessionSchema);
