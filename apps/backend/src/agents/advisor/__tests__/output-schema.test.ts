import { describe, it, expect } from "vitest";
import { adviceSchema } from "../output-schema";

function envelope(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    diagnosis: {
      stage: "pre-launch" as const,
      goal_restated: "test goal",
      key_signals: [],
    },
    research_findings: [],
    recommendations: {
      decide_today: [],
      next_30d: [],
      watch_for: [],
    },
    dispatch_proposals: [],
    clarifications_needed: false as const,
    rendered_markdown: "x",
    ...overrides,
  };
}

describe("advisor output-schema rationale + summary caps (post-C9)", () => {
  it("accepts a 1200-char rationale (was the gate-failure shape)", () => {
    const long = "x".repeat(1200);
    const env = envelope({
      recommendations: {
        decide_today: [
          {
            title: "t",
            rationale: long,
            evidence_refs: [],
            estimated_impact: "",
            confidence: "inference",
            disconfirming_signal: "s",
          },
        ],
        next_30d: [],
        watch_for: [],
        lead_priority: "Ship the wedge",
      },
    });
    const r = adviceSchema.safeParse(env);
    expect(r.success).toBe(true);
  });

  it("rejects a 1201-char rationale (cap is hard at 1200)", () => {
    const tooLong = "x".repeat(1201);
    const env = envelope({
      recommendations: {
        decide_today: [
          {
            title: "t",
            rationale: tooLong,
            evidence_refs: [],
            estimated_impact: "",
            confidence: "inference",
            disconfirming_signal: "s",
          },
        ],
        next_30d: [],
        watch_for: [],
        lead_priority: "Ship the wedge",
      },
    });
    const r = adviceSchema.safeParse(env);
    expect(r.success).toBe(false);
  });

  it("accepts a 1200-char research_findings[].summary", () => {
    const long = "x".repeat(1200);
    const env = envelope({
      research_findings: [
        {
          topic: "operator_data" as const,
          summary: long,
          evidence: [],
        },
      ],
    });
    const r = adviceSchema.safeParse(env);
    expect(r.success).toBe(true);
  });

  it("rejects a 1201-char summary (cap is hard at 1200)", () => {
    const tooLong = "x".repeat(1201);
    const env = envelope({
      research_findings: [
        {
          topic: "operator_data" as const,
          summary: tooLong,
          evidence: [],
        },
      ],
    });
    const r = adviceSchema.safeParse(env);
    expect(r.success).toBe(false);
  });
});

