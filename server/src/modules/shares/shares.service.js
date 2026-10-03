const config = require("../../config");
const Share = require("./share.model");
const { createDownloadToken } = require("../files/linkTokens");
const { publish } = require("../../infrastructure/queue");
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

// A share that can be opened and downloaded from: uploaded, scanned, not
// ended, not expired.
const liveFilter = () => ({
    endedAt: null,
    uploadPending: { $ne: true },
    processing: { $ne: true },
    expiresAt: { $gt: new Date() },
});

// Every stored object belonging to these shares: files and thumbnails.
const fileKeys = (shares) =>
    shares.flatMap((s) => s.files.flatMap((f) => (f.thumbnailKey ? [f.storedName, f.thumbnailKey] : [f.storedName])));

// Multipart uploads still in progress for these shares: [{ key, uploadId }].
const pendingUploads = (shares) =>
    shares.flatMap((s) => s.files.filter((f) => f.upload?.uploadId).map((f) => ({ key: f.storedName, uploadId: f.upload.uploadId })));

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
        thumbnailUrl: file.thumbnailKey ? `${downloadUrl}?thumb=1` : null,
        width: file.width ?? null,
        height: file.height ?? null,
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
        // "removed" (by an admin) or "malware"; "used_up" can also appear on an active
        // share that is in its final download window.
        endedReason: share.endedReason ?? (share.viewsRemaining === 0 ? "used_up" : status === "expired" ? "expired" : null),
        hasText: Boolean(share.text),
        textPreview: share.text ? share.text.slice(0, 140) : null,
        files: share.files.map((f) => ({
            id: f._id,
            name: f.originalName,
            size: f.size,
            mimeType: f.mimeType,
            downloads: f.downloads,
            scanStatus: f.scanStatus,
        })),
        // Still being scanned: not openable yet.
        processing: Boolean(share.processing),
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

// Guest shares have no history; their record goes once the files are deleted.
// This is only a backstop in case that never happens.
const GUEST_RECORD_BACKSTOP_MS = 24 * 60 * 60 * 1000;

const endedReasonFor = (share, reason) => reason ?? (share.viewsRemaining === 0 ? "used_up" : "expired");

// Ends shares. The share stops working at once (its message is erased and it
// is marked ended); its files move to "pending_deletion" and a share.ended
// event asks the cleanup worker to delete them from storage. Owned shares
// keep their metadata for the owner's history; guest shares are removed once
// their files are gone.
// `reason` defaults to "used_up"/"expired" based on each share's state.
const endShares = async (shares, reason) => {
    if (shares.length === 0) return;
    const now = new Date();
    const ownedPurgeAt = new Date(now.getTime() + config.endedShareRetentionSeconds * 1000);
    const guestPurgeAt = new Date(now.getTime() + GUEST_RECORD_BACKSTOP_MS);

    const result = await Share.bulkWrite(
        shares.map((s) => ({
            updateOne: {
                filter: { _id: s._id, endedAt: null },
                update: {
                    $set: {
                        endedAt: now,
                        endedReason: endedReasonFor(s, reason),
                        text: null,
                        processing: false,
                        filesState: s.files.length ? "pending_deletion" : "deleted",
                        purgeAt: s.ownerId ? ownedPurgeAt : guestPurgeAt,
                    },
                },
            },
        }))
    );
    if (result.modifiedCount === 0) return;

    for (const share of shares) {
        const ended = { reason: endedReasonFor(share, reason) };
        await publish("share.ended", {
            shareId: String(share._id),
            code: share.code,
            ownerId: share.ownerId ? String(share.ownerId) : null,
            reason: ended.reason,
            keys: fileKeys([share]),
        });
        notifyShare(share, "share:ended", ended);
    }
};

// Throws away shares whose upload never finished (or was refused): the
// record goes now, the cleanup worker deletes whatever was uploaded and
// aborts uploads still in progress.
const discardShares = async (shares) => {
    if (shares.length === 0) return;
    await Share.deleteMany({ _id: { $in: shares.map((s) => s._id) } });
    const keys = fileKeys(shares);
    const uploads = pendingUploads(shares);
    if (keys.length || uploads.length) {
        await publish("share.discarded", { shareIds: shares.map((s) => String(s._id)), keys, uploads });
    }
};

module.exports = {
    fileKeys,
    pendingUploads,
    NOT_FOUND_MESSAGE,
    PREVIEWABLE_TYPES,
    liveFilter,
    serializeFile,
    serializeOwnedShare,
    shareStatus,
    endShares,
    discardShares,
};
