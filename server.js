const mongoose = require("mongoose");
const config = require("./src/config");
const { createApp } = require("./src/app");
const { startCleanupJob } = require("./src/lib/cleanup");

const start = async () => {
    await mongoose.connect(config.mongoUri);
    console.log("Connected to MongoDB");

    startCleanupJob(config.cleanupIntervalMs);

    createApp().listen(config.port, () => {
        console.log(`Server running on http://localhost:${config.port}`);
    });
};

start().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
});
