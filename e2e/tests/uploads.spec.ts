import crypto from "crypto";
import fs from "fs";
import { expect, test, type Page } from "@playwright/test";
import { openAsRecipient, tempFile } from "./helpers";

// Throttled upload bandwidth (Chromium's DevTools protocol), so there's time
// to pause and reload mid-upload.
async function throttle(page: Page, bytesPerSecond: number) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: bytesPerSecond });
}

const percent = async (page: Page) => Number((await page.getByTestId("upload-panel").getByRole("status").innerText()).match(/(\d+)%/)?.[1] ?? -1);

// 4 MB with 1 MB parts (see server.js): a resumable upload in 4 parts.
const bytes = crypto.randomBytes(4 * 1024 * 1024);
const file = tempFile("video.bin", bytes);

test.skip(({ browserName }) => browserName !== "chromium", "needs Chromium's network throttling");

test("a big upload can be paused, resumed after a reload, and arrives intact", async ({ page, browser }) => {
    page.on("dialog", (d) => d.accept()); // "leave the page?" when reloading mid-upload
    await page.goto("/");
    await page.getByLabel("Choose files").setInputFiles(file);
    await throttle(page, 512 * 1024);
    await page.getByRole("button", { name: "Create share" }).click();

    await expect.poll(() => percent(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(10);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByTestId("upload-panel").getByRole("status")).toContainText("Paused at");
    await page.getByRole("button", { name: "Resume" }).click();

    // Reload once at least two parts are stored.
    await expect.poll(() => percent(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(60);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Finish your upload" })).toBeVisible();
    await page.getByLabel("Choose the same files").setInputFiles(file);
    await expect(page.getByRole("heading", { name: "Your share is ready" })).toBeVisible({ timeout: 60_000 });
    const code = (await page.getByTestId("share-code").innerText()).replace("-", "");

    const recipient = await openAsRecipient(browser, code);
    const [download] = await Promise.all([recipient.waitForEvent("download"), recipient.getByRole("link", { name: /Download/ }).click()]);
    expect(fs.readFileSync(await download.path()).equals(bytes)).toBe(true);
});
