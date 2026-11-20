import { describe, it, expect, vi, beforeEach } from "vitest";

type Captured = { table: string; filters: Record<string, unknown>; op: string; payload?: unknown };

const state: {
  flagEnabled: boolean;
  roadmapRows: Record<string, unknown>[];
  agentRuns: Record<string, unknown>[];
  dispatchHistory: Record<string, unknown>[];
  captured: Captured[];
} = {
  flagEnabled: false,
  roadmapRows: [],
  agentRuns: [],
  dispatchHistory: [],
  captured: [],
};

function reset() {
  state.flagEnabled = false;
  state.roadmapRows = [];
  state.agentRuns = [];
  state.dispatchHistory = [];
  state.captured = [];
}

vi.mock("@/services/supabase", () => {
  function makeBuilder(table: string) {
    const filters: Record<string, unknown> = {};
    const rec: Captured = { table, filters, op: "select" };
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
      upsert: (payload: unknown, opts: unknown) => {
        state.captured.push({ table, filters: { ...filters }, op: "upsert", payload: { payload, opts } });
        return { error: null };
      },
      insert: (payload: unknown) => {
        state.captured.push({ table, filters: { ...filters }, op: "insert", payload });
        return { error: null };
      },
      update: (payload: unknown) => {
        rec.op = "update";
        rec.payload = payload;
        const updBuilder: Record<string, unknown> = {
          eq: (k: string, v: unknown) => {
            filters[k] = v;
            return updBuilder;
          },
          then: undefined,
        };
        (updBuilder as { then: (r: (x: { error: null }) => void) => void }).then = (resolve) => {
          state.captured.push({ table, filters: { ...filters }, op: "update", payload });
          resolve({ error: null });
        };
        return updBuilder;
      },
      maybeSingle: () => resolveQuery(table, filters),
      single: () => resolveQuery(table, filters),
      then: (resolve: (x: { data: unknown; error: null }) => void) => {
        resolve(resolveListQuery(table, filters));
      },
    };
    return builder;
  }
  return {
    serviceClient: () => ({ from: (t: string) => makeBuilder(t) }),
  };
});

function resolveQuery(table: string, filters: Record<string, unknown>): { data: unknown; error: null } {
  state.captured.push({ table, filters: { ...filters }, op: "select-single" });
  if (table === "system_config") {
    return { data: { blob: { pm_roadmap_enabled: state.flagEnabled } }, error: null };
  }
  if (table === "pm_roadmap") {
    const match = state.roadmapRows.find(
      (r) =>
        r.tenant_id === filters.tenant_id &&
        (filters.dedup_key === undefined || r.dedup_key === filters.dedup_key) &&
        (filters.status === undefined || r.status === filters.status),
    );
    return { data: match ?? null, error: null };
  }
  if (table === "agent_runs") {
    const match = state.agentRuns.find(
      (r) => r.tenant_id === filters.tenant_id && (filters.id === undefined || r.id === filters.id),
    );
    return { data: match ?? null, error: null };
  }
  if (table === "dispatch_history") {
    const match = state.dispatchHistory.find(
      (r) => r.tenant_id === filters.tenant_id && r.dedup_key === filters.dedup_key,
    );
    return { data: match ?? null, error: null };
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

function resolveListQuery(table: string, filters: Record<string, unknown>): { data: unknown; error: null } {
  state.captured.push({ table, filters: { ...filters }, op: "select-list" });
  if (table === "pm_roadmap") {
    const rawStatus = filters.status;
    const statuses = Array.isArray(rawStatus)
      ? (rawStatus as string[])
      : typeof rawStatus === "string"
        ? [rawStatus]
        : undefined;
    const rows = state.roadmapRows.filter(
      (r) => r.tenant_id === filters.tenant_id && (!statuses || statuses.includes(r.status as string)),
    );
    return { data: rows, error: null };
  }
  if (table === "agent_runs") {
    const idFilter = filters.id as string[] | undefined;
    if (Array.isArray(idFilter)) {
      const rows = state.agentRuns.filter(
        (r) => r.tenant_id === filters.tenant_id && idFilter.includes(r.id as string),
      );
      return { data: rows.map((r) => ({ id: r.id, agent_slug: r.agent_slug, error: r.error })), error: null };
    }
    const after = filters.finished_at as string | undefined;
    const rows = state.agentRuns.filter(
      (r) =>
        r.tenant_id === filters.tenant_id &&
        (after === undefined || (typeof r.finished_at === "string" && (r.finished_at as string) > after)) &&
        r.error != null,
    );
    return { data: rows.map((r) => ({ error: r.error })), error: null };
  }
  return { data: [], error: null };
}

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: vi.fn(async () => ({ run_id: "11111111-aaaa-bbbb-cccc-000000000001" })),
}));
vi.mock("@/services/memory", () => ({ writeNote: vi.fn(async () => {}) }));

