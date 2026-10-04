import { useDeferredValue, useState, type FormEvent, type ReactNode } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Activity, BadgeCheck, Ban, Crown, HardDrive, Search, Share2, ShieldCheck, Upload, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/inputs";
import { Alert, Badge, Card, Skeleton } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useSession } from "@/hooks/useSession";
import { SiteAnalytics } from "@/components/SiteAnalytics";
import { api } from "@/lib/api";
import { can } from "@/lib/permissions";
import { formatCode, formatDate, formatDateTime, formatSize, normalizeCodeInput, pluralize, stripCode } from "@/lib/format";
import type { AdminShare, AdminStats, AdminUser, AdminUsersPage } from "@/lib/types";

const adminKey = ["admin"] as const;

function StatTile({ icon: Icon, label, value, detail }: { icon: typeof Users; label: string; value: ReactNode; detail?: string }) {
    return (
        <Card className="p-4">
            <div className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                <Icon className="size-4" aria-hidden />
                {label}
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
            {detail && <p className="mt-0.5 text-xs text-zinc-500">{detail}</p>}
        </Card>
    );
}

function Stats() {
    const { data, error } = useQuery({
        queryKey: [...adminKey, "stats"],
        queryFn: () => api<AdminStats>("/api/admin/stats"),
        refetchInterval: 30_000,
    });
    if (error) return <Alert tone="error">{error.message}</Alert>;
    if (!data) {
        return (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-24 rounded-2xl" />
                ))}
            </div>
        );
    }
    return (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile icon={Users} label="Users" value={data.users.total} detail={`${data.users.newThisWeek} new this week · ${data.users.verified} verified`} />
            <StatTile icon={Share2} label="Active shares" value={data.shares.active} detail={`${data.shares.createdToday} created today`} />
            <StatTile icon={HardDrive} label="Storage" value={formatSize(data.storage.bytes)} detail={`${data.storage.files} files`} />
            <StatTile
                icon={Activity}
                label="Activity"
                value={data.activity.views}
                detail={`views · ${data.activity.downloads} downloads${data.shares.uploading ? ` · ${data.shares.uploading} uploading` : ""}`}
            />
        </div>
    );
}

// role/disabled: PATCH the user; logout: log them out on every device.
type PendingChange = {
    user: AdminUser;
    change: { role?: "user" | "admin"; disabled?: boolean; logout?: true };
    title: string;
    description: string;
};

