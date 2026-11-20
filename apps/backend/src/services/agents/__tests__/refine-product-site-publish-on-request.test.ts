import { describe, it, expect, vi, type Mock } from "vitest";
import {
  refineProduct,
  createSiteRepublisher,
  MAX_SITE_PUBLISHES_PER_DAY,
  SITE_FAST_EDIT_ESTIMATE_USD,
  type RefineProductDeps,
  type PriorRefineTurn,
} from "@/services/agents/refine-product";
import {
  conductorTick,
  type ConductorNode,
  type ConductorRow,
  type ConductorTickDeps,
  type SiteDeployDeps,
} from "@/services/agents/conductor";
import type { SiteRow } from "@/services/sites/contract";
import { MAX_PRODUCT_REFINES_PER_DAY, TooManyBuildsToday } from "@/services/agents/start-product-build";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const SITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const HEAD = "1111111";

const LIVE: SiteRow = {
  id: SITE_ID,
  tenant_id: TENANT,
  root_conductor_run_id: SESSION,
  started_by_user_id: null,
  owner_email: "owner@example.test",
  label: "alpha",
  hostname: "alpha.zaviagent.com",
  github_full_name: "praxis-built/alpha",
  supabase_project_ref: null,
  supabase_url: null,
  status: "live",
  live_url: "https://alpha.zaviagent.com",
  desired_sha: HEAD,
  live_sha: HEAD,
  live_deploy_id: "d00000000a-live0001",
  last_visit_at: null,
  last_edit_at: null,
  paused_at: null,
  last_error: null,
  created_at: "2026-10-02T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
};

const NEVER_PUBLISHED: SiteRow = {
  ...LIVE,
  status: "building",
  live_url: null,
  live_sha: null,
  live_deploy_id: null,
};

type MockDeps = RefineProductDeps & { [K in keyof RefineProductDeps]: Mock };

function deps(site: SiteRow, over: Partial<RefineProductDeps> = {}): MockDeps {
  return {
    loadProvisionedTarget: vi.fn().mockResolvedValue(null),
    loadPriorRefines: vi.fn().mockResolvedValue([] as PriorRefineTurn[]),
    verifyConductorRunOwnership: vi.fn().mockResolvedValue(true),
    loadConductorRunKind: vi.fn().mockResolvedValue("build_app"),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_refine_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    loadRepoHeadSha: vi.fn().mockResolvedValue(HEAD),
    resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(true),
    isFleetHalted: vi.fn().mockResolvedValue(false),
    loadAppPolicy: vi.fn().mockResolvedValue({ protected_globs: [], freeze: false, preview: "branch_preview" }),
    loadSiteForRun: vi.fn().mockResolvedValue({ ...site }),
    markSiteEdited: vi.fn().mockResolvedValue(undefined),
    resolveSiteFastEditNode: vi.fn().mockResolvedValue(false),
    resolveSiteEditTimingLog: vi.fn().mockResolvedValue(true),
    resolveBuildPublishOnRequest: vi.fn().mockResolvedValue(true),
    ...over,
  } as unknown as MockDeps;
}

function graphOf(d: MockDeps): ConductorNode[] {
  for (const call of d.updateConductorRunStatus.mock.calls) {
    const arg = call[0] as { goal_graph?: ConductorNode[] };
    if (arg.goal_graph) return arg.goal_graph;
  }
  throw new Error("no goal_graph written");
}

const stages = (g: ConductorNode[]) => g.map((n) => n.payload.stage);

const EDIT = { tenant_id: TENANT, message: "change the hero title to Rent e-bikes fast", conductor_run_id: SESSION };

