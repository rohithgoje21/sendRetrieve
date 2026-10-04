const mongoose = require("mongoose");

// Daily statistics, written by the analytics worker. Counts only: no IP
// addresses, no visitor IDs; unique visitors are a HyperLogLog sketch (see
// shared/hyperloglog.js), which can't be turned back into anyone.

const DAY_SECONDS = 24 * 60 * 60;

// One share, one day (UTC).
const shareStatSchema = new mongoose.Schema(
    {
        shareId: { type: mongoose.Schema.Types.ObjectId, required: true },
        ownerId: { type: mongoose.Schema.Types.ObjectId, default: null },
        day: { type: Date, required: true },
        views: { type: Number, default: 0 },
        downloads: { type: Number, default: 0 },
        // Bandwidth: bytes of files downloaded
        bytes: { type: Number, default: 0 },
        visitors: { type: mongoose.Schema.Types.Mixed, default: {} },
        // { image: 3, document: 1, ... }
        downloadsByType: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { versionKey: false, minimize: false }
);
shareStatSchema.index({ shareId: 1, day: 1 }, { unique: true });
shareStatSchema.index({ ownerId: 1, day: 1 });
shareStatSchema.index({ day: 1 }, { expireAfterSeconds: 400 * DAY_SECONDS });

// The whole site, one day (UTC).
const siteStatSchema = new mongoose.Schema(
    {
        day: { type: Date, required: true },
        views: { type: Number, default: 0 },
        downloads: { type: Number, default: 0 },
        bytes: { type: Number, default: 0 },
        visitors: { type: mongoose.Schema.Types.Mixed, default: {} },
        downloadsByType: { type: mongoose.Schema.Types.Mixed, default: {} },
        sharesCreated: { type: Number, default: 0 },
        filesUploaded: { type: Number, default: 0 },
        bytesUploaded: { type: Number, default: 0 },
        // { image: { files: 3, bytes: 1234 }, ... }
        uploadsByType: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { versionKey: false, minimize: false }
);
siteStatSchema.index({ day: 1 }, { unique: true, expireAfterSeconds: 2 * 365 * DAY_SECONDS });

module.exports = {
    ShareStat: mongoose.model("ShareStat", shareStatSchema),
    SiteStat: mongoose.model("SiteStat", siteStatSchema),
};
