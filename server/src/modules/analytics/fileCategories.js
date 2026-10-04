// Coarse file categories for statistics and filters, by MIME type.
const PATTERNS = {
    image: /^image\//,
    video: /^video\//,
    audio: /^audio\//,
    document: /^text\/|pdf|msword|officedocument|opendocument|rtf|epub|json|xml|csv|presentation|spreadsheet/,
    archive: /zip|gzip|x-7z|rar|x-tar|bzip|compressed/,
};

const CATEGORIES = [...Object.keys(PATTERNS), "other"];

const categoryOf = (mimeType = "") => Object.keys(PATTERNS).find((c) => PATTERNS[c].test(mimeType)) ?? "other";

module.exports = { CATEGORIES, PATTERNS, categoryOf };
