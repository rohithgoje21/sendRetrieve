import type { ReactNode } from "react";
import { Link } from "react-router";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SegmentItem {
    key: string;
    label: ReactNode;
    active: boolean;
    icon?: LucideIcon;
    count?: number;
    // A link (page sections) or a button (filters).
    to?: string;
    onSelect?: () => void;
}

export function SegmentedControl({ items, label }: { items: SegmentItem[]; label: string }) {
    return (
        <nav aria-label={label} className="flex gap-1 rounded-xl bg-zinc-200/60 p-1 dark:bg-zinc-800/60">
            {items.map(({ key, label: itemLabel, active, icon: Icon, count, to, onSelect }) => {
                const className = cn(
                    "flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-all",
                    "focus-visible:outline-2 focus-visible:outline-indigo-500",
                    active
                        ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
                        : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                );
                const content = (
                    <>
                        {Icon && <Icon className="size-4" aria-hidden />}
                        {itemLabel}
                        {count !== undefined && (
                            <span className="rounded-full bg-zinc-200/80 px-1.5 text-xs tabular-nums dark:bg-zinc-700/80">
                                {count}
                            </span>
                        )}
                    </>
                );
                return to ? (
                    <Link key={key} to={to} className={className} aria-current={active ? "page" : undefined}>
                        {content}
                    </Link>
                ) : (
                    <button key={key} type="button" onClick={onSelect} className={className} aria-pressed={active}>
                        {content}
                    </button>
                );
            })}
        </nav>
    );
}
