
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSiteStore, siteRow, T1 } from "@/services/sites/__tests__/fake-site-store";

const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  sessionRows: [] as Array<Record<string, unknown>>,
  sandboxes: [] as Array<Record<string, unknown>>,
  resources: [] as Array<Record<string, unknown>>,
  tablesRead: [] as string[],
  store: null as unknown,
  byId: null as string | null,
  siteFlags: {} as Record<string, boolean>,
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...actual,
    getBoolSetting: vi.fn(async (key: string, ...rest: unknown[]) =>
      key in h.siteFlags ? h.siteFlags[key] : (actual.getBoolSetting as (...a: unknown[]) => Promise<boolean>)(key, ...rest),
    ),
  };
});

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u", access_token: "tok" }),
}));
vi.mock("@/services/sites/store", () => ({ siteStore: () => h.store }));

function chain(resolve: (calls: Array<[string, unknown[]]>) => unknown) {
  const calls: Array<[string, unknown[]]> = [];
  const api: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "or", "order", "gt", "gte", "is"]) {
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
          const sel = String(calls.find(([m]) => m === "select")?.[1][0] ?? "");
          if (sel.includes("refine_mode:goal_graph")) return { data: h.sessionRows, error: null };
          const id = calls.find(([m, a]) => m === "eq" && a[0] === "id")?.[1][1];
          const rows = id ? h.runs.filter((r) => r.id === id) : h.runs;
          if (sel.includes("s0:goal_graph")) {
            let marked = rows.map((r) => {
              const g = (r.goal_graph as Array<{ payload?: { site_id?: string } }>) ?? [];
              return { id: r.id, status: r.status, created_at: r.created_at, s0: g[0]?.payload?.site_id ?? null, s1: g[1]?.payload?.site_id ?? null, s2: g[2]?.payload?.site_id ?? null };
            });
            if (calls.some(([m, a]) => m === "is" && String(a[0]).includes("site_id"))) {
              marked = marked.filter((r) => r.s0 === null && r.s1 === null && r.s2 === null);
            }
            marked.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
            const lim = calls.find(([m]) => m === "limit")?.[1][0];
            return { data: typeof lim === "number" ? marked.slice(0, lim) : marked, error: null };
          }
          return { data: rows, error: null };
        });
      }
      if (table === "tenant_resources") return chain(() => ({ data: h.resources, error: null }));
      return chain(() => ({ data: [], error: null }));
    },
  }),
  serviceClient: () => ({ from: () => chain(() => ({ data: null, error: null })), rpc: async () => ({ data: null, error: null }) }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) =>
      chain((calls) => {
        if (table !== "tenant_sandbox") return { data: null, error: null };
        const repo = calls.find(([m, a]) => m === "eq" && a[0] === "repo_full_name")?.[1][1];
        return { data: h.sandboxes.find((s) => s.repo_full_name === repo) ?? null, error: null };
      }),
  }),
}));

import { getAutopilotBuildSessions, getAutopilotBuildStatus } from "../autopilot";

const SA = "aaaaaaaa-0000-4000-8000-000000000001";
const SB = "bbbbbbbb-0000-4000-8000-000000000002";
const RA = "a0000000-0000-4000-8000-00000000000a";
const RB = "b0000000-0000-4000-8000-00000000000b";

const siteGraph = (site_id: string, deployStatus = "done") => [
  { status: "done", payload: { stage: "provision" } },
  { status: "done", payload: { stage: "build", site_id, fast_single_pass: true } },
  { status: deployStatus, payload: { stage: "deploy", site_id } },
];

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

