import { describe, it, expect, vi, beforeEach } from "vitest";
import { stageExpectedMs } from "@/services/build/stage-expected";
import { fakeSiteStore, siteRow } from "@/services/sites/__tests__/fake-site-store";

const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  tablesRead: [] as string[],
  store: null as unknown,
  settings: {} as Record<string, boolean>,
  serving: {} as Record<string, string>,
  probes: [] as Array<{ hostname: string; deployId: string; attempts: unknown }>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u", access_token: "tok" }),
}));
vi.mock("@/services/sites/store", () => ({ siteStore: () => h.store }));
vi.mock("@/services/hosting/site-publish", () => ({
  verifySiteDeploy: async (hostname: string, deployId: string, deps: { verifyAttempts?: number }) => {
    h.probes.push({ hostname, deployId, attempts: deps?.verifyAttempts });
    return h.serving[hostname] === deployId ? { ok: true } : { ok: false, error: "mismatch" };
  },
}));
vi.mock("@/services/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...real,
    getBoolSetting: async (key: string) => h.settings[key] ?? true,
  };
});

function chain(resolve: (calls: Array<[string, unknown[]]>) => unknown) {
  const calls: Array<[string, unknown[]]> = [];
  const api: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "or", "order", "gte", "is", "not"]) {
    api[m] = (...a: unknown[]) => {
      calls.push([m, a]);
      return api;
    };
  }
  api.limit = (...a: unknown[]) => {
    calls.push(["limit", a]);
    return resolve(calls);
  };
  api.maybeSingle = () => resolve(calls);
  api.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(calls)).then(ok, bad);
  return api;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      h.tablesRead.push(table);
      if (table === "conductor_runs") {
        return chain((calls) => {
          const id = calls.find(([m, a]) => m === "eq" && a[0] === "id")?.[1][1];
          return { data: id ? h.runs.filter((r) => r.id === id) : h.runs, error: null };
        });
      }
      return chain(() => ({ data: [], error: null }));
    },
  }),
  serviceClient: () => ({ from: () => chain(() => ({ data: null, error: null })), rpc: async () => ({ data: null, error: null }) }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: () => chain(() => ({ data: null, error: null })) }),
}));

import { getAutopilotBuildStatus } from "../autopilot";
import { resetSiteLiveChecks } from "@/services/sites/site-build-status";

const SA = "aaaaaaaa-0000-4000-8000-000000000001";
const SB = "bbbbbbbb-0000-4000-8000-000000000002";
const RA = "a0000000-0000-4000-8000-00000000000a";
const RB = "b0000000-0000-4000-8000-00000000000b";

type N = Record<string, unknown>;
const siteGraph = (site_id: string, deploy: N = { status: "done" }) => [
  { status: "done", payload: { stage: "provision" } },
  { status: "done", payload: { stage: "build", site_id, fast_single_pass: true } },
  { ...deploy, payload: { stage: "deploy", site_id } },
];
const run = (id: string, graph: N[], status = "done") => ({
  id,
  objective: "Build product: X — x",
  status,
  goal_graph: graph,
  spend_usd: 0,
  max_usd: 10,
  created_at: "2026-09-30T01:00:00Z",
  updated_at: "2026-09-30T01:00:00Z",
});

function res() {
  const r = {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      r.statusCode = c;
      return r;
    },
    json(b: unknown) {
      r.body = b;
      return r;
    },
  };
  return r;
}

async function status(run_id: string) {
  const r = res();
  await getAutopilotBuildStatus({ query: { run_id } } as never, r as never);
  return r;
}

const OLD = "c0000000-0000-4000-8000-00000000000c";
const oldGraph = [
  { status: "done", payload: { stage: "provision" }, started_at: "2026-10-01T10:00:00Z", finished_at: "2026-10-01T10:02:00Z" },
  { status: "done", payload: { stage: "spec" }, started_at: "2026-10-01T10:02:00Z", finished_at: "2026-10-01T10:05:00Z" },
  { status: "dispatched", payload: { stage: "scaffold" }, started_at: "2026-10-01T10:05:00Z" },
  { status: "pending", payload: { stage: "build" } },
];

type Row = { stage: string; status: string; started_at: string | null; expected_ms?: number };

beforeEach(() => {
  resetSiteLiveChecks();
  h.tablesRead = [];
  h.settings = {};
  h.serving = {};
  h.probes = [];
  h.store = fakeSiteStore([siteRow({ id: SB, label: "beta", root_conductor_run_id: RB, status: "building" })]).store;
  h.runs = [run(RB, siteGraph(SB, { status: "dispatched", started_at: "2026-10-01T10:00:00Z" }), "active"), run(OLD, oldGraph, "active")];
});

describe("build-status sends each step's expected length (build_progress_moves_in_stage)", () => {
  it("old flow: every stage carries its expected length and the running scaffold keeps its start time", async () => {
    const r = await status(OLD);
    const stages = r.body.run.stages as Row[];
    expect(stages.map((s) => s.stage)).toEqual(["provision", "spec", "scaffold", "build"]);
    for (const s of stages) expect(s.expected_ms).toBe(stageExpectedMs(s.stage, false));
    const scaffold = stages.find((s) => s.stage === "scaffold")!;
    expect(scaffold).toMatchObject({ status: "running", started_at: "2026-10-01T10:05:00Z" });
    expect(scaffold.expected_ms).toBe(25 * 60_000);
  });

  it("new-flow site: the site's own stage lengths", async () => {
    const r = await status(RB);
    const stages = r.body.run.stages as Row[];
    expect(stages.map((s) => s.stage)).toEqual(["provision", "build", "deploy"]);
    for (const s of stages) expect(s.expected_ms).toBe(stageExpectedMs(s.stage, true));
    expect(stages.find((s) => s.stage === "build")!.expected_ms).toBe(7 * 60_000);
  });

  it("key off: no stage carries expected_ms, in either flow", async () => {
    h.settings.build_progress_moves_in_stage = false;
    for (const id of [OLD, RB]) {
      const r = await status(id);
      for (const s of r.body.run.stages as Row[]) expect(s).not.toHaveProperty("expected_ms");
    }
  });
});
