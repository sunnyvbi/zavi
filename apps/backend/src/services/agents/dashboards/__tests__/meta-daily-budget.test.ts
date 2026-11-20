import { describe, expect, it } from "vitest";
import { buildMetaDailyBudget } from "../meta-daily-budget";
import type { MetaDailyRow } from "@/services/tools/meta-ads/daily_series";

const row = (date: string, campaign_id: string, spend_usd: number): MetaDailyRow =>
  ({ date, campaign_id, campaign_name: `C ${campaign_id}`, ad_set_id: null, ad_set_name: null, spend_usd } as MetaDailyRow);

const camp = (campaign_id: string, status: string, budget: number | null) => ({
  channel: "meta",
  campaign_id,
  campaign_name: `C ${campaign_id}\nsub`,
  status,
  active_daily_budget_usd: budget,
});

describe("buildMetaDailyBudget", () => {
  it("marks a failed per-day read, so an empty table is never shown as no spend", () => {
    const failed = buildMetaDailyBudget({ campaigns: [camp("a", "ACTIVE", 100)], daily: null, today: null });
    expect(failed.days).toEqual([]);
    expect(failed.history_unreadable).toBe(true);
    const read = buildMetaDailyBudget({ campaigns: [camp("a", "ACTIVE", 100)], daily: { rows: [], truncated: false }, today: null });
    expect(read.history_unreadable).toBe(false);
  });

  it("sums active budgets, splits each day by campaign, newest day first", () => {
    const out = buildMetaDailyBudget({
      campaigns: [camp("a", "ACTIVE", 100), camp("b", "ACTIVE", 80), camp("c", "PAUSED", 50)],
      daily: { rows: [row("2026-10-30", "a", 90), row("2026-10-30", "b", 55), row("2026-10-31", "a", 88.5), row("2026-10-31", "c", 10)], truncated: false },
      today: { date: "2026-11-01", spend_usd: 40, by_campaign: { a: 40 } },
    });
    expect(out.total_daily_budget_usd).toBe(180);
    expect(out.active_campaigns).toBe(2);
    expect(out.days.map((d) => d.date)).toEqual(["2026-10-31", "2026-10-30"]);
    expect(out.days[0]).toEqual({ date: "2026-10-31", spend_usd: 98.5, by_campaign: { a: 88.5, c: 10 } });
    expect(out.campaigns.map((c) => [c.campaign_id, c.daily_budget_usd, c.campaign_name])).toEqual([
      ["a", 100, "C a"],
      ["b", 80, "C b"],
      ["c", null, "C c"],
    ]);
  });

  it("does not claim a total when an active campaign's budget was not read", () => {
    const out = buildMetaDailyBudget({ campaigns: [camp("a", "ACTIVE", 100), camp("b", "ACTIVE", null)], daily: null, today: null });
    expect(out.total_daily_budget_usd).toBeNull();
    expect(out.known_daily_budget_usd).toBe(100);
    expect(out.known_campaigns).toBe(1);
    expect(out.days).toEqual([]);
  });

  it("keeps today's partial row out of the past days", () => {
    const out = buildMetaDailyBudget({
      campaigns: [camp("a", "ACTIVE", 100)],
      daily: { rows: [row("2026-10-31", "a", 90), row("2026-11-01", "a", 12)], truncated: true },
      today: { date: "2026-11-01", spend_usd: 12, by_campaign: { a: 12 } },
    });
    expect(out.days.map((d) => d.date)).toEqual(["2026-10-31"]);
    expect(out.truncated).toBe(true);
  });
});
