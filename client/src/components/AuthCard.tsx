import type { ReactNode } from "react";
import { Card } from "./ui/feedback";
import { Logo } from "./layout";

export function AuthCard({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
    return (
        <div className="mx-auto max-w-sm">
            <title>{`${title} · sendRetrieve`}</title>
            <div className="mb-6 flex flex-col items-center text-center">
                <Logo className="size-10" />
                <h1 className="mt-4 text-2xl font-bold tracking-tight">{title}</h1>
                {description && <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">{description}</p>}
            </div>
            <Card className="p-6">{children}</Card>
            {footer && <div className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">{footer}</div>}
        </div>
    );
}
