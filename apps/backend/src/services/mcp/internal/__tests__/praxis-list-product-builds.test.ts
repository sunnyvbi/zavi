import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
let buildRows: Row[] = [];
let freshCount = 0;
let totalCount = 0;
let queryError: { message: string } | null = null;
let hostingRows: Row[] = [];
let hostingError: { message: string } | null = null;
const capturedFilters: Array<[string, unknown]> = [];
const capturedOrs: string[] = [];
const capturedTables: string[] = [];
const capturedIs: Array<[string, unknown]> = [];
let headSelects = 0;
const sitesState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  error: null as Error | null,
  tenants: [] as string[],
}));
vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    listForTenant: async (tenant_id: string) => {
      sitesState.tenants.push(tenant_id);
      if (sitesState.error) throw sitesState.error;
      return sitesState.rows.filter((s) => s.tenant_id === tenant_id);
    },
  }),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      capturedTables.push(table);
      const isHosting = table === "tenant_resources";
      let isHead = false;
      let sawOr = false;
      const builder = {
        select: (_c?: string, opts?: { head?: boolean }) => {
          if (opts?.head) {
            isHead = true;
            headSelects += 1;
          }
          return builder;
        },
        eq: (k: string, v: unknown) => {
          capturedFilters.push([k, v]);
          return builder;
        },
        or: (f: string) => {
          capturedOrs.push(f);
          sawOr = true;
          return builder;
        },
        is: (k: string, v: unknown) => {
          capturedIs.push([k, v]);
          return builder;
        },
        order: (_c: string, _o?: unknown) => builder,
        limit: async (_n: number) => {
          if (isHosting) {
            return hostingError
              ? { data: null, error: hostingError }
              : { data: hostingRows, error: null };
          }
          return queryError ? { data: null, error: queryError } : { data: buildRows, error: null };
        },
        then: (resolve: (v: unknown) => void) => {
          if (!isHead) return resolve({ data: buildRows, error: null });
          if (queryError) return resolve({ count: null, error: queryError });
          return resolve({ count: sawOr ? freshCount : totalCount, error: null });
        },
      };
      return builder;
    },
  }),
}));

const publishState = vi.hoisted(() => ({ impl: null as null | ((t: string, sites: Array<{ id: string }>) => Promise<Map<string, unknown>>) }));
vi.mock("@/services/sites/site-publish-state", async (orig) => {
  const real = await orig<typeof import("@/services/sites/site-publish-state")>();
  return {
    ...real,
    sitePublishStates: (t: string, sites: Array<{ id: string }>, reads: unknown) =>
      publishState.impl ? publishState.impl(t, sites) : real.sitePublishStates(t, sites as never, reads as never),
  };
});

import { callPraxisTool, listPraxisTools } from "../praxis";

const ctx = { tenant_id: "t-1", run_id: "r-1", agent_slug: "operator" } as never;
const call = async () => {
  const r = await callPraxisTool(ctx, "list_product_builds", {});
  return { r, body: JSON.parse(r.content as string) };
};

const fresh = (id: string, status: string): Row => ({
  id,
  objective: "build it",
  status,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T01:00:00Z",
  goal_graph: [{ status, payload: { stage: "build" } }],
});
const refine = (id: string, status: string): Row => ({
  id,
  objective: "tweak it",
  status,
  created_at: "2026-09-02T00:00:00Z",
  updated_at: "2026-09-02T01:00:00Z",
  goal_graph: [{ status, payload: { stage: "build", refine_mode: true } }],
});

beforeEach(() => {
  buildRows = [];
  freshCount = 0;
  totalCount = 0;
  queryError = null;
  hostingRows = [];
  hostingError = null;
  capturedFilters.length = 0;
  capturedOrs.length = 0;
  capturedTables.length = 0;
  capturedIs.length = 0;
  headSelects = 0;
  sitesState.rows = [];
  sitesState.error = null;
  sitesState.tenants = [];
  publishState.impl = null;
});

