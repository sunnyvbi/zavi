import { expect, test, type Page } from "@playwright/test";

const SETTINGS_ROUTE = "**/api/channels/reddit_organic/settings";
const SUGGEST_ROUTE = "**/api/reddit/workspace/suggest";

const KEYWORDS = [
  "car rental platform host protection",
  "peer to peer car rental insurance",
  "turo host damage claim denied",
];

const fixture = {
  fields: {
    keywords: KEYWORDS.map((item, i) => ({
      id: `kw-${i}`,
      item,
      item_type: "industry",
      status: "suggested",
      position: i,
    })),
    competitors: [],
  },
};

async function openKeywordCard(page: Page) {
  await page.route(SETTINGS_ROUTE, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) })
      : route.fallback(),
  );
  await page.route(SUGGEST_ROUTE, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ keywords_added: KEYWORDS.length }) }),
  );

  await page.goto("/workspace?tab=channels");

  const channels = page.locator("button, a[href], [role=button]");
  const labels = await channels.evaluateAll((els) =>
    els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()),
  );
  const reddit = labels.findIndex((t) => /^Reddit(\s|$)/.test(t) && !/^Reddit Ads/.test(t));
  expect(reddit, "Reddit organic is not in the channel list").toBeGreaterThan(-1);
  await channels.nth(reddit).click();

  await page.getByRole("tab", { name: "Settings" }).click();

  const card = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Keywords", level: 4 }) })
    .last();

  await expect(card.getByRole("listitem")).toHaveCount(0);
  await card.getByRole("button", { name: "Suggest" }).click();
  await expect(card.getByRole("listitem")).toHaveCount(KEYWORDS.length);
  return card;
}

test.describe("a keyword row at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("prints the keyword itself, and does not clip its own controls", async ({ page }) => {
    const card = await openKeywordCard(page);

    for (const keyword of KEYWORDS) {
      await expect(card.getByText(keyword, { exact: true })).toBeVisible();
    }

    const measured = await card.locator("li").evaluateAll((rows) =>
      rows.map((row) => {
        const label = row.querySelector("span") as HTMLElement;
        const { width } = label.getBoundingClientRect();
        return {
          text: label.textContent ?? "",
          labelWidth: Math.round(width),
          clipped: row.scrollWidth - row.clientWidth,
        };
      }),
    );

    for (const row of measured) {
      expect(row.labelWidth, `"${row.text}" was squeezed to ${row.labelWidth}px`).toBeGreaterThanOrEqual(
        96,
      );
      expect(row.clipped, `"${row.text}" overflows its card by ${row.clipped}px`).toBeLessThanOrEqual(
        0,
      );
    }
  });
});
