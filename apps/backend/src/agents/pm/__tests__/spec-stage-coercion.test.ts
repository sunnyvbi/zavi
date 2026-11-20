
import { describe, expect, it } from "vitest";
import { productPmBacklogSchema, clampedText, softMeta } from "../output-schema";

function backlogItem(overrides: Record<string, unknown> = {}) {
  return {
    item_id: "item-1",
    theme: "Booking flow",
    theme_normalized: "booking flow",
    problem: "Guests cannot rebook.",
    proposed_fix: "Add a rebook route.",
    target: "backend",
    code_reach: 100,
    code_confidence: 80,
    impact: "high",
    effort: "low",
    rice_score: 0,
    reasoning: "Core path.",
    evidence_sources: [],
    ...overrides,
  };
}

function actionableBrief(overrides: Record<string, unknown> = {}) {
  return {
    status: "actionable",
    rendered_markdown: "## Spec\n\nBuild it.",
    summary: { bullets: ["x"], top_theme: "x" },
    backlog: [backlogItem()],
    ...overrides,
  };
}

describe("spec-stage coercion — over-length descriptive free-text clamps (was build-killer)", () => {
  it("regression: dispatched_actions[].task_description at 2500 chars parses SUCCESS, truncated to 2000 (run 0f716295)", () => {
    const brief = actionableBrief({
      dispatched_actions: [
        {
          item_id: "item-1",
          target_agent_slug: "engineer",
          task_description: "x".repeat(2500),
          file_hints: ["src/index.ts"],
          child_run_id: "child-1",
        },
      ],
    });
    const r = productPmBacklogSchema.safeParse(brief);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dispatched_actions[0].task_description).toHaveLength(2000);
    }
  });

  it("backlog problem / proposed_fix / reasoning over 1000 chars all parse SUCCESS, truncated", () => {
    const brief = actionableBrief({
      backlog: [
        backlogItem({
          problem: "p".repeat(1500),
          proposed_fix: "f".repeat(1500),
          reasoning: "r".repeat(1500),
        }),
      ],
    });
    const r = productPmBacklogSchema.safeParse(brief);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.backlog[0].problem).toHaveLength(1000);
      expect(r.data.backlog[0].proposed_fix).toHaveLength(1000);
      expect(r.data.backlog[0].reasoning).toHaveLength(1000);
    }
  });
});

describe("spec-stage coercion — provenance self-heals (was build-killer)", () => {
  it("regression: sources_all[] with a MISSING fetched_at parses SUCCESS (run 8fa8ee7b)", () => {
    const brief = actionableBrief({
      sources_all: [{ tool_name: "web_search", query_summary: "pet marketplaces" }],
    });
    const r = productPmBacklogSchema.safeParse(brief);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.sources_all[0].fetched_at).toBe("");
    }
  });

  it("sources_all[] with null / wrong-type / over-long fields all self-heal", () => {
    const brief = actionableBrief({
      sources_all: [
        { tool_name: null, query_summary: 12345, fetched_at: "z".repeat(80) },
      ],
    });
    const r = productPmBacklogSchema.safeParse(brief);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.sources_all[0].tool_name).toBe("");
      expect(r.data.sources_all[0].query_summary).toBe("");
      expect(r.data.sources_all[0].fetched_at).toBe("");
    }
  });

  it("sources_all container hardening: over-count slices to 50, non-array → []", () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      tool_name: "t",
      query_summary: "q" + i,
      fetched_at: "2026-06-28",
    }));
    const r1 = productPmBacklogSchema.safeParse(actionableBrief({ sources_all: many }));
    expect(r1.success).toBe(true);
    if (r1.success) expect(r1.data.sources_all).toHaveLength(50);

    const r2 = productPmBacklogSchema.safeParse(actionableBrief({ sources_all: "not-an-array" }));
    expect(r2.success).toBe(true);
    if (r2.success) expect(r2.data.sources_all).toEqual([]);
  });
});

