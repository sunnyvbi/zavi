
import { describe, it, expect } from "vitest";
import {
  evaluateLearningPhaseStep,
  STEP_PCT_CEILING,
  STEP_DOLLAR_FLOOR_USD,
} from "../_step-guard";

describe("evaluateLearningPhaseStep — silent (forceApproval:false) cases", () => {
  it("non-delivering ad set: never forces, even on a 5x jump", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 100,
      proposed_daily_budget_usd: 500,
      delivering: false,
    });
    expect(r.forceApproval).toBe(false);
  });

  it("delivering UNKNOWN (absent): defaults to silent (we never invent delivering)", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 100,
      proposed_daily_budget_usd: 500,
    });
    expect(r.forceApproval).toBe(false);
  });

  it("DECREASE on a delivering ad set: never gated here (cuts don't reset learning)", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 100,
      proposed_daily_budget_usd: 20,
      delivering: true,
    });
    expect(r.forceApproval).toBe(false);
  });

  it("no-op (proposed === current) on a delivering ad set: silent", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 100,
      proposed_daily_budget_usd: 100,
      delivering: true,
    });
    expect(r.forceApproval).toBe(false);
  });

  it("raise exactly at +30% on a delivering ad set: allowed (inclusive bound)", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 100,
      proposed_daily_budget_usd: 130,
      delivering: true,
    });
    expect(r.forceApproval).toBe(false);
    expect(r.step_pct).toBeCloseTo(0.3, 10);
  });

  it("raise just under +30%: allowed", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 100,
      proposed_daily_budget_usd: 125,
      delivering: true,
    });
    expect(r.forceApproval).toBe(false);
  });

  it("tiny line: $2 → $11 (+450% but only +$9 ≤ $10 floor) → allowed", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 2,
      proposed_daily_budget_usd: 11,
      delivering: true,
    });
    expect(r.forceApproval).toBe(false);
  });

  it("tiny line at the $10 floor exactly: $5 → $15 (+$10) → allowed (inclusive)", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 5,
      proposed_daily_budget_usd: 15,
      delivering: true,
    });
    expect(r.forceApproval).toBe(false);
  });

  it("current budget 0 on a 'delivering' flag: treated as create-style, silent", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 0,
      proposed_daily_budget_usd: 50,
      delivering: true,
    });
    expect(r.forceApproval).toBe(false);
  });
});

describe("evaluateLearningPhaseStep — FORCES approval", () => {
  it("delivering ad set, $72 → $144 (2x, +100%, +$72) → force approval", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 72,
      proposed_daily_budget_usd: 144,
      delivering: true,
    });
    expect(r.forceApproval).toBe(true);
    expect(r.reason).toBe("oversized_learning_phase_step");
    expect(r.step_pct).toBeCloseTo(1.0, 10);
  });

  it("delivering ad set, $100 → $135 (+35%, +$35 > floor) → force approval", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 100,
      proposed_daily_budget_usd: 135,
      delivering: true,
    });
    expect(r.forceApproval).toBe(true);
  });

  it("boundary: $30 → $90 (+200%) → force approval", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 30,
      proposed_daily_budget_usd: 90,
      delivering: true,
    });
    expect(r.forceApproval).toBe(true);
  });
});

describe("evaluateLearningPhaseStep — justification escape hatch (still NOT auto)", () => {
  it("justified oversized step → forceApproval FALSE (defers to normal routing, never auto)", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 72,
      proposed_daily_budget_usd: 144,
      delivering: true,
      justifiedOversizedStep: true,
    });
    expect(r.forceApproval).toBe(false);
    expect(r.step_pct).toBeCloseTo(1.0, 10);
  });

  it("justification on a within-step raise is a no-op (already silent)", () => {
    const r = evaluateLearningPhaseStep({
      current_daily_budget_usd: 100,
      proposed_daily_budget_usd: 120,
      delivering: true,
      justifiedOversizedStep: true,
    });
    expect(r.forceApproval).toBe(false);
  });
});

describe("evaluateLearningPhaseStep — exported thresholds", () => {
  it("threshold constants are +30% / +$10", () => {
    expect(STEP_PCT_CEILING).toBe(0.3);
    expect(STEP_DOLLAR_FLOOR_USD).toBe(10);
  });
});

describe("evaluateLearningPhaseStep: Autopilot with an ad budget", () => {
  it("cgoBudgetBounds silences an oversized raise on a delivering ad set", () => {
    const r = evaluateLearningPhaseStep({ current_daily_budget_usd: 100, proposed_daily_budget_usd: 180, delivering: true, cgoBudgetBounds: true });
    expect(r.forceApproval).toBe(false);
    expect(r.reason).toBe("cgo_budget_bounds_step");
  });

  it("without it the same raise is forced to review", () => {
    const r = evaluateLearningPhaseStep({ current_daily_budget_usd: 100, proposed_daily_budget_usd: 180, delivering: true });
    expect(r.forceApproval).toBe(true);
  });
});
