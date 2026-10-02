// JSON client for the API. Sessions live in httpOnly cookies, so there's no
// token handling here beyond one thing: when the access token has expired,
// refresh the session once and retry.

export interface ApiErrorBody {
    error?: string;
    field?: string;
    code?: string;
    passwordRequired?: boolean;
    retryAfterSeconds?: number;
    requestId?: string;
}

export class ApiError extends Error {
    readonly status: number;
    readonly data: ApiErrorBody;

    constructor(message: string, status: number, data: ApiErrorBody = {}) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.data = data;
    }
}

export const isAbortError = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

// Requests that hit an expired token at the same moment share one refresh.
let refreshing: Promise<boolean> | null = null;

export const refreshSession = (): Promise<boolean> =>
    (refreshing ??= fetch("/api/auth/refresh", { method: "POST" })
        .then((res) => res.ok)
        .catch(() => false)
        .finally(() => {
            refreshing = null;
        }));

interface RequestOptions {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}, retry = true): Promise<T> {
    const { method = "GET", body, signal } = options;

    let res: Response;
    try {
        res = await fetch(path, {
            method,
            signal,
            headers: body === undefined ? undefined : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch (err) {
        if (isAbortError(err)) throw err;
        throw new ApiError("Network error. Check your connection.", 0);
    }

    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));

    if (res.status === 401 && data.code === "token_expired" && retry) {
        await refreshSession();
        return api<T>(path, options, false);
    }
    if (!res.ok) {
        throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
    }
    return data as T;
}
