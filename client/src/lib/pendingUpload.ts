import type { PendingUpload } from "./upload";

// The upload this browser hasn't finished, so it can be resumed after a
// reload. One at a time. Storage can be unavailable (private mode, blocked
// site data): then uploads simply can't be resumed after a reload.

const KEY = "sendretrieve:pending-upload";

export function savePendingUpload(pending: PendingUpload) {
    try {
        localStorage.setItem(KEY, JSON.stringify(pending));
    } catch {
        // not available
    }
}

export function loadPendingUpload(): PendingUpload | null {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        const pending = JSON.parse(raw) as PendingUpload;
        if (!pending?.code || !pending.manageToken || !Array.isArray(pending.files)) return null;
        // Past its deadline, the server has thrown it away.
        if (Date.parse(pending.uploadExpiresAt) <= Date.now()) {
            clearPendingUpload();
            return null;
        }
        return pending;
    } catch {
        return null;
    }
}

export function clearPendingUpload() {
    try {
        localStorage.removeItem(KEY);
    } catch {
        // not available
    }
}
