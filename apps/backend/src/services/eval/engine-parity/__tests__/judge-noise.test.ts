import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertJudgeNotContestant,
  modelFamily,
  normalizeForBlind,
  deriveComparisonScore,
  gradeShadowRowCore,
  buildBedrockJudgeLadder,
  type ShadowJudgeFn,
} from "../engine-parity";
import {
  countRowFlips,
  summarizeNoise,
  runNoise,
  type NoiseRow,
} from "../../../../../scripts/shadow-judge-noise";
import { MODELS } from "../../../llm/models";

describe("assertJudgeNotContestant — fairness guard fires", () => {
  const QWEN = MODELS.bedrock.qwen3Next80b;
  const CLAUDE = MODELS.anthropic.opus;
  const JUDGE = MODELS.bedrock.judgeMistralLarge3;

  it("passes for the pinned non-contestant judge (llama) vs qwen-candidate / claude-baseline", () => {
    expect(() =>
      assertJudgeNotContestant({ judgeModel: JUDGE, candidateModel: QWEN, baselineModel: CLAUDE }),
    ).not.toThrow();
  });

  it("(b) THROWS when judge_model === shadow_model (Qwen-vs-Qwen rejected)", () => {
    expect(() =>
      assertJudgeNotContestant({ judgeModel: QWEN, candidateModel: QWEN, baselineModel: CLAUDE }),
    ).toThrow(/judge_model[\s\S]*=== shadow_model|cannot blind-judge itself/);
  });

  it("(b) THROWS when judge_model === baseline_model", () => {
    expect(() =>
      assertJudgeNotContestant({ judgeModel: CLAUDE, candidateModel: QWEN, baselineModel: CLAUDE }),
    ).toThrow(/baseline_model|cannot blind-judge itself/);
  });

  it("(a) THROWS when judge family matches a contestant family (different id, same family)", () => {
    expect(() =>
      assertJudgeNotContestant({
        judgeModel: "qwen.qwen3-other-variant",
        candidateModel: QWEN,
        baselineModel: CLAUDE,
      }),
    ).toThrow(/family[\s\S]*matches a contestant family/);
  });

  it("(a) THROWS when judge shares the baseline (anthropic) family", () => {
    expect(() =>
      assertJudgeNotContestant({
        judgeModel: "claude-sonnet-4-6",
        candidateModel: QWEN,
        baselineModel: CLAUDE,
      }),
    ).toThrow(/family[\s\S]*matches a contestant family|cannot blind-judge itself/);
  });

  it("THROWS on empty judge model", () => {
    expect(() =>
      assertJudgeNotContestant({ judgeModel: "  ", candidateModel: QWEN, baselineModel: CLAUDE }),
    ).toThrow(/judge model is empty/);
  });

  it("modelFamily classifies the contestant families distinctly", () => {
    expect(modelFamily(MODELS.bedrock.qwen3Next80b)).toBe("qwen");
    expect(modelFamily(MODELS.bedrock.judgeMistralLarge3)).toBe("mistral");
    expect(modelFamily(MODELS.anthropic.opus)).toBe("anthropic");
    expect(modelFamily("zai.glm-5")).toBe("zai");
  });
});

describe("normalizeForBlind — strips the Slice-1 Bedrock/open-weights tokens", () => {
  it("strips bedrock|aws|qwen|zai|glm|llama (in addition to existing residue)", () => {
    const n = normalizeForBlind(
      "Served via AWS Bedrock, this Qwen / Llama / GLM (zai) model says hi. As Claude / GPT / Gemini too.",
    );
    const lc = n.toLowerCase();
    for (const tok of ["bedrock", "aws", "qwen", "zai", "glm", "llama", "claude", "gpt", "gemini"]) {
      expect(lc).not.toContain(tok);
    }
  });
  it("preserves substantive content", () => {
    expect(normalizeForBlind("The booking is confirmed for Tuesday.")).toContain(
      "booking is confirmed for Tuesday",
    );
  });
});

describe("flip math — countRowFlips + summarizeNoise", () => {
  it("stable judge (all rounds same score) → 0 flips", () => {
    expect(countRowFlips([3, 3, 3])).toEqual({ flips: 0, pairs: 2 });
  });
  it("one flip across an adjacent pair", () => {
    expect(countRowFlips([3, 4, 4])).toEqual({ flips: 1, pairs: 2 });
  });
  it("flips on every adjacent pair (max noise)", () => {
    expect(countRowFlips([2, 4, 2])).toEqual({ flips: 2, pairs: 2 });
  });
  it("single round → no comparable pairs", () => {
    expect(countRowFlips([3])).toEqual({ flips: 0, pairs: 0 });
  });

  it("summarizeNoise: clean flip-rate under threshold → reliable", () => {
    const perRow = Array.from({ length: 10 }, () => ({ flips: 0, pairs: 2 }));
    const res = summarizeNoise(perRow, 0, 10, 0.1);
    expect(res.flip_rate).toBe(0);
    expect(res.reliable).toBe(true);
  });
  it("summarizeNoise: flip-rate over threshold → NOT reliable", () => {
    const perRow = Array.from({ length: 10 }, (_, i) => ({ flips: i < 5 ? 1 : 0, pairs: 2 }));
    const res = summarizeNoise(perRow, 0, 10, 0.1);
    expect(res.flip_rate).toBe(0.25);
    expect(res.reliable).toBe(false);
  });
  it("summarizeNoise: any judge outage fails the gate even with clean flips", () => {
    const perRow = Array.from({ length: 10 }, () => ({ flips: 0, pairs: 2 }));
    const res = summarizeNoise(perRow, 1, 10, 0.1);
    expect(res.flip_rate).toBe(0);
    expect(res.reliable).toBe(false);
  });
});

