import type { FileCategory } from "./types";

// Shared by the analytics pages and charts.

export const PERIODS = [7, 30, 90] as const;

export const CATEGORY_LABELS: Record<FileCategory, string> = {
    image: "Images",
    video: "Videos",
    audio: "Audio",
    document: "Documents",
    archive: "Archives",
    other: "Other",
};

export interface Series {
    key: string;
    label: string;
    // A CSS color, e.g. "var(--series-1)"
    color: string;
}

// Same color for the same measure everywhere: views, visitors, downloads.
export const ACTIVITY_SERIES: Series[] = [
    { key: "views", label: "Views", color: "var(--series-1)" },
    { key: "visitors", label: "Visitors", color: "var(--series-3)" },
    { key: "downloads", label: "Downloads", color: "var(--series-2)" },
];

// Round ticks for a byte axis, round in the unit shown (KB, MB...: 1024s).
export const niceByteTicks = (max: number): number[] => {
    const unit = max >= 1024 ? 1024 ** Math.min(3, Math.floor(Math.log(max) / Math.log(1024))) : 1;
    return niceTicks(max / unit).map((t) => t * unit);
};

// Round tick values from 0 to at least `max`: 0, 2,500, 5,000...
export const niceTicks = (max: number, count = 4): number[] => {
    if (max <= 0) return [0, 1];
    const raw = max / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
    const top = Math.ceil(max / step) * step;
    return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(10));
};
