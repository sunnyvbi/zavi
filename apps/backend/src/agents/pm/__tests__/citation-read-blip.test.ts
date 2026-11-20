import { describe, it, expect, vi, beforeEach } from "vitest";

const state: {
  agentRuns: Record<string, unknown>[];
  failCitationRead: boolean;
} = { agentRuns: [], failCitationRead: false };

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
      then: (resolve: (x: { data: unknown; error: unknown }) => void) =>
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
      if (state.failCitationRead) {
        return { data: null, error: { message: "transient connection reset" } };
      }
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
import { enqueueAgentRun } from "@/services/agents/runner";
import type { AgentContext } from "@/services/agents/types";

const TENANT = "aaaaaaaa-1111-1111-1111-111111111111";
const RUN_A = "ffffffff-0000-0000-0000-00000000000a";

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
  rendered_markdown: "Here is the backlog summary, dispatching the top item.",
  summary: { bullets: ["b"] },
  dispatched_actions: [] as unknown[],
  recommended_actions_not_dispatched: [] as unknown[],
  sources_all: [] as unknown[],
  snapshot_run_id: "run_x",
};

function backlogItem(over: Record<string, unknown> = {}) {
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

describe("Fix #1 — transient citation-lookup failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.agentRuns = [];
    state.failCitationRead = false;
  });

  it("sets insufficient_data + retry copy + citation_lookup_failed, and dispatches nothing", async () => {
    state.failCitationRead = true;
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [backlogItem()] as unknown[],
    };
    const { brief: out, skipped } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
    );
    expect(out.status).toBe("insufficient_data");
    expect(out.status).not.toBe("no_signal");
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    const md = out.rendered_markdown ?? "";
    expect(md).toMatch(/transient/i);
    expect(md).toMatch(/retry/i);
    expect(skipped).toContainEqual({ item_id: "i1", reason: "citation_lookup_failed" });
    expect(skipped).not.toContainEqual({ item_id: "i1", reason: "citation_invalid" });
  });

  it("control — a genuinely invalid citation (read OK, id absent) still drops to no_signal", async () => {
    state.failCitationRead = false;
    state.agentRuns = [];
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [backlogItem()] as unknown[],
    };
    const { brief: out, skipped } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
    );
    expect(out.status).toBe("no_signal");
    expect(skipped).toContainEqual({ item_id: "i1", reason: "citation_invalid" });
    expect(skipped).not.toContainEqual({ item_id: "i1", reason: "citation_lookup_failed" });
  });

  it("control — a valid citation survives the citation filter (not dropped)", async () => {
    state.failCitationRead = false;
    state.agentRuns = [
      {
        id: RUN_A,
        tenant_id: TENANT,
        agent_slug: "engineer",
        error: null,
        parsed: { summary: "checkout funnel conversion regression in the payment step" },
      },
    ];
    const brief = {
      ...base,
      status: "actionable" as const,
      backlog: [backlogItem()] as unknown[],
    };
    const { brief: out, skipped } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(brief)) as never,
    );
    expect(out.status).not.toBe("insufficient_data");
    expect(skipped).not.toContainEqual({ item_id: "i1", reason: "citation_invalid" });
    expect(skipped).not.toContainEqual({ item_id: "i1", reason: "citation_lookup_failed" });
  });
});
