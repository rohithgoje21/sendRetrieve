import { Download, Paperclip } from "lucide-react";
import { formatSize } from "@/lib/format";
import { CopyButton } from "./CopyButton";
import { FileIcon, FilePreview } from "./files";
import { buttonClasses } from "./ui/styles";

interface ContentFile {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    downloadUrl?: string;
    previewUrl?: string | null;
    thumbnailUrl?: string | null;
    width?: number | null;
    height?: number | null;
    downloads?: number;
}

// A share's message and files: used when opening a share, and for an owner
// viewing their own.
export function SharedContent({ text, files }: { text?: string | null; files: ContentFile[] }) {
    return (
        <div className="space-y-5">
            {text && (
                <section>
                    <div className="mb-2 flex items-center justify-between">
                        <h3 className="text-sm font-medium">Message</h3>
                        <CopyButton value={text} />
                    </div>
                    <pre className="max-h-96 overflow-auto rounded-xl bg-zinc-50 p-4 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap dark:bg-zinc-800/50">
                        {text}
                    </pre>
                </section>
            )}

            {files.length > 0 && (
                <section>
                    <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                        <Paperclip className="size-4 text-zinc-500" aria-hidden />
                        {files.length === 1 ? "1 file" : `${files.length} files`}
                    </h3>
                    <ul className="space-y-2">
                        {files.map((file) => (
                            <li key={file.id} className="space-y-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
                                <FilePreview
                                    name={file.name}
                                    mimeType={file.mimeType}
                                    previewUrl={file.previewUrl}
                                    thumbnailUrl={file.thumbnailUrl}
                                    width={file.width}
                                    height={file.height}
                                />
                                <div className="flex items-center gap-3">
                                    <FileIcon mimeType={file.mimeType} />
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium" title={file.name}>
                                            {file.name}
                                        </p>
                                        <p className="text-xs text-zinc-500">
                                            {formatSize(file.size)}
                                            {file.downloads !== undefined &&
                                                ` · ${file.downloads} ${file.downloads === 1 ? "download" : "downloads"}`}
                                        </p>
                                    </div>
                                    {file.downloadUrl && (
                                        <a
                                            href={file.downloadUrl}
                                            download
                                            className={buttonClasses({ variant: "secondary", size: "sm" })}
                                        >
                                            <Download aria-hidden />
                                            Download
                                        </a>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}
