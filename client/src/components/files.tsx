import { useRef, useState, type DragEvent } from "react";
import { File, FileArchive, FileAudio, FileImage, FileText, FileVideo, UploadCloud, X } from "lucide-react";
import { formatSize } from "@/lib/format";
import { cn } from "@/lib/utils";

export function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
    const Icon = mimeType.startsWith("image/")
        ? FileImage
        : mimeType.startsWith("video/")
          ? FileVideo
          : mimeType.startsWith("audio/")
            ? FileAudio
            : mimeType.startsWith("text/") || mimeType === "application/pdf"
              ? FileText
              : /zip|compressed|tar|rar|7z/.test(mimeType)
                ? FileArchive
                : File;
    return <Icon className={cn("size-5 shrink-0 text-zinc-500", className)} aria-hidden />;
}

interface DropzoneProps {
    onFiles: (files: File[]) => void;
    disabled?: boolean;
    hint: string;
}

export function Dropzone({ onFiles, disabled, hint }: DropzoneProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);

    const onDrop = (event: DragEvent) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) onFiles([...event.dataTransfer.files]);
    };

    return (
        <div
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-disabled={disabled}
            onClick={() => !disabled && inputRef.current?.click()}
            onKeyDown={(event) => {
                if (!disabled && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    inputRef.current?.click();
                }
            }}
            onDragOver={(event) => {
                event.preventDefault();
                if (!disabled) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
                "flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500",
                dragging
                    ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30"
                    : "border-zinc-300 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800/40",
                disabled && "cursor-not-allowed opacity-60"
            )}
        >
            <div className="flex size-10 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
                <UploadCloud className="size-5 text-zinc-600 dark:text-zinc-300" aria-hidden />
            </div>
            <p className="mt-3 text-sm">
                <span className="font-medium">Drop files here</span> or{" "}
                <span className="font-medium text-indigo-600 dark:text-indigo-400">browse</span>
            </p>
            <p className="mt-1 text-xs text-zinc-500">{hint}</p>
            <input
                ref={inputRef}
                type="file"
                multiple
                className="sr-only"
                aria-label="Choose files"
                tabIndex={-1}
                disabled={disabled}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                    onFiles([...(event.target.files ?? [])]);
                    event.target.value = "";
                }}
            />
        </div>
    );
}

export function SelectedFileList({ files, onRemove, disabled }: { files: File[]; onRemove: (index: number) => void; disabled?: boolean }) {
    if (files.length === 0) return null;
    const total = files.reduce((sum, f) => sum + f.size, 0);
    return (
        <div className="space-y-2">
            <ul className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {files.map((file, index) => (
                    <li key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center gap-3 px-3 py-2.5">
                        <FileIcon mimeType={file.type} />
                        <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>
                            {file.name}
                        </span>
                        <span className="text-xs text-zinc-500 tabular-nums">{formatSize(file.size)}</span>
                        <button
                            type="button"
                            onClick={() => onRemove(index)}
                            disabled={disabled}
                            className="flex size-7 cursor-pointer items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                            aria-label={`Remove ${file.name}`}
                        >
                            <X className="size-4" />
                        </button>
                    </li>
                ))}
            </ul>
            <p className="text-right text-xs text-zinc-500">
                {files.length} {files.length === 1 ? "file" : "files"} · {formatSize(total)}
            </p>
        </div>
    );
}

interface FilePreviewProps {
    name: string;
    mimeType: string;
    previewUrl?: string | null;
    // Images: a small version made by the server, and the image's size
    thumbnailUrl?: string | null;
    width?: number | null;
    height?: number | null;
}

// Inline preview for media the server allows to be shown in the page. Images
// show their thumbnail when there is one, linking to the full image.
export function FilePreview({ name, mimeType, previewUrl, thumbnailUrl, width, height }: FilePreviewProps) {
    if (thumbnailUrl) {
        const image = (
            <img
                src={thumbnailUrl}
                alt={name}
                loading="lazy"
                width={width ?? undefined}
                height={height ?? undefined}
                className="mx-auto h-auto max-h-80 max-w-full rounded-lg object-contain"
            />
        );
        return previewUrl ? (
            <a href={previewUrl} target="_blank" rel="noreferrer" title="Open full size">
                {image}
            </a>
        ) : (
            image
        );
    }
    if (!previewUrl) return null;
    if (mimeType.startsWith("image/")) {
        return (
            <img
                src={previewUrl}
                alt={name}
                loading="lazy"
                className="max-h-80 w-full rounded-lg bg-zinc-100 object-contain dark:bg-zinc-800"
            />
        );
    }
    if (mimeType.startsWith("video/")) {
        return <video src={previewUrl} controls preload="metadata" className="max-h-80 w-full rounded-lg bg-black" />;
    }
    if (mimeType.startsWith("audio/")) {
        return <audio src={previewUrl} controls preload="metadata" className="w-full" />;
    }
    return null;
}
