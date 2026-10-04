import { QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

export const sessionKey = ["session"] as const;
export const sharesKey = ["shares"] as const;
export const configKey = ["config"] as const;
export const devicesKey = ["devices"] as const;
export const notificationsKey = ["notifications"] as const;
export const notificationSettingsKey = ["notification-settings"] as const;

export const createQueryClient = () => {
    const client: QueryClient = new QueryClient({
        queryCache: new QueryCache({
            // A request found the session gone (logged out elsewhere, password
            // changed): reflect that everywhere, which sends protected pages
            // to the login screen.
            onError: (error) => {
                if (error instanceof ApiError && error.status === 401 && error.data.code === "auth_required") {
                    client.setQueryData(sessionKey, null);
                }
            },
        }),
        defaultOptions: {
            queries: {
                refetchOnWindowFocus: false,
                // Don't retry client errors (404, 401...); do retry network/server ones.
                retry: (failureCount, error) =>
                    failureCount < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
            },
        },
    });
    return client;
};
