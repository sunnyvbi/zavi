import { describe, it, expect, vi, beforeEach } from "vitest";

type Captured = { table: string; filters: Record<string, unknown>; op: string };

const state: {
  flagEnabled: boolean;
  precisionFlagEnabled: boolean;
  dispatchHistory: Record<string, unknown>[];
  agentRuns: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  roadmapRows: Record<string, unknown>[];
  captured: Captured[];
  forceError: Set<string>;
} = {
  flagEnabled: false,
  precisionFlagEnabled: true,
  dispatchHistory: [],
  agentRuns: [],
  decisions: [],
  roadmapRows: [],
  captured: [],
  forceError: new Set(),
};

function reset() {
  state.flagEnabled = false;
  state.precisionFlagEnabled = true;
  state.dispatchHistory = [];
  state.agentRuns = [];
  state.decisions = [];
  state.roadmapRows = [];
  state.captured = [];
  state.forceError = new Set();
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
      maybeSingle: () => resolveSingle(table, filters),
      single: () => resolveSingle(table, filters),
      then: (resolve: (x: { data: unknown; error: unknown }) => void) => {
        resolve(resolveList(table, filters));
      },
    };
    return builder;
  }
  return { serviceClient: () => ({ from: (t: string) => makeBuilder(t) }) };
});

function err(table: string): { data: null; error: { message: string } } | null {
  return state.forceError.has(table) ? { data: null, error: { message: `forced ${table} error` } } : null;
}

function resolveSingle(table: string, filters: Record<string, unknown>): { data: unknown; error: unknown } {
  state.captured.push({ table, filters: { ...filters }, op: "single" });
  const e = err(table);
  if (e) return e;
  if (table === "system_config") {
    return { data: { blob: { pm_precision_gate_enabled: state.precisionFlagEnabled } }, error: null };
  }
  return { data: null, error: null };
}

function resolveList(table: string, filters: Record<string, unknown>): { data: unknown; error: unknown } {
  state.captured.push({ table, filters: { ...filters }, op: "list" });
  const e = err(table);
  if (e) return e;
  if (table === "dispatch_history") {
    const rows = state.dispatchHistory.filter(
      (r) =>
        r.tenant_id === filters.tenant_id &&
        r.source_agent_slug === filters.source_agent_slug &&
        r.target_agent_slug === filters.target_agent_slug,
    );
    return { data: rows, error: null };
  }
  if (table === "agent_runs") {
    const ids = (filters.id as string[]) ?? [];
    const rows = state.agentRuns.filter((r) => r.tenant_id === filters.tenant_id && ids.includes(r.id as string));
    return { data: rows.map((r) => ({ id: r.id, status: r.status })), error: null };
  }
  if (table === "decisions") {
    const ids = (filters.agent_run_id as string[]) ?? [];
    const rows = state.decisions.filter((r) => r.tenant_id === filters.tenant_id && ids.includes(r.agent_run_id as string));
    return { data: rows.map((r) => ({ agent_run_id: r.agent_run_id, status: r.status })), error: null };
  }
  if (table === "pm_roadmap") {
    const keys = (filters.dedup_key as string[]) ?? [];
    const rows = state.roadmapRows.filter((r) => r.tenant_id === filters.tenant_id && keys.includes(r.dedup_key as string));
    return { data: rows.map((r) => ({ dedup_key: r.dedup_key, outcome: r.outcome })), error: null };
  }
  return { data: [], error: null };
}

import { computeDispatchPrecision, MIN_SETTLED_SAMPLE, PRECISION_THRESHOLD } from "../precision";
import { isPmPrecisionGateEnabled } from "../precision-flag";
import type { AgentContext } from "@/services/agents/types";

const TENANT_A = "aaaaaaaa-1111-1111-1111-111111111111";
const TENANT_B = "bbbbbbbb-2222-2222-2222-222222222222";

function ctx(tenant = TENANT_A): AgentContext {
  return { tenant_id: tenant, runId: "run_test", trigger: "cron", agent: { slug: "pm" } } as unknown as AgentContext;
}