beforeEach(() => {
  h.siteFlags = {};
  h.tablesRead = [];
  h.resources = [];
  h.store = fakeSiteStore([
    siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "live", live_deploy_id: "d1", live_url: "https://alpha.zaviagent.com" }),
    siteRow({ id: SB, label: "beta", root_conductor_run_id: RB, status: "building" }),
  ]).store;
  h.runs = [
    { id: RB, objective: "Build product: Beta — b", status: "active", goal_graph: siteGraph(SB, "pending"), spend_usd: 0, max_usd: 10, created_at: "2026-09-30T02:00:00Z", updated_at: "2026-09-30T02:00:00Z" },
    { id: RA, objective: "Build product: Alpha — a", status: "done", goal_graph: siteGraph(SA), spend_usd: 0, max_usd: 10, created_at: "2026-09-30T01:00:00Z", updated_at: "2026-09-30T01:00:00Z" },
  ];
  h.sandboxes = [
    { id: "sbx-row-a", repo_full_name: "Praxis-build/alpha", preview_url: "https://5173-a.e2b.app", preview_status: "live" },
    { id: "sbx-row-b", repo_full_name: "Praxis-build/beta", preview_url: "https://5173-b.e2b.app", preview_status: "live" },
  ];
  vi.stubGlobal("fetch", async (url: string) => ({
    status: 200,
    text: async () => "<html></html>",
    headers: new Headers(
      String(url).startsWith("https://alpha.zaviagent.com") ? { "content-type": "text/html", "x-zavi-deploy-id": "d1" } : {},
    ),
  }));
});

describe("build-status for new-flow sites", () => {
  it("two sites in one tenant: each run shows its own site, live url and preview", async () => {
    const a = res();
    await getAutopilotBuildStatus({ query: { run_id: RA } } as never, a as never);
    const b = res();
    await getAutopilotBuildStatus({ query: { run_id: RB } } as never, b as never);

    expect(a.body.target).toEqual({
      repo_url: "https://github.com/Praxis-build/alpha",
      live_url: "https://alpha.zaviagent.com",
      admin_url: "https://alpha.zaviagent.com/admin",
      admin_setup_email: "owner@example.test",
      live_announce: true,
      live_announce_url: "https://alpha.zaviagent.com",
    });
    expect(a.body.preview).toEqual({ url: "https://alpha.zaviagent.com", kind: "final" });
    expect(a.body.site).toMatchObject({ id: SA, hostname: "alpha.zaviagent.com", admin_url: "https://alpha.zaviagent.com/admin", status: "live" });
    expect(a.body.is_current).toBe(true);

    expect(b.body.target).toEqual({ repo_url: "https://github.com/Praxis-build/beta", live_url: null });
    expect(b.body.preview).toEqual({ url: "https://5173-b.e2b.app", kind: "instant" });
    expect(b.body.site.hostname).toBe("beta.zaviagent.com");
    expect(b.body.is_current).toBe(true);
    expect(h.tablesRead).not.toContain("tenant_resources");
  });

  it("stages are the graph's own: provision, build, deploy (no phantom spec/scaffold)", async () => {
    const r = res();
    await getAutopilotBuildStatus({ query: { run_id: RA } } as never, r as never);
    expect(r.body.run.stages.map((s: { stage: string }) => s.stage)).toEqual(["provision", "build", "deploy"]);
  });

  it("the latest (no run_id) build is a site: it answers from that site", async () => {
    const r = res();
    await getAutopilotBuildStatus({ query: {} } as never, r as never);
    expect(r.body.run.id).toBe(RB);
    expect(r.body.site.id).toBe(SB);
  });

  it("a site id that is not this tenant's 404s instead of showing anything", async () => {
    h.runs = [{ ...h.runs[1], goal_graph: siteGraph("cccccccc-0000-4000-8000-000000000003") }];
    const r = res();
    await getAutopilotBuildStatus({ query: { run_id: RA } } as never, r as never);
    expect(r.statusCode).toBe(404);
  });

  it("a site that fell back to the old flow shows no live url or preview", async () => {
    h.store = fakeSiteStore([siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "fell_back_old" })]).store;
    const r = res();
    await getAutopilotBuildStatus({ query: { run_id: RA } } as never, r as never);
    expect(r.body.target.live_url).toBeNull();
    expect(r.body.preview).toEqual({ url: null, kind: "none" });
  });
});