function tickHarness(start: ConductorNode[]) {
  let graph = start.map((n) => ({ ...n, payload: { ...n.payload } }));
  let status: ConductorRow["status"] = "active";
  const statuses: string[] = [];
  const siteDeploy: SiteDeployDeps = {
    step: vi.fn(async () => ({ kind: "waiting" as const })),
    headSha: vi.fn(async () => "2222222"),
    ownsSite: vi.fn(async () => true),
    markDesired: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    repairMaxAttempts: vi.fn(async () => 1),
  };
  const hostingStatus = vi.fn(async () => "ready" as const);
  const staticRequest = vi.fn();
  const tick: ConductorTickDeps = {
    load: async () => ({
      id: "cr_refine_1",
      tenant_id: TENANT,
      objective: "[refine] change the hero title",
      status,
      max_usd: 5,
      spend_usd: 0,
      kind: "build_app",
      goal_graph: graph,
    }),
    childStatus: async () => "success",
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "child-edit" })),
    verifyStagePush: async () => "landed",
    saveGraph: async (_id, g) => {
      graph = g.map((n) => ({ ...n, payload: { ...n.payload } }));
    },
    setStatus: async (_id, next) => {
      statuses.push(next);
      status = next;
    },
    hostingStatus,
    staticPublish: { plan: vi.fn(), request: staticRequest, rollback: vi.fn() },
    siteDeploy,
  };
  return { tick, siteDeploy, hostingStatus, staticRequest, statuses, graph: () => graph };
}

describe("refineProduct: build_publish_on_request and a site that was never published", () => {
  it("setting on, never published: the engineer node alone, still pushing to main, and no pre-edit snapshot is read", async () => {
    const d = deps(NEVER_PUBLISHED);
    const r = await refineProduct(EDIT, d);
    const g = graphOf(d);
    expect(g).toHaveLength(1);
    expect(stages(g)).toEqual(["build"]);
    expect(g[0].target_agent_slug).toBe("engineer");
    expect(g[0].payload).toMatchObject({
      refine_mode: true,
      site_id: SITE_ID,
      direct_merge_enabled: true,
      parent_conductor_run_id: SESSION,
      target: { github_full_name: "praxis-built/alpha" },
    });
    expect(g.some((n) => "pre_refine_sha" in n.payload || "refine_deploy_enqueued_at" in n.payload)).toBe(false);
    expect(d.resolveBuildPublishOnRequest).toHaveBeenCalledTimes(1);
    expect(d.resolveBuildPublishOnRequest).toHaveBeenCalledWith(TENANT);
    expect(d.loadRepoHeadSha).not.toHaveBeenCalled();
    expect(r).toMatchObject({ conductor_run_id: "cr_refine_1", site_id: SITE_ID, direct_merge_enabled: true });
  });

  it("setting on, already live: the edit also stops at the preview (always click Publish) and says so", async () => {
    const d = deps(LIVE);
    const r = await refineProduct(EDIT, d);
    const g = graphOf(d);
    expect(stages(g)).toEqual(["build"]);
    expect(g[0].payload).toMatchObject({ site_id: SITE_ID, direct_merge_enabled: true, stop_at_preview: true });
    expect(d.loadRepoHeadSha).not.toHaveBeenCalled();
    expect(d.resolveBuildPublishOnRequest).toHaveBeenCalledWith(TENANT);
    expect(r.stop_at_preview).toBe(true);
  });
  it("every previously published state stops at the preview too", async () => {
    for (const status of ["live", "paused", "waking", "publishing", "building"] as const) {
      const d = deps({ ...LIVE, status });
      await refineProduct(EDIT, d);
      expect(stages(graphOf(d))).toEqual(["build"]);
    }
  });
  it("setting off: both a never-published and a live site get the deploy gate", async () => {
    for (const site of [NEVER_PUBLISHED, LIVE]) {
      const d = deps(site, { resolveBuildPublishOnRequest: vi.fn().mockResolvedValue(false) });
      await refineProduct(EDIT, d);
      const g = graphOf(d);
      expect(stages(g)).toEqual(["build", "deploy"]);
      expect(g[1].payload).toMatchObject({ site_id: SITE_ID, pre_refine_sha: HEAD });
      expect("stop_at_preview" in g[0].payload).toBe(false);
    }
  });

  it("a setting read that throws stops the edit at preview, on a never-published and on a live site (never a surprise publish)", async () => {
    const down = () => vi.fn().mockRejectedValue(new Error("settings down"));
    const fresh = deps(NEVER_PUBLISHED, { resolveBuildPublishOnRequest: down() });
    await refineProduct(EDIT, fresh);
    expect(stages(graphOf(fresh))).toEqual(["build"]);
    const live = deps(LIVE, { resolveBuildPublishOnRequest: down() });
    await refineProduct(EDIT, live);
    expect(stages(graphOf(live))).toEqual(["build"]);
  });

  it("an empty-string live_deploy_id counts as never published", async () => {
    const d = deps({ ...NEVER_PUBLISHED, live_deploy_id: "" });
    await refineProduct(EDIT, d);
    expect(stages(graphOf(d))).toEqual(["build"]);
  });

  it("a refine that names no site resolves the workspace's one site and stops at preview the same way", async () => {
    const d = deps(NEVER_PUBLISHED, {
      loadSiteForRun: vi.fn().mockResolvedValue(null),
      listSites: vi.fn().mockResolvedValue([{ ...NEVER_PUBLISHED }]),
    });
    await refineProduct({ tenant_id: TENANT, message: EDIT.message }, d);
    expect(stages(graphOf(d))).toEqual(["build"]);
    expect(graphOf(d)[0].payload).toMatchObject({ site_id: SITE_ID, parent_conductor_run_id: SESSION });
  });

  it("a small edit on a never-published site is the fast edit node alone", async () => {
    const d = deps(NEVER_PUBLISHED, { resolveSiteFastEditNode: vi.fn().mockResolvedValue(true) });
    await refineProduct({ ...EDIT, small_edit: true }, d);
    const g = graphOf(d);
    expect(stages(g)).toEqual(["build"]);
    expect(g[0].payload).toMatchObject({ fast_edit: true, small_edit: true });
    expect(g[0].estimate_usd).toBe(SITE_FAST_EDIT_ESTIMATE_USD);
  });

  it("the direct-merge brake still wins: one parked node with direct_merge_enabled false, and the publish setting is not read", async () => {
    const d = deps(NEVER_PUBLISHED, { resolveRefineDirectMergeEnabled: vi.fn().mockResolvedValue(false) });
    await refineProduct(EDIT, d);
    const g = graphOf(d);
    expect(stages(g)).toEqual(["build"]);
    expect(g[0].payload.direct_merge_enabled).toBe(false);
    expect(d.resolveBuildPublishOnRequest).not.toHaveBeenCalled();
  });

  it("deps that do not wire the setting keep the deploy gate", async () => {
    const d = deps(NEVER_PUBLISHED, { resolveBuildPublishOnRequest: undefined });
    await refineProduct(EDIT, d);
    expect(stages(graphOf(d))).toEqual(["build", "deploy"]);
  });
});

