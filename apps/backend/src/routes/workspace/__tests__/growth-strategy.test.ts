import { describe, it, expect } from "vitest";
import { CHANNELS } from "@zavi/shared";
import { intakeStarted, projectStrategy } from "../growth-strategy";

const FULL = {
  north_star: { metric: "activation_rate", why: "signups stall", provenance: "funnel" },
  constraint: {
    statement: "Activation is binding",
    lever_family: "activation",
    evidence: "step 3 drop",
    confidence: "high",
  },
  channel_bets: [
    { channel_slug: "seo", rationale: "compounding", expected_effect: "signups" },
  ],
  goal: {
    objective: "Lift activation",
    target_metric: "activation_rate",
    target_value: 40,
    due_date: "2026-12-31",
  },
  gaps: ["budget?"],
  unmeasured: [{ lever: "churn", the_one_read_that_would_size_it: "Stripe" }],
};

describe("intakeStarted", () => {
  it("is false for a tenant with no note and no metadata", () => {
    expect(intakeStarted(null)).toBe(false);
    expect(intakeStarted({})).toBe(false);
  });

  it("is false when the interview exists but nothing was recorded", () => {
    expect(intakeStarted({ interview: {} })).toBe(false);
    expect(intakeStarted({ interview: { answers: {} } })).toBe(false);
  });

  it("is true after a single answer", () => {
    expect(intakeStarted({ interview: { answers: { metric: "signups" } } })).toBe(true);
  });

  it("is true after an explicit skip, with no answers at all", () => {
    expect(intakeStarted({ interview: { skipped: true } })).toBe(true);
  });

  it("treats only a real true as a skip", () => {
    expect(intakeStarted({ interview: { skipped: "yes" } })).toBe(false);
    expect(intakeStarted({ interview: { skipped: 1 } })).toBe(false);
    expect(intakeStarted({ interview: { skipped: false } })).toBe(false);
  });

  it("does not throw on junk in the metadata", () => {
    expect(intakeStarted({ interview: "nonsense" })).toBe(false);
    expect(intakeStarted({ interview: { answers: "nonsense" } })).toBe(false);
  });
});

describe("projectStrategy", () => {
  it("projects a complete strategy", () => {
    const p = projectStrategy(FULL);
    expect(p).not.toBeNull();
    expect(p!.north_star.metric).toBe("activation_rate");
    expect(p!.constraint.confidence).toBe("high");
    expect(p!.channel_bets).toHaveLength(1);
    expect(p!.goal?.target_value).toBe(40);
  });

  it("returns null without a North Star or without a constraint", () => {
    const { north_star, ...noNs } = FULL;
    const { constraint, ...noC } = FULL;
    expect(projectStrategy(noNs)).toBeNull();
    expect(projectStrategy(noC)).toBeNull();
    expect(projectStrategy({ ...FULL, north_star: { metric: "   " } })).toBeNull();
  });

  it("returns null for junk input rather than throwing", () => {
    for (const junk of [null, undefined, "a string", 42, []]) {
      expect(projectStrategy(junk)).toBeNull();
    }
  });

  it("drops unknown fields instead of passing metadata through", () => {
    const p = projectStrategy({ ...FULL, evil: "<script>", extra: { a: 1 } });
    expect(p).not.toBeNull();
    expect(Object.keys(p as object).sort()).toEqual(
      [
        "basis_evidence",
        "channel_bets",
        "constraint",
        "gaps",
        "goal",
        "north_star",
        "unmeasured",
      ].sort(),
    );
  });

  it("projects basis_evidence item-by-item rather than passing the blob through", () => {
    const p = projectStrategy({
      ...FULL,
      basis_evidence: [
        { kind: "platform", source: "growth__read_ads_perf", statement: "kept", evil: "<script>" },
        { kind: "not_a_kind", source: "x", statement: "dropped — bad kind" },
        { kind: "founder", source: "who_we_serve", statement: "" },
      ],
    });
    expect(p).not.toBeNull();
    const ev = (p as { basis_evidence: Array<Record<string, unknown>> }).basis_evidence;
    expect(ev).toHaveLength(1);
    expect(ev[0].statement).toBe("kept");
    expect(Object.keys(ev[0]).sort()).toEqual(["kind", "source", "statement"]);
  });

  it("caps bets at 3 and drops nameless ones", () => {
    const bets = CHANNELS.slice(0, 6).map((c) => ({ channel_slug: c.slug }));
    expect(projectStrategy({ ...FULL, channel_bets: bets })!.channel_bets).toHaveLength(3);
    expect(
      projectStrategy({ ...FULL, channel_bets: [{ rationale: "no slug" }] })!.channel_bets,
    ).toHaveLength(0);
  });

  it("drops a channel slug that is not in the registry", () => {
    const p = projectStrategy({
      ...FULL,
      channel_bets: [
        { channel_slug: "growth_hacking_synergy", rationale: "invented" },
        { channel_slug: CHANNELS[0].slug, rationale: "real" },
      ],
    })!;
    expect(p.channel_bets.map((b) => b.channel_slug)).toEqual([CHANNELS[0].slug]);
  });

  it("degrades an unreadable confidence to low", () => {
    const p = projectStrategy({ ...FULL, constraint: { ...FULL.constraint, confidence: "yes" } });
    expect(p!.constraint.confidence).toBe("low");
  });

  it("drops an incomplete goal rather than rendering a half goal", () => {
    const p = projectStrategy({ ...FULL, goal: { objective: "grow", target_metric: "mrr" } });
    expect(p!.goal).toBeNull();
  });
});
