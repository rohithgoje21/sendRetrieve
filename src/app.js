const path = require("path");
const express = require("express");
const helmet = require("helmet");
const config = require("./config");
const { createSharesRouter } = require("./routes/shares");
const { HttpError, errorHandler } = require("./lib/errors");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

const createApp = ({ rateLimit = true } = {}) => {
    const app = express();

    app.set("trust proxy", config.trustProxy);
    app.disable("x-powered-by");

    app.use(helmet());
    app.use(express.json({ limit: "10kb" }));

    app.use("/api", createSharesRouter({ rateLimit }));
    app.use("/api", () => {
        throw new HttpError(404, "Not found");
    });

    app.use(express.static(PUBLIC_DIR));
    // Share links: the page reads the code from the URL and pre-fills it.
    app.get("/s/:code", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

    app.use(errorHandler);
    return app;
};

module.exports = { createApp };
