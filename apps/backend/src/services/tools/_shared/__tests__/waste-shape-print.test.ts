import { it, expect } from "vitest";
import { buildWaste, wasteBytes } from "../waste";

it("prints the real-shaped block", () => {
  const w = buildWaste(
    [
      { campaign_name: "Instagram post: 40% to Turo. 0% to us.", spend_usd: 608.44, conversions: 0, leads: 0 },
      { campaign_name: "Labor Day", spend_usd: 171.24, conversions: 0, leads: 0 },
      { campaign_name: "Weekend Coupon Sales", spend_usd: 48.97, conversions: 0, leads: 0 },
      { campaign_name: "Regular Rentals Leads", spend_usd: 200, conversions: 0, leads: 50 },
      { campaign_name: "New Sales Campaign", spend_usd: 1370.53, conversions: 341, leads: 0 },
    ],
    {
      labelFields: ["campaign_name"],
      spendField: "spend_usd",
      conversionFields: ["conversions", "leads"],
      outcomeLabel: "sales, signups or leads",
      window: "2026-08-19..2026-09-18",
      currency: "USD",
      entity: "campaigns",
      complete: true,
    },
  )!;
  // eslint-disable-next-line no-console
  console.log("\n" + JSON.stringify(w, null, 1) + `\nbytes: ${wasteBytes(w)}\n`);
  expect(w.lines.map((l) => l.label)).not.toContain("Regular Rentals Leads");
  expect(w.lines.map((l) => l.label)).not.toContain("New Sales Campaign");
});