describe("praxis__list_product_builds — registration and scoping", () => {
  it("is a registered, callable tool (so the prompt's grounding rule has an instrument)", () => {
    expect(listPraxisTools().map((t) => t.tool_name)).toContain("list_product_builds");
  });

  it("reads conductor_runs kind='build_app', scoped to the run's tenant", async () => {
    await call();
    expect(capturedTables).toContain("conductor_runs");
    expect(capturedFilters).toContainEqual(["tenant_id", "t-1"]);
    expect(capturedFilters).toContainEqual(["kind", "build_app"]);
  });

  it("surfaces a query failure instead of an empty list that reads as 'no builds'", async () => {
    queryError = { message: "boom" };
    const { r, body } = await call();
    expect(r.ok).toBe(false);
    expect(body.error).toBe("list_product_builds_failed");
    expect(body.product_builds).toBeUndefined();
  });
});

describe("praxis__list_product_builds — currently_live (G4 P1)", () => {
  it("latest fresh build done → live", async () => {
    buildRows = [fresh("b2", "done"), fresh("b1", "done")];
    freshCount = totalCount = 2;
    const { body } = await call();
    expect(body.currently_live).toBe(true);
  });

  it("a NEWER fresh build that FAILED over an older done build → NOT live", async () => {
    buildRows = [fresh("b2", "failed"), fresh("b1", "done")];
    freshCount = totalCount = 2;
    const { body } = await call();
    expect(body.currently_live).toBe(false);
    expect(body.live_reason).toMatch(/placeholder/i);
    expect(body.live_reason).toMatch(/failed/);
  });

  it("a newer fresh build still ACTIVE over an older done build → NOT live", async () => {
    buildRows = [fresh("b2", "active"), fresh("b1", "done")];
    freshCount = totalCount = 2;
    const { body } = await call();
    expect(body.currently_live).toBe(false);
  });

  it("a refine after a done fresh build inherits live", async () => {
    buildRows = [refine("r1", "active"), fresh("b1", "done")];
    freshCount = 1;
    totalCount = 2;
    const { body } = await call();
    expect(body.currently_live).toBe(true);
  });

  it("a refine after a FAILED fresh build does NOT confer live", async () => {
    buildRows = [refine("r1", "done"), fresh("b2", "failed"), fresh("b1", "done")];
    freshCount = 2;
    totalCount = 3;
    const { body } = await call();
    expect(body.currently_live).toBe(false);
  });

  it("marks which row decides liveness and which are superseded history", async () => {
    buildRows = [fresh("b2", "failed"), fresh("b1", "done")];
    freshCount = totalCount = 2;
    const { body } = await call();
    const byId = Object.fromEntries(body.builds.map((b: Row) => [b.build_id, b]));
    expect(byId.b2.decides_liveness).toBe(true);
    expect(byId.b2.superseded).toBe(false);
    expect(byId.b1.decides_liveness).toBe(false);
    expect(byId.b1.superseded).toBe(true);
  });

  it("states that liveness was NOT probed, so 'live' is never overread as 'the site is up'", async () => {
    buildRows = [fresh("b1", "done")];
    freshCount = totalCount = 1;
    const { body } = await call();
    expect(body.live_check).toMatch(/not probed/i);
  });
});

describe("praxis__list_product_builds — honest counts (G4 P2)", () => {
  it("product_builds is an EXACT head count, not the length of the capped page", async () => {
    buildRows = Array.from({ length: 20 }, (_, i) => fresh(`b${i}`, "done"));
    freshCount = 57;
    totalCount = 61;
    const { body } = await call();
    expect(headSelects).toBeGreaterThanOrEqual(2);
    expect(body.product_builds).toBe(57);
    expect(body.builds_returned).toBe(20);
    expect(body.builds_truncated).toBe(true);
  });

  it("refines are counted separately and are NOT counted as builds", async () => {
    buildRows = [refine("r1", "done"), fresh("b1", "done")];
    freshCount = 1;
    totalCount = 4;
    const { body } = await call();
    expect(body.product_builds).toBe(1);
    expect(body.refines).toBe(3);
    expect(capturedOrs.some((f) => f.includes("refine_mode"))).toBe(true);
  });

  it("does not claim truncation when the page is the whole history", async () => {
    buildRows = [fresh("b1", "done")];
    freshCount = totalCount = 1;
    const { body } = await call();
    expect(body.builds_truncated).toBe(false);
  });

  it("a tenant that never built anything gets 0 and an explicit not-an-agent-run note", async () => {
    const { r, body } = await call();
    expect(r.ok).toBe(true);
    expect(body.product_builds).toBe(0);
    expect(body.currently_live).toBe(false);
    expect(body.builds).toEqual([]);
    expect(body.note).toMatch(/never started a product build/i);
    expect(body.note).toMatch(/agent runs are a different object/i);
  });
});

