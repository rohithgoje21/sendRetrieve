const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const config = require("../config");

// All file I/O goes through this module so the disk can later be swapped for
// object storage (S3/R2) without touching the routes.

fs.mkdirSync(config.uploadDir, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: config.uploadDir,
        // Random names: no collisions, no path tricks, nothing guessable.
        filename: (req, file, cb) => cb(null, crypto.randomUUID()),
    }),
    // Browsers send filenames as raw UTF-8; the latin1 default garbles "résumé.pdf".
    defParamCharset: "utf8",
    limits: {
        fileSize: config.limits.maxFileSize,
        files: config.limits.maxFiles,
        fields: 10,
    },
});

const filePath = (storedName) => path.join(config.uploadDir, path.basename(storedName));

const deleteFiles = async (storedNames) => {
    await Promise.all(
        storedNames.map((name) =>
            fs.promises.unlink(filePath(name)).catch((err) => {
                if (err.code !== "ENOENT") throw err;
            })
        )
    );
};

const listStoredFiles = async () => {
    const names = await fs.promises.readdir(config.uploadDir);
    return Promise.all(
        names.map(async (name) => {
            const stat = await fs.promises.stat(filePath(name));
            return { name, modifiedAt: stat.mtime };
        })
    );
};

module.exports = { upload, filePath, deleteFiles, listStoredFiles };
