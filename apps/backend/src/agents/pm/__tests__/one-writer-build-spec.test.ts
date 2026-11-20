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
vi.mock("@/services/connectors/github/scoped-repos", () => ({
  getScopedRepoFullNames: vi.fn(async () => ["acme/storefront"]),
}));
const precisionState = vi.hoisted(() => ({ on: false }));
vi.mock("../precision-flag", () => ({
  isPmPrecisionGateEnabled: vi.fn(async () => precisionState.on),
}));
vi.mock("../precision", () => ({
  computeDispatchPrecision: vi.fn(async () => ({
    precision: 0.25,
    good: 1,
    settled: 4,
    downgrade: true,
  })),
}));

import { processProductPmBacklog } from "../post-run";
import type { AgentContext } from "@/services/agents/types";
import { enqueueAgentRun } from "@/services/agents/runner";

const TENANT = "aaaaaaaa-3333-3333-3333-333333333333";
const REPO = "acme/storefront";

function ctx(): AgentContext {
  return {
    tenant_id: TENANT,
    runId: "run_one_writer",
    trigger: "a2a",
    agent: { slug: "pm", metadata_praxis: {} },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
  } as unknown as AgentContext;
}

function threeItems(withEvidence: boolean) {
  return [1, 2, 3].map((n) => ({
    item_id: `i${n}`,
    theme: `slice ${n}`,
    theme_normalized: `slice-${n}`,
    problem: `the product needs part ${n}`,
    proposed_fix: `build part ${n}`,
    target: "backend",
    code_reach: 0,
    code_confidence: 0,
    impact: "high",
    effort: "low",
    rice_score: 10 - n,
    reasoning: "load-bearing for v1",
    evidence_sources: withEvidence
      ? [{ agent_run_id: "bbbbbbbb-1111-1111-1111-111111111111", summary: "prior run" }]
      : [],
  }));
}

function dispatches() {
  return [1, 2, 3].map((n) => ({
    item_id: `i${n}`,
    target_agent_slug: "engineer",
    task_description: `Build part ${n} of the product.`,
    repo_hint: REPO,
    file_hints: [`src/part${n}.ts`],
  }));
}

function brief(withEvidence: boolean) {
  return {
    status: "actionable" as const,
    rendered_markdown: "# Spec\n\nThe product, its routes and its data model.",
    summary: { bullets: ["build v1"] },
    backlog: threeItems(withEvidence),
    dispatched_actions: dispatches(),
    recommended_actions_not_dispatched: [] as unknown[],
    sources_all: [] as unknown[],
    snapshot_run_id: "pending",
  };
}

describe("one writer — a build spec dispatches nothing", () => {
  beforeEach(() => {
    state.agentRuns = [];
    precisionState.on = false;
    vi.mocked(enqueueAgentRun).mockClear();
  });

  it("holds ALL dispatches on a build-spec run and enqueues no engineer", async () => {
    const { brief: out, skipped } = await processProductPmBacklog(
      ctx(),
      brief(false) as never,
      { isBuildAppSpec: true },
    );

    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(out.dispatched_actions).toHaveLength(0);
    expect(skipped.filter((s) => s.reason === "build_spec_conductor_owns_build"))
      .toHaveLength(3);
    expect(out.rendered_markdown).toContain("data model");
    expect(out.backlog.length).toBeGreaterThan(0);
  });

  it("does NOT recommend the held items — they are the conductor's plan, not a menu", async () => {
    const { brief: out } = await processProductPmBacklog(
      ctx(),
      brief(false) as never,
      { isBuildAppSpec: true },
    );
    expect(out.recommended_actions_not_dispatched).toHaveLength(0);
  });

  it("keeps the precision banner OUT of the spec — it would be false, and the spec is the build input", async () => {
    precisionState.on = true;
    const { brief: out } = await processProductPmBacklog(
      ctx(),
      brief(false) as never,
      { isBuildAppSpec: true },
    );
    expect(out.rendered_markdown).not.toContain("Auto-dispatch paused");
    expect(out.rendered_markdown).toContain("data model");
  });

  it("FALSIFIER: the SAME downgrade still banners an ops run", async () => {
    precisionState.on = true;
    state.agentRuns = [
      {
        id: "bbbbbbbb-1111-1111-1111-111111111111",
        tenant_id: TENANT,
        agent_slug: "support-lead",
        error: null,
        output_text:
          "the product needs part 1, part 2 and part 3 built — slice work for the backend",
      },
    ];
    const { brief: out } = await processProductPmBacklog(
      ctx(),
      brief(true) as never,
      { isBuildAppSpec: false },
    );
    expect(out.rendered_markdown).toContain("Auto-dispatch paused");
  });

  it("FALSIFIER: an ops delivery run still dispatches — pm's job is unchanged", async () => {
    state.agentRuns = [
      {
        id: "bbbbbbbb-1111-1111-1111-111111111111",
        tenant_id: TENANT,
        agent_slug: "support-lead",
        error: null,
        output_text:
          "the product needs part 1, part 2 and part 3 built — slice work for the backend",
      },
    ];
    const { brief: out } = await processProductPmBacklog(
      ctx(),
      brief(true) as never,
      { isBuildAppSpec: false },
    );

    expect(enqueueAgentRun).toHaveBeenCalled();
    expect(out.dispatched_actions.length).toBeGreaterThan(0);
  });
});
