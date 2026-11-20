
import { describe, it, expect } from "vitest";
import { selectRenderedText } from "../render-select";
import { CLARIFY_ENVELOPE_KIND } from "../clarify-envelope";

const STUB_RE = /run completed — see Runs tab for details/;

describe("selectRenderedText — non-stub regression (Move #2)", () => {
  it("returns a real advisor rendered_markdown verbatim (not the stub)", () => {
    const rm = "## Decide today\n\n1. Ship the onboarding wedge — it gates activation.";
    const sel = selectRenderedText({
      envelope: "advice",
      agentSlug: "advisor",
      parsed: { rendered_markdown: rm },
      rawText: `<advice>{"rendered_markdown":"..."}</advice>`,
    });
    expect(sel.text).toBe(rm);
    expect(sel.text).not.toMatch(STUB_RE);
  });

  it("returns a real performance-marketer digest verbatim (the <digest> regression surface)", () => {
    const rm = "## Funnel diagnosis\n\nCAC up 12% WoW; pause the underperforming ad set.";
    const sel = selectRenderedText({
      envelope: "digest",
      agentSlug: "performance-marketer",
      parsed: { rendered_markdown: rm, machine_digest: "## Tier 1\n..." },
      rawText: `<digest>...</digest>`,
    });
    expect(sel.text).toBe(rm);
    expect(sel.text).not.toMatch(STUB_RE);
  });

  it("a clarifying-questions envelope renders clarify text, NOT the stub (research async-clarification class)", () => {
    const sel = selectRenderedText({
      envelope: "research_report",
      agentSlug: "research",
      parsed: {
        envelope_kind: CLARIFY_ENVELOPE_KIND,
        questions: [{ text: "Which competitor set should I benchmark against?" }],
      },
      rawText: "<research_report>...</research_report>",
    });
    expect(sel.text.trim().length).toBeGreaterThan(0);
    expect(sel.text).not.toMatch(STUB_RE);
    expect(sel.clarifyEnvelope).toBeTruthy();
  });

  it("the stub is reached ONLY on the genuinely-empty path (sentinel boundary lock)", () => {
    const sel = selectRenderedText({
      envelope: "advice",
      agentSlug: "advisor",
      parsed: { some_unparsed_field: true },
      rawText: "<advice></advice>",
    });
    expect(sel.text).toMatch(STUB_RE);
  });
});
