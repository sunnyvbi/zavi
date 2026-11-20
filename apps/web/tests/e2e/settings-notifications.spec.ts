import { expect, test } from "@playwright/test";

test("Settings → Notifications renders its recipient preference rows", async ({
  page,
}) => {
  await page.goto("/workspace?tab=settings&section=notifications");

  await expect(
    page.getByRole("heading", { name: "Notifications", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Who hears from your agents", level: 3 }),
  ).toBeVisible();
  await expect(page.getByText("The owner is always included.")).toBeVisible();

  const recipient = page.getByLabel("Email address");
  const add = page.getByRole("button", { name: "Add", exact: true });

  await expect(recipient).toBeVisible();
  await expect(recipient).toHaveValue("");
  await expect(add).toBeDisabled();

  await recipient.click();
  await recipient.pressSequentially("qa-nobody@example.com");
  await expect(add).toBeEnabled();

  await recipient.fill("");
  await expect(add).toBeDisabled();
});
