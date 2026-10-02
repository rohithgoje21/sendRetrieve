import type { ComponentProps, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------- Card ---------- */

export function Card({ className, ...props }: ComponentProps<"div">) {
    return (
        <div
            className={cn(
                "rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900",
                className
            )}
            {...props}
        />
    );
}

/* ---------- Alert ---------- */

type AlertTone = "error" | "success" | "warning" | "info";

const alertTones: Record<AlertTone, { className: string; icon: typeof Info }> = {
    error: {
        className: "border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
        icon: XCircle,
    },
    success: {
        className:
            "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300",
        icon: CheckCircle2,
    },
    warning: {
        className:
            "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300",
        icon: AlertTriangle,
    },
    info: {
        className: "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-800/40 dark:text-zinc-300",
        icon: Info,
    },
};

export function Alert({ tone = "info", children, className }: { tone?: AlertTone; children: ReactNode; className?: string }) {
    const { className: toneClass, icon: Icon } = alertTones[tone];
    return (
        <div
            role={tone === "error" ? "alert" : "status"}
            className={cn("flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm", toneClass, className)}
        >
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0">{children}</div>
        </div>
    );
}

/* ---------- Badge ---------- */

type BadgeTone = "neutral" | "success" | "warning" | "danger";

const badgeTones: Record<BadgeTone, string> = {
    neutral: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    success: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/50 dark:text-emerald-400",
    warning: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950/50 dark:text-amber-400",
    danger: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950/50 dark:text-red-400",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-transparent ring-inset",
                badgeTones[tone]
            )}
        >
            {children}
        </span>
    );
}

/* ---------- Progress ---------- */

export function Progress({ value, label }: { value: number; label: string }) {
    return (
        <div
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(value)}
            className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
        >
            <div
                className="h-full rounded-full bg-indigo-500 transition-[width] duration-150"
                style={{ width: `${value}%` }}
            />
        </div>
    );
}

/* ---------- Spinners & skeletons ---------- */

export function PageSpinner() {
    return (
        <div className="flex justify-center py-20" role="status" aria-label="Loading">
            <Loader2 className="size-6 animate-spin text-zinc-400" />
        </div>
    );
}

export function Skeleton({ className }: { className?: string }) {
    return <div className={cn("animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800", className)} />;
}

/* ---------- Empty state ---------- */

export function EmptyState({ icon: Icon, title, children }: { icon: typeof Info; title: string; children?: ReactNode }) {
    return (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-zinc-300 px-6 py-14 text-center dark:border-zinc-700">
            <div className="flex size-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
                <Icon className="size-5 text-zinc-500" aria-hidden />
            </div>
            <h3 className="mt-4 font-medium">{title}</h3>
            {children && <div className="mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">{children}</div>}
        </div>
    );
}
