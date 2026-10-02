const mongoose = require("mongoose");

const fileSchema = new mongoose.Schema({
    originalName: { type: String, required: true },
    storedName: { type: String, required: true },
    size: { type: Number, required: true },
    mimeType: { type: String, default: "application/octet-stream" },
    downloads: { type: Number, default: 0 },
});

const shareSchema = new mongoose.Schema(
    {
        code: { type: String, required: true, unique: true },
        text: { type: String, default: null },
        files: { type: [fileSchema], default: [] },
        passwordHash: { type: String, default: null },
        // null = unlimited opens
        viewsRemaining: { type: Number, default: null },
        views: { type: Number, default: 0 },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true }
);

// The cleanup job deletes expired shares together with their files. This TTL
// index is only a backstop in case that job isn't running; any files it
// leaves behind are removed by the orphan sweep.
shareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 });

module.exports = mongoose.model("Share", shareSchema);
