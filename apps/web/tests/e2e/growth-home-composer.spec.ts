import { expect, test } from "@playwright/test";

test("growth home composer gates Send on having something to send", async ({
  page,
}) => {
  await page.goto("/workspace");

  const composer = page.getByRole("textbox", {
    name: "Send a message to Zavi",
  });
  const send = page.getByRole("button", { name: "Send message" });

  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(send).toBeDisabled();

  await composer.click();
  await composer.pressSequentially("draft only, never sent");
  await expect(send).toBeEnabled();

  await composer.fill("");
  await expect(send).toBeDisabled();
});
