const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const config = require("../../config");
const Share = require("./share.model");
const schemas = require("./shares.schemas");
const { generateCode, normalizeCode } = require("./codes");
const { storage, storageKey } = require("../../infrastructure/storage");
const { HEAD_BYTES, resolveFileType } = require("../files/fileType");
const { HttpError } = require("../../shared/errors");
const { validateBody } = require("../../shared/validate");
const { limiter } = require("../../shared/rateLimit");
const { optionalAuth } = require("../auth/middleware");
const { createManageToken, manageTokenMatches } = require("./manageToken");
const { baseUrl } = require("../../shared/urls");
const { PREVIEWABLE_TYPES, liveFilter, serializeFile, discardShares, NOT_FOUND_MESSAGE } = require("./shares.service");
const { notifyShare } = require("../realtime/realtime");
const scanner = require("../../infrastructure/clamav");
const { publish } = require("../../infrastructure/queue");

const UPLOAD_NOT_FOUND_MESSAGE = "This upload has expired or was already completed.";

// Guest shares have no history to keep, so they get a purge date right away
// as a backstop for the cleanup job.
const GUEST_PURGE_DELAY_MS = 60 * 60 * 1000;

// Strip control characters and path separators; keep the name readable.
const cleanFileName = (name) =>
    name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 255) || "file";

// A declared type is only a hint (the real one is detected after upload), but
// it's signed into the upload URL, so keep it to something header-safe.
const cleanContentType = (type) => (/^[\w.+-]+\/[\w.+-]+$/.test(type) ? type.toLowerCase() : "application/octet-stream");

const insertWithUniqueCode = async (doc) => {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            return await Share.create({ ...doc, code: generateCode() });
        } catch (err) {
            if (err.code !== 11000) throw err; // duplicate code: try another
        }
    }
    throw new Error("Could not generate a unique share code");
};

const shareSummary = (req, share) => ({
    code: share.code,
    url: `${baseUrl(req)}/s/${share.code}`,
    expiresAt: share.expiresAt,
    maxViews: share.maxViews,
    passwordProtected: Boolean(share.passwordHash),
    fileCount: share.files.length,
    owned: Boolean(share.ownerId),
});

const logCreated = (req, share) =>
    req.log.info(
        {
            event: "share.created",
            shareId: share._id,
            owned: Boolean(share.ownerId),
            fileCount: share.files.length,
            totalBytes: share.files.reduce((sum, f) => sum + f.size, 0),
            hasText: Boolean(share.text),
            durationSeconds: share.durationSeconds,
            maxViews: share.maxViews,
            passwordProtected: Boolean(share.passwordHash),
        },
        "Share created"
    );

// ---- Multipart (resumable) uploads ----
// Files bigger than the part size are uploaded in parts, each to its own
// signed URL, so a failed part is retried alone and an interrupted upload
// resumes where it stopped. Storage keeps track of which parts arrived.

// S3 allows at most 10,000 parts per upload.
const MAX_PARTS = 10_000;
const MB = 1024 * 1024;
// The configured part size, or bigger (whole MB) for a file so huge it
// would need more parts than that.
const partSizeFor = (size) => {
    const needed = Math.ceil(size / MAX_PARTS);
    return needed <= config.uploads.partSize ? config.uploads.partSize : Math.ceil(needed / MB) * MB;
};
const partCount = (file) => Math.max(1, Math.ceil(file.size / file.upload.partSize));
const partSizeOf = (file, partNumber) => {
    const count = partCount(file);
    return partNumber < count ? file.upload.partSize : file.size - file.upload.partSize * (count - 1);
};

// The parts storage holds for `file` that are complete (the right size), or
// null if the storage upload no longer exists.
const receivedParts = async (file) => {
    const parts = await storage.listUploadedParts({ key: file.storedName, uploadId: file.upload.uploadId });
    if (!parts) return null;
    const count = partCount(file);
    return parts.filter((p) => p.partNumber <= count && p.size === partSizeOf(file, p.partNumber));
};

