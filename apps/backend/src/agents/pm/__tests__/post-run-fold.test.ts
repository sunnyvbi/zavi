import { describe, it, expect, vi, beforeEach } from "vitest";

const state: {
  agentRuns: Record<string, unknown>[];
} = { agentRuns: [] };

vi.mock("@/services/supabase", () => {
  function makeBuilder(table: string) {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (k: string, v: unknown) => {
        filters[k] = v;
        return builder;
      },
      in: (k: string, v: unknown) => {
        filters[k] = v;
        return builder;
      },
      gt: () => builder,
      not: () => builder,
      order: () => builder,
      limit: () => builder,
      upsert: () => ({ error: null }),
      insert: () => ({ error: null }),
      update: () => {
        const u: Record<string, unknown> = {
          eq: () => u,
          then: (resolve: (x: { error: null }) => void) => resolve({ error: null }),
        };
        return u;
      },
      maybeSingle: () => resolveSingle(table, filters),
      single: () => resolveSingle(table, filters),
      then: (resolve: (x: { data: unknown; error: null }) => void) =>
        resolve(resolveList(table, filters)),
    };
    return builder;
  }
  return { serviceClient: () => ({ from: (t: string) => makeBuilder(t) }) };
});

function resolveSingle(table: string, _filters: Record<string, unknown>) {
  if (table === "system_config") {
    return { data: { blob: { pm_roadmap_enabled: false } }, error: null };
  }
  if (table === "connector_metadata") {
    return {
      data: {
        repo_full_names: ["rravi149/praxis"],
        default_repo_full_name: "rravi149/praxis",
      },
      error: null,
    };
  }
  return { data: null, error: null };
}

function resolveList(table: string, filters: Record<string, unknown>) {
  if (table === "agent_runs") {
    const idFilter = filters.id as string[] | undefined;
    if (Array.isArray(idFilter)) {
      const rows = state.agentRuns.filter(
        (r) => r.tenant_id === filters.tenant_id && idFilter.includes(r.id as string),
      );
      return {
        data: rows.map((r) => ({
          id: r.id,
          agent_slug: r.agent_slug,
          error: r.error,
          parsed: r.parsed ?? null,
          reasoning_text: r.reasoning_text ?? null,
          output_text: r.output_text ?? null,
        })),
        error: null,
      };
    }
  }
  return { data: [], error: null };
}

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: vi.fn(async () => ({ run_id: "11111111-aaaa-bbbb-cccc-000000000001" })),
}));
vi.mock("@/services/memory", () => ({ writeNote: vi.fn(async () => {}) }));

import { processProductPmBacklog } from "../post-run";
import type { AgentContext } from "@/services/agents/types";

const TENANT = "aaaaaaaa-1111-1111-1111-111111111111";
const RUN_A = "ffffffff-0000-0000-0000-00000000000a";
const RUN_B = "ffffffff-0000-0000-0000-00000000000b";

function ctx(trigger: "cron" | "chat" = "cron", company = ""): AgentContext {
  return {
    tenant_id: TENANT,
    runId: "run_test",
    trigger,
    agent: { slug: "pm", metadata_praxis: {} },
    memory: { company, ops: "", policies: "", disputes: "", support: "" },
  } as unknown as AgentContext;
}

const RICH_COMPANY =
  "Praxis is an AI cofounder team for any company, shaped by real operating data from a live P2P car-rental marketplace. We sell to early-stage founders who want an agent team rather than a synthetic demo. Pricing is per-seat subscription with a usage component on agent runs.";

const base = {
  rendered_markdown: "Here is the backlog summary.",
  summary: { bullets: ["b"] },
  dispatched_actions: [] as unknown[],
  recommended_actions_not_dispatched: [] as unknown[],
  sources_all: [] as unknown[],
  snapshot_run_id: "run_x",
};

function backlogItem(over: Record<string, unknown>) {
  return {
    item_id: "i1",
    theme: "checkout funnel regression",
    theme_normalized: "checkout-funnel-regression",
    problem: "checkout funnel conversion dropped sharply this week",
    proposed_fix: "investigate the checkout funnel payment step",
    target: "product",
    code_reach: 0,
    code_confidence: 0,
    impact: "high",
    effort: "medium",
    rice_score: 0,
    reasoning: "r",
    evidence_sources: [{ agent_run_id: RUN_A, summary: "" }],
    ...over,
  };
}

describe("P0a — RICE table folded into rendered_markdown", () => {
  beforeEach(() => {
    state.agentRuns = [
      {
        id: RUN_A,
        tenant_id: TENANT,
        agent_slug: "engineer",
        error: null,
        parsed: { summary: "checkout funnel conversion regression observed in payment step" },
      },
    ];
  });

  it("actionable backlog appends the heading + a numeric rice_score row", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [backlogItem({})] as unknown[],
    };
    const { brief: out } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
    );
    const md = out.rendered_markdown ?? "";
    expect(md).toContain("## RICE-ranked backlog");
    expect(md).toContain("| # | Item | RICE | Impact | Effort |");
    const item = out.backlog[0];
    expect(md).toContain(item.rice_score.toFixed(1));
    expect(md).toMatch(/\|\s*1\s*\|.*\|\s*3\.0\s*\|/);
  });

  it("idempotent — second pass does not append a second table", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [backlogItem({})] as unknown[],
    };
    const { brief: out1 } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
    );
    const brief2 = {
      ...base,
      rendered_markdown: out1.rendered_markdown,
      status: "actionable" as const,
      backlog: [backlogItem({})] as unknown[],
    };
    const { brief: out2 } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief2)) as never,
    );
    const count = (out2.rendered_markdown ?? "").split("## RICE-ranked backlog").length - 1;
    expect(count).toBe(1);
  });

  it("never emits a $-figure (envelope reparse passes)", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [backlogItem({})] as unknown[],
    };
    const { brief: out } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
    );
    expect(out.rendered_markdown ?? "").not.toMatch(/\$\s?\d/);
  });
});

