import { describe, expect, it } from "vitest";
import { inflightOutcome } from "@/services/decisions/ad-hold-resolve";
import { forecastDailySpend } from "@/services/growth/spend-pace";
const now = new Date("2026-10-09T01:00:00Z");
describe("Reddit shared budget accounting", () => {
  it("commits only a confirmed raise and retains uncertainty", () => {
    const hold = { id: "hold", platform: "reddit", object_id: "group", op: "raise", updated_at: "2026-10-08T20:00:00Z" };
    const card = { exec_class: "reddit_ads.update_budget", body: { daily_budget_usd: 20, expected_current_daily_budget_usd: 10 } };
    const ledger = { object_id: "group", campaign_id: "campaign", level: "ad_group", budget_kind: "daily", budget_usd: 20, campaign_budget_usd: null, status: "ACTIVE", as_of: now.toISOString() };
    expect(inflightOutcome(hold, card, [ledger], now)).toBe("landed");
    expect(inflightOutcome(hold, card, [{ ...ledger, budget_usd: 10 }], now)).toBe("not_landed");
    expect(inflightOutcome(hold, card, [{ ...ledger, budget_kind: "campaign_level", budget_usd: null }], now)).toBeNull();
    expect(inflightOutcome(hold, card, [{ ...ledger, budget_usd: 15 }], now)).toBeNull();
    expect(inflightOutcome(hold, card, [{ ...ledger, budget_usd: 10.01 }], now)).toBeNull();
    expect(inflightOutcome(hold, { ...card, body: { daily_budget_usd: 20 } }, [{ ...ledger, budget_usd: 10 }], now)).toBeNull();
    expect(inflightOutcome(hold, card, [{ ...ledger, as_of: "2026-10-08T01:00:00Z" }], now)).toBeNull();
    expect(inflightOutcome({ ...hold, op: "resume" }, { exec_class: "reddit_ads.launch_campaign", body: {} }, [{ ...ledger, status: "CAMPAIGN_PAUSED" }], now)).toBeNull();
  });
  it("settles a resume hold only from the ad group the card itself turned on", () => {
    const hold = { id: "hold", platform: "reddit", object_id: "group", op: "resume", updated_at: "2026-10-08T20:00:00Z" };
    const ledger = { object_id: "group", campaign_id: "campaign", level: "ad_group", budget_kind: "daily", budget_usd: 20, campaign_budget_usd: null, status: "ACTIVE", as_of: now.toISOString() };
    const status = (level: string, object_id: string) => ({ exec_class: "reddit_ads.set_object_status", body: { level, object_id, status: "ACTIVE" } });
    expect(inflightOutcome(hold, status("ad_group", "group"), [ledger], now)).toBe("landed");
    expect(inflightOutcome(hold, status("ad", "ad_7"), [ledger], now)).toBeNull();
    expect(inflightOutcome(hold, status("campaign", "campaign"), [ledger], now)).toBeNull();
    expect(inflightOutcome(hold, status("ad_group", "group"), [{ ...ledger, status: "PAUSED" }], now)).toBeNull();
  });
  it("counts multiple account clocks without treating partial days as whole days", () => {
    const result = forecastDailySpend({ now, objects: [{ platform: "reddit", account_id: "west", object_id: "west_group", status: "ACTIVE", budget_kind: "daily", budget_usd: 10 }, { platform: "reddit", account_id: "east", object_id: "east_group", status: "ACTIVE", budget_kind: "daily", budget_usd: 20 }], spend: [{ platform: "reddit", object_id: "west_group", spend_date: "2026-10-08", amount_usd: 3 }, { platform: "reddit", object_id: "east_group", spend_date: "2026-10-09", amount_usd: 5 }], holds: [{ platform: "reddit", object_id: "west_group", created_at: now.toISOString() }, { platform: "reddit", object_id: "east_group", created_at: now.toISOString() }], today: { "reddit:west": "2026-10-08", "reddit:east": "2026-10-09" } });
    expect(result.actual_today_usd).toBe(8);
    expect(result.forecast_daily_usd).toBe(30);
  });
});