describe("praxis__list_product_builds — per-build detail", () => {
  it("returns stage-by-stage status so 'what stage is it on' is answerable", async () => {
    buildRows = [
      {
        id: "b-1",
        objective: "ship the marketplace",
        status: "active",
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T01:00:00Z",
        goal_graph: [
          { status: "done", payload: { stage: "spec" } },
          { status: "running", payload: { stage: "build" } },
          { status: "pending", payload: { stage: "deploy" } },
        ],
      },
    ];
    freshCount = totalCount = 1;
    const { body } = await call();
    expect(body.builds[0].stages).toEqual([
      { stage: "spec", status: "done" },
      { stage: "build", status: "running" },
      { stage: "deploy", status: "pending" },
    ]);
  });
});

const hosting = (status: string, url?: unknown): Row => ({
  status,
  external_ref: url === undefined ? {} : { url, render_service_id: "srv-1" },
});

describe("praxis__list_product_builds — live_url, the address the verdict is about", () => {
  it("hands back the live address for the prod shape that shipped a page with nowhere to open it", async () => {
    buildRows = [
      {
        id: "0db945c6-acce-4a73-b6e9-e40294882815",
        objective: "Build product: UpcarAI — A launch-ready landing page",
        status: "done",
        created_at: "2026-09-22T10:06:11Z",
        updated_at: "2026-09-22T10:28:05Z",
        goal_graph: [
          { status: "done", payload: { stage: "provision" } },
          { status: "done", payload: { stage: "spec" } },
          { status: "done", payload: { stage: "scaffold" } },
          { status: "done", payload: { stage: "build" } },
          { status: "done", payload: { stage: "qa" } },
          { status: "done", payload: { stage: "deploy", deploy_enqueued_at: 1790072885522 } },
        ],
      },
    ];
    freshCount = totalCount = 1;
    hostingRows = [hosting("ready", "https://upcarai-6ec4d609.onrender.com")];

    const { body } = await call();

    expect(body.currently_live).toBe(true);
    expect(body.live_url).toBe("https://upcarai-6ec4d609.onrender.com");
  });

  it("reads the hosting row scoped to this tenant's provisioned hosting resource", async () => {
    hostingRows = [hosting("ready", "https://x.onrender.com")];
    await call();
    expect(capturedTables).toContain("tenant_resources");
    expect(capturedFilters).toContainEqual(["resource_kind", "hosting"]);
    expect(capturedFilters).toContainEqual(["mode", "provisioned"]);
    expect(capturedFilters.filter(([k]) => k === "tenant_id").every(([, v]) => v === "t-1")).toBe(
      true,
    );
  });

  it("withholds the address when a NEWER failed build re-seeded the placeholder under a 'ready' host", async () => {
    buildRows = [fresh("b2", "failed"), fresh("b1", "done")];
    freshCount = totalCount = 2;
    hostingRows = [hosting("ready", "https://upcarai-6ec4d609.onrender.com")];

    const { body } = await call();

    expect(body.currently_live).toBe(false);
    expect(body.live_url).toBeNull();
  });

  it("withholds the address while a fresh build is still running over a 'ready' host", async () => {
    buildRows = [fresh("b2", "active"), fresh("b1", "done")];
    freshCount = totalCount = 2;
    hostingRows = [hosting("ready", "https://upcarai-6ec4d609.onrender.com")];
    const { body } = await call();
    expect(body.live_url).toBeNull();
  });

  it("withholds the address when hosting has a url but has not reached 'ready'", async () => {
    buildRows = [fresh("b1", "done")];
    freshCount = totalCount = 1;
    hostingRows = [hosting("provisioning", "https://upcarai-6ec4d609.onrender.com")];
    const { body } = await call();
    expect(body.currently_live).toBe(true);
    expect(body.live_url).toBeNull();
  });

  it("withholds the address when the jsonb url is not a string", async () => {
    buildRows = [fresh("b1", "done")];
    freshCount = totalCount = 1;
    hostingRows = [hosting("ready", { href: "https://upcarai-6ec4d609.onrender.com" })];
    const { body } = await call();
    expect(body.live_url).toBeNull();
  });

  it("returns live_url as an explicit null, never an absent key, so the agent cannot read it as unknown", async () => {
    buildRows = [fresh("b1", "done")];
    freshCount = totalCount = 1;
    const { r, body } = await call();
    expect(r.ok).toBe(true);
    expect("live_url" in body).toBe(true);
    expect(body.live_url).toBeNull();
    expect(JSON.parse(r.content as string).live_url).toBeNull();
  });

  it("fails soft: a hosting read error costs the address, not the build list", async () => {
    buildRows = [fresh("b1", "done")];
    freshCount = totalCount = 1;
    hostingError = { message: "hosting read blew up" };

    const { r, body } = await call();

    expect(r.ok).toBe(true);
    expect(body.error).toBeUndefined();
    expect(body.currently_live).toBe(true);
    expect(body.builds).toHaveLength(1);
    expect(body.live_url).toBeNull();
  });

  it("tells the agent to paste the address rather than describe it", () => {
    const desc = listPraxisTools().find((t) => t.tool_name === "list_product_builds")!.description;
    expect(desc).toMatch(/live_url/);
    expect(desc).toMatch(/paste that exact URL/i);
    expect(desc).toMatch(/never invent or guess/i);
  });
});

