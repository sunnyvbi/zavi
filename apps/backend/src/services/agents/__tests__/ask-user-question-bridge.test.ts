
import { describe, it, expect } from "vitest";
import { askUserQuestionToClarifyInput, ASK_USER_QUESTION_DENY_MESSAGE } from "../ask-user-question-bridge";
import { buildClarifyEnvelope } from "../clarify-envelope";

const SDK_INPUT = {
  questions: [
    {
      question: "Which channel should I post the UGC campaign video to?",
      header: "Slack channel",
      multiSelect: false,
      options: [
        { label: "#all-general", description: "Company-wide channel, 27 members" },
        { label: "#content-updates", description: "Content-focused channel" },
      ],
    },
  ],
};

describe("askUserQuestionToClarifyInput", () => {
  it("maps the SDK shape onto a renderable clarify envelope", () => {
    const raw = askUserQuestionToClarifyInput(SDK_INPUT);
    expect(raw).not.toBeNull();
    const built = buildClarifyEnvelope({ agentSlug: "operator", rawInput: raw! });
    expect(built.degraded).toBe(false);
    expect(built.envelope.envelope_kind).toBe("clarifying_questions");
    expect(built.envelope.questions).toHaveLength(1);
    expect(built.envelope.questions[0].options.map((o) => o.label)).toEqual([
      "#all-general",
      "#content-updates",
    ]);
  });

  it("always leaves a free-form escape hatch — the model's options are a guess", () => {
    const raw = askUserQuestionToClarifyInput(SDK_INPUT)!;
    expect((raw.questions as Array<{ allow_other: boolean }>)[0].allow_other).toBe(true);
  });

  it("never pre-selects a model-authored option (no prefill/provenance)", () => {
    const raw = askUserQuestionToClarifyInput(SDK_INPUT)!;
    const opts = (raw.questions as Array<{ options: Array<Record<string, unknown>> }>)[0].options;
    for (const o of opts) {
      expect(o.prefill).toBeUndefined();
      expect(o.provenance).toBeUndefined();
    }
  });

  it("asks for free text when the model offered no options", () => {
    const raw = askUserQuestionToClarifyInput({ questions: [{ question: "What is the CTA URL?" }] })!;
    const q = (raw.questions as Array<{ type: string; options: unknown[] }>)[0];
    expect(q.type).toBe("text");
    expect(q.options).toEqual([]);
  });

  it("marks a multi-select question as multi", () => {
    const raw = askUserQuestionToClarifyInput({
      questions: [{ question: "Which platforms?", multiSelect: true, options: [{ label: "TikTok" }] }],
    })!;
    expect((raw.questions as Array<{ type: string }>)[0].type).toBe("multi");
  });

  it("returns null when there is nothing askable — caller then leaves the tool alone", () => {
    expect(askUserQuestionToClarifyInput(null)).toBeNull();
    expect(askUserQuestionToClarifyInput({})).toBeNull();
    expect(askUserQuestionToClarifyInput({ questions: [] })).toBeNull();
    expect(askUserQuestionToClarifyInput({ questions: [{ question: "   " }] })).toBeNull();
  });

  it("caps runaway payloads", () => {
    const raw = askUserQuestionToClarifyInput({
      questions: Array.from({ length: 9 }, (_, i) => ({
        question: `q${i}`,
        options: Array.from({ length: 9 }, (_, j) => ({ label: `o${j}` })),
      })),
    })!;
    const qs = raw.questions as Array<{ options: unknown[] }>;
    expect(qs.length).toBeLessThanOrEqual(4);
    expect(qs[0].options.length).toBeLessThanOrEqual(4);
  });

  it("tells the model the ask landed, so it stops instead of retyping the question", () => {
    expect(ASK_USER_QUESTION_DENY_MESSAGE).toMatch(/do NOT repeat the question/i);
    expect(ASK_USER_QUESTION_DENY_MESSAGE).toMatch(/End your turn/i);
  });
});
