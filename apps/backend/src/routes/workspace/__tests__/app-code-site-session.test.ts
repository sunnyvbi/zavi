
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  singleton: null as Row | null,
  runsError: null as { message: string } | null,
  runFilters: [] as Array<[string, unknown]>,
}));

function marker(r: Row, i: number): unknown {
  const g = r.goal_graph as Array<{ payload?: Row }> | undefined;
  return g?.[i]?.payload?.site_id ?? null;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: db.singleton, error: null }),
    };
    return { from: () => q };
  },
  serverClientFromBearer: () => ({
    from: () => {
      const eqs: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (eqs.push([c, v]), db.runFilters.push([c, v]), q),
        maybeSingle: async () => {
          if (db.runsError) return { data: null, error: db.runsError };
          const r = db.runs.find((row) => eqs.every(([c, v]) => row[c] === v));
          return { data: r ? { id: r.id, s0: marker(r, 0), s1: marker(r, 1), s2: marker(r, 2) } : null, error: null };
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    getByRun: async (tid: string, run: string) => db.sites.find((s) => s.tenant_id === tid && s.root_conductor_run_id === run) ?? null,
    get: async (tid: string, id: string) => db.sites.find((s) => s.tenant_id === tid && s.id === id) ?? null,
    listForTenant: async (tid: string) => db.sites.filter((s) => s.tenant_id === tid),
  }),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: T, user_id: "u1", access_token: "tok" })),
  authMiddleware: vi.fn(),
}));

import { getWorkspaceAppCodeTree } from "../app-code";