describe("runNoise — exercises the shared gradeShadowRowCore via a fake judge", () => {
  const row: NoiseRow = {
    shadow_id: "s1",
    agent_slug: "research",
    input_prompt: "summarize",
    candidate_raw: "CANDIDATE ANSWER",
    baseline_raw: "BASELINE ANSWER",
    shadow_model: MODELS.bedrock.qwen3Next80b,
  };

  it("a position-stable judge yields 0 flips → reliable", async () => {
    const judge: ShadowJudgeFn = async ({ user }) => {
      const candFirst = user.indexOf("CANDIDATE ANSWER");
      const baseFirst = user.indexOf("BASELINE ANSWER");
      const candIsA = candFirst < baseFirst;
      const score_a = candIsA ? 5 : 2;
      const score_b = candIsA ? 2 : 5;
      return JSON.stringify({ score_a, score_b, winner: candIsA ? "A" : "B", justification: "x" });
    };
    const res = await runNoise([row], judge, MODELS.bedrock.judgeMistralLarge3, 4, 0.1);
    expect(res.rows_evaluated).toBe(1);
    expect(res.flips).toBe(0);
    expect(res.reliable).toBe(true);
  });

  it("a POSITION-biased judge (always prefers slot A) flips on every swap → NOT reliable", async () => {
    const judge: ShadowJudgeFn = async () =>
      JSON.stringify({ score_a: 5, score_b: 1, winner: "A", justification: "x" });
    const res = await runNoise([row], judge, MODELS.bedrock.judgeMistralLarge3, 4, 0.1);
    expect(res.rows_evaluated).toBe(1);
    expect(res.flips).toBeGreaterThan(0);
    expect(res.reliable).toBe(false);
  });

  it("a judge outage (null) → judge_unavailable, not reliable", async () => {
    const judge: ShadowJudgeFn = async () => null;
    const res = await runNoise([row], judge, MODELS.bedrock.judgeMistralLarge3, 3, 0.1);
    expect(res.judge_unavailable).toBe(1);
    expect(res.rows_evaluated).toBe(0);
    expect(res.reliable).toBe(false);
  });

  it("gradeShadowRowCore THROWS (fails the core) when judge==contestant — fairness enforced in the real path", async () => {
    const judge: ShadowJudgeFn = async () =>
      JSON.stringify({ score_a: 3, score_b: 3, winner: "tie", justification: "x" });
    await expect(
      gradeShadowRowCore({
        row: {
          id: "s1",
          agent_slug: "research",
          input_prompt: "x",
          candidate_raw: "c",
          baseline_raw: "b",
        },
        judge,
        judgeModel: MODELS.bedrock.qwen3Next80b,
        candidateModel: MODELS.bedrock.qwen3Next80b,
        baselineModel: MODELS.anthropic.opus,
        coin: 0,
      }),
    ).rejects.toThrow(/cannot blind-judge itself|=== shadow_model/);
  });
});

describe("noise script uses the shared core — NOT a fork", () => {
  const noiseSrc = readFileSync(
    join(__dirname, "../../../../../scripts/shadow-judge-noise.ts"),
    "utf-8",
  );
  const gradeSrc = readFileSync(
    join(__dirname, "../../../../../scripts/shadow-grade.ts"),
    "utf-8",
  );

  it("noise script imports gradeShadowRowCore from engine-parity", () => {
    expect(noiseSrc).toMatch(/gradeShadowRowCore/);
    expect(noiseSrc).toMatch(/from "\.\.\/src\/services\/eval\/engine-parity\/engine-parity"/);
  });
  it("noise script does NOT re-implement the judge call / parse / derive (no fork)", () => {
    expect(noiseSrc).not.toMatch(/function deriveComparisonScore/);
    expect(noiseSrc).not.toMatch(/function parseBlindJudgeReply/);
    expect(noiseSrc).not.toMatch(/function buildBlindJudgePrompt/);
  });
  it("the GRADER also routes through the SAME shared core (single path)", () => {
    expect(gradeSrc).toMatch(/gradeShadowRowCore/);
  });
  it("both scripts use the in-VPC Bedrock judge, not a 3rd-party-only path", () => {
    expect(noiseSrc).toMatch(/makeBedrockJudgeFn/);
    expect(gradeSrc).toMatch(/makeBedrockJudgeFn/);
  });
});

describe("buildBedrockJudgeLadder", () => {
  it("returns a single bedrock family with the default model when env unset", () => {
    const ladder = buildBedrockJudgeLadder({
      env: {},
      defaultModel: MODELS.bedrock.judgeMistralLarge3,
    });
    expect(ladder).toHaveLength(1);
    expect(ladder[0]).toEqual({ name: "bedrock", model: MODELS.bedrock.judgeMistralLarge3 });
  });
  it("env PRAXIS_SHADOW_JUDGE_BEDROCK_MODEL overrides the default", () => {
    const ladder = buildBedrockJudgeLadder({
      env: { PRAXIS_SHADOW_JUDGE_BEDROCK_MODEL: "meta.llama-custom" },
      defaultModel: MODELS.bedrock.judgeMistralLarge3,
    });
    expect(ladder[0].model).toBe("meta.llama-custom");
  });
});
