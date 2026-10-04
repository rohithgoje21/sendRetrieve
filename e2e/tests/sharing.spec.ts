import fs from "fs";
import { expect, test } from "@playwright/test";
import { openAsRecipient, sendShare, tempFile } from "./helpers";

test("a guest shares a message; the recipient opens it once and it's gone", async ({ page, browser }) => {
    const code = await sendShare(page, { text: "The wifi password is hunter2", opens: "Once" });

    const recipient = await openAsRecipient(browser, code);
    await expect(recipient.getByText("The wifi password is hunter2")).toBeVisible();
    await expect(recipient.getByText("That was the last allowed view")).toBeVisible();

    const late = await openAsRecipient(browser, code);
    await expect(late.getByRole("alert")).toContainText(/not found/i);
});

test("a file arrives intact, behind a password", async ({ page, browser }) => {
    const content = "quarterly numbers\n".repeat(100);
    const code = await sendShare(page, { files: [tempFile("report.txt", content)], password: "open-sesame" });

    const recipient = await openAsRecipient(browser, code, "open-sesame");
    await expect(recipient.getByText("report.txt")).toBeVisible();
    const [download] = await Promise.all([recipient.waitForEvent("download"), recipient.getByRole("link", { name: /Download/ }).click()]);
    expect(download.suggestedFilename()).toBe("report.txt");
    expect(fs.readFileSync(await download.path(), "utf8")).toBe(content);
});

test("a wrong password is refused", async ({ page, browser }) => {
    const code = await sendShare(page, { text: "secret", password: "open-sesame" });
    const recipient = await openAsRecipient(browser, code, "not-it");
    await expect(recipient.getByText("Incorrect password")).toBeVisible();
});

test("programs are refused before anything is uploaded", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Choose files").setInputFiles(tempFile("setup.exe", "MZ fake program"));
    await page.getByRole("button", { name: "Create share" }).click();
    await expect(page.getByRole("alert")).toContainText('"setup.exe" can\'t be shared');
});

test("a share link opens the share directly", async ({ page, browser }) => {
    const code = await sendShare(page, { text: "via link" });
    const recipient = await (await browser.newContext()).newPage();
    await recipient.goto(`/s/${code}`);
    await recipient.getByRole("button", { name: "Open share" }).click();
    await expect(recipient.getByText("via link")).toBeVisible();
});
