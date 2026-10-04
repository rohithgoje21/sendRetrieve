// Service worker for browser notifications (Web Push): shows what the server
// pushes, even when the site isn't open, and opens the right page when a
// notification is clicked. Nothing else: no caching, no offline mode.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = { title: event.data ? event.data.text() : "" };
    }
    event.waitUntil(
        self.registration.showNotification(data.title || "sendRetrieve", {
            body: data.body || "",
            // Same tag: a newer notification replaces the older one.
            tag: data.tag,
            renotify: Boolean(data.tag),
            icon: "/favicon.svg",
            data: { url: data.url || "/" },
        })
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    // Only ever this site's own pages.
    const origin = self.location.origin;
    const target = new URL(event.notification.data?.url || "/", origin);
    const url = target.origin === origin ? target.href : `${origin}/`;

    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            const open = windows.find((w) => new URL(w.url).origin === origin);
            if (open) {
                await open.focus();
                if ("navigate" in open) return open.navigate(url).catch(() => self.clients.openWindow(url));
                return;
            }
            return self.clients.openWindow(url);
        })()
    );
});
