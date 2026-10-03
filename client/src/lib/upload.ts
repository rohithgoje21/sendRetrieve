import { api, ApiError, isAbortError } from "./api";
import type { CreatedShare, CreateShareResponse, PartTarget, ResumeResponse, SignedUpload, UploadTarget } from "./types";

// Creating a share with files takes three steps:
//   1. POST /api/shares with the files' names, sizes and types. The server
//      answers with a signed upload URL per small file, and a part layout for
//      each big one.
//   2. Upload: small files are PUT whole; big files in parts, each to its own
//      signed URL (fetched in batches as the upload goes). URLs point at object
//      storage (MinIO, S3, R2), or at the API when it stores files on disk.
//      Failed requests are retried with backoff; while offline, the upload
//      waits for the connection to come back.
//   3. POST /api/shares/:code/complete. The server checks every file arrived
//      intact and detects its real type. The share goes live, or first gets
//      scanned for malware ("processing") when the server has a scanner.
//
// An interrupted upload (paused, failed, tab closed) can be resumed: the
// server says what it already has (POST /api/shares/:code/resume) and only
// the rest is sent. After a reload the browser needs the same files again.

export interface ShareInput {
    text: string;
    expiresIn: string;
    maxViews: number | null;
    password: string;
    files: File[];
}

// What the browser keeps (in localStorage) to resume an upload later.
export interface PendingUpload {
    code: string;
    manageToken: string;
    owned: boolean;
    startedAt: string;
    uploadExpiresAt: string;
    files: { name: string; size: number; type: string; lastModified: number }[];
}

export interface UploadProgress {
    loaded: number;
    total: number;
    // "retrying": a request failed and is tried again at retryAt;
    // "offline": waiting for the connection to come back.
    state: "uploading" | "retrying" | "offline";
    retryAt: number | null;
    bytesPerSecond: number | null;
}

export interface UploadOptions {
    onProgress?: (progress: UploadProgress) => void;
    // Called once the share exists on the server, so it can be resumed.
    onPending?: (pending: PendingUpload) => void;
    // Aborting stops the upload; the share stays, so it can be resumed or
    // discarded (discardUpload).
    signal?: AbortSignal;
}

export const uploadSettings = {
    parallel: 4,
    // Part URLs asked for at once.
    partBatch: 20,
    // Signed part URLs last 15 minutes; refresh well before.
    partUrlMaxAgeMs: 10 * 60 * 1000,
    // Waits before each retry of a failed request (about a minute in all);
    // after the last, the upload stops (it can be resumed).
    retryDelaysMs: [1000, 2000, 4000, 8000, 16000, 30000],
};

const abortError = () => new DOMException("Upload cancelled", "AbortError");

const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(abortError());
            },
            { once: true }
        );
    });

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

const waitForOnline = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (!isOffline()) return resolve();
        const done = () => {
            window.removeEventListener("online", done);
            if (signal?.aborted) reject(abortError());
            else resolve();
        };
        window.addEventListener("online", done);
        signal?.addEventListener("abort", done, { once: true });
    });

// Network errors, timeouts, rate limits and server errors are worth another
// try; so is 403, which a signed URL gives once it has expired.
const isRetryable = (err: unknown) =>
    err instanceof ApiError && (err.status === 0 || err.status === 403 || err.status === 408 || err.status === 429 || err.status >= 500);

// Whether an upload that failed with `err` can be picked up again later.
export const isResumable = (err: unknown) => isRetryable(err) || (err instanceof ApiError && err.status === 409);

type Wait = { offline: boolean; retryAt: number | null };

// Runs `attempt`, retrying failures worth retrying with exponential backoff
// (with jitter, so parallel retries spread out). While offline, it waits for
// the connection instead, which doesn't use up a retry.
async function withRetries<T>(
    attempt: () => Promise<T>,
    { signal, onWait, onFailure }: { signal?: AbortSignal; onWait?: (wait: Wait | null) => void; onFailure?: (err: unknown) => void } = {}
): Promise<T> {
    for (let retries = 0; ; retries++) {
        try {
            return await attempt();
        } catch (err) {
            if (isAbortError(err) || !isRetryable(err) || retries >= uploadSettings.retryDelaysMs.length) throw err;
            onFailure?.(err);
            if (isOffline()) {
                onWait?.({ offline: true, retryAt: null });
                await waitForOnline(signal);
                retries--;
            } else {
                const delay = uploadSettings.retryDelaysMs[retries] * (0.75 + Math.random() * 0.5);
                onWait?.({ offline: false, retryAt: Date.now() + delay });
                await sleep(delay, signal);
            }
            onWait?.(null);
        }
    }
}

