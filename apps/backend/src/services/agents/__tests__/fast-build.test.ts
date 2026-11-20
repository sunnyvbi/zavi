
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  startFastBuild,
  fastBuildEstimateUsd,
  OWNER_ADMIN_RETRY_DELAYS_MS,
  SITE_SETUP_CONFIG_ALERT_CODE,
  type FastBuildDeps,
} from "@/services/agents/fast-build";
import { SiteCredentialsMissing } from "@/services/sites/contract";
import type { FastBuildContext, StarterFiles } from "@/services/sites/contract";
import type { ConductorNode } from "@/services/agents/conductor";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/vite-react-zavi/template-files.generated";
import { brandPreset } from "@/services/sites/design-directions";
import { renderThemeCss } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import type { DesignBrief } from "@/services/sites/design-brief";
import {
  fakeRepo,
  fakeStore,
  fakeSupabase,
  providersOf,
  STARTER,
  type FakeRepo,
  type FakeStore,
  type FakeSupabase,
} from "@/services/sites/__tests__/site-fakes";

const T1 = "11111111-1111-4111-8111-111111111111";

function ctx(over: Partial<FastBuildContext> = {}): FastBuildContext {
  return {
    tenant_id: T1,
    conductor_run_id: "run-1",
    company_name: "Studio Co",
    idea: "A booking site",
    max_usd: 50,
    started_by_user_id: "u1",
    owner_email: "owner@example.com",
    first_build_free: false,
    ...over,
  };
}

const POOLED_STARTER: StarterFiles = {
  files: { "package.json": "{}", "src/zavi.ts": "export {};" },
  starter_sql: "create table should_never_ship (id int);",
  manifest_json: '{"schemaVersion":1,"collections":{}}',
};
const NEEDS_DEDICATED: StarterFiles = {
  files: { "package.json": "{}" },
  manifest_json: '{"schemaVersion":1,"collections":{},"capabilities":["payments"]}',
};

let store: FakeStore;
let repo: FakeRepo;
let sb: FakeSupabase;
let graphs: Array<{ conductor_run_id: string; goal_graph: ConductorNode[] }>;
let alerts: Array<{ code: string; msg: string; tenant_id: string }>;
let pooledStarter: StarterFiles;
let pooledReady: boolean | "throws";
let staticCalls: string[];

function pooled() {
  return {
    enabledFor: vi.fn(async () => {
      if (pooledReady === "throws") throw new Error("readiness down");
      return pooledReady;
    }),
    starter: vi.fn(async () => ({ starterFiles: () => pooledStarter })),
    initStatic: vi.fn(async (_t: string, s: string) => {
      staticCalls.push(`static:${s}`);
      const site = store.sites.get(s);
      if (site) site.backend_mode = "static";
    }),
  };
}

function deps(over: Partial<FastBuildDeps> = {}): Partial<FastBuildDeps> {
  return {
    holdSearch: async () => undefined,
    store,
    repo,
    supabase: sb,
    starter: { starterFiles: () => STARTER },
    pooled: pooled(),
    updateConductorRunStatus: async (p) => { graphs.push(p); },
    ensureGithubConnector: vi.fn(async () => undefined),
    alert: async (a) => { alerts.push(a); },
    sleep: async () => undefined,
    publishOnRequest: async () => false,
    designBrief: async () => ({ brief: null, reason: "test_default" }),
    designStore: null,
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  store = fakeStore();
  repo = fakeRepo();
  sb = fakeSupabase(store);
  graphs = [];
  alerts = [];
  pooledStarter = POOLED_STARTER;
  pooledReady = true;
  staticCalls = [];
});

const BRIEF: DesignBrief = {
  industry: "coffee shop",
  mood: "warm cosy crafted",
  mode: "light",
  colors: {
    background: "#fff8f1",
    foreground: "#2b1d14",
    muted: "#f3e6d8",
    "muted-foreground": "#6b4f3a",
    primary: "#b4532a",
    "primary-foreground": "#ffffff",
    border: "#e6d3c0",
  },
  fonts: { heading: "Fraunces", body: "DM Sans" },
};

