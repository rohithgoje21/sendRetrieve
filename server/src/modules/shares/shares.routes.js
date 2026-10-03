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

            const shareId = new mongoose.Types.ObjectId();
            const fileDocs = files.map((f) => {
                const fileId = new mongoose.Types.ObjectId();
                return {
                    _id: fileId,
                    originalName: cleanFileName(f.name),
                    storedName: storageKey(shareId, fileId),
                    size: f.size,
                    mimeType: cleanContentType(f.type),
                };
            });

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

            const uploads = await Promise.all(
                share.files.map(async (f) => ({
                    fileId: f._id,
                    ...(await storage.createUploadTarget({ key: f.storedName, size: f.size, contentType: f.mimeType })),
                }))
            );

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
            const share = await findPendingShare(req.params.code, req.body.manageToken);
            const files = await verifyUploadedFiles(share);

            const expiresAt = new Date(Date.now() + share.durationSeconds * 1000);
            const completed = await Share.findOneAndUpdate(
                { _id: share._id, uploadPending: true },
                {
                    $set: {
                        uploadPending: false,
                        files,
                        expiresAt,
                        purgeAt: share.ownerId ? null : new Date(expiresAt.getTime() + GUEST_PURGE_DELAY_MS),
                    },
                },
                { new: true }
            );
            if (!completed) throw new HttpError(404, UPLOAD_NOT_FOUND_MESSAGE);

            logCreated(req, completed);
            notifyShare(completed, "share:created");
            res.json({ ...shareSummary(req, completed), status: "ready" });
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
