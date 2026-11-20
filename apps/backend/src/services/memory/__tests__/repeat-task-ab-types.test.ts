import { describe, it, expect } from "vitest";
import {
  clampCorrectness,
  computeGoldenDelta,
  summarizeAbRun,
  type AbArmResult,
} from "../repeat-task-ab-types";

const arm = (over: Partial<AbArmResult>): AbArmResult => ({
  tenant_id: "t-1",
  agent_slug: "engineer",
  golden_id: "g-1",
  eval_run_id: "run-1",
  arm: "brain_on",
  correctness_score: null,
  model_cost_usd: null,
  retrieval_cost_usd: null,
  judge_cost_usd: null,
  walltime_ms: null,
  terminal_status: null,
  ...over,
});

describe("clampCorrectness", () => {
  it("clamps to [0,1] and passes null/NaN through as null", () => {
    expect(clampCorrectness(0.5)).toBe(0.5);
    expect(clampCorrectness(1.4)).toBe(1);
    expect(clampCorrectness(-0.2)).toBe(0);
    expect(clampCorrectness(null)).toBeNull();
    expect(clampCorrectness(undefined)).toBeNull();
    expect(clampCorrectness(NaN)).toBeNull();
  });
});

describe("computeGoldenDelta", () => {
  it("computes correctness + cost deltas with judge cost excluded from customer delta", () => {
    const d = computeGoldenDelta([
      arm({ arm: "brain_on", correctness_score: 0.9, model_cost_usd: 0.10, retrieval_cost_usd: 0.02, judge_cost_usd: 0.05, terminal_status: "finished" }),
      arm({ arm: "brain_off", correctness_score: 0.6, model_cost_usd: 0.08, retrieval_cost_usd: 0, judge_cost_usd: 0.05, terminal_status: "finished" }),
    ]);
    expect(d.correctness_delta).toBeCloseTo(0.3);
    expect(d.customer_cost_delta).toBeCloseTo(0.04);
    expect(d.total_cost_delta).toBeCloseTo(0.04);
    expect(d.both_arms_finished).toBe(true);
  });

  it("null-fills deltas when an arm is missing (partial run never fabricates a comparison)", () => {
    const d = computeGoldenDelta([
      arm({ arm: "brain_on", correctness_score: 0.9, terminal_status: "finished" }),
    ]);
    expect(d.correctness_off).toBeNull();
    expect(d.correctness_delta).toBeNull();
    expect(d.both_arms_finished).toBe(false);
  });

  it("both_arms_finished is false if either arm errored", () => {
    const d = computeGoldenDelta([
      arm({ arm: "brain_on", correctness_score: 0.9, terminal_status: "finished" }),
      arm({ arm: "brain_off", correctness_score: 0.5, terminal_status: "dispatch_error" }),
    ]);
    expect(d.both_arms_finished).toBe(false);
  });

  it("throws on a malformed pairing (results spanning multiple goldens)", () => {
    expect(() =>
      computeGoldenDelta([
        arm({ arm: "brain_on", golden_id: "g-1" }),
        arm({ arm: "brain_off", golden_id: "g-2" }),
      ]),
    ).toThrow(/multiple goldens/);
  });

  it("throws when no arm results are supplied", () => {
    expect(() => computeGoldenDelta([])).toThrow(/no arm results/);
  });

  it("throws on a duplicate arm (invariant: one result per arm)", () => {
    expect(() =>
      computeGoldenDelta([
        arm({ arm: "brain_on", correctness_score: 0.9 }),
        arm({ arm: "brain_on", correctness_score: 0.4 }),
      ]),
    ).toThrow(/duplicate 'brain_on' arm/);
  });
});

describe("summarizeAbRun", () => {
  it("means only over goldens with both arms finished AND judged", () => {
    const finishedJudged = computeGoldenDelta([
      arm({ golden_id: "g-1", arm: "brain_on", correctness_score: 1, model_cost_usd: 0.1, terminal_status: "finished" }),
      arm({ golden_id: "g-1", arm: "brain_off", correctness_score: 0.5, model_cost_usd: 0.1, terminal_status: "finished" }),
    ]);
    const unjudged = computeGoldenDelta([
      arm({ golden_id: "g-2", arm: "brain_on", correctness_score: null, terminal_status: "finished" }),
      arm({ golden_id: "g-2", arm: "brain_off", correctness_score: null, terminal_status: "finished" }),
    ]);
    const halfRun = computeGoldenDelta([
      arm({ golden_id: "g-3", arm: "brain_on", correctness_score: 0.9, terminal_status: "finished" }),
    ]);
    const s = summarizeAbRun("run-1", [finishedJudged, unjudged, halfRun]);
    expect(s.goldens_compared).toBe(1);
    expect(s.mean_correctness_delta).toBeCloseTo(0.5);
    expect(s.brain_helped_count).toBe(1);
    expect(s.brain_hurt_count).toBe(0);
  });

  it("returns null means for an empty / all-unqualified run", () => {
    const s = summarizeAbRun("run-9", []);
    expect(s.goldens_compared).toBe(0);
    expect(s.mean_correctness_delta).toBeNull();
    expect(s.mean_customer_cost_delta).toBeNull();
  });
});