describe("old-flow build next to new-flow sites", () => {
  it("a newer site build does not supersede the old singleton app", async () => {
    const OLD = "c0000000-0000-4000-8000-00000000000c";
    h.runs = [
      ...h.runs,
      {
        id: OLD,
        objective: "Build product: Old — o",
        status: "done",
        goal_graph: ["provision", "spec", "scaffold", "build", "deploy"].map((stage) => ({ status: "done", payload: { stage } })),
        spend_usd: 0,
        max_usd: 10,
        created_at: "2026-09-29T01:00:00Z",
        updated_at: "2026-09-29T01:00:00Z",
      },
    ];
    h.resources = [
      { resource_kind: "repo", status: "ready", external_ref: { repo_url: "https://github.com/Praxis-build/old" } },
      { resource_kind: "hosting", status: "ready", external_ref: { url: "https://old.onrender.com" }, created_at: "2026-09-29T00:00:00Z" },
    ];
    const r = res();
    await getAutopilotBuildStatus({ query: { run_id: OLD } } as never, r as never);
    expect(r.body.is_current).toBe(true);
    expect(r.body.target).toMatchObject({ repo_url: "https://github.com/Praxis-build/old", live_url: "https://old.onrender.com" });
    expect(r.body.site).toBeUndefined();
  });
});

describe("old-flow build behind many new sites", () => {
  it("30 newer site builds never hide the current old-flow build (site runs excluded before the limit)", async () => {
    const OLD = "c0000000-0000-4000-8000-00000000000d";
    const siteRuns = Array.from({ length: 30 }, (_, i) => ({
      id: `d0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      objective: `Build product: S${i} — s`,
      status: "done",
      goal_graph: [{ status: "done", payload: { stage: "provision" } }, { status: "done", payload: { stage: "build", site_id: `e0000000-0000-4000-8000-${String(i).padStart(12, "0")}` } }, { status: "done", payload: { stage: "deploy", site_id: `e0000000-0000-4000-8000-${String(i).padStart(12, "0")}` } }],
      spend_usd: 0,
      max_usd: 10,
      created_at: `2026-09-30T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
      updated_at: "2026-09-30T10:00:00Z",
    }));
    h.runs = [
      ...siteRuns,
      {
        id: OLD,
        objective: "Build product: Old — o",
        status: "done",
        goal_graph: ["provision", "spec", "scaffold", "build", "deploy"].map((stage) => ({ status: "done", payload: { stage } })),
        spend_usd: 0,
        max_usd: 10,
        created_at: "2026-09-29T01:00:00Z",
        updated_at: "2026-09-29T01:00:00Z",
      },
    ];
    h.resources = [
      { resource_kind: "repo", status: "ready", external_ref: { repo_url: "https://github.com/Praxis-build/old" } },
      { resource_kind: "hosting", status: "ready", external_ref: { url: "https://old.onrender.com" }, created_at: "2026-09-29T00:00:00Z" },
    ];
    const r = res();
    await getAutopilotBuildStatus({ query: { run_id: OLD } } as never, r as never);
    expect(r.body.is_current).toBe(true);
    expect(r.body.target).toMatchObject({ live_url: "https://old.onrender.com" });
    expect(r.body.site).toBeUndefined();
  });
});

