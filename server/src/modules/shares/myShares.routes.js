const express = require("express");
const config = require("../../config");
const Share = require("./share.model");
const { HttpError } = require("../../shared/errors");
const { normalizeCode } = require("./codes");
const { baseUrl } = require("../../shared/urls");
const { requireAuth } = require("../auth/middleware");
const { serializeOwnedShare, shareStatus, endShares } = require("./shares.service");
const { PATTERNS } = require("../analytics/fileCategories");

const PAGE_SIZE = 20;
const STATUSES = ["active", "expired", "deleted"];

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Search and filters from the query string (all optional):
//   q          text in a file name or the message, or (part of) the code
//   kind       "files" | "text" (text-only shares)
//   fileType   image | video | audio | document | archive: has such a file
//   protected  "yes" | "no": password-protected or not
const searchFilter = (query) => {
    const and = [];
    const q = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
    if (q) {
        const contains = new RegExp(escapeRegex(q), "i");
        const code = q.replace(/[\s-]/g, "").toUpperCase();
        and.push({
            $or: [
                { "files.originalName": contains },
                { text: contains },
                ...(/^[A-Z0-9]{1,8}$/.test(code) ? [{ code: new RegExp(`^${code}`) }] : []),
            ],
        });
    }
    if (query.kind === "files") and.push({ "files.0": { $exists: true } });
    if (query.kind === "text") and.push({ files: { $size: 0 } });
    if (PATTERNS[query.fileType]) and.push({ files: { $elemMatch: { mimeType: PATTERNS[query.fileType] } } });
    if (query.protected === "yes") and.push({ passwordHash: { $ne: null } });
    if (query.protected === "no") and.push({ passwordHash: null });
    return and.length ? { $and: and } : {};
};

const SORTS = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    views: { views: -1, createdAt: -1 },
    downloads: { totalDownloads: -1, createdAt: -1 },
    size: { totalSize: -1, createdAt: -1 },
    expiring: { expiresAt: 1 },
};

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

    // A page of shares in one tab (active, expired, deleted), searched,
    // filtered and sorted; counts per tab follow the same search.
    router.get("/", async (req, res) => {
        const status = STATUSES.includes(req.query.status) ? req.query.status : "active";
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const sort = SORTS[req.query.sort] ? req.query.sort : "newest";
        const search = searchFilter(req.query);
        const match = (s) => ({ $and: [statusFilter(req.user._id, s), search] });

        const [shares, ...counts] = await Promise.all([
            Share.aggregate([
                { $match: match(status) },
                {
                    $addFields: {
                        totalSize: { $sum: "$files.size" },
                        totalDownloads: { $sum: "$files.downloads" },
                    },
                },
                { $sort: SORTS[sort] },
                { $skip: (page - 1) * PAGE_SIZE },
                { $limit: PAGE_SIZE + 1 },
            ]),
            ...STATUSES.map((s) => Share.countDocuments(match(s))),
        ]);

        const base = baseUrl(req);
        res.set("Cache-Control", "no-store");
        res.json({
            status,
            sort,
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
            // Its files are already deleted, or about to be by the cleanup worker.
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
