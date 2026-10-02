require("dotenv").config();
const path = require("path");
const crypto = require("crypto");

const HOUR = 60 * 60;

const config = {
    env: process.env.NODE_ENV || "development",
    port: Number(process.env.PORT) || 8080,
    mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/sendretrieve",
    uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads"),

    // Signs short-lived download links. Without a fixed secret, links stop
    // working when the server restarts (shares themselves are unaffected).
    tokenSecret: process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex"),

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
