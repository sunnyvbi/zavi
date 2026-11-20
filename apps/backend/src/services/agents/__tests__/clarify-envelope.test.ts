import { describe, it, expect } from "vitest";
import {
  buildClarifyEnvelope,
  fromLegacyStringQuestions,
  synthesizeClarifyMarkdown,
  clarifyEnvelopeSchema,
  CLARIFY_ENVELOPE_KIND,
  CLARIFY_SCHEMA_VERSION,
} from "../clarify-envelope";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validRaw = {
  agent_slug: "pm",
  intro: "A couple of things before I draft the GTM.",
  questions: [
    {
      id: "side",
      text: "Which side gets the subscription?",
      header: "Side",
      why: "Defines the pricing ceiling.",
      type: "single",
      options: [
        { id: "drivers", label: "Drivers", recommended: true },
        { id: "hosts", label: "Hosts" },
        { id: "both", label: "Both" },
      ],
      allow_other: true,
    },
  ],
};

describe("buildClarifyEnvelope — happy path", () => {
  it("validates a well-formed payload and server-stamps a uuid request_id", () => {
    const { envelope, degraded } = buildClarifyEnvelope({
      agentSlug: "pm",
      rawInput: validRaw,
    });
    expect(degraded).toBe(false);
    expect(envelope.envelope_kind).toBe(CLARIFY_ENVELOPE_KIND);
    expect(envelope.schema_version).toBe(CLARIFY_SCHEMA_VERSION);
    expect(envelope.request_id).toMatch(UUID_RE);
    expect(envelope.questions).toHaveLength(1);
    expect(envelope.questions[0].options).toHaveLength(3);
  });

  it("OVERWRITES any model-supplied request_id (trust boundary)", () => {
    const { envelope } = buildClarifyEnvelope({
      agentSlug: "pm",
      rawInput: { ...validRaw, request_id: "not-a-real-uuid-from-llm" },
    });
    expect(envelope.request_id).toMatch(UUID_RE);
    expect(envelope.request_id).not.toBe("not-a-real-uuid-from-llm");
  });

  it("forces agent_slug to the server-provided value, ignoring the model's", () => {
    const { envelope } = buildClarifyEnvelope({
      agentSlug: "engineer",
      rawInput: { ...validRaw, agent_slug: "spoofed" },
    });
    expect(envelope.agent_slug).toBe("engineer");
  });

  it("each build gets a fresh request_id", () => {
    const a = buildClarifyEnvelope({ agentSlug: "x", rawInput: validRaw });
    const b = buildClarifyEnvelope({ agentSlug: "x", rawInput: validRaw });
    expect(a.envelope.request_id).not.toBe(b.envelope.request_id);
  });
});

describe("buildClarifyEnvelope — degrade-to-free-form on invalid input", () => {
  it("degrades a malformed payload to a valid free-form envelope (never a broken card)", () => {
    const { envelope, degraded } = buildClarifyEnvelope({
      agentSlug: "performance-marketer",
      rawInput: {
        questions: [
          { text: "What is the weekly budget cap?" },
          "Which campaigns count as bay-area?",
        ],
      },
    });
    expect(degraded).toBe(true);
    expect(clarifyEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.questions.every((q) => q.type === "text")).toBe(true);
    expect(envelope.questions[0].allow_other).toBe(true);
    expect(envelope.questions.map((q) => q.text).join(" ")).toContain("budget");
  });

  it("sanitizes an over-long intro on the degrade path (codex-P1 — always schema-valid)", () => {
    const { envelope, degraded } = buildClarifyEnvelope({
      agentSlug: "x",
      rawInput: {
        intro: "z".repeat(5000),
        questions: [{ text: "Real question?" }],
      },
    });
    expect(degraded).toBe(true);
    expect((envelope.intro ?? "").length).toBeLessThanOrEqual(600);
    expect(clarifyEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("guarantees ≥1 question even from empty/garbage input", () => {
    const { envelope, degraded } = buildClarifyEnvelope({
      agentSlug: "x",
      rawInput: { questions: [] },
    });
    expect(degraded).toBe(true);
    expect(envelope.questions.length).toBeGreaterThanOrEqual(1);
    expect(clarifyEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("rejects an over-long header at validation, then degrades cleanly", () => {
    const { envelope, degraded } = buildClarifyEnvelope({
      agentSlug: "x",
      rawInput: {
        questions: [
          {
            id: "q1",
            text: "Pick one",
            header: "WAY-too-long-header-chip",
            type: "single",
            options: [{ id: "a", label: "A" }],
            allow_other: true,
          },
        ],
      },
    });
    expect(degraded).toBe(true);
    expect(clarifyEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe("fromLegacyStringQuestions — back-compat", () => {
  it("turns a legacy string[] into a valid free-form envelope", () => {
    const { envelope, degraded } = fromLegacyStringQuestions("pm", [
      "What does the subscription include?",
      "What's the monthly price point?",
    ]);
    expect(degraded).toBe(false);
    expect(clarifyEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.questions).toHaveLength(2);
    expect(envelope.questions.every((q) => q.type === "text")).toBe(true);
    expect(envelope.request_id).toMatch(UUID_RE);
  });

  it("caps at 5 questions", () => {
    const { envelope } = fromLegacyStringQuestions(
      "x",
      Array.from({ length: 9 }, (_, i) => `Question ${i}`),
    );
    expect(envelope.questions.length).toBeLessThanOrEqual(5);
  });

  it("drops empty strings", () => {
    const { envelope } = fromLegacyStringQuestions("x", ["", "  ", "real one"]);
    expect(envelope.questions).toHaveLength(1);
    expect(envelope.questions[0].text).toBe("real one");
  });
});

describe("synthesizeClarifyMarkdown", () => {
  it("renders a numbered list with the intro line", () => {
    const { envelope } = buildClarifyEnvelope({
      agentSlug: "pm",
      rawInput: validRaw,
    });
    const md = synthesizeClarifyMarkdown(envelope);
    expect(md).toContain("A couple of things");
    expect(md).toContain("1. Which side gets the subscription?");
  });

  it("falls back to a default intro when none given", () => {
    const { envelope } = fromLegacyStringQuestions("x", ["Q?"]);
    expect(synthesizeClarifyMarkdown(envelope)).toContain(
      "I need a few details",
    );
  });
});
