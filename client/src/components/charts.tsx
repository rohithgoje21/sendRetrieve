import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { niceByteTicks, niceTicks, type Series } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { Card } from "./ui/feedback";
import { SegmentedControl } from "./ui/SegmentedControl";

// Small SVG charts for the analytics pages. House rules (see the dataviz
// checks in the repo history): one y-axis per chart, thin marks (2px lines,
// <= 24px bars with a 4px rounded end), hairline solid gridlines, text in text
// colors (never the series color), a legend for 2+ series, a hover/keyboard
// tooltip, and a table view so no value depends on hovering. Series colors are
// CSS variables (--series-1..3 in index.css), validated for both themes.

type Datum = { day: string } & Record<string, number | string>;

const MARGIN = { top: 12, right: 12, bottom: 24, left: 44 };

// Width of the element, kept current (jsdom has no ResizeObserver).
function useWidth<T extends HTMLElement>(fallback = 640) {
    const ref = useRef<T>(null);
    const [width, setWidth] = useState(fallback);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.floor(entry.contentRect.width))));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    return [ref, width] as const;
}

const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

function Legend({ series, shape }: { series: Series[]; shape: "line" | "rect" }) {
    return (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400" aria-label="Legend">
            {series.map((s) => (
                <li key={s.key} className="flex items-center gap-1.5">
                    <span
                        className={shape === "line" ? "h-0.5 w-3.5 rounded-full" : "size-2.5 rounded-sm"}
                        style={{ background: s.color }}
                        aria-hidden
                    />
                    {s.label}
                </li>
            ))}
        </ul>
    );
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
    // Keep it inside the chart: flip to the left of the pointer near the right edge.
    const left = x > width - 170 ? x - 162 : x + 12;
    return (
        <div
            role="status"
            className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900"
            style={{ left }}
        >
            {children}
        </div>
    );
}

