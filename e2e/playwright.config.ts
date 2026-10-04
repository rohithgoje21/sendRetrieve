import { defineConfig, devices } from "@playwright/test";

// End-to-end tests: real browsers against the real app (see server.js).
//
//   npm run build && npm run test:e2e
//
// Uses Playwright's Chromium (npx playwright install chromium). To use an
// installed browser instead: PW_CHANNEL=msedge (or chrome) npm run test:e2e.

const port = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
    testDir: "./tests",
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: true,
    workers: process.env.CI ? 2 : 4,
    retries: process.env.CI ? 1 : 0,
    forbidOnly: Boolean(process.env.CI),
    reporter: process.env.CI ? [["github"], ["html", { open: "never", outputFolder: "../playwright-report" }]] : [["list"]],
    outputDir: "../test-results",
    use: {
        ...devices["Desktop Chrome"],
        channel: process.env.PW_CHANNEL || undefined,
        baseURL: `http://localhost:${port}`,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    webServer: {
        command: "node server.js",
        url: `http://localhost:${port}/healthz`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: "ignore",
        stderr: "pipe",
    },
});
