import { api, ApiError } from "./api";

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const expired = () => json(401, { error: "Your session has expired", code: "token_expired" });

describe("api()", () => {
    test("returns the JSON body", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => json(200, { ok: true })));
        await expect(api("/api/thing")).resolves.toEqual({ ok: true });
    });

    test("sends JSON bodies", async () => {
        const fetchMock = vi.fn(async () => json(200, {}));
        vi.stubGlobal("fetch", fetchMock);
        await api("/api/thing", { method: "POST", body: { a: 1 } });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/thing",
            expect.objectContaining({ method: "POST", body: '{"a":1}', headers: { "Content-Type": "application/json" } })
        );
    });

    test("errors carry the status and the server's body", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => json(404, { error: "Share not found", field: "code" })));
        const error = await api("/api/thing").catch((e) => e);
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({ status: 404, message: "Share not found", data: { field: "code" } });
    });

    test("network failures become an ApiError with status 0", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
        await expect(api("/api/thing")).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/network/i) });
    });

    test("an expired session is refreshed once and the request retried", async () => {
        let refreshed = false;
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (input === "/api/auth/refresh") {
                refreshed = true;
                return json(200, {});
            }
            return refreshed ? json(200, { ok: true }) : expired();
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(api("/api/thing")).resolves.toEqual({ ok: true });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/thing", "/api/auth/refresh", "/api/thing"]);
    });

    test("requests that expire at the same time share one refresh", async () => {
        let refreshed = false;
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (input === "/api/auth/refresh") {
                await new Promise((resolve) => setTimeout(resolve, 10));
                refreshed = true;
                return json(200, {});
            }
            return refreshed ? json(200, { ok: true }) : expired();
        });
        vi.stubGlobal("fetch", fetchMock);

        await Promise.all([api("/api/a"), api("/api/b"), api("/api/c")]);
        expect(fetchMock.mock.calls.filter(([url]) => url === "/api/auth/refresh")).toHaveLength(1);
    });

    test("doesn't loop if the refresh fails", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
            input === "/api/auth/refresh" ? json(401, { code: "auth_required" }) : expired()
        );
        vi.stubGlobal("fetch", fetchMock);

        await expect(api("/api/thing")).rejects.toMatchObject({ status: 401 });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
});
