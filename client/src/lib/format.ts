export const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

export const formatDateTime = (iso: string): string =>
    new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const formatDate = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 24 * 3600],
    ["month", 30 * 24 * 3600],
    ["week", 7 * 24 * 3600],
    ["day", 24 * 3600],
    ["hour", 3600],
    ["minute", 60],
];

// "in 5 hours", "2 days ago", "just now"
export const formatRelative = (iso: string, now = Date.now()): string => {
    const seconds = (new Date(iso).getTime() - now) / 1000;
    for (const [unit, size] of UNITS) {
        if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
    }
    return seconds > 0 ? "in under a minute" : "just now";
};

// Time left for an upload: "a few seconds left", "about 3 min left", "about 2 h 5 min left"
export const formatTimeLeft = (seconds: number): string => {
    if (seconds < 10) return "a few seconds left";
    if (seconds < 60) return `about ${Math.round(seconds / 10) * 10} s left`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `about ${minutes} min left`;
    const hours = Math.floor(minutes / 60);
    return `about ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""} left`;
};

export const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
    `${count} ${count === 1 ? singular : plural}`;

// Share codes use these characters only (no 0/O, 1/I/L).
const NOT_CODE_CHAR = /[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/g;
export const CODE_LENGTH = 8;

// "7KX92PMQ" -> "7KX9-2PMQ"
export const formatCode = (code: string): string =>
    code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

// For the code input: uppercase, drop characters a code can't contain, add the dash.
export const normalizeCodeInput = (value: string): string =>
    formatCode(value.toUpperCase().replace(NOT_CODE_CHAR, "").slice(0, CODE_LENGTH));

export const stripCode = (value: string): string => value.replace(/-/g, "");
