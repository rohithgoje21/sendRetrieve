import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./Button";

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    description?: ReactNode;
    confirmLabel?: string;
    destructive?: boolean;
    busy?: boolean;
    onConfirm?: () => void;
    onCancel: () => void;
    // When the dialog holds a form: the confirm button submits it.
    formId?: string;
    children?: ReactNode;
}

// Modal confirmation built on the native <dialog>, which handles focus
// trapping, Escape and the backdrop.
export function ConfirmDialog({
    open,
    title,
    description,
    confirmLabel = "Confirm",
    destructive = false,
    busy = false,
    onConfirm,
    onCancel,
    formId,
    children,
}: ConfirmDialogProps) {
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
            onClose={() => open && onCancel()}
            onCancel={(event) => busy && event.preventDefault()}
            className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-zinc-950/50 backdrop:backdrop-blur-sm open:animate-fade-in dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        >
            <div className="p-6">
                <h2 id={titleId} className="text-lg font-semibold">
                    {title}
                </h2>
                {description && <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{description}</div>}
                {children && <div className="mt-4">{children}</div>}
            </div>
            <div className="flex justify-end gap-2 rounded-b-2xl border-t border-zinc-200 bg-zinc-50 px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900/60">
                <Button variant="secondary" onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
                <Button
                    variant={destructive ? "danger" : "primary"}
                    loading={busy}
                    type={formId ? "submit" : "button"}
                    form={formId}
                    onClick={formId ? undefined : onConfirm}
                >
                    {confirmLabel}
                </Button>
            </div>
        </dialog>
    );
}
