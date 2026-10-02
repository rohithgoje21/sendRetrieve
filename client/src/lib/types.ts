// Shapes of the API's JSON responses.

export interface User {
    id: string;
    email: string;
    name: string;
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
}

export interface CreatedShare {
    code: string;
    url: string;
    expiresAt: string;
    maxViews: number | null;
    passwordProtected: boolean;
    fileCount: number;
    owned: boolean;
}

export interface SharedFile {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    downloadUrl: string;
    previewUrl: string | null;
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
export type EndedReason = "expired" | "used_up" | "deleted";

export interface OwnedFile {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    downloads: number;
    // Only on the detail endpoint, for active shares
    downloadUrl?: string;
    previewUrl?: string | null;
}

export interface OwnedShare {
    code: string;
    url: string;
    status: ShareStatus;
    endedReason: EndedReason | null;
    hasText: boolean;
    textPreview: string | null;
    files: OwnedFile[];
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
