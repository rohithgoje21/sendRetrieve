const config = require("../../config");
const Share = require("./share.model");
const { createDownloadToken } = require("../files/linkTokens");
const { storage } = require("../../infrastructure/storage");
const { notifyShare } = require("../realtime/realtime");

// Only types a browser renders as media are ever served inline, and only when
// the file's contents confirmed the type (see fileType.js). Everything else
// (HTML, SVG, PDF, ...) is forced to download so an uploaded file can't run
// script in the page.
const PREVIEWABLE_TYPES = new Set([
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
    "video/mp4", "video/webm", "video/ogg",
    "audio/mpeg", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "audio/mp4", "audio/aac",
]);

const NOT_FOUND_MESSAGE = "Share not found. It may have expired or reached its view limit.";

// A share that can be opened and downloaded from: uploaded, not ended, not expired.
const liveFilter = () => ({ endedAt: null, uploadPending: { $ne: true }, expiresAt: { $gt: new Date() } });

const fileKeys = (shares) => shares.flatMap((s) => s.files.map((f) => f.storedName));

const serializeFile = (code, file) => {
    const token = createDownloadToken({ code, fileId: file._id });
    const downloadUrl = `/api/files/${token}`;
    return {
        id: file._id,
        name: file.originalName,
        size: file.size,
        mimeType: file.mimeType,
        downloadUrl,
        previewUrl: PREVIEWABLE_TYPES.has(file.mimeType) ? `${downloadUrl}?inline=1` : null,
    };
};

const ENDED_AS_DELETED = new Set(["deleted", "removed"]);

const shareStatus = (share) => {
    if (ENDED_AS_DELETED.has(share.endedReason)) return "deleted";
    if (share.endedAt || share.expiresAt <= new Date()) return "expired";
    return "active";
};

// What an owner sees in their share list. Content is only included when asked
// for (and only while the share is active).
const serializeOwnedShare = (share, baseUrl, { includeContent = false } = {}) => {
    const status = shareStatus(share);
    const result = {
        code: share.code,
        url: `${baseUrl}/s/${share.code}`,
        status,
        // Why it ended: "expired", "used_up", "deleted" (by the owner) or
        // "removed" (by an admin); "used_up" can also appear on an active
        // share that is in its final download window.
        endedReason: share.endedReason ?? (share.viewsRemaining === 0 ? "used_up" : status === "expired" ? "expired" : null),
        hasText: Boolean(share.text),
        textPreview: share.text ? share.text.slice(0, 140) : null,
        files: share.files.map((f) => ({ id: f._id, name: f.originalName, size: f.size, mimeType: f.mimeType, downloads: f.downloads })),
        totalSize: share.files.reduce((sum, f) => sum + f.size, 0),
        passwordProtected: Boolean(share.passwordHash),
        maxViews: share.maxViews,
        viewsRemaining: share.viewsRemaining,
        views: share.views,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        endedAt: share.endedAt,
    };
    if (includeContent && status === "active") {
        result.text = share.text;
        result.files = share.files.map((f) => ({ ...serializeFile(share.code, f), downloads: f.downloads }));
    }
    return result;
};

// Ends shares: deletes their files and content. Guest shares are removed
// entirely; owned shares keep their metadata for the owner's history.
// `reason` defaults to "used_up"/"expired" based on each share's state.
const endShares = async (shares, reason) => {
    if (shares.length === 0) return;
    await storage.delete(fileKeys(shares));

    const guestIds = shares.filter((s) => !s.ownerId).map((s) => s._id);
    if (guestIds.length) await Share.deleteMany({ _id: { $in: guestIds } });

    const owned = shares.filter((s) => s.ownerId);
    if (owned.length) {
        const now = new Date();
        const purgeAt = new Date(now.getTime() + config.endedShareRetentionSeconds * 1000);
        await Share.bulkWrite(
            owned.map((s) => ({
                updateOne: {
                    filter: { _id: s._id, endedAt: null },
                    update: {
                        $set: {
                            endedAt: now,
                            endedReason: reason ?? (s.viewsRemaining === 0 ? "used_up" : "expired"),
                            text: null,
                            purgeAt,
                        },
                    },
                },
            }))
        );
    }

    for (const share of shares) {
        notifyShare(share, "share:ended", { reason: reason ?? (share.viewsRemaining === 0 ? "used_up" : "expired") });
    }
};

// Throws away shares whose upload never finished: files and record, no history.
const discardShares = async (shares) => {
    if (shares.length === 0) return;
    await storage.delete(fileKeys(shares));
    await Share.deleteMany({ _id: { $in: shares.map((s) => s._id) } });
};

module.exports = {
    NOT_FOUND_MESSAGE,
    PREVIEWABLE_TYPES,
    liveFilter,
    serializeFile,
    serializeOwnedShare,
    shareStatus,
    endShares,
    discardShares,
};
