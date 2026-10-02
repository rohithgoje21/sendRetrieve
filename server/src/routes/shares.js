const express = require("express");
const bcrypt = require("bcryptjs");
const contentDisposition = require("content-disposition");
const config = require("../config");
const Share = require("../models/Share");
const schemas = require("../lib/schemas");
const { generateCode, normalizeCode } = require("../lib/codes");
const { verifyDownloadToken } = require("../lib/tokens");
const { upload, filePath, deleteFiles } = require("../lib/storage");
const { HttpError } = require("../lib/errors");
const { parse, validateBody } = require("../lib/validate");
const { limiter } = require("../lib/rateLimit");
const { optionalAuth } = require("../lib/auth");
const { baseUrl } = require("../lib/urls");
const { PREVIEWABLE_TYPES, liveFilter, serializeFile } = require("../lib/shares");

const NOT_FOUND_MESSAGE = "Share not found. It may have expired or reached its view limit.";

// Guest shares have no history to keep, so they get a purge date right away
// as a backstop for the cleanup job.
const GUEST_PURGE_DELAY_MS = 60 * 60 * 1000;

// Strip control characters and path separators; keep the name readable.
const cleanFileName = (name) =>
    name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 255) || "file";

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

// Counts one view. Returns the share's state after the view, or null if a
// concurrent request used up the last one first.
const consumeView = async (share) => {
    if (share.viewsRemaining === null) {
        await Share.updateOne({ _id: share._id }, { $inc: { views: 1 } });
        return { viewsRemaining: null, expiresAt: share.expiresAt };
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
    return { viewsRemaining: updated.viewsRemaining, expiresAt };
};

const createSharesRouter = (ctx) => {
    const router = express.Router();

    router.post(
        "/shares",
        limiter(ctx, { name: "create-share", limit: 30, error: "Too many shares created. Please wait a few minutes." }),
        optionalAuth,
        upload.array("files", config.limits.maxFiles),
        async (req, res) => {
            const uploaded = req.files || [];
            try {
                const { text, expiresIn, maxViews, password } = parse(schemas.createShare, req.body);
                if (!text && uploaded.length === 0) {
                    throw new HttpError(400, "Add some text or at least one file");
                }

                const expiresAt = new Date(Date.now() + config.expiryOptions[expiresIn] * 1000);
                const share = await insertWithUniqueCode({
                    ownerId: req.user?._id ?? null,
                    text,
                    files: uploaded.map((f) => ({
                        originalName: cleanFileName(f.originalname),
                        storedName: f.filename,
                        size: f.size,
                        mimeType: f.mimetype || "application/octet-stream",
                    })),
                    passwordHash: password ? await bcrypt.hash(password, config.bcryptRounds) : null,
                    maxViews,
                    viewsRemaining: maxViews,
                    expiresAt,
                    purgeAt: req.user ? null : new Date(expiresAt.getTime() + GUEST_PURGE_DELAY_MS),
                });

                req.log.info(
                    {
                        event: "share.created",
                        shareId: share._id,
                        owned: Boolean(req.user),
                        fileCount: share.files.length,
                        totalBytes: share.files.reduce((sum, f) => sum + f.size, 0),
                        hasText: Boolean(text),
                        expiresIn,
                        maxViews,
                        passwordProtected: Boolean(password),
                    },
                    "Share created"
                );

                res.status(201).json({
                    code: share.code,
                    url: `${baseUrl(req)}/s/${share.code}`,
                    expiresAt: share.expiresAt,
                    maxViews,
                    passwordProtected: Boolean(password),
                    fileCount: share.files.length,
                    owned: Boolean(req.user),
                });
            } catch (err) {
                await deleteFiles(uploaded.map((f) => f.filename)).catch(() => {});
                throw err;
            }
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

            const inline = req.query.inline === "1" && PREVIEWABLE_TYPES.has(file.mimeType);
            if (!inline) {
                await Share.updateOne(
                    { _id: share._id, "files._id": file._id },
                    { $inc: { "files.$.downloads": 1 } }
                );
                req.log.info({ event: "file.downloaded", shareId: share._id, fileId: file._id }, "File downloaded");
            }

            res.sendFile(filePath(file.storedName), {
                headers: {
                    "Content-Type": inline ? file.mimeType : "application/octet-stream",
                    "Content-Disposition": contentDisposition(file.originalName, {
                        type: inline ? "inline" : "attachment",
                    }),
                    "Cache-Control": "private, no-store",
                },
            });
        }
    );

    return router;
};

module.exports = { createSharesRouter };
