const config = require("../../config");

// The storage driver for this process, chosen by config.storage.driver.
//
// Every driver provides:
//   driver, publicOrigin                       name; origin browsers load files from (CSP)
//   init(), health()                           startup check; "up" | "down" | "disk"
//   createUploadTarget({ key, size, contentType })  -> { method, url, headers } for the browser
//   stat(key)                                  -> { size } | null
//   readStart(key, bytes)                      -> first bytes, to detect the real file type
//   openStream(key), put(key, body, type)      whole-file stream (scanning); store a small object (thumbnails)
//   sendDownload(res, { key, contentType, contentDisposition })
//   delete(keys), list()                       cleanup; list() yields { key, modifiedAt }
// The disk driver also has receiveUpload(req, { key, size }) behind /api/uploads.

const createStorage = () => {
    switch (config.storage.driver) {
        case "s3":
            return require("./s3").createS3Storage();
        case "disk":
            return require("./disk").createDiskStorage();
        default:
            throw new Error(`Unknown STORAGE_DRIVER "${config.storage.driver}" (use "s3" or "disk")`);
    }
};

const storage = createStorage();

// Where a share's file is stored. IDs, not names: nothing guessable, nothing
// user-controlled in the path.
const storageKey = (shareId, fileId) => `shares/${shareId}/${fileId}`;

module.exports = { storage, storageKey };
