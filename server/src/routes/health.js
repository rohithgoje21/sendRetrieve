const express = require("express");
const mongoose = require("mongoose");

const CHECK_TIMEOUT_MS = 2000;

const check = (promise) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS);
    });
    return Promise.race([promise, timeout])
        .then(() => "up", () => "down")
        .finally(() => clearTimeout(timer));
};

// GET /healthz for Docker, Railway and uptime monitors.
//   200 ok        everything is up
//   200 degraded  Redis is down (the app still works; limits fail open) or
//                 object storage is down (text shares still work)
//   503           MongoDB is down, or the server is shutting down
const createHealthRouter = (ctx) => {
    const router = express.Router();

    router.get("/healthz", async (req, res) => {
        const mongo =
            mongoose.connection.readyState === 1 ? await check(mongoose.connection.db.admin().ping()) : "down";
        const [redis, storage] = await Promise.all([
            ctx.redis ? check(ctx.redis.ping()) : "disabled",
            ctx.storage.health(),
        ]);
        const shuttingDown = Boolean(req.app.locals.shuttingDown);

        let status = "ok";
        if (shuttingDown) status = "shutting_down";
        else if (mongo === "down") status = "down";
        else if (redis === "down" || storage === "down") status = "degraded";

        res.set("Cache-Control", "no-store");
        res.status(status === "ok" || status === "degraded" ? 200 : 503).json({
            status,
            mongo,
            redis,
            storage,
            uptimeSeconds: Math.round(process.uptime()),
        });
    });

    return router;
};

module.exports = { createHealthRouter };
