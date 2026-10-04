const mongoose = require("mongoose");
const config = require("../../config");

// An in-app notification (the bell). Kept for a while, then removed.
const notificationSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        // One of the events in preferences.js
        event: { type: String, required: true },
        title: { type: String, required: true },
        body: { type: String, default: null },
        // Where clicking it goes, inside the app (e.g. "/shares")
        link: { type: String, default: null },
        // For merging repeats (downloads of one share) and for the client
        data: { type: mongoose.Schema.Types.Mixed, default: {} },
        readAt: { type: Date, default: null },
    },
    { timestamps: true }
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: config.notifications.retentionDays * 24 * 60 * 60 });

notificationSchema.methods.toPublic = function () {
    return {
        id: this._id,
        event: this.event,
        title: this.title,
        body: this.body,
        link: this.link,
        read: Boolean(this.readAt),
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
    };
};

module.exports = mongoose.model("Notification", notificationSchema);