describe("startFastBuild: the design brief is in the repo before the engineer starts", () => {
  const styled = {
    ...POOLED_STARTER,
    files: { ...POOLED_STARTER.files, "src/index.css": TEMPLATE_FILES["src/index.css"], "src/theme.css": TEMPLATE_FILES["src/theme.css"], "index.html": TEMPLATE_FILES["index.html"] },
  };

  it("the seed commit carries the brief's colours and fonts, and the build node carries the brief", async () => {
    pooledStarter = styled;
    const seeded: Array<Record<string, string>> = [];
    repo.seed = async (_t: string, _r: string, files: Record<string, string>) => {
      seeded.push(files);
      return "a".repeat(40);
    };
    const designBrief = vi.fn(async () => ({ brief: BRIEF }));
    const r = await startFastBuild(ctx(), deps({ designBrief }));
    expect(r.kind).toBe("started");
    const [site] = [...store.sites.values()];
    expect(designBrief).toHaveBeenCalledWith({ idea: ctx().idea, name: site.name });
    const stored = graphs[0].goal_graph[1].payload.design_brief as DesignBrief;
    expect(stored).toMatchObject(BRIEF);
    expect(seeded[0]["src/theme.css"]).toBe(renderThemeCss(brandPreset(stored)));
    expect(seeded[0]["src/theme.css"]).not.toBe(TEMPLATE_FILES["src/theme.css"]);
    expect(seeded[0]["src/theme.css"]).toContain("family=Fraunces:wght@");
    const look = stored.look!;
    expect(look.alternates).toHaveLength(2);
    expect(look.alternates).not.toContain(look.base);
  });

  it("a failed or empty brief seeds the deterministic fallback look, never the bare starter, and the build still starts", async () => {
    for (const designBrief of [
      vi.fn(async () => {
        throw new Error("model down");
      }),
      vi.fn(async () => ({ brief: null, reason: "unparseable" })),
    ]) {
      store = fakeStore();
      repo = fakeRepo();
      graphs = [];
      pooledStarter = styled;
      const seeded: Array<Record<string, string>> = [];
      repo.seed = async (_t: string, _r: string, files: Record<string, string>) => {
        seeded.push(files);
        return "a".repeat(40);
      };
      const r = await startFastBuild(ctx(), deps({ designBrief }));
      expect(r.kind).toBe("started");
      expect(seeded[0]["src/theme.css"]).not.toBe(TEMPLATE_FILES["src/theme.css"]);
      expect((graphs[0].goal_graph[1].payload.design_brief as DesignBrief).source).toBe("fallback");
    }
  });
});

