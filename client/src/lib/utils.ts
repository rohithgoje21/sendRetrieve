import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { ApiError } from "./api";

// Joins class names; later Tailwind classes override earlier conflicting ones.
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

// Puts a failed request's message on the field the server named, or on the
// form as a whole.
export const showServerError =
    <T extends FieldValues>(form: UseFormReturn<T>) =>
    (err: unknown) => {
        const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
        const field = err instanceof ApiError ? err.data.field : undefined;
        if (field && field in form.getValues()) form.setError(field as Path<T>, { message }, { shouldFocus: true });
        else form.setError("root", { message });
    };

// Only same-site paths, so ?next= can't send people to another site.
export const safeNextPath = (next: string | null, fallback = "/shares"): string =>
    next && next.startsWith("/") && !next.startsWith("//") ? next : fallback;
