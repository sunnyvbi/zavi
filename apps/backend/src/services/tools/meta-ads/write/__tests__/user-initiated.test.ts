
import { describe, it, expect } from "vitest";
import {
  evaluateAgentUnsure,
  minMergeCap,
  AUTHORIZED_EFFECTIVE_CAP,
  MISPARSE_RATIO_LIMIT,
  MISPARSE_ABSOLUTE_LIMIT_USD,
} from "../_user-initiated";
import { evaluateBudgetCap } from "../_cap-evaluator";

describe("evaluateAgentUnsure — ambiguity gate", () => {
  it("ambiguous when match_confidence is ABSENT (default ⇒ gate)", () => {
    const r = evaluateAgentUnsure({
      current_daily_budget_usd: 50,
      proposed_daily_budget_usd: 100,
    });
    expect(r.unsure).toBe(true);
    expect(r.reason).toBe("ambiguous_match");
  });

  it("ambiguous when match_confidence === 'ambiguous'", () => {
    const r = evaluateAgentUnsure({
      match_confidence: "ambiguous",
      current_daily_budget_usd: 50,
      proposed_daily_budget_usd: 100,
    });
    expect(r.unsure).toBe(true);
    expect(r.reason).toBe("ambiguous_match");
  });
});

describe("evaluateAgentUnsure — misparse (fat-finger) gate, given match_confidence='exact'", () => {
  it("a normal DOUBLE (ratio 2) is NOT unsure", () => {
    const r = evaluateAgentUnsure({
      match_confidence: "exact",
      current_daily_budget_usd: 50,
      proposed_daily_budget_usd: 100,
    });
    expect(r.unsure).toBe(false);
  });

  it("ratio = 11 (> 10x) → unsure (misparse_ratio)", () => {
    const r = evaluateAgentUnsure({
      match_confidence: "exact",
      current_daily_budget_usd: 10,
      proposed_daily_budget_usd: 110,
    });
    expect(r.unsure).toBe(true);
    expect(r.reason).toBe("misparse_ratio");
  });

  it("ratio = exactly 10x is NOT unsure (strictly-greater boundary)", () => {
    const r = evaluateAgentUnsure({
      match_confidence: "exact",
      current_daily_budget_usd: 10,
      proposed_daily_budget_usd: 100,
    });
    expect(r.unsure).toBe(false);
  });

  it("proposed = $10,001 (> $10k) → unsure (misparse_absolute), even at a small ratio", () => {
    const r = evaluateAgentUnsure({
      match_confidence: "exact",
      current_daily_budget_usd: 9000,
      proposed_daily_budget_usd: 10_001,
    });
    expect(r.unsure).toBe(true);
    expect(r.reason).toBe("misparse_absolute");
  });

  it("proposed = $9,999 within ratio → NOT unsure", () => {
    const r = evaluateAgentUnsure({
      match_confidence: "exact",
      current_daily_budget_usd: 5000,
      proposed_daily_budget_usd: 9_999,
    });
    expect(r.unsure).toBe(false);
  });

  it("proposed = exactly $10,000 is NOT unsure (inclusive bound)", () => {
    const r = evaluateAgentUnsure({
      match_confidence: "exact",
      current_daily_budget_usd: 8000,
      proposed_daily_budget_usd: 10_000,
    });
    expect(r.unsure).toBe(false);
  });

  it("ratio gate is skipped when current is 0 (no ratio defined) — absolute still applies", () => {
    expect(
      evaluateAgentUnsure({
        match_confidence: "exact",
        current_daily_budget_usd: 0,
        proposed_daily_budget_usd: 500,
      }).unsure,
    ).toBe(false);
    expect(
      evaluateAgentUnsure({
        match_confidence: "exact",
        current_daily_budget_usd: 0,
        proposed_daily_budget_usd: 10_001,
      }).unsure,
    ).toBe(true);
  });

  it("constants are the documented thresholds", () => {
    expect(MISPARSE_RATIO_LIMIT).toBe(10);
    expect(MISPARSE_ABSOLUTE_LIMIT_USD).toBe(10_000);
    expect(AUTHORIZED_EFFECTIVE_CAP).toEqual({
      enabled: true,
      max_daily_budget_usd: 10_000,
      max_pct_change_per_run: 50,
    });
  });
});

describe("minMergeCap — stricter-per-field merge", () => {
  it("no tenant cap → authorized cap verbatim (+ null aggregate)", () => {
    expect(minMergeCap(AUTHORIZED_EFFECTIVE_CAP, null)).toEqual({
      enabled: true,
      max_daily_budget_usd: 10_000,
      max_pct_change_per_run: 50,
      max_daily_total_change_usd: null,
    });
  });

  it("stricter tenant absolute wins; authorized pct wins when tenant pct is looser", () => {
    const merged = minMergeCap(AUTHORIZED_EFFECTIVE_CAP, {
      enabled: true,
      max_daily_budget_usd: 50,
      max_pct_change_per_run: 99,
      max_daily_total_change_usd: 200,
    });
    expect(merged.max_daily_budget_usd).toBe(50);
    expect(merged.max_pct_change_per_run).toBe(50);
    expect(merged.max_daily_total_change_usd).toBe(200);
  });

  it("null tenant dimension = unbounded on that axis ⇒ authorized's bound wins", () => {
    const merged = minMergeCap(AUTHORIZED_EFFECTIVE_CAP, {
      enabled: true,
      max_daily_budget_usd: null,
      max_pct_change_per_run: null,
      max_daily_total_change_usd: null,
    });
    expect(merged.max_daily_budget_usd).toBe(10_000);
    expect(merged.max_pct_change_per_run).toBe(50);
    expect(merged.max_daily_total_change_usd).toBe(null);
  });
});

describe("authorized effective cap + evaluateBudgetCap (dispatch math)", () => {
  it("normal double on a NO-CAP tenant APPLIES (within)", () => {
    const cap = minMergeCap(AUTHORIZED_EFFECTIVE_CAP, null);
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 100,
      current_daily_budget_usd: 50,
      today_total_change_usd: 0,
      cap,
    });
    expect(r.within).toBe(true);
  });

  it("$50k / 100x on a NO-CAP tenant REFUSES (fat-finger trips the authorized bound)", () => {
    const cap = minMergeCap(AUTHORIZED_EFFECTIVE_CAP, null);
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 50_000,
      current_daily_budget_usd: 500,
      today_total_change_usd: 0,
      cap,
    });
    expect(r.within).toBe(false);
    expect(r.reason).toBe("over_absolute_ceiling");
  });

  it("a STRICTER real tenant cap ($50/day) refuses an $80 change (stricter wins)", () => {
    const cap = minMergeCap(AUTHORIZED_EFFECTIVE_CAP, {
      enabled: true,
      max_daily_budget_usd: 50,
      max_pct_change_per_run: null,
      max_daily_total_change_usd: null,
    });
    const r = evaluateBudgetCap({
      proposed_daily_budget_usd: 80,
      current_daily_budget_usd: 40,
      today_total_change_usd: 0,
      cap,
    });
    expect(r.within).toBe(false);
    expect(r.reason).toBe("over_absolute_ceiling");
  });
});
