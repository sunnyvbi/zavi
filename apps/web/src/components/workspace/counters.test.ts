import { describe, it, expect } from "vitest";
import { num, normalizeCounters, EMPTY_COUNTERS } from "./counters";

describe("num — strict numeric coercion", () => {
  it("passes through finite numbers, including negatives (credits/adjustments)", () => {
    expect(num(5)).toBe(5);
    expect(num(-2.5)).toBe(-2.5);
    expect(num(0)).toBe(0);
  });
  it("rejects non-numbers / non-finite to the default (NO string coercion)", () => {
    expect(num("5.0")).toBe(0);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num(NaN)).toBe(0);
    expect(num(Infinity)).toBe(0);
    expect(num({})).toBe(0);
    expect(num("x", 7)).toBe(7);
  });
});

describe("normalizeCounters", () => {
  const prev = { ...EMPTY_COUNTERS, drift_pct: 1, cost_today_usd: 2, active_runs: 3, approvals_pending: 4 };

  it("passes a fully-valid payload through unchanged", () => {
    const raw = { drift_pct: 10, cost_today_usd: 5.5, active_runs: 2, approvals_pending: 1 };
    expect(normalizeCounters(raw)).toEqual({
      ...raw,
      credits_remaining: null,
      credits_enforced: false,
      included_allowance: null,
      credits_total: null,
    });
  });

  it("falls back per-field to prev on missing/non-numeric fields (no $0.00 flash)", () => {
    expect(normalizeCounters({ active_runs: 9 }, prev)).toEqual({
      drift_pct: 1,
      cost_today_usd: 2,
      active_runs: 9,
      approvals_pending: 4,
      credits_remaining: prev.credits_remaining,
      credits_enforced: prev.credits_enforced,
      included_allowance: prev.included_allowance,
      credits_total: prev.credits_total,
    });
    expect(normalizeCounters({ cost_today_usd: "x" }, prev).cost_today_usd).toBe(2);
  });

  it("preserves credit fields: number/null passthrough, enforced bool", () => {
    expect(normalizeCounters({ credits_remaining: 38500, credits_enforced: true }, prev).credits_remaining).toBe(38500);
    expect(normalizeCounters({ credits_remaining: null }, prev).credits_remaining).toBeNull();
    expect(normalizeCounters({ credits_enforced: true }, prev).credits_enforced).toBe(true);
    expect(normalizeCounters({ credits_enforced: "yes" }, prev).credits_enforced).toBe(false);
  });

  it("threads included_allowance: number/null passthrough, else prev (same shape as credits_remaining)", () => {
    expect(normalizeCounters({ included_allowance: 80000 }, prev).included_allowance).toBe(80000);
    expect(normalizeCounters({ included_allowance: null }, prev).included_allowance).toBeNull();
    const withPrev = { ...prev, included_allowance: 20000 };
    expect(normalizeCounters({ active_runs: 1 }, withPrev).included_allowance).toBe(20000);
    expect(normalizeCounters({ included_allowance: "x" }, withPrev).included_allowance).toBe(20000);
  });

  it("keeps prev (last-good) when the whole payload is not an object", () => {
    expect(normalizeCounters(null, prev)).toBe(prev);
    expect(normalizeCounters("boom", prev)).toBe(prev);
    expect(normalizeCounters(undefined, prev)).toBe(prev);
  });

  it("defaults to EMPTY_COUNTERS when no prev given and payload is empty", () => {
    expect(normalizeCounters({})).toEqual(EMPTY_COUNTERS);
  });
});
