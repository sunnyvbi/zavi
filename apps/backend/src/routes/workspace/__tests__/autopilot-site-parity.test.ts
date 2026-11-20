
import { describe, it, expect, vi, beforeEach } from "vitest";
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
  for (const m of ["select", "eq", "in", "or", "order", "gte"]) {
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

beforeEach(() => {
  resetSiteLiveChecks();
  h.tablesRead = [];
  h.settings = {};
  h.serving = { "alpha.zaviagent.com": "d1", "beta.zaviagent.com": "d2" };
  h.probes = [];
  h.store = fakeSiteStore([
    siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "live", live_deploy_id: "d1", live_url: "https://alpha.zaviagent.com" }),
    siteRow({ id: SB, label: "beta", root_conductor_run_id: RB, status: "building" }),
  ]).store;
  h.runs = [run(RA, siteGraph(SA)), run(RB, siteGraph(SB, { status: "pending" }), "active")];
});

describe("site build-status: retry labels", () => {
  beforeEach(() => {
    h.runs = [run(RB, siteGraph(SB, { status: "dispatched", site_repair_attempts: 1 }), "active")];
  });

  it("a deploy fix pass shows as attempt 2 when the setting is on", async () => {
    const r = await status(RB);
    const deploy = r.body.run.stages.find((s: { stage: string }) => s.stage === "deploy");
    expect(deploy).toMatchObject({ status: "running", retry_count: 1, attempt: 2 });
    expect(h.tablesRead).not.toContain("tenant_resources");
  });

  it("the setting off keeps the count but shows no attempt label", async () => {
    h.settings.build_progress_shows_retries = false;
    const r = await status(RB);
    const deploy = r.body.run.stages.find((s: { stage: string }) => s.stage === "deploy");
    expect(deploy.retry_count).toBe(1);
    expect("attempt" in deploy).toBe(false);
  });

  it("no fix pass: no attempt label", async () => {
    h.runs = [run(RB, siteGraph(SB, { status: "dispatched" }), "active")];
    const r = await status(RB);
    for (const s of r.body.run.stages) expect("attempt" in s).toBe(false);
  });
});

describe("site build-status: live announcement", () => {
  it("a live site announces its own address; a building site in the same tenant does not", async () => {
    const a = await status(RA);
    const b = await status(RB);
    expect(a.body.target).toMatchObject({
      live_url: "https://alpha.zaviagent.com",
      live_announce: true,
      live_announce_url: "https://alpha.zaviagent.com",
    });
    expect(b.body.target.live_url).toBeNull();
    expect("live_announce" in b.body.target).toBe(false);
    expect(h.tablesRead).not.toContain("tenant_resources");
  });

  it("two live sites each announce their own address", async () => {
    h.store = fakeSiteStore([
      siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "live", live_deploy_id: "d1" }),
      siteRow({ id: SB, label: "beta", root_conductor_run_id: RB, status: "live", live_deploy_id: "d2" }),
    ]).store;
    h.runs = [run(RA, siteGraph(SA)), run(RB, siteGraph(SB))];
    expect((await status(RA)).body.target.live_announce_url).toBe("https://alpha.zaviagent.com");
    expect((await status(RB)).body.target.live_announce_url).toBe("https://beta.zaviagent.com");
  });

  it("the setting off: no announcement", async () => {
    h.settings.build_live_announcement = false;
    const a = await status(RA);
    expect(a.body.target.live_url).toBe("https://alpha.zaviagent.com");
    expect("live_announce" in a.body.target).toBe(false);
    expect("live_announce_url" in a.body.target).toBe(false);
  });
});

