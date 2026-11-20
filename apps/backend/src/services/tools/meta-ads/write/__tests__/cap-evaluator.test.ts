
import { describe, it, expect } from "vitest";
import { evaluateBudgetCap, type Cap } from "../_cap-evaluator";

const fullCap: Cap = {
  enabled: true,
  max_daily_budget_usd: 100,
  max_pct_change_per_run: 0.25,
  max_daily_total_change_usd: 50,
};

describe("evaluateBudgetCap — gating cases", () => {
  it("refuses when cap row is missing (safe default)", () => {
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 30,
      current_daily_budget_usd: 25,
      today_total_change_usd: 0,
      cap: null,
    });
    expect(r.within).toBe(false);
    expect(r.reason).toBe("no_cap_configured");
  });

  it("refuses when cap row exists but is disabled", () => {
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 30,
      current_daily_budget_usd: 25,
      today_total_change_usd: 0,
      cap: { ...fullCap, enabled: false },
    });
    expect(r.within).toBe(false);
    expect(r.reason).toBe("cap_disabled");
  });
});

describe("evaluateBudgetCap — absolute ceiling", () => {
  it("refuses when proposed exceeds max_daily_budget_usd", () => {
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 101,
      current_daily_budget_usd: 80,
      today_total_change_usd: 0,
      cap: fullCap,
    });
    expect(r.within).toBe(false);
    expect(r.reason).toBe("over_absolute_ceiling");
  });

  it("allows proposed exactly at max_daily_budget_usd", () => {
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 100,
      current_daily_budget_usd: 80,
      today_total_change_usd: 0,
      cap: fullCap,
    });
    expect(r.within).toBe(true);
  });

  it("skips the absolute check when max_daily_budget_usd is null", () => {
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 9999,
      current_daily_budget_usd: 100,
      today_total_change_usd: 0,
      cap: { ...fullCap, max_daily_budget_usd: null, max_pct_change_per_run: null, max_daily_total_change_usd: null },
    });
    expect(r.within).toBe(true);
  });
});

describe("evaluateBudgetCap — percent change per run", () => {
  it("refuses when the absolute-pct change exceeds the cap", () => {
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 30,
      current_daily_budget_usd: 20,
      today_total_change_usd: 0,
      cap: fullCap,
    });
    expect(r.within).toBe(false);
    expect(r.reason).toBe("over_pct_change");
  });

  it("a big DOWN move is within: a cut never counts against the per-change percent (budget brake, 2026-09-27)", () => {
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 5,
      current_daily_budget_usd: 20,
      today_total_change_usd: 0,
      cap: fullCap,
    });
    expect(r.within).toBe(true);
  });

  it("a cut is within even when the day's change total is already spent, or could not be read", () => {
    const cap = { ...fullCap, max_daily_total_change_usd: 100 };
    expect(
      evaluateBudgetCap({ proposed_daily_budget_usd: 10, current_daily_budget_usd: 500, today_total_change_usd: 100, cap }).within,
    ).toBe(true);
    expect(
      evaluateBudgetCap({ proposed_daily_budget_usd: 10, current_daily_budget_usd: 500, today_total_change_usd: Number.MAX_SAFE_INTEGER, cap }).within,
    ).toBe(true);
    expect(
      evaluateBudgetCap({ proposed_daily_budget_usd: 11, current_daily_budget_usd: 10, today_total_change_usd: 100, cap }),
    ).toEqual({ within: false, reason: "over_daily_aggregate" });
  });

  it("a cut on an ad set already above the absolute ceiling is within; a raise there is still refused", () => {
    const cap = { ...fullCap, max_daily_budget_usd: 100 };
    expect(evaluateBudgetCap({ proposed_daily_budget_usd: 300, current_daily_budget_usd: 500, today_total_change_usd: 0, cap }).within).toBe(true);
    expect(evaluateBudgetCap({ proposed_daily_budget_usd: 501, current_daily_budget_usd: 500, today_total_change_usd: 0, cap })).toEqual({
      within: false,
      reason: "over_absolute_ceiling",
    });
  });

  it("a cut still needs a cap row that is on (no cap and a disabled cap refuse as before)", () => {
    expect(evaluateBudgetCap({ proposed_daily_budget_usd: 5, current_daily_budget_usd: 20, today_total_change_usd: 0, cap: null }).reason).toBe(
      "no_cap_configured",
    );
    expect(
      evaluateBudgetCap({ proposed_daily_budget_usd: 5, current_daily_budget_usd: 20, today_total_change_usd: 0, cap: { ...fullCap, enabled: false } })
        .reason,
    ).toBe("cap_disabled");
  });

  it("allows a change at exactly the pct cap", () => {
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 25,
      current_daily_budget_usd: 20,
      today_total_change_usd: 0,
      cap: fullCap,
    });
    expect(r.within).toBe(true);
  });

  it("skips the pct check when current_daily_budget_usd is 0 (create-style)", () => {
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 30,
      current_daily_budget_usd: 0,
      today_total_change_usd: 0,
      cap: fullCap,
    });
    expect(r.within).toBe(true);
  });
});

describe("evaluateBudgetCap — daily aggregate", () => {
  it("refuses when today_total + this_change exceeds the daily aggregate cap", () => {
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 30,
      current_daily_budget_usd: 20,
      today_total_change_usd: 45,
      cap: { ...fullCap, max_pct_change_per_run: 1.0 },
    });
    expect(r.within).toBe(false);
    expect(r.reason).toBe("over_daily_aggregate");
  });

  it("allows the change when total stays at the cap exactly", () => {
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 30,
      current_daily_budget_usd: 20,
      today_total_change_usd: 40,
      cap: { ...fullCap, max_pct_change_per_run: 1.0 },
    });
    expect(r.within).toBe(true);
  });
});
