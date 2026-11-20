import { describe, it, expect } from "vitest";
import { coerceEnvelope } from "../envelope-coerce";
import { prProposalModelOutputSchema } from "@/agents/engineer/output-schema";
import { adviceSchema } from "@/agents/advisor/output-schema";

describe("coerceEnvelope", () => {
  it("truncates an over-cap cto title to exactly the cap and notes it (the 957065b6 incident)", () => {
    const title =
      "legal(tos): swap FairClaims → New Era ADR + add pre-arbitration notice, severability, and challengeable damage determination";
    expect(title.length).toBeGreaterThan(120);
    const { value, notes } = coerceEnvelope("engineer", { title });
    const coercedTitle = (value as { title: string }).title;
    expect(coercedTitle.length).toBe(118);
    expect(coercedTitle.length).toBeLessThanOrEqual(120);
    expect(coercedTitle.endsWith("…")).toBe(true);
    expect(notes).toContain("title auto-shortened to 120 chars");
  });

  it("makes a previously-rejected full pr_proposal validate after coercion", () => {
    const longTitle = "x".repeat(124);
    const raw = {
      repo: "rravi149/upcar",
      base_branch: "main",
      head_branch: "engineer/tos-update",
      title: longTitle,
      body: "ok",
      rendered_markdown: "## Plan\nDoes a thing.",
      risk_class: "low",
      test_results: { passed: 0, failed: 0, output_tail: "" },
    };
    expect(prProposalModelOutputSchema.safeParse(raw).success).toBe(false);
    const { value } = coerceEnvelope("engineer", raw);
    const after = prProposalModelOutputSchema.safeParse(value);
    expect(after.success).toBe(true);
  });

  it("is a no-op for in-cap fields and leaves the original object identity", () => {
    const raw = { title: "short", body: "fine" };
    const { value, notes } = coerceEnvelope("engineer", raw);
    expect(notes).toEqual([]);
    expect(value).toBe(raw);
  });

  it("does NOT coerce non-display fields (branch names / enums must still fail loudly)", () => {
    const raw = {
      title: "fine",
      head_branch: "x".repeat(200),
      risk_class: "bogus-enum",
    };
    const { value, notes } = coerceEnvelope("engineer", raw);
    expect((value as { head_branch: string }).head_branch.length).toBe(200);
    expect((value as { risk_class: string }).risk_class).toBe("bogus-enum");
    expect(notes).toEqual([]);
  });

  it("is a no-op for agents without a coercion map", () => {
    const raw = { title: "x".repeat(500) };
    const { value, notes } = coerceEnvelope("chief-of-staff", raw);
    expect(value).toBe(raw);
    expect(notes).toEqual([]);
  });
});

describe("coerceEnvelope — pm empty strategy placeholder", () => {
  it("drops the semantically empty strategy object emitted on a delivery response", () => {
    const raw = {
      status: "actionable",
      strategy: {
        premise_check: "",
        reframe_options: [],
        research_findings: [],
        clarifications_needed: false,
      },
    };

    const { value, notes } = coerceEnvelope("pm", raw);

    expect(value).not.toHaveProperty("strategy");
    expect(notes).toContain(
      "strategy omitted (model emitted an empty delivery-mode placeholder)",
    );
    expect(raw).toHaveProperty("strategy");
  });

  it("preserves non-empty strategy data so the authoritative schema still rejects mode mixing", () => {
    const raw = {
      status: "actionable",
      strategy: {
        premise_check: "This changes the product direction.",
        reframe_options: [],
        research_findings: [],
        clarifications_needed: false,
      },
    };

    const { value, notes } = coerceEnvelope("pm", raw);

    expect(value).toBe(raw);
    expect(notes).toEqual([]);
  });
});

