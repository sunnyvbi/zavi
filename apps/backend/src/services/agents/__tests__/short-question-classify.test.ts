import { describe, it, expect } from "vitest";
import {
  isShortQuestion,
  resolveResponseShape,
} from "../short-question-classify";

describe("isShortQuestion", () => {
  describe("SHORT (true)", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["incident question", "is the bay area budget doubled?"],
      ["explicit yes/no marker", "yes or no — did we lose the Q4 host?"],
      ["tldr marker", "tldr the ads digest"],
      ["one-line marker", "one line: are we profitable?"],
      ["short status query", "is stripe connected?"],
      ["short factual lookup", "how many active campaigns do we have?"],
      ["minimal", "did we ship today?"],
    ];
    for (const [label, text] of cases) {
      it(label, () => {
        expect(isShortQuestion(text)).toBe(true);
      });
    }
  });

  describe("LONG (false)", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        "explicit full-digest request",
        "give me the full weekly digest for ads with all five sections",
      ],
      ["explicit report request", "run the report on host acquisition this week"],
      ["deep-dive request", "walk me through the dispute-response funnel deep dive"],
      [
        "long multi-clause",
        "summarize our entire growth strategy across paid, organic, partner channels and tell me what to prioritize next quarter and why with reasoning",
      ],
      ["empty", ""],
      ["whitespace", "    \n  "],
      ["null", null as unknown as string],
      ["full + weekly mix", "comprehensive monthly review of payouts"],
    ];
    for (const [label, text] of cases) {
      it(label, () => {
        expect(isShortQuestion(text)).toBe(false);
      });
    }
  });
});

describe("resolveResponseShape", () => {
  it("contract=digest pins to digest regardless of length", () => {
    const r = resolveResponseShape({
      responseContract: "digest",
      hasEnvelope: true,
      questionText: "is X doubled?",
    });
    expect(r.shape).toBe("digest");
    expect(r.short_question).toBe(true);
  });

  it("contract=terse pins to terse regardless of length", () => {
    const r = resolveResponseShape({
      responseContract: "terse",
      hasEnvelope: true,
      questionText: "give me the full weekly comprehensive digest",
    });
    expect(r.shape).toBe("terse");
    expect(r.short_question).toBe(false);
  });

  it("auto + envelope agent + short question → terse", () => {
    const r = resolveResponseShape({
      responseContract: "auto",
      hasEnvelope: true,
      questionText: "is the bay area budget doubled?",
    });
    expect(r.shape).toBe("terse");
  });

  it("auto + envelope agent + LONG question → digest", () => {
    const r = resolveResponseShape({
      responseContract: "auto",
      hasEnvelope: true,
      questionText: "give me the full weekly digest with all five sections please",
    });
    expect(r.shape).toBe("digest");
  });

  it("auto + non-envelope agent (chat-only) → digest (nothing to collapse)", () => {
    const r = resolveResponseShape({
      responseContract: "auto",
      hasEnvelope: false,
      questionText: "is X doubled?",
    });
    expect(r.shape).toBe("digest");
  });

  it("defaults responseContract to auto when undefined", () => {
    const r = resolveResponseShape({
      responseContract: undefined,
      hasEnvelope: true,
      questionText: "is X paused?",
    });
    expect(r.shape).toBe("terse");
  });
});
