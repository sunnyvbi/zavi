import { describe, expect, it } from "vitest";
import { buildGoogleDailyBudget } from "../google-daily-budget";
import type { CampaignBudget } from "@/routes/agents/dashboards/google-ads";
import type { GoogleDailyRow } from "@/services/tools/google-ads/daily_series";

const row = (date: string, campaign_id: string, spend_usd: number): GoogleDailyRow => ({
  date,
  campaign_id,
  campaign_name: `C ${campaign_id}`,
  spend_usd,
  impressions: 0,
  clicks: 0,
  conversions: 0,
  conversions_value_usd: 0,
});
const budget = (campaign_id: string, status: string, daily_budget: number | null, budget_resource: string | null = `b/${campaign_id}`): CampaignBudget => ({
  campaign_id,
  status,
  budget_resource,
  daily_budget,
  limited_by_budget: false,
});

describe("buildGoogleDailyBudget", () => {
  it("marks a failed per-day read, so an empty table is never shown as no spend", () => {
    const failed = buildGoogleDailyBudget({ budgets: [budget("a", "ENABLED", 100)], names: new Map(), daily: null, today: null });
    expect(failed.days).toEqual([]);
    expect(failed.history_unreadable).toBe(true);
    expect(buildGoogleDailyBudget({ budgets: [budget("a", "ENABLED", 100)], names: new Map(), daily: [], today: null }).history_unreadable).toBe(false);
  });

  it("sums enabled budgets (a shared one once), splits each day by campaign, newest first", () => {
    const out = buildGoogleDailyBudget({
      budgets: [budget("a", "ENABLED", 100), budget("b", "ENABLED", 50, "b/shared"), budget("c", "ENABLED", 50, "b/shared"), budget("d", "PAUSED", 30)],
      names: new Map([["a", "Brand"]]),
      daily: [row("2026-10-30", "a", 90), row("2026-10-30", "b", 20), row("2026-10-31", "a", 99.5), row("2026-10-31", "d", 5)],
      today: { date: "2026-11-01", spend_usd: 40, by_campaign: { a: 40 } },
    });
    expect(out.total_daily_budget_usd).toBe(150);
    expect(out.active_campaigns).toBe(3);
    expect(out.days.map((d) => d.date)).toEqual(["2026-10-31", "2026-10-30"]);
    expect(out.days[0]).toEqual({ date: "2026-10-31", spend_usd: 104.5, by_campaign: { a: 99.5, d: 5 } });
    expect(out.campaigns.map((c) => [c.campaign_id, c.campaign_name, c.daily_budget_usd, c.shared])).toEqual([
      ["a", "Brand", 100, false],
      ["b", "C b", 50, true],
      ["c", "c", 50, true],
      ["d", "C d", null, false],
    ]);
  });

  it("claims no total when an enabled campaign's budget was not read", () => {
    const out = buildGoogleDailyBudget({ budgets: [budget("a", "ENABLED", 100), budget("b", "ENABLED", null)], names: new Map(), daily: [], today: null });
    expect(out.total_daily_budget_usd).toBeNull();
    expect(out.known_daily_budget_usd).toBe(100);
    expect(out.known_campaigns).toBe(1);
  });

  it("keeps today's rows out of the past days", () => {
    const out = buildGoogleDailyBudget({
      budgets: [budget("a", "ENABLED", 100)],
      names: new Map(),
      daily: [row("2026-10-31", "a", 90), row("2026-11-01", "a", 12)],
      today: { date: "2026-11-01", spend_usd: 12, by_campaign: { a: 12 } },
    });
    expect(out.days.map((d) => d.date)).toEqual(["2026-10-31"]);
  });
});