// The same numbers as a table, for screen readers and anyone who'd rather read.
function TableView({ data, series, format }: { data: Datum[]; series: Series[]; format: (v: number) => string }) {
    return (
        <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300">Show as table</summary>
            <div className="mt-2 max-h-64 overflow-auto">
                <table className="w-full tabular-nums">
                    <thead>
                        <tr className="text-left text-zinc-500 dark:text-zinc-400">
                            <th className="py-1 pr-3 font-medium">Day</th>
                            {series.map((s) => (
                                <th key={s.key} className="py-1 pr-3 text-right font-medium">
                                    {s.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {data.map((d) => (
                            <tr key={d.day} className="border-t border-zinc-100 dark:border-zinc-800">
                                <td className="py-1 pr-3">{dayLabel(d.day)}</td>
                                {series.map((s) => (
                                    <td key={s.key} className="py-1 pr-3 text-right">
                                        {format(Number(d[s.key]))}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </details>
    );
}

// Shared frame: axes, gridlines, x labels (first, middle, last day).
function Frame({ width, height, ticks, y, data, x, format }: {
    width: number;
    height: number;
    ticks: number[];
    y: (v: number) => number;
    data: Datum[];
    x: (i: number) => number;
    format: (v: number) => string;
}) {
    const labelled = data.length > 2 ? [0, Math.floor((data.length - 1) / 2), data.length - 1] : data.map((_, i) => i);
    return (
        <g className="text-[10px]">
            {ticks.map((t) => (
                <g key={t}>
                    <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth={1} />
                    <text x={MARGIN.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fill="var(--chart-axis)" className="tabular-nums">
                        {format(t)}
                    </text>
                </g>
            ))}
            {labelled.map((i) => (
                <text
                    key={i}
                    x={x(i)}
                    y={height - 6}
                    textAnchor={i === 0 && data.length > 1 ? "start" : i === data.length - 1 && data.length > 1 ? "end" : "middle"}
                    fill="var(--chart-axis)"
                >
                    {dayLabel(data[i].day)}
                </text>
            ))}
        </g>
    );
}

// Values over time, one line per series, on one axis.
export function LineChart({
    data,
    series,
    format = (v) => v.toLocaleString(),
    height = 220,
    label,
}: {
    data: Datum[];
    series: Series[];
    format?: (v: number) => string;
    height?: number;
    label: string;
}) {
    const [ref, width] = useWidth<HTMLDivElement>();
    const [active, setActive] = useState<number | null>(null);
    const titleId = useId();
    const max = Math.max(0, ...data.flatMap((d) => series.map((s) => Number(d[s.key]))));
    const ticks = niceTicks(max);
    const top = ticks.at(-1) ?? 1;
    const plotW = width - MARGIN.left - MARGIN.right;
    const plotH = height - MARGIN.top - MARGIN.bottom;
    const x = (i: number) => MARGIN.left + (data.length > 1 ? (i * plotW) / (data.length - 1) : plotW / 2);
    const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;

    const pick = (clientX: number, rect: DOMRect) => {
        const rel = ((clientX - rect.left) / rect.width) * width - MARGIN.left;
        setActive(Math.max(0, Math.min(data.length - 1, Math.round((rel / plotW) * (data.length - 1)))));
    };
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? data.length) - 1));
        else if (e.key === "ArrowRight") setActive((a) => Math.min(data.length - 1, (a ?? -1) + 1));
        else if (e.key === "Escape") setActive(null);
        else return;
        e.preventDefault();
    };

    return (
        <figure aria-labelledby={titleId}>
            <figcaption id={titleId} className="sr-only">
                {label}
            </figcaption>
            {series.length > 1 && <Legend series={series} shape="line" />}
            <div
                ref={ref}
                className="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                role="group"
                tabIndex={0}
                aria-label={`${label}. Use the left and right arrow keys to read each day.`}
                onKeyDown={onKeyDown}
                onFocus={() => setActive((a) => a ?? data.length - 1)}
                onBlur={() => setActive(null)}
            >
                <svg
                    width="100%"
                    viewBox={`0 0 ${width} ${height}`}
                    className="block touch-none"
                    onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
                    onPointerLeave={() => setActive(null)}
                    aria-hidden
                >
                    <Frame width={width} height={height} ticks={ticks} y={y} data={data} x={x} format={format} />
                    {active !== null && (
                        <line x1={x(active)} x2={x(active)} y1={MARGIN.top} y2={MARGIN.top + plotH} stroke="var(--chart-axis)" strokeWidth={1} />
                    )}
                    {/* The first series is drawn last, so it's on top where lines meet. */}
                    {[...series].reverse().map((s) => (
                        <path
                            key={s.key}
                            d={data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(Number(d[s.key])).toFixed(1)}`).join("")}
                            fill="none"
                            stroke={s.color}
                            strokeWidth={2}
                            strokeLinejoin="round"
                            strokeLinecap="round"
                        />
                    ))}
                    {/* End dots, or the hovered day's dots, ringed in the surface color. */}
                    {[...series].reverse().map((s) => {
                        const i = active ?? data.length - 1;
                        return (
                            <circle
                                key={s.key}
                                cx={x(i)}
                                cy={y(Number(data[i]?.[s.key] ?? 0))}
                                r={4}
                                fill={s.color}
                                stroke="var(--chart-surface)"
                                strokeWidth={2}
                            />
                        );
                    })}
                </svg>
                {active !== null && data[active] && (
                    <Tooltip x={x(active)} width={width}>
                        <p className="mb-1 text-zinc-500 dark:text-zinc-400">{dayLabel(data[active].day)}</p>
                        {series.map((s) => (
                            <p key={s.key} className="flex items-center gap-2">
                                <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden />
                                <span className="font-semibold text-zinc-900 tabular-nums dark:text-zinc-100">{format(Number(data[active][s.key]))}</span>
                                <span className="text-zinc-500 dark:text-zinc-400">{s.label}</span>
                            </p>
                        ))}
                    </Tooltip>
                )}
            </div>
            <TableView data={data} series={series} format={format} />
        </figure>
    );
}

// One value per day as columns (a single series: the title names it).
export function ColumnChart({
    data,
    valueKey,
    label,
    format = (v) => v.toLocaleString(),
    height = 180,
    bytes = false,
}: {
    data: Datum[];
    valueKey: string;
    label: string;
    format?: (v: number) => string;
    height?: number;
    // Values are byte counts: ticks round in KB/MB
    bytes?: boolean;
}) {
    const [ref, width] = useWidth<HTMLDivElement>();
    const [active, setActive] = useState<number | null>(null);
    const titleId = useId();
    const max = Math.max(0, ...data.map((d) => Number(d[valueKey])));
    const ticks = bytes ? niceByteTicks(max) : niceTicks(max);
    const top = ticks.at(-1) ?? 1;
    const plotW = width - MARGIN.left - MARGIN.right;
    const plotH = height - MARGIN.top - MARGIN.bottom;
    const slot = plotW / Math.max(1, data.length);
    const barW = Math.max(2, Math.min(24, slot - 2));
    const x = (i: number) => MARGIN.left + slot * i + slot / 2;
    const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;
    const base = MARGIN.top + plotH;

    // A column with a 4px rounded top, square at the baseline.
    const column = (cx: number, value: number) => {
        const h = base - y(value);
        if (h <= 0) return "";
        const r = Math.min(4, h, barW / 2);
        const l = cx - barW / 2;
        const rt = cx + barW / 2;
        const t = base - h;
        return `M${l},${base}V${t + r}Q${l},${t} ${l + r},${t}H${rt - r}Q${rt},${t} ${rt},${t + r}V${base}Z`;
    };

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? data.length) - 1));
        else if (e.key === "ArrowRight") setActive((a) => Math.min(data.length - 1, (a ?? -1) + 1));
        else if (e.key === "Escape") setActive(null);
        else return;
        e.preventDefault();
    };

    return (
        <figure aria-labelledby={titleId}>
            <figcaption id={titleId} className="sr-only">
                {label}
            </figcaption>
            <div
                ref={ref}
                className="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                role="group"
                tabIndex={0}
                aria-label={`${label}. Use the left and right arrow keys to read each day.`}
                onKeyDown={onKeyDown}
                onFocus={() => setActive((a) => a ?? data.length - 1)}
                onBlur={() => setActive(null)}
            >
                <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="block" onPointerLeave={() => setActive(null)} aria-hidden>
                    <Frame width={width} height={height} ticks={ticks} y={y} data={data} x={x} format={format} />
                    {data.map((d, i) => (
                        <g key={d.day} onPointerEnter={() => setActive(i)}>
                            {/* The whole slot is the hit target, not just the bar. */}
                            <rect x={x(i) - slot / 2} y={MARGIN.top} width={slot} height={plotH} fill="transparent" />
                            <path d={column(x(i), Number(d[valueKey]))} fill="var(--series-1)" opacity={active === null || active === i ? 1 : 0.55} />
                        </g>
                    ))}
                </svg>
                {active !== null && data[active] && (
                    <Tooltip x={x(active)} width={width}>
                        <p className="mb-1 text-zinc-500 dark:text-zinc-400">{dayLabel(data[active].day)}</p>
                        <p className="font-semibold text-zinc-900 tabular-nums dark:text-zinc-100">{format(Number(data[active][valueKey]))}</p>
                    </Tooltip>
                )}
            </div>
            <TableView data={data} series={[{ key: valueKey, label, color: "var(--series-1)" }]} format={format} />
        </figure>
    );
}

// Categories compared by one value, largest first, every value labelled.
export function BarList({ items, label }: { items: { key: string; label: string; value: number; detail?: string }[]; label: string }) {
    const max = Math.max(1, ...items.map((i) => i.value));
    const sorted = [...items].sort((a, b) => b.value - a.value);
    return (
        <ul aria-label={label} className="space-y-2.5">
            {sorted.map((item) => (
                <li key={item.key} className="text-sm">
                    <div className="mb-1 flex items-baseline justify-between gap-3">
                        <span className="text-zinc-700 dark:text-zinc-300">{item.label}</span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                            <span className="font-semibold text-zinc-900 dark:text-zinc-100">{item.value.toLocaleString()}</span>
                            {item.detail && <> · {item.detail}</>}
                        </span>
                    </div>
                    <div className="h-2 rounded-r bg-transparent">
                        <div
                            className={cn("h-2 rounded-r-[4px]", item.value === 0 && "hidden")}
                            style={{ width: `${(item.value / max) * 100}%`, background: "var(--series-1)" }}
                        />
                    </div>
                </li>
            ))}
        </ul>
    );
}

export function ChartCard({ title, description, children, className }: { title: string; description?: string; children: ReactNode; className?: string }) {
    return (
        <Card className={cn("p-4 sm:p-5", className)}>
            <h2 className="font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{description}</p>}
            <div className="mt-3">{children}</div>
        </Card>
    );
}

// 7 / 30 / 90 days: the one filter above an analytics view.
export function PeriodPicker({ days, onChange, periods }: { days: number; onChange: (days: number) => void; periods: readonly number[] }) {
    return (
        <SegmentedControl
            label="Period"
            items={periods.map((d) => ({ key: String(d), label: `${d} days`, active: d === days, onSelect: () => onChange(d) }))}
        />
    );
}

// A headline number with its change against the previous period.
export function StatTile({
    label,
    value,
    previous,
    format = (v) => v.toLocaleString(),
    approximate,
    period,
}: {
    label: string;
    value: number;
    previous?: number;
    format?: (v: number) => string;
    approximate?: boolean;
    period?: string;
}) {
    const change = previous === undefined ? null : previous === 0 ? (value > 0 ? null : 0) : Math.round(((value - previous) / previous) * 100);
    return (
        <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{label}</p>
            <p className="mt-1.5 text-2xl font-semibold">
                {approximate && value > 0 && <span className="text-zinc-400">~</span>}
                {format(value)}
            </p>
            {previous !== undefined && (
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {change === null ? (
                        "new this period"
                    ) : (
                        <>
                            <span
                                className={cn(
                                    "font-medium",
                                    change > 0 && "text-emerald-700 dark:text-emerald-400",
                                    change < 0 && "text-red-700 dark:text-red-400"
                                )}
                            >
                                {change > 0 ? "▲" : change < 0 ? "▼" : ""} {change > 0 ? "+" : ""}
                                {change}%
                            </span>{" "}
                            vs {period ?? "previous period"}
                        </>
                    )}
                </p>
            )}
        </div>
    );
}
