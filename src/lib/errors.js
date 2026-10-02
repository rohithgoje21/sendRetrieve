const multer = require("multer");
const config = require("../config");

class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

const multerMessages = {
    LIMIT_FILE_SIZE: `Each file must be ${Math.round(config.limits.maxFileSize / 1024 / 1024)} MB or smaller`,
    LIMIT_FILE_COUNT: `You can send up to ${config.limits.maxFiles} files at once`,
    LIMIT_UNEXPECTED_FILE: "Unexpected file field",
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
    if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    if (err instanceof multer.MulterError) {
        const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({ error: multerMessages[err.code] || err.message });
    }
    // Errors raised by Express/body-parser/send carry a 4xx status.
    if (err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ error: err.expose ? err.message : "Bad request" });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
};

module.exports = { HttpError, errorHandler };
