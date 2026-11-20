import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { agentRuns: Record<string, unknown>[] } = { agentRuns: [] };

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
      data: { repo_full_names: [], default_repo_full_name: null },
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
import { productPmBacklogSchema } from "../output-schema";
import type { AgentContext } from "@/services/agents/types";

const TENANT = "aaaaaaaa-2222-2222-2222-222222222222";

function ctx(): AgentContext {
  return {
    tenant_id: TENANT,
    runId: "run_spec_test",
    trigger: "a2a",
    agent: { slug: "pm", metadata_praxis: {} },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
  } as unknown as AgentContext;
}

const base = {
  rendered_markdown: "Product PRD for the from-scratch build.",
  summary: { bullets: ["build the MVP"] },
  dispatched_actions: [] as unknown[],
  recommended_actions_not_dispatched: [] as unknown[],
  sources_all: [] as unknown[],
  snapshot_run_id: "pending",
};

function backlogItem(over: Record<string, unknown> = {}) {
  return {
    item_id: "i1",
    theme: "auth and signup flow",
    theme_normalized: "auth-and-signup-flow",
    problem: "the app needs an email/password signup flow",
    proposed_fix: "scaffold a signup form wired to the auth provider",
    target: "frontend",
    code_reach: 0,
    code_confidence: 0,
    impact: "high",
    effort: "medium",
    rice_score: 0,
    reasoning: "core to the MVP",
    evidence_sources: [] as unknown[],
    ...over,
  };
}

describe("build_app spec — empty evidence_sources is allowed", () => {
  beforeEach(() => {
    state.agentRuns = [];
  });

  it("schema PARSES a backlog item with empty evidence_sources (no hard-fail)", () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [backlogItem()],
    };
    const parsed = productPmBacklogSchema.safeParse(brief);
    expect(parsed.success).toBe(true);
  });

  it("build_app spec run KEEPS the empty-evidence backlog item", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [backlogItem()] as unknown[],
    };
    const { brief: out, skipped } = await processProductPmBacklog(
      ctx(),
      brief as never,
      { isBuildAppSpec: true },
    );
    expect(out.backlog).toHaveLength(1);
    expect(out.backlog[0].item_id).toBe("i1");
    expect(skipped.find((s) => s.reason === "ungrounded_item")).toBeUndefined();
    expect(out.status).toBe("actionable");
  });
});

describe("ops pm run — empty evidence_sources is STILL rejected", () => {
  beforeEach(() => {
    state.agentRuns = [];
  });

  it("non-build_app run DROPS the empty-evidence backlog item (guard preserved)", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [backlogItem()] as unknown[],
    };
    const { brief: out, skipped } = await processProductPmBacklog(
      ctx(),
      brief as never,
      { isBuildAppSpec: false },
    );
    expect(out.backlog).toHaveLength(0);
    expect(skipped.find((s) => s.reason === "ungrounded_item")).toBeDefined();
    expect(out.status).toBe("no_signal");
  });

  it("default opts (no isBuildAppSpec) behaves as an ops run — drops it", async () => {
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [backlogItem()] as unknown[],
    };
    const { brief: out, skipped } = await processProductPmBacklog(
      ctx(),
      brief as never,
    );
    expect(out.backlog).toHaveLength(0);
    expect(skipped.find((s) => s.reason === "ungrounded_item")).toBeDefined();
  });
});