describe("a site edit run through the conductor: what actually gets published", () => {
  it("never published, setting on: the run ends done when the edit lands and the site deploy handler is never asked to publish", async () => {
    const d = deps(NEVER_PUBLISHED);
    await refineProduct(EDIT, d);
    const h = tickHarness(graphOf(d));

    expect(await conductorTick("cr_refine_1", h.tick)).toMatchObject({ action: "dispatched", child_run_id: "child-edit" });
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "completed", final: "done" });
    expect(h.statuses).toEqual(["done"]);
    expect(h.graph().map((n) => n.status)).toEqual(["done"]);
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "noop", reason: "done" });

    expect(h.siteDeploy.step).not.toHaveBeenCalled();
    expect(h.siteDeploy.headSha).not.toHaveBeenCalled();
    expect(h.siteDeploy.markDesired).not.toHaveBeenCalled();
    expect(h.siteDeploy.settle).not.toHaveBeenCalled();
    expect(h.hostingStatus).not.toHaveBeenCalled();
    expect(h.staticRequest).not.toHaveBeenCalled();
  });

  it("already live, setting on: the run ends done when the edit lands and nothing is published (the live site keeps its version)", async () => {
    const d = deps(LIVE);
    await refineProduct(EDIT, d);
    const h = tickHarness(graphOf(d));
    await conductorTick("cr_refine_1", h.tick);
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "completed", final: "done" });
    expect(h.siteDeploy.step).not.toHaveBeenCalled();
    expect(h.siteDeploy.markDesired).not.toHaveBeenCalled();
    expect(h.staticRequest).not.toHaveBeenCalled();
  });

  it("already live, setting off: once the edit lands, the site deploy handler is asked to publish the new HEAD", async () => {
    const d = deps(LIVE, { resolveBuildPublishOnRequest: vi.fn().mockResolvedValue(false) });
    await refineProduct(EDIT, d);
    const h = tickHarness(graphOf(d));
    await conductorTick("cr_refine_1", h.tick);
    expect(await conductorTick("cr_refine_1", h.tick)).toEqual({ action: "waiting", in_flight: 0 });
    expect(h.siteDeploy.markDesired).toHaveBeenCalledWith({ tenant_id: TENANT, site_id: SITE_ID, sha: "2222222" });
    expect(h.siteDeploy.step).toHaveBeenCalledTimes(1);
    expect(h.statuses).toEqual([]);
    expect(h.staticRequest).not.toHaveBeenCalled();
  });
});

