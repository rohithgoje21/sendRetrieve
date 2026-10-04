import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellRing } from "lucide-react";
import { api } from "@/lib/api";
import { notificationSettingsKey } from "@/lib/queryClient";
import { currentPushSubscription, disablePush, enablePush, pushPermission } from "@/lib/push";
import type { ChannelChoices, NotificationEvent, NotificationSettings as Settings } from "@/lib/types";
import { Button } from "./ui/Button";
import { Alert, Badge, Skeleton } from "./ui/feedback";

const CHANNELS: { key: keyof ChannelChoices; label: string }[] = [
    { key: "inApp", label: "In app" },
    { key: "email", label: "Email" },
    { key: "push", label: "Browser" },
];

// Browser notifications for this browser: on, off, blocked, or unsupported.
function ThisBrowser({ publicKey }: { publicKey: string }) {
    const [state, setState] = useState<"loading" | "on" | "off">("loading");
    const [busy, setBusy] = useState(false);
    const permission = pushPermission();

    useEffect(() => {
        currentPushSubscription()
            .then((s) => setState(s ? "on" : "off"))
            .catch(() => setState("off"));
    }, []);

    if (permission === "unsupported") return <p className="text-sm text-zinc-500 dark:text-zinc-400">This browser can't show notifications from websites.</p>;

    const toggle = async () => {
        setBusy(true);
        try {
            if (state === "on") {
                await disablePush();
                setState("off");
                toast.success("Browser notifications turned off for this browser");
            } else {
                await enablePush(publicKey);
                setState("on");
                toast.success("Browser notifications turned on for this browser");
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Couldn't change browser notifications");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
            <p className="flex items-center gap-2 text-sm">
                <BellRing className="size-4 text-zinc-500 dark:text-zinc-400" aria-hidden />
                {state === "on"
                    ? "Browser notifications are on for this browser."
                    : permission === "denied"
                      ? "Notifications are blocked for this site in your browser's settings."
                      : "Get notifications even when this site isn't open."}
            </p>
            {state !== "loading" && !(permission === "denied" && state === "off") && (
                <Button size="sm" variant={state === "on" ? "secondary" : "primary"} loading={busy} onClick={toggle}>
                    {state === "on" ? "Turn off" : "Turn on for this browser"}
                </Button>
            )}
        </div>
    );
}

// Which notifications to get, and how: a row per event, a column per channel.
export function NotificationSettings() {
    const queryClient = useQueryClient();
    const { data, error } = useQuery({
        queryKey: notificationSettingsKey,
        queryFn: () => api<Settings>("/api/notifications/preferences"),
    });
    const save = useMutation({
        mutationFn: (change: Partial<Record<NotificationEvent, Partial<ChannelChoices>>>) =>
            api<Settings>("/api/notifications/preferences", { method: "PUT", body: { preferences: change } }),
        onSuccess: (settings) => queryClient.setQueryData(notificationSettingsKey, settings),
        onError: (err) => toast.error(err.message),
    });

    if (error) return <Alert tone="error">{error.message}</Alert>;
    if (!data) return <Skeleton className="h-48 w-full" />;

    const channels = CHANNELS.filter((c) => c.key !== "push" || data.channels.push.available);
    const preferences = save.isPending && save.variables ? merge(data.preferences, save.variables) : data.preferences;

    return (
        <div className="space-y-4">
            {!data.channels.email.verified && (
                <Alert tone="warning">
                    Only security alerts are emailed until you{" "}
                    <Link to="/verify-email?next=/account" className="font-medium underline underline-offset-2">
                        verify your email address
                    </Link>
                    .
                </Alert>
            )}
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs text-zinc-500 dark:text-zinc-400">
                            <th className="pb-2 font-medium">Notify me when</th>
                            {channels.map((c) => (
                                <th key={c.key} className="w-16 pb-2 text-center font-medium">
                                    {c.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                        {data.events.map((event) => (
                            <tr key={event.key}>
                                <td className="py-2.5 pr-3">
                                    {event.label} {event.security && <Badge tone="warning">Security</Badge>}
                                </td>
                                {channels.map((c) => {
                                    const emailOff = c.key === "email" && !data.channels.email.verified && !event.security;
                                    return (
                                        <td key={c.key} className="py-2.5 text-center">
                                            <input
                                                type="checkbox"
                                                className="size-4 cursor-pointer accent-indigo-600 disabled:cursor-not-allowed"
                                                aria-label={`${c.label}: ${event.label}`}
                                                checked={preferences[event.key][c.key] && !emailOff}
                                                disabled={emailOff}
                                                onChange={(e) => save.mutate({ [event.key]: { [c.key]: e.target.checked } })}
                                            />
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {data.channels.push.available && data.channels.push.publicKey && (
                <ThisBrowser publicKey={data.channels.push.publicKey} />
            )}
        </div>
    );
}

// Shows a change right away, before the server confirms it.
const merge = (current: Settings["preferences"], change: Partial<Record<NotificationEvent, Partial<ChannelChoices>>>) =>
    Object.fromEntries(
        Object.entries(current).map(([event, choices]) => [event, { ...choices, ...change[event as NotificationEvent] }])
    ) as Settings["preferences"];
