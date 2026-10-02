const pino = require("pino");
const config = require("../config");

// JSON logs in production (one object per line, ready for a log service);
// pretty, colored output when running in a terminal during development.
const canPrettyPrint = () => {
    if (!process.stdout.isTTY || config.env === "production" || config.env === "test") return false;
    if (process.env.LOG_FORMAT === "json") return false;
    try {
        require.resolve("pino-pretty");
        return true;
    } catch {
        return false; // dev dependency not installed
    }
};

// `destination` and `level` let tests capture output.
const createLogger = (destination, { level = config.logLevel } = {}) =>
    pino(
        {
            level,
            // Our serializers never include these, but an error object or a
            // careless log call might.
            redact: {
                paths: [
                    "password",
                    "*.password",
                    "token",
                    "*.token",
                    "text",
                    "*.text",
                    "req.headers.cookie",
                    "req.headers.authorization",
                    'res.headers["set-cookie"]',
                ],
                censor: "[redacted]",
            },
            transport:
                !destination && canPrettyPrint()
                    ? { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } }
                    : undefined,
        },
        destination
    );

const logger = createLogger();

module.exports = { logger, createLogger };
