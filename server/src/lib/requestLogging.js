const crypto = require("crypto");
const pinoHttp = require("pino-http");
const { logger: defaultLogger } = require("./logger");

// URLs carry secrets: share codes, download tokens, reset tokens (?token=).
// Log the route's shape instead of the value, and drop query strings.
const SECRET_ROUTES = [
    [/^\/api\/shares\/[^/]+\/(open|complete|cancel)$/, "/api/shares/:code/$1"],
    [/^\/api\/files\/[^/]+$/, "/api/files/:token"],
    [/^\/api\/uploads\/[^/]+$/, "/api/uploads/:token"],
    [/^\/api\/me\/shares\/[^/]+$/, "/api/me/shares/:code"],
    [/^\/api\/admin\/shares\/[^/]+$/, "/api/admin/shares/:code"],
    [/^\/s\/[^/]+$/, "/s/:code"],
];

const redactPath = (url = "") => {
    const path = url.split("?")[0];
    for (const [pattern, replacement] of SECRET_ROUTES) {
        if (pattern.test(path)) return path.replace(pattern, replacement);
    }
    return path;
};

const STATIC_ASSET = /\.(css|js|svg|ico|png|map|txt)$/;
// Accept a request ID from a proxy if it looks sane; otherwise make one.
const INCOMING_REQUEST_ID = /^[\w.-]{8,128}$/;

// Logs one line per request (method, route, status, duration, user) and gives
// each request an ID: returned in X-Request-Id, attached to every log line the
// request produces (req.log), and included in 500 responses.
const createRequestLogger = (logger = defaultLogger) =>
    pinoHttp({
        logger,
        quietReqLogger: true, // event logs via req.log carry just the reqId
        genReqId: (req, res) => {
            const incoming = req.headers["x-request-id"];
            const id = typeof incoming === "string" && INCOMING_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
            res.setHeader("X-Request-Id", id);
            return id;
        },
        autoLogging: {
            ignore: (req) => {
                const path = req.url.split("?")[0];
                return path === "/healthz" || STATIC_ASSET.test(path);
            },
        },
        customLogLevel: (req, res, err) => {
            if (err || res.statusCode >= 500) return "error";
            if (res.statusCode === 429) return "warn";
            return "info";
        },
        customSuccessMessage: (req, res, responseTime) =>
            `${req.method} ${redactPath(req.originalUrl)} ${res.statusCode} ${responseTime}ms`,
        customErrorMessage: (req, res) => `${req.method} ${redactPath(req.originalUrl)} ${res.statusCode}`,
        // Evaluated when the response finishes, after auth has run.
        customProps: (req) => (req.user ? { userId: String(req.user._id) } : {}),
        serializers: {
            req: (req) => ({
                method: req.method,
                path: redactPath(req.url),
                ip: req.raw.ip,
                userAgent: req.headers["user-agent"],
            }),
            res: (res) => ({ statusCode: res.statusCode }),
        },
    });

module.exports = { createRequestLogger, redactPath };