describe("startFastBuild — pooled (every new site)", () => {
  it("NEVER creates a per-site Supabase project, runs no SQL, registers no admin; the site starts static and building", async () => {
    const seeded: Array<Record<string, string>> = [];
    repo.seed = async (_t: string, _r: string, files: Record<string, string>) => {
      seeded.push(files);
      return "a".repeat(40);
    };
    const r = await startFastBuild(ctx(), deps());
    expect(r.kind).toBe("started");
    const [site] = [...store.sites.values()];
    expect(sb.calls).toEqual([]);
    expect(sb.projects.size).toBe(0);
    expect(staticCalls).toEqual([`static:${site.id}`]);
    expect(providersOf(store, T1, site.id).map((x) => x.kind)).toEqual(["github_repo"]);
    expect(seeded[0]["src/zavi.ts"]).toBeDefined();
    expect(Object.keys(seeded[0]).some((k) => k.startsWith("supabase/"))).toBe(false);
    expect(Object.values(seeded[0]).join("\n")).not.toContain("should_never_ship");
    expect(site.status).toBe("building");
    expect(site.desired_sha).toBe("a".repeat(40));
    expect(site.owner_email).toBe("owner@example.com");
    if (r.kind === "started") expect(r.result.provision.provisioned).toEqual(["repo"]);
  });

  it("writes the 3-node site graph on the site's own repo", async () => {
    const r = await startFastBuild(ctx({ reference_images: ["https://img/a.png"] }), deps());
    const [site] = [...store.sites.values()];
    const g = graphs[0].goal_graph;
    expect(g.map((n) => [n.payload.stage, n.status])).toEqual([
      ["provision", "done"],
      ["build", "pending"],
      ["deploy", "pending"],
    ]);
    for (const n of g) expect(n.payload.site_id).toBe(site.id);
    expect(g[1].payload.fast_single_pass).toBe(true);
    expect(g[1].payload.reference_images).toEqual(["https://img/a.png"]);
    expect((g[1].payload.target as { github_full_name: string }).github_full_name).toBe(site.github_full_name);
    if (r.kind === "started") expect(r.result.conductor_run_id).toBe("run-1");
  });

  it("build_publish_on_request on: the graph is provision and build only, the tenant's own setting is read, and the site still has its repo and seed commit", async () => {
    const publishOnRequest = vi.fn(async (tenant_id: string) => tenant_id === T1);
    const r = await startFastBuild(ctx({ reference_images: ["https://img/a.png"] }), deps({ publishOnRequest }));
    expect(r.kind).toBe("started");
    expect(publishOnRequest.mock.calls).toEqual([[T1]]);
    expect(graphs).toHaveLength(1);
    const g = graphs[0].goal_graph;
    expect(g.map((n) => [n.payload.stage, n.status])).toEqual([
      ["provision", "done"],
      ["build", "pending"],
    ]);
    expect(g.some((n) => n.payload.stage === "deploy" || /-deploy$/.test(n.id) || "seed_sha" in n.payload)).toBe(false);
    const [site] = [...store.sites.values()];
    for (const n of g) expect(n.payload.site_id).toBe(site.id);
    expect(g[1].payload.fast_single_pass).toBe(true);
    expect(g[1].payload.reference_images).toEqual(["https://img/a.png"]);
    expect(site.status).toBe("building");
    expect(site.desired_sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(site.live_deploy_id ?? null).toBeNull();
  });

  it("build_publish_on_request is read per build: another tenant with it off still gets the deploy node in the same process", async () => {
    const T2 = "22222222-2222-4222-8222-222222222222";
    const publishOnRequest = vi.fn(async (tenant_id: string) => tenant_id === T1);
    await startFastBuild(ctx({ conductor_run_id: "run-1" }), deps({ publishOnRequest }));
    await startFastBuild(ctx({ tenant_id: T2, conductor_run_id: "run-2" }), deps({ publishOnRequest }));
    expect(publishOnRequest.mock.calls).toEqual([[T1], [T2]]);
    expect(graphs.map((x) => x.goal_graph.map((n) => n.payload.stage))).toEqual([
      ["provision", "build"],
      ["provision", "build", "deploy"],
    ]);
  });

  it("only a workspace's first site is held out of search; a later site never is", async () => {
    const holdSearch = vi.fn().mockResolvedValue(undefined);
    await startFastBuild(ctx({ first_build_free: false }), deps({ holdSearch }));
    expect(holdSearch).not.toHaveBeenCalled();
    await startFastBuild(ctx({ conductor_run_id: "run-2", first_build_free: true }), deps({ holdSearch }));
    expect(holdSearch).toHaveBeenCalledTimes(1);
    holdSearch.mockClear();
    await startFastBuild(ctx({ conductor_run_id: "run-3", first_site: true, first_build_free: false }), deps({ holdSearch }));
    expect(holdSearch).toHaveBeenCalledTimes(1);
  });

  it("a held first site is the one that goes live by itself, and a later site on publish-on-request is not held", async () => {
    const holdSearch = vi.fn().mockResolvedValue(undefined);
    await startFastBuild(ctx({ first_build_free: false }), deps({ holdSearch, publishOnRequest: async () => true }));
    expect(holdSearch).not.toHaveBeenCalled();
    expect(graphs[0].goal_graph.map((n) => n.payload.stage)).toEqual(["provision", "build"]);
  });

  it("a failed search hold never fails the build", async () => {
    const r = await startFastBuild(ctx({ first_build_free: true }), deps({ holdSearch: vi.fn().mockRejectedValue(new Error("rpc down")) }));
    expect(r.kind).toBe("started");
  });

  it("a paying first site, whose free claim errored, still goes live by itself", async () => {
    await startFastBuild(ctx({ first_site: true, first_build_free: false }), deps({ publishOnRequest: async () => true }));
    expect(graphs[0].goal_graph.map((n) => n.payload.stage)).toEqual(["provision", "build", "deploy"]);
  });

  it("the workspace's first build gets the deploy stage even with build_publish_on_request on, so it goes live with no Publish click", async () => {
    const r = await startFastBuild(ctx({ first_build_free: true }), deps({ publishOnRequest: async () => true }));
    expect(r.kind).toBe("started");
    const g = graphs[0].goal_graph;
    expect(g.map((n) => n.payload.stage)).toEqual(["provision", "build", "deploy"]);
    expect(g[2].payload.seed_sha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("a later build (not the free first one) still waits for Publish", async () => {
    await startFastBuild(ctx({ conductor_run_id: "run-1", first_build_free: true }), deps({ publishOnRequest: async () => true }));
    await startFastBuild(ctx({ conductor_run_id: "run-2", first_build_free: false }), deps({ publishOnRequest: async () => true }));
    expect(graphs.map((x) => x.goal_graph.map((n) => n.payload.stage))).toEqual([
      ["provision", "build", "deploy"],
      ["provision", "build"],
    ]);
  });

  it("the first build goes live even when the publish setting read fails", async () => {
    await startFastBuild(ctx({ first_build_free: true }), deps({ publishOnRequest: async () => { throw new Error("settings down"); } }));
    expect(graphs[0].goal_graph.map((n) => n.payload.stage)).toEqual(["provision", "build", "deploy"]);
  });

  it("a build_publish_on_request read that throws answers the default (on): nothing is published on its own", async () => {
    const r = await startFastBuild(ctx(), deps({ publishOnRequest: async () => { throw new Error("settings down"); } }));
    expect(r.kind).toBe("started");
    expect(graphs[0].goal_graph.map((n) => n.payload.stage)).toEqual(["provision", "build"]);
  });

  it("a Retry of a failed setup writes the graph for the setting as it is now (flipped on between the attempts)", async () => {
    let on = false;
    const publishOnRequest = async () => on;
    const first = await startFastBuild(
      ctx(),
      deps({ publishOnRequest, updateConductorRunStatus: async () => { throw new Error("db blip"); } }),
    );
    expect(first).toMatchObject({ kind: "setup_failed", retryable: true });
    expect(graphs).toHaveLength(0);
    on = true;
    const second = await startFastBuild(ctx(), deps({ publishOnRequest }));
    expect(second.kind).toBe("started");
    expect(store.sites.size).toBe(1);
    expect(graphs).toHaveLength(1);
    expect(graphs[0].goal_graph.map((n) => n.payload.stage)).toEqual(["provision", "build"]);
  });

  it("does not need the dedicated provisioner or starter at all", async () => {
    const r = await startFastBuild(ctx(), deps({ supabase: null, starter: null }));
    expect(r.kind).toBe("started");
  });

  it("two builds in one tenant give two sites and two repos", async () => {
    await startFastBuild(ctx({ conductor_run_id: "run-1" }), deps());
    await startFastBuild(ctx({ conductor_run_id: "run-2" }), deps());
    expect(store.sites.size).toBe(2);
    expect(repo.repos.size).toBe(2);
  });

  it.each([
    ["not ready", false],
    ["readiness throws", "throws"],
  ] as const)("pooled backend %s: a retryable setup failure BEFORE any site row, NEVER the dedicated path", async (_n, ready) => {
    pooledReady = ready;
    const r = await startFastBuild(ctx(), deps());
    expect(r).toEqual({ kind: "setup_failed", retryable: true, reason: "provisioning_failed:backend" });
    expect(sb.calls).toEqual([]);
    expect(repo.repos.size).toBe(0);
    expect(store.sites.size).toBe(0);
  });

  it("pooled backend not wired: retryable failure and an ops alert, no site row", async () => {
    const r = await startFastBuild(ctx(), deps({ pooled: null }));
    expect(r).toMatchObject({ kind: "setup_failed", retryable: true });
    expect(store.sites.size).toBe(0);
    await flush();
    expect(alerts).toEqual([expect.objectContaining({ code: SITE_SETUP_CONFIG_ALERT_CODE, tenant_id: T1 })]);
  });

  it("a fresh site row carries the insert default backend_mode 'dedicated': that is NOT a chosen backend, the site goes pooled", async () => {
    const realCreate = store.getOrCreateForRun.bind(store);
    store.getOrCreateForRun = async (i) => {
      const row = await realCreate(i);
      store.sites.get(row.id)!.backend_mode = "dedicated";
      return { ...store.sites.get(row.id)! };
    };
    const r = await startFastBuild(ctx(), deps());
    expect(r.kind).toBe("started");
    expect(staticCalls).toHaveLength(1);
    expect(sb.calls).toEqual([]);
  });

  it("the backend is stamped on every graph node (it picks the prompt and the sandbox image)", async () => {
    await startFastBuild(ctx(), deps());
    for (const n of graphs[0].goal_graph) expect(n.payload.site_backend).toBe("pooled");
    pooledStarter = NEEDS_DEDICATED;
    await startFastBuild(ctx({ conductor_run_id: "run-2" }), deps());
    for (const n of graphs[1].goal_graph) expect(n.payload.site_backend).toBe("dedicated");
  });

  it("the repo provider is claimed right after the site row, so a site whose next step fails is still reapable", async () => {
    const p = pooled();
    p.initStatic.mockRejectedValueOnce(new Error("db blip"));
    const r = await startFastBuild(ctx(), deps({ pooled: p }));
    expect(r).toMatchObject({ kind: "setup_failed", retryable: true, reason: "provisioning_failed:backend_mode" });
    const [site] = [...store.sites.values()];
    expect(providersOf(store, T1, site.id).map((x) => `${x.kind}:${x.state}`)).toEqual(["github_repo:claimed"]);
  });

  it("a run stopped while its site was set up stays ended: the activation's refusal is thrown, never a retryable failure", async () => {
    const stopped = Object.assign(new Error("The build was stopped while its site was being set up."), { name: "RunNoLongerProvisioning" });
    await expect(startFastBuild(ctx(), deps({ updateConductorRunStatus: async () => { throw stopped; } }))).rejects.toBe(stopped);
  });

  it("a pooled starter that throws (no lockfile): retryable failure, ops alerted, nothing created", async () => {
    const p = pooled();
    p.starter.mockResolvedValue({ starterFiles: () => { throw new Error("no lockfile"); } });
    const r = await startFastBuild(ctx(), deps({ pooled: p }));
    expect(r).toMatchObject({ kind: "setup_failed", retryable: true });
    expect(repo.repos.size).toBe(0);
    expect(store.sites.size).toBe(0);
    await flush();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].msg).toMatch(/pooled site starter unavailable/);
  });

  it("a missing publisher or deploy handler is refused before any site row (and alerted)", async () => {
    for (const missing of [{ publisher: null }, { deployHandler: null }] as const) {
      const r = await startFastBuild(ctx(), deps(missing));
      expect(r).toEqual({ kind: "setup_failed", reason: "site_providers_not_wired", retryable: true });
    }
    expect(store.sites.size).toBe(0);
    await flush();
    expect(alerts).toHaveLength(2);
  });
});

describe("startFastBuild — a dedicated capability (provisionDedicatedSite seam)", () => {
  beforeEach(() => {
    pooledStarter = NEEDS_DEDICATED;
  });

  it("a starter declaring a dedicated capability gets its own project: project, auth, schema, owner", async () => {
    const r = await startFastBuild(ctx(), deps());
    expect(r.kind).toBe("started");
    const [site] = [...store.sites.values()];
    expect(sb.calls).toEqual([`ensure:${site.id}`, `auth:${site.id}`, `sql:${site.id}:000_starter`, `owner:${site.id}`]);
    expect(staticCalls).toEqual([]);
    expect(providersOf(store, T1, site.id).map((p) => `${p.kind}:${p.state}`).sort()).toEqual([
      "github_repo:created",
      "supabase_project:created",
    ]);
    if (r.kind === "started") expect(r.result.provision.provisioned).toEqual(["repo", "db"]);
  });

  it("no dedicated provisioner wired: retryable failure with an alert (never silently pooled)", async () => {
    const r = await startFastBuild(ctx(), deps({ supabase: null }));
    expect(r).toMatchObject({ kind: "setup_failed", retryable: true });
    await flush();
    expect(alerts[0].msg).toMatch(/dedicated site provisioner not wired/);
  });

  it("a dedicated starter without starter SQL is a configuration failure", async () => {
    const r = await startFastBuild(ctx(), deps({ starter: { starterFiles: () => ({ files: {}, manifest_json: "{}" }) } }));
    expect(r).toMatchObject({ kind: "setup_failed", retryable: true });
    await flush();
    expect(alerts[0].msg).toMatch(/no starter SQL/);
  });

  it("a site that already has a dedicated project keeps it on a retry, even when the starter would be pooled", async () => {
    sb.failEnsure = true;
    await startFastBuild(ctx(), deps());
    sb.failEnsure = false;
    const [site] = [...store.sites.values()];
    store.sites.get(site.id)!.supabase_project_ref = "abcdefghijklmnopqrst";
    pooledStarter = POOLED_STARTER;
    const r = await startFastBuild(ctx(), deps());
    expect(r.kind).toBe("started");
    expect(staticCalls).toEqual([]);
    expect(sb.projects.size).toBe(1);
  });
});

describe("startFastBuild — a failed step keeps its checkpoints and is retryable", () => {
  it("the repo fails: nothing is torn down, the site stays provisioning with last_error", async () => {
    repo.failCreate = true;
    const r = await startFastBuild(ctx(), deps());
    expect(r).toMatchObject({ kind: "setup_failed", retryable: true, reason: "provisioning_failed:repo", site_id: expect.any(String) });
    const [site] = [...store.sites.values()];
    expect(site.status).toBe("provisioning");
    expect(site.last_error).toMatch(/^repo:/);
    expect((r as { detail?: string }).detail).toBeTruthy();
    expect(site.last_error).toContain((r as { detail: string }).detail);
    expect(repo.deleted).toEqual([]);
    expect(graphs).toHaveLength(0);
  });

  it("Retry of the same run resumes: same site, one repo, the claimed providers reused, then it starts", async () => {
    repo.failCreate = true;
    await startFastBuild(ctx(), deps());
    repo.failCreate = false;
    const r = await startFastBuild(ctx(), deps());
    expect(r.kind).toBe("started");
    expect(store.sites.size).toBe(1);
    expect(repo.repos.size).toBe(1);
    const [site] = [...store.sites.values()];
    expect(site.status).toBe("building");
    expect(site.last_error).toBeNull();
    expect(staticCalls).toHaveLength(2);
  });

  it("a failure after the site moved to building (run update) is still resumable", async () => {
    const r1 = await startFastBuild(ctx(), deps({ updateConductorRunStatus: async () => { throw new Error("db blip"); } }));
    expect(r1).toMatchObject({ kind: "setup_failed", retryable: true, reason: "provisioning_failed:run_update" });
    expect([...store.sites.values()][0].status).toBe("building");
    const r2 = await startFastBuild(ctx(), deps());
    expect(r2.kind).toBe("started");
    expect(repo.repos.size).toBe(1);
  });

  it("a dedicated-site credential failure is retryable and alerted; nothing is torn down", async () => {
    pooledStarter = NEEDS_DEDICATED;
    sb.ensureProject = async () => { throw new SiteCredentialsMissing(["SUPABASE_MGMT_TOKEN"]); };
    const r = await startFastBuild(ctx(), deps());
    expect(r).toMatchObject({ kind: "setup_failed", retryable: true, reason: "provisioning_failed:dedicated_backend" });
    expect(repo.deleted).toEqual([]);
    await flush();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].msg).toContain("SUPABASE_MGMT_TOKEN");
  });

  it("a site that died (reaped / deleted) is never set up again: not retryable", async () => {
    await startFastBuild(ctx(), deps({ updateConductorRunStatus: async () => { throw new Error("db blip"); } }));
    const [site] = [...store.sites.values()];
    store.sites.get(site.id)!.status = "deleting";
    const r = await startFastBuild(ctx(), deps());
    expect(r).toEqual({ kind: "setup_failed", reason: "site_deleting", retryable: false, site_id: site.id });
  });
});