describe("praxis__list_product_builds — many apps in one workspace", () => {
  const SITE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
  const SITE_B = "bbbbbbbb-0000-4000-8000-00000000000b";
  const siteBuild = (id: string, site: string, status: string, at: string): Row => ({
    id,
    objective: "Build product: site",
    status,
    created_at: at,
    updated_at: at,
    goal_graph: [
      { status, payload: { stage: "provision", site_id: site } },
      { status, payload: { stage: "build", site_id: site } },
    ],
  });
  const siteRow = (id: string, status: string, extra: Row = {}): Row => ({
    id,
    tenant_id: "t-1",
    hostname: `${id.slice(0, 4)}.zavi.site`,
    status,
    live_url: `https://${id.slice(0, 4)}.zavi.site`,
    live_deploy_id: status === "live" ? "dep-1" : null,
    root_conductor_run_id: null,
    created_at: "2026-09-30T00:00:00Z",
    ...extra,
  });

  it("an older site is NOT superseded by a newer, different site; each site keeps its own verdict", async () => {
    buildRows = [
      siteBuild("b-new", SITE_B, "active", "2026-10-01T02:00:00Z"),
      siteBuild("a-old", SITE_A, "done", "2026-10-01T01:00:00Z"),
    ];
    freshCount = totalCount = 2;
    sitesState.rows = [siteRow(SITE_B, "building"), siteRow(SITE_A, "live")];
    const { body } = await call();
    const byId = Object.fromEntries(body.builds.map((b: Row) => [b.build_id, b]));
    expect(byId["a-old"].superseded).toBe(false);
    expect(byId["a-old"].site_id).toBe(SITE_A);
    expect(byId["b-new"].site_id).toBe(SITE_B);
    expect(body.currently_live).toBe(true);
    expect(body.live_url).toBe("https://aaaa.zavi.site");
    const apps = Object.fromEntries(body.apps.map((a: Row) => [a.site_id, a]));
    expect(apps[SITE_A]).toMatchObject({ kind: "site", currently_live: true, live_url: "https://aaaa.zavi.site" });
    expect(apps[SITE_B]).toMatchObject({ kind: "site", currently_live: false, live_url: null });
  });

  it("a newer build of the SAME site still supersedes the older one", async () => {
    buildRows = [
      siteBuild("a-2", SITE_A, "active", "2026-10-01T02:00:00Z"),
      siteBuild("a-1", SITE_A, "done", "2026-10-01T01:00:00Z"),
    ];
    freshCount = totalCount = 2;
    sitesState.rows = [siteRow(SITE_A, "building")];
    const { body } = await call();
    const byId = Object.fromEntries(body.builds.map((b: Row) => [b.build_id, b]));
    expect(byId["a-1"].superseded).toBe(true);
    expect(byId["a-2"].superseded).toBe(false);
  });

  it("the original app's liveness is decided by ITS latest build, never by a newer site build", async () => {
    buildRows = [siteBuild("s-new", SITE_A, "failed", "2026-10-01T02:00:00Z"), fresh("old-1", "done")];
    freshCount = totalCount = 2;
    hostingRows = [hosting("ready", "https://old-app.onrender.com")];
    sitesState.rows = [siteRow(SITE_A, "failed")];
    const { body } = await call();
    for (const n of [0, 1, 2]) expect(capturedIs).toContainEqual([`goal_graph->${n}->payload->>site_id`, null]);
    const byId = Object.fromEntries(body.builds.map((b: Row) => [b.build_id, b]));
    expect(byId["old-1"].superseded).toBe(false);
    expect(byId["old-1"].decides_liveness).toBe(true);
    expect(body.currently_live).toBe(true);
    expect(body.live_url).toBe("https://old-app.onrender.com");
    const workspaceApp = body.apps.find((a: Row) => a.kind === "workspace_app");
    expect(workspaceApp).toMatchObject({ currently_live: true, live_url: "https://old-app.onrender.com" });
  });

  it("reads sites for THIS run's tenant only, and a sites read failure fails the call instead of saying 'not live'", async () => {
    buildRows = [siteBuild("a-1", SITE_A, "done", "2026-10-01T01:00:00Z")];
    freshCount = totalCount = 1;
    sitesState.rows = [siteRow(SITE_A, "live"), siteRow(SITE_B, "live", { tenant_id: "t-other" })];
    const ok = await call();
    expect(sitesState.tenants).toEqual(["t-1"]);
    expect(ok.body.apps.map((a: Row) => a.site_id)).toEqual([SITE_A]);
    sitesState.error = new Error("sites down");
    const { r, body } = await call();
    expect(r.ok).toBe(false);
    expect(body.error).toBe("list_product_builds_failed");
  });

  it("a workspace with no site run in view keeps answering for its own app when sites cannot be read", async () => {
    buildRows = [fresh("old-1", "done")];
    freshCount = totalCount = 1;
    sitesState.error = new Error("sites down");
    const { r, body } = await call();
    expect(r.ok).toBe(true);
    expect(body.currently_live).toBe(true);
    expect(body.sites_checked).toBe(false);
  });

  it("deleted and fallen-back sites are not apps", async () => {
    buildRows = [siteBuild("a-1", SITE_A, "done", "2026-10-01T01:00:00Z")];
    freshCount = totalCount = 1;
    sitesState.rows = [siteRow(SITE_A, "deleted"), siteRow(SITE_B, "fell_back_old")];
    const { body } = await call();
    expect(body.apps).toEqual([]);
    expect(body.currently_live).toBe(false);
  });
});

