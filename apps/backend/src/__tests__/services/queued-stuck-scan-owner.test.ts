import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ME = "dev:laptop";
const OTHER = "canonical";
const CR_MINE = "00000000-0000-4000-8000-0000000000a1";
const CR_THEIRS = "00000000-0000-4000-8000-0000000000a2";
const CR_LEGACY = "00000000-0000-4000-8000-0000000000a3";
const CR_DONE = "00000000-0000-4000-8000-0000000000a4";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  ownerOnly: true,
  early: [] as Array<Record<string, unknown>>,
  queued: [] as Array<Record<string, unknown>>,
  chatRunning: [] as Array<Record<string, unknown>>,
  infra: [] as Array<Record<string, unknown>>,
  conductors: [] as Array<Record<string, unknown>>,
  reapUpdates: [] as string[],
  sends: [] as Array<Record<string, unknown>>,
  infraRetried: [] as string[],
}));

type Trace = { table: string; ops: Array<[string, unknown[]]> };
const has = (t: Trace, op: string, ...args: unknown[]) =>
  t.ops.some(([o, a]) => o === op && args.every((x, i) => JSON.stringify(a[i]) === JSON.stringify(x)));

function route(t: Trace): { data: unknown; error: null } {
  if (t.table === "conductor_runs") return { data: h.conductors, error: null };
  if (t.table !== "agent_runs") return { data: [], error: null };
  if (has(t, "update")) {
    const id = t.ops.find(([o, a]) => o === "eq" && a[0] === "id")?.[1][1] as string;
    const patch = t.ops.find(([o]) => o === "update")?.[1][0] as { status?: string } | undefined;
    if (patch?.status === "failed") h.reapUpdates.push(id);
    return { data: [{ id }], error: null };
  }
  if (has(t, "eq", "needs_run_end_emit")) return { data: [], error: null };
  if (has(t, "eq", "status", "queued") && has(t, "in", "trigger", ["chat", "mcp"])) return { data: h.early, error: null };
  if (has(t, "eq", "status", "queued")) return { data: h.queued, error: null };
  if (has(t, "eq", "status", "running") && t.ops.some(([o]) => o === "in")) return { data: h.chatRunning, error: null };
  if (has(t, "eq", "status", "running")) return { data: [], error: null };
  if (has(t, "in", "status", ["dispatch_error", "failed"]) && has(t, "is", "last_progress_at")) {
    return { data: h.infra, error: null };
  }
  return { data: [], error: null };
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
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
    rpc: async () => ({ data: [], error: null }),
  }),
}));

vi.mock("../../../workers/client", () => ({
  inngest: {
    createFunction: (_c: unknown, _t: unknown, handler: unknown) => ({ handler }),
    send: async (e: Record<string, unknown>) => {
      h.sends.push(e);
      return { ids: [] };
    },
  },
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: async (key: string) => (key === "conductor_owner_only" ? h.ownerOnly : true),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/agents/thread-event", () => ({ emitThreadEvent: vi.fn(async () => {}) }));
vi.mock("@/services/agents/custom-agent-runs", () => ({ settleCustomAgentAltTerminal: vi.fn(async () => {}) }));
vi.mock("@/services/agents/batch-fanout-rollup", () => ({
  recordChildTerminalAndCheckBatch: vi.fn(async () => ({ batch_complete: true })),
}));
vi.mock("@/services/agents/infra-retry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/infra-retry")>()),
  tryInfraRetryRun: vi.fn(async (_s: unknown, _i: unknown, row: { id: string }) => {
    h.infraRetried.push(row.id);
    return true;
  }),
}));

import { queuedStuckScanFn } from "../../../workers/functions/queued-stuck-scan";

type Handler = (ctx: { logger: { info: () => void; warn: () => void; error: () => void } }) => Promise<unknown>;
const scan = () =>
  (queuedStuckScanFn as unknown as { handler: Handler }).handler({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

const stamped = (owner: string | null) => [{ id: "n", payload: owner ? { owner_worker: owner } : {} }];
const old = new Date(Date.now() - 3 * 3600_000).toISOString();
const queuedRow = (id: string, over: Row = {}) => ({
  id,
  tenant_id: "t1",
  agent_slug: "engineer",
  trigger: "a2a",
  batch_id: null,
  worker_id: null,
  conductor_run_id: null,
  ...over,
});
const resentIds = () =>
  h.sends.filter((e) => e.name === "agent.run.requested").map((e) => (e.data as { run_id: string }).run_id);

beforeEach(() => {
  vi.stubEnv("PRAXIS_CONTAINER_ROLE", "");
  vi.stubEnv("HOSTNAME", "laptop");
  h.ownerOnly = true;
  h.early = [];
  h.queued = [];
  h.chatRunning = [];
  h.infra = [];
  h.reapUpdates.length = 0;
  h.sends.length = 0;
  h.infraRetried.length = 0;
  h.conductors = [
    { id: CR_MINE, status: "active", goal_graph: stamped(ME) },
    { id: CR_THEIRS, status: "active", goal_graph: stamped(OTHER) },
    { id: CR_LEGACY, status: "active", goal_graph: stamped(null) },
    { id: CR_DONE, status: "failed", goal_graph: stamped(null) },
  ];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("queued-stuck-scan on the deployed server", () => {
  it("is skipped on a laptop", async () => {
    h.queued = [queuedRow("mine", { worker_id: ME })];
    expect(await scan()).toEqual({ skipped: "not_canonical" });
    expect(resentIds()).toEqual([]);
  });

  it("re-sends a stuck queued run whoever claimed it, laptop runs included", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
    h.queued = [
      queuedRow("laptop", { worker_id: ME }),
      queuedRow("canonical", { worker_id: OTHER }),
      queuedRow("unclaimed"),
      queuedRow("child-of-laptop-build", { conductor_run_id: CR_MINE }),
    ];
    await scan();
    expect(resentIds().sort()).toEqual(["canonical", "child-of-laptop-build", "laptop", "unclaimed"]);
  });
});
