import { useState, type ComponentProps } from "react";
import { ChevronDown, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { controlClasses } from "./styles";

// `invalid` is set by <Field> when the field has an error.
type WithInvalid<T> = T & { invalid?: boolean };

export function Input({ invalid, className, ...props }: WithInvalid<ComponentProps<"input">>) {
    return <input className={controlClasses(invalid, cn("h-10", className))} aria-invalid={invalid || undefined} {...props} />;
}

export function Textarea({ invalid, className, ...props }: WithInvalid<ComponentProps<"textarea">>) {
    return (
        <textarea
            className={controlClasses(invalid, cn("min-h-28 resize-y py-2.5 leading-relaxed", className))}
            aria-invalid={invalid || undefined}
            {...props}
        />
    );
}

export function Select({ invalid, className, children, ...props }: WithInvalid<ComponentProps<"select">>) {
    return (
        <div className="relative">
            <select
                className={controlClasses(invalid, cn("h-10 cursor-pointer appearance-none pr-9", className))}
                aria-invalid={invalid || undefined}
                {...props}
            >
                {children}
            </select>
            <ChevronDown
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-zinc-500 dark:text-zinc-400"
                aria-hidden
            />
        </div>
    );
}

export function PasswordInput({ className, ...props }: WithInvalid<Omit<ComponentProps<"input">, "type">>) {
    const [visible, setVisible] = useState(false);
    return (
        <div className="relative">
            <Input type={visible ? "text" : "password"} className={cn("pr-10", className)} {...props} />
            <button
                type="button"
                onClick={() => setVisible((v) => !v)}
                className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                aria-label={visible ? "Hide password" : "Show password"}
            >
                {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
        </div>
    );
}