describe("advisor Phase-1 structured fields", () => {
  it("1.1a rejects a decide_today item missing confidence", () => {
    const env = envelope({
      recommendations: {
        decide_today: [
          {
            title: "t",
            rationale: "r",
            evidence_refs: [],
            estimated_impact: "",
            disconfirming_signal: "s",
          },
        ],
        next_30d: [],
        watch_for: [],
        lead_priority: "Ship the wedge",
      },
    });
    expect(adviceSchema.safeParse(env).success).toBe(false);
  });

  it("1.1b rejects a decide_today item missing disconfirming_signal", () => {
    const env = envelope({
      recommendations: {
        decide_today: [
          {
            title: "t",
            rationale: "r",
            evidence_refs: [],
            estimated_impact: "",
            confidence: "inference",
          },
        ],
        next_30d: [],
        watch_for: [],
        lead_priority: "Ship the wedge",
      },
    });
    expect(adviceSchema.safeParse(env).success).toBe(false);
  });

  it("1.1c accepts a well-formed decide_today item", () => {
    const env = envelope({
      recommendations: {
        decide_today: [
          {
            title: "t",
            rationale: "r",
            evidence_refs: [],
            estimated_impact: "",
            confidence: "inference",
            disconfirming_signal: "churn ticks up",
          },
        ],
        next_30d: [],
        watch_for: [],
        lead_priority: "Ship onboarding fix",
      },
    });
    expect(adviceSchema.safeParse(env).success).toBe(true);
  });

  it("1.1d next_30d item requires confidence but NOT disconfirming_signal", () => {
    const env = envelope({
      recommendations: {
        decide_today: [],
        next_30d: [
          {
            title: "t",
            rationale: "r",
            evidence_refs: [],
            estimated_impact: "",
            confidence: "evidence_grounded",
          },
        ],
        watch_for: [],
      },
    });
    expect(adviceSchema.safeParse(env).success).toBe(true);
  });

  it("1.2a rejects non-empty decide_today with blank lead_priority", () => {
    const env = envelope({
      recommendations: {
        decide_today: [
          {
            title: "t",
            rationale: "r",
            evidence_refs: [],
            estimated_impact: "",
            confidence: "inference",
            disconfirming_signal: "x",
          },
        ],
        next_30d: [],
        watch_for: [],
        lead_priority: "",
      },
    });
    expect(adviceSchema.safeParse(env).success).toBe(false);
  });

  it("1.2b accepts empty decide_today with omitted lead_priority", () => {
    const env = envelope();
    expect(adviceSchema.safeParse(env).success).toBe(true);
  });

  it("1.3a accepts optional dissent", () => {
    const env = envelope({
      dissent: { what_not_to_do: "Don't rebrand", why: "No demand signal" },
    });
    expect(adviceSchema.safeParse(env).success).toBe(true);
  });

  it("1.3b rejects malformed dissent missing why", () => {
    const env = envelope({
      dissent: { what_not_to_do: "x" },
    });
    expect(adviceSchema.safeParse(env).success).toBe(false);
  });

  const UUID = "11111111-1111-4111-8111-111111111111";

  it("P0-1 defaults close_recommendations to [] when omitted", () => {
    const env = envelope();
    const parsed = adviceSchema.safeParse(env);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.close_recommendations).toEqual([]);
  });

  it("P0-1 accepts + round-trips valid close_recommendations", () => {
    const env = envelope({
      close_recommendations: [
        { id: UUID, status: "acted", reason: "operator shipped it" },
        { id: "22222222-2222-4222-8222-222222222222", status: "stale" },
      ],
    });
    const parsed = adviceSchema.safeParse(env);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.close_recommendations).toHaveLength(2);
      expect(parsed.data.close_recommendations[0]).toEqual({
        id: UUID,
        status: "acted",
        reason: "operator shipped it",
      });
    }
  });

  it("P0-1 rejects a non-UUID close id", () => {
    const env = envelope({
      close_recommendations: [{ id: "not-a-uuid", status: "acted" }],
    });
    expect(adviceSchema.safeParse(env).success).toBe(false);
  });

  it("P0-1 rejects an invalid close status (not acted/rejected/stale)", () => {
    const env = envelope({
      close_recommendations: [{ id: UUID, status: "open" }],
    });
    expect(adviceSchema.safeParse(env).success).toBe(false);
  });
});

describe("advisor output-schema — explicit-null tolerance on optional fields", () => {
  const UUID = "11111111-1111-4111-8111-111111111111";
  it("accepts dissent: null and normalizes it to undefined (was the parse_failed)", () => {
    const r = adviceSchema.safeParse(envelope({ dissent: null }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.dissent).toBeUndefined();
  });

  it("accepts recommendations.lead_priority: null (empty decide_today) → undefined", () => {
    const r = adviceSchema.safeParse(
      envelope({
        recommendations: { decide_today: [], next_30d: [], watch_for: [], lead_priority: null },
      }),
    );
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.recommendations.lead_priority).toBeUndefined();
  });

  it("accepts close_recommendations[].reason: null → undefined", () => {
    const r = adviceSchema.safeParse(
      envelope({ close_recommendations: [{ id: UUID, status: "acted", reason: null }] }),
    );
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.close_recommendations[0].reason).toBeUndefined();
  });

  it("still rejects a malformed dissent OBJECT (null tolerance didn't weaken validation)", () => {
    const r = adviceSchema.safeParse(envelope({ dissent: { what_not_to_do: "x" } }));
    expect(r.success).toBe(false);
  });

  it("still enforces lead_priority required when decide_today is non-empty (null ≠ bypass)", () => {
    const r = adviceSchema.safeParse(
      envelope({
        recommendations: {
          decide_today: [{ title: "t", rationale: "r", evidence_refs: [] }],
          next_30d: [],
          watch_for: [],
          lead_priority: null,
        },
      }),
    );
    expect(r.success).toBe(false);
  });
});
