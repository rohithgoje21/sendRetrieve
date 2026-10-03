const express = require("express");
const contentDisposition = require("content-disposition");
const Share = require("../shares/share.model");
const { verifyDownloadToken } = require("./linkTokens");
const { storage } = require("../../infrastructure/storage");
const { HttpError } = require("../../shared/errors");
const { limiter } = require("../../shared/rateLimit");
const { PREVIEWABLE_TYPES, liveFilter, NOT_FOUND_MESSAGE } = require("../shares/shares.service");
const { notifyShare } = require("../realtime/realtime");

// GET /api/files/:token: a download link handed out when a share is opened.
// Checks the share is still live, counts the download, then hands over the
// file: a redirect to a signed storage URL (S3) or the file itself (disk).
const createDownloadsRouter = (ctx) => {
    const router = express.Router();

    router.get(
        "/files/:token",
        limiter(ctx, { name: "download", limit: 300, error: "Too many downloads. Please wait a few minutes." }),
        async (req, res) => {
            const claims = verifyDownloadToken(req.params.token);
            if (!claims) {
                throw new HttpError(404, "This download link has expired. Open the share again to get a new one.");
            }

            const share = await Share.findOne({ code: claims.code, ...liveFilter() });
            const file = share?.files.id(claims.fileId);
            if (!file) throw new HttpError(404, NOT_FOUND_MESSAGE);

            // Thumbnails (images, made by the processing worker): small, inline,
            // not counted as downloads.
            if (req.query.thumb === "1") {
                if (!file.thumbnailKey) throw new HttpError(404, "No thumbnail for this file");
                return storage.sendDownload(res, {
                    key: file.thumbnailKey,
                    contentType: "image/webp",
                    contentDisposition: contentDisposition(`${file.originalName}.webp`, { type: "inline" }),
                });
            }

            const inline = req.query.inline === "1" && PREVIEWABLE_TYPES.has(file.mimeType);
            if (!inline) {
                const updated = await Share.findOneAndUpdate(
                    { _id: share._id, "files._id": file._id },
                    { $inc: { "files.$.downloads": 1 } },
                    { new: true, projection: { files: 1 } }
                );
                req.log.info({ event: "file.downloaded", shareId: share._id, fileId: file._id }, "File downloaded");
                notifyShare(share, "file:downloaded", {
                    fileId: file._id,
                    fileName: file.originalName,
                    downloads: updated?.files.id(file._id)?.downloads ?? file.downloads + 1,
                });
            }

            await storage.sendDownload(res, {
                key: file.storedName,
                contentType: inline ? file.mimeType : "application/octet-stream",
                contentDisposition: contentDisposition(file.originalName, { type: inline ? "inline" : "attachment" }),
            });
        }
    );

    return router;
};

module.exports = { createDownloadsRouter };
