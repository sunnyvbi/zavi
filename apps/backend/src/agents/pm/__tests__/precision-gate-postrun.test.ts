import { describe, it, expect, vi, beforeEach } from "vitest";

type Captured = { table: string; filters: Record<string, unknown>; op: string; payload?: unknown };

const state: {
  roadmapFlag: boolean;
  precisionFlag: boolean;
  precisionDispatches: Record<string, unknown>[];
  precisionDecisions: Record<string, unknown>[];
  precisionRoadmap: Record<string, unknown>[];
  agentRuns: Record<string, unknown>[];
  roadmapRows: Record<string, unknown>[];
  dispatchHistory: Record<string, unknown>[];
  captured: Captured[];
} = {
  roadmapFlag: false,
  precisionFlag: true,
  precisionDispatches: [],
  precisionDecisions: [],
  precisionRoadmap: [],
  agentRuns: [],
  roadmapRows: [],
  dispatchHistory: [],
  captured: [],
};

function reset() {
  state.roadmapFlag = false;
  state.precisionFlag = true;
  state.precisionDispatches = [];
  state.precisionDecisions = [];
  state.precisionRoadmap = [];
  state.agentRuns = [];
  state.roadmapRows = [];
  state.dispatchHistory = [];
  state.captured = [];
}

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
      gt: (k: string, v: unknown) => {
        filters[k] = v;
        return builder;
      },
      not: () => builder,
      order: () => builder,
      limit: () => builder,
      upsert: () => {
        state.captured.push({ table, filters: { ...filters }, op: "upsert" });
        return { error: null };
      },
      insert: (payload: unknown) => {
        state.captured.push({ table, filters: { ...filters }, op: "insert", payload });
        return { error: null };
      },
      maybeSingle: () => resolveSingle(table, filters),
      single: () => resolveSingle(table, filters),
      then: (resolve: (x: { data: unknown; error: null }) => void) => resolve(resolveList(table, filters)),
    };
    return builder;
  }
  return { serviceClient: () => ({ from: (t: string) => makeBuilder(t) }) };
});

function resolveSingle(table: string, filters: Record<string, unknown>): { data: unknown; error: null } {
  state.captured.push({ table, filters: { ...filters }, op: "single" });
  if (table === "system_config") {
    return {
      data: { blob: { pm_roadmap_enabled: state.roadmapFlag, pm_precision_gate_enabled: state.precisionFlag } },
      error: null,
    };
  }
  if (table === "dispatch_history") {
    return { data: null, error: null };
  }
  if (table === "agent_runs") {
    const match = state.agentRuns.find((r) => r.tenant_id === filters.tenant_id && r.id === filters.id);
    return { data: match ?? null, error: null };
  }
  if (table === "connector_metadata") {
    return { data: { repo_full_names: ["rravi149/praxis"], default_repo_full_name: "rravi149/praxis" }, error: null };
  }
  return { data: null, error: null };
}

function resolveList(table: string, filters: Record<string, unknown>): { data: unknown; error: null } {
  state.captured.push({ table, filters: { ...filters }, op: "list" });
  if (table === "agent_runs") {
    const ids = filters.id as string[] | undefined;
    if (Array.isArray(ids)) {
      const rows = state.agentRuns.filter((r) => r.tenant_id === filters.tenant_id && ids.includes(r.id as string));
      return {
        data: rows.map((r) => ({
          id: r.id,
          agent_slug: r.agent_slug ?? "engineer",
          error: r.error ?? null,
          parsed: null,
          reasoning_text: null,
          output_text: null,
          status: r.status,
        })),
        error: null,
      };
    }
    return { data: [], error: null };
  }
  if (table === "dispatch_history") {
    if (filters.source_agent_slug === "pm" && filters.target_agent_slug === "engineer") {
      const rows = state.precisionDispatches.filter((r) => r.tenant_id === filters.tenant_id);
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  }
  if (table === "decisions") {
    const ids = (filters.agent_run_id as string[]) ?? [];
    const rows = state.precisionDecisions.filter((r) => r.tenant_id === filters.tenant_id && ids.includes(r.agent_run_id as string));
    return { data: rows, error: null };
  }
  if (table === "pm_roadmap") {
    const keys = filters.dedup_key as string[] | undefined;
    if (Array.isArray(keys)) {
      const rows = state.precisionRoadmap.filter((r) => r.tenant_id === filters.tenant_id && keys.includes(r.dedup_key as string));
      return { data: rows, error: null };
    }
    const rows = state.roadmapRows.filter((r) => r.tenant_id === filters.tenant_id);
    return { data: rows, error: null };
  }
  return { data: [], error: null };
}

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: vi.fn(async () => ({ run_id: "11111111-aaaa-bbbb-cccc-000000000001" })),
}));
vi.mock("@/services/memory", () => ({ writeNote: vi.fn(async () => {}) }));
vi.mock("@/services/agents/deepagent", () => ({ LangChainDeepAgentEngine: class {} }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn(async () => {}) }));

