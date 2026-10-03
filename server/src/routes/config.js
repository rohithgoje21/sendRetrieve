const express = require("express");
const config = require("../config");

const EXPIRY_LABELS = {
    "1h": "1 hour",
    "6h": "6 hours",
    "24h": "24 hours",
    "3d": "3 days",
    "7d": "7 days",
};

// GET /api/config: limits and options the frontend needs, so they're
// defined once, here.
const createConfigRouter = () => {
    const router = express.Router();

    router.get("/config", (req, res) => {
        const { limits, auth } = config;
        res.set("Cache-Control", "public, max-age=300");
        res.json({
            maxFiles: limits.maxFiles,
            maxFileSizeBytes: limits.maxFileSize,
            maxTextLength: limits.maxTextLength,
            expiryOptions: Object.keys(config.expiryOptions).map((value) => ({
                value,
                label: EXPIRY_LABELS[value] ?? value,
            })),
            defaultExpiry: config.defaultExpiry,
            viewLimitOptions: config.viewLimitOptions,
            downloadWindowSeconds: config.downloadWindowSeconds,
            sharePassword: { min: limits.minPasswordLength, max: limits.maxPasswordLength },
            accountPassword: { min: auth.minPasswordLength, max: auth.maxPasswordLength },
            uploadWindowSeconds: config.uploadWindowSeconds,
            storage: config.storage.driver,
        });
    });

    return router;
};

module.exports = { createConfigRouter };
