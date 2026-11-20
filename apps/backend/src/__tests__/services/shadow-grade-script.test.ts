import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveComparisonScore,
  normalizeForBlind,
  assignBlindLabels,
  decodeScores,
  gradeabilityReason,
  aggregateScorecard,
  type ShadowGradeRow,
  type GradeOutcome,
} from "../../../scripts/shadow-grade";
import type { BlindJudgeVerdict } from "../../services/eval/engine-parity/engine-parity";

const src = readFileSync(join(__dirname, "../../../scripts/shadow-grade.ts"), "utf-8");

const baseRow = (over: Partial<ShadowGradeRow> = {}): ShadowGradeRow => ({
  shadow_id: "s1",
  source_agent_run_id: "r1",
  agent_slug: "support-lead",
  shadow_tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
  source_tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
  input_prompt: "help me",
  openai_raw: "openai answer",
  anthropic_raw: "anthropic answer",
  shadow_model: "qwen.qwen3-next-80b-a3b-instruct",
  ...over,
});

describe("deriveComparisonScore — 0-5 blind pair → 0-4 parity", () => {
  it("tie → 3 (parity, ship-acceptable)", () => {
    expect(deriveComparisonScore(3, 3)).toBe(3);
    expect(deriveComparisonScore(5, 5)).toBe(3);
    expect(deriveComparisonScore(0, 0)).toBe(3);
  });
  it("OpenAI better by 1 → 4 (round(3.5)=4)", () => {
    expect(deriveComparisonScore(4, 3)).toBe(4);
  });
  it("OpenAI worse by 1 → 2 (round(1.5)=2)", () => {
    expect(deriveComparisonScore(3, 4)).toBe(2);
  });
  it("OpenAI far worse → clamps to 0", () => {
    expect(deriveComparisonScore(0, 5)).toBe(0);
    expect(deriveComparisonScore(0, 4)).toBe(0);
  });
  it("OpenAI far better → clamps to 4", () => {
    expect(deriveComparisonScore(5, 0)).toBe(4);
  });
});

describe("normalizeForBlind — strip provider residue", () => {
  it("removes brand/model tokens", () => {
    const n = normalizeForBlind("As Claude, an Anthropic model (not GPT-4o or Gemini)...");
    expect(n.toLowerCase()).not.toContain("claude");
    expect(n.toLowerCase()).not.toContain("anthropic");
    expect(n.toLowerCase()).not.toContain("gpt");
    expect(n.toLowerCase()).not.toContain("gemini");
  });
  it("strips anthropic XML tool envelopes + openai tool-call wrappers", () => {
    const n = normalizeForBlind("<function_calls><invoke>x</invoke></function_calls> tool_calls here");
    expect(n).not.toMatch(/function_calls|invoke|tool_calls/i);
  });
  it("preserves substantive content", () => {
    expect(normalizeForBlind("The booking is confirmed for Tuesday.")).toContain("booking is confirmed for Tuesday");
  });
});

describe("assignBlindLabels + decodeScores — A/B randomize then un-randomize", () => {
  it("coin 0 → A=candidate, B=baseline; decode recovers the right side", () => {
    const { outputA, outputB, labelMap } = assignBlindLabels("CAND_TEXT", "BASE_TEXT", 0);
    expect(outputA).toBe("CAND_TEXT");
    expect(outputB).toBe("BASE_TEXT");
    expect(labelMap).toEqual({ A: "candidate", B: "baseline" });
    const v: BlindJudgeVerdict = { task_id: "t", winner_label: "A", score_a: 4, score_b: 2, justification: "" };
    expect(decodeScores(v, labelMap)).toEqual({ candidate_score: 4, baseline_score: 2 });
  });
  it("coin 1 → A=baseline, B=candidate; decode still recovers the candidate's score", () => {
    const { outputA, outputB, labelMap } = assignBlindLabels("CAND_TEXT", "BASE_TEXT", 1);
    expect(outputA).toBe("BASE_TEXT");
    expect(outputB).toBe("CAND_TEXT");
    expect(labelMap).toEqual({ A: "baseline", B: "candidate" });
    const v: BlindJudgeVerdict = { task_id: "t", winner_label: "B", score_a: 1, score_b: 5, justification: "" };
    expect(decodeScores(v, labelMap)).toEqual({ candidate_score: 5, baseline_score: 1 });
  });
});

