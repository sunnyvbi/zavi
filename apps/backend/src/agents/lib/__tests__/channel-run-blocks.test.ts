
import { describe, it, expect } from "vitest";
import {
  channelRecipeStepEnvelopeSchema,
  stepDecisionBodies,
} from "@/agents/lib/channel-recipe-step";

const step = {
  title: "Apply the exclusion audience to four ad sets",
  body: "Built, confirmed ready by Meta, and attached to nothing.",
  blocking: false,
  effort: "minutes" as const,
  evidence: ["meta_ads__list_custom_audiences: in_use=false"],
};

const legacy = { rendered_markdown: "## Scoreboard", steps: [step] };

describe("envelope without the run-level blocks", () => {
  it("parses, and leaves all four undefined", () => {
    const r = channelRecipeStepEnvelopeSchema.safeParse(legacy);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.summary).toBeUndefined();
    expect(r.data.caveat).toBeUndefined();
    expect(r.data.breakdown).toBeUndefined();
    expect(r.data.reads_not_done).toBeUndefined();
  });
});

describe("a malformed block costs the block, never the run", () => {
  it("keeps the steps when every optional block is garbage", () => {
    const r = channelRecipeStepEnvelopeSchema.safeParse({
      ...legacy,
      summary: "not an object",
      caveat: 42,
      breakdown: { columns: "nope" },
      reads_not_done: "no",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.steps).toHaveLength(1);
    expect(r.data.summary).toBeUndefined();
    expect(r.data.breakdown).toBeUndefined();
  });
});

describe("a well-formed envelope", () => {
  const full = {
    ...legacy,
    summary: { label: "Return", value: "1.05x", context: "on $4,150.77 across 22 purchases" },
    caveat: {
      title: "Every return figure here is Meta-attributed only",
      detail: "Three pixels found, all degraded.",
      impact: "Do not cut a campaign on these numbers yet.",
    },
    breakdown: {
      title: "Money map",
      columns: ["Campaign", "Posture", "Return"],
      rows: [{ cells: ["Gig Rentals Purchase", "Hold", "6.24x"], status: "pass" }],
    },
    reads_not_done: [
      { what: "Landing match", why: "/rent and /about both 404", impact: "Every click is lost." },
    ],
  };

  it("keeps all four", () => {
    const r = channelRecipeStepEnvelopeSchema.safeParse(full);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.summary?.value).toBe("1.05x");
    expect(r.data.caveat?.impact).toBe("Do not cut a campaign on these numbers yet.");
    expect(r.data.breakdown?.rows[0].status).toBe("pass");
    expect(r.data.reads_not_done).toHaveLength(1);
  });

  it("clamps an over-wide table instead of rejecting the run", () => {
    const r = channelRecipeStepEnvelopeSchema.safeParse({
      ...full,
      breakdown: {
        title: "Wide",
        columns: ["a", "b", "c", "d", "e", "f"],
        rows: Array.from({ length: 20 }, () => ({ cells: ["1", "2", "3", "4"] })),
      },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.breakdown?.columns).toHaveLength(4);
    expect(r.data.breakdown?.rows).toHaveLength(8);
  });
});

describe("the fan-out", () => {
  const twoStep = {
    rendered_markdown: "md",
    steps: [step, { ...step, title: "Second" }],
    summary: { label: "Return", value: "1.05x", context: "on $4,150.77" },
    caveat: { title: "Meta-attributed only", detail: "Three pixels degraded." },
    breakdown: {
      title: "Money map",
      columns: ["Campaign", "Return"],
      rows: [{ cells: ["Gig Rentals", "6.24x"], status: "pass" }],
    },
    reads_not_done: [{ what: "Landing match", why: "404" }],
  };

  it("still explodes one body per action", () => {
    const bodies = stepDecisionBodies(channelRecipeStepEnvelopeSchema.parse(twoStep));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].position).toBe(1);
    expect(bodies[1].of).toBe(2);
  });

  it("carries all four run-level blocks onto action 1", () => {
    const bodies = stepDecisionBodies(channelRecipeStepEnvelopeSchema.parse(twoStep));
    expect(bodies[0].summary?.value).toBe("1.05x");
    expect(bodies[0].caveat?.title).toBe("Meta-attributed only");
    expect(bodies[0].breakdown?.rows[0].cells[1]).toBe("6.24x");
    expect(bodies[0].reads_not_done).toHaveLength(1);
  });

  it("carries them on action 1 ONLY", () => {
    const bodies = stepDecisionBodies(channelRecipeStepEnvelopeSchema.parse(twoStep));
    expect(bodies[1].summary).toBeUndefined();
    expect(bodies[1].caveat).toBeUndefined();
    expect(bodies[1].breakdown).toBeUndefined();
    expect(bodies[1].reads_not_done).toBeUndefined();
  });

  it("omits them entirely for a run that emitted none", () => {
    const bodies = stepDecisionBodies(channelRecipeStepEnvelopeSchema.parse(legacy));
    expect(bodies[0].summary).toBeUndefined();
    expect(bodies[0].breakdown).toBeUndefined();
  });
});