describe("startFastBuild — owner admin on a dedicated site (build_auto_site_owner)", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  beforeEach(() => {
    sleeps.length = 0;
    pooledStarter = NEEDS_DEDICATED;
  });

  it("setting off: no owner admin is created and the site records no owner", async () => {
    const autoSiteOwner = vi.fn(async () => false);
    const r = await startFastBuild(ctx(), deps({ autoSiteOwner, sleep }));
    expect(r.kind).toBe("started");
    expect(autoSiteOwner).toHaveBeenCalledWith(T1);
    expect(sb.calls.some((c) => c.startsWith("owner:"))).toBe(false);
    expect([...store.sites.values()][0].owner_email).toBeNull();
  });

  it("a setting read that throws answers the default (on)", async () => {
    await startFastBuild(ctx(), deps({ autoSiteOwner: async () => { throw new Error("settings down"); }, sleep }));
    expect(sb.calls.some((c) => c.startsWith("owner:"))).toBe(true);
  });

  it("a transient failure is retried, then the build starts with the owner recorded", async () => {
    let calls = 0;
    sb.ensureOwnerAdmin = async () => {
      calls += 1;
      if (calls < 3) throw new Error("fetch failed");
      return { user_id: "u" };
    };
    const r = await startFastBuild(ctx(), deps({ sleep }));
    expect(r.kind).toBe("started");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
    expect([...store.sites.values()][0].owner_email).toBe("owner@example.com");
  });

  it("still failing after 3 retries: a retryable setup failure, the site keeps its project", async () => {
    let calls = 0;
    sb.ensureOwnerAdmin = async () => {
      calls += 1;
      throw new Error("owner profile row is missing");
    };
    const r = await startFastBuild(ctx(), deps({ sleep }));
    expect(r).toMatchObject({ kind: "setup_failed", retryable: true, reason: "provisioning_failed:dedicated_backend" });
    expect(calls).toBe(OWNER_ADMIN_RETRY_DELAYS_MS.length + 1);
    expect(graphs).toHaveLength(0);
    const [site] = [...store.sites.values()];
    expect(site.owner_email).toBeNull();
    expect(providersOf(store, T1, site.id).find((p) => p.kind === "supabase_project")?.state).toBe("created");
  });

  it("an invalid owner email is not retried", async () => {
    let calls = 0;
    sb.ensureOwnerAdmin = async () => {
      calls += 1;
      throw new Error("invalid owner email");
    };
    const r = await startFastBuild(ctx(), deps({ sleep }));
    expect(r.kind).toBe("setup_failed");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("fastBuildEstimateUsd", () => {
  it("defaults to 2 and honours a positive override", () => {
    expect(fastBuildEstimateUsd({})).toBe(2);
    expect(fastBuildEstimateUsd({ FAST_BUILD_ESTIMATE_USD: "1.5" })).toBe(1.5);
    expect(fastBuildEstimateUsd({ FAST_BUILD_ESTIMATE_USD: "-1" })).toBe(2);
  });
});

describe("startFastBuild — the site's address is named after the site", () => {
  it("passes the site's own name, not the workspace name, to the label", async () => {
    const r = await startFastBuild(
      ctx({ company_name: "Apna Tutor", workspace_name: "Apna Tutor", idea: "A booking website for my dog grooming salon. Show services." }),
      deps(),
    );
    expect(r.kind).toBe("started");
    expect([...store.sites.values()][0].label.startsWith("dog-grooming-salon-")).toBe(true);
  });

  it("keeps a product name the founder typed", async () => {
    await startFastBuild(ctx({ company_name: "Puzzle Night", workspace_name: "Apna Tutor", idea: "A multiplayer puzzle game" }), deps());
    expect([...store.sites.values()][0].label.startsWith("puzzle-night-")).toBe(true);
  });
});

describe("startFastBuild — stopped while provisioning", () => {
  it("throws when the site was failed mid-saga", async () => {
    repo.seed = async () => {
      for (const site of store.sites.values()) site.status = "failed";
      throw new Error("seed aborted");
    };
    await expect(startFastBuild(ctx(), deps())).rejects.toThrow(/stopped/i);
    expect(graphs).toHaveLength(0);
  });
});
