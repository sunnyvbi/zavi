import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ME = "dev:laptop";
const OTHER = "canonical";
const CR_THEIRS = "00000000-0000-4000-8000-0000000000b2";
const CR_MINE = "00000000-0000-4000-8000-0000000000b1";

const h = vi.hoisted(() => ({
  ownerOnly: true,
  blocked: [] as Array<Record<string, unknown>>,
  queued: [] as Array<Record<string, unknown>>,
  active: [] as Array<Record<string, unknown>>,
  conductors: [] as Array<Record<string, unknown>>,
  failedWrites: [] as string[],
  cancelled: [] as string[],
}));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/team-notes/emit-run-end", () => ({ emitTeamNoteRunEnd: vi.fn(async () => {}) }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("svc is injected");
  },
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: async (key: string) => (key === "conductor_owner_only" ? h.ownerOnly : true),
}));

import { reapStaleRuns } from "@/services/agents/stale-run-reaper";

type Trace = { table: string; ops: Array<[string, unknown[]]> };
const eqOf = (t: Trace, col: string) => t.ops.find(([o, a]) => o === "eq" && a[0] === col)?.[1][1];

function route(t: Trace): { data: unknown; error: null } {
  const update = t.ops.find(([o]) => o === "update")?.[1][0] as { status?: string } | undefined;
  if (t.table === "agent_runs" && update) {
    if (update.status === "failed") h.failedWrites.push(eqOf(t, "id") as string);
    return { data: [{ id: eqOf(t, "id") }], error: null };
  }
  if (t.table === "agent_runs" && eqOf(t, "status") === "blocked") return { data: h.blocked, error: null };
  if (t.table === "agent_runs" && eqOf(t, "status") === "queued") return { data: h.queued, error: null };
  if (t.table === "conductor_runs" && eqOf(t, "status") === "active") return { data: h.active, error: null };
  if (t.table === "conductor_runs") return { data: t.ops.some(([o]) => o === "in") ? h.conductors : [], error: null };
  return { data: [], error: null };
}

function makeSvc() {
  return {
    from: (table: string) => {
      const trace: Trace = { table, ops: [] };
      const b: Record<string, unknown> = new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === "then") return (res: (v: unknown) => unknown) => res(route(trace));
            return (...args: unknown[]) => {
              trace.ops.push([prop, args]);
              return b;
            };
          },
        },
      );
      return b;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "cancel_conductor_run") {
        h.cancelled.push(args.p_conductor_run_id as string);
        return { data: { cancelled: true, stopped_children: 0 }, error: null };
      }
      return { data: null, error: null };
    },
  } as never;
}

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const run = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  tenant_id: "t1",
  agent_slug: "engineer",
  blocked_by_run_id: null,
  payload: {},
  trigger: "a2a",
  worker_id: null,
  ...over,
});
const graphOwnedBy = (owner: string | null) => [
  { id: "n", status: "dispatched", child_run_id: null, payload: owner ? { owner_worker: owner } : {} },
];

beforeEach(() => {
  vi.stubEnv("PRAXIS_CONTAINER_ROLE", "");
  vi.stubEnv("HOSTNAME", "laptop");
  h.ownerOnly = true;
  h.blocked = [];
  h.queued = [];
  h.active = [];
  h.conductors = [
    { id: CR_THEIRS, status: "active", goal_graph: graphOwnedBy(OTHER) },
    { id: CR_MINE, status: "active", goal_graph: graphOwnedBy(ME) },
  ];
  h.failedWrites.length = 0;
  h.cancelled.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("stale-run-reaper leaves another worker's runs alone", () => {
  it("does not reap a stale blocked run whose own worker_id is another worker", async () => {
    h.blocked = [run("b-theirs", { worker_id: OTHER }), run("b-mine", { worker_id: ME }), run("b-legacy")];
    await reapStaleRuns(makeSvc(), undefined, NOW);
    expect(h.failedWrites.sort()).toEqual(["b-legacy", "b-mine"]);
  });

  it("does not reap a stale queued run of another worker or of another worker's conductor", async () => {
    h.queued = [
      run("q-theirs", { worker_id: OTHER }),
      run("q-conductor-theirs", { payload: { build_conductor_run_id: CR_THEIRS } }),
      run("q-conductor-mine", { payload: { build_conductor_run_id: CR_MINE } }),
      run("q-legacy"),
    ];
    await reapStaleRuns(makeSvc(), undefined, NOW);
    expect(h.failedWrites.sort()).toEqual(["q-conductor-mine", "q-legacy"]);
  });

  it("does not reap a wedged conductor run another worker owns; reaps its own and unstamped ones", async () => {
    h.active = [
      { id: CR_THEIRS, tenant_id: "t1", goal_graph: graphOwnedBy(OTHER) },
      { id: CR_MINE, tenant_id: "t1", goal_graph: graphOwnedBy(ME) },
      { id: "cr-legacy", tenant_id: "t1", goal_graph: graphOwnedBy(null) },
    ];
    await reapStaleRuns(makeSvc(), undefined, NOW);
    expect(h.cancelled.sort()).toEqual(["cr-legacy", CR_MINE].sort());
  });

  it("conductor_owner_only off restores today's behaviour (guard)", async () => {
    h.ownerOnly = false;
    h.blocked = [run("b-theirs", { worker_id: OTHER })];
    h.queued = [run("q-conductor-theirs", { payload: { build_conductor_run_id: CR_THEIRS } })];
    h.active = [{ id: CR_THEIRS, tenant_id: "t1", goal_graph: graphOwnedBy(OTHER) }];
    await reapStaleRuns(makeSvc(), undefined, NOW);
    expect(h.failedWrites.sort()).toEqual(["b-theirs", "q-conductor-theirs"]);
    expect(h.cancelled).toEqual([CR_THEIRS]);
  });
});
