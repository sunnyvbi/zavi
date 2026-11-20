
import { describe, it, expect } from "vitest";
import {
  gradeShadowRowSwapAveraged,
  scoreDirection,
  type ShadowJudgeFn,
} from "../engine-parity";

const ROW = {
  id: "row1",
  agent_slug: "research",
  input_prompt: "task",
  candidate_raw: "CANDIDATE ANSWER",
  baseline_raw: "BASELINE ANSWER",
};
const MODELS_ARG = {
  judgeModel: "mistral.mistral-large-3-675b-instruct",
  candidateModel: "qwen.qwen3-next-80b-a3b-instruct",
  baselineModel: "claude-opus-4-7",
};

function scriptedJudge(replies: (string | null)[]): ShadowJudgeFn {
  let i = 0;
  return async () => replies[i++] ?? null;
}
const verdict = (a: number, b: number) =>
  JSON.stringify({ score_a: a, score_b: b, winner: a > b ? "A" : a < b ? "B" : "tie", justification: "x" });

describe("gradeShadowRowSwapAveraged", () => {
  it("scoreDirection is order-independent on decoded scores", () => {
    expect(scoreDirection(5, 3)).toBe("candidate");
    expect(scoreDirection(3, 5)).toBe("baseline");
    expect(scoreDirection(4, 4)).toBe("tie");
  });

  it("POSITION-BIASED judge (always A>B) → neutralized to TIE", async () => {
    const out = await gradeShadowRowSwapAveraged({
      row: ROW,
      judge: scriptedJudge([verdict(5, 3), verdict(5, 3)]),
      ...MODELS_ARG,
    });
    expect(out.kind).toBe("graded");
    if (out.kind !== "graded") return;
    expect(out.orders_used).toBe(2);
    expect(out.orders_agreed).toBe(false);
    expect(out.winner).toBe("tie");
    expect(out.comparison_score).toBe(3);
    expect(out.candidate_score).toBe(4);
  });

  it("CONTENT-CONSISTENT judge (candidate wins both orders) → keeps verdict", async () => {
    const out = await gradeShadowRowSwapAveraged({
      row: ROW,
      judge: scriptedJudge([verdict(5, 2), verdict(2, 5)]),
      ...MODELS_ARG,
    });
    expect(out.kind).toBe("graded");
    if (out.kind !== "graded") return;
    expect(out.orders_agreed).toBe(true);
    expect(out.winner).toBe("candidate");
    expect(out.candidate_score).toBe(5);
    expect(out.baseline_score).toBe(2);
    expect(out.comparison_score).toBe(4);
  });

  it("one order fails → DEGRADED to the single available order (not lost)", async () => {
    const out = await gradeShadowRowSwapAveraged({
      row: ROW,
      judge: scriptedJudge([verdict(5, 2), null]),
      ...MODELS_ARG,
    });
    expect(out.kind).toBe("graded");
    if (out.kind !== "graded") return;
    expect(out.orders_used).toBe(1);
    expect(out.orders_agreed).toBe(null);
    expect(out.winner).toBe("candidate");
  });

  it("both orders fail → judge_unavailable (fail-closed)", async () => {
    const out = await gradeShadowRowSwapAveraged({
      row: ROW,
      judge: scriptedJudge([null, null]),
      ...MODELS_ARG,
    });
    expect(out.kind).toBe("judge_unavailable");
  });
});
