
import { describe, expect, it } from "vitest";
import { productPmBacklogSchema } from "../output-schema";

const backlogItem = (n: number) => ({
  item_id: `item-${n}`,
  theme: `Theme ${n}`,
  theme_normalized: `theme-${n}`,
  problem: `Problem ${n} blocking the private-rentals launch.`,
  proposed_fix: `Fix ${n}.`,
  target: "backend",
  code_reach: 100,
  code_confidence: 80,
  impact: "high",
  effort: "low",
  rice_score: 10,
  reasoning: `Reasoning ${n}.`,
  evidence_sources: [{ agent_run_id: "12fe9168", summary: "competitor intel run" }],
});

const recommendedAction = (n: number) => ({
  item_id: `rec-${n}`,
  description: `Recommendation ${n} — close before the campaign fires.`,
  target_team: n % 2 === 0 ? "growth" : "product",
  urgency: "this-week" as const,
});

const dispatchedAction = (n: number) => ({
  item_id: `item-${n}`,
  target_agent_slug: "engineer" as const,
  task_description: `Ship the fix for item ${n} against the launch blocker list.`,
  file_hints: ["apps/backend/src/routes/index.ts"],
  child_run_id: `child-${n}`,
});

function gtmEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    status: "actionable",
    rendered_markdown:
      "Private Rentals GTM (Turo host poach) — window is real; 4 pre-launch gaps must close before the campaign fires.",
    summary: { bullets: ["Turo host poach window is real"], top_theme: "private-rentals-gtm" },
    backlog: [backlogItem(1)],
    dispatched_actions: [],
    recommended_actions_not_dispatched: [],
    sources_all: [],
    ...overrides,
  };
}

describe("pm output-schema array count-cap coercion", () => {
  it("run 1a52c59e regression: 14 recommendations (8 gaps + 6 growth plays) parse SUCCESS, not schema_soft_fail", () => {
    const r = productPmBacklogSchema.safeParse(
      gtmEnvelope({
        recommended_actions_not_dispatched: Array.from({ length: 14 }, (_, i) => recommendedAction(i + 1)),
      }),
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.recommended_actions_not_dispatched).toHaveLength(14);
    expect(r.data.rendered_markdown).toContain("Turo host poach");
    expect(r.data.backlog).toHaveLength(1);
  });

  it("an over-count beyond the ceiling TRUNCATES — a count can never fail the run", () => {
    const r = productPmBacklogSchema.safeParse(
      gtmEnvelope({
        recommended_actions_not_dispatched: Array.from({ length: 40 }, (_, i) => recommendedAction(i + 1)),
        backlog: Array.from({ length: 40 }, (_, i) => backlogItem(i + 1)),
        summary: { bullets: ["a", "b", "c", "d", "e"], top_theme: "t" },
      }),
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.recommended_actions_not_dispatched).toHaveLength(25);
    expect(r.data.backlog).toHaveLength(25);
    expect(r.data.summary.bullets).toHaveLength(3);
    expect(r.data.recommended_actions_not_dispatched[0].item_id).toBe("rec-1");
    expect(r.data.backlog[0].item_id).toBe("item-1");
  });

  it("dispatched_actions keeps its governance ceiling of 3 — slice is safe-direction (never MORE side effects)", () => {
    const r = productPmBacklogSchema.safeParse(
      gtmEnvelope({
        backlog: Array.from({ length: 6 }, (_, i) => backlogItem(i + 1)),
        dispatched_actions: Array.from({ length: 6 }, (_, i) => dispatchedAction(i + 1)),
      }),
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.dispatched_actions).toHaveLength(3);
    const ids = new Set(r.data.backlog.map((b) => b.item_id));
    for (const d of r.data.dispatched_actions) expect(ids.has(d.item_id)).toBe(true);
  });

  it("under-cap envelopes are untouched (no silent reshaping of the common case)", () => {
    const r = productPmBacklogSchema.safeParse(
      gtmEnvelope({
        recommended_actions_not_dispatched: [recommendedAction(1), recommendedAction(2)],
      }),
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.recommended_actions_not_dispatched).toHaveLength(2);
    expect(r.data.backlog).toHaveLength(1);
    expect(r.data.summary.bullets).toHaveLength(1);
  });
});
