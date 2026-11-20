
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSiteStore, siteRow, T1 } from "@/services/sites/__tests__/fake-site-store";

const USER = "99999999-0000-4000-8000-000000000009";

type Calls = Array<[string, unknown[]]>;
const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  threads: [] as Array<Record<string, unknown>>,
  agentRuns: [] as Array<Record<string, unknown>>,
  conductorCalls: [] as Calls[],
  threadError: null as { message: string } | null,
  store: null as unknown,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({
    tenant_id: "11111111-1111-4111-8111-111111111111",
    user_id: "99999999-0000-4000-8000-000000000009",
    access_token: "tok",
  }),
}));
vi.mock("@/services/sites/store", () => ({ siteStore: () => h.store }));
vi.mock("@/services/hosting/site-publish", () => ({ verifySiteDeploy: async () => ({ ok: true }) }));
vi.mock("@/services/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/settings")>();
  return { ...real, getBoolSetting: async () => false };
});

function chain(resolve: (calls: Calls) => { data: unknown; error: unknown }) {
  const calls: Calls = [];
  const api: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "or", "order", "gte", "is", "not", "limit"]) {
    api[m] = (...a: unknown[]) => {
      calls.push([m, a]);
      return api;
    };
  }
  api.maybeSingle = () => {
    const r = resolve(calls);
    const rows = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
    return Promise.resolve({ data: rows[0] ?? null, error: r.error });
  };
  api.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve(resolve(calls)).then(ok, bad);
  return { api, calls };
}

const eqOf = (calls: Calls, col: string) => calls.find(([m, a]) => m === "eq" && a[0] === col)?.[1][1];
const isSite = (r: Record<string, unknown>) =>
  ((r.goal_graph as Array<{ payload?: { site_id?: unknown } }>) ?? []).some((n) => typeof n.payload?.site_id === "string");

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        const c = chain((calls) => {
          const id = eqOf(calls, "id");
          const workspaceOnly = calls.some(([m, a]) => m === "is" && String(a[0]).includes("site_id"));
          let rows = h.runs.filter((r) => r.tenant_id === eqOf(calls, "tenant_id"));
          if (id) rows = rows.filter((r) => r.id === id);
          if (workspaceOnly) rows = rows.filter((r) => !isSite(r));
          rows = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
          return { data: rows.slice(0, 1), error: null };
        });
        h.conductorCalls.push(c.calls);
        return c.api;
      }
      if (table === "agent_threads") {
        return chain((calls) => {
          if (h.threadError) return { data: null, error: h.threadError };
          const rows = h.threads.filter(
            (t) =>
              t.id === eqOf(calls, "id") &&
              t.tenant_id === eqOf(calls, "tenant_id") &&
              t.user_id === eqOf(calls, "user_id") &&
              !t.deleted_at,
          );
          return { data: rows, error: null };
        }).api;
      }
      if (table === "agent_runs") {
        return chain((calls) => {
          const thread = eqOf(calls, "payload->>thread_id");
          if (!thread) return { data: [], error: null };
          const rows = h.agentRuns
            .filter((r) => r.tenant_id === eqOf(calls, "tenant_id"))
            .filter((r) => (r.payload as Record<string, unknown>).thread_id === thread)
            .filter((r) => (r.payload as Record<string, unknown>).build_session_id != null)
            .sort((a, b) => String(b.enqueued_at).localeCompare(String(a.enqueued_at)));
          return { data: rows, error: null };
        }).api;
      }
      return chain(() => ({ data: [], error: null })).api;
    },
  }),
  serviceClient: () => ({
    from: () => chain(() => ({ data: null, error: null })).api,
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: () => chain(() => ({ data: null, error: null })).api }),
}));

import { getAutopilotBuildStatus } from "../autopilot";
import { resetSiteLiveChecks } from "@/services/sites/site-build-status";

const SA = "aaaaaaaa-0000-4000-8000-000000000001";
const SB = "bbbbbbbb-0000-4000-8000-000000000002";
const RA = "a0000000-0000-4000-8000-00000000000a";
const RB = "b0000000-0000-4000-8000-00000000000b";
const RO = "c0000000-0000-4000-8000-00000000000c";
const TH_A = "d0000000-0000-4000-8000-0000000000a1";
const TH_B = "d0000000-0000-4000-8000-0000000000b1";
const TH_HOME = "d0000000-0000-4000-8000-0000000000c1";
const TH_OTHER_USER = "d0000000-0000-4000-8000-0000000000d1";
const TH_DELETED = "d0000000-0000-4000-8000-0000000000e1";

