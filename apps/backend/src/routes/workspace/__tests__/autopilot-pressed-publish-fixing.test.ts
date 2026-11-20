import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeSiteStore, siteRow, T1 } from "@/services/sites/__tests__/fake-site-store";
import type { SiteRow } from "@/services/sites/contract";
import { BUILD_FIXES_EXHAUSTED } from "@zavi/shared";
import STEPS from "./fixtures/pressed-publish-fix-pass.json";

type PublishRunRow = { id: string; tenant_id: string; kind: string; status: string; created_at: string; failure_class?: string; goal_graph: Array<Record<string, unknown>> };

const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  publishRuns: [] as PublishRunRow[],
  publishQueries: [] as Array<Array<[string, unknown[]]>>,
  publishQueryError: null as null | string,
  publishQueryThrows: false,
  sandboxes: [] as Array<Record<string, unknown>>,
  store: null as unknown,
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/settings")>();
  return { ...actual, getBoolSetting: vi.fn(async () => true) };
});
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u", access_token: "tok" }),
}));
vi.mock("@/services/sites/store", () => ({ siteStore: () => h.store }));
vi.mock("@/services/agents/conductor-driver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/agents/conductor-driver")>();
  return { ...actual, kickSandboxPreview: () => undefined };
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

const SITE_PATH = "goal_graph->0->payload->>site_id";
const REPUBLISH_PATH = "goal_graph->0->payload->>republish";

function publishRunQuery(calls: Array<[string, unknown[]]>) {
  h.publishQueries.push(calls.map(([m, a]) => [m, [...a]] as [string, unknown[]]));
  if (h.publishQueryThrows) throw new Error("socket hang up");
  if (h.publishQueryError) return { data: null, error: { message: h.publishQueryError } };
  const eq = (col: string) => calls.find(([m, a]) => m === "eq" && a[0] === col)?.[1][1];
  let rows = h.publishRuns.filter((r) => {
    const node = r.goal_graph[0] as { payload?: { site_id?: unknown; republish?: unknown } } | undefined;
    return (
      r.tenant_id === eq("tenant_id") &&
      r.kind === eq("kind") &&
      node?.payload?.site_id === eq(SITE_PATH) &&
      String(node?.payload?.republish) === eq(REPUBLISH_PATH)
    );
  });
  const order = calls.find(([m]) => m === "order");
  if (order && order[1][0] === "created_at" && (order[1][1] as { ascending?: boolean })?.ascending === false) {
    rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  const lim = calls.find(([m]) => m === "limit")?.[1][0];
  return { data: typeof lim === "number" ? rows.slice(0, lim) : rows, error: null };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        return chain((calls) => {
          const sel = String(calls.find(([m]) => m === "select")?.[1][0] ?? "");
          if (sel === "id, status, created_at, failure_class, goal_graph") return publishRunQuery(calls);
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
  tenantClient: (tenant_id: string) => ({
    from: (table: string) =>
      chain((calls) => {
        if (table !== "tenant_sandbox") return { data: null, error: null };
        const repo = calls.find(([m, a]) => m === "eq" && a[0] === "repo_full_name")?.[1][1];
        return { data: h.sandboxes.find((s) => s.tenant_id === tenant_id && s.repo_full_name === repo) ?? null, error: null };
      }),
  }),
}));

import { getAutopilotBuildStatus } from "../autopilot";

const SA = "aaaaaaaa-0000-4000-8000-000000000001";
const SB = "bbbbbbbb-0000-4000-8000-000000000002";
const RA = "a0000000-0000-4000-8000-00000000000a";
const RB = "b0000000-0000-4000-8000-00000000000b";
const PREVIEW = "https://5173-sbx-a.e2b.app";
const GATE = "The site's smoke check failed: the booking form returns a 500\nEvidence: POST /api/data/bookings -> 500";

const onRequestGraph = (site_id: string) => [
  { status: "done", payload: { stage: "provision" } },
  { status: "done", payload: { stage: "build", site_id, fast_single_pass: true } },
];

function rootRun(id: string, graph: unknown[], status = "done") {
  return { id, objective: "Build product: Alpha", status, goal_graph: graph, spend_usd: 0, max_usd: 10, created_at: "2026-10-01T01:00:00Z", updated_at: "2026-10-01T01:10:00Z" };
}

function sites(over: Partial<SiteRow> = {}) {
  h.store = fakeSiteStore([
    siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "building", updated_at: "2026-10-02T04:00:00Z", ...over }),
    siteRow({ id: SB, label: "beta", root_conductor_run_id: RB, status: "building" }),
  ]).store;
}

