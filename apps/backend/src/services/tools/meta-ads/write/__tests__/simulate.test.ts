
import { describe, it, expect } from "vitest";
import {
  simulateBudgetWrite,
  simulateStatusWrite,
  simulateCreateWrite,
} from "../_simulate";
import type { Cap } from "../_cap-evaluator";

const fullCap: Cap = {
  enabled: true,
  max_daily_budget_usd: 100,
  max_pct_change_per_run: 0.5,
  max_daily_total_change_usd: 50,
};

describe("simulateBudgetWrite — within-cap increase", () => {
  it("computes before/after/delta/pct/aggregate and within=true", () => {
    const s = simulateBudgetWrite({
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 55,
      today_total_change_usd: 0,
      cap: fullCap,
    });
    expect(s.kind).toBe("budget");
    expect(s.before_daily_budget_usd).toBe(40);
    expect(s.after_daily_budget_usd).toBe(55);
    expect(s.delta_usd).toBe(15);
    expect(s.pct_change).toBe(0.38);
    expect(s.today_aggregate_after_usd).toBe(15);
    expect(s.within).toBe(true);
    expect(s.reason).toBeNull();
    expect(s.cap_state).toEqual({
      enabled: true,
      max_daily_budget_usd: 100,
      max_pct_change_per_run: 0.5,
      max_daily_total_change_usd: 50,
    });
  });
});

describe("simulateBudgetWrite — over-cap surfaces the reason", () => {
  it("reports within=false + over_absolute_ceiling when proposed exceeds ceiling", () => {
    const s = simulateBudgetWrite({
      current_daily_budget_usd: 80,
      proposed_daily_budget_usd: 150,
      today_total_change_usd: 0,
      cap: fullCap,
    });
    expect(s.within).toBe(false);
    expect(s.reason).toBe("over_absolute_ceiling");
    expect(s.delta_usd).toBe(70);
    expect(s.after_daily_budget_usd).toBe(150);
  });

  it("reports over_daily_aggregate when today's spend + delta exceeds the aggregate cap", () => {
    const s = simulateBudgetWrite({
      current_daily_budget_usd: 30,
      proposed_daily_budget_usd: 40,
      today_total_change_usd: 45,
      cap: fullCap,
    });
    expect(s.within).toBe(false);
    expect(s.reason).toBe("over_daily_aggregate");
    expect(s.today_aggregate_after_usd).toBe(55);
  });

  it("refuses with no_cap_configured when cap is null and reports null cap_state", () => {
    const s = simulateBudgetWrite({
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 41,
      today_total_change_usd: 0,
      cap: null,
    });
    expect(s.within).toBe(false);
    expect(s.reason).toBe("no_cap_configured");
    expect(s.cap_state).toBeNull();
  });
});

describe("simulateBudgetWrite — boundary + decrease cases", () => {
  it("exact-ceiling proposal is within (inclusive bound, mirrors evaluator)", () => {
    const s = simulateBudgetWrite({
      current_daily_budget_usd: 80,
      proposed_daily_budget_usd: 100,
      today_total_change_usd: 0,
      cap: fullCap,
    });
    expect(s.within).toBe(true);
    expect(s.reason).toBeNull();
  });

  it("a decrease yields a negative delta + negative pct", () => {
    const s = simulateBudgetWrite({
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 30,
      today_total_change_usd: 0,
      cap: fullCap,
    });
    expect(s.delta_usd).toBe(-10);
    expect(s.pct_change).toBe(-0.25);
    expect(s.today_aggregate_after_usd).toBe(0);
    expect(s.within).toBe(true);
  });

  it("pct_change is null when current is 0 (no baseline, create-style)", () => {
    const s = simulateBudgetWrite({
      current_daily_budget_usd: 0,
      proposed_daily_budget_usd: 25,
      today_total_change_usd: 0,
      cap: fullCap,
    });
    expect(s.pct_change).toBeNull();
  });
});

describe("simulateStatusWrite", () => {
  it("flags reopens_spend on a PAUSED → ACTIVE resume", () => {
    const s = simulateStatusWrite({
      object_id: "123",
      level: "adset",
      current_status: "PAUSED",
      target_status: "ACTIVE",
    });
    expect(s.kind).toBe("status");
    expect(s.before_status).toBe("PAUSED");
    expect(s.after_status).toBe("ACTIVE");
    expect(s.reopens_spend).toBe(true);
  });

  it("does NOT flag reopens_spend on an ACTIVE → PAUSED pause", () => {
    const s = simulateStatusWrite({
      object_id: "456",
      level: "campaign",
      current_status: "ACTIVE",
      target_status: "PAUSED",
    });
    expect(s.reopens_spend).toBe(false);
  });
});

describe("simulateCreateWrite", () => {
  it("always lands PAUSED and counts the full budget toward today's aggregate", () => {
    const s = simulateCreateWrite({
      campaign_id: "c1",
      name: "Bay Area intent",
      daily_budget_usd: 30,
      today_total_change_usd: 10,
      cap: fullCap,
    });
    expect(s.kind).toBe("create");
    expect(s.created_status).toBe("PAUSED");
    expect(s.daily_budget_usd).toBe(30);
    expect(s.today_aggregate_after_usd).toBe(40);
    expect(s.within).toBe(true);
  });

  it("surfaces over_absolute_ceiling for an over-cap create (no throw)", () => {
    const s = simulateCreateWrite({
      campaign_id: "c1",
      name: "too big",
      daily_budget_usd: 200,
      today_total_change_usd: 0,
      cap: fullCap,
    });
    expect(s.within).toBe(false);
    expect(s.reason).toBe("over_absolute_ceiling");
  });
});