const metricState: { current: number | null } = { current: null };
vi.mock("../roadmap-metric", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../roadmap-metric")>();
  return {
    ...actual,
    rerunBaselineMetric: vi.fn(async () => metricState.current),
  };
});

import { productPmBacklogSchema } from "../output-schema";
import { processProductPmBacklog } from "../post-run";
import { hydrateRoadmap, renderRoadmapBlock, runRecurrenceCheck, runLifecycleFollowThrough, deriveDispatchStage } from "../roadmap";
import type { AgentContext } from "@/services/agents/types";

const TENANT_A = "aaaaaaaa-1111-1111-1111-111111111111";
const TENANT_B = "bbbbbbbb-2222-2222-2222-222222222222";

function ctx(o: Partial<AgentContext> = {}): AgentContext {
  return {
    tenant_id: TENANT_A,
    runId: "run_test",
    trigger: "cron",
    agent: { slug: "pm", metadata_praxis: {} },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    ...o,
  } as unknown as AgentContext;
}

const base = {
  rendered_markdown: "x",
  summary: { bullets: [] as string[] },
  backlog: [] as unknown[],
  dispatched_actions: [] as unknown[],
  recommended_actions_not_dispatched: [] as unknown[],
  sources_all: [] as unknown[],
  snapshot_run_id: "run_x",
};

const CITED_RUN = "ffffffff-0000-0000-0000-000000000001";
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
        problem: "p",
        proposed_fix: "f",
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

beforeEach(() => {
  reset();
  metricState.current = null;
  state.agentRuns.push({
    id: CITED_RUN,
    tenant_id: TENANT_A,
    agent_slug: "engineer",
    error: "missing repo_hint",
    finished_at: "2026-05-01T00:00:00.000Z",
  });
});

describe("roadmap hydration", () => {
  it("flag ON → roadmap rows render into the prompt block", async () => {
    state.flagEnabled = true;
    state.roadmapRows.push({
      tenant_id: TENANT_A,
      dedup_key: "k1",
      theme: "checkout dropoff",
      theme_normalized: "checkout-dropoff",
      status: "in_flight",
      child_run_id: null,
      baseline_signature: null,
      outcome: null,
    });
    const block = await hydrateRoadmap(ctx());
    expect(block).toContain("## Roadmap state (already tracked)");
    expect(block).toContain("checkout dropoff");
    expect(block).toContain("in_flight");
  });

  it("flag OFF → caller never hydrates; renderRoadmapBlock([]) is empty (behavior identical to today)", () => {
    expect(renderRoadmapBlock([])).toBe("");
  });

  it("recurred outcome surfaces as 'prior fix did not hold' framing", () => {
    const block = renderRoadmapBlock([
      {
        id: "r1",
        dedup_key: "k1",
        theme: "payout drift",
        theme_normalized: "payout-drift",
        status: "proposed",
        child_run_id: "c1",
        baseline_signature: "sig",
        outcome: "recurred",
      },
    ]);
    expect(block).toContain("payout drift");
    expect(block).toContain("recurred");
    expect(block).toContain("did NOT hold");
  });
});