// XHR rather than fetch: fetch can't report upload progress.
export const uploadBlob = (
    target: SignedUpload,
    body: Blob,
    fileName: string,
    { onProgress, signal }: { onProgress?: (loaded: number) => void; signal?: AbortSignal } = {}
) =>
    new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(target.method, target.url);
        for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);

        xhr.upload.onprogress = (event) => onProgress?.(event.loaded);
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) return resolve();
            reject(new ApiError(`Uploading "${fileName}" failed (${xhr.status}).`, xhr.status));
        };
        xhr.onerror = () => reject(new ApiError(`Uploading "${fileName}" failed. Check your connection.`, 0));
        xhr.onabort = () => reject(abortError());

        if (signal?.aborted) return reject(abortError());
        signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(body);
    });

// ---- The upload itself ----

interface Task {
    size: number;
    run: (onProgress: (loaded: number) => void, signal: AbortSignal | undefined) => Promise<void>;
    // A failed attempt may mean its signed URL expired: get a fresh one.
    refresh: () => void;
}

// What's left to upload for one file.
type FilePlan =
    | { kind: "done"; size: number }
    | { kind: "single"; file: File; fileId: string; target: SignedUpload }
    | { kind: "multipart"; file: File; fileId: string; partSize: number; partCount: number; uploaded: number[] };

interface Session {
    code: string;
    manageToken: string;
}

// Hands out signed part URLs for one file, fetched in batches as needed.
function partUrls(session: Session, fileId: string, queue: number[], signal?: AbortSignal) {
    const cache = new Map<number, { target: PartTarget; at: number }>();
    let inflight: Promise<void> | null = null;

    const fetchBatch = async (first: number) => {
        const index = queue.indexOf(first);
        const wanted = [first, ...queue.slice(index + 1).filter((n) => !cache.has(n))].slice(0, uploadSettings.partBatch);
        const { parts } = await api<{ parts: PartTarget[] }>(`/api/shares/${session.code}/uploads/${fileId}/parts`, {
            method: "POST",
            body: { manageToken: session.manageToken, partNumbers: wanted },
            signal,
        });
        const at = Date.now();
        for (const part of parts) cache.set(part.partNumber, { target: part, at });
    };

    return {
        async get(partNumber: number): Promise<PartTarget> {
            for (;;) {
                const cached = cache.get(partNumber);
                if (cached && Date.now() - cached.at < uploadSettings.partUrlMaxAgeMs) return cached.target;
                if (!inflight) {
                    inflight = fetchBatch(partNumber).finally(() => {
                        inflight = null;
                    });
                    await inflight;
                    const fetched = cache.get(partNumber);
                    if (fetched) return fetched.target;
                    throw new ApiError("The server didn't return an upload URL for a part.", 500);
                }
                await inflight.catch(() => {});
            }
        },
        forget(partNumber: number) {
            cache.delete(partNumber);
        },
    };
}

