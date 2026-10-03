import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getSocket, isWatched, setRealtimeUser, watchShare } from "@/lib/realtime";
import { sharesKey } from "@/lib/queryClient";
import { formatCode, pluralize } from "@/lib/format";
import type { FileDownloadedEvent, ShareEndedEvent, ShareOpenedEvent } from "@/lib/types";
import { useSession } from "./useSession";

const viewsLabel = (e: ShareOpenedEvent) =>
    e.maxViews === null ? `${pluralize(e.views, "view")} so far` : `${e.views} of ${e.maxViews} views used`;

// For the whole signed-in app: keeps My shares in sync and announces activity
// on the user's shares as it happens.
export function useRealtimeUpdates() {
    const { user } = useSession();
    const queryClient = useQueryClient();
    const userId = user?.id;

    useEffect(() => {
        setRealtimeUser(Boolean(userId));
        if (!userId) return;

        const socket = getSocket();
        const refresh = () => queryClient.invalidateQueries({ queryKey: sharesKey });
        const onOpened = (e: ShareOpenedEvent) => {
            refresh();
            if (!isWatched(e.code)) toast(`Share ${formatCode(e.code)} was just opened`, { description: viewsLabel(e) });
        };
        const onDownloaded = (e: FileDownloadedEvent) => {
            refresh();
            if (!isWatched(e.code)) toast(`"${e.fileName}" was downloaded`, { description: `From share ${formatCode(e.code)}` });
        };
        const onEnded = (e: ShareEndedEvent) => {
            refresh();
            if (e.reason === "removed") toast.warning(`Share ${formatCode(e.code)} was removed by an administrator`);
        };

        socket.on("share:created", refresh);
        socket.on("share:opened", onOpened);
        socket.on("file:downloaded", onDownloaded);
        socket.on("share:ended", onEnded);
        return () => {
            socket.off("share:created", refresh);
            socket.off("share:opened", onOpened);
            socket.off("file:downloaded", onDownloaded);
            socket.off("share:ended", onEnded);
        };
    }, [userId, queryClient]);
}

export type ActivityItem =
    | { kind: "opened"; at: string; views: number; maxViews: number | null }
    | { kind: "downloaded"; at: string; fileName: string }
    | { kind: "ended"; at: string; reason: ShareEndedEvent["reason"] };

// Live activity for one share, newest first. Works for guests too: it uses
// the manage token the sender got when creating the share.
export function useShareActivity(code: string, manageToken: string) {
    const [activity, setActivity] = useState<ActivityItem[]>([]);
    const [connected, setConnected] = useState(() => getSocket().connected);

    useEffect(() => {
        const socket = getSocket();
        const add = (item: ActivityItem) => setActivity((items) => [item, ...items].slice(0, 20));
        const onOpened = (e: ShareOpenedEvent) =>
            e.code === code && add({ kind: "opened", at: e.at, views: e.views, maxViews: e.maxViews });
        const onDownloaded = (e: FileDownloadedEvent) =>
            e.code === code && add({ kind: "downloaded", at: e.at, fileName: e.fileName });
        const onEnded = (e: ShareEndedEvent) => e.code === code && add({ kind: "ended", at: e.at, reason: e.reason });
        const onConnect = () => setConnected(true);
        const onDisconnect = () => setConnected(false);

        socket.on("share:opened", onOpened);
        socket.on("file:downloaded", onDownloaded);
        socket.on("share:ended", onEnded);
        socket.on("connect", onConnect);
        socket.on("disconnect", onDisconnect);
        const unwatch = watchShare(code, manageToken);

        return () => {
            unwatch();
            socket.off("share:opened", onOpened);
            socket.off("file:downloaded", onDownloaded);
            socket.off("share:ended", onEnded);
            socket.off("connect", onConnect);
            socket.off("disconnect", onDisconnect);
        };
    }, [code, manageToken]);

    return { activity, connected };
}
