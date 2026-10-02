import { Link, isRouteErrorResponse, useRouteError } from "react-router";
import { buttonClasses } from "@/components/ui/styles";

function Message({ title, body }: { title: string; body: string }) {
    return (
        <div className="py-16 text-center">
            <title>{`${title} · sendRetrieve`}</title>
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">{body}</p>
            <Link to="/" className={buttonClasses({ className: "mt-6" })}>
                Go to the home page
            </Link>
        </div>
    );
}

export default function NotFoundPage() {
    return <Message title="Page not found" body="There's nothing at this address." />;
}

// Shown if a page crashes while rendering.
export function RouteError() {
    const error = useRouteError();
    if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
    return (
        <div className="mx-auto max-w-md px-4">
            <Message title="Something went wrong" body="An unexpected error occurred. Try again, or go back to the home page." />
        </div>
    );
}
