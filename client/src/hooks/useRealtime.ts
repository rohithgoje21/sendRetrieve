import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getSocket, isWatched, setRealtimeUser, watchShare } from "@/lib/realtime";
import { sharesKey } from "@/lib/queryClient";
import { formatCode, pluralize } from "@/lib/format";
import type {
    EndedReason,
    FileDownloadedEvent,
    ShareBlockedEvent,
    ShareEndedEvent,
    ShareOpenedEvent,
    ShareReadyEvent,
    WatchedShareState,
} from "@/lib/types";
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
        const onBlocked = (e: ShareBlockedEvent) => {
            refresh();
            if (!isWatched(e.code)) {
                toast.error(`Share ${formatCode(e.code)} was blocked`, { description: `"${e.fileName}" contains malware` });
            }
        };

        socket.on("share:created", refresh);
        socket.on("share:ready", refresh);
        socket.on("share:opened", onOpened);
        socket.on("file:downloaded", onDownloaded);
        socket.on("share:ended", onEnded);
        socket.on("share:blocked", onBlocked);
        return () => {
            socket.off("share:created", refresh);
            socket.off("share:ready", refresh);
            socket.off("share:opened", onOpened);
            socket.off("file:downloaded", onDownloaded);
            socket.off("share:ended", onEnded);
            socket.off("share:blocked", onBlocked);
        };
    }, [userId, queryClient]);
}

export type ActivityItem =
    | { kind: "opened"; at: string; views: number; maxViews: number | null }
    | { kind: "downloaded"; at: string; fileName: string }
    | { kind: "ended"; at: string; reason: ShareEndedEvent["reason"] };

// Where a just-created share stands: being scanned, open for business, found
// to contain malware (and removed), or over for another reason.
export type LiveShareStatus =
    | { status: "processing" }
    | { status: "ready" }
    | { status: "blocked"; fileName: string | null; signature: string | null }
    | { status: "ended"; reason: EndedReason | null };

// Live activity for one share, newest first, and its status. Works for guests
// too: it uses the manage token the sender got when creating the share.
export function useShareActivity(code: string, manageToken: string, initialStatus: "ready" | "processing" = "ready") {
    const [activity, setActivity] = useState<ActivityItem[]>([]);
    const [connected, setConnected] = useState(() => getSocket().connected);
    const [status, setStatus] = useState<LiveShareStatus>({ status: initialStatus });

    useEffect(() => {
        const socket = getSocket();
        const add = (item: ActivityItem) => setActivity((items) => [item, ...items].slice(0, 20));
        const onOpened = (e: ShareOpenedEvent) =>
            e.code === code && add({ kind: "opened", at: e.at, views: e.views, maxViews: e.maxViews });
        const onDownloaded = (e: FileDownloadedEvent) =>
            e.code === code && add({ kind: "downloaded", at: e.at, fileName: e.fileName });
        const onEnded = (e: ShareEndedEvent) => {
            if (e.code !== code) return;
            if (e.reason === "malware") {
                // share:blocked (with the details) normally comes first
                setStatus((s) => (s.status === "blocked" ? s : { status: "blocked", fileName: null, signature: null }));
            } else {
                add({ kind: "ended", at: e.at, reason: e.reason });
                setStatus({ status: "ended", reason: e.reason });
            }
        };
        const onReady = (e: ShareReadyEvent) => e.code === code && setStatus({ status: "ready" });
        const onBlocked = (e: ShareBlockedEvent) =>
            e.code === code && setStatus({ status: "blocked", fileName: e.fileName, signature: e.signature });
        // The state when watching starts: the scan may have finished already.
        const onState = (state: WatchedShareState) => {
            if (state.status === "uploading") return;
            if (state.status === "ready" || state.status === "processing") setStatus({ status: state.status });
            else if (state.endedReason === "malware") {
                setStatus((s) => (s.status === "blocked" ? s : { status: "blocked", fileName: null, signature: null }));
            } else setStatus({ status: "ended", reason: state.endedReason });
        };
        const onConnect = () => setConnected(true);
        const onDisconnect = () => setConnected(false);

        socket.on("share:opened", onOpened);
        socket.on("file:downloaded", onDownloaded);
        socket.on("share:ended", onEnded);
        socket.on("share:ready", onReady);
        socket.on("share:blocked", onBlocked);
        socket.on("connect", onConnect);
        socket.on("disconnect", onDisconnect);
        const unwatch = watchShare(code, manageToken, onState);

        return () => {
            unwatch();
            socket.off("share:opened", onOpened);
            socket.off("file:downloaded", onDownloaded);
            socket.off("share:ended", onEnded);
            socket.off("share:ready", onReady);
            socket.off("share:blocked", onBlocked);
            socket.off("connect", onConnect);
            socket.off("disconnect", onDisconnect);
        };
    }, [code, manageToken]);

    return { activity, connected, status };
}