type Res = { statusCode: number; body: unknown; status: (n: number) => Res; json: (b: unknown) => Res };
function mockRes(): Res {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

const fetched: string[] = [];
const run = (id: string, tenant: string, site: string | null): Row => ({
  id, tenant_id: tenant, kind: "build_app",
  goal_graph: [{ payload: { stage: "provision", ...(site ? { site_id: site } : {}) } }],
});
const site = (id: string, run_id: string, repo: string | null, tenant = T): Row => ({
  id, tenant_id: tenant, root_conductor_run_id: run_id, github_full_name: repo, status: "live", hostname: `${id}.zavi.site`,
});

beforeEach(() => {
  process.env.GITHUB_PROVISION_TOKEN = "umbrella";
  db.runs = [run(RUN_A, T, SITE_A), run(RUN_B, T, SITE_B), run(RUN_OLD, T, null), run(RUN_FOREIGN, OTHER_T, SITE_A)];
  db.sites = [site(SITE_A, RUN_A, "zavi-sites/lucky-paws"), site(SITE_B, RUN_B, "zavi-sites/mile-high")];
  db.singleton = { mode: "provisioned", external_ref: { github_full_name: "Praxis-build/old-app", default_branch: "trunk" } };
  db.runsError = null;
  db.runFilters = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(url);
      return { status: 200, json: async () => ({ tree: [{ path: "README.md", type: "blob" }], truncated: false }), text: async () => "" };
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetched.length = 0;
});

async function tree(query: Record<string, unknown>) {
  const res = mockRes();
  await getWorkspaceAppCodeTree({ query, headers: {} } as never, res as never);
  return res;
}

describe("Code tab reads the app in view", () => {
  it("site A's session reads site A's repo, site B's reads site B's (two sites in one tenant)", async () => {
    const a = await tree({ build_session_id: RUN_A });
    expect(a.statusCode).toBe(200);
    expect(fetched.join(" ")).toContain("zavi-sites/lucky-paws");
    expect(fetched.join(" ")).not.toMatch(/mile-high|old-app/);
    fetched.length = 0;
    const b = await tree({ build_session_id: RUN_B });
    expect(b.statusCode).toBe(200);
    expect(fetched.join(" ")).toContain("zavi-sites/mile-high");
    expect(fetched.join(" ")).not.toMatch(/lucky-paws|old-app/);
  });

  it("the session ownership read is scoped to the caller's tenant and a build run", async () => {
    await tree({ build_session_id: RUN_A });
    expect(db.runFilters).toContainEqual(["tenant_id", T]);
    expect(db.runFilters).toContainEqual(["kind", "build_app"]);
  });

  it("an old-flow session reads the frozen legacy app's repo", async () => {
    await tree({ build_session_id: RUN_OLD });
    expect(fetched.join(" ")).toContain("Praxis-build/old-app");
  });

  it("no session reads the most recent active site's repo, never the singleton", async () => {
    db.sites = [
      { ...site(SITE_A, RUN_A, "zavi-sites/lucky-paws"), created_at: "2026-10-01T00:00:00Z" },
      { ...site(SITE_B, RUN_B, "zavi-sites/mile-high"), created_at: "2026-10-02T00:00:00Z" },
    ];
    const r = await tree({});
    expect(r.statusCode).toBe(200);
    expect(fetched.join(" ")).toContain("zavi-sites/mile-high");
    expect(fetched.join(" ")).not.toMatch(/lucky-paws|old-app/);
  });

  it("no session and no active site (all deleted) reads the legacy app; none at all = 409", async () => {
    db.sites = [{ ...site(SITE_A, RUN_A, "zavi-sites/lucky-paws"), status: "deleted" }];
    await tree({});
    expect(fetched.join(" ")).toContain("Praxis-build/old-app");
    fetched.length = 0;
    db.singleton = null;
    const none = await tree({});
    expect(none.statusCode).toBe(409);
    expect(fetched).toEqual([]);
  });

  it("an explicit site_id reads that site; another tenant's site id is 404 with no read", async () => {
    await tree({ site_id: SITE_A });
    expect(fetched.join(" ")).toContain("zavi-sites/lucky-paws");
    fetched.length = 0;
    db.sites.push(site("ffffffff-0000-4000-8000-00000000000f", RUN_FOREIGN, "zavi-sites/theirs", OTHER_T));
    const r = await tree({ site_id: "ffffffff-0000-4000-8000-00000000000f" });
    expect(r.statusCode).toBe(404);
    expect((r.body as { error: { code: string } }).error.code).toBe("site_not_found");
    expect(fetched).toEqual([]);
  });

  it("app=workspace reads the legacy app's repo even when the workspace has sites", async () => {
    const r = await tree({ app: "workspace" });
    expect(r.statusCode).toBe(200);
    expect(fetched.join(" ")).toContain("Praxis-build/old-app");
    expect(fetched.join(" ")).not.toMatch(/lucky-paws|mile-high/);
  });

  it("a deleted site's session is refused, not answered with its old repo or the singleton", async () => {
    db.sites = [{ ...site(SITE_A, RUN_A, "zavi-sites/lucky-paws"), status: "deleting" }];
    const r = await tree({ build_session_id: RUN_A });
    expect(r.statusCode).toBe(404);
    expect(fetched).toEqual([]);
  });

  it("refuses another tenant's session (404) without reading any repo", async () => {
    const r = await tree({ build_session_id: RUN_FOREIGN });
    expect(r.statusCode).toBe(404);
    expect((r.body as { error: { code: string } }).error.code).toBe("build_session_not_found");
    expect(fetched).toEqual([]);
  });

  it("refuses an unknown (404) or malformed (400) session, and a read outage is 503", async () => {
    expect((await tree({ build_session_id: "eeeeeeee-1111-4000-8000-00000000000e" })).statusCode).toBe(404);
    expect((await tree({ build_session_id: "not-a-uuid" })).statusCode).toBe(400);
    expect((await tree({ build_session_id: "" })).statusCode).toBe(400);
    db.runsError = { message: "boom" };
    expect((await tree({ build_session_id: RUN_A })).statusCode).toBe(503);
    expect(fetched).toEqual([]);
  });

  it("a site run whose site row is another tenant's is refused, never the singleton", async () => {
    db.sites = [site(SITE_A, RUN_A, "zavi-sites/lucky-paws", OTHER_T)];
    const r = await tree({ build_session_id: RUN_A });
    expect(r.statusCode).toBe(404);
    expect(fetched).toEqual([]);
  });

  it("a run with a corrupt (non-uuid) site marker is refused, never read as the workspace app", async () => {
    db.runs.push({ id: "eeeeeeee-2222-4000-8000-00000000000e", tenant_id: T, kind: "build_app", goal_graph: [{ payload: { site_id: "not-a-site" } }] });
    const r = await tree({ build_session_id: "eeeeeeee-2222-4000-8000-00000000000e" });
    expect(r.statusCode).toBe(404);
    expect(fetched).toEqual([]);
  });

  it("a site without a repo yet answers no_provisioned_repo, not the singleton's code", async () => {
    db.sites = [site(SITE_A, RUN_A, null), site(SITE_B, RUN_B, "zavi-sites/mile-high")];
    const r = await tree({ build_session_id: RUN_A });
    expect(r.statusCode).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe("no_provisioned_repo");
    expect(fetched).toEqual([]);
  });
});
