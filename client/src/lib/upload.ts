import { api, ApiError } from "./api";
import type { CreatedShare, CreateShareResponse, UploadTarget } from "./types";

// Creating a share with files takes three steps:
//   1. POST /api/shares with the files' names, sizes and types. The server
//      answers with one signed upload URL per file.
//   2. PUT each file straight to its URL: object storage (MinIO, S3, R2),
//      or the API itself when the server stores files on disk. File bytes
//      never pass through the API when object storage is used.
//   3. POST /api/shares/:code/complete. The server checks every file arrived
//      intact and detects its real type. The share goes live, or first gets
//      scanned for malware ("processing") when the server has a scanner.

export interface ShareInput {
    text: string;
    expiresIn: string;
    maxViews: number | null;
    password: string;
    files: File[];
}

interface UploadOptions {
    onProgress?: (loaded: number, total: number) => void;
    signal?: AbortSignal;
}

const PARALLEL_UPLOADS = 3;

const abortError = () => new DOMException("Upload cancelled", "AbortError");

// XHR rather than fetch: fetch can't report upload progress.
export const uploadFile = (target: UploadTarget, file: File, { onProgress, signal }: UploadOptions = {}) =>
    new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(target.method, target.url);
        for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);

        xhr.upload.onprogress = (event) => onProgress?.(event.loaded, event.total);
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) return resolve();
            reject(new ApiError(`Uploading "${file.name}" failed (${xhr.status}). Please try again.`, xhr.status));
        };
        xhr.onerror = () => reject(new ApiError(`Uploading "${file.name}" failed. Check your connection.`, 0));
        xhr.onabort = () => reject(abortError());

        if (signal?.aborted) return reject(abortError());
        signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(file);
    });

// Runs `tasks` with at most `limit` in flight; rejects on the first failure.
const runLimited = async (tasks: (() => Promise<void>)[], limit: number) => {
    let next = 0;
    const worker = async () => {
        while (next < tasks.length) await tasks[next++]();
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
};

export async function createShare(input: ShareInput, { onProgress, signal }: UploadOptions = {}): Promise<CreatedShare> {
    const created = await api<CreateShareResponse>("/api/shares", {
        method: "POST",
        signal,
        body: {
            text: input.text.trim() ? input.text : null,
            expiresIn: input.expiresIn,
            maxViews: input.maxViews,
            password: input.password || null,
            files: input.files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
        },
    });
    if (created.status === "ready") return { ...created, status: "ready" };

    const { code, manageToken } = created;
    const total = input.files.reduce((sum, file) => sum + file.size, 0);
    const loaded = input.files.map(() => 0);

    try {
        await runLimited(
            created.uploads.map((target, i) => () =>
                uploadFile(target, input.files[i], {
                    signal,
                    onProgress: (bytes) => {
                        loaded[i] = Math.min(bytes, input.files[i].size);
                        onProgress?.(loaded.reduce((sum, n) => sum + n, 0), total);
                    },
                })
            ),
            PARALLEL_UPLOADS
        );
        if (signal?.aborted) throw abortError();
        const completed = await api<CreatedShare>(`/api/shares/${code}/complete`, {
            method: "POST",
            body: { manageToken },
        });
        return { ...completed, manageToken };
    } catch (err) {
        // Free the storage now rather than waiting for the server's cleanup,
        // unless the server already discarded the share (it rejected the files,
        // e.g. an executable, or the upload window had passed).
        const discarded = err instanceof ApiError && (err.status === 422 || err.status === 404);
        if (!discarded) api(`/api/shares/${code}/cancel`, { method: "POST", body: { manageToken } }).catch(() => {});
        throw err;
    }
}
