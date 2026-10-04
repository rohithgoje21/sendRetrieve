import fs from "fs";
import os from "os";
import path from "path";
import { MongoClient } from "mongodb";
import { expect, type Browser, type Page } from "@playwright/test";

export const PASSWORD = "correct-horse-battery";

let counter = 0;
export const uniqueEmail = (prefix = "user") => `${prefix}-${Date.now()}-${process.pid}-${counter++}@example.com`;

export async function signUp(page: Page, { name = "E2E Tester", email = uniqueEmail() } = {}) {
    await page.goto("/signup");
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    // Password hashing is slow on purpose; with several browsers at once, more so.
    await expect(page).not.toHaveURL(/\/signup/, { timeout: 30_000 });
    return email;
}

export async function logIn(page: Page, email: string) {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

// Creates a share from the home page; returns its code (without the dash).
export async function sendShare(page: Page, { text, files = [], password, opens }: { text?: string; files?: string[]; password?: string; opens?: string } = {}) {
    await page.goto("/");
    if (text) await page.getByLabel(/^Message/).fill(text);
    if (files.length) await page.getByLabel("Choose files").setInputFiles(files);
    if (password) await page.getByLabel(/^Password/).fill(password);
    if (opens) await page.getByLabel("Can be opened").selectOption({ label: opens });
    await page.getByRole("button", { name: "Create share" }).click();
    await expect(page.getByRole("heading", { name: "Your share is ready" })).toBeVisible({ timeout: 30_000 });
    return (await page.getByTestId("share-code").innerText()).replace("-", "");
}

// Opens a share by code in a fresh browser (a recipient).
export async function openAsRecipient(browser: Browser, code: string, password?: string) {
    const page = await (await browser.newContext()).newPage();
    await page.goto("/open");
    await page.getByLabel("Share code").fill(code);
    await page.getByRole("button", { name: "Open share" }).click();
    if (password) {
        await page.getByLabel("Password", { exact: true }).fill(password);
        await page.getByRole("button", { name: "Open share" }).click();
        // Checking a password is slow on purpose, and shares the server's
        // bounded hashing queue with sign-ups from parallel tests.
        await expect(page.getByRole("button", { name: "Opening…" })).toHaveCount(0, { timeout: 30_000 });
    }
    return page;
}

// A file on disk with the given content, for upload fields.
export function tempFile(name: string, content: string | Buffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-e2e-"));
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
}

// Direct database access (e.g. to make an admin), via the URI the test
// server wrote at startup.
export async function setRole(email: string, role: "user" | "admin" | "superadmin") {
    const { mongoUri } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".state.json"), "utf8"));
    const client = await MongoClient.connect(mongoUri);
    try {
        await client.db().collection("users").updateOne({ email }, { $set: { role } });
    } finally {
        await client.close();
    }
}
