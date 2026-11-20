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

describe("customer_impact RICE fold (Bundle A-E3)", () => {
  it("operator_db-backed high customer_impact out-ranks an identical internal-noise item", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [
        {
          item_id: "internal-noise",
          theme: "internal agent echo",
          theme_normalized: "internal-agent-echo",
          problem: "p",
          proposed_fix: "f",
          target: "product",
          code_reach: 0,
          code_confidence: 0,
          impact: "medium",
          effort: "low",
          rice_score: 0,
          reasoning: "r",
          evidence_sources: [{ agent_run_id: RUN_A, summary: "" }],
        },
        {
          item_id: "real-funnel-drop",
          theme: "checkout funnel drop from operator_db",
          theme_normalized: "checkout-funnel-drop",
          problem: "p",
          proposed_fix: "f",
          target: "product",
          code_reach: 0,
          code_confidence: 0,
          impact: "medium",
          effort: "low",
          customer_impact: "high",
          rice_score: 0,
          reasoning: "r",
          evidence_sources: [{ agent_run_id: RUN_B, summary: "" }],
        },
      ] as unknown[],
    };

    const { brief: out } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
    );

    const noise = out.backlog.find((b) => b.item_id === "internal-noise")!;
    const funnel = out.backlog.find((b) => b.item_id === "real-funnel-drop")!;

    expect(funnel.rice_score).toBeGreaterThan(noise.rice_score);
    expect(funnel.rice_score).toBeCloseTo(noise.rice_score * 2, 5);
    expect(out.backlog[0].item_id).toBe("real-funnel-drop");
  });

  it("operatorDbReadThisRun:false → customer_impact STRIPPED (ungrounded claim cannot inflate rank)", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [
        {
          item_id: "internal-noise",
          theme: "internal agent echo",
          theme_normalized: "internal-agent-echo",
          problem: "p",
          proposed_fix: "f",
          target: "product",
          code_reach: 0,
          code_confidence: 0,
          impact: "medium",
          effort: "low",
          rice_score: 0,
          reasoning: "r",
          evidence_sources: [{ agent_run_id: RUN_A, summary: "" }],
        },
        {
          item_id: "claimed-funnel-drop",
          theme: "claims customer impact with no operator_db read",
          theme_normalized: "claims-customer-impact",
          problem: "p",
          proposed_fix: "f",
          target: "product",
          code_reach: 0,
          code_confidence: 0,
          impact: "medium",
          effort: "low",
          customer_impact: "high",
          rice_score: 0,
          reasoning: "r",
          evidence_sources: [{ agent_run_id: RUN_B, summary: "" }],
        },
      ] as unknown[],
    };
    const { brief: out } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
      { operatorDbReadThisRun: false },
    );
    const noise = out.backlog.find((b) => b.item_id === "internal-noise")!;
    const claimed = out.backlog.find((b) => b.item_id === "claimed-funnel-drop")!;
    expect(claimed.customer_impact).toBeUndefined();
    expect(claimed.rice_score).toBeCloseTo(noise.rice_score, 5);
  });

  it("operatorDbReadThisRun:true → customer_impact PRESERVED (real operator_db read this run)", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [
        {
          item_id: "real-funnel-drop",
          theme: "checkout funnel drop from operator_db",
          theme_normalized: "checkout-funnel-drop",
          problem: "p",
          proposed_fix: "f",
          target: "product",
          code_reach: 0,
          code_confidence: 0,
          impact: "medium",
          effort: "low",
          customer_impact: "high",
          rice_score: 0,
          reasoning: "r",
          evidence_sources: [{ agent_run_id: RUN_B, summary: "" }],
        },
      ] as unknown[],
    };
    const { brief: out } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
      { operatorDbReadThisRun: true },
    );
    const item = out.backlog[0];
    expect(item.customer_impact).toBe("high");
    expect(item.rice_score).toBeCloseTo(6.0, 5);
  });

  it("absent customer_impact → score unchanged vs the prior formula (no fold)", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [
        {
          item_id: "plain",
          theme: "plain item",
          theme_normalized: "plain-item",
          problem: "p",
          proposed_fix: "f",
          target: "product",
          code_reach: 0,
          code_confidence: 0,
          impact: "high",
          effort: "medium",
          rice_score: 0,
          reasoning: "r",
          evidence_sources: [{ agent_run_id: RUN_A, summary: "" }],
        },
      ] as unknown[],
    };
    const { brief: out } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
    );
    const item = out.backlog[0];
    expect(item.rice_score).toBeCloseTo(3.0, 5);
  });
});
