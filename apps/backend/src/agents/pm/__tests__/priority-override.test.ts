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
        data: rows.map((r) => ({ id: r.id, agent_slug: r.agent_slug, error: r.error })),
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
import { productPmBacklogSchema } from "../output-schema";
import type { AgentContext } from "@/services/agents/types";

const TENANT = "aaaaaaaa-1111-1111-1111-111111111111";
const RUN_A = "ffffffff-0000-0000-0000-00000000000a";
const RUN_B = "ffffffff-0000-0000-0000-00000000000b";

function ctx(): AgentContext {
  return {
    tenant_id: TENANT,
    runId: "run_test",
    trigger: "cron",
    agent: { slug: "pm", metadata_praxis: {} },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
  } as unknown as AgentContext;
}

const base = {
  rendered_markdown: "x",
  summary: { bullets: ["b"] },
  dispatched_actions: [] as unknown[],
  recommended_actions_not_dispatched: [] as unknown[],
  sources_all: [] as unknown[],
  snapshot_run_id: "run_x",
};

beforeEach(() => {
  state.agentRuns = [
    { id: RUN_A, tenant_id: TENANT, agent_slug: "engineer", error: "noise-a", finished_at: "2026-05-01T00:00:00.000Z" },
    { id: RUN_B, tenant_id: TENANT, agent_slug: "engineer", error: "noise-b", finished_at: "2026-05-01T00:00:00.000Z" },
  ];
});

function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: "item-x",
    theme: "noise theme",
    theme_normalized: "noise-theme",
    problem: "noise problem",
    proposed_fix: "noise fix",
    target: "product",
    code_reach: 0,
    code_confidence: 0,
    impact: "medium",
    effort: "low",
    rice_score: 0,
    reasoning: "r",
    evidence_sources: [{ agent_run_id: RUN_A, summary: "" }],
    ...over,
  };
}

async function run(brief: Record<string, unknown>) {
  return processProductPmBacklog(ctx(), JSON.parse(JSON.stringify(brief)) as never);
}

