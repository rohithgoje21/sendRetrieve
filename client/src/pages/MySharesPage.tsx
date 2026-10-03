import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, Clock, Download, Eye, FileText, HardDrive, Inbox, Lock, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Alert, Badge, Card, EmptyState, Skeleton } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { buttonClasses } from "@/components/ui/styles";
import { CopyButton } from "@/components/CopyButton";
import { QrCodeButton } from "@/components/QrCode";
import { SharedContent } from "@/components/SharedContent";
import { api } from "@/lib/api";
import { formatCode, formatDateTime, formatRelative, formatSize, pluralize } from "@/lib/format";
import { sharesKey } from "@/lib/queryClient";
import type { OwnedShare, SharesPage, ShareStatus } from "@/lib/types";

const STATUSES: { value: ShareStatus; label: string }[] = [
    { value: "active", label: "Active" },
    { value: "expired", label: "Expired" },
    { value: "deleted", label: "Deleted" },
];

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

    const query = useInfiniteQuery({
        queryKey: [...sharesKey, "list", status],
        queryFn: ({ pageParam }) => api<SharesPage>(`/api/me/shares?status=${status}&page=${pageParam}`),
        initialPageParam: 1,
        getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    });

    const shares = query.data?.pages.flatMap((p) => p.shares) ?? [];
    const counts = query.data?.pages[0]?.counts;
    const empty = EMPTY[status];

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
                    onSelect: () => setParams(value === "active" ? {} : { status: value }, { replace: true }),
                }))}
            />

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

                {query.isSuccess && shares.length === 0 && (
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
