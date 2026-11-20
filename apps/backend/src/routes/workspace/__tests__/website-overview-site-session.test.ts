
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const T = "11111111-1111-4111-8111-111111111111";
const OTHER_T = "22222222-2222-4222-8222-222222222222";
const SITE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const SITE_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const RUN_A = "aaaaaaaa-1111-4000-8000-00000000000a";
const RUN_B = "bbbbbbbb-1111-4000-8000-00000000000b";
const RUN_OLD = "cccccccc-1111-4000-8000-00000000000c";
const RUN_FOREIGN = "dddddddd-1111-4000-8000-00000000000d";

const db = vi.hoisted(() => ({
  runs: [] as Row[],
  sites: [] as Row[],
  runsError: null as { message: string } | null,
  singletonReads: 0,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: T, user_id: "u1", access_token: "tok" })),
  authMiddleware: vi.fn(),
}));
vi.mock("@/services/settings", () => ({
  getStringSetting: vi.fn(async () => "private"),
  getBoolSetting: vi.fn(async () => true),
  getSetting: vi.fn(async () => ({ name: "Old App", description: null })),
  setTenantSetting: vi.fn(),
}));
vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    getByRun: async (tid: string, run: string) => db.sites.find((s) => s.tenant_id === tid && s.root_conductor_run_id === run) ?? null,
    get: async (tid: string, id: string) => db.sites.find((s) => s.tenant_id === tid && s.id === id) ?? null,
    listForTenant: async (tid: string) => db.sites.filter((s) => s.tenant_id === tid),
  }),
}));

const marker = (r: Row, i: number) => ((r.goal_graph as Array<{ payload?: Row }>)[i]?.payload?.site_id ?? null);

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => ({}) }),
  serverClientFromBearer: () => ({
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      let cols = "";
      const q: Record<string, unknown> = {};
      const found = () => db.runs.find((r) => eqs.every(([c, v]) => r[c] === v));
      Object.assign(q, {
        select: (c: string) => ((cols = c), q),
        eq: (c: string, v: unknown) => (eqs.push([c, v]), q),
        or: () => q,
        is: () => q,
        in: () => q,
        order: () => q,
        limit: async () => {
          db.singletonReads++;
          return { data: [], error: null };
        },
        maybeSingle: async () => {
          if (table === "tenants") {
            db.singletonReads++;
            return { data: { display_name: "Workspace", product_url: {}, created_at: "2026-09-01T00:00:00Z" }, error: null };
          }
          if (table !== "conductor_runs") {
            db.singletonReads++;
            return { data: null, error: null };
          }
          if (db.runsError) return { data: null, error: db.runsError };
          const r = found();
          if (!r) return { data: null, error: null };
          if (cols.includes("s0:")) return { data: { id: r.id, s0: marker(r, 0), s1: marker(r, 1), s2: marker(r, 2) }, error: null };
          return { data: { objective: r.objective, status: r.status }, error: null };
        },
      });
      return q;
    },
  }),
}));

import { getWebsiteOverviewHandler } from "../website-overview";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}
async function overview(query: Row) {
  const res = mockRes();
  await getWebsiteOverviewHandler({ query, headers: { authorization: "Bearer tok" } } as never, res as never);
  return res as { statusCode: number; body: Record<string, any> };
}

const run = (id: string, tenant: string, site: string | null, objective: string, status = "done"): Row => ({
  id, tenant_id: tenant, kind: "build_app", objective, status,
  goal_graph: [{ payload: { stage: "provision", ...(site ? { site_id: site } : {}) } }],
});
const site = (id: string, run_id: string, hostname: string, extra: Row = {}): Row => ({
  id, tenant_id: T, root_conductor_run_id: run_id, hostname, status: "live",
  live_url: `https://${hostname}`, live_deploy_id: "dep-1", created_at: "2026-10-01T00:00:00Z", ...extra,
});

beforeEach(() => {
  db.runs = [
    run(RUN_A, T, SITE_A, "Build product: X — A website called Lucky Paws for a dog groomer"),
    run(RUN_B, T, SITE_B, "Build product: X — Website for Mile High Coffee, a cafe in Denver", "active"),
    run(RUN_OLD, T, null, "Build product: X — The old app"),
    run(RUN_FOREIGN, OTHER_T, SITE_A, "Build product: X — Someone else's"),
  ];
  db.sites = [
    site(SITE_A, RUN_A, "lucky-paws.zavi.site"),
    site(SITE_B, RUN_B, "mile-high.zavi.site", { status: "building", live_deploy_id: null }),
  ];
  db.runsError = null;
  db.singletonReads = 0;
});

