import { describe, it, expect } from "vitest";
import { supportTriageSchema } from "../output-schema";

function card(overrides: Record<string, unknown> = {}) {
  return {
    signal_ref: "ticket-1234",
    class: "support" as const,
    severity: "P1" as const,
    next_step: "no_op" as const,
    specialist_slug: null,
    evidence: ["ticket-1234", "2026-06-02T10:00:00Z"],
    confidence: 0.8,
    ...overrides,
  };
}

describe("supportTriageSchema", () => {
  it("accepts a valid full card + rendered_markdown", () => {
    const r = supportTriageSchema.safeParse({
      rendered_markdown: "P1 — feature broken for host #42",
      cards: [card()],
    });
    expect(r.success).toBe(true);
  });

  it("(1B) rejects a card missing severity", () => {
    const { severity, ...noSeverity } = card();
    const r = supportTriageSchema.safeParse({
      rendered_markdown: "x",
      cards: [noSeverity],
    });
    expect(r.success).toBe(false);
  });

  it("(1D/1B) rejects route_specialist with a null specialist_slug", () => {
    const r = supportTriageSchema.safeParse({
      rendered_markdown: "x",
      cards: [card({ next_step: "route_specialist", specialist_slug: null })],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const hit = r.error.issues.some((i) =>
        i.path.includes("specialist_slug"),
      );
      expect(hit).toBe(true);
    }
  });

  it("(1D) accepts route_specialist with a named specialist_slug", () => {
    const r = supportTriageSchema.safeParse({
      rendered_markdown: "x",
      cards: [
        card({ next_step: "route_specialist", specialist_slug: "dispute-response" }),
      ],
    });
    expect(r.success).toBe(true);
  });

  it("(1C/1B) rejects confidence 0.59 + auto_resolve", () => {
    const r = supportTriageSchema.safeParse({
      rendered_markdown: "x",
      cards: [card({ next_step: "auto_resolve", confidence: 0.59 })],
    });
    expect(r.success).toBe(false);
  });

  it("(1C/1B) accepts confidence 0.6 + auto_resolve (boundary)", () => {
    const r = supportTriageSchema.safeParse({
      rendered_markdown: "x",
      cards: [card({ next_step: "auto_resolve", confidence: 0.6 })],
    });
    expect(r.success).toBe(true);
  });

  it("rejects an empty evidence[] on a claim card", () => {
    const r = supportTriageSchema.safeParse({
      rendered_markdown: "x",
      cards: [card({ evidence: [] })],
    });
    expect(r.success).toBe(false);
  });

  it("(§0.2 fallback safety) accepts { rendered_markdown } with NO cards and defaults cards to []", () => {
    const r = supportTriageSchema.safeParse({
      rendered_markdown: "prose-fallback rescue text",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.cards).toEqual([]);
    }
  });

  it("the confidence gate only blocks auto_resolve, not route_specialist", () => {
    const r = supportTriageSchema.safeParse({
      rendered_markdown: "x",
      cards: [
        card({
          next_step: "route_specialist",
          specialist_slug: "engineer",
          confidence: 0.4,
        }),
      ],
    });
    expect(r.success).toBe(true);
  });
});