describe("gradeabilityReason — skip on null raw", () => {
  it("gradeable when both raws present", () => {
    expect(gradeabilityReason(baseRow())).toBeNull();
  });
  it("skips when source anthropic raw empty", () => {
    expect(gradeabilityReason(baseRow({ anthropic_raw: null }))).toMatch(/rendered output empty/);
    expect(gradeabilityReason(baseRow({ anthropic_raw: "   " }))).toMatch(/rendered output empty/);
  });
  it("skips when shadow openai raw empty", () => {
    expect(gradeabilityReason(baseRow({ openai_raw: null }))).toMatch(/output_text/);
  });
});

describe("aggregateScorecard", () => {
  it("computes mean, parity%, skipped/judge counts per agent", () => {
    const outcomes: GradeOutcome[] = [
      { kind: "graded", agent_slug: "support-lead", comparison_score: 4, openai_score: 5, anthropic_score: 3 },
      { kind: "graded", agent_slug: "support-lead", comparison_score: 2, openai_score: 2, anthropic_score: 3 },
      { kind: "skipped_null", agent_slug: "support-lead", reason: "x" },
      { kind: "judge_unavailable", agent_slug: "pm" },
      { kind: "graded", agent_slug: "pm", comparison_score: 3, openai_score: 3, anthropic_score: 3 },
    ];
    const scores = aggregateScorecard(outcomes);
    const sl = scores.find((s) => s.agent_slug === "support-lead")!;
    expect(sl.n).toBe(2);
    expect(sl.mean).toBe(3);
    expect(sl.parity_pct).toBe(50);
    expect(sl.skipped_null).toBe(1);
    const pm = scores.find((s) => s.agent_slug === "pm")!;
    expect(pm.n).toBe(1);
    expect(pm.parity_pct).toBe(100);
    expect(pm.judge_unavailable).toBe(1);
  });
});

describe("shadow-grade script — safety wiring (source-level)", () => {
  it("Slice 2: --tenant gated on the shadow allowlist; egress filter on the REQUESTED tenant", () => {
    expect(src).toMatch(/isShadowTenantAllowed/);
    expect(src).toMatch(/from "\.\.\/src\/services\/eval\/shadow-tenant-allowlist"/);
    expect(src).toMatch(/\.eq\("agent_runs\.tenant_id", tenant\)/);
    expect(src).not.toMatch(/\.eq\("agent_runs\.tenant_id", DOGFOOD_TENANT\)/);
  });
  it("per-row tenant-mismatch HARD-ERRORS (corrupt row never egresses to a judge)", () => {
    expect(src).toMatch(/shadow_tenant_id !== row\.source_tenant_id/);
    expect(src).toMatch(/throw new Error\([\s\S]*tenant mismatch/);
  });
  it("only selects ungraded gradeable rows (idempotent rescans)", () => {
    expect(src).toMatch(/\.is\("comparison_score", null\)/);
    expect(src).toMatch(/\.in\("status",\s*\[\s*"success",\s*"parse_failed"\s*\]\)/);
    expect(src).toMatch(/\.not\("output_text", "is", null\)/);
  });
  it("judge family ladder EXCLUDES the OpenAI family (NEVER codex/claude — shadow side under judgment)", () => {
    expect(src).toMatch(/buildJudgeFamilyLadder\(\{[\s\S]*excludeOpenAiFamily: true/);
    expect(src).toMatch(/JUDGE_LADDER/);
    expect(src).not.toMatch(/codex (exec|review)/);
    expect(src).not.toMatch(/CODEX_CALL/);
    expect(src).not.toMatch(/callModel\(/);
  });
  it("writeback is the grade_shadow_run RPC touching only comparison_*", () => {
    expect(src).toMatch(/\.rpc\("grade_shadow_run"/);
    expect(src).toMatch(/p_comparison_score: comparison_score/);
    expect(src).toMatch(/p_comparison_notes: notes/);
  });
  it("comparison_notes is structured metadata — NO raw output excerpts (2nd-PII-surface guard)", () => {
    expect(src).toMatch(/buildComparisonNotes\(isCustomer,/);
    expect(src).toMatch(/judge_family: v\.judge_family/);
    expect(src).not.toMatch(/notes[\s\S]{0,40}openai_raw/);
  });
  it("judge outage leaves the row null + exits non-zero unless --allow-partial", () => {
    expect(src).toMatch(/judge_unavailable/);
    expect(src).toMatch(/!args\.allowPartial/);
    expect(src).toMatch(/process\.exit\(1\)/);
  });
});
