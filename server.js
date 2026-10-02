const mongoose = require("mongoose");
const config = require("./src/config");
const { createApp } = require("./src/app");
const { startCleanupJob } = require("./src/lib/cleanup");
const Share = require("./src/models/Share");
const User = require("./src/models/User");
const RefreshToken = require("./src/models/RefreshToken");

const start = async () => {
    await mongoose.connect(config.mongoUri);
    console.log("Connected to MongoDB");

    // Brings indexes in line with the schemas, e.g. replacing Phase 1's TTL
    // index on expiresAt, which would otherwise delete owned shares' history.
    await Promise.all([Share.syncIndexes(), User.syncIndexes(), RefreshToken.syncIndexes()]);

    startCleanupJob(config.cleanupIntervalMs);

    createApp().listen(config.port, () => {
        console.log(`Server running on http://localhost:${config.port}`);
    });
};

start().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
});