// What the browser needs to upload a file: a signed URL for the whole file,
// or, for a big one, the part layout (part URLs come from .../parts).
const uploadTarget = async (file) =>
    file.upload
        ? { fileId: file._id, multipart: { partSize: file.upload.partSize, partCount: partCount(file) } }
        : {
              fileId: file._id,
              multipart: null,
              ...(await storage.createUploadTarget({ key: file.storedName, size: file.size, contentType: file.mimeType })),
          };

// Upload activity pushes a pending share's deadline out (to an hour from
// now), up to a maximum after the share was created. Returns the deadline.
const extendUploadDeadline = async (share) => {
    const deadline = new Date(
        Math.min(
            Date.now() + config.uploadWindowSeconds * 1000,
            share.createdAt.getTime() + config.maxUploadWindowSeconds * 1000
        )
    );
    if (deadline <= share.expiresAt) return share.expiresAt;
    await Share.updateOne(
        { _id: share._id, uploadPending: true },
        { $set: { expiresAt: deadline, ...(share.ownerId ? {} : { purgeAt: new Date(deadline.getTime() + GUEST_PURGE_DELAY_MS) }) } }
    );
    return deadline;
};

// Joins the parts of each multipart file into the stored file. Throws 409
// (with the missing part numbers) if a file isn't fully uploaded yet.
const finishMultipartUploads = async (share) => {
    for (const file of share.files.filter((f) => f.upload)) {
        const parts = await receivedParts(file);
        if (!parts) {
            // Already joined by an earlier /complete that didn't get to finish.
            if ((await storage.stat(file.storedName))?.size === file.size) continue;
            throw new HttpError(409, `"${file.originalName}" has to be uploaded again.`, { fileId: file._id });
        }
        const received = new Set(parts.map((p) => p.partNumber));
        const missingParts = [];
        for (let n = 1; n <= partCount(file); n++) if (!received.has(n)) missingParts.push(n);
        if (missingParts.length) {
            throw new HttpError(409, `"${file.originalName}" hasn't finished uploading.`, {
                fileId: file._id,
                missingParts: missingParts.slice(0, 100),
            });
        }
        await storage.completeMultipartUpload({ key: file.storedName, uploadId: file.upload.uploadId, parts });
    }
};

// A share whose upload is still in progress, if `manageToken` is its token.
const findPendingShare = async (code, manageToken) => {
    const normalized = normalizeCode(code);
    const share =
        normalized &&
        (await Share.findOne({ code: normalized, uploadPending: true, endedAt: null, expiresAt: { $gt: new Date() } }));
    if (!share || !manageTokenMatches(share, manageToken)) throw new HttpError(404, UPLOAD_NOT_FOUND_MESSAGE);
    return share;
};

// Checks each uploaded file against what was announced and detects its real
// type. Returns the files' new types, or throws (discarding the share if a
// file is an executable).
const verifyUploadedFiles = async (share) => {
    const checked = await Promise.all(
        share.files.map(async (file) => {
            const stat = await storage.stat(file.storedName);
            if (!stat) {
                throw new HttpError(409, `"${file.originalName}" hasn't finished uploading.`, { fileId: file._id });
            }
            if (stat.size !== file.size) {
                throw new HttpError(409, `"${file.originalName}" didn't upload correctly. Try again.`, { fileId: file._id });
            }
            const head = await storage.readStart(file.storedName, HEAD_BYTES);
            return {
                file,
                ...resolveFileType({
                    declared: file.mimeType,
                    head,
                    previewable: PREVIEWABLE_TYPES,
                    blockExecutables: config.blockExecutables,
                }),
            };
        })
    );

    const blocked = checked.find((c) => c.blocked);
    if (blocked) {
        await discardShares([share]);
        throw new HttpError(
            422,
            `"${blocked.file.originalName}" is a program (executable). Executable files can't be shared.`,
            { fileId: blocked.file._id }
        );
    }
    return checked.map(({ file, mimeType }) => ({ ...file.toObject(), mimeType }));
};

