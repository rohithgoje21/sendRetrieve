import { api } from "./api";

// Browser notifications (Web Push). The service worker (public/sw.js) shows
// what the server pushes, even when the site isn't open. Each browser opts
// in separately: the user allows notifications, the browser subscribes with
// the server's public key, and the server stores the subscription.

export const pushSupported = () =>
    typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// "granted" | "denied" | "default" (not asked yet) | "unsupported"
export const pushPermission = (): NotificationPermission | "unsupported" =>
    pushSupported() ? Notification.permission : "unsupported";

// Base64url (how VAPID keys are written) to the bytes PushManager wants.
const keyBytes = (base64url: string) => {
    const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
};

// This browser's subscription, if it has one.
export async function currentPushSubscription(): Promise<PushSubscription | null> {
    if (!pushSupported()) return null;
    const registration = await navigator.serviceWorker.getRegistration("/");
    return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(publicKey: string) {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
        throw new Error(
            permission === "denied"
                ? "Notifications are blocked for this site. Allow them in your browser's site settings, then try again."
                : "Notifications weren't allowed."
        );
    }
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    await api("/api/notifications/push-subscriptions", { method: "POST", body: subscription.toJSON() });
}

// Stops push to this browser (on the server and in the browser).
export async function disablePush() {
    const subscription = await currentPushSubscription();
    if (!subscription) return;
    await api("/api/notifications/push-subscriptions", { method: "DELETE", body: { endpoint: subscription.endpoint } }).catch(() => {});
    await subscription.unsubscribe();
}