describe("priority_override channel (P1.1)", () => {
  it("valid dependency override re-ranks up to stated rank", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [
        item({ item_id: "item-a", impact: "high", evidence_sources: [{ agent_run_id: RUN_A, summary: "" }] }),
        item({
          item_id: "item-b",
          impact: "low",
          evidence_sources: [{ agent_run_id: RUN_B, summary: "" }],
          priority_override: { rank: 1, reason_class: "dependency", depends_on_item_id: "item-a", rationale: "unblocks A" },
        }),
      ] as unknown[],
    };
    const { brief: out } = await run(brief);
    expect(out.backlog[0].item_id).toBe("item-b");
    expect(out.backlog[0].rice_score).toBeLessThan(out.backlog[1].rice_score);
  });

  it("override NEVER changes rice_score", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [
        item({ item_id: "item-a", impact: "high", evidence_sources: [{ agent_run_id: RUN_A, summary: "" }] }),
        item({
          item_id: "item-b",
          impact: "low",
          evidence_sources: [{ agent_run_id: RUN_B, summary: "" }],
          priority_override: { rank: 1, reason_class: "dependency", depends_on_item_id: "item-a", rationale: "unblocks A" },
        }),
      ] as unknown[],
    };
    const { brief: out } = await run(brief);
    const a = out.backlog.find((b) => b.item_id === "item-a")!;
    const b = out.backlog.find((b) => b.item_id === "item-b")!;
    expect(a.rice_score).toBeCloseTo(9, 5);
    expect(b.rice_score).toBeCloseTo(1, 5);
  });

  it("unvalidatable dependency (bad sibling id) is ignored + logged + stripped", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [
        item({ item_id: "item-a", impact: "high", evidence_sources: [{ agent_run_id: RUN_A, summary: "" }] }),
        item({
          item_id: "item-b",
          impact: "low",
          evidence_sources: [{ agent_run_id: RUN_B, summary: "" }],
          priority_override: { rank: 1, reason_class: "dependency", depends_on_item_id: "does-not-exist", rationale: "x" },
        }),
      ] as unknown[],
    };
    const { brief: out, skipped } = await run(brief);
    expect(out.backlog[0].item_id).toBe("item-a");
    expect(skipped).toContainEqual({ item_id: "item-b", reason: "override_unvalidated" });
    const b = out.backlog.find((x) => x.item_id === "item-b")!;
    expect(b.priority_override).toBeUndefined();
  });

  it("money_or_compliance validates only for backend/agent_prompt money text", async () => {
    const money = (over: Record<string, unknown>) =>
      item({
        item_id: "item-money",
        impact: "low",
        evidence_sources: [{ agent_run_id: RUN_B, summary: "" }],
        priority_override: { rank: 1, reason_class: "money_or_compliance", rationale: "ships first" },
        ...over,
      });
    const high = () =>
      item({ item_id: "item-high", impact: "high", evidence_sources: [{ agent_run_id: RUN_A, summary: "" }] });

    const a = await run({
      ...base,
      status: "actionable" as const,
      backlog: [high(), money({ target: "backend", problem: "stripe payout fails" })] as unknown[],
    });
    expect(a.brief.backlog[0].item_id).toBe("item-money");

    const b = await run({
      ...base,
      status: "actionable" as const,
      backlog: [high(), money({ target: "frontend", problem: "stripe payout fails" })] as unknown[],
    });
    expect(b.brief.backlog[0].item_id).toBe("item-high");
    expect(b.skipped).toContainEqual({ item_id: "item-money", reason: "override_unvalidated" });

    const c = await run({
      ...base,
      status: "actionable" as const,
      backlog: [high(), money({ target: "backend", problem: "render glitch" })] as unknown[],
    });
    expect(c.brief.backlog[0].item_id).toBe("item-high");
    expect(c.skipped).toContainEqual({ item_id: "item-money", reason: "override_unvalidated" });
  });

  it("churn_risk_anchor requires customer_impact:high", async () => {
    const high = () =>
      item({ item_id: "item-high", impact: "high", evidence_sources: [{ agent_run_id: RUN_A, summary: "" }] });
    const churn = (over: Record<string, unknown>) =>
      item({
        item_id: "item-churn",
        impact: "low",
        evidence_sources: [{ agent_run_id: RUN_B, summary: "" }],
        priority_override: { rank: 1, reason_class: "churn_risk_anchor", rationale: "cohort churning" },
        ...over,
      });

    const a = await run({
      ...base,
      status: "actionable" as const,
      backlog: [high(), churn({ customer_impact: "high" })] as unknown[],
    });
    expect(a.brief.backlog[0].item_id).toBe("item-churn");

    const b = await run({
      ...base,
      status: "actionable" as const,
      backlog: [high(), churn({ customer_impact: "medium" })] as unknown[],
    });
    expect(b.brief.backlog[0].item_id).toBe("item-high");
    expect(b.skipped).toContainEqual({ item_id: "item-churn", reason: "override_unvalidated" });

    const c = await run({
      ...base,
      status: "actionable" as const,
      backlog: [high(), churn({})] as unknown[],
    });
    expect(c.brief.backlog[0].item_id).toBe("item-high");
    expect(c.skipped).toContainEqual({ item_id: "item-churn", reason: "override_unvalidated" });
  });

  it("table_stakes is always ignored (no server rule)", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [
        item({ item_id: "item-a", impact: "high", evidence_sources: [{ agent_run_id: RUN_A, summary: "" }] }),
        item({
          item_id: "item-b",
          impact: "low",
          evidence_sources: [{ agent_run_id: RUN_B, summary: "" }],
          priority_override: { rank: 1, reason_class: "table_stakes", rationale: "broken core path" },
        }),
      ] as unknown[],
    };
    const { brief: out, skipped } = await run(brief);
    expect(out.backlog[0].item_id).toBe("item-a");
    expect(skipped).toContainEqual({ item_id: "item-b", reason: "override_unvalidated" });
  });

  it("override is UP-only — a rank:5 request on an already-#1 item is a no-op", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [
        item({
          item_id: "item-top",
          impact: "high",
          evidence_sources: [{ agent_run_id: RUN_A, summary: "" }],
          priority_override: { rank: 5, reason_class: "dependency", depends_on_item_id: "item-low", rationale: "x" },
        }),
        item({ item_id: "item-low", impact: "low", evidence_sources: [{ agent_run_id: RUN_B, summary: "" }] }),
      ] as unknown[],
    };
    const { brief: out } = await run(brief);
    expect(out.backlog[0].item_id).toBe("item-top");
  });

  it("rendered_markdown carries the WHY line and re-parses", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [
        item({ item_id: "item-a", impact: "high", evidence_sources: [{ agent_run_id: RUN_A, summary: "" }] }),
        item({
          item_id: "item-b",
          impact: "low",
          evidence_sources: [{ agent_run_id: RUN_B, summary: "" }],
          priority_override: { rank: 1, reason_class: "dependency", depends_on_item_id: "item-a", rationale: "unblocks A" },
        }),
      ] as unknown[],
    };
    const { brief: out } = await run(brief);
    expect(out.rendered_markdown?.startsWith("> **Ranked #1 over")).toBe(true);
    expect(productPmBacklogSchema.safeParse(out).success).toBe(true);
  });
});

