
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { productPmBacklogSchema } from "../output-schema";

function backlogItem(overrides: Record<string, unknown> = {}) {
  return {
    item_id: "item-1",
    theme: "Auth flow gaps",
    theme_normalized: "auth flow gaps",
    problem: "Login lacks a forgot-password path.",
    proposed_fix: "Add a password-reset route.",
    target: "backend",
    code_reach: 100,
    code_confidence: 80,
    impact: "high",
    effort: "low",
    rice_score: 0,
    reasoning: "Core onboarding path.",
    evidence_sources: [{ agent_run_id: "run-abc", summary: "spec read" }],
    ...overrides,
  };
}

function actionableBrief(overrides: Record<string, unknown> = {}) {
  return {
    status: "actionable",
    rendered_markdown: "## Spec\n\nBuild the auth flow.",
    summary: { bullets: ["auth flow"], top_theme: "auth" },
    backlog: [backlogItem()],
    ...overrides,
  };
}

describe("pm output-schema null tolerance on optional fields (build run 6839003e)", () => {
  it("regression: priority_override.depends_on_item_id: null parses SUCCESS (was schema_soft_fail)", () => {
    const brief = actionableBrief({
      backlog: [
        backlogItem({ item_id: "item-1" }),
        backlogItem({
          item_id: "item-2",
          impact: "low",
          priority_override: {
            rank: 1,
            reason_class: "table_stakes",
            depends_on_item_id: null,
            rationale: "table stakes",
          },
        }),
      ],
    });
    const r = productPmBacklogSchema.safeParse(brief);
    expect(r.success).toBe(true);
  });

  it("a whole backlog item with EVERY optional field set to null parses SUCCESS", () => {
    const brief = actionableBrief({
      backlog: [
        backlogItem({
          customer_impact: null,
          priority_override: null,
          reversal_trigger: null,
        }),
      ],
    });
    const r = productPmBacklogSchema.safeParse(brief);
    expect(r.success).toBe(true);
  });

  it("top-level status_reason: null and artifact_label: null parse SUCCESS (skip-shape no_signal envelope)", () => {
    const brief = {
      status: "no_signal",
      status_reason: null,
      artifact_label: null,
      rendered_markdown: "Nothing actionable this run.",
      summary: { bullets: [] as string[] },
      backlog: [] as unknown[],
    };
    const r = productPmBacklogSchema.safeParse(brief);
    expect(r.success).toBe(true);
  });

  it("strategy reframe option reversal_trigger: null parses SUCCESS", () => {
    const brief = {
      status: "strategy_memo",
      rendered_markdown: "## Premise",
      summary: { bullets: [] as string[] },
      backlog: [] as unknown[],
      dispatched_actions: [] as unknown[],
      recommended_actions_not_dispatched: [] as unknown[],
      sources_all: [] as unknown[],
      strategy: {
        premise_check: "p",
        reframe_options: [{ title: "t", rationale: "r", metrics: ["m"], reversal_trigger: null, rank: 1 }],
        research_findings: [],
        clarifications_needed: false as const,
      },
    };
    const r = productPmBacklogSchema.safeParse(brief);
    expect(r.success).toBe(true);
  });

  it("the schema stays a ZodObject (structured-output's two-channel split requires it)", () => {
    expect(productPmBacklogSchema instanceof z.ZodObject).toBe(true);
  });
});
