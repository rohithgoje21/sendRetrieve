import { useEffect, useState } from "react";
import { Download, Eye, Radio, XCircle } from "lucide-react";
import type { ActivityItem } from "@/hooks/useRealtime";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

const ENDED: Record<string, string> = {
    used_up: "Used up: no opens left",
    expired: "Expired",
    deleted: "Deleted",
    removed: "Removed by an administrator",
    malware: "Blocked: malware found",
};

const describe = (item: ActivityItem) => {
    switch (item.kind) {
        case "opened":
            return {
                icon: Eye,
                text: "Someone opened the share",
                detail: item.maxViews === null ? `${item.views} so far` : `${item.views} of ${item.maxViews} views`,
            };
        case "downloaded":
            return { icon: Download, text: `"${item.fileName}" was downloaded`, detail: null };
        case "ended":
            return { icon: XCircle, text: ENDED[item.reason] ?? "The share ended", detail: null };
    }
};

// Re-renders every 30s so "just now" turns into "1 minute ago".
function useNow(intervalMs = 30_000) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs]);
    return now;
}

// "Live activity" for a share the user just created: opens and downloads
// appear as they happen (from useShareActivity).
export function ShareActivity({ activity, connected }: { activity: ActivityItem[]; connected: boolean }) {
    const now = useNow();

    return (
        <section aria-label="Live activity" className="rounded-xl border border-zinc-200 p-4 text-left dark:border-zinc-800">
            <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                    <Radio className="size-4 text-zinc-500 dark:text-zinc-400" aria-hidden />
                    Live activity
                </h3>
                <span className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                    <span
                        className={cn(
                            "size-2 rounded-full",
                            connected ? "animate-pulse bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"
                        )}
                        aria-hidden
                    />
                    {connected ? "Watching" : "Connecting…"}
                </span>
            </div>

            {activity.length === 0 ? (
                <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Nothing yet. You'll see it here when someone opens the share.</p>
            ) : (
                <ul className="mt-3 space-y-2" aria-live="polite">
                    {activity.map((item, i) => {
                        const { icon: Icon, text, detail } = describe(item);
                        return (
                            <li key={`${item.at}-${i}`} className="flex animate-fade-in items-start gap-2.5 text-sm">
                                <Icon className="mt-0.5 size-4 shrink-0 text-indigo-500" aria-hidden />
                                <span className="min-w-0 flex-1">
                                    {text}
                                    {detail && <span className="text-zinc-500 dark:text-zinc-400"> · {detail}</span>}
                                </span>
                                <time className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400" dateTime={item.at}>
                                    {/* Past events: if the server's clock is a little ahead, still "just now". */}
                                    {formatRelative(item.at, Math.max(now, Date.parse(item.at)))}
                                </time>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
