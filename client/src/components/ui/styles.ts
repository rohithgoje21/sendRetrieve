import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const variants: Record<ButtonVariant, string> = {
    primary:
        "bg-zinc-900 text-white shadow-sm hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200",
    secondary:
        "border border-zinc-200 bg-white text-zinc-900 shadow-xs hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
    ghost: "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
    danger: "bg-red-600 text-white shadow-sm hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500",
};

const sizes: Record<ButtonSize, string> = {
    sm: "h-8 gap-1.5 px-3 text-sm",
    md: "h-10 gap-2 px-4 text-sm",
    lg: "h-12 gap-2 px-5 text-base",
    icon: "size-9",
};

// Shared by <Button> and links styled as buttons.
export const buttonClasses = ({
    variant = "primary",
    size = "md",
    className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) =>
    cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        variants[variant],
        sizes[size],
        className
    );

export const controlClasses = (invalid?: boolean, className?: string) =>
    cn(
        "w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 shadow-xs transition-colors",
        "placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-3 focus:ring-indigo-500/20 focus:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-60 read-only:bg-zinc-50",
        "dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:read-only:bg-zinc-800/50",
        invalid && "border-red-500 focus:border-red-500 focus:ring-red-500/20 dark:border-red-500",
        className
    );
