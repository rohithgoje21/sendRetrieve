import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { getSocket } from "@/lib/realtime";
import { notificationsKey } from "@/lib/queryClient";
import type { NotificationEventPayload, NotificationsPage } from "@/lib/types";

// The bell: the latest notifications and the unread count, kept current over
// Socket.IO (new ones arrive, other tabs mark them read).

export function useNotifications(enabled = true) {
    return useQuery({
        queryKey: notificationsKey,
        queryFn: () => api<NotificationsPage>("/api/notifications"),
        enabled,
        staleTime: 60_000,
    });
}

// A new notification, or an existing one updated (merged downloads): newest
// first, replacing any older copy.
const addNotification = (queryClient: QueryClient, { notification, unread }: NotificationEventPayload) =>
    queryClient.setQueryData<NotificationsPage>(notificationsKey, (page) =>
        page
            ? { ...page, unread, notifications: [notification, ...page.notifications.filter((n) => n.id !== notification.id)] }
            : page
    );

export function useNotificationUpdates(enabled: boolean) {
    const queryClient = useQueryClient();
    useEffect(() => {
        if (!enabled) return;
        const socket = getSocket();
        const onNotification = (payload: NotificationEventPayload) => addNotification(queryClient, payload);
        // Read in another tab: refetch to see which.
        const onRead = () => queryClient.invalidateQueries({ queryKey: notificationsKey });
        socket.on("notification", onNotification);
        socket.on("notifications:read", onRead);
        return () => {
            socket.off("notification", onNotification);
            socket.off("notifications:read", onRead);
        };
    }, [enabled, queryClient]);
}

export function useMarkRead() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (target: { ids: string[] } | { all: true }) =>
            api<{ unread: number }>("/api/notifications/read", { method: "POST", body: target }),
        onMutate: (target) =>
            queryClient.setQueryData<NotificationsPage>(notificationsKey, (page) => {
                if (!page) return page;
                const marks = (id: string) => "all" in target || target.ids.includes(id);
                const notifications = page.notifications.map((n) => (marks(n.id) ? { ...n, read: true } : n));
                return { ...page, notifications, unread: Math.max(0, page.unread - (page.notifications.filter((n) => !n.read && marks(n.id)).length)) };
            }),
        onSuccess: ({ unread }) =>
            queryClient.setQueryData<NotificationsPage>(notificationsKey, (page) => (page ? { ...page, unread } : page)),
    });
}