describe("roadmap-aware dedup suppression", () => {
  it("flag ON → an in_flight roadmap row suppresses re-dispatch (beyond 24h)", async () => {
    state.flagEnabled = true;
    const { computeDedupKey } = await import("../post-run");
    const dedupKey = computeDedupKey({
      source: "pm",
      target: "engineer",
      target_kind: "backend",
      repo_hint: "rravi149/praxis",
      file_hints: ["apps/backend/src/services/agents/runner.ts"],
    });
    state.roadmapRows.push({
      tenant_id: TENANT_A,
      dedup_key: dedupKey,
      theme: "t",
      theme_normalized: "t",
      status: "in_flight",
      child_run_id: "c1",
      baseline_signature: "missing repo hint",
      outcome: null,
    });
    const { dispatched, skipped } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(makeDispatchableBrief())),
    );
    expect(dispatched).toHaveLength(0);
    expect(skipped.some((s) => s.reason === "deduped_within_24h")).toBe(true);
  });

  it("flag OFF → 24h-only behavior; in_flight roadmap row does NOT suppress (still dispatches)", async () => {
    state.flagEnabled = false;
    const { computeDedupKey } = await import("../post-run");
    const dedupKey = computeDedupKey({
      source: "pm",
      target: "engineer",
      target_kind: "backend",
      repo_hint: "rravi149/praxis",
      file_hints: ["apps/backend/src/services/agents/runner.ts"],
    });
    state.roadmapRows.push({
      tenant_id: TENANT_A,
      dedup_key: dedupKey,
      theme: "t",
      theme_normalized: "t",
      status: "in_flight",
      child_run_id: "c1",
      baseline_signature: "x",
      outcome: null,
    });
    const { dispatched } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(makeDispatchableBrief())),
    );
    expect(dispatched).toHaveLength(1);
  });

  it("always-on: a successful dispatch upserts an in_flight pm_roadmap row with the real child_run_id", async () => {
    state.flagEnabled = false;
    const { dispatched } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(makeDispatchableBrief())),
    );
    expect(dispatched).toHaveLength(1);
    const upsert = state.captured.find((c) => c.table === "pm_roadmap" && c.op === "upsert");
    expect(upsert).toBeTruthy();
    const payload = (upsert!.payload as { payload: Record<string, unknown> }).payload;
    expect(payload.status).toBe("in_flight");
    expect(payload.child_run_id).toBe("11111111-aaaa-bbbb-cccc-000000000001");
    expect(payload.tenant_id).toBe(TENANT_A);
    expect(payload.baseline_signature).toBe("missing repo hint");
  });
});

describe("recurrence transition", () => {
  const ROW = {
    id: "rm1",
    tenant_id: TENANT_A,
    dedup_key: "k1",
    theme: "t",
    status: "in_flight",
    child_run_id: "child1",
    baseline_signature: "boom error sig",
  };

  it("signature GONE after child finished → measured/won", async () => {
    state.roadmapRows.push({ ...ROW });
    state.agentRuns.push({ id: "child1", tenant_id: TENANT_A, finished_at: "2026-05-10T00:00:00.000Z", error: null });
    state.agentRuns.push({ id: "later1", tenant_id: TENANT_A, finished_at: "2026-05-11T00:00:00.000Z", error: "some other unrelated thing" });
    const summary = await runRecurrenceCheck(ctx());
    expect(summary.won).toBe(1);
    expect(summary.recurred).toBe(0);
    const upd = state.captured.find((c) => c.table === "pm_roadmap" && c.op === "update");
    expect((upd!.payload as Record<string, unknown>).status).toBe("measured");
    expect((upd!.payload as Record<string, unknown>).outcome).toBe("won");
  });

  it("signature RECURRED after child finished → proposed/recurred", async () => {
    state.roadmapRows.push({ ...ROW });
    state.agentRuns.push({ id: "child1", tenant_id: TENANT_A, finished_at: "2026-05-10T00:00:00.000Z", error: null });
    state.agentRuns.push({ id: "later1", tenant_id: TENANT_A, finished_at: "2026-05-12T00:00:00.000Z", error: "Boom! Error: sig" });
    const summary = await runRecurrenceCheck(ctx());
    expect(summary.recurred).toBe(1);
    expect(summary.won).toBe(0);
    const upd = state.captured.find((c) => c.table === "pm_roadmap" && c.op === "update");
    expect((upd!.payload as Record<string, unknown>).status).toBe("proposed");
    expect((upd!.payload as Record<string, unknown>).outcome).toBe("recurred");
  });

  it("child run not finished yet → no transition", async () => {
    state.roadmapRows.push({ ...ROW });
    state.agentRuns.push({ id: "child1", tenant_id: TENANT_A, finished_at: null, error: null });
    const summary = await runRecurrenceCheck(ctx());
    expect(summary.won).toBe(0);
    expect(summary.recurred).toBe(0);
  });
});

