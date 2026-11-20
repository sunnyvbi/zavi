import { expect, test } from "@playwright/test";

test.describe("/workspace (signed in)", () => {
  test("renders the shell instead of bouncing to /login", async ({ page }) => {
    await page.goto("/workspace");

    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page).toHaveTitle(/Workspace/i);
    await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
  });

  test("a deep-linked tab keeps the signed-in session", async ({ page }) => {
    await page.goto("/workspace?tab=artifacts");

    await expect(page).toHaveURL(/tab=artifacts/);
    expect(new URL(page.url()).pathname).toBe("/workspace");
  });
});
