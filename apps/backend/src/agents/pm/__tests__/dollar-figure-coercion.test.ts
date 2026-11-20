
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { productPmBacklogSchema, stripDollarFigures } from "../output-schema";

function makeActionableBrief(overrides: Record<string, unknown> = {}) {
  return {
    status: "actionable",
    rendered_markdown:
      "## Top theme\n\nAd-spend waste: ~$2,913/mo in confirmed waste across paused campaigns.",
    summary: { bullets: ["~$2,913/mo in confirmed waste"], top_theme: "ad-spend waste" },
    backlog: [
      {
        item_id: "item-1",
        theme: "Ad-spend waste",
        theme_normalized: "ad-spend waste",
        problem: "Roughly $2,913 per month is being burned on paused-audience campaigns.",
        proposed_fix: "Add a reconcile check that flags spend on paused audiences.",
        target: "backend",
        code_reach: 100,
        code_confidence: 80,
        impact: "high",
        effort: "low",
        rice_score: 0,
        reasoning: "Confirmed waste with direct evidence.",
        evidence_sources: [{ agent_run_id: "run-abc", summary: "meta ads read" }],
      },
    ],
    ...overrides,
  };
}

describe("pm output-schema $-figure auto-coercion", () => {
  it("run edf7d8a6 regression: an actionable envelope carrying '$2,913/mo' parses SUCCESS (not schema_soft_fail)", () => {
    const r = productPmBacklogSchema.safeParse(makeActionableBrief());
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.rendered_markdown).toContain("~2,913/mo in confirmed waste");
    expect(r.data.rendered_markdown).not.toMatch(/\$\s?\d/);
    expect(r.data.summary.bullets[0]).toBe("~2,913/mo in confirmed waste");
    expect(r.data.backlog[0].problem).toContain("Roughly 2,913 per month");
    expect(JSON.stringify(r.data)).not.toMatch(/\$\s?\d/);
  });

  it("strips '$ 5' (space form) and stacked '$$5' to a fixed point", () => {
    expect(stripDollarFigures("costs $ 5 today")).toBe("costs  5 today");
    expect(stripDollarFigures("stacked $$5 figure")).toBe("stacked 5 figure");
    expect(stripDollarFigures("$$$1,200")).toBe("1,200");
  });

  it("leaves non-$-figure text untouched (no false coercion)", () => {
    const brief = makeActionableBrief({
      rendered_markdown: "Use the env var $HOME and the USD label without digits.",
      summary: { bullets: ["plain bullet"], top_theme: "t" },
    });
    brief.backlog = [
      {
        ...(makeActionableBrief().backlog as Array<Record<string, unknown>>)[0],
        problem: "No money figures here at all.",
      },
    ] as never;
    const r = productPmBacklogSchema.safeParse(brief);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.rendered_markdown).toBe(
      "Use the env var $HOME and the USD label without digits.",
    );
    expect(r.data.backlog[0].problem).toBe("No money figures here at all.");
  });

  it("deep-walks arrays and nested objects", () => {
    const v = stripDollarFigures({
      a: ["save $100", { b: "another $2,913/mo" }],
      n: 5,
      flag: true,
      nul: null,
    });
    expect(v).toEqual({
      a: ["save 100", { b: "another 2,913/mo" }],
      n: 5,
      flag: true,
      nul: null,
    });
  });

  it("schema stays a ZodObject (two-channel split in structured-output.ts requires it)", () => {
    expect(productPmBacklogSchema instanceof z.ZodObject).toBe(true);
  });

  it("skip-shape envelopes with a $-figure also parse (no_signal status)", () => {
    const r = productPmBacklogSchema.safeParse({
      status: "no_signal",
      status_reason: "nothing actionable",
      rendered_markdown: "Spend held steady at about $1,400 this week; no action needed.",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.rendered_markdown).toContain("about 1,400 this week");
  });
});
