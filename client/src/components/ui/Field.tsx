import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ControlProps {
    id?: string;
    invalid?: boolean;
    "aria-describedby"?: string;
}

interface FieldProps {
    label: ReactNode;
    children: ReactElement<ControlProps>;
    error?: string;
    hint?: ReactNode;
    optional?: boolean;
    // Shown at the right of the label, e.g. a "Forgot password?" link
    action?: ReactNode;
    className?: string;
}

// Label + control + hint/error, wired together for screen readers.
export function Field({ label, children, error, hint, optional, action, className }: FieldProps) {
    const generatedId = useId();
    const id = children.props.id ?? generatedId;
    const hintId = hint ? `${id}-hint` : undefined;
    const errorId = error ? `${id}-error` : undefined;
    const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

    return (
        <div className={cn("space-y-1.5", className)}>
            <div className="flex items-baseline justify-between gap-2">
                <label htmlFor={id} className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {label}
                    {optional && <span className="font-normal text-zinc-500"> (optional)</span>}
                </label>
                {action}
            </div>
            {cloneElement(children, { id, invalid: Boolean(error), "aria-describedby": describedBy })}
            {hint && (
                <p id={hintId} className="text-xs text-zinc-500 dark:text-zinc-400">
                    {hint}
                </p>
            )}
            {error && (
                <p id={errorId} className="text-xs font-medium text-red-600 dark:text-red-400">
                    {error}
                </p>
            )}
        </div>
    );
}
