const express = require("express");
const Share = require("../shares/share.model");
const { HttpError } = require("../../shared/errors");
const { normalizeCode } = require("../shares/codes");
const { requireAuth } = require("../auth/middleware");
const { ownerAnalytics, shareAnalytics } = require("./analytics.service");

const PERIODS = [7, 30, 90];
const periodParam = (req) => {
    const days = Number.parseInt(req.query.days, 10);
    return PERIODS.includes(days) ? days : 30;
};

// /api/me/analytics: statistics for the signed-in user's shares.
const createAnalyticsRouter = () => {
    const router = express.Router();
    router.use(requireAuth);

    router.get("/", async (req, res) => {
        res.set("Cache-Control", "no-store");
        res.json(await ownerAnalytics(req.user._id, periodParam(req)));
    });

    router.get("/shares/:code", async (req, res) => {
        const code = normalizeCode(req.params.code);
        const share = code && (await Share.findOne({ code, ownerId: req.user._id }));
        if (!share) throw new HttpError(404, "Share not found");
        res.set("Cache-Control", "no-store");
        res.json(await shareAnalytics(share, periodParam(req)));
    });

    return router;
};

module.exports = { createAnalyticsRouter, periodParam };
