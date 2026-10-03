const sharp = require("sharp");
const config = require("../config");
const Share = require("../modules/shares/share.model");
const { storage } = require("../infrastructure/storage");
const scanner = require("../infrastructure/clamav");
const { publish } = require("../infrastructure/queue");
const { endShares } = require("../modules/shares/shares.service");
const { notifyShare } = require("../modules/realtime/realtime");

// sr.processing: runs after a share's files are uploaded (share.uploaded).
//
//   1. Malware scan (when a scanner is configured): each file is streamed from
//      storage to ClamAV. One infected file blocks the whole share: it ends
//      with reason "malware", its files are deleted, the owner is told.
//      If the scanner can't be reached the job fails and the queue retries
//      it; the share stays unavailable meanwhile (fail closed).
//   2. Thumbnails for images (and their dimensions). Best effort: a failure
//      here never blocks the share.
//   3. The share goes live ("share:ready" to the sender).

const THUMBNAIL_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
// Bigger images aren't worth decoding just for a thumbnail.
const MAX_THUMBNAIL_SOURCE_BYTES = 50 * 1024 * 1024;

const streamToBuffer = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
};

const makeThumbnail = async (file) => {
    const source = await streamToBuffer(await storage.openStream(file.storedName));
    const image = sharp(source, { limitInputPixels: 100_000_000, failOn: "error" });
    const meta = await image.metadata();
    const thumbnail = await image
        .rotate() // honor the camera's orientation
        .resize({ width: config.thumbnails.width, withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
    const thumbnailKey = `${file.storedName}.thumb.webp`;
    await storage.put(thumbnailKey, thumbnail, "image/webp");
    // EXIF orientations 5-8 are rotated 90 degrees: width and height swap.
    const rotated = meta.orientation >= 5;
    return { thumbnailKey, width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height };
};

const setFileFields = (shareId, fileId, fields) =>
    Share.updateOne(
        { _id: shareId, "files._id": fileId },
        { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`files.$.${k}`, v])) }
    );

const block = async (share, file, signature, log) => {
    await setFileFields(share._id, file._id, { scanStatus: "infected" });
    log.warn({ event: "share.blocked", shareId: share._id, fileId: file._id, signature }, "Malware found; share blocked");
    notifyShare(share, "share:blocked", { fileName: file.originalName, signature });
    await publish("share.blocked", {
        shareId: String(share._id),
        code: share.code,
        ownerId: share.ownerId ? String(share.ownerId) : null,
        fileName: file.originalName,
        signature,
    });
    await endShares([share], "malware");
};

const handle = async (message, { log }) => {
    const share = await Share.findById(message.data.shareId).lean();
    if (!share || share.endedAt) return; // ended (or deleted) in the meantime

    for (const file of share.files) {
        if (share.processing && file.scanStatus === "pending") {
            const { infected, signature } = await scanner.scanStream(await storage.openStream(file.storedName));
            if (infected) return block(share, file, signature, log);
            await setFileFields(share._id, file._id, { scanStatus: "clean" });
        }

        if (THUMBNAIL_TYPES.has(file.mimeType) && !file.thumbnailKey && file.size <= MAX_THUMBNAIL_SOURCE_BYTES) {
            try {
                await setFileFields(share._id, file._id, await makeThumbnail(file));
            } catch (err) {
                log.warn({ err, event: "thumbnail.failed", fileId: file._id }, "Couldn't make a thumbnail");
            }
        }
    }

    if (share.processing) {
        const ready = await Share.findOneAndUpdate(
            { _id: share._id, endedAt: null, processing: true },
            { $set: { processing: false } },
            { new: true }
        );
        if (ready) {
            log.info({ event: "share.ready", shareId: share._id, files: share.files.length }, "Files scanned clean; share is live");
            notifyShare(ready, "share:ready");
            notifyShare(ready, "share:created");
        }
    }
};

module.exports = { queue: "sr.processing", handle, makeThumbnail };
