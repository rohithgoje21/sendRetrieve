import { useDeferredValue, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, Clock, Download, Eye, FileText, HardDrive, Inbox, Lock, Plus, Search, SearchX, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Alert, Badge, Card, EmptyState, Skeleton } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { buttonClasses } from "@/components/ui/styles";
import { CopyButton } from "@/components/CopyButton";
import { QrCodeButton } from "@/components/QrCode";
import { SharedContent } from "@/components/SharedContent";
import { LineChart } from "@/components/charts";
import { Input, Select } from "@/components/ui/inputs";
import { api } from "@/lib/api";
import { formatCode, formatDateTime, formatRelative, formatSize, pluralize } from "@/lib/format";
import { analyticsKey, sharesKey } from "@/lib/queryClient";
import { ACTIVITY_SERIES, CATEGORY_LABELS } from "@/lib/analytics";
import type { FileCategory, OwnedShare, ShareAnalytics, SharesPage, ShareStatus } from "@/lib/types";

const STATUSES: { value: ShareStatus; label: string }[] = [
    { value: "active", label: "Active" },
    { value: "expired", label: "Expired" },
    { value: "deleted", label: "Deleted" },
];

// Search, filters and sort, kept in the URL (?q=...&kind=...).
const FILTERS = {
    kind: [
        { value: "", label: "Any content" },
        { value: "files", label: "With files" },
        { value: "text", label: "Text only" },
    ],
    fileType: [
        { value: "", label: "Any file type" },
        ...(["image", "video", "audio", "document", "archive"] as FileCategory[]).map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
    ],
    protected: [
        { value: "", label: "Any access" },
        { value: "yes", label: "Password protected" },
        { value: "no", label: "No password" },
    ],
    sort: [
        { value: "", label: "Newest first" },
        { value: "oldest", label: "Oldest first" },
        { value: "views", label: "Most viewed" },
        { value: "downloads", label: "Most downloaded" },
        { value: "size", label: "Largest" },
        { value: "expiring", label: "Expiring soonest" },
    ],
} as const;
type FilterKey = keyof typeof FILTERS;

const EMPTY: Record<ShareStatus, { icon: typeof Inbox; title: string; body: string }> = {
    active: { icon: Inbox, title: "No active shares", body: "Anything you send while logged in shows up here." },
    expired: { icon: Clock, title: "No expired shares", body: "Shares that expire or reach their view limit are listed here for 30 days." },
    deleted: { icon: Archive, title: "No deleted shares", body: "Shares you delete early are listed here for 30 days." },
};

function StatusBadge({ share }: { share: OwnedShare }) {
    if (share.endedReason === "malware") return <Badge tone="danger">Blocked: malware</Badge>;
    if (share.endedReason === "removed") return <Badge tone="danger">Removed by an admin</Badge>;
    if (share.status === "deleted") return <Badge tone="danger">Deleted</Badge>;
    if (share.endedReason === "used_up") return <Badge tone="warning">Used up</Badge>;
    if (share.status === "expired") return <Badge>Expired</Badge>;
    if (share.processing) return <Badge tone="warning">Scanning…</Badge>;
    return <Badge tone="success">Active</Badge>;
}

function ShareStats({ share }: { share: OwnedShare }) {
    const downloads = share.files.reduce((sum, f) => sum + f.downloads, 0);
    const views = share.maxViews === null ? pluralize(share.views, "view") : `${share.views} of ${share.maxViews} views`;
    const when = share.status === "active" ? share.expiresAt : (share.endedAt ?? share.expiresAt);

    const stat = "inline-flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:text-zinc-400";
    return (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-zinc-600 dark:text-zinc-400">
            <span className={stat}>
                <Eye aria-hidden /> {views}
            </span>
            {share.files.length > 0 && (
                <>
                    <span className={stat}>
                        <Download aria-hidden /> {pluralize(downloads, "download")}
                    </span>
                    <span className={stat}>
                        <HardDrive aria-hidden /> {formatSize(share.totalSize)}
                    </span>
                </>
            )}
            {share.passwordProtected && (
                <span className={stat}>
                    <Lock aria-hidden /> Password
                </span>
            )}
            <span className={stat} title={formatDateTime(when)}>
                <Clock aria-hidden />
                {share.status === "active" ? `Expires ${formatRelative(when)}` : `Ended ${formatRelative(when)}`}
            </span>
        </div>
    );
}

