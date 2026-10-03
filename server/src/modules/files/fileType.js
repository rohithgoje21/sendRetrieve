// Identifies a file's real type from its first bytes ("magic numbers"),
// because the browser-reported type is whatever the sender says it is: an
// HTML page renamed to photo.png still claims to be image/png.
//
// Covers every type the app previews inline, executables (which can be
// refused), and a few common formats. Anything else is "unknown".

const HEAD_BYTES = 4100;

const bytesAt = (buf, offset, bytes) => bytes.every((b, i) => buf[offset + i] === b);
const asciiAt = (buf, offset, text) => buf.length >= offset + text.length && buf.toString("latin1", offset, offset + text.length) === text;

// ISO base media (MP4, MOV, AVIF, M4A): "ftyp" at byte 4, then a brand.
const ftypBrand = (buf) => (asciiAt(buf, 4, "ftyp") ? buf.toString("latin1", 8, 12) : null);

const SIGNATURES = [
    // Executables
    { mime: "application/x-msdownload", executable: true, test: (b) => asciiAt(b, 0, "MZ") },
    { mime: "application/x-elf", executable: true, test: (b) => bytesAt(b, 0, [0x7f, 0x45, 0x4c, 0x46]) },
    {
        mime: "application/x-mach-binary",
        executable: true,
        test: (b) =>
            [
                [0xfe, 0xed, 0xfa, 0xce],
                [0xfe, 0xed, 0xfa, 0xcf],
                [0xce, 0xfa, 0xed, 0xfe],
                [0xcf, 0xfa, 0xed, 0xfe],
            ].some((magic) => bytesAt(b, 0, magic)),
    },

    // Images
    { mime: "image/png", test: (b) => bytesAt(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { mime: "image/jpeg", test: (b) => bytesAt(b, 0, [0xff, 0xd8, 0xff]) },
    { mime: "image/gif", test: (b) => asciiAt(b, 0, "GIF87a") || asciiAt(b, 0, "GIF89a") },
    { mime: "image/webp", test: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WEBP") },
    { mime: "image/avif", test: (b) => ["avif", "avis"].includes(ftypBrand(b)) },

    // Audio
    { mime: "audio/wav", test: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WAVE") },
    { mime: "audio/mp4", test: (b) => ["M4A ", "M4B "].includes(ftypBrand(b)) },
    { mime: "audio/ogg", test: (b) => asciiAt(b, 0, "OggS") },
    // AAC (ADTS): 12-bit sync, layer bits 00. Must come before MP3.
    { mime: "audio/aac", test: (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0 },
    // MP3: ID3 tag, or an MPEG audio frame (11-bit sync, non-zero layer)
    { mime: "audio/mpeg", test: (b) => asciiAt(b, 0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0) },

    // Video
    {
        mime: "video/webm",
        test: (b) => bytesAt(b, 0, [0x1a, 0x45, 0xdf, 0xa3]) && b.subarray(0, 64).includes("webm"),
    },
    { mime: "video/x-matroska", test: (b) => bytesAt(b, 0, [0x1a, 0x45, 0xdf, 0xa3]) },
    { mime: "video/quicktime", test: (b) => ftypBrand(b) === "qt  " },
    { mime: "video/mp4", test: (b) => ftypBrand(b) !== null },

    // Documents and archives
    { mime: "application/pdf", test: (b) => asciiAt(b, 0, "%PDF-") },
    { mime: "application/zip", test: (b) => bytesAt(b, 0, [0x50, 0x4b, 0x03, 0x04]) || bytesAt(b, 0, [0x50, 0x4b, 0x05, 0x06]) },
    { mime: "application/gzip", test: (b) => bytesAt(b, 0, [0x1f, 0x8b]) },
    { mime: "application/x-7z-compressed", test: (b) => bytesAt(b, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
    { mime: "application/vnd.rar", test: (b) => asciiAt(b, 0, "Rar!\x1a\x07") },
];

// Returns { mime, executable } for a recognized type, or null.
const detectFileType = (head) => {
    const match = SIGNATURES.find((sig) => sig.test(head));
    return match ? { mime: match.mime, executable: Boolean(match.executable) } : null;
};

// Decides which type to store for an uploaded file:
//   - recognized executable        -> { blocked } (if blocking is on)
//   - recognized type              -> the detected type
//   - unrecognized, and the sender claims a type we'd show inline (image,
//     video, audio)                -> application/octet-stream: never render
//                                     a claim we couldn't confirm
//   - otherwise                    -> the claimed type (e.g. a .docx's type,
//                                     which is only used for the file icon)
const resolveFileType = ({ declared, head, previewable, blockExecutables }) => {
    const detected = detectFileType(head);
    if (detected?.executable && blockExecutables) return { blocked: true, mimeType: detected.mime };
    if (detected) {
        // Containers like ZIP also hold .docx/.xlsx; keep a more specific claim.
        const generic = detected.mime === "application/zip" && declared && !previewable.has(declared);
        return { blocked: false, mimeType: generic ? declared : detected.mime };
    }
    if (!declared || previewable.has(declared)) return { blocked: false, mimeType: "application/octet-stream" };
    return { blocked: false, mimeType: declared };
};

module.exports = { HEAD_BYTES, detectFileType, resolveFileType };
