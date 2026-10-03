const Share = require("../modules/shares/share.model");
const { storage } = require("../infrastructure/storage");

// sr.cleanup: deletes a share's files from storage once it has ended (or its
// upload was abandoned, in which case multipart uploads still in progress are
// aborted too), then finishes the share's lifecycle:
//   owned share   filesState -> "deleted" (kept in the owner's history)
//   guest share   record removed
// Deleting is idempotent, so a redelivered or replayed message is harmless.
// If storage is down, the job fails and the queue retries it with backoff.
const handle = async (message, { log }) => {
    const { keys = [], uploads = [], shareId } = message.data;
    for (const upload of uploads) await storage.abortMultipartUpload(upload);
    if (keys.length) await storage.delete(keys);

    if (message.type === "share.ended" && shareId) {
        const share = await Share.findById(shareId, { ownerId: 1 }).lean();
        if (share?.ownerId) await Share.updateOne({ _id: share._id }, { filesState: "deleted" });
        else if (share) await Share.deleteOne({ _id: share._id });
    }
    log.info({ event: "cleanup.files_deleted", type: message.type, files: keys.length }, "Deleted stored files");
};

module.exports = { queue: "sr.cleanup", handle };
