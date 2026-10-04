// Starts the app for the end-to-end tests: the real server and the built
// React app, with an in-memory MongoDB, files on disk, and the in-process
// queue and workers. No Docker needed, so it runs the same locally and in CI.
// Playwright starts it (playwright.config.ts, webServer).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { MongoMemoryServer } = require("mongodb-memory-server");

const ROOT = path.join(__dirname, "..");
const port = process.env.E2E_PORT || "4173";
const clientDir = path.join(ROOT, "client", "dist");

const main = async () => {
    if (!fs.existsSync(path.join(clientDir, "index.html"))) {
        throw new Error("The client isn't built: run `npm run build` first.");
    }
    const mongo = await MongoMemoryServer.create();
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendretrieve-e2e-"));
    const mongoUri = mongo.getUri("sendretrieve");

    Object.assign(process.env, {
        NODE_ENV: "production",
        PORT: port,
        APP_URL: `http://localhost:${port}`,
        TRUST_PROXY: "0",
        MONGODB_URI: mongoUri,
        TOKEN_SECRET: "e2e-token-secret",
        STORAGE_DRIVER: "disk",
        UPLOAD_DIR: uploadDir,
        CLIENT_DIR: clientDir,
        // One machine sends every request in these tests.
        RATE_LIMITS: "off",
        // 1 MB parts, so resumable uploads are exercised with small files.
        UPLOAD_PART_SIZE_MB: "1",
        METRICS_PORT: "0",
        LOG_LEVEL: process.env.LOG_LEVEL || "warn",
    });
    // For tests that need to reach into the database (e.g. to make an admin).
    fs.writeFileSync(path.join(__dirname, ".state.json"), JSON.stringify({ mongoUri }));

    const cleanUp = () => fs.rmSync(uploadDir, { recursive: true, force: true });
    process.on("exit", cleanUp);
    require(path.join(ROOT, "server", "server.js"));
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