describe("P1-3 canonical-metric outcome loop", () => {
  it("stamps {baseline_query, baseline_value} on the roadmap row when the run used a named operator_db read", async () => {
    state.flagEnabled = false;
    const traces = [
      {
        name: "operator_db_query_funnel_by_geo_category",
        status: "ok",
        output_preview: JSON.stringify({ data: { rows: [{ book_n: 30 }, { book_n: 20 }] } }),
      },
    ];
    const { dispatched } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(makeDispatchableBrief())),
      { operatorDbTraces: traces },
    );
    expect(dispatched).toHaveLength(1);
    const upsert = state.captured.find((c) => c.table === "pm_roadmap" && c.op === "upsert");
    const payload = (upsert!.payload as { payload: Record<string, unknown> }).payload;
    expect(payload.baseline_query).toBe("query_funnel_by_geo_category");
    expect(payload.baseline_value).toBe(50);
  });

  it("does NOT stamp a baseline when no named operator_db read ran (signature-only loop preserved)", async () => {
    state.flagEnabled = false;
    const { dispatched } = await processProductPmBacklog(
      ctx(),
      JSON.parse(JSON.stringify(makeDispatchableBrief())),
      { operatorDbTraces: [{ name: "operator_db_catalog", status: "ok", output_preview: "{}" }] },
    );
    expect(dispatched).toHaveLength(1);
    const upsert = state.captured.find((c) => c.table === "pm_roadmap" && c.op === "upsert");
    const payload = (upsert!.payload as { payload: Record<string, unknown> }).payload;
    expect(payload.baseline_query).toBeUndefined();
    expect(payload.baseline_value).toBeUndefined();
  });

  it("recurrence re-runs the named query → MOVED when the live value diverged", async () => {
    metricState.current = 200;
    state.roadmapRows.push({
      id: "rm-metric",
      tenant_id: TENANT_A,
      dedup_key: "km",
      theme: "checkout funnel drop",
      status: "in_flight",
      child_run_id: "child1",
      baseline_signature: "boom error sig",
      baseline_query: "query_funnel_by_geo_category",
      baseline_value: 100,
    });
    state.agentRuns.push({ id: "child1", tenant_id: TENANT_A, finished_at: "2026-05-10T00:00:00.000Z", error: null });
    const summary = await runRecurrenceCheck(ctx());
    expect(summary.moved).toBe(1);
    expect(summary.flat).toBe(0);
    expect(summary.metricOutcomes[0]).toMatchObject({
      baseline_query: "query_funnel_by_geo_category",
      baseline_value: 100,
      current_value: 200,
      move: "moved",
    });
  });

  it("recurrence re-runs the named query → FLAT when the live value barely changed", async () => {
    metricState.current = 103;
    state.roadmapRows.push({
      id: "rm-metric2",
      tenant_id: TENANT_A,
      dedup_key: "km2",
      theme: "supply asymmetry",
      status: "in_flight",
      child_run_id: "child1",
      baseline_signature: "boom error sig",
      baseline_query: "query_active_supply_by_geo_category",
      baseline_value: 100,
    });
    state.agentRuns.push({ id: "child1", tenant_id: TENANT_A, finished_at: "2026-05-10T00:00:00.000Z", error: null });
    const summary = await runRecurrenceCheck(ctx());
    expect(summary.flat).toBe(1);
    expect(summary.moved).toBe(0);
  });

  it("no baseline metric on the row → no moved/flat (signature-only)", async () => {
    metricState.current = 999;
    state.roadmapRows.push({
      id: "rm-nometric",
      tenant_id: TENANT_A,
      dedup_key: "kn",
      theme: "t",
      status: "in_flight",
      child_run_id: "child1",
      baseline_signature: "boom error sig",
      baseline_query: null,
      baseline_value: null,
    });
    state.agentRuns.push({ id: "child1", tenant_id: TENANT_A, finished_at: "2026-05-10T00:00:00.000Z", error: null });
    const summary = await runRecurrenceCheck(ctx());
    expect(summary.moved).toBe(0);
    expect(summary.flat).toBe(0);
  });
});