type DayRow = { id: string; kind: string; status: string; goal_graph: ConductorNode[] };

function dailyBuckets() {
  const rows: DayRow[] = [];
  const marker = (r: DayRow, key: string) => (r.goal_graph[0]?.payload as Record<string, unknown> | undefined)?.[key] === true;
  const acquire = vi.fn(async (p: { tenant_id: string; max_per_day: number; is_refine?: boolean }) => {
    if (rows.some((r) => r.kind === "build_app" && (r.status === "provisioning" || r.status === "active"))) throw new Error("double_build");
    const today = rows.filter((r) => r.kind === "build_app" && marker(r, "refine_mode") === (p.is_refine === true)).length;
    if (today >= p.max_per_day) throw new TooManyBuildsToday(p.tenant_id, today, p.max_per_day);
    const id = `cr_${rows.length + 1}`;
    rows.push({ id, kind: "build_app", status: "provisioning", goal_graph: [] });
    return id;
  });
  const write = vi.fn(async (p: { conductor_run_id: string; status: string; goal_graph?: ConductorNode[] }) => {
    const r = rows.find((x) => x.id === p.conductor_run_id)!;
    r.status = p.status;
    if (p.goal_graph) r.goal_graph = p.goal_graph;
  });
  const countSitePublishesToday = vi.fn(async (_tenant_id: string) => rows.filter((r) => r.kind === "build_app" && marker(r, "publish_request")).length);
  const seedRefines = (n: number) => {
    for (let i = 0; i < n; i++) {
      rows.push({ id: `seed_${rows.length + 1}`, kind: "build_app", status: "done", goal_graph: [{ id: "e", status: "done", target_agent_slug: "engineer", payload: { stage: "build", refine_mode: true }, estimate_usd: 0, child_run_id: null }] });
    }
  };
  const refines = () => rows.filter((r) => marker(r, "refine_mode") && !marker(r, "publish_request")).length;
  const republisher = createSiteRepublisher({
    tryAcquireBuildSlot: acquire as unknown as RefineProductDeps["tryAcquireBuildSlot"],
    updateConductorRunStatus: write as unknown as RefineProductDeps["updateConductorRunStatus"],
    resolveDailyCap: async () => 25,
    countSitePublishesToday,
    stageReservedGraph: async (p) => {
      rows.find((r) => r.id === p.conductor_run_id)!.goal_graph = p.goal_graph;
    },
    activateReserved: async (p) => {
      const row = rows.find((r) => r.id === p.conductor_run_id)!;
      if (row.status === "active") return "already_active" as const;
      if (row.status !== "provisioning") return "gone" as const;
      row.status = "active";
      row.goal_graph = p.goal_graph;
      return "activated" as const;
    },
    requestTick: async () => undefined,
  });
  const publishOnce = async (site: SiteRow) => {
    const id = await republisher.reserve({ tenant_id: TENANT, site, publish_request: true });
    await republisher.start({ tenant_id: TENANT, conductor_run_id: id, site, sha: "abcdef1", publish_request: true });
    rows.find((r) => r.id === id)!.status = "failed";
    return id;
  };
  return { rows, acquire, write, countSitePublishesToday, seedRefines, refines, republisher, publishOnce };
}

