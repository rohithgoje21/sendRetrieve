import { io, type Socket } from "socket.io-client";
import { api } from "./api";
import type { WatchedShareState } from "./types";

// One Socket.IO connection for the whole app.
//
// Signed-in users authenticate it with a short-lived token from the API, so
// it works even when the socket server is on another origin than the page
// (frontend on Vercel, API on Render), where session cookies aren't sent.
// Guests connect without a token and can still watch shares they created
// (with the share's manage token).
//
// VITE_REALTIME_URL points at the API's origin when the frontend is hosted
// separately; by default the socket connects to the page's own origin.

const REALTIME_URL = import.meta.env.VITE_REALTIME_URL || undefined;

let socket: Socket | null = null;
let signedIn = false;
// Shares this page shows live activity for (so global toasts can skip them).
const watched = new Set<string>();

export const getSocket = (): Socket =>
    (socket ??= io(REALTIME_URL, {
        autoConnect: false,
        auth: (callback) => {
            if (!signedIn) return callback({});
            api<{ token: string }>("/api/auth/realtime-token")
                .then(({ token }) => callback({ token }))
                .catch(() => callback({}));
        },
    }));

// Reconnects with (or without) the user's identity after login or logout.
export const setRealtimeUser = (isSignedIn: boolean) => {
    const changed = signedIn !== isSignedIn;
    signedIn = isSignedIn;
    const s = getSocket();
    if (changed && s.connected) s.disconnect();
    if (signedIn) s.connect();
    else if (watched.size === 0) s.disconnect();
};

// Watches one share for the rest of the page's life (until the returned
// function is called). Rooms are per connection, so it re-watches after a
// reconnect. `onState` gets the share's state each time watching starts.
export const watchShare = (
    code: string,
    manageToken: string,
    onState?: (state: WatchedShareState) => void
): (() => void) => {
    const s = getSocket();
    const watch = () =>
        s.emit("share:watch", { code, manageToken }, (res: { ok: boolean; share?: WatchedShareState }) => {
            if (res?.ok && res.share) onState?.(res.share);
        });
    watched.add(code);
    s.on("connect", watch);
    if (s.connected) watch();
    else s.connect();

    return () => {
        watched.delete(code);
        s.off("connect", watch);
        if (!signedIn && watched.size === 0) s.disconnect();
    };
};

export const isWatched = (code: string) => watched.has(code);