function ShareDetail({ code }: { code: string }) {
    const { data, error, isPending } = useQuery({
        queryKey: [...sharesKey, "detail", code],
        queryFn: () => api<{ share: OwnedShare; downloadWindowSeconds: number }>(`/api/me/shares/${code}`),
        staleTime: 60 * 1000,
    });

    if (isPending) return <Skeleton className="h-24 w-full" />;
    if (error) return <Alert tone="error">{error.message}</Alert>;
    return (
        <div className="space-y-3">
            <SharedContent text={data.share.text} files={data.share.files} />
            <p className="text-xs text-zinc-500">
                Viewing your own share doesn't count as a view. Download links work for{" "}
                {Math.round(data.downloadWindowSeconds / 60)} minutes.
            </p>
        </div>
    );
}

// Views, visitors and downloads of one share over the last 30 days.
function ShareActivityStats({ code }: { code: string }) {
    const { data, error } = useQuery({
        queryKey: [...analyticsKey, "share", code],
        queryFn: () => api<ShareAnalytics>(`/api/me/analytics/shares/${code}?days=30`),
    });
    if (error) return <Alert tone="error">{error.message}</Alert>;
    if (!data) return <Skeleton className="h-32 w-full" />;
    return (
        <section aria-label="Activity, last 30 days">
            <h3 className="text-sm font-medium">Last 30 days</h3>
            <p className="mt-0.5 text-xs text-zinc-500">
                {pluralize(data.totals.views, "view")} · ~{pluralize(data.totals.visitors, "visitor")} · {pluralize(data.totals.downloads, "download")} ·{" "}
                {formatSize(data.totals.bytes)} downloaded
            </p>
            <div className="mt-2">
                <LineChart data={data.daily} series={ACTIVITY_SERIES} height={150} label={`Activity of share ${formatCode(code)}, last 30 days`} />
            </div>
        </section>
    );
}

function ShareCard({ share }: { share: OwnedShare }) {
    const queryClient = useQueryClient();
    const [expanded, setExpanded] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const active = share.status === "active";

    const remove = useMutation({
        mutationFn: () => api(`/api/me/shares/${share.code}`, { method: "DELETE" }),
        onSuccess: () => {
            setConfirming(false);
            toast.success(active ? `Share ${formatCode(share.code)} deleted` : "Removed from the list");
            queryClient.invalidateQueries({ queryKey: sharesKey });
        },
        onError: (err) => toast.error(err.message),
    });

    return (
        <Card className="p-4 sm:p-5">
            <article aria-label={`Share ${formatCode(share.code)}`}>
                <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-base font-semibold tracking-wider">{formatCode(share.code)}</code>
                    <StatusBadge share={share} />
                </div>

                {share.textPreview && (
                    <p className="mt-2 line-clamp-2 text-sm text-zinc-700 dark:text-zinc-300">{share.textPreview}</p>
                )}
                {share.files.length > 0 && (
                    <p className="mt-1.5 flex items-center gap-1.5 truncate text-sm text-zinc-500">
                        <FileText className="size-3.5 shrink-0" aria-hidden />
                        <span className="truncate">{share.files.map((f) => f.name).join(", ")}</span>
                    </p>
                )}

                <div className="mt-3">
                    <ShareStats share={share} />
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                    {active ? (
                        <>
                            <CopyButton value={share.url} label="Copy link" />
                            <QrCodeButton url={share.url} code={share.code} />
                            <Button variant="secondary" size="sm" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
                                <Eye aria-hidden />
                                {expanded ? "Hide" : "View"}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} className="text-red-600 hover:text-red-700 dark:text-red-400">
                                <Trash2 aria-hidden />
                                Delete
                            </Button>
                        </>
                    ) : (
                        <Button variant="secondary" size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>
                            Remove from list
                        </Button>
                    )}
                </div>

                {expanded && (
                    <div className="mt-4 animate-fade-in border-t border-zinc-200 pt-4 dark:border-zinc-800">
                        <ShareDetail code={share.code} />
                        <div className="mt-5">
                            <ShareActivityStats code={share.code} />
                        </div>
                    </div>
                )}
            </article>

            <ConfirmDialog
                open={confirming}
                title={`Delete share ${formatCode(share.code)}?`}
                description="It stops working immediately and its files are removed. This can't be undone."
                confirmLabel="Delete share"
                destructive
                busy={remove.isPending}
                onConfirm={() => remove.mutate()}
                onCancel={() => setConfirming(false)}
            />
        </Card>
    );
}