const tasksFor = (session: Session, plans: FilePlan[], signal?: AbortSignal): { tasks: Task[]; alreadyUploaded: number } => {
    const tasks: Task[] = [];
    let alreadyUploaded = 0;

    for (const plan of plans) {
        if (plan.kind === "done") {
            alreadyUploaded += plan.size;
            continue;
        }
        if (plan.kind === "single") {
            let target = plan.target;
            let stale = false;
            tasks.push({
                size: plan.file.size,
                run: async (onProgress, taskSignal) => {
                    if (stale) {
                        // A fresh signed URL for this file.
                        const state = await api<ResumeResponse>(`/api/shares/${session.code}/resume`, {
                            method: "POST",
                            body: { manageToken: session.manageToken },
                            signal: taskSignal,
                        });
                        const fresh = state.files.find((f) => f.fileId === plan.fileId);
                        if (fresh?.uploaded) return;
                        if (fresh?.url) target = fresh as SignedUpload;
                        stale = false;
                    }
                    await uploadBlob(target, plan.file, plan.file.name, { onProgress, signal: taskSignal });
                },
                refresh: () => {
                    stale = true;
                },
            });
            continue;
        }

        const uploaded = new Set(plan.uploaded);
        const missing = Array.from({ length: plan.partCount }, (_, i) => i + 1).filter((n) => !uploaded.has(n));
        const urls = partUrls(session, plan.fileId, missing, signal);
        for (let n = 1; n <= plan.partCount; n++) {
            const start = (n - 1) * plan.partSize;
            const end = Math.min(start + plan.partSize, plan.file.size);
            if (uploaded.has(n)) {
                alreadyUploaded += end - start;
                continue;
            }
            const partNumber = n;
            tasks.push({
                size: end - start,
                run: async (onProgress, taskSignal) => {
                    const target = await urls.get(partNumber);
                    await uploadBlob(target, plan.file.slice(start, end), plan.file.name, { onProgress, signal: taskSignal });
                },
                refresh: () => urls.forget(partNumber),
            });
        }
    }
    return { tasks, alreadyUploaded };
};

// Runs the tasks, a few at a time, each retried with backoff.
// Rejects with the first error that retries didn't fix (stopping the rest).
async function runTasks(
    tasks: Task[],
    total: number,
    alreadyUploaded: number,
    { onProgress, controller }: { onProgress?: UploadOptions["onProgress"]; controller: AbortController }
) {
    const { signal } = controller;
    let finished = alreadyUploaded;
    const inFlight = new Map<number, number>();
    const waiting = new Map<number, Wait>();
    const samples: { at: number; loaded: number }[] = [];

    const report = () => {
        const loaded = finished + [...inFlight.values()].reduce((sum, n) => sum + n, 0);
        const now = Date.now();
        samples.push({ at: now, loaded });
        while (samples.length > 2 && now - samples[0].at > 5000) samples.shift();
        const span = (now - samples[0].at) / 1000;
        const bytesPerSecond = span >= 1 ? Math.max(0, (loaded - samples[0].loaded) / span) : null;

        const waits = [...waiting.values()];
        const offline = waits.some((w) => w.offline);
        const retryAts = waits.map((w) => w.retryAt).filter((t): t is number => t !== null);
        onProgress?.({
            loaded: Math.min(loaded, total),
            total,
            state: offline ? "offline" : waits.length ? "retrying" : "uploading",
            retryAt: retryAts.length ? Math.min(...retryAts) : null,
            bytesPerSecond,
        });
    };

    const runOne = async (task: Task, id: number) => {
        await withRetries(
            () =>
                task.run((loaded) => {
                    inFlight.set(id, Math.min(loaded, task.size));
                    report();
                }, signal),
            {
                signal,
                onFailure: (err) => {
                    inFlight.delete(id);
                    if (err instanceof ApiError && err.status === 403) task.refresh();
                },
                onWait: (wait) => {
                    if (wait) waiting.set(id, wait);
                    else waiting.delete(id);
                    report();
                },
            }
        );
        inFlight.delete(id);
        finished += task.size;
        report();
    };

    // Keeps the countdown and speed moving while nothing else reports.
    const ticker = setInterval(report, 1000);
    try {
        let next = 0;
        let failure: unknown = null;
        const worker = async () => {
            while (next < tasks.length && failure === null) {
                const id = next++;
                try {
                    await runOne(tasks[id], id);
                } catch (err) {
                    failure ??= err;
                    controller.abort();
                }
            }
        };
        report();
        await Promise.all(Array.from({ length: Math.min(uploadSettings.parallel, tasks.length) }, worker));
        if (failure !== null) throw failure;
    } finally {
        clearInterval(ticker);
    }
}

const planFromCreate = (files: File[], uploads: UploadTarget[]): FilePlan[] =>
    uploads.map((target, i) =>
        target.multipart
            ? { kind: "multipart", file: files[i], fileId: target.fileId, ...target.multipart, uploaded: [] }
            : { kind: "single", file: files[i], fileId: target.fileId, target }
    );

