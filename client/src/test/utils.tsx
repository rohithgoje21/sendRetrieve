import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/components/ThemeProvider";
import { createQueryClient } from "@/lib/queryClient";
import { routes } from "@/routes";
import type { AppConfig, User } from "@/lib/types";

// Renders the real app (all routes, providers) at `path`.
export function renderApp(path = "/") {
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    const queryClient = createQueryClient();
    const view = render(
        <ThemeProvider>
            <QueryClientProvider client={queryClient}>
                <RouterProvider router={router} />
            </QueryClientProvider>
        </ThemeProvider>
    );
    return { ...view, router, queryClient };
}

interface MockRequest {
    method: string;
    path: string;
    body: unknown;
}
type MockResponse = [status: number, body?: unknown];
type MockRoute = MockResponse | ((request: MockRequest) => MockResponse);

// Replaces fetch with canned API responses, keyed "METHOD /path" (no query
// string). Returns the requests made, for assertions.
export function mockApi(routes: Record<string, MockRoute>) {
    const calls: MockRequest[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        const request = { method, path: url.pathname + url.search, body };
        calls.push(request);

        const route = routes[`${method} ${url.pathname}`];
        const [status, json] = !route
            ? [500, { error: `No mock for ${method} ${url.pathname}` }]
            : typeof route === "function"
              ? route(request)
              : route;
        return new Response(status === 204 ? null : JSON.stringify(json ?? {}), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls, fetchMock };
}

export const guestSession: MockResponse = [401, { error: "Please log in", code: "auth_required" }];

export const testUser: User = { id: "u1", email: "ada@example.com", name: "Ada Lovelace", createdAt: "2026-01-01T00:00:00.000Z" };

export const testConfig: AppConfig = {
    maxFiles: 3,
    maxFileSizeBytes: 1024,
    maxTextLength: 100_000,
    expiryOptions: [
        { value: "1h", label: "1 hour" },
        { value: "24h", label: "24 hours" },
    ],
    defaultExpiry: "24h",
    viewLimitOptions: [1, 5],
    downloadWindowSeconds: 600,
    sharePassword: { min: 4, max: 72 },
    accountPassword: { min: 8, max: 72 },
};

export const inHours = (hours: number) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