async function status(run_id = RA) {
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
  await getAutopilotBuildStatus({ query: { run_id } } as never, r as never);
  return r;
}

beforeEach(() => {
  h.publishRuns = [];
  h.publishQueries = [];
  h.publishQueryError = null;
  h.publishQueryThrows = false;
  sites();
  h.runs = [rootRun(RA, onRequestGraph(SA)), rootRun(RB, onRequestGraph(SB))];
  h.sandboxes = [{ id: "row-a", tenant_id: T1, repo_full_name: "Praxis-build/alpha", preview_url: PREVIEW, preview_status: "live" }];
  vi.stubGlobal("fetch", async () => ({ status: 200, text: async () => "<html></html>", headers: new Headers({ "content-type": "text/html", "x-zavi-deploy-id": "d1" }) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const STARTED = "2026-10-05T05:48:00+00:00";
const LIVE_URL = "https://alpha.zaviagent.com";

type Node = Record<string, unknown>;
const deployNode = (over: Node = {}): Node => ({
  id: "site-republish-x",
  status: "pending",
  payload: { stage: "deploy", refine_mode: true, republish: true, publish_request: true, site_id: SA, site_sha: "abc1234" },
  ...over,
});
const pressed = (status: string, node: Node, failure_class?: string): PublishRunRow => ({
  id: "cr-press",
  tenant_id: T1,
  kind: "build_app",
  status,
  created_at: STARTED,
  ...(failure_class ? { failure_class } : {}),
  goal_graph: [node],
});

const REPAIR_PENDING = { status: "dispatched", child_run_id: "fix-1", site_repair_attempts: 1, site_repair_pending: true, last_failure_signal: GATE };
const REPAIR_SETTLED = { status: "pending", child_run_id: null, site_repair_attempts: 1, site_repair_pending: false, last_failure_signal: GATE };

describe("a publish the founder pressed whose final check failed and a fix pass runs", () => {
  it("running -> fix pass -> fix settled -> live: fixing only while the fix runs, never on the live payload", async () => {
    h.publishRuns = [pressed("active", deployNode())];
    expect((await status()).body.publish).toEqual(STEPS.running);

    h.publishRuns = [pressed("active", deployNode(REPAIR_PENDING))];
    const fixing = await status();
    expect(fixing.body.publish).toEqual(STEPS.repairPending);
    expect(fixing.body.app_ready).toBe(true);
    expect(JSON.stringify(fixing.body)).not.toMatch(/smoke check|Evidence|booking form/);

    h.publishRuns = [pressed("active", deployNode(REPAIR_SETTLED))];
    expect((await status()).body.publish).toEqual(STEPS.repairSettled);

    sites({ status: "live", live_deploy_id: "d2", live_sha: "def5678", live_url: LIVE_URL, last_error: null });
    h.publishRuns = [pressed("done", deployNode({ ...REPAIR_PENDING, status: "done" }))];
    const live = await status();
    expect(live.body.publish).toEqual(STEPS.live);
    expect(live.body.publish.fixing).toBeUndefined();
  });

  it("running -> fix pass -> fixes ran out: failed with the shared line, fixing gone even if the node kept its marker", async () => {
    h.publishRuns = [pressed("active", deployNode(REPAIR_PENDING))];
    expect((await status()).body.publish).toEqual(STEPS.repairPending);

    h.publishRuns = [
      pressed(
        "failed",
        deployNode({ ...REPAIR_PENDING, status: "failed", error: `The site still failed its checks after 1 fix attempt(s): ${GATE}` }),
        "repair_exhausted",
      ),
    ];
    const failed = await status();
    expect(failed.body.publish).toEqual(STEPS.failed);
    expect(failed.body.publish.reason).toBe(BUILD_FIXES_EXHAUSTED);
    expect(failed.body.publish.fixing).toBeUndefined();
  });

  it("a fix pass on a run stopped mid-fix (halted) is never reported as fixing", async () => {
    h.publishRuns = [pressed("halted", deployNode(REPAIR_PENDING), "budget_halted")];
    const r = await status();
    expect(r.body.publish.status).toBe("failed");
    expect(r.body.publish.fixing).toBeUndefined();
  });

  it("a pressed publish waiting for a database is waiting, not fixing", async () => {
    h.publishRuns = [pressed("active", deployNode({ payload: { ...(deployNode().payload as object), site_capacity_wait_since: 1 } }))];
    const r = await status();
    expect(r.body.publish.waiting).toBe(true);
    expect(r.body.publish.fixing).toBeUndefined();
  });
});
