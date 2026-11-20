import { expect, test } from "@playwright/test";

const DESTINATIONS = [
  "Home",
  "Growth Channels",
  "Analytics",
  "Messaging",
  "Build",
  "Growth Strategy",
  "Artifacts",
  "Connectors",
];

const DESKTOP_ONLY_DESTINATIONS = ["Board"];

const COMPACT_MAX_PX = 639;

test("left nav lists every workspace destination", async ({ page }) => {
  await page.goto("/workspace");

  const isCompact = (page.viewportSize()?.width ?? 0) <= COMPACT_MAX_PX;
  if (isCompact) {
    const openNav = page.getByRole("button", { name: "Open navigation" });
    await expect(openNav).toBeVisible();
    await openNav.click();
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  }

  const nav = page.getByRole("navigation", { name: "Destinations" });
  await expect(nav).toBeVisible();

  for (const label of DESTINATIONS) {
    await expect(
      nav.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  }

  for (const label of DESKTOP_ONLY_DESTINATIONS) {
    const row = nav.getByRole("button", { name: label, exact: true });
    if (isCompact) {
      await expect(row).toBeHidden();
    } else {
      await expect(row).toBeVisible();
    }
  }
});
