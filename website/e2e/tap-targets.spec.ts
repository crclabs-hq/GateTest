import { test, expect } from "@playwright/test";

// GT-07 (outside reviewer, unauthenticated crawl of gatetest.io at 390x844,
// 2026-09-26): nav and footer links measured as low as 19px tall on phones,
// well under the WCAG 2.5.8 24px minimum. tests/tap-targets.test.js proves
// the fix at the source (every interactive element in the shared chrome
// carries an explicit min-h-*/min-w-* class); this spec proves it renders —
// a real 390px viewport, a real layout engine, boundingClientRect on the
// actual link boxes.
test.describe("GT-07 tap targets @ 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("mobile drawer nav links are at least 24px tall", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open menu" }).click();
    const nav = page.getByRole("navigation", { name: "Primary (mobile)" });
    const links = await nav.locator("a").all();
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const box = await link.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(24);
    }
  });

  test("footer links are at least 24px tall", async ({ page }) => {
    await page.goto("/");
    const footer = page.locator("footer");
    await footer.scrollIntoViewIfNeeded();
    const links = await footer.locator("a").all();
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const box = await link.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(24);
    }
  });
});