type Outcome = {
  run_id: string;
  dedup_key: string;
  run_status?: string;
  decision_status?: string;
  roadmap_outcome?: "won" | "recurred" | null;
};
function seed(outcomes: Outcome[], tenant = TENANT_A) {
  let n = 0;
  for (const o of outcomes) {
    n += 1;
    state.dispatchHistory.push({
      tenant_id: tenant,
      source_agent_slug: "pm",
      target_agent_slug: "engineer",
      target_run_id: o.run_id,
      dedup_key: o.dedup_key,
      created_at: `2026-06-0${(n % 9) + 1}T00:00:00.000Z`,
    });
    if (o.run_status) state.agentRuns.push({ id: o.run_id, tenant_id: tenant, status: o.run_status });
    if (o.decision_status) state.decisions.push({ tenant_id: tenant, agent_run_id: o.run_id, status: o.decision_status });
    if (o.roadmap_outcome !== undefined) {
      state.roadmapRows.push({ tenant_id: tenant, dedup_key: o.dedup_key, outcome: o.roadmap_outcome });
    }
  }
}

beforeEach(reset);

describe("computeDispatchPrecision — settled verdict classification", () => {
  it("acted decision → good; rejected decision → bad", async () => {
    seed([
      { run_id: "r1", dedup_key: "k1", run_status: "success", decision_status: "acted" },
      { run_id: "r2", dedup_key: "k2", run_status: "success", decision_status: "rejected" },
    ]);
    const p = await computeDispatchPrecision(ctx());
    expect(p.good).toBe(1);
    expect(p.bad).toBe(1);
    expect(p.settled).toBe(2);
    expect(p.precision).toBe(0.5);
  });

  it("roadmap won → good; roadmap recurred → bad (even with no decision row)", async () => {
    seed([
      { run_id: "r1", dedup_key: "k1", run_status: "success", roadmap_outcome: "won" },
      { run_id: "r2", dedup_key: "k2", run_status: "success", roadmap_outcome: "recurred" },
    ]);
    const p = await computeDispatchPrecision(ctx());
    expect(p.good).toBe(1);
    expect(p.bad).toBe(1);
  });

  it("engineer run failed → bad regardless of missing decision/roadmap", async () => {
    seed([{ run_id: "r1", dedup_key: "k1", run_status: "failed" }]);
    const p = await computeDispatchPrecision(ctx());
    expect(p.bad).toBe(1);
    expect(p.good).toBe(0);
  });

  it("reject DOMINATES within a single dispatch (acted + rejected on same child → bad)", async () => {
    state.dispatchHistory.push({
      tenant_id: TENANT_A, source_agent_slug: "pm", target_agent_slug: "engineer",
      target_run_id: "r1", dedup_key: "k1", created_at: "2026-06-01T00:00:00.000Z",
    });
    state.agentRuns.push({ id: "r1", tenant_id: TENANT_A, status: "success" });
    state.decisions.push({ tenant_id: TENANT_A, agent_run_id: "r1", status: "acted" });
    state.decisions.push({ tenant_id: TENANT_A, agent_run_id: "r1", status: "rejected" });
    const p = await computeDispatchPrecision(ctx());
    expect(p.bad).toBe(1);
    expect(p.good).toBe(0);
  });

  it("undecided dispatches (still running / approved / in_flight) are excluded from the denominator", async () => {
    seed([
      { run_id: "r1", dedup_key: "k1", run_status: "success", decision_status: "acted" },
      { run_id: "r2", dedup_key: "k2", run_status: "running" },
      { run_id: "r3", dedup_key: "k3", run_status: "success", decision_status: "approved" },
      { run_id: "r4", dedup_key: "k4", run_status: "success", decision_status: "proposed" },
    ]);
    const p = await computeDispatchPrecision(ctx());
    expect(p.scanned).toBe(4);
    expect(p.settled).toBe(1);
    expect(p.good).toBe(1);
    expect(p.precision).toBe(1);
  });
});

