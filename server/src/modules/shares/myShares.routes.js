const express = require("express");
const config = require("../../config");
const Share = require("./share.model");
const { HttpError } = require("../../shared/errors");
const { normalizeCode } = require("./codes");
const { storage } = require("../../infrastructure/storage");
const { baseUrl } = require("../../shared/urls");
const { requireAuth } = require("../auth/middleware");
const { serializeOwnedShare, shareStatus, endShares } = require("./shares.service");

const PAGE_SIZE = 20;
const STATUSES = ["active", "expired", "deleted"];

// Shares still uploading aren't listed: they appear once the upload completes
// (or are cleaned up if it never does).
const statusFilter = (ownerId, status) => {
    const now = new Date();
    const base = { ownerId, uploadPending: { $ne: true } };
    switch (status) {
        case "active":
            return { ...base, endedAt: null, expiresAt: { $gt: now } };
        case "expired":
            return {
                ...base,
                $or: [{ endedReason: { $in: ["expired", "used_up"] } }, { endedAt: null, expiresAt: { $lte: now } }],
            };
        case "deleted":
            return { ...base, endedReason: { $in: ["deleted", "removed"] } };
    }
};

// /api/me/shares: the signed-in user's own shares.
const createMySharesRouter = () => {
    const router = express.Router();
    router.use(requireAuth);

    router.get("/", async (req, res) => {
        const status = STATUSES.includes(req.query.status) ? req.query.status : "active";
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

        const [shares, ...counts] = await Promise.all([
            Share.find(statusFilter(req.user._id, status))
                .sort({ createdAt: -1 })
                .skip((page - 1) * PAGE_SIZE)
                .limit(PAGE_SIZE + 1),
            ...STATUSES.map((s) => Share.countDocuments(statusFilter(req.user._id, s))),
        ]);

        const base = baseUrl(req);
        res.set("Cache-Control", "no-store");
        res.json({
            status,
            page,
            hasMore: shares.length > PAGE_SIZE,
            shares: shares.slice(0, PAGE_SIZE).map((s) => serializeOwnedShare(s, base)),
            counts: Object.fromEntries(STATUSES.map((s, i) => [s, counts[i]])),
        });
    });

    const findOwnedShare = async (req) => {
        const code = normalizeCode(req.params.code);
        const share = code && (await Share.findOne({ code, ownerId: req.user._id, uploadPending: { $ne: true } }));
        // 404 rather than 403 for other people's shares: don't confirm they exist.
        if (!share) throw new HttpError(404, "Share not found");
        return share;
    };

    // The owner can see their own share's content without using up a view.
    router.get("/:code", async (req, res) => {
        const share = await findOwnedShare(req);
        res.set("Cache-Control", "no-store");
        res.json({
            share: serializeOwnedShare(share, baseUrl(req), { includeContent: true }),
            downloadWindowSeconds: config.downloadWindowSeconds,
        });
    });

    // Active share: stop it now (it moves to "Deleted").
    // Ended share: remove it from history for good.
    router.delete("/:code", async (req, res) => {
        const share = await findOwnedShare(req);
        const wasActive = shareStatus(share) === "active";
        if (wasActive) {
            await endShares([share], "deleted");
        } else {
            await storage.delete(share.files.map((f) => f.storedName));
            await Share.deleteOne({ _id: share._id });
        }
        req.log.info(
            { event: wasActive ? "share.deleted" : "share.removed_from_history", shareId: share._id },
            wasActive ? "Share deleted by owner" : "Ended share removed from history"
        );
        res.status(204).end();
    });

    return router;
};

module.exports = { createMySharesRouter };