describe("Publish has its own daily allowance, apart from chat edits", () => {
  it("with chat edits at today's cap, Publish still starts", async () => {
    const b = dailyBuckets();
    b.seedRefines(MAX_PRODUCT_REFINES_PER_DAY);
    await expect(b.publishOnce(NEVER_PUBLISHED)).resolves.toMatch(/^cr_/);
    expect(b.rows.filter((r) => r.goal_graph[0]?.payload.publish_request === true)).toHaveLength(1);
  });

  it("publish attempts do not use up chat edits: after several publishes the next edit still starts", async () => {
    const b = dailyBuckets();
    b.seedRefines(MAX_PRODUCT_REFINES_PER_DAY - 1);
    for (let i = 0; i < 5; i++) await b.publishOnce(NEVER_PUBLISHED);
    expect(b.refines()).toBe(MAX_PRODUCT_REFINES_PER_DAY - 1);
    const d = deps(NEVER_PUBLISHED, {
      tryAcquireBuildSlot: b.acquire as unknown as RefineProductDeps["tryAcquireBuildSlot"],
      updateConductorRunStatus: b.write as unknown as RefineProductDeps["updateConductorRunStatus"],
      countSitePublishesToday: b.countSitePublishesToday,
    });
    await expect(refineProduct(EDIT, d)).resolves.toMatchObject({ site_id: SITE_ID });
    expect(b.refines()).toBe(MAX_PRODUCT_REFINES_PER_DAY);
    b.rows[b.rows.length - 1].status = "done";
    const again = deps(NEVER_PUBLISHED, {
      tryAcquireBuildSlot: b.acquire as unknown as RefineProductDeps["tryAcquireBuildSlot"],
      updateConductorRunStatus: b.write as unknown as RefineProductDeps["updateConductorRunStatus"],
      countSitePublishesToday: b.countSitePublishesToday,
    });
    await expect(refineProduct(EDIT, again)).rejects.toBeInstanceOf(TooManyBuildsToday);
  });

  it("an undo republish is not blocked by today's publishes either", async () => {
    const b = dailyBuckets();
    b.seedRefines(MAX_PRODUCT_REFINES_PER_DAY - 1);
    for (let i = 0; i < 3; i++) await b.publishOnce(LIVE);
    await expect(b.republisher.reserve({ tenant_id: TENANT, site: LIVE })).resolves.toMatch(/^cr_/);
  });

  it("Publish has its own cap per day", async () => {
    const b = dailyBuckets();
    for (let i = 0; i < MAX_SITE_PUBLISHES_PER_DAY; i++) await b.publishOnce(NEVER_PUBLISHED);
    await expect(b.republisher.reserve({ tenant_id: TENANT, site: NEVER_PUBLISHED, publish_request: true })).rejects.toBeInstanceOf(TooManyBuildsToday);
    expect(b.acquire).toHaveBeenCalledTimes(MAX_SITE_PUBLISHES_PER_DAY);
  });

  it("when today's publishes cannot be counted, Publish and edits keep today's shared allowance", async () => {
    const b = dailyBuckets();
    b.countSitePublishesToday.mockRejectedValue(new Error("db down"));
    b.seedRefines(MAX_PRODUCT_REFINES_PER_DAY);
    await expect(b.republisher.reserve({ tenant_id: TENANT, site: NEVER_PUBLISHED, publish_request: true })).rejects.toBeInstanceOf(TooManyBuildsToday);
  });
});