describe("P1-5 dispatch lifecycle follow-through", () => {
  const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  it("surfaces a dispatch stuck > 7d at PR-open as a stuck backlog row", async () => {
    state.roadmapRows.push({
      id: "rm-stuck",
      tenant_id: TENANT_A,
      theme: "your Tuesday fix",
      status: "in_flight",
      child_run_id: "child-stuck",
      last_dispatched_at: EIGHT_DAYS_AGO,
    });
    state.agentRuns.push({
      id: "child-stuck",
      tenant_id: TENANT_A,
      status: "success",
      finished_at: EIGHT_DAYS_AGO,
      parsed: { pr_url: "https://github.com/x/y/pull/1", pr_state: null },
    });
    const summary = await runLifecycleFollowThrough(ctx());
    expect(summary.stuck).toHaveLength(1);
    expect(summary.stuck[0]).toMatchObject({ theme: "your Tuesday fix", stage: "pr_open" });
    expect(summary.stuck[0].days_stuck).toBeGreaterThanOrEqual(7);
    expect(summary.stuck[0].pr_url).toBe("https://github.com/x/y/pull/1");
  });

  it("a MERGED dispatch is terminal — never flagged stuck", async () => {
    state.roadmapRows.push({
      id: "rm-merged",
      tenant_id: TENANT_A,
      theme: "shipped fix",
      status: "in_flight",
      child_run_id: "child-merged",
      last_dispatched_at: EIGHT_DAYS_AGO,
    });
    state.agentRuns.push({
      id: "child-merged",
      tenant_id: TENANT_A,
      status: "success",
      finished_at: EIGHT_DAYS_AGO,
      parsed: { pr_url: "https://github.com/x/y/pull/2", pr_state: "merged", merged: true },
    });
    const summary = await runLifecycleFollowThrough(ctx());
    expect(summary.stuck).toHaveLength(0);
  });

  it("a dispatch younger than 7d is NOT flagged (within window)", async () => {
    state.roadmapRows.push({
      id: "rm-young",
      tenant_id: TENANT_A,
      theme: "fresh fix",
      status: "in_flight",
      child_run_id: "child-young",
      last_dispatched_at: TWO_DAYS_AGO,
    });
    state.agentRuns.push({
      id: "child-young",
      tenant_id: TENANT_A,
      status: "success",
      finished_at: TWO_DAYS_AGO,
      parsed: { pr_url: "https://github.com/x/y/pull/3" },
    });
    const summary = await runLifecycleFollowThrough(ctx());
    expect(summary.stuck).toHaveLength(0);
  });

  it("a closed_unmerged dispatch is a terminal sad-path — not 'stuck in review'", async () => {
    state.roadmapRows.push({
      id: "rm-closed",
      tenant_id: TENANT_A,
      theme: "dead fix",
      status: "in_flight",
      child_run_id: "child-closed",
      last_dispatched_at: EIGHT_DAYS_AGO,
    });
    state.agentRuns.push({
      id: "child-closed",
      tenant_id: TENANT_A,
      status: "success",
      finished_at: EIGHT_DAYS_AGO,
      parsed: { pr_url: "https://github.com/x/y/pull/4", pr_state: "closed_unmerged" },
    });
    const summary = await runLifecycleFollowThrough(ctx());
    expect(summary.stuck).toHaveLength(0);
  });

  it("BUG 1 — a FAILED engineer child with no PR is failed_to_open (terminal) → NOT surfaced as stuck-in-review", async () => {
    state.roadmapRows.push({
      id: "rm-failed",
      tenant_id: TENANT_A,
      theme: "engineer blew up",
      status: "in_flight",
      child_run_id: "child-failed",
      last_dispatched_at: EIGHT_DAYS_AGO,
    });
    state.agentRuns.push({
      id: "child-failed",
      tenant_id: TENANT_A,
      status: "failed",
      finished_at: EIGHT_DAYS_AGO,
      parsed: {},
    });
    const summary = await runLifecycleFollowThrough(ctx());
    expect(summary.stuck).toHaveLength(0);
  });
});

describe("deriveDispatchStage — failed runs never badge engineer_done", () => {
  it("status=failed + no pr_url → failed_to_open (NOT engineer_done)", () => {
    expect(
      deriveDispatchStage({ status: "failed", finished_at: "2026-06-10T00:00:00Z", parsed: {} }),
    ).toBe("failed_to_open");
  });

  it("status=parse_failed + no pr_url → failed_to_open", () => {
    expect(
      deriveDispatchStage({ status: "parse_failed", finished_at: "2026-06-10T00:00:00Z", parsed: {} }),
    ).toBe("failed_to_open");
  });

  it.each(["error", "timeout", "killed"])(
    "status=%s + no pr_url → failed_to_open",
    (status) => {
      expect(
        deriveDispatchStage({ status, finished_at: "2026-06-10T00:00:00Z", parsed: {} }),
      ).toBe("failed_to_open");
    },
  );

  it("status=success + no pr_url STILL → engineer_done", () => {
    expect(
      deriveDispatchStage({ status: "success", finished_at: "2026-06-10T00:00:00Z", parsed: {} }),
    ).toBe("engineer_done");
  });

  it("a failed run that never finished is STILL failed_to_open (terminal beats not-finished→dispatched)", () => {
    expect(
      deriveDispatchStage({ status: "failed", finished_at: null, parsed: {} }),
    ).toBe("failed_to_open");
  });

  it("PR fields still win over status — a merged/open PR ignores a stale failed status", () => {
    expect(
      deriveDispatchStage({ status: "failed", finished_at: null, parsed: { pr_state: "merged" } }),
    ).toBe("merged");
    expect(
      deriveDispatchStage({ status: "failed", finished_at: null, parsed: { pr_url: "https://github.com/x/y/pull/1" } }),
    ).toBe("pr_open");
  });
});