describe("schema round-trip (P1.1 / P1.4)", () => {
  it("accepts priority_override + reversal_trigger on a backlog item and reversal_trigger on a reframe option", async () => {
    const delivery = {
      ...base,
      status: "actionable" as const,
      backlog: [
        item({
          item_id: "item-a",
          reversal_trigger: "drop if signature gone in 2 weeks",
          priority_override: { rank: 1, reason_class: "dependency", depends_on_item_id: "item-b", rationale: "x" },
        }),
        item({ item_id: "item-b" }),
      ] as unknown[],
    };
    expect(productPmBacklogSchema.safeParse(delivery).success).toBe(true);

    const strategy = {
      status: "strategy_memo" as const,
      rendered_markdown: "## Premise",
      summary: { bullets: [] as string[] },
      backlog: [] as unknown[],
      dispatched_actions: [] as unknown[],
      recommended_actions_not_dispatched: [] as unknown[],
      sources_all: [] as unknown[],
      strategy: {
        premise_check: "p",
        reframe_options: [
          { title: "t", rationale: "r", metrics: ["m"], reversal_trigger: "kill if no movement in 30d", rank: 1 },
        ],
        research_findings: [],
        clarifications_needed: false as const,
      },
    };
    expect(productPmBacklogSchema.safeParse(strategy).success).toBe(true);
  });

  it("TRUNCATES an over-long override rationale (was: rejected — killed build 5aeb80dc)", async () => {
    const tooLong = {
      ...base,
      status: "actionable" as const,
      backlog: [
        item({
          item_id: "item-a",
          priority_override: { rank: 1, reason_class: "dependency", depends_on_item_id: "item-b", rationale: "x".repeat(301) },
        }),
      ] as unknown[],
    };
    const parsedLong = productPmBacklogSchema.safeParse(tooLong);
    expect(parsedLong.success).toBe(true);
    if (parsedLong.success) {
      expect(
        (parsedLong.data.backlog[0] as { priority_override?: { rationale?: string } })
          .priority_override?.rationale,
      ).toHaveLength(300);
    }
  });

  it("still REJECTS a bad reason_class (enum stays strict — server cannot act on it)", async () => {
    const badClass = {
      ...base,
      status: "actionable" as const,
      backlog: [
        item({
          item_id: "item-a",
          priority_override: { rank: 1, reason_class: "vibes", rationale: "x" },
        }),
      ] as unknown[],
    };
    expect(productPmBacklogSchema.safeParse(badClass).success).toBe(false);
  });
});
