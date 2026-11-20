import { describe, it, expect, beforeEach, vi } from "vitest";

type Filter = { op: string; col: string; val: unknown };
type Query = { table: string; filters: Filter[] };
type Result = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  respond: (_q: Query): Result => ({ data: [], error: null }),
  queries: [] as Query[],
  rpcs: [] as Array<{ fn: string; args: unknown }>,
  destroyed: [] as string[],
  killed: [] as string[],
}));

vi.mock("@/services/supabase", () => {
  const builder = (table: string) => {
    const q: Query = { table, filters: [] };
    state.queries.push(q);
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

vi.mock("@/services/sandbox/lifecycle", () => ({
  destroySandboxRow: async (id: string) => {
    state.destroyed.push(id);
  },
}));

vi.mock("@/services/sandbox/e2b-client", () => ({
  listSandboxes: async () => [],
  destroySandbox: async (id: string) => {
    state.killed.push(id);
  },
}));

import { sweepSandboxes } from "../infra-reaper";

const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

function previewRow(id: string, tenant_id: string) {
  return {
    id,
    tenant_id,
    repo_full_name: `praxis-built/${tenant_id}`,
    e2b_sandbox_id: `sbx-${id}`,
    status: "active",
    updated_at: longAgo,
    preview_status: "live",
    preview_last_viewed_at: longAgo,
  };
}

function has(q: Query, op: string, col: string, val?: unknown) {
  return q.filters.some((f) => f.op === op && f.col === col && (val === undefined || f.val === val));
}

function isPreviewSelect(q: Query) {
  return q.table === "tenant_sandbox" && has(q, "eq", "preview_status", "live");
}

function isRunningRuns(q: Query) {
  return q.table === "agent_runs" && has(q, "eq", "status", "running");
}

function isActiveConductor(q: Query) {
  return q.table === "conductor_runs" && has(q, "eq", "kind", "build_app");
}

function tenantsIn(q: Query): string[] {
  const f = q.filters.find((x) => x.op === "in" && x.col === "tenant_id");
  return (f?.val as string[]) ?? [];
}

const logger = { info: () => {} };

beforeEach(() => {
  state.queries = [];
  state.rpcs = [];
  state.destroyed = [];
  state.killed = [];
});

describe("infra-reaper idle-preview sweep never destroys a sandbox a live run or build is using", () => {
  it("skips a tenant with a running engineer run and a tenant with an active build conductor, reaps the idle one", async () => {
    state.respond = (q) => {
      if (isPreviewSelect(q)) {
        return {
          data: [previewRow("row-run", "t-run"), previewRow("row-cond", "t-cond"), previewRow("row-idle", "t-idle")],
          error: null,
        };
      }
      if (isRunningRuns(q)) {
        return { data: tenantsIn(q).includes("t-run") ? [{ tenant_id: "t-run" }] : [], error: null };
      }
      if (isActiveConductor(q)) {
        return { data: tenantsIn(q).includes("t-cond") ? [{ tenant_id: "t-cond" }] : [], error: null };
      }
      return { data: [], error: null };
    };

    const out = await sweepSandboxes(false, logger);

    expect(state.destroyed).toEqual(["row-idle"]);
    expect(state.rpcs).toEqual([{ fn: "clear_sandbox_preview", args: { p_id: "row-idle", p_final_status: "dead" } }]);
    expect(out.reaped).toBe(1);
  });

  it("fails closed: when the running-runs read errors, no preview is cleared or destroyed", async () => {
    state.respond = (q) => {
      if (isPreviewSelect(q)) return { data: [previewRow("row-a", "t-a"), previewRow("row-b", "t-b")], error: null };
      if (isRunningRuns(q)) return { data: null, error: { message: "statement timeout" } };
      return { data: [], error: null };
    };

    const out = await sweepSandboxes(false, logger);

    expect(state.destroyed).toEqual([]);
    expect(state.rpcs).toEqual([]);
    expect(out.reaped).toBe(0);
  });

  it("fails closed when the conductor read errors", async () => {
    state.respond = (q) => {
      if (isPreviewSelect(q)) return { data: [previewRow("row-a", "t-a")], error: null };
      if (isActiveConductor(q)) return { data: null, error: { message: "boom" } };
      return { data: [], error: null };
    };

    await sweepSandboxes(false, logger);

    expect(state.destroyed).toEqual([]);
    expect(state.rpcs).toEqual([]);
  });
});

type RunFixture = { tenant_id: string; agent_slug: string; status: string; started_at: string | null };

function evalRuns(q: Query, table: RunFixture[]) {
  return table.filter((row) =>
    q.filters.every((f) => {
      const v = (row as Record<string, unknown>)[f.col];
      if (f.op === "select" || f.op === "limit") return true;
      if (f.op === "eq") return v === f.val;
      if (f.op === "in") return (f.val as unknown[]).includes(v);
      if (f.op === "gte") return v !== null && v !== undefined && String(v) >= String(f.val);
      throw new Error(`unsupported filter ${f.op} on agent_runs`);
    }),
  );
}

describe("infra-reaper idle-preview sweep only honours running runs that use the preview sandbox", () => {
  it("reaps previews held only by a stuck non-engineer run or a stale engineer run, keeps one with a fresh engineer run", async () => {
    const minsAgo = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString();
    const runs: RunFixture[] = [
      { tenant_id: "t-slack", agent_slug: "support-lead", status: "running", started_at: minsAgo(5) },
      { tenant_id: "t-ops", agent_slug: "operator", status: "running", started_at: minsAgo(1) },
      { tenant_id: "t-stale", agent_slug: "engineer", status: "running", started_at: minsAgo(6 * 60) },
      { tenant_id: "t-null", agent_slug: "engineer", status: "running", started_at: null },
      { tenant_id: "t-done", agent_slug: "engineer", status: "success", started_at: minsAgo(3) },
      { tenant_id: "t-eng", agent_slug: "engineer", status: "running", started_at: minsAgo(10) },
    ];
    state.respond = (q) => {
      if (isPreviewSelect(q)) {
        return {
          data: ["t-slack", "t-ops", "t-stale", "t-null", "t-done", "t-eng"].map((t) => previewRow(`row-${t}`, t)),
          error: null,
        };
      }
      if (q.table === "agent_runs") return { data: evalRuns(q, runs).map((r) => ({ tenant_id: r.tenant_id })), error: null };
      return { data: [], error: null };
    };

    const out = await sweepSandboxes(false, logger);

    expect([...state.destroyed].sort()).toEqual(["row-t-done", "row-t-null", "row-t-ops", "row-t-slack", "row-t-stale"]);
    expect(state.destroyed).not.toContain("row-t-eng");
    expect(state.rpcs.map((r) => (r.args as { p_id: string }).p_id)).not.toContain("row-t-eng");
    expect(out.reaped).toBe(5);
  });
});
