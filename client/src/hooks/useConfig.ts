import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { configKey } from "@/lib/queryClient";
import type { AppConfig } from "@/lib/types";

// Limits and options (file sizes, expiry choices...) come from the server so
// they're defined in one place.
export function useConfig() {
    return useQuery({ queryKey: configKey, queryFn: () => api<AppConfig>("/api/config"), staleTime: Infinity });
}