describe("Settings pane overview for a site's Build session", () => {
  it("each of two sites gets ITS own overview, never the workspace app's", async () => {
    const a = await overview({ build_session_id: RUN_A });
    expect(a.statusCode).toBe(200);
    expect(a.body.site).toEqual({ id: SITE_A, hostname: "lucky-paws.zavi.site", status: "live" });
    expect(a.body.app.name).toBe("Lucky Paws");
    expect(a.body.app.deployed_url).toBe("https://lucky-paws.zavi.site");
    expect(a.body.app.build_status).toBe("done");
    expect(a.body.visibility).toBeNull();
    expect(a.body.badge_hidden).toBeNull();

    const b = await overview({ build_session_id: RUN_B });
    expect(b.body.site.id).toBe(SITE_B);
    expect(b.body.app.name).toBe("Website for Mile High Coffee");
    expect(b.body.app.deployed_url).toBeNull();
    expect(b.body.app.build_status).toBe("active");
    expect(db.singletonReads).toBe(0);
  });

  it("an old-flow session answers with the frozen legacy app", async () => {
    const old = await overview({ build_session_id: RUN_OLD });
    expect(old.statusCode).toBe(200);
    expect(old.body.site).toBeUndefined();
    expect(old.body.app.name).toBe("Old App");
    expect(old.body.visibility).toBe("private");
  });

  it("no session: the most recent active site, never a singleton guess", async () => {
    db.sites = [
      site(SITE_A, RUN_A, "lucky-paws.zavi.site", { created_at: "2026-10-01T00:00:00Z" }),
      site(SITE_B, RUN_B, "mile-high.zavi.site", { created_at: "2026-10-02T00:00:00Z", status: "building", live_deploy_id: null }),
    ];
    const none = await overview({});
    expect(none.statusCode).toBe(200);
    expect(none.body.site.id).toBe(SITE_B);
    expect(db.singletonReads).toBe(0);
  });

  it("no session: a deleted / failed / fell-back site is never the default; none left = legacy app", async () => {
    db.sites = [
      site(SITE_A, RUN_A, "lucky-paws.zavi.site", { created_at: "2026-10-01T00:00:00Z" }),
      site(SITE_B, RUN_B, "mile-high.zavi.site", { created_at: "2026-10-02T00:00:00Z", status: "deleted" }),
    ];
    expect((await overview({})).body.site.id).toBe(SITE_A);
    db.sites = [
      site(SITE_A, RUN_A, "lucky-paws.zavi.site", { status: "failed" }),
      site(SITE_B, RUN_B, "mile-high.zavi.site", { status: "fell_back_old" }),
    ];
    const legacy = await overview({});
    expect(legacy.body.site).toBeUndefined();
    expect(legacy.body.app.name).toBe("Old App");
  });

  it("an explicit site_id names that site; another tenant's or a deleted one is 404, malformed 400", async () => {
    const a = await overview({ site_id: SITE_A });
    expect(a.statusCode).toBe(200);
    expect(a.body.site.id).toBe(SITE_A);
    db.sites.push({ ...site("ffffffff-0000-4000-8000-00000000000f", RUN_FOREIGN, "x.zavi.site"), tenant_id: OTHER_T });
    const foreign = await overview({ site_id: "ffffffff-0000-4000-8000-00000000000f" });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body.error.code).toBe("site_not_found");
    db.sites[0] = { ...db.sites[0], status: "deleted" };
    expect((await overview({ site_id: SITE_A })).statusCode).toBe(404);
    expect((await overview({ site_id: "nope" })).statusCode).toBe(400);
    expect(db.singletonReads).toBe(0);
  });

  it("app=workspace (the Website surface) is the legacy app even when the workspace has sites", async () => {
    const r = await overview({ app: "workspace" });
    expect(r.statusCode).toBe(200);
    expect(r.body.site).toBeUndefined();
    expect(r.body.app.name).toBe("Old App");
    expect((await overview({ app: "nope" })).statusCode).toBe(400);
  });

  it("a deleted site's session is 404; a session whose site fell back to the old flow is the legacy app", async () => {
    db.sites = [site(SITE_A, RUN_A, "lucky-paws.zavi.site", { status: "deleted" })];
    const gone = await overview({ build_session_id: RUN_A });
    expect(gone.statusCode).toBe(404);
    expect(gone.body.error.code).toBe("site_not_found");
    expect(db.singletonReads).toBe(0);
    db.sites = [site(SITE_A, RUN_A, "lucky-paws.zavi.site", { status: "fell_back_old" })];
    const fell = await overview({ build_session_id: RUN_A });
    expect(fell.statusCode).toBe(200);
    expect(fell.body.site).toBeUndefined();
    expect(fell.body.app.name).toBe("Old App");
  });

  it("site_id and build_session_id must name the same app", async () => {
    expect((await overview({ site_id: SITE_A, build_session_id: RUN_A })).body.site.id).toBe(SITE_A);
    const clash = await overview({ site_id: SITE_A, build_session_id: RUN_B });
    expect(clash.statusCode).toBe(400);
    expect(clash.body.error.code).toBe("app_selection_conflict");
    expect((await overview({ site_id: SITE_A, build_session_id: RUN_OLD })).statusCode).toBe(400);
  });

  it("refuses another tenant's session (404), an unknown one (404) and a malformed one (400)", async () => {
    expect((await overview({ build_session_id: RUN_FOREIGN })).statusCode).toBe(404);
    expect((await overview({ build_session_id: "eeeeeeee-1111-4000-8000-00000000000e" })).statusCode).toBe(404);
    const bad = await overview({ build_session_id: "nope" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error.code).toBe("invalid_build_session");
    expect(db.singletonReads).toBe(0);
  });

  it("a session read outage is a 503, not the workspace app", async () => {
    db.runsError = { message: "down" };
    const r = await overview({ build_session_id: RUN_A });
    expect(r.statusCode).toBe(503);
    expect(r.body.error.code).toBe("build_session_check_failed");
  });

  it("a site run whose site row is gone is refused, not shown as the workspace app", async () => {
    db.sites = [];
    const r = await overview({ build_session_id: RUN_A });
    expect(r.statusCode).toBe(404);
    expect(db.singletonReads).toBe(0);
  });
});
