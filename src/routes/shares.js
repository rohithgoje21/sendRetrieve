const express = require("express");
const bcrypt = require("bcryptjs");
const contentDisposition = require("content-disposition");
const { rateLimit } = require("express-rate-limit");
const config = require("../config");
const Share = require("../models/Share");
const { generateCode, normalizeCode } = require("../lib/codes");
const { createDownloadToken, verifyDownloadToken } = require("../lib/tokens");
const { upload, filePath, deleteFiles } = require("../lib/storage");
const { HttpError } = require("../lib/errors");

// Only types a browser renders as media are ever served inline. Everything
// else (HTML, SVG, PDF, ...) is forced to download so an uploaded file can't
// run script on this origin.
const PREVIEWABLE_TYPES = new Set([
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
    "video/mp4", "video/webm", "video/ogg",
    "audio/mpeg", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "audio/mp4", "audio/aac",
]);

const NOT_FOUND_MESSAGE = "Share not found. It may have expired or reached its view limit.";

const limiter = (enabled, limit, error) =>
    rateLimit({
        windowMs: 15 * 60 * 1000,
        limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        message: { error },
        skip: () => !enabled,
    });

// Strip control characters and path separators; keep the name readable.
const cleanFileName = (name) =>
    name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 255) || "file";

const parseShareOptions = (body) => {
    const { limits, expiryOptions, defaultExpiry, viewLimitOptions } = config;

    const text = typeof body.text === "string" && body.text.trim() ? body.text : null;
    if (text && text.length > limits.maxTextLength) {
        throw new HttpError(400, `Text must be ${limits.maxTextLength.toLocaleString()} characters or fewer`);
    }

    const expiresIn = body.expiresIn || defaultExpiry;
    if (!Object.hasOwn(expiryOptions, expiresIn)) {
        throw new HttpError(400, `expiresIn must be one of: ${Object.keys(expiryOptions).join(", ")}`);
    }

    let maxViews = null;
    if (body.maxViews && body.maxViews !== "unlimited") {
        maxViews = Number(body.maxViews);
        if (!viewLimitOptions.includes(maxViews)) {
            throw new HttpError(400, `maxViews must be one of: unlimited, ${viewLimitOptions.join(", ")}`);
        }
    }

    const password = typeof body.password === "string" && body.password !== "" ? body.password : null;
    if (password && (password.length < limits.minPasswordLength || password.length > limits.maxPasswordLength)) {
        throw new HttpError(
            400,
            `Password must be ${limits.minPasswordLength}-${limits.maxPasswordLength} characters`
        );
    }

    return { text, expiresIn, maxViews, password };
};

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

const createSharesRouter = ({ rateLimit: rateLimitEnabled = true } = {}) => {
    const router = express.Router();

    router.post(
        "/shares",
        limiter(rateLimitEnabled, 30, "Too many shares created. Please wait a few minutes."),
        upload.array("files", config.limits.maxFiles),
        async (req, res) => {
            const uploaded = req.files || [];
            try {
                const { text, expiresIn, maxViews, password } = parseShareOptions(req.body || {});
                if (!text && uploaded.length === 0) {
                    throw new HttpError(400, "Add some text or at least one file");
                }

                const share = await insertWithUniqueCode({
                    text,
                    files: uploaded.map((f) => ({
                        originalName: cleanFileName(f.originalname),
                        storedName: f.filename,
                        size: f.size,
                        mimeType: f.mimetype || "application/octet-stream",
                    })),
                    passwordHash: password ? await bcrypt.hash(password, 10) : null,
                    viewsRemaining: maxViews,
                    expiresAt: new Date(Date.now() + config.expiryOptions[expiresIn] * 1000),
                });

                res.status(201).json({
                    code: share.code,
                    url: `${req.protocol}://${req.get("host")}/s/${share.code}`,
                    expiresAt: share.expiresAt,
                    maxViews,
                    passwordProtected: Boolean(password),
                    fileCount: share.files.length,
                });
            } catch (err) {
                await deleteFiles(uploaded.map((f) => f.filename)).catch(() => {});
                throw err;
            }
        }
    );

    router.post(
        "/shares/:code/open",
        limiter(rateLimitEnabled, 60, "Too many attempts. Please wait a few minutes."),
        async (req, res) => {
            const code = normalizeCode(req.params.code);
            if (!code) throw new HttpError(404, NOT_FOUND_MESSAGE);

            const share = await Share.findOne({
                code,
                expiresAt: { $gt: new Date() },
                $or: [{ viewsRemaining: null }, { viewsRemaining: { $gt: 0 } }],
            });
            if (!share) throw new HttpError(404, NOT_FOUND_MESSAGE);

            if (share.passwordHash) {
                const password = req.body?.password;
                if (typeof password !== "string" || password === "") {
                    throw new HttpError(401, "This share is password protected", { passwordRequired: true });
                }
                if (!(await bcrypt.compare(password, share.passwordHash))) {
                    throw new HttpError(401, "Incorrect password", { passwordRequired: true });
                }
            }

            const state = await consumeView(share);
            if (!state) throw new HttpError(404, NOT_FOUND_MESSAGE);

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
        limiter(rateLimitEnabled, 300, "Too many downloads. Please wait a few minutes."),
        async (req, res) => {
            const claims = verifyDownloadToken(req.params.token);
            if (!claims) {
                throw new HttpError(404, "This download link has expired. Open the share again to get a new one.");
            }

            const share = await Share.findOne({ code: claims.code, expiresAt: { $gt: new Date() } });
            const file = share?.files.id(claims.fileId);
            if (!file) throw new HttpError(404, NOT_FOUND_MESSAGE);

            const inline = req.query.inline === "1" && PREVIEWABLE_TYPES.has(file.mimeType);
            if (!inline) {
                await Share.updateOne(
                    { _id: share._id, "files._id": file._id },
                    { $inc: { "files.$.downloads": 1 } }
                );
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
