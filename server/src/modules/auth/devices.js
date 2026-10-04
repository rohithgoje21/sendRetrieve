const net = require("net");

// What the sessions list shows about a device: "Edge on Windows", a desktop.
// Parsed from the User-Agent header, which browsers still send in full
// enough detail for this. Order matters: Edge and Opera also claim to be
// Chrome, and Chrome claims to be Safari.
const BROWSERS = [
    [/EdgA?\/|Edg(iOS)?\//, "Edge"],
    [/OPR\/|Opera/, "Opera"],
    [/SamsungBrowser\//, "Samsung Internet"],
    [/Firefox\/|FxiOS\//, "Firefox"],
    [/Chrome\/|CriOS\//, "Chrome"],
    [/Safari\//, "Safari"],
];
const SYSTEMS = [
    [/iPhone|iPod/, "iOS"],
    [/iPad/, "iPadOS"],
    [/Android/, "Android"],
    [/CrOS/, "ChromeOS"],
    [/Windows/, "Windows"],
    [/Mac OS X|Macintosh/, "macOS"],
    [/Linux/, "Linux"],
];

const firstMatch = (list, text) => list.find(([pattern]) => pattern.test(text))?.[1] ?? null;

const describeDevice = (userAgent = "") => {
    const ua = String(userAgent).slice(0, 512);
    let type = "desktop";
    if (/iPad|Tablet|Android(?!.*Mobile)/.test(ua)) type = "tablet";
    else if (/Mobi|iPhone|iPod|Android/.test(ua)) type = "mobile";
    else if (!ua) type = "unknown";
    return { browser: firstMatch(BROWSERS, ua), os: firstMatch(SYSTEMS, ua), type };
};

// "Edge on Windows", "Safari on iOS", "Unknown device"
const deviceLabel = ({ browser, os } = {}) =>
    browser && os ? `${browser} on ${os}` : browser || os || "Unknown device";

// Only the network part of an address is kept (203.0.113.* or 2001:db8:85a3::*):
// enough to tell "home" from "somewhere else", without storing where exactly
// someone was.
const maskIp = (ip) => {
    if (!ip) return null;
    const address = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
    if (net.isIPv4(address)) return `${address.split(".").slice(0, 3).join(".")}.*`;
    if (net.isIPv6(address)) {
        const [head] = address.split("::");
        return `${head.split(":").slice(0, 3).filter(Boolean).join(":")}::*`;
    }
    return null;
};

module.exports = { describeDevice, deviceLabel, maskIp };
