import { Link, useSearchParams } from "react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Alert, Skeleton } from "@/components/ui/feedback";
import { BarList, ChartCard, ColumnChart, LineChart, PeriodPicker, StatTile } from "@/components/charts";
import { api } from "@/lib/api";
import { ACTIVITY_SERIES, CATEGORY_LABELS, PERIODS } from "@/lib/analytics";
import { formatCode, formatSize } from "@/lib/format";
import { analyticsKey } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { FileCategory, MyAnalytics } from "@/lib/types";

// The signed-in user's analytics: views, unique visitors, downloads and
// bandwidth over 7, 30 or 90 days, compared with the period before.
export default function AnalyticsPage() {
    const [params, setParams] = useSearchParams();
    const requested = Number(params.get("days"));
    const days = PERIODS.includes(requested as (typeof PERIODS)[number]) ? requested : 30;
    const { data, error, isPlaceholderData } = useQuery({
        queryKey: [...analyticsKey, "me", days],
        queryFn: () => api<MyAnalytics>(`/api/me/analytics?days=${days}`),
        placeholderData: keepPreviousData,
    });
    const period = `previous ${days} days`;

    return (
        <div className="space-y-4">
            <title>Analytics · sendRetrieve</title>
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">How your shares are being used.</p>
            </div>
            <PeriodPicker periods={PERIODS} days={days} onChange={(d) => setParams(d === 30 ? {} : { days: String(d) }, { replace: true })} />

            {error && <Alert tone="error">{error.message}</Alert>}
            {!data && !error && (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-24 rounded-2xl" />
                    ))}
                </div>
            )}

            {data && (
                // While another period loads, keep this one, dimmed.
                <div className={cn("space-y-4 transition-opacity", isPlaceholderData && "opacity-60")}>
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <StatTile label="Views" value={data.totals.views} previous={data.previous.views} period={period} />
                        <StatTile label="Unique visitors" value={data.totals.visitors} previous={data.previous.visitors} approximate period={period} />
                        <StatTile label="Downloads" value={data.totals.downloads} previous={data.previous.downloads} period={period} />
                        <StatTile label="Bandwidth" value={data.totals.bytes} previous={data.previous.bytes} format={formatSize} period={period} />
                    </div>

                    <ChartCard title="Activity" description="Views, unique visitors and downloads per day (UTC).">
                        <LineChart data={data.daily} series={ACTIVITY_SERIES} label={`Views, visitors and downloads per day, last ${days} days`} />
                    </ChartCard>

                    <ChartCard title="Bandwidth" description="Data downloaded from your shares per day.">
                        <ColumnChart data={data.daily} valueKey="bytes" label={`Bandwidth per day, last ${days} days`} format={formatSize} bytes />
                    </ChartCard>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <ChartCard title="What you shared" description={`Files in shares created in the last ${days} days.`}>
                            {Object.values(data.fileTypes).some((t) => t.files > 0) ? (
                                <BarList
                                    label="Files shared, by type"
                                    items={Object.entries(data.fileTypes)
                                        .filter(([, t]) => t.files > 0)
                                        .map(([key, t]) => ({ key, label: CATEGORY_LABELS[key as FileCategory], value: t.files, detail: formatSize(t.bytes) }))}
                                />
                            ) : (
                                <p className="text-sm text-zinc-500 dark:text-zinc-400">No files shared in this period.</p>
                            )}
                        </ChartCard>
                        <ChartCard title="What gets downloaded" description="Downloads by file type.">
                            {data.totals.downloads > 0 ? (
                                <BarList
                                    label="Downloads, by file type"
                                    items={Object.entries(data.downloadsByType)
                                        .filter(([, n]) => n > 0)
                                        .map(([key, n]) => ({ key, label: CATEGORY_LABELS[key as FileCategory], value: n }))}
                                />
                            ) : (
                                <p className="text-sm text-zinc-500 dark:text-zinc-400">No downloads in this period.</p>
                            )}
                        </ChartCard>
                    </div>

                    <ChartCard title="Most active shares">
                        {data.topShares.length === 0 ? (
                            <p className="text-sm text-zinc-500 dark:text-zinc-400">No activity in this period.</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-xs text-zinc-500 dark:text-zinc-400">
                                            <th className="pb-2 font-medium">Share</th>
                                            <th className="pb-2 text-right font-medium">Views</th>
                                            <th className="pb-2 text-right font-medium">Visitors</th>
                                            <th className="pb-2 text-right font-medium">Downloads</th>
                                            <th className="pb-2 text-right font-medium">Bandwidth</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-800">
                                        {data.topShares.map((s, i) => (
                                            <tr key={s.code ?? i}>
                                                <td className="max-w-56 py-2 pr-3">
                                                    {s.code ? (
                                                        <Link to={`/shares?q=${s.code}`} className="font-mono font-medium hover:underline">
                                                            {formatCode(s.code)}
                                                        </Link>
                                                    ) : null}
                                                    <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{s.label}</span>
                                                </td>
                                                <td className="py-2 text-right">{s.views.toLocaleString()}</td>
                                                <td className="py-2 text-right">~{s.visitors.toLocaleString()}</td>
                                                <td className="py-2 text-right">{s.downloads.toLocaleString()}</td>
                                                <td className="py-2 text-right">{formatSize(s.bytes)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </ChartCard>

                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        Unique visitors are estimated without tracking anyone: no addresses are stored, and the same person on
                        two different days counts twice.
                    </p>
                </div>
            )}
        </div>
    );
}