import { productPmBacklogSchema } from "../output-schema";
import { processProductPmBacklog } from "../post-run";
import type { AgentContext } from "@/services/agents/types";

const TENANT_A = "aaaaaaaa-1111-1111-1111-111111111111";
const CITED_RUN = "ffffffff-0000-0000-0000-000000000001";

function ctx(): AgentContext {
  return {
    tenant_id: TENANT_A,
    runId: "run_test",
    trigger: "cron",
    agent: { slug: "pm", metadata_praxis: {} },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
  } as unknown as AgentContext;
}

const base = {
  rendered_markdown: "Backlog ready.",
  summary: { bullets: [] as string[] },
  backlog: [] as unknown[],
  dispatched_actions: [] as unknown[],
  recommended_actions_not_dispatched: [] as unknown[],
  sources_all: [] as unknown[],
  snapshot_run_id: "run_x",
};

function makeDispatchableBrief() {
  return {
    ...base,
    status: "actionable" as const,
    summary: { bullets: ["b"] },
    backlog: [
      {
        item_id: "i1",
        theme: "engineer parse_failed on missing repo_hint",
        theme_normalized: "engineer-parse-failed-missing-repo-hint",
        problem: "engineer keeps failing parse",
        proposed_fix: "Relax the repo_hint requirement",
        target: "backend",
        code_reach: 0,
        code_confidence: 0,
        impact: "high",
        effort: "low",
        rice_score: 0,
        reasoning: "r",
        evidence_sources: [{ agent_run_id: CITED_RUN, summary: "" }],
      },
    ],
    dispatched_actions: [
      {
        item_id: "i1",
        target_agent_slug: "engineer" as const,
        task_description: "Relax the repo_hint requirement in the dispatch path.",
        repo_hint: "rravi149/praxis",
        file_hints: ["apps/backend/src/services/agents/runner.ts"],
        child_run_id: "pending",
      },
    ],
  };
}

function seedBadPrecision() {
  const outcomes = [
    { run_id: "p1", dedup_key: "kp1", status: "success", decision: "acted" },
    { run_id: "p2", dedup_key: "kp2", status: "success", decision: "rejected" },
    { run_id: "p3", dedup_key: "kp3", status: "failed" },
    { run_id: "p4", dedup_key: "kp4", status: "success", roadmap: "recurred" },
  ];
  for (const o of outcomes) {
    state.precisionDispatches.push({
      tenant_id: TENANT_A, source_agent_slug: "pm", target_agent_slug: "engineer",
      target_run_id: o.run_id, dedup_key: o.dedup_key, created_at: "2026-06-01T00:00:00.000Z",
    });
    state.agentRuns.push({ id: o.run_id, tenant_id: TENANT_A, status: o.status, agent_slug: "engineer" });
    if (o.decision) state.precisionDecisions.push({ tenant_id: TENANT_A, agent_run_id: o.run_id, status: o.decision });
    if (o.roadmap) state.precisionRoadmap.push({ tenant_id: TENANT_A, dedup_key: o.dedup_key, outcome: o.roadmap });
  }
}

beforeEach(() => {
  reset();
  state.agentRuns.push({
    id: CITED_RUN, tenant_id: TENANT_A, agent_slug: "engineer", error: "missing repo_hint",
    finished_at: "2026-05-01T00:00:00.000Z", status: "success",
  });
});

