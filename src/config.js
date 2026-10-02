require("dotenv").config();
const path = require("path");
const crypto = require("crypto");

const HOUR = 60 * 60;

const config = {
    env: process.env.NODE_ENV || "development",
    port: Number(process.env.PORT) || 8080,
    mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/sendretrieve",
    uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads"),

    // Signs download links and login sessions. Without a fixed secret, links
    // and sessions stop working when the server restarts.
    tokenSecret: process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex"),

    // Public URL used in emailed links, e.g. https://sendretrieve.up.railway.app.
    // Falls back to the request's host, which is fine locally but should be set
    // in production so a forged Host header can't redirect reset links.
    appUrl: process.env.APP_URL ? process.env.APP_URL.replace(/\/+$/, "") : null,

    email: {
        resendApiKey: process.env.RESEND_API_KEY || null,
        from: process.env.EMAIL_FROM || "sendRetrieve <onboarding@resend.dev>",
    },

    auth: {
        accessTokenTtlSeconds: 15 * 60,
        refreshTokenTtlSeconds: 30 * 24 * HOUR,
        passwordResetTtlSeconds: 30 * 60,
        minPasswordLength: 8,
        maxPasswordLength: 72,
        maxNameLength: 60,
    },

    // Lower in tests so the suite isn't dominated by hashing time.
    bcryptRounds: process.env.NODE_ENV === "test" ? 4 : 12,

    // Shares owned by an account stay visible (without their content) under
    // "Expired"/"Deleted" for this long before being removed for good.
    endedShareRetentionSeconds: 30 * 24 * HOUR,

    // Number of reverse proxies in front of the app (Railway = 1). Needed so
    // rate limiting sees the client IP instead of the proxy's.
    trustProxy: process.env.TRUST_PROXY !== undefined ? Number(process.env.TRUST_PROXY) : 1,

    limits: {
        maxFileSize: Number(process.env.MAX_FILE_SIZE_MB || 50) * 1024 * 1024,
        maxFiles: 10,
        maxTextLength: 100_000,
        minPasswordLength: 4,
        maxPasswordLength: 72, // bcrypt ignores bytes past 72
    },

    expiryOptions: {
        "1h": 1 * HOUR,
        "6h": 6 * HOUR,
        "24h": 24 * HOUR,
        "3d": 72 * HOUR,
        "7d": 168 * HOUR,
    },
    defaultExpiry: "24h",

    viewLimitOptions: [1, 5, 10],

    // How long a download link from an "open" stays valid. This is also the
    // grace period a share survives after its last allowed view.
    downloadWindowSeconds: 10 * 60,

    cleanupIntervalMs: 5 * 60 * 1000,
};

module.exports = config;