const planFromResume = (files: File[], state: ResumeResponse): FilePlan[] =>
    state.files.map((f, i) => {
        if (f.uploaded) return { kind: "done", size: f.size };
        if (f.multipart) {
            return {
                kind: "multipart",
                file: files[i],
                fileId: f.fileId,
                partSize: f.multipart.partSize,
                partCount: f.multipart.partCount,
                uploaded: f.multipart.uploadedParts ?? [],
            };
        }
        return { kind: "single", file: files[i], fileId: f.fileId, target: f as SignedUpload };
    });

async function uploadAndComplete(session: Session, plans: FilePlan[], options: UploadOptions): Promise<CreatedShare> {
    const total = plans.reduce((sum, p) => sum + (p.kind === "done" ? p.size : p.file.size), 0);
    // Stops every request when the caller aborts, or when one fails for good.
    const controller = new AbortController();
    if (options.signal?.aborted) throw abortError();
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    let last: UploadProgress = { loaded: 0, total, state: "uploading", retryAt: null, bytesPerSecond: null };
    const onProgress = (progress: UploadProgress) => {
        last = progress;
        options.onProgress?.(progress);
    };

    const { tasks, alreadyUploaded } = tasksFor(session, plans, controller.signal);
    await runTasks(tasks, total, alreadyUploaded, { onProgress, controller });
    if (options.signal?.aborted) throw abortError();

    // Safe to retry: completing an already completed share gives the same answer.
    const completed = await withRetries(
        () =>
            api<CreatedShare>(`/api/shares/${session.code}/complete`, {
                method: "POST",
                body: { manageToken: session.manageToken },
                signal: options.signal,
            }),
        {
            signal: options.signal,
            onWait: (wait) =>
                options.onProgress?.({
                    ...last,
                    state: wait ? (wait.offline ? "offline" : "retrying") : "uploading",
                    retryAt: wait?.retryAt ?? null,
                    bytesPerSecond: null,
                }),
        }
    );
    return { ...completed, manageToken: session.manageToken };
}

export async function createShare(input: ShareInput, options: UploadOptions = {}): Promise<CreatedShare> {
    const created = await api<CreateShareResponse>("/api/shares", {
        method: "POST",
        signal: options.signal,
        body: {
            text: input.text.trim() ? input.text : null,
            expiresIn: input.expiresIn,
            maxViews: input.maxViews,
            password: input.password || null,
            files: input.files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
        },
    });
    if (created.status === "ready") return { ...created, status: "ready" };

    options.onPending?.({
        code: created.code,
        manageToken: created.manageToken,
        owned: created.owned,
        startedAt: new Date().toISOString(),
        uploadExpiresAt: created.uploadExpiresAt ?? created.expiresAt,
        files: input.files.map((f) => ({ name: f.name, size: f.size, type: f.type, lastModified: f.lastModified })),
    });
    return uploadAndComplete(created, planFromCreate(input.files, created.uploads), options);
}

// Continues an upload: only what the server doesn't have yet is sent.
// `files` must be the same files, in the same order (see matchFiles).
export async function resumeUpload(pending: PendingUpload, files: File[], options: UploadOptions = {}): Promise<CreatedShare> {
    const state = await withRetries(
        () =>
            api<ResumeResponse>(`/api/shares/${pending.code}/resume`, {
                method: "POST",
                body: { manageToken: pending.manageToken },
                signal: options.signal,
            }),
        { signal: options.signal }
    );
    options.onPending?.({ ...pending, uploadExpiresAt: state.uploadExpiresAt });
    return uploadAndComplete(pending, planFromResume(files, state), options);
}

// Gives up on an upload: the server deletes whatever was uploaded.
export const discardUpload = (pending: Pick<PendingUpload, "code" | "manageToken">) =>
    api(`/api/shares/${pending.code}/cancel`, { method: "POST", body: { manageToken: pending.manageToken } }).catch(() => {});

// Lines up files the user picked with the ones the upload was started with
// (same name, size and modification time). Returns them in the upload's
// order, or the names still missing.
export function matchFiles(pending: PendingUpload, chosen: File[]): { files: File[] } | { missing: string[] } {
    const files: File[] = [];
    const missing: string[] = [];
    for (const expected of pending.files) {
        const match = chosen.find(
            (f) => f.name === expected.name && f.size === expected.size && f.lastModified === expected.lastModified
        );
        if (match) files.push(match);
        else missing.push(expected.name);
    }
    return missing.length ? { missing } : { files };
}