describe("site build-status: offline status", () => {
  it("a live site serving its own deploy is live, probed once with one attempt", async () => {
    const a = await status(RA);
    expect(a.body.target.live_url).toBe("https://alpha.zaviagent.com");
    expect("site_offline" in a.body.target).toBe(false);
    expect(h.probes).toEqual([{ hostname: "alpha.zaviagent.com", deployId: "d1", attempts: 1 }]);
    await status(RA);
    expect(h.probes).toHaveLength(1);
  });

  it("a live site whose hostname serves another deploy is offline, no address, no announcement", async () => {
    h.serving["alpha.zaviagent.com"] = "d-old";
    const a = await status(RA);
    expect(a.body.target).toMatchObject({ live_url: null, site_offline: true });
    expect("live_announce" in a.body.target).toBe(false);
    expect(a.body.site.live_url).toBeNull();
    expect(a.body.publish).toMatchObject({ status: "live", url: "https://alpha.zaviagent.com" });
    expect(h.tablesRead).not.toContain("tenant_resources");
  });

  it.each(["paused", "waking", "failed"] as const)("a published %s site is offline without a probe", async (st) => {
    h.store = fakeSiteStore([siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: st, live_deploy_id: "d1" })]).store;
    const a = await status(RA);
    expect(a.body.target).toMatchObject({ live_url: null, site_offline: true });
    expect(h.probes).toEqual([]);
  });

  it("the setting off: no probe, no offline flag; a paused site still shows no address", async () => {
    h.settings.build_site_offline_status = false;
    h.serving = {};
    const a = await status(RA);
    expect(a.body.target.live_url).toBe("https://alpha.zaviagent.com");
    expect("site_offline" in a.body.target).toBe(false);
    h.store = fakeSiteStore([siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "paused", live_deploy_id: "d1" })]).store;
    const p = await status(RA);
    expect(p.body.target.live_url).toBeNull();
    expect("site_offline" in p.body.target).toBe(false);
    expect(h.probes).toEqual([]);
  });

  it("two live sites: one offline never marks the other", async () => {
    h.store = fakeSiteStore([
      siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "live", live_deploy_id: "d1" }),
      siteRow({ id: SB, label: "beta", root_conductor_run_id: RB, status: "live", live_deploy_id: "d2" }),
    ]).store;
    h.runs = [run(RA, siteGraph(SA)), run(RB, siteGraph(SB))];
    delete h.serving["beta.zaviagent.com"];
    expect((await status(RA)).body.target).toMatchObject({ live_url: "https://alpha.zaviagent.com" });
    expect((await status(RB)).body.target).toMatchObject({ live_url: null, site_offline: true });
  });
});

describe("site build-status: owner admin line", () => {
  it("a live site whose owner admin was set up shows its own admin address and owner", async () => {
    const a = await status(RA);
    expect(a.body.target).toMatchObject({
      admin_url: "https://alpha.zaviagent.com/admin",
      admin_setup_email: "owner@example.test",
    });
    expect(h.tablesRead).not.toContain("tenant_resources");
  });

  it("no owner recorded (setup skipped or failed): no admin line", async () => {
    h.store = fakeSiteStore([
      siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "live", live_deploy_id: "d1", owner_email: null }),
    ]).store;
    const a = await status(RA);
    expect(a.body.target.live_url).toBe("https://alpha.zaviagent.com");
    expect("admin_url" in a.body.target).toBe(false);
    expect("admin_setup_email" in a.body.target).toBe(false);
  });

  it("the setting off: no admin line", async () => {
    h.settings.build_auto_site_owner = false;
    const a = await status(RA);
    expect("admin_url" in a.body.target).toBe(false);
  });

  it("not live (building) or offline: no admin line", async () => {
    expect("admin_url" in (await status(RB)).body.target).toBe(false);
    h.serving["alpha.zaviagent.com"] = "d-old";
    const a = await status(RA);
    expect(a.body.target.site_offline).toBe(true);
    expect("admin_url" in a.body.target).toBe(false);
  });

  it("two live sites: each shows its own admin address and owner", async () => {
    h.store = fakeSiteStore([
      siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "live", live_deploy_id: "d1", owner_email: "a@example.test" }),
      siteRow({ id: SB, label: "beta", root_conductor_run_id: RB, status: "live", live_deploy_id: "d2", owner_email: "b@example.test" }),
    ]).store;
    h.runs = [run(RA, siteGraph(SA)), run(RB, siteGraph(SB))];
    expect((await status(RA)).body.target).toMatchObject({ admin_url: "https://alpha.zaviagent.com/admin", admin_setup_email: "a@example.test" });
    expect((await status(RB)).body.target).toMatchObject({ admin_url: "https://beta.zaviagent.com/admin", admin_setup_email: "b@example.test" });
  });
});
