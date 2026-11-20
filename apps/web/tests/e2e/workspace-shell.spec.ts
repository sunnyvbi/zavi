
import { expect, test } from "@playwright/test";

test.describe("/workspace shell (Phase 1)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("unauthed → /login redirect with ?next=/workspace", async ({
    page,
  }) => {
    await page.goto("/workspace");
    await page.waitForURL(/\/login/);
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/workspace");
  });

  test("marketing home unaffected by /workspace ship", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Zavi/i);
    const mainBg = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return null;
      return getComputedStyle(main).backgroundColor;
    });
    expect(mainBg).not.toBe("rgb(248, 250, 252)");
  });
});
