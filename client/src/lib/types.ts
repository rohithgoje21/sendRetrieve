// Shapes of the API's JSON responses.

export type Role = "user" | "admin";

export interface User {
    id: string;
    email: string;
    name: string;
    role: Role;
    emailVerified: boolean;
    createdAt: string;
}

export interface AppConfig {
    maxFiles: number;
    maxFileSizeBytes: number;
    maxTextLength: number;
    expiryOptions: { value: string; label: string }[];
    defaultExpiry: string;
    viewLimitOptions: number[];
    downloadWindowSeconds: number;
    sharePassword: { min: number; max: number };
    accountPassword: { min: number; max: number };
    uploadWindowSeconds: number;
    storage: "s3" | "disk";
}

export interface CreatedShare {
    code: string;
    url: string;
    expiresAt: string;
    maxViews: number | null;
    passwordProtected: boolean;
    fileCount: number;
    owned: boolean;
    // Lets this browser finish the upload and watch the share live.
    manageToken: string;
    // "processing": the files are being scanned for malware; the share can
    // be opened once that's done.
    status: "ready" | "processing";
}

// Where and how the browser uploads one file: a signed object-storage URL,
// or the API's own upload endpoint (disk storage).
export interface UploadTarget {
    fileId: string;
    method: "PUT";
    url: string;
    headers: Record<string, string>;
}

export interface CreateShareResponse extends Omit<CreatedShare, "status"> {
    status: "uploading" | "ready";
    uploads: UploadTarget[];
    uploadExpiresAt: string | null;
}

export interface SharedFile {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    downloadUrl: string;
    previewUrl: string | null;
    // Images: a small preview, and the image's size
    thumbnailUrl: string | null;
    width: number | null;
    height: number | null;
}

export interface OpenedShare {
    code: string;
    text: string | null;
    files: SharedFile[];
    createdAt: string;
    expiresAt: string;
    viewsRemaining: number | null;
    downloadWindowSeconds: number;
}

export type ShareStatus = "active" | "expired" | "deleted";
export type EndedReason = "expired" | "used_up" | "deleted" | "removed" | "malware";
export type ScanStatus = "pending" | "clean" | "infected" | "skipped";

export interface OwnedFile {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    downloads: number;
    scanStatus: ScanStatus;
    // Only on the detail endpoint, for active shares
    downloadUrl?: string;
    previewUrl?: string | null;
    thumbnailUrl?: string | null;
    width?: number | null;
    height?: number | null;
}

export interface OwnedShare {
    code: string;
    url: string;
    status: ShareStatus;
    endedReason: EndedReason | null;
    hasText: boolean;
    textPreview: string | null;
    files: OwnedFile[];
    // Still being scanned for malware: can't be opened yet
    processing: boolean;
    totalSize: number;
    passwordProtected: boolean;
    maxViews: number | null;
    viewsRemaining: number | null;
    views: number;
    createdAt: string;
    expiresAt: string;
    endedAt: string | null;
    // Only on the detail endpoint, for active shares
    text?: string | null;
}

export interface SharesPage {
    status: ShareStatus;
    page: number;
    hasMore: boolean;
    shares: OwnedShare[];
    counts: Record<ShareStatus, number>;
}

// Real-time events (Socket.IO) about a share.
export interface ShareOpenedEvent {
    code: string;
    views: number;
    maxViews: number | null;
    viewsRemaining: number | null;
    at: string;
}

export interface FileDownloadedEvent {
    code: string;
    fileId: string;
    fileName: string;
    downloads: number;
    at: string;
}

export interface ShareEndedEvent {
    code: string;
    reason: EndedReason;
    at: string;
}

// The malware scan: all clear (share:ready), or a file was infected and the
// share removed (share:blocked, followed by share:ended).
export interface ShareReadyEvent {
    code: string;
    at: string;
}

export interface ShareBlockedEvent {
    code: string;
    fileName: string;
    signature: string;
    at: string;
}

// What the server answers when the browser starts watching a share.
export interface WatchedShareState {
    status: "uploading" | "processing" | "ready" | "ended";
    endedReason: EndedReason | null;
}

// Admin dashboard
export interface AdminStats {
    users: { total: number; verified: number; disabled: number; admins: number; newThisWeek: number };
    shares: { active: number; uploading: number; createdToday: number };
    storage: { bytes: number; files: number };
    activity: { views: number; downloads: number };
}

export interface AdminUser extends User {
    disabled: boolean;
    activeShares: number;
}

export interface AdminUsersPage {
    page: number;
    total: number;
    hasMore: boolean;
    users: AdminUser[];
}

export interface AdminShare extends Omit<OwnedShare, "textPreview" | "text"> {
    uploading: boolean;
    owner: { id: string; name: string; email: string } | null;
}
