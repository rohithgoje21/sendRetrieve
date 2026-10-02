import { Navigate, Outlet, useLocation, useSearchParams } from "react-router";
import { useSession } from "@/hooks/useSession";
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
export function GuestOnly() {
    const { user, isLoading } = useSession();
    const [params] = useSearchParams();
    if (isLoading) return <PageSpinner />;
    if (user) return <Navigate to={safeNextPath(params.get("next"))} replace />;
    return <Outlet />;
}