describe("coerceEnvelope — advisor nested-path coercion (2026-05-28 parse_failed fix)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function advice(overrides: Record<string, unknown> = {}): any {
    return {
      diagnosis: { stage: "growth", goal_restated: "g", key_signals: [] },
      research_findings: [],
      recommendations: { decide_today: [], next_30d: [], watch_for: [] },
      dispatch_proposals: [],
      clarifications_needed: false,
      rendered_markdown: "x",
      ...overrides,
    };
  }

  it("truncates an over-cap estimated_impact nested in decide_today[] (the real failure field)", () => {
    const raw = advice({
      recommendations: {
        decide_today: [
          {
            title: "t",
            rationale: "r",
            evidence_refs: [],
            estimated_impact: "x".repeat(1260),
            confidence: "inference",
            disconfirming_signal: "s",
          },
        ],
        next_30d: [],
        watch_for: [],
        lead_priority: "Ship the wedge",
      },
    });
    expect(adviceSchema.safeParse(raw).success).toBe(false);
    const { value, notes } = coerceEnvelope("advisor", raw);
    const ei = (value as typeof raw).recommendations.decide_today[0]
      .estimated_impact;
    expect(ei.length).toBeLessThanOrEqual(1200);
    expect(ei.endsWith("…")).toBe(true);
    expect(notes.length).toBeGreaterThan(0);
    expect(adviceSchema.safeParse(value).success).toBe(true);
  });

  it("truncates over-cap watch_for trigger/what_to_do and key_signals[]", () => {
    const raw = advice({
      diagnosis: {
        stage: "scale",
        goal_restated: "g",
        key_signals: ["x".repeat(660)],
      },
      recommendations: {
        decide_today: [],
        next_30d: [],
        watch_for: [
          { trigger: "x".repeat(660), what_to_do: "y".repeat(660) },
        ],
      },
    });
    expect(adviceSchema.safeParse(raw).success).toBe(false);
    const { value } = coerceEnvelope("advisor", raw);
    const v = value as typeof raw;
    expect(v.diagnosis.key_signals[0].length).toBeLessThanOrEqual(600);
    expect(v.recommendations.watch_for[0].trigger.length).toBeLessThanOrEqual(
      600,
    );
    expect(
      v.recommendations.watch_for[0].what_to_do.length,
    ).toBeLessThanOrEqual(600);
    expect(adviceSchema.safeParse(value).success).toBe(true);
  });

  it("does NOT clone-mutate the caller's object; coercion is on a copy", () => {
    const raw = advice({
      recommendations: {
        decide_today: [
          {
            title: "t",
            rationale: "r",
            evidence_refs: [],
            estimated_impact: "x".repeat(1260),
          },
        ],
        next_30d: [],
        watch_for: [],
      },
    });
    coerceEnvelope("advisor", raw);
    expect(raw.recommendations.decide_today[0].estimated_impact.length).toBe(
      1260,
    );
  });

  it("SAFETY: never coerces dispatch_proposals[].agent_slug — a forbidden slug must still fail loudly (INV-A7)", () => {
    const raw = advice({
      dispatch_proposals: [
        {
          agent_slug: "engineer",
          brief: "x".repeat(1300),
          why: "w",
        },
      ],
    });
    const { value } = coerceEnvelope("advisor", raw);
    const p = (value as typeof raw).dispatch_proposals[0];
    expect(p.brief.length).toBeLessThanOrEqual(1200);
    expect(p.agent_slug).toBe("engineer");
    expect(adviceSchema.safeParse(value).success).toBe(false);
  });

  it("is a no-op for an already-in-cap advisor envelope (returns original identity)", () => {
    const raw = advice({
      recommendations: {
        decide_today: [
          {
            title: "t",
            rationale: "r",
            evidence_refs: [],
            estimated_impact: "fine",
            confidence: "inference",
            disconfirming_signal: "s",
          },
        ],
        next_30d: [],
        watch_for: [{ trigger: "ok", what_to_do: "ok" }],
        lead_priority: "Ship the wedge",
      },
    });
    const { value, notes } = coerceEnvelope("advisor", raw);
    expect(value).toBe(raw);
    expect(notes).toEqual([]);
  });

  it("truncates over-cap disconfirming_signal (cap 600) so the envelope still parses", () => {
    const raw = advice({
      recommendations: {
        decide_today: [
          {
            title: "t",
            rationale: "r",
            evidence_refs: [],
            estimated_impact: "",
            confidence: "inference",
            disconfirming_signal: "x".repeat(700),
          },
        ],
        next_30d: [],
        watch_for: [],
        lead_priority: "Ship the wedge",
      },
    });
    expect(adviceSchema.safeParse(raw).success).toBe(false);
    const { value } = coerceEnvelope("advisor", raw);
    const ds = (value as typeof raw).recommendations.decide_today[0]
      .disconfirming_signal;
    expect(ds.length).toBeLessThanOrEqual(600);
    expect(ds.endsWith("…")).toBe(true);
    expect(adviceSchema.safeParse(value).success).toBe(true);
  });

  it("truncates over-cap lead_priority (cap 300) and dissent.why (cap 400)", () => {
    const raw = advice({
      recommendations: {
        decide_today: [
          {
            title: "t",
            rationale: "r",
            evidence_refs: [],
            estimated_impact: "",
            confidence: "inference",
            disconfirming_signal: "s",
          },
        ],
        next_30d: [],
        watch_for: [],
        lead_priority: "x".repeat(360),
      },
      dissent: { what_not_to_do: "stop", why: "y".repeat(460) },
    });
    expect(adviceSchema.safeParse(raw).success).toBe(false);
    const { value } = coerceEnvelope("advisor", raw);
    const v = value as typeof raw;
    expect(v.recommendations.lead_priority.length).toBeLessThanOrEqual(300);
    expect(v.dissent.why.length).toBeLessThanOrEqual(400);
    expect(adviceSchema.safeParse(value).success).toBe(true);
  });
});