describe("praxis__list_product_builds — a site's waiting version and custom domains", () => {
  const SITE = "cccccccc-0000-4000-8000-00000000000c";
  const pendingSite = {
    id: SITE,
    tenant_id: "t-1",
    hostname: "cccc.zavi.site",
    status: "live",
    live_url: "https://cccc.zavi.site",
    live_deploy_id: "dep-1",
    root_conductor_run_id: null,
    desired_sha: "e0027618aaaa",
    live_sha: "00acd47bbbbb",
    last_error: "gate: the home page shows no photo",
    created_at: "2026-09-30T00:00:00Z",
  };

  it("carries each site's publish state, and says a site has no custom domains yet", async () => {
    sitesState.rows = [pendingSite];
    const state = { pending: true, publish_status: "failed", last_problem: "held back", preview_url: null, open_in_zavi: "x" };
    publishState.impl = async (t, sites) => {
      expect(t).toBe("t-1");
      return new Map(sites.map((st) => [st.id, state]));
    };
    const { body } = await call();
    const app = body.apps.find((a: Row) => a.site_id === SITE);
    expect(app.publish).toEqual(state);
    expect(JSON.stringify(body)).not.toMatch(/gate:|no photo/);
    expect(body.custom_domains.site).toMatchObject({ available: false });
    expect(body.custom_domains.workspace_app).toBeUndefined();
  });

  it("an unreadable publish state is said to be unchecked, and the call still answers", async () => {
    sitesState.rows = [pendingSite];
    publishState.impl = async () => {
      throw new Error("boom");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { r, body } = await call();
    warn.mockRestore();
    expect(r.ok).toBe(true);
    const app = body.apps.find((a: Row) => a.site_id === SITE);
    expect(app.publish_checked).toBe(false);
    expect(app.publish).toBeUndefined();
  });
});
