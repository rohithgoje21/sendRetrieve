import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CircleCheck, CircleAlert, CircleDot } from "lucide-react";
import { Button } from "./ui/Button";
import { Alert, Badge, Card, Skeleton } from "./ui/feedback";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { useSession } from "@/hooks/useSession";
import { api } from "@/lib/api";
import { can } from "@/lib/permissions";
import { formatRelative, pluralize } from "@/lib/format";
import type { DeadLetter, QueuesOverview } from "@/lib/types";

const queuesKey = ["admin", "queues"] as const;

const BREAKER = {
    closed: { label: "Closed", tone: "success", icon: CircleCheck, hint: "working normally" },
    half_open: { label: "Half open", tone: "warning", icon: CircleDot, hint: "trying again after failures" },
    open: { label: "Open", tone: "danger", icon: CircleAlert, hint: "paused after repeated failures" },
} as const;

// Messages that failed every retry, for one queue.
function DeadLetters({ queue }: { queue: string }) {
    const { data, error } = useQuery({
        queryKey: [...queuesKey, queue, "dead"],
        queryFn: () => api<{ messages: DeadLetter[] }>(`/api/admin/queues/${queue}/dead-letters?limit=20`),
    });
    if (error) return <Alert tone="error">{error.message}</Alert>;
    if (!data) return <Skeleton className="h-12 w-full" />;
    return (
        <ul className="space-y-1.5 text-xs" aria-label={`Dead letters in ${queue}`}>
            {data.messages.map((m, i) => (
                <li key={m.message?.id ?? i} className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
                    <span className="font-mono font-medium">{m.message?.type ?? "unknown"}</span>
                    {m.failedAt && <span className="text-zinc-500 dark:text-zinc-400"> · failed {formatRelative(m.failedAt)}</span>}
                    {m.attempts !== null && <span className="text-zinc-500 dark:text-zinc-400"> · {pluralize(Number(m.attempts), "attempt")}</span>}
                    {m.error && <p className="mt-0.5 break-words text-red-700 dark:text-red-400">{m.error}</p>}
                </li>
            ))}
        </ul>
    );
}

// Admin: queues, dead letters and circuit breakers.
export function BackgroundJobs() {
    const { user } = useSession();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState<string | null>(null);
    const [purging, setPurging] = useState<string | null>(null);
    const { data, error } = useQuery({
        queryKey: queuesKey,
        queryFn: () => api<QueuesOverview>("/api/admin/queues"),
        refetchInterval: 10_000,
    });
    const refresh = () => queryClient.invalidateQueries({ queryKey: queuesKey });

    const replay = useMutation({
        mutationFn: (queue: string) => api<{ replayed: number }>(`/api/admin/queues/${queue}/dead-letters/replay`, { method: "POST" }),
        onSuccess: ({ replayed }, queue) => {
            toast.success(`${pluralize(replayed, "message")} from ${queue} sent through again`);
            refresh();
        },
        onError: (err) => toast.error(err.message),
    });
    const purge = useMutation({
        mutationFn: (queue: string) => api<{ purged: number }>(`/api/admin/queues/${queue}/dead-letters`, { method: "DELETE" }),
        onSuccess: ({ purged }, queue) => {
            setPurging(null);
            toast.success(`${pluralize(purged, "message")} deleted from ${queue}`);
            refresh();
        },
        onError: (err) => toast.error(err.message),
    });

    return (
        <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 p-4 dark:border-zinc-800">
                <h2 className="font-semibold">Background jobs</h2>
                {data && <Badge>{data.broker === "rabbitmq" ? "RabbitMQ" : "In-process queue"}</Badge>}
            </div>
            {error && <Alert tone="error" className="m-4">{error.message}</Alert>}
            {!data && !error && <Skeleton className="m-4 h-24" />}
            {data && (
                <>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-zinc-500 dark:text-zinc-400">
                                    <th className="px-4 py-2 font-medium">Queue</th>
                                    <th className="px-2 py-2 text-right font-medium">Waiting</th>
                                    <th className="px-2 py-2 text-right font-medium">Retrying</th>
                                    <th className="px-2 py-2 text-right font-medium">Failed</th>
                                    <th className="px-2 py-2 text-right font-medium">Workers</th>
                                    <th className="px-4 py-2" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-800">
                                {data.queues.map((q) => (
                                    <tr key={q.name} className="align-top">
                                        <td className="px-4 py-2.5">
                                            <span className="font-mono text-xs font-medium">{q.name}</span>
                                            <span className="block text-xs text-zinc-500 dark:text-zinc-400">{q.description}</span>
                                            {open === q.name && (
                                                <div className="mt-2">
                                                    <DeadLetters queue={q.name} />
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-2 py-2.5 text-right">{q.ready}</td>
                                        <td className="px-2 py-2.5 text-right">{q.retrying ?? 0}</td>
                                        <td className="px-2 py-2.5 text-right">
                                            {q.deadLettered > 0 ? <Badge tone="danger">{q.deadLettered}</Badge> : 0}
                                        </td>
                                        <td className="px-2 py-2.5 text-right">{q.consumers}</td>
                                        <td className="px-4 py-2.5">
                                            {q.deadLettered > 0 && (
                                                <div className="flex justify-end gap-1.5">
                                                    <Button size="sm" variant="ghost" onClick={() => setOpen(open === q.name ? null : q.name)}>
                                                        {open === q.name ? "Hide" : "View"}
                                                    </Button>
                                                    {can(user, "queues.replay") && (
                                                        <Button size="sm" variant="secondary" loading={replay.isPending && replay.variables === q.name} onClick={() => replay.mutate(q.name)}>
                                                            Replay
                                                        </Button>
                                                    )}
                                                    {can(user, "queues.purge") && (
                                                        <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => setPurging(q.name)}>
                                                            Delete
                                                        </Button>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
                        <h3 className="text-sm font-medium">Outside services</h3>
                        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Circuit breakers">
                            {data.circuitBreakers.map((b) => {
                                const s = BREAKER[b.state] ?? BREAKER.closed;
                                return (
                                    <li key={b.name} title={`${b.name}: ${s.hint}`}>
                                        <Badge tone={s.tone}>
                                            <s.icon className="size-3" aria-hidden /> {b.name}: {s.label}
                                        </Badge>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                </>
            )}
            <ConfirmDialog
                open={purging !== null}
                title={`Delete the failed messages in ${purging}?`}
                description="They're gone for good: the work they stood for (emails, scans, cleanups) won't happen. Replay them instead if the cause is fixed."
                confirmLabel="Delete messages"
                destructive
                busy={purge.isPending}
                onConfirm={() => purging && purge.mutate(purging)}
                onCancel={() => setPurging(null)}
            />
        </Card>
    );
}