export default function MySharesPage() {
    const [params, setParams] = useSearchParams();
    const requested = params.get("status");
    const status: ShareStatus = STATUSES.some((s) => s.value === requested) ? (requested as ShareStatus) : "active";

    // The search box updates the URL as you type; the list follows a beat behind.
    const [search, setSearch] = useState(params.get("q") ?? "");
    const deferredSearch = useDeferredValue(search.trim());
    const filters = Object.fromEntries((Object.keys(FILTERS) as FilterKey[]).map((k) => [k, params.get(k) ?? ""])) as Record<FilterKey, string>;
    const filtering = Boolean(deferredSearch || filters.kind || filters.fileType || filters.protected);

    const update = (changes: Record<string, string>) => {
        const next = new URLSearchParams(params);
        for (const [key, value] of Object.entries(changes)) {
            if (value) next.set(key, value);
            else next.delete(key);
        }
        setParams(next, { replace: true });
    };
    useEffect(() => {
        if ((params.get("q") ?? "") !== deferredSearch) update({ q: deferredSearch });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the search text settles
    }, [deferredSearch]);

    const listQuery = new URLSearchParams({ status, ...(deferredSearch ? { q: deferredSearch } : {}) });
    for (const [key, value] of Object.entries(filters)) if (value) listQuery.set(key, value);

    const query = useInfiniteQuery({
        queryKey: [...sharesKey, "list", listQuery.toString()],
        queryFn: ({ pageParam }) => api<SharesPage>(`/api/me/shares?${listQuery}&page=${pageParam}`),
        initialPageParam: 1,
        getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
        placeholderData: (previous) => previous,
    });

    const shares = query.data?.pages.flatMap((p) => p.shares) ?? [];
    const counts = query.data?.pages[0]?.counts;
    const empty = EMPTY[status];
    const clearFilters = () => {
        setSearch("");
        update({ q: "", kind: "", fileType: "", protected: "" });
    };

    return (
        <div>
            <title>My shares · sendRetrieve</title>
            <div className="mb-6 flex items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">My shares</h1>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Track views and downloads, or delete shares early.</p>
                </div>
                <Link to="/" className={buttonClasses()}>
                    <Plus aria-hidden />
                    <span className="max-sm:sr-only">New share</span>
                </Link>
            </div>

            <SegmentedControl
                label="Filter shares"
                items={STATUSES.map(({ value, label }) => ({
                    key: value,
                    label,
                    count: counts?.[value],
                    active: value === status,
                    onSelect: () => update({ status: value === "active" ? "" : value }),
                }))}
            />

            <div className="mt-3 flex flex-wrap gap-2" role="search">
                <div className="relative min-w-48 flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search file names, messages, codes"
                        aria-label="Search shares"
                        className="pl-9"
                    />
                </div>
                {(Object.keys(FILTERS) as FilterKey[]).map((key) => (
                    <Select
                        key={key}
                        aria-label={key === "sort" ? "Sort by" : `Filter by ${key === "fileType" ? "file type" : key === "protected" ? "password" : "content"}`}
                        value={filters[key]}
                        onChange={(e) => update({ [key]: e.target.value })}
                        className="w-auto"
                    >
                        {FILTERS[key].map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </Select>
                ))}
            </div>

            <div className="mt-4 space-y-3">
                {query.isPending &&
                    [0, 1, 2].map((i) => (
                        <Card key={i} className="space-y-3 p-5">
                            <Skeleton className="h-5 w-32" />
                            <Skeleton className="h-4 w-3/4" />
                            <Skeleton className="h-3 w-1/2" />
                        </Card>
                    ))}

                {query.error && (
                    <Alert tone="error">
                        {query.error.message}{" "}
                        <button type="button" className="cursor-pointer font-medium underline" onClick={() => query.refetch()}>
                            Try again
                        </button>
                    </Alert>
                )}

                {query.isSuccess && shares.length === 0 && filtering && (
                    <EmptyState icon={SearchX} title="No shares match">
                        Try other words or filters.
                        <div className="mt-4">
                            <Button variant="secondary" size="sm" onClick={clearFilters}>
                                Clear search and filters
                            </Button>
                        </div>
                    </EmptyState>
                )}

                {query.isSuccess && shares.length === 0 && !filtering && (
                    <EmptyState icon={empty.icon} title={empty.title}>
                        {empty.body}
                        {status === "active" && (
                            <div className="mt-4">
                                <Link to="/" className={buttonClasses({ size: "sm" })}>
                                    Create a share
                                </Link>
                            </div>
                        )}
                    </EmptyState>
                )}

                {shares.map((share) => (
                    <ShareCard key={share.code} share={share} />
                ))}

                {query.hasNextPage && (
                    <Button variant="secondary" className="w-full" loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
                        Load more
                    </Button>
                )}

                {status !== "active" && shares.length > 0 && (
                    <p className="pt-2 text-center text-xs text-zinc-500">
                        Ended shares are listed for 30 days. Their content and files are already gone.
                    </p>
                )}
            </div>
        </div>
    );
}
