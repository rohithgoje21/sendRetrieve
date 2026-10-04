import { expect, test } from "@playwright/test";
import { logIn, openAsRecipient, sendShare, setRole, signUp, tempFile } from "./helpers";

test("my shares: search, view, delete", async ({ page }) => {
    await signUp(page);
    const report = await sendShare(page, { files: [tempFile("Quarterly Report.txt", "numbers")] });
    await sendShare(page, { text: "Meeting notes" });

    await page.goto("/shares");
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.getByRole("textbox", { name: "Search shares" }).fill("quarterly");
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page).toHaveURL(/q=quarterly/);

    const card = page.getByRole("article", { name: `Share ${report.slice(0, 4)}-${report.slice(4)}` });
    await card.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete share" }).click();
    await expect(page.getByText(/No shares match/)).toBeVisible();
    await page.getByRole("button", { name: /Deleted/ }).click();
    await expect(page.getByRole("article")).toHaveCount(1);
});

test("devices: log another device out, and get told about new logins", async ({ page, browser }) => {
    const email = await signUp(page);
    const phone = await (await browser.newContext({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" })).newPage();
    await logIn(phone, email);

    // The login from a new device shows up in the bell, live.
    await expect(page.getByRole("button", { name: "Notifications, 1 unread" })).toBeVisible();
    await page.getByRole("button", { name: "Notifications, 1 unread" }).click();
    await expect(page.getByRole("dialog", { name: "Notifications" })).toContainText("New login from Safari on iOS");
    await page.keyboard.press("Escape");

    await page.goto("/account");
    await page.getByRole("button", { name: "Log out Safari on iOS" }).click();
    await expect(page.getByText("Logged out Safari on iOS")).toBeVisible();
    await phone.goto("/shares");
    await expect(phone).toHaveURL(/\/login/);
});

test("analytics count what recipients do", async ({ page, browser }) => {
    await signUp(page);
    const code = await sendShare(page, { files: [tempFile("notes.txt", "hello")] });
    const recipient = await openAsRecipient(browser, code);
    await Promise.all([recipient.waitForEvent("download"), recipient.getByRole("link", { name: /Download/ }).click()]);

    await page.goto("/analytics?days=7");
    const views = page.locator("div", { has: page.getByText("Views", { exact: true }) }).filter({ hasText: /^Views/ }).first();
    await expect(views).toContainText("1");
    await expect(page.getByRole("table").last()).toContainText("notes.txt");
});

test("the admin area is for admins; superadmins see background jobs", async ({ page }) => {
    const email = await signUp(page);
    await page.goto("/admin");
    await expect(page.getByText("You don't have access to this page")).toBeVisible();

    await setRole(email, "superadmin");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Site analytics" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Background jobs" })).toBeVisible();
    await expect(page.getByText("sr.notifications")).toBeVisible();
});
