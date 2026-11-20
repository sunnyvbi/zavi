import { describe, it, expect, beforeEach, vi } from "vitest";

type Filter = { op: string; col: string; val: unknown };
type Query = { table: string; filters: Filter[] };
type Result = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  respond: (_q: Query): Result => ({ data: [], error: null }),
  rpcs: [] as Array<{ fn: string; args: unknown }>,
  paused: [] as string[],
  destroyed: [] as string[],
}));

vi.mock("@/services/supabase", () => {
  const builder = (table: string) => {
    const q: Query = { table, filters: [] };
    const chain: Record<string, unknown> = {};
    for (const op of ["select", "eq", "neq", "in", "is", "not", "gte", "lte", "limit", "order"]) {
      chain[op] = (col: string, val: unknown) => {
        q.filters.push({ op, col, val });
        return chain;
      };
    }
    chain.then = (res: (r: Result) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(() => state.respond(q)).then(res, rej);
    return chain;
  };
  return {
    serviceClient: () => ({
      from: builder,
      rpc: async (fn: string, args: unknown) => {
        state.rpcs.push({ fn, args });
        return { data: null, error: null };
      },
    }),
  };
});

vi.mock("@/services/sandbox/e2b-client", () => ({
  pauseSandbox: async (id: string) => {
    state.paused.push(id);
  },
  listSandboxes: async () => [],
  destroySandbox: async (id: string) => {
    state.destroyed.push(id);
  },
}));

vi.mock("@/services/sandbox/lifecycle", () => ({
  destroySandboxRow: async (id: string) => {
    state.destroyed.push(id);
  },
}));

vi.mock("@/services/sandbox/engineer-preview", () => ({
  engineerPreviewGloballyEnabled: async () => true,
}));

import { sweepEngineerPreviews } from "../preview-reaper";

const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

function liveEditRow(id: string, tenant_id: string) {
  return {
    id,
    tenant_id,
    repo_full_name: `praxis-built/${tenant_id}`,
    e2b_sandbox_id: `sbx-${id}`,
    status: "active",
    updated_at: longAgo,
    preview_status: "live",
    preview_last_viewed_at: longAgo,
    preview_started_at: longAgo,
    preview_run_id: `live-edit:run-${id}`,
  };
}

function has(q: Query, op: string, col: string, val?: unknown) {
  return q.filters.some((f) => f.op === op && f.col === col && (val === undefined || f.val === val));
}

const isPreviewSelect = (q: Query) => q.table === "tenant_sandbox" && has(q, "not", "preview_run_id");
const isRunningRuns = (q: Query) => q.table === "agent_runs" && has(q, "eq", "status", "running");
const isActiveConductor = (q: Query) => q.table === "conductor_runs" && has(q, "eq", "kind", "build_app");

function tenantsIn(q: Query): string[] {
  const f = q.filters.find((x) => x.op === "in" && x.col === "tenant_id");
  return (f?.val as string[]) ?? [];
}

const logger = { info: () => {} };

beforeEach(() => {
  state.rpcs = [];
  state.paused = [];
  state.destroyed = [];
});

describe("preview-reaper never pauses the shared sandbox while a run or build is using it", () => {
  it("skips a tenant mid live-edit run and a tenant with an active build, pauses and expires the idle one", async () => {
    state.respond = (q) => {
      if (isPreviewSelect(q)) {
        return {
          data: [liveEditRow("row-run", "t-run"), liveEditRow("row-cond", "t-cond"), liveEditRow("row-idle", "t-idle")],
          error: null,
        };
      }
      if (isRunningRuns(q)) return { data: tenantsIn(q).includes("t-run") ? [{ tenant_id: "t-run" }] : [], error: null };
      if (isActiveConductor(q)) {
        return { data: tenantsIn(q).includes("t-cond") ? [{ tenant_id: "t-cond" }] : [], error: null };
      }
      return { data: [], error: null };
    };

    const out = await sweepEngineerPreviews(false, logger);

    expect(state.paused).toEqual(["sbx-row-idle"]);
    expect(state.rpcs).toEqual([
      { fn: "expire_engineer_sandbox_preview", args: { p_id: "row-idle", p_reason: expect.any(String) } },
    ]);
    expect(state.destroyed).toEqual([]);
    expect(out.reaped).toBe(1);
  });

  it("fails closed: a failed running-runs read pauses nothing", async () => {
    state.respond = (q) => {
      if (isPreviewSelect(q)) return { data: [liveEditRow("row-a", "t-a"), liveEditRow("row-b", "t-b")], error: null };
      if (isRunningRuns(q)) return { data: null, error: { message: "statement timeout" } };
      return { data: [], error: null };
    };

    const out = await sweepEngineerPreviews(false, logger);

    expect(state.paused).toEqual([]);
    expect(state.rpcs).toEqual([]);
    expect(out.reaped).toBe(0);
  });

  it("fails closed when the conductor read throws", async () => {
    state.respond = (q) => {
      if (isPreviewSelect(q)) return { data: [liveEditRow("row-a", "t-a")], error: null };
      if (isActiveConductor(q)) throw new Error("socket hang up");
      return { data: [], error: null };
    };

    await sweepEngineerPreviews(false, logger);

    expect(state.paused).toEqual([]);
    expect(state.rpcs).toEqual([]);
  });
});
