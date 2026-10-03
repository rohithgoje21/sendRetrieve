class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

const errorHandler = (err, req, res, next) => {
    // Too late to send an error (e.g. a download stream failed midway).
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) {
        if (err.extra.retryAfterSeconds) res.set("Retry-After", String(err.extra.retryAfterSeconds));
        return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    // Errors raised by Express/body-parser/send carry a 4xx status.
    if (err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ error: err.expose ? err.message : "Bad request" });
    }
    // The request logger picks this up and logs it, with the stack, on the
    // request's own log line.
    res.err = err;
    res.status(500).json({
        error: "Something went wrong. Please try again.",
        // Lets a user quote the ID so the matching log line can be found.
        requestId: req.id,
    });
};

module.exports = { HttpError, errorHandler };
