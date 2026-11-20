import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import { dailyBudgetTotal } from "./x-ads";

describe("X Ads daily budget total", () => {
  it("claims no total when an active campaign has only a total budget", () => {
    const out = dailyBudgetTotal([{ status: "ACTIVE", daily_budget: 50 }, { status: "ACTIVE", daily_budget: null }, { status: "PAUSED", daily_budget: 30 }], "USD");
    expect(out).toEqual({ total_daily_budget_usd: null, active_campaigns: 2, known_daily_budget_usd: 50, known_campaigns: 1 });
  });

  it("adds every active daily budget when all are known", () => {
    const out = dailyBudgetTotal([{ status: "ACTIVE", daily_budget: 50 }, { status: "ACTIVE", daily_budget: 20.5 }], "USD");
    expect(out).toEqual({ total_daily_budget_usd: 70.5, active_campaigns: 2, known_daily_budget_usd: 70.5, known_campaigns: 2 });
  });

  it("claims nothing without one account currency", () => {
    const out = dailyBudgetTotal([{ status: "ACTIVE", daily_budget: 50 }], null);
    expect(out).toEqual({ total_daily_budget_usd: null, active_campaigns: 1, known_daily_budget_usd: null, known_campaigns: 0 });
  });
});