describe("coerceEnvelope — advisor empty-dissent drop (2026-06-10 schema_soft_fail fix)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function advice(overrides: Record<string, unknown> = {}): any {
    return {
      diagnosis: { stage: "growth", goal_restated: "g", key_signals: [] },
      research_findings: [],
      recommendations: { decide_today: [], next_30d: [], watch_for: [] },
      dispatch_proposals: [],
      clarifications_needed: false,
      rendered_markdown: "x",
      ...overrides,
    };
  }

  it("drops a dissent whose fields are all empty strings (prod runs e2940caa/802117e4)", () => {
    const raw = advice({ dissent: { what_not_to_do: "", why: "" } });
    expect(adviceSchema.safeParse(raw).success).toBe(false);
    const { value, notes } = coerceEnvelope("advisor", raw);
    expect((value as Record<string, unknown>).dissent).toBeUndefined();
    expect(notes).toContain(
      "dissent omitted (model emitted an empty dissent object)",
    );
    expect(adviceSchema.safeParse(value).success).toBe(true);
  });

  it("drops a dissent whose fields are whitespace-only", () => {
    const raw = advice({ dissent: { what_not_to_do: "  ", why: "\n" } });
    const { value } = coerceEnvelope("advisor", raw);
    expect((value as Record<string, unknown>).dissent).toBeUndefined();
    expect(adviceSchema.safeParse(value).success).toBe(true);
  });

  it("does NOT drop a partially-filled dissent (real content must fail loudly, not vanish)", () => {
    const raw = advice({
      dissent: { what_not_to_do: "Don't rebrand", why: "" },
    });
    const { value } = coerceEnvelope("advisor", raw);
    expect((value as typeof raw).dissent).toEqual({
      what_not_to_do: "Don't rebrand",
      why: "",
    });
    expect(adviceSchema.safeParse(value).success).toBe(false);
  });

  it("does NOT touch a complete, valid dissent", () => {
    const raw = advice({
      dissent: { what_not_to_do: "Don't rebrand", why: "No demand signal" },
    });
    const { value, notes } = coerceEnvelope("advisor", raw);
    expect((value as typeof raw).dissent).toEqual({
      what_not_to_do: "Don't rebrand",
      why: "No demand signal",
    });
    expect(notes).toEqual([]);
    expect(value).toBe(raw);
  });
});

describe("coerceEnvelope — advisor null-dissent drop (2026-06-11 probe finding, run edd12957)", () => {
  it("drops dissent: null (model emits null instead of omitting the optional field)", () => {
    const raw = {
      diagnosis: { stage: "growth", goal_restated: "g", key_signals: [] },
      research_findings: [],
      recommendations: { decide_today: [], next_30d: [], watch_for: [] },
      dispatch_proposals: [],
      clarifications_needed: false,
      rendered_markdown: "x",
      dissent: null,
    };
    expect(adviceSchema.safeParse(raw).success).toBe(true);
    const { value, notes } = coerceEnvelope("advisor", raw);
    expect("dissent" in (value as Record<string, unknown>)).toBe(false);
    expect(notes).toContain(
      "dissent omitted (model emitted an empty dissent object)",
    );
    expect(adviceSchema.safeParse(value).success).toBe(true);
  });
});

describe("coerceEnvelope — pm rendered_markdown over-cap (run cf5304d4)", () => {
  it("truncates an over-16000-char pm rendered_markdown to the cap and notes it", () => {
    const md = "y".repeat(16500);
    expect(md.length).toBeGreaterThan(16000);
    const { value, notes } = coerceEnvelope("pm", { rendered_markdown: md });
    const coerced = (value as { rendered_markdown: string }).rendered_markdown;
    expect(coerced.length).toBeLessThanOrEqual(16000);
    expect(coerced.endsWith("…")).toBe(true);
    expect(notes).toContain("rendered_markdown auto-shortened to 16000 chars");
  });

  it("is a no-op for an in-cap pm rendered_markdown (original identity)", () => {
    const raw = { rendered_markdown: "## Status\nAll good." };
    const { value, notes } = coerceEnvelope("pm", raw);
    expect(value).toBe(raw);
    expect(notes).toHaveLength(0);
  });
});

