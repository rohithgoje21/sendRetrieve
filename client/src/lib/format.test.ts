import { formatCode, formatRelative, formatSize, normalizeCodeInput, pluralize, stripCode } from "./format";

describe("formatSize", () => {
    test.each([
        [0, "0 B"],
        [1023, "1023 B"],
        [1536, "1.5 KB"],
        [50 * 1024 * 1024, "50 MB"],
        [3.2 * 1024 ** 3, "3.2 GB"],
    ])("%d bytes -> %s", (bytes, expected) => {
        expect(formatSize(bytes)).toBe(expected);
    });
});

describe("share codes", () => {
    test("formatCode adds the dash", () => {
        expect(formatCode("7KX92PMQ")).toBe("7KX9-2PMQ");
    });

    test("normalizeCodeInput uppercases, drops impossible characters and limits length", () => {
        expect(normalizeCodeInput("7kx9")).toBe("7KX9");
        expect(normalizeCodeInput("7kx92")).toBe("7KX9-2");
        expect(normalizeCodeInput(" 7kx9-2pmq ")).toBe("7KX9-2PMQ");
        expect(normalizeCodeInput("7KX92PMQEXTRA")).toBe("7KX9-2PMQ");
        // 0, O, 1, I, L never appear in codes
        expect(normalizeCodeInput("O0I1L7KX")).toBe("7KX");
    });

    test("stripCode removes the dash", () => {
        expect(stripCode("7KX9-2PMQ")).toBe("7KX92PMQ");
    });
});

describe("formatRelative", () => {
    const now = new Date("2026-06-01T12:00:00Z").getTime();
    test.each([
        ["2026-06-01T17:00:00Z", "in 5 hours"],
        ["2026-05-30T12:00:00Z", "2 days ago"],
        ["2026-06-01T12:00:20Z", "in under a minute"],
        ["2026-06-01T11:59:40Z", "just now"],
        ["2026-06-01T12:00:00Z", "just now"],
    ])("%s -> %s", (iso, expected) => {
        expect(formatRelative(iso, now)).toBe(expected);
    });
});

test("pluralize", () => {
    expect(pluralize(1, "view")).toBe("1 view");
    expect(pluralize(3, "view")).toBe("3 views");
});