describe("computeDispatchPrecision — downgrade decision", () => {
  it("DOWNGRADES when settled >= MIN_SETTLED_SAMPLE and precision < threshold", async () => {
    seed([
      { run_id: "r1", dedup_key: "k1", run_status: "success", decision_status: "acted" },
      { run_id: "r2", dedup_key: "k2", run_status: "success", decision_status: "rejected" },
      { run_id: "r3", dedup_key: "k3", run_status: "failed" },
      { run_id: "r4", dedup_key: "k4", run_status: "success", roadmap_outcome: "recurred" },
    ]);
    const p = await computeDispatchPrecision(ctx());
    expect(p.settled).toBeGreaterThanOrEqual(MIN_SETTLED_SAMPLE);
    expect(p.precision).toBeLessThan(PRECISION_THRESHOLD);
    expect(p.downgrade).toBe(true);
  });

  it("does NOT downgrade on a thin sample (< MIN_SETTLED_SAMPLE) even at 0% precision", async () => {
    seed([
      { run_id: "r1", dedup_key: "k1", run_status: "failed" },
      { run_id: "r2", dedup_key: "k2", run_status: "success", decision_status: "rejected" },
    ]);
    const p = await computeDispatchPrecision(ctx());
    expect(p.settled).toBeLessThan(MIN_SETTLED_SAMPLE);
    expect(p.precision).toBe(0);
    expect(p.downgrade).toBe(false);
  });

  it("RECOVERS — does NOT downgrade once precision climbs back to/above threshold", async () => {
    seed([
      { run_id: "r1", dedup_key: "k1", run_status: "success", decision_status: "acted" },
      { run_id: "r2", dedup_key: "k2", run_status: "success", roadmap_outcome: "won" },
      { run_id: "r3", dedup_key: "k3", run_status: "failed" },
      { run_id: "r4", dedup_key: "k4", run_status: "success", decision_status: "rejected" },
    ]);
    const p = await computeDispatchPrecision(ctx());
    expect(p.precision).toBe(0.5);
    expect(p.downgrade).toBe(false);
  });

  it("empty history → NEUTRAL (precision null, no downgrade)", async () => {
    const p = await computeDispatchPrecision(ctx());
    expect(p.precision).toBeNull();
    expect(p.settled).toBe(0);
    expect(p.downgrade).toBe(false);
  });
});

describe("computeDispatchPrecision — safety + isolation", () => {
  it("fail-OPEN: a dispatch_history read error returns NEUTRAL (no downgrade)", async () => {
    seed([{ run_id: "r1", dedup_key: "k1", run_status: "failed" }]);
    state.forceError.add("dispatch_history");
    const p = await computeDispatchPrecision(ctx());
    expect(p.downgrade).toBe(false);
    expect(p.precision).toBeNull();
  });

  it("fail-OPEN: a decisions read error returns NEUTRAL", async () => {
    seed([
      { run_id: "r1", dedup_key: "k1", run_status: "success", decision_status: "rejected" },
      { run_id: "r2", dedup_key: "k2", run_status: "failed" },
      { run_id: "r3", dedup_key: "k3", run_status: "failed" },
      { run_id: "r4", dedup_key: "k4", run_status: "failed" },
    ]);
    state.forceError.add("decisions");
    const p = await computeDispatchPrecision(ctx());
    expect(p.downgrade).toBe(false);
  });

  it("tenant-scoped: only reads tenant A's rows; B never leaks into the score", async () => {
    seed([{ run_id: "r1", dedup_key: "k1", run_status: "success", decision_status: "acted" }], TENANT_A);
    seed([
      { run_id: "rb1", dedup_key: "kb1", run_status: "failed" },
      { run_id: "rb2", dedup_key: "kb2", run_status: "failed" },
      { run_id: "rb3", dedup_key: "kb3", run_status: "failed" },
      { run_id: "rb4", dedup_key: "kb4", run_status: "failed" },
    ], TENANT_B);
    const p = await computeDispatchPrecision(ctx(TENANT_A));
    expect(p.good).toBe(1);
    expect(p.bad).toBe(0);
    expect(p.downgrade).toBe(false);
    for (const c of state.captured.filter((c) => c.op === "list")) {
      expect(c.filters.tenant_id).toBe(TENANT_A);
    }
  });
});

describe("isPmPrecisionGateEnabled — default-ON kill switch", () => {
  it("absent key → ON", async () => {
    state.precisionFlagEnabled = undefined as unknown as boolean;
    const enabled = await isPmPrecisionGateEnabled();
    expect(enabled).toBe(true);
  });

  it("explicit false → OFF (kill switch)", async () => {
    state.precisionFlagEnabled = false;
    expect(await isPmPrecisionGateEnabled()).toBe(false);
  });

  it("system_config outage → OFF (safe: no downgrade on an infra blip)", async () => {
    state.forceError.add("system_config");
    expect(await isPmPrecisionGateEnabled()).toBe(false);
  });
});
