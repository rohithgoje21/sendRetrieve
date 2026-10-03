const { detectFileType, resolveFileType } = require("../src/modules/files/fileType");

const bytes = (...parts) =>
    Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));

const PREVIEWABLE = new Set(["image/png", "image/jpeg", "video/mp4", "audio/mpeg"]);
const resolve = (declared, head, blockExecutables = true) =>
    resolveFileType({ declared, head, previewable: PREVIEWABLE, blockExecutables });

describe("detectFileType", () => {
    test.each([
        ["PNG", bytes([0x89], "PNG\r\n\x1a\n", "rest"), "image/png"],
        ["JPEG", bytes([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
        ["GIF", bytes("GIF89a..."), "image/gif"],
        ["WebP", bytes("RIFF\0\0\0\0WEBPVP8 "), "image/webp"],
        ["AVIF", bytes([0, 0, 0, 0x1c], "ftypavif"), "image/avif"],
        ["MP4", bytes([0, 0, 0, 0x18], "ftypisom"), "video/mp4"],
        ["MOV", bytes([0, 0, 0, 0x14], "ftypqt  "), "video/quicktime"],
        ["M4A", bytes([0, 0, 0, 0x20], "ftypM4A "), "audio/mp4"],
        ["WebM", bytes([0x1a, 0x45, 0xdf, 0xa3], "\x9fB\x86\x81\x01B\xf7\x81\x01B\xf2\x81\x04B\xf3\x81\x08B\x82\x84webm"), "video/webm"],
        ["MKV", bytes([0x1a, 0x45, 0xdf, 0xa3], "\x9fB\x82\x88matroska"), "video/x-matroska"],
        ["MP3 (ID3)", bytes("ID3\x04\0"), "audio/mpeg"],
        ["MP3 (frame)", bytes([0xff, 0xfb, 0x90, 0x64]), "audio/mpeg"],
        ["AAC", bytes([0xff, 0xf1, 0x50, 0x80]), "audio/aac"],
        ["WAV", bytes("RIFF\0\0\0\0WAVEfmt "), "audio/wav"],
        ["Ogg", bytes("OggS\0\x02"), "audio/ogg"],
        ["PDF", bytes("%PDF-1.7\n"), "application/pdf"],
        ["ZIP", bytes("PK\x03\x04\x14\0"), "application/zip"],
        ["gzip", bytes([0x1f, 0x8b, 0x08]), "application/gzip"],
    ])("%s", (_, head, mime) => {
        expect(detectFileType(head)).toEqual({ mime, executable: false });
    });

    test.each([
        ["Windows (MZ)", bytes("MZ\x90\0\x03\0")],
        ["Linux (ELF)", bytes([0x7f], "ELF\x02\x01")],
        ["macOS (Mach-O 64)", bytes([0xcf, 0xfa, 0xed, 0xfe, 0x07])],
    ])("executable: %s", (_, head) => {
        expect(detectFileType(head)).toMatchObject({ executable: true });
    });

    test("plain text, HTML, SVG and empty files are unknown", () => {
        for (const head of [bytes("hello world"), bytes("<!doctype html><script>"), bytes("<svg xmlns="), Buffer.alloc(0)]) {
            expect(detectFileType(head)).toBeNull();
        }
    });
});

describe("resolveFileType", () => {
    const png = bytes([0x89], "PNG\r\n\x1a\n");

    test("the detected type wins over the claimed one", () => {
        expect(resolve("image/jpeg", png)).toEqual({ blocked: false, mimeType: "image/png" });
        expect(resolve("text/plain", bytes("%PDF-1.4"))).toEqual({ blocked: false, mimeType: "application/pdf" });
    });

    test("an unconfirmed claim to be media is downgraded, so it's never shown inline", () => {
        expect(resolve("image/png", bytes("<html><script>alert(1)</script>"))).toEqual({
            blocked: false,
            mimeType: "application/octet-stream",
        });
    });

    test("other unrecognized files keep their claimed type", () => {
        expect(resolve("text/csv", bytes("a,b\n1,2"))).toEqual({ blocked: false, mimeType: "text/csv" });
        expect(resolve("", bytes("anything"))).toEqual({ blocked: false, mimeType: "application/octet-stream" });
    });

    test("a ZIP keeps a more specific claim (e.g. .docx), but not a media claim", () => {
        const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        expect(resolve(docx, bytes("PK\x03\x04"))).toEqual({ blocked: false, mimeType: docx });
        expect(resolve("image/png", bytes("PK\x03\x04"))).toEqual({ blocked: false, mimeType: "application/zip" });
    });

    test("executables are blocked, whatever they claim to be", () => {
        expect(resolve("application/pdf", bytes("MZ\x90"))).toMatchObject({ blocked: true });
        expect(resolve("application/pdf", bytes("MZ\x90"), false)).toEqual({
            blocked: false,
            mimeType: "application/x-msdownload",
        });
    });
});