describe("precision gate — downgrade to recommend-for-approval", () => {
  it("LOW precision → cap 0, item moved to recommended_actions_not_dispatched with needs_go:true, NO dispatch", async () => {
    state.precisionFlag = true;
    seedBadPrecision();
    const parsed = productPmBacklogSchema.parse(makeDispatchableBrief());
    const { brief, dispatched } = await processProductPmBacklog(ctx(), parsed);
    expect(dispatched).toHaveLength(0);
    expect(brief.dispatched_actions).toHaveLength(0);
    const rec = brief.recommended_actions_not_dispatched.find((r) => r.item_id === "i1");
    expect(rec).toBeTruthy();
    expect(rec!.needs_go).toBe(true);
    expect(brief.rendered_markdown).toContain("Auto-dispatch paused");
    const { enqueueAgentRun } = await import("@/services/agents/runner");
    expect((enqueueAgentRun as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it("HIGH precision → normal auto-dispatch (cap 3), item dispatched, no needs_go banner", async () => {
    state.precisionFlag = true;
    for (let i = 1; i <= 4; i++) {
      state.precisionDispatches.push({
        tenant_id: TENANT_A, source_agent_slug: "pm", target_agent_slug: "engineer",
        target_run_id: `g${i}`, dedup_key: `kg${i}`, created_at: "2026-06-01T00:00:00.000Z",
      });
      state.agentRuns.push({ id: `g${i}`, tenant_id: TENANT_A, status: "success", agent_slug: "engineer" });
      state.precisionDecisions.push({ tenant_id: TENANT_A, agent_run_id: `g${i}`, status: "acted" });
    }
    const parsed = productPmBacklogSchema.parse(makeDispatchableBrief());
    const { brief, dispatched } = await processProductPmBacklog(ctx(), parsed);
    expect(dispatched).toHaveLength(1);
    expect(brief.rendered_markdown).not.toContain("Auto-dispatch paused");
  });

  it("flag OFF (kill switch) → no precision read, normal dispatch even with bad history", async () => {
    state.precisionFlag = false;
    seedBadPrecision();
    const parsed = productPmBacklogSchema.parse(makeDispatchableBrief());
    const { dispatched } = await processProductPmBacklog(ctx(), parsed);
    expect(dispatched).toHaveLength(1);
  });

  it("thin history (no settled sample) → no downgrade, normal dispatch", async () => {
    state.precisionFlag = true;
    const parsed = productPmBacklogSchema.parse(makeDispatchableBrief());
    const { dispatched } = await processProductPmBacklog(ctx(), parsed);
    expect(dispatched).toHaveLength(1);
    const { writeNote } = await import("@/services/memory");
    const titles = (writeNote as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => (c[1] as { title?: string }).title ?? "");
    expect(titles.filter((t) => t.startsWith("pm dispatch"))).toHaveLength(0);
  });
});

describe("three-tier pricing — engineer not on the tenant's plan", () => {
  it("does not fail the pm run: item skipped as plan_upgrade_required, recommended, noted once", async () => {
    state.precisionFlag = false;
    const { enqueueAgentRun } = await import("@/services/agents/runner");
    (enqueueAgentRun as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(
      Object.assign(new Error("Engineer needs the Pro plan ($240/mo)."), {
        code: "plan_upgrade_required",
        agent_slug: "engineer",
        required_tier: "pro",
        body: {},
      }),
    );
    const parsed = productPmBacklogSchema.parse(makeDispatchableBrief());
    const { brief, dispatched, skipped } = await processProductPmBacklog(ctx(), parsed);
    expect(dispatched).toHaveLength(0);
    expect(skipped).toContainEqual({ item_id: "i1", reason: "plan_upgrade_required" });
    const rec = brief.recommended_actions_not_dispatched.find((r) => r.item_id === "i1");
    expect(rec).toBeTruthy();
    expect(brief.rendered_markdown).toContain("Engineer needs the Pro plan ($240/mo).");
    expect(brief.rendered_markdown).toContain("Billing page");
  });
});
