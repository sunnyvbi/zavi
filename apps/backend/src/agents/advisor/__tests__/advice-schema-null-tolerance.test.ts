
import { describe, it, expect } from "vitest";
import { adviceSchema } from "../output-schema";

function envelope(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    diagnosis: { stage: "growth" as const, goal_restated: "g", key_signals: [] },
    research_findings: [],
    recommendations: { decide_today: [], next_30d: [], watch_for: [] },
    dispatch_proposals: [],
    clarifications_needed: false as const,
    rendered_markdown: "x",
    ...overrides,
  };
}

describe("advisor adviceSchema — explicit-null tolerance (parse_failed regression)", () => {
  it("accepts an explicit null lead_priority (empty decide_today)", () => {
    const r = adviceSchema.safeParse(
      envelope({ recommendations: { decide_today: [], next_30d: [], watch_for: [], lead_priority: null } }),
    );
    expect(r.success).toBe(true);
  });

  it("accepts an explicit null dissent", () => {
    const r = adviceSchema.safeParse(envelope({ dissent: null }));
    expect(r.success).toBe(true);
  });

  it("accepts an explicit null clarifications_needed.reason", () => {
    const r = adviceSchema.safeParse(
      envelope({ clarifications_needed: { questions: ["Which segment?"], reason: null } }),
    );
    expect(r.success).toBe(true);
  });

  it("all three nulls at once still parse (the full census-edd12957 shape)", () => {
    const r = adviceSchema.safeParse(
      envelope({
        recommendations: { decide_today: [], next_30d: [], watch_for: [], lead_priority: null },
        dissent: null,
      }),
    );
    expect(r.success).toBe(true);
  });

  it("accepts a max-length (20000) rendered_markdown; over-cap fails", () => {
    expect(adviceSchema.safeParse(envelope({ rendered_markdown: "x".repeat(20000) })).success).toBe(true);
    expect(adviceSchema.safeParse(envelope({ rendered_markdown: "x".repeat(20001) })).success).toBe(false);
  });
});
