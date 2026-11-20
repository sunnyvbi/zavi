import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  gradeShadowRowCore,
  type ShadowJudgeFn,
} from "@/services/eval/engine-parity/engine-parity";
import { MODELS } from "@/services/llm/models";
import { buildComparisonNotes } from "../../../scripts/shadow-grade";

const gradeSrc = readFileSync(join(__dirname, "../../../scripts/shadow-grade.ts"), "utf-8");

describe("(a) mocked Bedrock failure → judge_unavailable + ZERO 3rd-party fallback", () => {
  it("a null (outage) Bedrock judge yields judge_unavailable — the core has NO fallback", async () => {
    const cliSpy = vi.fn();
    const judge: ShadowJudgeFn = async () => {
      return null;
    };
    const res = await gradeShadowRowCore({
      row: {
        id: "s1",
        agent_slug: "support-lead",
        input_prompt: "customer asks for a refund on order 8842",
        candidate_raw: "candidate answer with the customer's order details",
        baseline_raw: "baseline answer with the customer's order details",
      },
      judge,
      judgeModel: MODELS.bedrock.judgeMistralLarge3,
      candidateModel: MODELS.bedrock.qwen3Next80b,
      baselineModel: MODELS.anthropic.opus,
      coin: 0,
      judgeFamily: "bedrock",
    });
    expect(res.kind).toBe("judge_unavailable");
    expect(cliSpy).not.toHaveBeenCalled();
  });

  it("a thrown (outage) Bedrock judge ALSO yields judge_unavailable (no fallback)", async () => {
    const judge: ShadowJudgeFn = async () => {
      throw new Error("bedrock 503");
    };
    const res = await gradeShadowRowCore({
      row: {
        id: "s2",
        agent_slug: "pm",
        input_prompt: "x",
        candidate_raw: "c",
        baseline_raw: "b",
      },
      judge,
      judgeModel: MODELS.bedrock.judgeMistralLarge3,
      candidateModel: MODELS.bedrock.qwen3Next80b,
      baselineModel: MODELS.anthropic.opus,
      coin: 1,
      judgeFamily: "bedrock",
    });
    expect(res.kind).toBe("judge_unavailable");
  });
});

describe("(source) customer rows IGNORE the legacy grok/gemini CLI judge", () => {
  it("useLegacyCli is gated on !isCustomer (customer rows never select the CLI ladder)", () => {
    expect(gradeSrc).toMatch(
      /const useLegacyCli\s*=\s*\n?\s*!isCustomer && process\.env\.SHADOW_GRADE_LEGACY_CLI_JUDGE === "1"/,
    );
  });

  it("customer path preflights the in-VPC Bedrock judge BEFORE loading rows (no 3rd-party fallback)", () => {
    expect(gradeSrc).toMatch(/assertBedrockJudgeAvailable\(\)/);
    const preflightIdx = gradeSrc.indexOf("assertBedrockJudgeAvailable()");
    const selectIdx = gradeSrc.indexOf("await selectUngraded(args)");
    expect(preflightIdx).toBeGreaterThan(0);
    expect(selectIdx).toBeGreaterThan(preflightIdx);
  });

  it("--allow-partial is FORBIDDEN for a customer tenant (all-or-nothing)", () => {
    expect(gradeSrc).toMatch(/--allow-partial is forbidden for a customer tenant/);
    expect(gradeSrc).toMatch(/if \(isCustomer\) \{[\s\S]*?if \(args\.allowPartial\)/);
  });
});

describe("(b) customer-row comparison_notes are structured-only (no free-text justification)", () => {
  const verdict = {
    judge_family: "bedrock",
    openai_score: 4,
    anthropic_score: 3,
    winner: "A" as const,
    justification: "The candidate quoted the customer's email jane@acme.com and order 8842.",
  };

  it("CUSTOMER notes DROP the justification entirely", () => {
    const parsed = JSON.parse(buildComparisonNotes(true, verdict));
    expect(parsed).toEqual({
      judge_family: "bedrock",
      openai_score: 4,
      anthropic_score: 3,
      winner: "A",
    });
    expect(parsed.reason).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("jane@acme.com");
    expect(JSON.stringify(parsed)).not.toContain("8842");
  });

  it("DOGFOOD notes keep a 280-char truncated reason (debuggability)", () => {
    const parsed = JSON.parse(buildComparisonNotes(false, verdict));
    expect(parsed.reason).toBe(verdict.justification);
    expect(parsed.judge_family).toBe("bedrock");
  });

  it("dogfood reason is capped at 280 chars", () => {
    const long = { ...verdict, justification: "z".repeat(500) };
    const parsed = JSON.parse(buildComparisonNotes(false, long));
    expect(parsed.reason.length).toBe(280);
  });
});
