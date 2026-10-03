const mongoose = require("mongoose");

const fileSchema = new mongoose.Schema({
    originalName: { type: String, required: true },
    // Key of the object in storage (shares/<shareId>/<fileId>; older shares
    // on disk storage used a bare random name).
    storedName: { type: String, required: true },
    size: { type: Number, required: true },
    // Detected from the file's contents once uploaded (see lib/fileType.js);
    // until then, what the browser reported.
    mimeType: { type: String, default: "application/octet-stream" },
    downloads: { type: Number, default: 0 },
    // Malware scan by the processing worker: pending -> clean | infected,
    // or "skipped" when no scanner is configured.
    scanStatus: { type: String, enum: ["pending", "clean", "infected", "skipped"], default: "pending" },
    // Images only, made by the processing worker.
    thumbnailKey: { type: String, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
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
        // The expiry the sender picked; the clock starts once files are uploaded.
        durationSeconds: { type: Number, default: null },

        // True while the browser is uploading the files to storage. Such a share
        // can't be opened, isn't listed, and is discarded if the upload isn't
        // completed in time (its expiresAt is the upload deadline until then).
        uploadPending: { type: Boolean, default: false },
        // Hash of the token that lets the creator complete/cancel the upload and
        // watch the share live.
        manageTokenHash: { type: String, default: null },

        // True after upload while the processing worker scans the files. Like an
        // upload in progress, a processing share can't be opened yet.
        processing: { type: Boolean, default: false },

        // Set when a share stops being available. Its content and files are
        // deleted at that point; owned shares keep their metadata until purgeAt.
        endedAt: { type: Date, default: null },
        endedReason: { type: String, enum: ["expired", "used_up", "deleted", "removed", "malware", null], default: null },
        // Lifecycle of the stored files once a share ends:
        //   stored -> pending_deletion (the share has ended; the cleanup worker
        //   is deleting them) -> deleted
        filesState: { type: String, enum: ["stored", "pending_deletion", "deleted"], default: "stored" },
        purgeAt: { type: Date, default: null },
    },
    { timestamps: true }
);

shareSchema.index({ endedAt: 1, expiresAt: 1 });
shareSchema.index({ ownerId: 1, createdAt: -1 });
// For the sweep that re-queues file deletions that got stuck.
shareSchema.index({ filesState: 1, endedAt: 1 });
// Final removal. Guest shares get a purgeAt shortly after expiry as a backstop
// in case the cleanup job isn't running; orphaned files are swept separately.
shareSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Share", shareSchema);