describe("Bundle C — acceptance_criteria + edge_cases schema", () => {
  function dispatchedWith(extra: Record<string, unknown>) {
    const b = makeDispatchableBrief();
    b.dispatched_actions[0] = { ...b.dispatched_actions[0], ...extra };
    return b;
  }

  it("valid arrays pass; default to [] when omitted", () => {
    const omitted = productPmBacklogSchema.safeParse(makeDispatchableBrief());
    expect(omitted.success).toBe(true);
    if (omitted.success) {
      expect(omitted.data.dispatched_actions[0].acceptance_criteria).toEqual([]);
      expect(omitted.data.dispatched_actions[0].edge_cases).toEqual([]);
    }
    const valid = productPmBacklogSchema.safeParse(
      dispatchedWith({ acceptance_criteria: ["tests green", "no parse_failed"], edge_cases: ["empty hints"] }),
    );
    expect(valid.success).toBe(true);
  });

  it("non-array acceptance_criteria → strict parse FAILS cleanly (prose_fallback path, no throw)", () => {
    const r = productPmBacklogSchema.safeParse(dispatchedWith({ acceptance_criteria: "not an array" }));
    expect(r.success).toBe(false);
  });

  it(">8 items → strict parse FAILS", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `c${i}`);
    expect(productPmBacklogSchema.safeParse(dispatchedWith({ acceptance_criteria: nine })).success).toBe(false);
  });

  it(">300-char item → strict parse FAILS", () => {
    const long = ["x".repeat(301)];
    expect(productPmBacklogSchema.safeParse(dispatchedWith({ edge_cases: long })).success).toBe(false);
  });

  it("acceptance_criteria + edge_cases thread into the engineer hand-off context_summary", async () => {
    const { enqueueAgentRun } = await import("@/services/agents/runner");
    state.flagEnabled = false;
    const brief = makeDispatchableBrief();
    brief.dispatched_actions[0] = {
      ...brief.dispatched_actions[0],
      acceptance_criteria: ["pm tests stay green"],
      edge_cases: ["tenant with no connected repo"],
    } as typeof brief.dispatched_actions[0];
    const parsed = productPmBacklogSchema.parse(brief);
    await processProductPmBacklog(ctx(), parsed);
    const calls = (enqueueAgentRun as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const last = calls[calls.length - 1][0] as { payload: { context_summary: string } };
    expect(last.payload.context_summary).toContain("Acceptance criteria:");
    expect(last.payload.context_summary).toContain("pm tests stay green");
    expect(last.payload.context_summary).toContain("Edge cases:");
    expect(last.payload.context_summary).toContain("tenant with no connected repo");
  });
});

describe("cross-tenant isolation", () => {
  it("a pm run for tenant A never reads tenant B's pm_roadmap rows", async () => {
    state.flagEnabled = true;
    state.roadmapRows.push({
      tenant_id: TENANT_B,
      dedup_key: "kB",
      theme: "tenant B secret theme",
      theme_normalized: "b",
      status: "in_flight",
      child_run_id: null,
      baseline_signature: null,
      outcome: null,
    });
    const block = await hydrateRoadmap(ctx({ tenant_id: TENANT_A }));
    expect(block).toBe("");
    expect(block).not.toContain("tenant B secret theme");
    const reads = state.captured.filter((c) => c.table === "pm_roadmap");
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(r.filters.tenant_id).toBe(TENANT_A);
    }
  });

  it("the roadmap upsert on dispatch is tenant-scoped to the run's tenant", async () => {
    state.flagEnabled = false;
    await processProductPmBacklog(ctx({ tenant_id: TENANT_A }), JSON.parse(JSON.stringify(makeDispatchableBrief())));
    const upsert = state.captured.find((c) => c.table === "pm_roadmap" && c.op === "upsert");
    const payload = (upsert!.payload as { payload: Record<string, unknown> }).payload;
    expect(payload.tenant_id).toBe(TENANT_A);
    expect(payload.tenant_id).not.toBe(TENANT_B);
  });
});