describe("spec-stage coercion — ESSENTIAL fields STILL fail loudly (no masking)", () => {
  it("task_description below min(12) still fails (degenerate dispatch is a real signal, not mechanical overflow)", () => {
    const brief = actionableBrief({
      dispatched_actions: [
        {
          item_id: "item-1",
          target_agent_slug: "engineer",
          task_description: "too short",
          file_hints: ["src/index.ts"],
          child_run_id: "child-1",
        },
      ],
    });
    expect(productPmBacklogSchema.safeParse(brief).success).toBe(false);
  });

  it("dispatched_actions referencing a non-existent backlog item_id still fails (referential integrity gate)", () => {
    const brief = actionableBrief({
      dispatched_actions: [
        {
          item_id: "does-not-exist",
          target_agent_slug: "engineer",
          task_description: "a valid length description",
          file_hints: ["src/index.ts"],
          child_run_id: "child-1",
        },
      ],
    });
    expect(productPmBacklogSchema.safeParse(brief).success).toBe(false);
  });

  it("a backlog item missing a required identifier (item_id) still fails", () => {
    const item = backlogItem();
    delete (item as Record<string, unknown>).item_id;
    expect(productPmBacklogSchema.safeParse(actionableBrief({ backlog: [item] })).success).toBe(false);
  });

  it("an invalid status enum still fails", () => {
    expect(productPmBacklogSchema.safeParse(actionableBrief({ status: "bogus" })).success).toBe(false);
  });
});

describe("coercion helpers (unit)", () => {
  it("clampedText truncates over-length but keeps too_small strict", () => {
    const s = clampedText(3, 5);
    expect(s.safeParse("abcdefgh")).toMatchObject({ success: true, data: "abcd\u2026" });
    expect(s.safeParse("ab").success).toBe(false);
    expect(s.safeParse("abc")).toMatchObject({ success: true, data: "abc" });
  });

  it("softMeta heals missing/null/over-long to the fallback", () => {
    const inObj = (v: unknown) => softMeta(5).safeParse((v as never));
    expect(softMeta(5).safeParse(undefined)).toMatchObject({ success: true, data: "" });
    expect(softMeta(5).safeParse(null)).toMatchObject({ success: true, data: "" });
    expect(softMeta(5).safeParse("toolong!!")).toMatchObject({ success: true, data: "" });
    expect(softMeta(5).safeParse("ok")).toMatchObject({ success: true, data: "ok" });
    void inObj;
  });
});

describe("spec-stage coercion — omitted-vs-empty and override rationale (run 5aeb80dc)", () => {
  it("regression: OMITTED evidence_sources parses SUCCESS and defaults to [] (not 'expected array, received undefined')", () => {
    const { evidence_sources: _omitted, ...noEvidence } = backlogItem();
    const parsed = productPmBacklogSchema.safeParse(
      actionableBrief({ backlog: [noEvidence] }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.backlog[0].evidence_sources).toEqual([]);
    }
  });

  it("an EXPLICIT empty array still parses (the behaviour min(0) already had)", () => {
    const parsed = productPmBacklogSchema.safeParse(
      actionableBrief({ backlog: [backlogItem({ evidence_sources: [] })] }),
    );
    expect(parsed.success).toBe(true);
  });

  it("regression: priority_override.rationale at 340 chars parses SUCCESS, truncated to 300", () => {
    const parsed = productPmBacklogSchema.safeParse(
      actionableBrief({
        backlog: [
          backlogItem({
            priority_override: {
              rank: 1,
              reason_class: "dependency",
              depends_on_item_id: "item-2",
              rationale: "y".repeat(340),
            },
          }),
        ],
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const r = parsed.data.backlog[0].priority_override?.rationale;
      expect(r).toHaveLength(300);
    }
  });

  it("over-count evidence_sources (25) truncates to 20 rather than killing the envelope", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      agent_run_id: `run-${i}`,
      summary: "s",
    }));
    const parsed = productPmBacklogSchema.safeParse(
      actionableBrief({ backlog: [backlogItem({ evidence_sources: many })] }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.backlog[0].evidence_sources).toHaveLength(20);
    }
  });

  it("still STRICT: a non-array evidence_sources is a real malformation and must fail", () => {
    const parsed = productPmBacklogSchema.safeParse(
      actionableBrief({ backlog: [backlogItem({ evidence_sources: "nope" })] }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("spec-stage coercion — partial summary object (omitted inner bullets)", () => {
  it("summary present but bullets OMITTED parses SUCCESS and defaults to []", () => {
    const parsed = productPmBacklogSchema.safeParse(
      actionableBrief({ summary: { top_theme: "Booking flow" } }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.summary.bullets).toEqual([]);
  });

  it("summary as a bare {} parses SUCCESS", () => {
    const parsed = productPmBacklogSchema.safeParse(actionableBrief({ summary: {} }));
    expect(parsed.success).toBe(true);
  });
});
