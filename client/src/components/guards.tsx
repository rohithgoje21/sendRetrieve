import { useState } from "react";
import { Navigate, Outlet, useLocation, useSearchParams } from "react-router";
import { useSession } from "@/hooks/useSession";
import { can } from "@/lib/permissions";
import { safeNextPath } from "@/lib/utils";
import { PageSpinner } from "./ui/feedback";

// Pages for signed-in users only; guests go to the login page and come back.
export function RequireAuth() {
    const { user, isLoading } = useSession();
    const location = useLocation();
    if (isLoading) return <PageSpinner />;
    if (!user) {
        const next = encodeURIComponent(location.pathname + location.search);
        return <Navigate to={`/login?next=${next}`} replace />;
    }
    return <Outlet />;
}

// Login and sign-up: already signed in? Go where you were headed.
//
// Decided once, when the page first knows the session. Signing in on the page
// itself mustn't trigger this redirect: the page sends the user on (sign-up
// goes to email verification first).
export function GuestOnly() {
    const { user, isLoading } = useSession();
    const [params] = useSearchParams();
    const [arrivedAs, setArrivedAs] = useState<"guest" | "user" | null>(null);
    if (!isLoading && arrivedAs === null) setArrivedAs(user ? "user" : "guest");

    if (arrivedAs === null) return <PageSpinner />;
    if (arrivedAs === "user") return <Navigate to={safeNextPath(params.get("next"))} replace />;
    return <Outlet />;
}

// Admin pages: signed-in admins and superadmins only.
export function RequireAdmin() {
    const { user, isLoading } = useSession();
    if (isLoading) return <PageSpinner />;
    if (!can(user, "admin.access")) return <NotAllowed />;
    return <Outlet />;
}

function NotAllowed() {
    return (
        <div className="py-16 text-center">
            <title>Not allowed · sendRetrieve</title>
            <h1 className="text-2xl font-bold tracking-tight">You don't have access to this page</h1>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">It's for administrators.</p>
        </div>
    );
}