describe("coerceEnvelope — research validation[].text over-cap (run 334d21cc)", () => {
  it("truncates an over-600-char validation chip text to the cap and notes it", () => {
    const longText = "z".repeat(700);
    expect(longText.length).toBeGreaterThan(600);
    const raw = {
      validation: [
        { tier: "validated", text: "ok", supporting_source_indices: [] },
        { tier: "inferred", text: longText, supporting_source_indices: [] },
      ],
    };
    const { value, notes } = coerceEnvelope("research", raw);
    const chips = (value as { validation: Array<{ text: string }> }).validation;
    expect(chips[0].text).toBe("ok");
    expect(chips[1].text.length).toBeLessThanOrEqual(600);
    expect(chips[1].text.endsWith("…")).toBe(true);
    expect(
      notes.some((n) => n.startsWith("validation[].text auto-shortened")),
    ).toBe(true);
  });

  it("SAFETY: never coerces the validation tier enum (must still fail loudly)", () => {
    const raw = {
      validation: [
        { tier: "poisoned-enum", text: "x", supporting_source_indices: [] },
      ],
    };
    const { value } = coerceEnvelope("research", raw);
    expect(
      (value as { validation: Array<{ tier: string }> }).validation[0].tier,
    ).toBe("poisoned-enum");
  });
});

describe("fundraising sourcing-list caps", () => {
  const long = (n: number) => "x".repeat(n);

  const listEnvelope = (over: Record<string, unknown> = {}) => ({
    stage: "Seed",
    investors: [
      {
        firm: "Nexus Venture Partners",
        tier: 3,
        fit_rationale: "Cross-border thesis.",
        source: "web",
        source_url: "https://nexusvp.com/team",
        evidence_text: "Nexus Venture Partners",
        evidence_span:
          "Nexus Venture Partners is a VC firm with 200 investments.",
        ...over,
      },
    ],
    rendered_markdown: "prose",
  });

  it("truncates an over-cap fit_rationale instead of losing the row", () => {
    const { value, notes } = coerceEnvelope(
      "fundraising",
      listEnvelope({ fit_rationale: long(601) }),
    );
    const inv = (value as { investors: Array<Record<string, string>> })
      .investors[0];
    expect(inv.fit_rationale.length).toBeLessThanOrEqual(600);
    expect(inv.fit_rationale.length).toBeGreaterThan(580);
    expect(inv.fit_rationale.endsWith("…")).toBe(true);
    expect(inv.firm).toBe("Nexus Venture Partners");
    expect(notes.join(" ")).toContain("fit_rationale");
  });

  it("EMPTIES an over-cap evidence_span rather than truncating it", () => {
    const { value } = coerceEnvelope(
      "fundraising",
      listEnvelope({ evidence_span: long(401) }),
    );
    const inv = (value as { investors: Array<Record<string, string>> })
      .investors[0];
    expect(inv.evidence_span).toBe("");
    expect(inv.evidence_span).not.toContain("…");
  });

  it("EMPTIES an over-cap evidence_text the same way", () => {
    const { value } = coerceEnvelope(
      "fundraising",
      listEnvelope({ evidence_text: long(601) }),
    );
    const inv = (value as { investors: Array<Record<string, string>> })
      .investors[0];
    expect(inv.evidence_text).toBe("");
  });

  it("leaves a within-cap row completely alone", () => {
    const input = listEnvelope();
    const { value, notes } = coerceEnvelope("fundraising", input);
    expect(notes).toEqual([]);
    expect(value).toBe(input);
  });

  it("coerces EVERY offending row, not just the first", () => {
    const env = {
      stage: "Seed",
      investors: [
        { firm: "A", tier: 1, fit_rationale: long(700), evidence_span: "ok" },
        { firm: "B", tier: 2, fit_rationale: "fine", evidence_span: long(500) },
      ],
      rendered_markdown: "prose",
    };
    const { value } = coerceEnvelope("fundraising", env);
    const rows = (value as { investors: Array<Record<string, string>> })
      .investors;
    expect(rows[0].fit_rationale.length).toBeLessThanOrEqual(600);
    expect(rows[0].fit_rationale.endsWith("…")).toBe(true);
    expect(rows[1].evidence_span).toBe("");
    expect(rows[1].fit_rationale).toBe("fine");
  });
});
