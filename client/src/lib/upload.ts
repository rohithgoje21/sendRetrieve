import { ApiError, refreshSession, type ApiErrorBody } from "./api";
import type { CreatedShare } from "./types";

interface UploadOptions {
    onProgress?: (loaded: number, total: number) => void;
    signal?: AbortSignal;
}

// XHR rather than fetch: fetch can't report upload progress.
const uploadShare = (form: FormData, { onProgress, signal }: UploadOptions): Promise<CreatedShare> =>
    new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/shares");
        xhr.responseType = "json";

        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) onProgress?.(event.loaded, event.total);
        };
        xhr.onload = () => {
            const body = (xhr.response ?? {}) as CreatedShare & ApiErrorBody;
            if (xhr.status >= 200 && xhr.status < 300) resolve(body);
            else reject(new ApiError(body.error ?? `Upload failed (${xhr.status})`, xhr.status, body));
        };
        xhr.onerror = () => reject(new ApiError("Network error. Check your connection.", 0));
        xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));

        if (signal?.aborted) return xhr.abort();
        signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(form);
    });

// Creates a share, retrying once if the session had expired.
export async function createShare(form: FormData, options: UploadOptions = {}): Promise<CreatedShare> {
    try {
        return await uploadShare(form, options);
    } catch (err) {
        if (!(err instanceof ApiError) || err.data.code !== "token_expired") throw err;
        await refreshSession();
        return uploadShare(form, options);
    }
}
