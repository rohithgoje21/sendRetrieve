import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { sendShare, signUp } from "./helpers";

// Automated accessibility checks (axe-core, WCAG 2.1 A and AA rules) on the
// main pages, in both themes. Fails on serious and critical issues.
const violations = async (page: Page) => {
    await expect(page.getByRole("heading").first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    return results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")})`);
};

const PUBLIC = ["/", "/open", "/login", "/signup", "/forgot-password"];
const SIGNED_IN = ["/shares", "/analytics", "/account"];

for (const theme of ["light", "dark"] as const) {
    test.describe(`${theme} theme`, () => {
        test.use({ colorScheme: theme });

        for (const path of PUBLIC) {
            test(`${path} (public)`, async ({ page }) => {
                await page.goto(path);
                expect(await violations(page)).toEqual([]);
            });
        }

        for (const path of SIGNED_IN) {
            test(`${path} (signed in)`, async ({ page }) => {
                await signUp(page);
                await sendShare(page, { text: "something to list" });
                await page.goto(path);
                expect(await violations(page)).toEqual([]);
            });
        }

        test("a share just created (signed in)", async ({ page }) => {
            await signUp(page);
            await sendShare(page, { text: "hello" });
            expect(await violations(page)).toEqual([]);
        });
    });
}
