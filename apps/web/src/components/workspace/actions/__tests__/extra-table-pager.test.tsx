// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ExtraTable } from "../ExtraTable";
import { linkedinAdsCampaignTable } from "../../agent/linkedinAdsTables";

afterEach(cleanup);

const zero = { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
const campaign = (i: number) => ({
  id: `c${i}`,
  currency: "USD",
  name: `Campaign ${i}`,
  status: i <= 4 ? "ACTIVE" : "PAUSED",
  spend: 0,
  clicks: 0,
  conversions: 0,
  cpa: null,
  url: "https://www.linkedin.com/campaignmanager/accounts/1/campaigns",
});
const payload = (n: number) => ({
  platform: "linkedin_ads",
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-09-02", to: "2026-10-01" },
  prev_period: { from: "2026-08-03", to: "2026-09-01" },
  account: { name: "Main", account_count: 1, campaign_count: n, currency: "USD" },
  totals: zero,
  prev_totals: zero,
  campaigns: Array.from({ length: n }, (_, i) => campaign(i + 1)),
});

const names = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .map((r) => r.textContent ?? "")
    .filter((t) => t.startsWith("Campaign "))
    .map((t) => t.match(/^Campaign \d+/)?.[0]);

it("shows sixteen LinkedIn campaigns ten at a time, with totals over all sixteen", () => {
  const [table] = linkedinAdsCampaignTable(payload(16));
  render(<ExtraTable data={table} />);

  expect(names()).toEqual(Array.from({ length: 10 }, (_, i) => `Campaign ${i + 1}`));
  expect(screen.getByTestId("extra-table-pager-range").textContent).toBe("1–10 of 16");
  expect(screen.getByTestId("totals-row").textContent).toContain("4 active of 16");
  const pager = screen.getByRole("navigation", { name: "Campaigns pages" });
  expect(within(pager).getByRole("button", { name: /Previous/ })).toHaveProperty("disabled", true);

  fireEvent.click(within(pager).getByRole("button", { name: /Next/ }));
  expect(names()).toEqual(Array.from({ length: 6 }, (_, i) => `Campaign ${i + 11}`));
  expect(screen.getByTestId("extra-table-pager-range").textContent).toBe("11–16 of 16");
  expect(within(pager).getByRole("button", { name: /Next/ })).toHaveProperty("disabled", true);
  expect(screen.getByTestId("totals-row").textContent).toContain("4 active of 16");

  fireEvent.click(within(pager).getByRole("button", { name: /Previous/ }));
  expect(names()?.[0]).toBe("Campaign 1");
});

it("draws no pager when every campaign fits on one page", () => {
  const [table] = linkedinAdsCampaignTable(payload(10));
  render(<ExtraTable data={table} />);
  expect(names()).toHaveLength(10);
  expect(screen.queryByTestId("extra-table-pager")).toBeNull();
});

it("falls back to the last page that still exists when campaigns disappear under it", () => {
  const { rerender } = render(<ExtraTable data={linkedinAdsCampaignTable(payload(25))[0]} />);
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect(screen.getByTestId("extra-table-pager-range").textContent).toBe("21–25 of 25");

  rerender(<ExtraTable data={linkedinAdsCampaignTable(payload(14))[0]} />);
  expect(names()).toEqual(["Campaign 11", "Campaign 12", "Campaign 13", "Campaign 14"]);
  expect(screen.getByTestId("extra-table-pager-range").textContent).toBe("11–14 of 14");

  rerender(<ExtraTable data={linkedinAdsCampaignTable(payload(3))[0]} />);
  expect(names()).toEqual(["Campaign 1", "Campaign 2", "Campaign 3"]);
  expect(screen.queryByTestId("extra-table-pager")).toBeNull();
});
