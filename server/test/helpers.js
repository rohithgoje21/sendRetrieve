// Shared test setup. Require this before any src/ module: config reads these
// environment variables when it is first loaded.
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sendretrieve-test-"));
process.env.TOKEN_SECRET = "test-secret";

// A stand-in for the React build (client/dist), so the server tests don't
// depend on the frontend having been built.
const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendretrieve-client-"));
fs.mkdirSync(path.join(clientDir, "assets"));
fs.writeFileSync(path.join(clientDir, "index.html"), '<!doctype html><title>sendRetrieve</title><div id="root"></div>');
fs.writeFileSync(path.join(clientDir, "assets", "index-abc123.js"), "console.log('app');");
fs.writeFileSync(path.join(clientDir, "favicon.svg"), "<svg></svg>");
process.env.CLIENT_DIR = clientDir;

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { createApp } = require("../src/app");

const uploadDir = process.env.UPLOAD_DIR;
const app = createApp({ rateLimit: false });
const storedFiles = () => fs.readdirSync(uploadDir);

// Registers beforeAll/afterEach/afterAll hooks for an isolated database.
const useTestDatabase = () => {
    let mongo;

    beforeAll(async () => {
        mongo = await MongoMemoryServer.create();
        await mongoose.connect(mongo.getUri());
        await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
    });

    afterEach(async () => {
        await Promise.all(Object.values(mongoose.models).map((m) => m.deleteMany({})));
        for (const name of storedFiles()) fs.unlinkSync(path.join(uploadDir, name));
    });

    afterAll(async () => {
        await mongoose.disconnect();
        await mongo.stop();
        fs.rmSync(uploadDir, { recursive: true, force: true });
    });
};

module.exports = { app, uploadDir, storedFiles, useTestDatabase };
