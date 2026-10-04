import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BarList, ChartCard, ColumnChart, LineChart, PeriodPicker, StatTile } from "./charts";
import { Alert, Skeleton } from "./ui/feedback";
import { api } from "@/lib/api";
import { ACTIVITY_SERIES, CATEGORY_LABELS, PERIODS } from "@/lib/analytics";
import { formatSize } from "@/lib/format";
import { analyticsKey } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { FileCategory, SiteAnalytics as Site } from "@/lib/types";

// Admin: the whole site's activity (every share, guests' included).
export function SiteAnalytics() {
    const [days, setDays] = useState(30);
    const { data, error, isPlaceholderData } = useQuery({
        queryKey: [...analyticsKey, "site", days],
        queryFn: () => api<Site>(`/api/admin/analytics?days=${days}`),
        placeholderData: keepPreviousData,
    });
    const period = `previous ${days} days`;

    return (
        <section className="space-y-4" aria-labelledby="site-analytics">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <h2 id="site-analytics" className="text-lg font-semibold">
                    Site analytics
                </h2>
                <PeriodPicker periods={PERIODS} days={days} onChange={setDays} />
            </div>
            {error && <Alert tone="error">{error.message}</Alert>}
            {!data && !error && <Skeleton className="h-64 w-full rounded-2xl" />}
            {data && (
                <div className={cn("space-y-4 transition-opacity", isPlaceholderData && "opacity-60")}>
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                        <StatTile label="Views" value={data.totals.views} previous={data.previous.views} period={period} />
                        <StatTile label="Unique visitors" value={data.totals.visitors} previous={data.previous.visitors} approximate period={period} />
                        <StatTile label="Downloads" value={data.totals.downloads} previous={data.previous.downloads} period={period} />
                        <StatTile label="Bandwidth" value={data.totals.bytes} previous={data.previous.bytes} format={formatSize} period={period} />
                        <StatTile label="Shares created" value={data.totals.sharesCreated} previous={data.previous.sharesCreated} period={period} />
                        <StatTile label="Uploaded" value={data.totals.bytesUploaded} previous={data.previous.bytesUploaded} format={formatSize} period={period} />
                    </div>
                    <ChartCard title="Activity" description="Views, unique visitors and downloads per day, across the site (UTC).">
                        <LineChart data={data.daily} series={ACTIVITY_SERIES} label={`Site views, visitors and downloads per day, last ${days} days`} />
                    </ChartCard>
                    <div className="grid gap-4 lg:grid-cols-2">
                        <ChartCard title="Uploads" description="Data uploaded per day.">
                            <ColumnChart data={data.daily} valueKey="bytesUploaded" label={`Data uploaded per day, last ${days} days`} format={formatSize} bytes />
                        </ChartCard>
                        <ChartCard title="Files uploaded, by type">
                            {data.totals.filesUploaded > 0 ? (
                                <BarList
                                    label="Files uploaded, by type"
                                    items={Object.entries(data.uploadsByType)
                                        .filter(([, t]) => t.files > 0)
                                        .map(([key, t]) => ({ key, label: CATEGORY_LABELS[key as FileCategory], value: t.files, detail: formatSize(t.bytes) }))}
                                />
                            ) : (
                                <p className="text-sm text-zinc-500 dark:text-zinc-400">No files uploaded in this period.</p>
                            )}
                        </ChartCard>
                    </div>
                </div>
            )}
        </section>
    );
}