describe("P0a — no_signal leaves rendered_markdown untouched (no table)", () => {
  it("no_signal does not append a RICE table", async () => {
    const brief = {
      ...base,
      rendered_markdown: "## No actionable signal\n\nNothing this run.",
      status: "no_signal" as const,
      backlog: [] as unknown[],
    };
    const { brief: out } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
    );
    expect(out.rendered_markdown ?? "").not.toContain("## RICE-ranked backlog");
    expect(out.rendered_markdown).toBe("## No actionable signal\n\nNothing this run.");
  });
});

describe("P0a — strategy_memo appends ranked options", () => {
  it("reframe_options fold into a ## Options (ranked) block", async () => {
    const brief = {
      ...base,
      rendered_markdown: "Strategy memo intro.",
      status: "strategy_memo" as const,
      summary: { bullets: [] },
      dispatched_actions: [] as unknown[],
      recommended_actions_not_dispatched: [] as unknown[],
      strategy: {
        premise_check: "premise looks sound",
        reframe_options: [
          { title: "Narrow the wedge", rationale: "focus on one ICP", metrics: ["activation", "retention"], rank: 1 },
          { title: "Go broad", rationale: "more TAM", metrics: ["TAM"], rank: 2 },
        ],
        research_findings: [],
        clarifications_needed: false,
      },
    };
    const { brief: out } = await processProductPmBacklog(
      ctx("chat", RICH_COMPANY),
      JSON.parse(JSON.stringify(brief)) as never,
    );
    const md = out.rendered_markdown ?? "";
    expect(md).toContain("## Options (ranked)");
    expect(md).toContain("**1. Narrow the wedge**");
    expect(md).toContain("**2. Go broad**");
    expect(md).toContain("_metrics: activation, retention_");
  });
});

describe("P1 — item-grounding faithfulness pass", () => {
  beforeEach(() => {
    state.agentRuns = [
      {
        id: RUN_A,
        tenant_id: TENANT,
        agent_slug: "engineer",
        error: null,
        parsed: { summary: "checkout funnel conversion regression in the payment step" },
      },
      {
        id: RUN_B,
        tenant_id: TENANT,
        agent_slug: "engineer",
        error: null,
        parsed: { summary: "deployment pipeline cache warming latency benchmark" },
      },
    ];
  });

  it("drops an item whose claim shares zero tokens with its cited run; keeps an overlapping item", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [
        backlogItem({
          item_id: "grounded",
          theme: "checkout funnel regression",
          problem: "checkout funnel conversion dropped",
          proposed_fix: "fix the payment step",
          evidence_sources: [{ agent_run_id: RUN_A, summary: "" }],
        }),
        backlogItem({
          item_id: "ungrounded",
          theme: "onboarding tutorial copy refresh",
          problem: "rewrite the onboarding tutorial welcome copy",
          proposed_fix: "update marketing tutorial wording everywhere",
          evidence_sources: [{ agent_run_id: RUN_B, summary: "" }],
        }),
      ] as unknown[],
    };
    const { brief: out, skipped } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
    );
    const ids = out.backlog.map((b) => b.item_id);
    expect(ids).toContain("grounded");
    expect(ids).not.toContain("ungrounded");
    expect(skipped).toContainEqual({ item_id: "ungrounded", reason: "ungrounded_item" });
  });
});

describe("P0a — budget hard cap: skip the fold rather than overflow the schema", () => {
  beforeEach(() => {
    state.agentRuns = [
      {
        id: RUN_A,
        tenant_id: TENANT,
        agent_slug: "engineer",
        error: null,
        parsed: { summary: "checkout funnel conversion regression observed in payment step" },
      },
    ];
  });

  it("does not append the table + stays <=4000 when rendered_markdown is already near the cap", async () => {
    const hugeBody = "x".repeat(3850);
    const brief = {
      ...base,
      rendered_markdown: hugeBody,
      status: "actionable" as const,
      backlog: [backlogItem({})] as unknown[],
    };
    const { brief: out } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
    );
    const md = out.rendered_markdown ?? "";
    expect(md).not.toContain("## RICE-ranked backlog");
    expect(md.length).toBeLessThanOrEqual(4000);
  });
});

describe("P1 — keeps an item when no grounding text is available to judge", () => {
  beforeEach(() => {
    state.agentRuns = [
      {
        id: RUN_A,
        tenant_id: TENANT,
        agent_slug: "engineer",
        error: null,
        parsed: null,
        reasoning_text: null,
        output_text: null,
      },
    ];
  });

  it("does not drop an item whose cited run has empty grounding text (permissive)", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [
        backlogItem({
          item_id: "nogrounding",
          evidence_sources: [{ agent_run_id: RUN_A, summary: "" }],
        }),
      ] as unknown[],
    };
    const { brief: out, skipped } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
    );
    expect(out.backlog.map((b) => b.item_id)).toContain("nogrounding");
    expect(skipped).not.toContainEqual({ item_id: "nogrounding", reason: "ungrounded_item" });
  });
});
