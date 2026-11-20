import { describe, it, expect } from "vitest";
import { fundraisingEnvelopeSchema } from "../output-schema";

const LEGACY_SOURCE_BLOCK = {
  stage: "Pre-seed",
  stage_rationale: "Pre-revenue with a sharp wedge -> pre-seed micro-VCs.",
  investors: [
    {
      firm: "Acme Ventures",
      name: "Jane Partner",
      tier: 1,
      focus: "B2B SaaS / dev tools",
      stage_focus: "pre-seed / seed",
      check_size: "$250k-$1M",
      fit_rationale: "Thesis is dev-infra at seed; backed two adjacent companies.",
      contact_hint: "acme.vc / @acmevc",
      suggested_message: "Short, sourced outreach note.",
      source: "investor_db",
    },
  ],
  rendered_markdown: "## Pre-seed list\n\nTier 1: Acme Ventures",
};

const STRATEGY_BLOCK = {
  ...LEGACY_SOURCE_BLOCK,
  mode: "strategy",
  investors: [
    {
      firm: "Acme Ventures",
      name: "Jane Partner",
      tier: 1,
      fit_rationale: "dev-infra thesis.",
      channel_segment: "email-ready",
      copy_variants: {
        cold_email: { subject: "Quick intro", body: "Body copy." },
        followup_1: "First nudge.",
      },
      source: "investor_db",
    },
  ],
  cadence: "Day 0 cold email; Day 5 follow-up 1.",
  rollout_plan: "Wave 1: Tier-1 email-ready.",
};

describe("fundraising envelope — additive legacy compatibility (invariant c)", () => {
  it("parses a legacy source block unchanged (no mode, no advice)", () => {
    const r = fundraisingEnvelopeSchema.safeParse(LEGACY_SOURCE_BLOCK);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mode).toBeUndefined();
      expect(r.data.advice).toBeUndefined();
      expect(r.data.investors).toHaveLength(1);
    }
  });

  it("parses a strategy block unchanged", () => {
    const r = fundraisingEnvelopeSchema.safeParse(STRATEGY_BLOCK);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mode).toBe("strategy");
      expect(r.data.advice).toBeUndefined();
    }
  });
});

describe("fundraising envelope — advise block (Slice 3)", () => {
  it("parses a readiness advise block with a grounded dimension", () => {
    const block = {
      investors: [],
      mode: "advise",
      advice: {
        topic: "readiness",
        readiness: [
          {
            key: "retention",
            status: "good",
            verdict: "Strong month-2 retention per the brain.",
            basis: "brain",
            source_ref: "brain: cohort retention note",
          },
        ],
        dos: ["Lead with retention."],
        donts: ["Do not overstate revenue."],
      },
      rendered_markdown: "## Readiness\n\nRetention looks strong.",
    };
    const r = fundraisingEnvelopeSchema.safeParse(block);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mode).toBe("advise");
      expect(r.data.advice?.topic).toBe("readiness");
      expect(r.data.advice?.readiness?.[0]?.basis).toBe("brain");
    }
  });

  it("parses a revenue GAP dimension carrying NO number (invariant a)", () => {
    const block = {
      investors: [],
      mode: "advise",
      advice: {
        topic: "readiness",
        readiness: [
          {
            key: "revenue",
            status: "gap",
            verdict:
              "No MRR in the brain. When an investor asks, give the real number out loud or say you're pre-revenue.",
            basis: "brain",
            source_ref: "brain: no revenue metric found",
          },
        ],
      },
      rendered_markdown: "## Readiness\n\nRevenue is an honest gap.",
    };
    const r = fundraisingEnvelopeSchema.safeParse(block);
    expect(r.success).toBe(true);
    if (r.success) {
      const rev = r.data.advice?.readiness?.find((d) => d.key === "revenue");
      expect(rev?.status).toBe("gap");
      expect(rev?.verdict ?? "").not.toMatch(/\$\s?\d/);
    }
  });

  it("parses a round_design advise block", () => {
    const block = {
      investors: [],
      mode: "advise",
      advice: {
        topic: "round_design",
        round_design: {
          ask: "$750k",
          verdict: "Raise a pre-seed to 18 months of runway.",
          basis: "playbook",
          source_ref: "",
        },
      },
      rendered_markdown: "## Round design\n\nRaise $750k.",
    };
    expect(fundraisingEnvelopeSchema.safeParse(block).success).toBe(true);
  });

  it("parses an advise block with `topic` OMITTED (the post-run derives it)", () => {
    const block = {
      investors: [],
      mode: "advise",
      advice: {
        readiness: [
          {
            key: "provenance",
            status: "gap",
            verdict: "Stripe Connect is not wired live, so there is nothing verifiable yet.",
            basis: "brain",
            source_ref: "brain: readiness gate",
          },
        ],
      },
      rendered_markdown: "## Readiness\n\nNot yet.",
    };
    expect(fundraisingEnvelopeSchema.safeParse(block).success).toBe(true);
  });

  it("STILL rejects an unknown topic string (optional is not 'anything goes')", () => {
    const block = {
      investors: [],
      mode: "advise",
      advice: { topic: "vibes", readiness: [] },
      rendered_markdown: "## Nope",
    };
    expect(fundraisingEnvelopeSchema.safeParse(block).success).toBe(false);
  });

  it("REJECTS an advice item missing `basis` (truthfulness enforced by the type system, invariant b)", () => {
    const block = {
      investors: [],
      mode: "advise",
      advice: {
        topic: "readiness",
        readiness: [
          {
            key: "revenue",
            status: "good",
            verdict: "ARR is trending up nicely.",
            source_ref: "somewhere",
          },
        ],
      },
      rendered_markdown: "## Readiness",
    };
    expect(fundraisingEnvelopeSchema.safeParse(block).success).toBe(false);
  });

  it("REJECTS a round_design missing `basis`", () => {
    const block = {
      investors: [],
      mode: "advise",
      advice: {
        topic: "round_design",
        round_design: { ask: "$750k", verdict: "Raise a pre-seed." },
      },
      rendered_markdown: "## Round design",
    };
    expect(fundraisingEnvelopeSchema.safeParse(block).success).toBe(false);
  });
});

describe("one bad prose field never discards the envelope", () => {
  it("an absent fit_rationale no longer takes out every investor", () => {
    const block = {
      ...LEGACY_SOURCE_BLOCK,
      investors: [
        { ...LEGACY_SOURCE_BLOCK.investors[0], fit_rationale: undefined },
        { ...LEGACY_SOURCE_BLOCK.investors[0], firm: "Beta Fund" },
      ],
    };
    const parsed = fundraisingEnvelopeSchema.safeParse(block);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.investors).toHaveLength(2);
    expect(parsed.success && parsed.data.investors[0].fit_rationale).toBe("");
    expect(parsed.success && parsed.data.investors[1].firm).toBe("Beta Fund");
  });

  it("an explicit null fit_rationale is tolerated the same way", () => {
    const block = {
      ...LEGACY_SOURCE_BLOCK,
      investors: [{ ...LEGACY_SOURCE_BLOCK.investors[0], fit_rationale: null }],
    };
    expect(fundraisingEnvelopeSchema.safeParse(block).success).toBe(true);
  });

  it("still fails loudly on a real truth field — tier is NOT tolerated", () => {
    const block = {
      ...LEGACY_SOURCE_BLOCK,
      investors: [{ ...LEGACY_SOURCE_BLOCK.investors[0], tier: 9 }],
    };
    expect(fundraisingEnvelopeSchema.safeParse(block).success).toBe(false);
  });
});