function UsersTable() {
    const { user: me } = useSession();
    const queryClient = useQueryClient();
    const [search, setSearch] = useState("");
    const deferredSearch = useDeferredValue(search.trim());
    const [page, setPage] = useState(1);
    const [pending, setPending] = useState<PendingChange | null>(null);

    const query = useQuery({
        queryKey: [...adminKey, "users", deferredSearch, page],
        queryFn: () => api<AdminUsersPage>(`/api/admin/users?search=${encodeURIComponent(deferredSearch)}&page=${page}`),
        placeholderData: keepPreviousData,
    });

    const update = useMutation({
        mutationFn: ({ user, change }: PendingChange) =>
            change.logout
                ? api(`/api/admin/users/${user.id}/logout`, { method: "POST" })
                : api(`/api/admin/users/${user.id}`, { method: "PATCH", body: change }),
        onSuccess: (_, { user, change }) => {
            setPending(null);
            toast.success(
                change.logout
                    ? `${user.email} was logged out everywhere`
                    : change.disabled !== undefined
                      ? `${user.email} ${change.disabled ? "disabled" : "enabled"}`
                      : `${user.email} is now ${change.role === "admin" ? "an admin" : "a regular user"}`
            );
            queryClient.invalidateQueries({ queryKey: adminKey });
        },
        onError: (err) => toast.error(err.message),
    });

    const ask = (user: AdminUser, change: PendingChange["change"]) => {
        if (change.disabled === true) {
            setPending({ user, change, title: `Disable ${user.email}?`, description: "They'll be logged out everywhere and can't log in until you enable the account again. Their shares keep working." });
        } else if (change.logout) {
            setPending({ user, change, title: `Log ${user.email} out everywhere?`, description: "Every device they're logged in on will have to log in again. Useful when an account may be compromised." });
        } else if (change.role === "admin") {
            setPending({ user, change, title: `Make ${user.email} an admin?`, description: "Admins can see site statistics, manage regular users, remove any share and replay failed background jobs." });
        } else {
            update.mutate({ user, change, title: "", description: "" });
        }
    };

    // Admins manage regular users; superadmins also manage admins; nobody
    // changes a superadmin here (only the set-role script can).
    const canManage = (user: AdminUser) =>
        user.role === "superadmin" ? false : user.role === "admin" ? can(me, "users.roles") : can(me, "users.disable");

    const data = query.data;
    return (
        <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 p-4 dark:border-zinc-800">
                <h2 className="font-semibold">Users {data && <span className="font-normal text-zinc-500">({data.total})</span>}</h2>
                <div className="relative w-full sm:w-64">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
                    <Input
                        value={search}
                        onChange={(e) => {
                            setSearch(e.target.value);
                            setPage(1);
                        }}
                        placeholder="Search name or email"
                        aria-label="Search users"
                        className="pl-9"
                    />
                </div>
            </div>

            {query.error && <Alert tone="error" className="m-4">{query.error.message}</Alert>}

            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {data?.users.map((user) => {
                    const self = user.id === me?.id;
                    return (
                        <li key={user.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                            <div className="min-w-0 flex-1">
                                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                    <span className="truncate">{user.name}</span>
                                    {user.role === "admin" && (
                                        <Badge tone="success">
                                            <ShieldCheck className="size-3" aria-hidden /> Admin
                                        </Badge>
                                    )}
                                    {user.role === "superadmin" && (
                                        <Badge tone="warning">
                                            <Crown className="size-3" aria-hidden /> Superadmin
                                        </Badge>
                                    )}
                                    {user.disabled && (
                                        <Badge tone="danger">
                                            <Ban className="size-3" aria-hidden /> Disabled
                                        </Badge>
                                    )}
                                    {self && <Badge>You</Badge>}
                                </p>
                                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
                                    <span className="truncate">{user.email}</span>
                                    {user.emailVerified && (
                                        <span className="inline-flex items-center gap-1">
                                            <BadgeCheck className="size-3" aria-hidden /> verified
                                        </span>
                                    )}
                                    <span>{pluralize(user.activeShares, "active share")}</span>
                                    <span>joined {formatDate(user.createdAt)}</span>
                                </p>
                            </div>
                            {!self && canManage(user) && (
                                <div className="flex flex-wrap gap-2">
                                    {can(me, "users.roles") && (
                                        <Button variant="secondary" size="sm" onClick={() => ask(user, { role: user.role === "admin" ? "user" : "admin" })}>
                                            {user.role === "admin" ? "Remove admin" : "Make admin"}
                                        </Button>
                                    )}
                                    {can(me, "users.logout") && (
                                        <Button variant="ghost" size="sm" onClick={() => ask(user, { logout: true })}>
                                            Log out
                                        </Button>
                                    )}
                                    <Button
                                        variant={user.disabled ? "secondary" : "ghost"}
                                        size="sm"
                                        className={user.disabled ? undefined : "text-red-600 hover:text-red-700 dark:text-red-400"}
                                        onClick={() => ask(user, { disabled: !user.disabled })}
                                    >
                                        {user.disabled ? "Enable" : "Disable"}
                                    </Button>
                                </div>
                            )}
                        </li>
                    );
                })}
                {data && data.users.length === 0 && <li className="px-4 py-8 text-center text-sm text-zinc-500">No users match.</li>}
                {!data && !query.error && (
                    <li className="space-y-2 p-4">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                    </li>
                )}
            </ul>

            {data && (page > 1 || data.hasMore) && (
                <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
                    <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                        Previous
                    </Button>
                    <span className="text-zinc-500">Page {page}</span>
                    <Button variant="secondary" size="sm" disabled={!data.hasMore} onClick={() => setPage((p) => p + 1)}>
                        Next
                    </Button>
                </div>
            )}

            <ConfirmDialog
                open={pending !== null}
                title={pending?.title ?? ""}
                description={pending?.description}
                confirmLabel={pending?.change.disabled ? "Disable account" : pending?.change.logout ? "Log out everywhere" : "Confirm"}
                destructive={pending?.change.disabled === true || pending?.change.logout === true}
                busy={update.isPending}
                onConfirm={() => pending && update.mutate(pending)}
                onCancel={() => setPending(null)}
            />
        </Card>
    );
}

function ShareLookup() {
    const queryClient = useQueryClient();
    const [code, setCode] = useState("");
    const [lookedUp, setLookedUp] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);

    const query = useQuery({
        queryKey: [...adminKey, "share", lookedUp],
        queryFn: () => api<{ share: AdminShare }>(`/api/admin/shares/${lookedUp}`),
        enabled: lookedUp !== null,
        retry: false,
    });

    const remove = useMutation({
        mutationFn: () => api(`/api/admin/shares/${lookedUp}`, { method: "DELETE" }),
        onSuccess: () => {
            setConfirming(false);
            toast.success(`Share ${formatCode(lookedUp ?? "")} removed`);
            queryClient.invalidateQueries({ queryKey: adminKey });
        },
        onError: (err) => toast.error(err.message),
    });

    const onSubmit = (event: FormEvent) => {
        event.preventDefault();
        if (stripCode(code).length === 8) setLookedUp(stripCode(code));
    };

    const share = query.data?.share;
    const removable = share && (share.status === "active" || share.uploading);

    return (
        <Card className="p-4">
            <h2 className="font-semibold">Look up a share</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                For abuse reports. You'll see who created it and what it contains (names and sizes), never its message or files.
            </p>
            <form onSubmit={onSubmit} className="mt-4 flex gap-2">
                <Input
                    value={code}
                    onChange={(e) => setCode(normalizeCodeInput(e.target.value))}
                    placeholder="XXXX-XXXX"
                    aria-label="Share code"
                    className="font-mono tracking-widest"
                />
                <Button type="submit" variant="secondary" loading={query.isFetching}>
                    Look up
                </Button>
            </form>

            {query.error && <Alert tone="error" className="mt-4">{query.error.message}</Alert>}
            {share && (
                <div className="mt-4 space-y-2 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
                    <div className="flex flex-wrap items-center gap-2">
                        <code className="font-mono font-semibold tracking-wider">{formatCode(share.code)}</code>
                        <Badge tone={share.status === "active" ? "success" : share.status === "deleted" ? "danger" : "neutral"}>
                            {share.uploading ? "Uploading" : share.endedReason === "removed" ? "Removed" : share.status}
                        </Badge>
                    </div>
                    <p className="text-zinc-600 dark:text-zinc-400">
                        {share.owner ? `${share.owner.name} (${share.owner.email})` : "Guest share"} · created {formatDateTime(share.createdAt)}
                    </p>
                    <p className="text-zinc-600 dark:text-zinc-400">
                        {share.hasText ? "Has a message · " : ""}
                        {share.files.length} files ({formatSize(share.totalSize)}) · {share.views} views
                    </p>
                    {share.files.length > 0 && (
                        <ul className="list-inside list-disc text-zinc-600 dark:text-zinc-400">
                            {share.files.map((f) => (
                                <li key={f.id} className="truncate">
                                    {f.name} · {formatSize(f.size)} · {f.mimeType}
                                </li>
                            ))}
                        </ul>
                    )}
                    {removable && (
                        <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
                            Remove share
                        </Button>
                    )}
                </div>
            )}

            <ConfirmDialog
                open={confirming}
                title={`Remove share ${formatCode(lookedUp ?? "")}?`}
                description="It stops working immediately and its files are deleted. If it belongs to an account, the owner sees it as removed by an administrator."
                confirmLabel="Remove share"
                destructive
                busy={remove.isPending}
                onConfirm={() => remove.mutate()}
                onCancel={() => setConfirming(false)}
            />
        </Card>
    );
}

export default function AdminPage() {
    return (
        <div className="space-y-6">
            <title>Admin · sendRetrieve</title>
            <div>
                <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
                    <ShieldCheck className="size-6" aria-hidden /> Admin
                </h1>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Site activity, accounts and moderation.</p>
            </div>
            <Stats />
            <SiteAnalytics />
            <UsersTable />
            <ShareLookup />
            <p className="flex items-center gap-1.5 text-xs text-zinc-500">
                <Upload className="size-3.5" aria-hidden /> Stats refresh every 30 seconds.
            </p>
        </div>
    );
}
