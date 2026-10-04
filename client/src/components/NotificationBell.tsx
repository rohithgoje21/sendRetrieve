import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Bell, CheckCheck, Download, Hourglass, ShieldAlert, ShieldCheck, BarChart3 } from "lucide-react";
import { useMarkRead, useNotifications, useNotificationUpdates } from "@/hooks/useNotifications";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AppNotification, NotificationEvent } from "@/lib/types";
import { Skeleton } from "./ui/feedback";
import { buttonClasses } from "./ui/styles";

const ICONS: Record<NotificationEvent, typeof Bell> = {
    fileDownloaded: Download,
    shareEnded: Hourglass,
    shareBlocked: ShieldAlert,
    newDevice: ShieldCheck,
    weeklySummary: BarChart3,
};

function Item({ notification, onOpen }: { notification: AppNotification; onOpen: (n: AppNotification) => void }) {
    const Icon = ICONS[notification.event] ?? Bell;
    return (
        <li>
            <button
                type="button"
                onClick={() => onOpen(notification)}
                className={cn(
                    "flex w-full cursor-pointer gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800",
                    !notification.read && "bg-indigo-50/60 dark:bg-indigo-950/30"
                )}
            >
                <Icon
                    className={cn("mt-0.5 size-4 shrink-0", notification.event === "shareBlocked" ? "text-red-500" : "text-zinc-500")}
                    aria-hidden
                />
                <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{notification.title}</span>
                    {notification.body && <span className="mt-0.5 block text-xs text-zinc-600 dark:text-zinc-400">{notification.body}</span>}
                    <time className="mt-1 block text-xs text-zinc-500" dateTime={notification.updatedAt}>
                        {formatRelative(notification.updatedAt)}
                    </time>
                </span>
                {!notification.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-indigo-500" aria-label="Unread" />}
            </button>
        </li>
    );
}

// The bell in the header: unread count, and the latest notifications.
export function NotificationBell() {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const navigate = useNavigate();
    const { data } = useNotifications();
    useNotificationUpdates(true);
    const markRead = useMarkRead();

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
        const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    const unread = data?.unread ?? 0;
    const openNotification = (notification: AppNotification) => {
        if (!notification.read) markRead.mutate({ ids: [notification.id] });
        setOpen(false);
        if (notification.link) navigate(notification.link);
    };

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
                className={cn(buttonClasses({ variant: "ghost", size: "icon" }), "relative")}
            >
                <Bell />
                {unread > 0 && (
                    <span className="absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-indigo-600 px-1 text-[10px] leading-4 font-semibold text-white">
                        {unread > 9 ? "9+" : unread}
                    </span>
                )}
            </button>

            {open && (
                <div
                    role="dialog"
                    aria-label="Notifications"
                    className="absolute right-0 z-20 mt-2 w-[min(22rem,calc(100vw-2rem))] animate-fade-in rounded-xl border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
                >
                    <div className="flex items-center justify-between px-3 py-1.5">
                        <h2 className="text-sm font-semibold">Notifications</h2>
                        <button
                            type="button"
                            disabled={unread === 0}
                            onClick={() => markRead.mutate({ all: true })}
                            className="flex cursor-pointer items-center gap-1 text-xs font-medium text-indigo-600 disabled:cursor-default disabled:text-zinc-400 dark:text-indigo-400"
                        >
                            <CheckCheck className="size-3.5" aria-hidden /> Mark all as read
                        </button>
                    </div>
                    <div className="max-h-96 overflow-y-auto">
                        {!data ? (
                            <div className="space-y-2 p-3">
                                <Skeleton className="h-10 w-full" />
                                <Skeleton className="h-10 w-full" />
                            </div>
                        ) : data.notifications.length === 0 ? (
                            <p className="px-3 py-8 text-center text-sm text-zinc-500">You're all caught up.</p>
                        ) : (
                            <ul className="space-y-0.5">
                                {data.notifications.map((n) => (
                                    <Item key={n.id} notification={n} onOpen={openNotification} />
                                ))}
                            </ul>
                        )}
                    </div>
                    <div className="mt-1 border-t border-zinc-200 px-3 pt-2 pb-1 dark:border-zinc-800">
                        <Link to="/account#notifications" onClick={() => setOpen(false)} className="text-xs font-medium text-zinc-600 hover:underline dark:text-zinc-400">
                            Notification settings
                        </Link>
                    </div>
                </div>
            )}
        </div>
    );
}
