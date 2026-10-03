import { Pause, Play, WifiOff, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Alert, Progress } from "@/components/ui/feedback";
import { formatSize, formatTimeLeft } from "@/lib/format";
import type { UploadState } from "@/hooks/useUpload";

const statusText = (state: Exclude<UploadState, { phase: "idle" }>, percent: number) => {
    if (state.phase === "paused") return state.error ? "Upload stopped" : `Paused at ${percent}%`;
    const progress = state.progress;
    if (progress?.state === "offline") return "You're offline. The upload continues when you're back online.";
    if (progress?.state === "retrying") {
        const seconds = progress.retryAt ? Math.max(0, Math.ceil((progress.retryAt - Date.now()) / 1000)) : 0;
        return seconds > 0 ? `Connection problem. Retrying in ${seconds} s…` : "Connection problem. Retrying…";
    }
    return progress ? `Uploading… ${percent}%` : "Starting upload…";
};

// Progress of an upload in progress or paused, with its controls.
export function UploadPanel({
    state,
    onPause,
    onResume,
    onCancel,
}: {
    state: Exclude<UploadState, { phase: "idle" }>;
    onPause: () => void;
    onResume: () => void;
    onCancel: () => void;
}) {
    const progress = state.progress;
    const fraction = progress && progress.total > 0 ? progress.loaded / progress.total : 0;
    const percent = Math.floor(fraction * 100);
    const speed = state.phase === "uploading" && progress?.state === "uploading" ? progress.bytesPerSecond : null;
    const offline = state.phase === "uploading" && progress?.state === "offline";

    return (
        <div className="space-y-3" data-testid="upload-panel">
            <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 text-xs text-zinc-600 dark:text-zinc-400">
                    <span role="status" className="flex items-center gap-1.5">
                        {offline && <WifiOff className="size-3.5" aria-hidden />}
                        {statusText(state, percent)}
                    </span>
                    {progress && (
                        <span className="shrink-0 tabular-nums">
                            {formatSize(progress.loaded)} / {formatSize(progress.total)}
                        </span>
                    )}
                </div>
                <Progress value={fraction * 100} label="Upload progress" />
                {speed !== null && speed > 0 && progress && (
                    <p className="text-xs text-zinc-500 tabular-nums">
                        {formatSize(speed)}/s · {formatTimeLeft((progress.total - progress.loaded) / speed)}
                    </p>
                )}
            </div>

            {state.phase === "paused" && state.error && (
                <Alert tone="error">
                    {state.error} What's uploaded so far is kept: resume to send the rest.
                </Alert>
            )}

            <div className="flex gap-2">
                {state.phase === "uploading" ? (
                    <Button size="lg" variant="secondary" className="flex-1" onClick={onPause}>
                        <Pause aria-hidden />
                        Pause
                    </Button>
                ) : (
                    <Button size="lg" className="flex-1" onClick={onResume}>
                        <Play aria-hidden />
                        Resume
                    </Button>
                )}
                <Button size="lg" variant="ghost" onClick={onCancel}>
                    <X aria-hidden />
                    Cancel
                </Button>
            </div>
        </div>
    );
}
