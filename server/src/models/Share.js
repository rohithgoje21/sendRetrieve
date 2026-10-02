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
        // null for guest shares
        ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        text: { type: String, default: null },
        files: { type: [fileSchema], default: [] },
        passwordHash: { type: String, default: null },
        // null = unlimited opens
        maxViews: { type: Number, default: null },
        viewsRemaining: { type: Number, default: null },
        views: { type: Number, default: 0 },
        expiresAt: { type: Date, required: true },

        // Set when a share stops being available. Its content and files are
        // deleted at that point; owned shares keep their metadata until purgeAt.
        endedAt: { type: Date, default: null },
        endedReason: { type: String, enum: ["expired", "used_up", "deleted", null], default: null },
        purgeAt: { type: Date, default: null },
    },
    { timestamps: true }
);

shareSchema.index({ endedAt: 1, expiresAt: 1 });
shareSchema.index({ ownerId: 1, createdAt: -1 });
// Final removal. Guest shares get a purgeAt shortly after expiry as a backstop
// in case the cleanup job isn't running; orphaned files are swept separately.
shareSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Share", shareSchema);