describe("build-sessions list with sites", () => {
  it("each site session carries its own hostname, url and status; old sessions carry no site", async () => {
    h.sessionRows = [
      { id: RB, objective: "Build product: Beta — b", status: "active", created_at: "2026-09-30T02:00:00Z", updated_at: "2026-09-30T02:00:00Z", s0: null, s1: SB, s2: SB },
      { id: RA, objective: "Build product: Alpha — a", status: "done", created_at: "2026-09-30T01:00:00Z", updated_at: "2026-09-30T01:00:00Z", s0: null, s1: SA, s2: SA },
      { id: "old-run", objective: "Build product: Old — o", status: "done", created_at: "2026-09-29T01:00:00Z", updated_at: "2026-09-29T01:00:00Z" },
    ];
    const r = res();
    await getAutopilotBuildSessions({ query: {} } as never, r as never);
    const byId = Object.fromEntries(r.body.sessions.map((s: { id: string }) => [s.id, s]));
    expect(byId[RA].site).toEqual({ hostname: "alpha.zaviagent.com", live_url: "https://alpha.zaviagent.com", status: "live", name: null, repo: "Praxis-build/alpha" });
    expect(byId[RB].site).toEqual({ hostname: "beta.zaviagent.com", live_url: null, status: "building", name: null, repo: "Praxis-build/beta" });
    expect("site" in byId["old-run"]).toBe(false);
  });

  it("DEL-1323 B34/B6: each site carries its own name and repo, and the response says which site behaviours are on", async () => {
    h.store = fakeSiteStore([
      siteRow({ id: SA, label: "paws", name: "Paws and Suds", root_conductor_run_id: RA, status: "live", live_deploy_id: "d1", live_url: "https://alpha.zaviagent.com" }),
      siteRow({ id: SB, label: "yoga", name: "Still Water Yoga", root_conductor_run_id: RB, status: "building" }),
    ]).store;
    h.sessionRows = [
      { id: RB, objective: "Build product: Apna Tutor — b", status: "active", created_at: "2026-09-30T02:00:00Z", updated_at: "2026-09-30T02:00:00Z", s0: null, s1: SB, s2: SB },
      { id: RA, objective: "Build product: Apna Tutor — a", status: "done", created_at: "2026-09-30T01:00:00Z", updated_at: "2026-09-30T01:00:00Z", s0: null, s1: SA, s2: SA },
    ];
    const r = res();
    await getAutopilotBuildSessions({ query: {} } as never, r as never);
    const byId = Object.fromEntries(r.body.sessions.map((s: { id: string }) => [s.id, s]));
    expect(byId[RA].site).toMatchObject({ name: "Paws and Suds", repo: "Praxis-build/paws" });
    expect(byId[RB].site).toMatchObject({ name: "Still Water Yoga", repo: "Praxis-build/yoga", status: "building" });
    expect(r.body.flags).toEqual({ site_names: true, site_repo_chip: true, site_list_details: true });
  });

  it("with the three keys off, the list carries no name or repo and says so", async () => {
    h.siteFlags = { build_site_own_name: false, build_site_keeps_own_repo: false, build_site_list_details: false };
    h.store = fakeSiteStore([
      siteRow({ id: SA, label: "paws", name: "Paws and Suds", root_conductor_run_id: RA, status: "live", live_deploy_id: "d1", live_url: "https://alpha.zaviagent.com" }),
    ]).store;
    h.sessionRows = [
      { id: RA, objective: "Build product: Apna Tutor — a", status: "done", created_at: "2026-09-30T01:00:00Z", updated_at: "2026-09-30T01:00:00Z", s0: null, s1: SA, s2: SA },
    ];
    const r = res();
    await getAutopilotBuildSessions({ query: {} } as never, r as never);
    expect(r.body.sessions[0].site).toEqual({ hostname: "paws.zaviagent.com", live_url: "https://alpha.zaviagent.com", status: "live" });
    expect(r.body.flags).toEqual({ site_names: false, site_repo_chip: false, site_list_details: false });
  });

  it("an old-flow-only history never reads the sites list", async () => {
    h.sessionRows = [{ id: "old-run", objective: "Build product: Old — o", status: "done", created_at: "2026-09-29T01:00:00Z", updated_at: "2026-09-29T01:00:00Z" }];
    const listForTenant = vi.fn(async () => {
      throw new Error("sites table unreachable");
    });
    h.store = { listForTenant };
    const r = res();
    await getAutopilotBuildSessions({ query: {} } as never, r as never);
    expect(r.body.sessions).toHaveLength(1);
    expect(listForTenant).not.toHaveBeenCalled();
  });
});

void T1;
