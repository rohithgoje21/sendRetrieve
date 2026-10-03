import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError } from "@/lib/api";
import { clearPendingUpload, savePendingUpload } from "@/lib/pendingUpload";
import {
    createShare,
    discardUpload,
    isResumable,
    resumeUpload,
    type PendingUpload,
    type ShareInput,
    type UploadOptions,
    type UploadProgress,
} from "@/lib/upload";
import type { CreatedShare } from "@/lib/types";

export type UploadState =
    | { phase: "idle" }
    | { phase: "uploading"; progress: UploadProgress | null }
    // Stopped by the user, or by a failure retries couldn't fix: can be resumed.
    | { phase: "paused"; progress: UploadProgress | null; error: string | null };

// Runs one share's upload: start, pause, resume, cancel. An unfinished upload
// is remembered (localStorage) so it can be resumed after a reload.
//
// start() and resume() resolve when the upload finishes or pauses; they
// reject when it fails for good (e.g. the server refused a file), after which
// the upload is forgotten.
export function useUpload(onDone: (share: CreatedShare) => void) {
    const [state, setState] = useState<UploadState>({ phase: "idle" });
    const pending = useRef<PendingUpload | null>(null);
    const files = useRef<File[]>([]);
    const controller = useRef<AbortController | null>(null);
    const cancelled = useRef(false);
    const lastProgress = useRef<UploadProgress | null>(null);
    const done = useRef(onDone);
    useEffect(() => {
        done.current = onDone;
    }, [onDone]);

    // Leaving the page stops the upload: ask first.
    useEffect(() => {
        if (state.phase !== "uploading") return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [state.phase]);

    // Navigating away within the app stops it too (it can be resumed later).
    useEffect(() => () => controller.current?.abort(), []);

    const forget = () => {
        clearPendingUpload();
        pending.current = null;
        lastProgress.current = null;
    };

    const run = useCallback(async (work: (options: UploadOptions) => Promise<CreatedShare>) => {
        const current = new AbortController();
        controller.current = current;
        cancelled.current = false;
        setState({ phase: "uploading", progress: lastProgress.current });
        try {
            const share = await work({
                signal: current.signal,
                onProgress: (progress) => {
                    lastProgress.current = progress;
                    setState({ phase: "uploading", progress });
                },
                onPending: (p) => {
                    pending.current = p;
                    savePendingUpload(p);
                },
            });
            forget();
            setState({ phase: "idle" });
            done.current(share);
        } catch (err) {
            if (cancelled.current) return; // cancel() has dealt with it
            if (pending.current && (isAbortError(err) || isResumable(err))) {
                const error = isAbortError(err) ? null : err instanceof Error ? err.message : "The upload stopped.";
                setState({ phase: "paused", progress: lastProgress.current, error });
                return;
            }
            forget();
            setState({ phase: "idle" });
            throw err;
        } finally {
            if (controller.current === current) controller.current = null;
        }
    }, []);

    const start = useCallback(
        (input: ShareInput) => {
            files.current = input.files;
            return run((options) => createShare(input, options));
        },
        [run]
    );

    // Continues the current upload, or (after a reload) `from` with the
    // files the user picked again.
    const resume = useCallback(
        (from?: { pending: PendingUpload; files: File[] }) => {
            if (from) {
                pending.current = from.pending;
                files.current = from.files;
            }
            const target = pending.current;
            if (!target) return Promise.resolve();
            return run((options) => resumeUpload(target, files.current, options));
        },
        [run]
    );

    const pause = useCallback(() => controller.current?.abort(), []);

    // Stops and throws the upload away (the server deletes what it got).
    const cancel = useCallback(async () => {
        cancelled.current = true;
        controller.current?.abort();
        const target = pending.current;
        forget();
        setState({ phase: "idle" });
        if (target) await discardUpload(target);
    }, []);

    return { state, start, resume, pause, cancel };
}
