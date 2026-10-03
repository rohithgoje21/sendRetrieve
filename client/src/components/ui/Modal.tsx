import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ModalProps {
    open: boolean;
    title: string;
    onClose: () => void;
    children: ReactNode;
    className?: string;
}

// A dialog built on the native <dialog>, which handles focus trapping,
// Escape and the backdrop.
export function Modal({ open, title, onClose, children, className }: ModalProps) {
    const ref = useRef<HTMLDialogElement>(null);
    const titleId = useId();

    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        if (open && !dialog.open) dialog.showModal();
        if (!open && dialog.open) dialog.close();
    }, [open]);

    return (
        <dialog
            ref={ref}
            aria-labelledby={titleId}
            onClose={() => open && onClose()}
            // Clicking the backdrop (the dialog element itself) closes it.
            onClick={(event) => event.target === ref.current && onClose()}
            className={cn(
                "m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-zinc-950/50 backdrop:backdrop-blur-sm open:animate-fade-in dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100",
                className
            )}
        >
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
                <h2 id={titleId} className="font-semibold">
                    {title}
                </h2>
                <button
                    type="button"
                    onClick={onClose}
                    className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    aria-label="Close"
                >
                    <X className="size-4" />
                </button>
            </div>
            <div className="p-5">{children}</div>
        </dialog>
    );
}
