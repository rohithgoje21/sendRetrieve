const express = require("express");
const { verifyUploadToken } = require("../lib/tokens");
const { HttpError } = require("../lib/errors");
const { limiter } = require("../lib/rateLimit");

// PUT /api/uploads/:token: the disk driver's stand-in for a signed S3 upload
// URL. The token (from POST /api/shares) names the file's storage key and
// exact size; the body is the raw file. Mounted before the JSON body parser,
// so a .json file isn't parsed as a request body.
const createUploadsRouter = (ctx, storage) => {
    const router = express.Router();

    router.put(
        "/:token",
        limiter(ctx, { name: "upload", limit: 300, error: "Too many uploads. Please wait a few minutes." }),
        async (req, res) => {
            const claims = verifyUploadToken(req.params.token);
            if (!claims) throw new HttpError(403, "This upload link is invalid or has expired.");
            await storage.receiveUpload(req, claims);
            res.status(200).end();
        }
    );

    return router;
};

module.exports = { createUploadsRouter };