// Counts one view. Returns the share's state after the view, or null if a
// concurrent request used up the last one first.
const consumeView = async (share) => {
    if (share.viewsRemaining === null) {
        const updated = await Share.findOneAndUpdate({ _id: share._id }, { $inc: { views: 1 } }, { new: true });
        return { viewsRemaining: null, views: updated.views, expiresAt: share.expiresAt };
    }

    const updated = await Share.findOneAndUpdate(
        { _id: share._id, viewsRemaining: { $gt: 0 } },
        { $inc: { viewsRemaining: -1, views: 1 } },
        { new: true }
    );
    if (!updated) return null;

    let { expiresAt } = updated;
    if (updated.viewsRemaining === 0) {
        // Last view: keep the share only long enough for its download links.
        const graceEnd = new Date(Date.now() + config.downloadWindowSeconds * 1000);
        if (graceEnd < expiresAt) {
            expiresAt = graceEnd;
            await Share.updateOne({ _id: share._id }, { expiresAt });
        }
    }
    return { viewsRemaining: updated.viewsRemaining, views: updated.views, expiresAt };
};

const createSharesRouter = (ctx) => {
    const router = express.Router();

    // Step 1: create the share. Without files it's ready at once. With files,
    // the response includes a signed upload URL per file; the browser uploads
    // straight to storage, then calls /complete.
    router.post(
        "/shares",
        limiter(ctx, { name: "create-share", limit: 30, error: "Too many shares created. Please wait a few minutes." }),
        optionalAuth,
        validateBody(schemas.createShare),
        async (req, res) => {
            const { text, expiresIn, maxViews, password, files } = req.body;
            if (!text && files.length === 0) throw new HttpError(400, "Add some text or at least one file");
            const blocked = files.findIndex((f) => config.blockedExtensions.includes(f.name.split(".").pop().toLowerCase()));
            if (blocked !== -1) {
                const { name } = files[blocked];
                throw new HttpError(400, `"${name}" can't be shared: .${name.split(".").pop().toLowerCase()} files are programs or scripts.`, {
                    field: `files.${blocked}.name`,
                });
            }

            const shareId = new mongoose.Types.ObjectId();
            const fileDocs = await Promise.all(
                files.map(async (f) => {
                    const fileId = new mongoose.Types.ObjectId();
                    const doc = {
                        _id: fileId,
                        originalName: cleanFileName(f.name),
                        storedName: storageKey(shareId, fileId),
                        size: f.size,
                        mimeType: cleanContentType(f.type),
                    };
                    if (f.size > config.uploads.partSize) {
                        const uploadId = await storage.createMultipartUpload({ key: doc.storedName, contentType: doc.mimeType });
                        doc.upload = { uploadId, partSize: partSizeFor(f.size) };
                    }
                    return doc;
                })
            );

            const durationSeconds = config.expiryOptions[expiresIn];
            const pending = fileDocs.length > 0;
            // While uploading, expiresAt is the upload deadline; the chosen
            // expiry starts once the upload completes.
            const expiresAt = new Date(Date.now() + (pending ? config.uploadWindowSeconds : durationSeconds) * 1000);
            const { token: manageToken, hash: manageTokenHash } = createManageToken();

            const share = await insertWithUniqueCode({
                _id: shareId,
                ownerId: req.user?._id ?? null,
                text,
                files: fileDocs,
                passwordHash: password ? await bcrypt.hash(password, config.bcryptRounds) : null,
                maxViews,
                viewsRemaining: maxViews,
                expiresAt,
                durationSeconds,
                uploadPending: pending,
                manageTokenHash,
                purgeAt: req.user ? null : new Date(expiresAt.getTime() + GUEST_PURGE_DELAY_MS),
            });

            const uploads = await Promise.all(share.files.map(uploadTarget));

            if (!pending) {
                logCreated(req, share);
                notifyShare(share, "share:created");
            }
            res.status(201).json({
                ...shareSummary(req, share),
                status: pending ? "uploading" : "ready",
                manageToken,
                uploads,
                uploadExpiresAt: pending ? share.expiresAt : null,
            });
        }
    );

    // Step 3: the browser has uploaded every file. Check them and open the
    // share for business.
    router.post(
        "/shares/:code/complete",
        limiter(ctx, { name: "complete-share", limit: 60, error: "Too many requests. Please wait a few minutes." }),
        validateBody(schemas.manageShare),
        async (req, res) => {
            // Already completed: a retry after the response got lost. Same answer.
            const code = normalizeCode(req.params.code);
            const existing = code && (await Share.findOne({ code, uploadPending: false, endedAt: null }));
            if (existing && manageTokenMatches(existing, req.body.manageToken)) {
                return res.json({ ...shareSummary(req, existing), status: existing.processing ? "processing" : "ready" });
            }

            const share = await findPendingShare(req.params.code, req.body.manageToken);
            await finishMultipartUploads(share);
            const files = await verifyUploadedFiles(share);

            // With a scanner, the share waits ("processing") until the processing
            // worker has scanned every file clean; without one it's live now.
            const scanning = scanner.enabled();
            const expiresAt = new Date(Date.now() + share.durationSeconds * 1000);
            const completed = await Share.findOneAndUpdate(
                { _id: share._id, uploadPending: true },
                {
                    $set: {
                        uploadPending: false,
                        processing: scanning,
                        files: files.map((f) => ({ ...f, upload: null, scanStatus: scanning ? "pending" : "skipped" })),
                        expiresAt,
                        purgeAt: share.ownerId ? null : new Date(expiresAt.getTime() + GUEST_PURGE_DELAY_MS),
                    },
                },
                { new: true }
            );
            if (!completed) throw new HttpError(404, UPLOAD_NOT_FOUND_MESSAGE);

            logCreated(req, completed);
            await publish("share.uploaded", { shareId: String(completed._id), code: completed.code, scan: scanning });
            if (!scanning) notifyShare(completed, "share:created");
            res.json({ ...shareSummary(req, completed), status: scanning ? "processing" : "ready" });
        }
    );

    // Step 2b, for big files: signed URLs for some of a file's parts. The
    // browser asks for more as it goes (they're short-lived).
    router.post(
        "/shares/:code/uploads/:fileId/parts",
        limiter(ctx, { name: "upload-parts", limit: 600, error: "Too many requests. Please wait a few minutes." }),
        validateBody(schemas.uploadParts),
        async (req, res) => {
            const share = await findPendingShare(req.params.code, req.body.manageToken);
            const file = mongoose.isValidObjectId(req.params.fileId) ? share.files.id(req.params.fileId) : null;
            if (!file?.upload) throw new HttpError(404, "There's no upload in parts for this file.");
            const count = partCount(file);
            if (req.body.partNumbers.some((n) => n > count)) {
                throw new HttpError(400, `This file has ${count} part${count === 1 ? "" : "s"}.`, { field: "partNumbers" });
            }

            const uploadExpiresAt = await extendUploadDeadline(share);
            const parts = await Promise.all(
                req.body.partNumbers.map(async (partNumber) => ({
                    partNumber,
                    ...(await storage.signUploadPart({
                        key: file.storedName,
                        uploadId: file.upload.uploadId,
                        partNumber,
                        size: partSizeOf(file, partNumber),
                    })),
                }))
            );
            res.json({ parts, uploadExpiresAt });
        }
    );

    // Picking up an interrupted upload (lost connection, closed tab): what's
    // already stored, and fresh upload URLs for what isn't.
    router.post(
        "/shares/:code/resume",
        limiter(ctx, { name: "resume-upload", limit: 120, error: "Too many requests. Please wait a few minutes." }),
        validateBody(schemas.manageShare),
        async (req, res) => {
            const share = await findPendingShare(req.params.code, req.body.manageToken);
            const uploadExpiresAt = await extendUploadDeadline(share);

            const files = await Promise.all(
                share.files.map(async (file) => {
                    const about = { name: file.originalName, size: file.size };
                    if (!file.upload) {
                        const uploaded = (await storage.stat(file.storedName))?.size === file.size;
                        return { ...(uploaded ? { fileId: file._id, multipart: null } : await uploadTarget(file)), ...about, uploaded };
                    }

                    let parts = await receivedParts(file);
                    if (!parts) {
                        // The storage upload is gone (e.g. cleaned up): start this file over.
                        const uploadId = await storage.createMultipartUpload({ key: file.storedName, contentType: file.mimeType });
                        await Share.updateOne({ _id: share._id, "files._id": file._id }, { $set: { "files.$.upload.uploadId": uploadId } });
                        file.upload.uploadId = uploadId;
                        parts = [];
                    }
                    const target = await uploadTarget(file);
                    return {
                        ...target,
                        ...about,
                        uploaded: parts.length === partCount(file),
                        multipart: { ...target.multipart, uploadedParts: parts.map((p) => p.partNumber) },
                    };
                })
            );

            res.set("Cache-Control", "no-store");
            res.json({ code: share.code, status: "uploading", uploadExpiresAt, files });
        }
    );

    // The sender gave up (or the upload failed): delete what was uploaded.
    router.post(
        "/shares/:code/cancel",
        limiter(ctx, { name: "cancel-share", limit: 60, error: "Too many requests. Please wait a few minutes." }),
        validateBody(schemas.manageShare),
        async (req, res) => {
            const share = await findPendingShare(req.params.code, req.body.manageToken);
            await discardShares([share]);
            req.log.info({ event: "share.upload_cancelled", shareId: share._id }, "Upload cancelled");
            res.status(204).end();
        }
    );

    router.post(
        "/shares/:code/open",
        limiter(ctx, { name: "open-share", limit: 60, error: "Too many attempts. Please wait a few minutes." }),
        validateBody(schemas.openShare),
        async (req, res) => {
            const code = normalizeCode(req.params.code);
            if (!code) throw new HttpError(404, NOT_FOUND_MESSAGE);

            const share = await Share.findOne({
                code,
                ...liveFilter(),
                $or: [{ viewsRemaining: null }, { viewsRemaining: { $gt: 0 } }],
            });
            if (!share) throw new HttpError(404, NOT_FOUND_MESSAGE);

            if (share.passwordHash) {
                const { password } = req.body;
                if (!password) {
                    throw new HttpError(401, "This share is password protected", { passwordRequired: true });
                }

                const shareId = String(share._id);
                await ctx.attempts.assertNotLocked("share", shareId, "Too many wrong passwords for this share.");
                if (!(await bcrypt.compare(password, share.passwordHash))) {
                    const locked = await ctx.attempts.recordFailure("share", shareId);
                    req.log.warn({ event: "share.password_failed", shareId }, "Wrong share password");
                    if (locked) req.log.warn({ event: "share.locked", shareId }, "Share locked after repeated wrong passwords");
                    throw new HttpError(401, "Incorrect password", { passwordRequired: true });
                }
                await ctx.attempts.reset("share", shareId);
            }

            const state = await consumeView(share);
            if (!state) throw new HttpError(404, NOT_FOUND_MESSAGE);
            req.log.info(
                { event: "share.opened", shareId: share._id, viewsRemaining: state.viewsRemaining },
                "Share opened"
            );
            notifyShare(share, "share:opened", {
                views: state.views,
                maxViews: share.maxViews,
                viewsRemaining: state.viewsRemaining,
            });

            res.set("Cache-Control", "no-store");
            res.json({
                code,
                text: share.text,
                files: share.files.map((f) => serializeFile(code, f)),
                createdAt: share.createdAt,
                expiresAt: state.expiresAt,
                viewsRemaining: state.viewsRemaining,
                downloadWindowSeconds: config.downloadWindowSeconds,
            });
        }
    );

    return router;
};

module.exports = { createSharesRouter };
