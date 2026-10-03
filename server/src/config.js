const path = require("path");
const crypto = require("crypto");

// server/.env first; the repo-root .env is also read, for setups from before
// the backend moved into server/. Real environment variables win over both.
require("dotenv").config({
    path: [path.join(__dirname, "..", ".env"), path.join(__dirname, "..", "..", ".env")],
    quiet: true,
});

const HOUR = 60 * 60;
const MB = 1024 * 1024;

const list = (value) =>
    value
        ? value
              .split(",")
              .map((v) => v.trim().replace(/\/+$/, ""))
              .filter(Boolean)
        : [];

// Where uploaded files live: "s3" (MinIO, Cloudflare R2, AWS S3, any
// S3-compatible service) or "disk" (a local folder, for tests and quick runs).
const storageDriver = process.env.STORAGE_DRIVER || (process.env.S3_BUCKET ? "s3" : "disk");

const config = {
    env: process.env.NODE_ENV || "development",
    port: Number(process.env.PORT) || 8080,
    mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/sendretrieve",
    // Disk storage only.
    uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads"),

    storage: {
        driver: storageDriver,
        s3: {
            // Omit for AWS S3. MinIO: http://localhost:9000 (http://minio:9000 inside Docker).
            endpoint: process.env.S3_ENDPOINT || null,
            // The address browsers use for signed upload/download links, when it
            // differs from the one the server uses (e.g. a Docker service name).
            publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || null,
            region: process.env.S3_REGION || "us-east-1",
            bucket: process.env.S3_BUCKET || "sendretrieve",
            accessKeyId: process.env.S3_ACCESS_KEY_ID || null,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || null,
            // MinIO and most self-hosted services need path-style URLs (host/bucket/key).
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
            // Create the bucket at startup if it's missing (handy for local MinIO).
            createBucket: process.env.S3_CREATE_BUCKET === "true",
        },
    },
    // The built React app (npm run build), served by Express in production.
    clientDir: process.env.CLIENT_DIR || path.join(__dirname, "..", "..", "client", "dist"),

    // Signs download links and login sessions. Without a fixed secret, links
    // and sessions stop working when the server restarts.
    tokenSecret: process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex"),

    // Public URL used in emailed links, e.g. https://sendretrieve.up.railway.app.
    // Falls back to the request's host, which is fine locally but should be set
    // in production so a forged Host header can't redirect reset links.
    appUrl: process.env.APP_URL ? process.env.APP_URL.replace(/\/+$/, "") : null,

    // Other origins allowed to talk to this server: the frontend's URL when it
    // is hosted separately (e.g. https://sendretrieve.vercel.app). Used for the
    // real-time connection's CORS and the same-origin check on API requests.
    corsOrigins: list(process.env.CORS_ORIGINS),

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

    // Email verification codes.
    otp: {
        length: 6,
        ttlSeconds: 10 * 60,
        maxAttempts: 5,
        resendCooldownSeconds: 60,
    },

    realtime: {
        // Short-lived token a signed-in browser exchanges for its socket connection.
        tokenTtlSeconds: 2 * 60,
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
        // With S3, files go straight from the browser to storage, so it can take
        // much larger files than disk storage, which streams through the server.
        maxFileSize: Number(process.env.MAX_FILE_SIZE_MB || (storageDriver === "s3" ? 500 : 50)) * MB,
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

    // How long a browser has to upload a new share's files before the share is
    // abandoned and cleaned up.
    uploadWindowSeconds: 60 * 60,

    // Refuse executables (Windows, Linux, macOS binaries), detected from the
    // file's contents rather than its name.
    blockExecutables: process.env.BLOCK_EXECUTABLES !== "false",

    // How often the scheduler looks for expired shares, abandoned uploads and
    // orphaned files (only one worker instance does it per interval).
    cleanupIntervalMs: 60 * 1000,

    queue: {
        // RabbitMQ. Without it, an in-process queue with the same retry and
        // dead-letter behavior is used (fine for one server and for tests).
        url: process.env.AMQP_URL || null,
        // Wait before each retry of a failed job; after the last, the message
        // goes to the queue's dead-letter queue.
        retryDelaysMs: process.env.QUEUE_RETRY_DELAYS_MS
            ? process.env.QUEUE_RETRY_DELAYS_MS.split(",").map(Number)
            : [1000, 5000, 30000],
        prefetch: 10,
        // Run the background workers inside the API process. Default: yes
        // without RabbitMQ; with RabbitMQ, run them separately (npm run worker).
        inlineWorkers: process.env.RUN_WORKERS ? process.env.RUN_WORKERS === "true" : !process.env.AMQP_URL,
    },

    // Calls to outside services (email, virus scanner) fail fast after this
    // many consecutive failures, then try again after the cool-down.
    circuitBreaker: {
        failureThreshold: 5,
        resetTimeoutMs: 30 * 1000,
        callTimeoutMs: 10 * 1000,
    },

    // Optional. Without it, rate limits and lockouts are kept in memory (lost
    // on restart and not shared between instances).
    redisUrl: process.env.REDIS_URL || null,

    logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "silent" : "info"),

    // Per-target brute-force protection, on top of per-IP rate limits: after
    // this many failures, a share's password or an account's login is locked
    // for the rest of the window, whichever IPs the attempts come from.
    lockout: {
        maxFailedAttempts: 10,
        windowSeconds: 15 * 60,
    },

    // How long in-flight requests get to finish on shutdown.
    shutdownTimeoutMs: 10 * 1000,
};

module.exports = config;
