import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// The API runs on :8080 (npm run dev in the repo root starts both). Vite
// forwards /api to it, so the browser sees one origin and the session cookies
// work as in production. changeOrigin must stay off: the server's CSRF check
// compares the browser's Origin (localhost:5173) with the Host header, and
// changeOrigin would rewrite Host to localhost:8080. (Vite turns it on for
// the "/api": url shorthand, hence the object form.)
const API_URL = process.env.API_URL ?? "http://localhost:8080";
const apiProxy = { target: API_URL, changeOrigin: false };

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
        port: 5173,
        proxy: {
            "/api": apiProxy,
            "/healthz": apiProxy,
            // Live updates (Socket.IO), including the WebSocket upgrade.
            "/socket.io": { ...apiProxy, ws: true },
        },
    },
    test: {
        // Worker threads start much faster than the default child processes;
        // on a busy Windows machine (e.g. right after the server suite)
        // process start-up could exceed Vitest's fixed 60s start timeout.
        pool: "threads",
        environment: "jsdom",
        globals: true,
        setupFiles: "./src/test/setup.ts",
        css: false,
    },
});
