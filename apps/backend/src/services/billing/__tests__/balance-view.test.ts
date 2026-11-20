
import { describe, it, expect } from "vitest";
import { creditBalanceView, type BalanceRow } from "../balance-view";

const NOW = new Date("2026-09-30T12:00:00Z");
const BLOB = { free_daily_credits: 1000, tier_credits: { starter: 8000, growth: 48000, pro: 96000 } };

function freeRow(extra: Partial<BalanceRow> = {}): BalanceRow {
  return {
    period_start: "2026-09-30",
    period_end: "2026-10-01",
    included_allowance: 1000,
    included_used: 0,
    purchased_balance: 0,
    reserved: 0,
    daily_allowance: 0,
    daily_used: 0,
    daily_period_end: null,
    ...extra,
  };
}

describe("creditBalanceView", () => {
  it("a running task's hold lowers spendable; settling moves it to the real cost", () => {
    const held = creditBalanceView(null, freeRow({ reserved: 490 }), BLOB, NOW);
    expect(held.effective_available).toBe(510);
    const settled = creditBalanceView(null, freeRow({ included_used: 350 }), BLOB, NOW);
    expect(settled.effective_available).toBe(650);
  });

  it("a paid row is current until the billing moment, not UTC midnight", () => {
    const sub = {
      plan: "team" as const,
      status: "active",
      tier: "starter",
      current_period_end: "2026-10-30T18:00:00Z",
      comp_expires_at: null,
    };
    const row = freeRow({
      period_start: "2026-08-30",
      period_end: "2026-09-30",
      included_allowance: 8000,
      included_used: 5000,
    });
    const v = creditBalanceView(sub, row, BLOB, NOW);
    expect(v.used).toBe(5000);
    expect(v.period_end).toBe("2026-09-30");
  });

  it("a free tenant with no row sees the live daily grant", () => {
    const v = creditBalanceView(null, null, BLOB, NOW);
    expect(v.allowance).toBe(1000);
    expect(v.credits_total).toBe(1000);
    expect(v.period_end).toBe("2026-10-01");
  });

  it("an active comp reads as its tier's pool", () => {
    const v = creditBalanceView(
      { plan: "free", status: "active", tier: "growth", current_period_end: null, comp_expires_at: "2026-12-01T00:00:00Z" },
      null,
      BLOB,
      NOW,
    );
    expect(v.plan).toBe("team");
    expect(v.allowance).toBe(48000);
  });

  it("an active paid tier past its window falls back to its tier pool, not the legacy team 80,000", () => {
    const sub = {
      plan: "team" as const,
      status: "active",
      tier: "starter",
      current_period_end: "2026-10-30T18:00:00Z",
      comp_expires_at: null,
    };
    const stale = freeRow({ period_start: "2026-07-30", period_end: "2026-08-30", included_allowance: 8000 });
    expect(creditBalanceView(sub, stale, BLOB, NOW).allowance).toBe(8000);
    expect(creditBalanceView(sub, null, BLOB, NOW).allowance).toBe(8000);
  });
});