type N = Record<string, unknown>;
const siteGraph = (site_id: string): N[] => [
  { status: "done", payload: { stage: "provision" } },
  { status: "done", payload: { stage: "build", site_id, fast_single_pass: true } },
  { status: "done", payload: { stage: "deploy", site_id } },
];
const oldGraph: N[] = [
  { status: "done", payload: { stage: "provision" } },
  { status: "done", payload: { stage: "build" } },
];
const run = (id: string, graph: N[], created_at: string) => ({
  id,
  tenant_id: T1,
  objective: "Build product: X — x",
  status: "done",
  goal_graph: graph,
  spend_usd: 0,
  max_usd: 10,
  created_at,
  updated_at: created_at,
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

async function status(query: Record<string, unknown>) {
  const r = res();
  await getAutopilotBuildStatus({ query } as never, r as never);
  return r;
}

beforeEach(() => {
  resetSiteLiveChecks();
  h.threadError = null;
  h.conductorCalls = [];
  h.store = fakeSiteStore([
    siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "live", live_deploy_id: "d1", live_url: "https://alpha.zaviagent.com" }),
    siteRow({ id: SB, label: "beta", root_conductor_run_id: RB, status: "live", live_deploy_id: "d2", live_url: "https://beta.zaviagent.com" }),
  ]).store;
  h.runs = [
    run(RO, oldGraph, "2026-09-28T01:00:00Z"),
    run(RA, siteGraph(SA), "2026-09-29T01:00:00Z"),
    run(RB, siteGraph(SB), "2026-09-30T01:00:00Z"),
  ];
  h.threads = [
    { id: TH_A, tenant_id: T1, user_id: USER, deleted_at: null },
    { id: TH_B, tenant_id: T1, user_id: USER, deleted_at: null },
    { id: TH_HOME, tenant_id: T1, user_id: USER, deleted_at: null },
    { id: TH_OTHER_USER, tenant_id: T1, user_id: "88888888-0000-4000-8000-000000000008", deleted_at: null },
    { id: TH_DELETED, tenant_id: T1, user_id: USER, deleted_at: "2026-09-30T00:00:00Z" },
  ];
  h.agentRuns = [
    { tenant_id: T1, enqueued_at: "2026-09-30T02:00:00Z", payload: { thread_id: TH_A, build_session_id: RA } },
    { tenant_id: T1, enqueued_at: "2026-09-30T03:00:00Z", payload: { thread_id: TH_A } },
    { tenant_id: T1, enqueued_at: "2026-09-30T02:30:00Z", payload: { thread_id: TH_B, build_session_id: RB } },
    { tenant_id: T1, enqueued_at: "2026-09-30T04:00:00Z", payload: { thread_id: TH_HOME } },
    { tenant_id: T1, enqueued_at: "2026-09-30T05:00:00Z", payload: { thread_id: TH_OTHER_USER, build_session_id: RB } },
  ];
});

describe("build-status ?thread_id= (two sites in one workspace)", () => {
  it("a thread about site A shows site A, never the newer site B", async () => {
    const r = await status({ thread_id: TH_A });
    expect(r.statusCode).toBe(200);
    expect(r.body.run.id).toBe(RA);
    expect(r.body.preview).toEqual({ url: "https://alpha.zaviagent.com", kind: "final" });
  });

  it("a thread about site B shows site B", async () => {
    const r = await status({ thread_id: TH_B });
    expect(r.body.run.id).toBe(RB);
    expect(r.body.preview).toEqual({ url: "https://beta.zaviagent.com", kind: "final" });
  });

  it("the unbound default (no params) is what used to leak: the newest site", async () => {
    const r = await status({});
    expect(r.body.run.id).toBe(RB);
  });

  it("an unbound thread is about the workspace (old-flow) app, never a site", async () => {
    const r = await status({ thread_id: TH_HOME });
    expect(r.statusCode).toBe(200);
    expect(r.body.run.id).toBe(RO);
    expect(r.body.site).toBeUndefined();
    const calls = h.conductorCalls.at(-1)!;
    expect(calls.filter(([m, a]) => m === "is" && String(a[0]).includes("site_id"))).toHaveLength(3);
  });

  it("an unbound thread in a sites-only workspace shows no app at all", async () => {
    h.runs = h.runs.filter((r) => r.id !== RO);
    const r = await status({ thread_id: TH_HOME });
    expect(r.statusCode).toBe(200);
    expect(r.body.run).toBeNull();
  });

  it("another member's thread or a deleted thread 404s, without reading its binding", async () => {
    for (const id of [TH_OTHER_USER, TH_DELETED, "d0000000-0000-4000-8000-0000000000ff"]) {
      h.conductorCalls = [];
      const r = await status({ thread_id: id });
      expect(r.statusCode).toBe(404);
      expect(r.body.error.code).toBe("thread_not_found");
      expect(h.conductorCalls).toHaveLength(0);
    }
  });

  it("a malformed thread id, or one combined with run_id/app, is a bad request", async () => {
    expect((await status({ thread_id: "nope" })).statusCode).toBe(400);
    expect((await status({ thread_id: ["a", "b"] })).statusCode).toBe(400);
    expect((await status({ thread_id: TH_A, run_id: RB })).statusCode).toBe(400);
    expect((await status({ thread_id: TH_A, app: "workspace" })).statusCode).toBe(400);
  });

  it("a thread read failure fails loud, never falls back to another app", async () => {
    h.threadError = { message: "boom" };
    const r = await status({ thread_id: TH_A });
    expect(r.statusCode).toBe(500);
    expect(r.body.run).toBeUndefined();
  });
});
