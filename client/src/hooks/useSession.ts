import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { disablePush } from "@/lib/push";
import { sessionKey, sharesKey } from "@/lib/queryClient";
import type { User } from "@/lib/types";

// The signed-in user, or null for guests.
export const fetchSession = async (): Promise<User | null> => {
    try {
        return (await api<{ user: User }>("/api/auth/me")).user;
    } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
    }
};

export function useSession() {
    const query = useQuery({ queryKey: sessionKey, queryFn: fetchSession, staleTime: 5 * 60 * 1000 });
    return { user: query.data ?? null, isLoading: query.isPending };
}

// Updates the cached session after login, sign-up, profile changes or logout.
export function useSetSession() {
    const queryClient = useQueryClient();
    return (user: User | null) => {
        queryClient.setQueryData(sessionKey, user);
        if (!user) queryClient.removeQueries({ queryKey: sharesKey });
    };
}

export function useLogout() {
    const setSession = useSetSession();
    const navigate = useNavigate();
    return useMutation({
        mutationFn: async () => {
            // Stop this browser's push notifications first (a shared computer
            // shouldn't keep getting this account's notifications).
            await disablePush().catch(() => {});
            await api("/api/auth/logout", { method: "POST" });
        },
        onSettled: () => {
            setSession(null);
            navigate("/");
            toast.success("Logged out");
        },
    });
}
