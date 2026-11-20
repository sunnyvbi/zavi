import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({ repairMax: 1 }));

vi.mock("@/services/settings", () => ({ getNumberSetting: vi.fn(async () => h.repairMax), getBoolSetting: vi.fn(async () => false) }));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u-admin", access_token: "tok" })),
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn(async () => true), loadTenantRoleFor: vi.fn(async () => "owner") }));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => true }));

import { conductorTick, type BuildFailureClass, type ConductorNode, type ConductorRow, type ConductorTickDeps } from "../conductor";
import { createSiteRepublisher } from "../refine-product";
import { DoubleBuildInFlight } from "../start-product-build";
import { handleSitePublish } from "@/routes/workspace/site-publish";
import { makeSiteDeployDeps } from "@/services/sites/site-deploy-deps";
import { setSiteWiring, resetSiteWiring } from "@/services/sites/wiring";
import { reapSites, type SiteRunState } from "@/services/sites/site-reaper";
import { siteLiveUrl, sitePublishedUrl } from "@/services/sites/site-build-status";
import { publishReason } from "@/services/build/app-ready";
import { SITE_PUBLISH_PLATFORM_RETRY } from "@zavi/shared";
import type { SiteDeployHandler, SiteDeployOutcome } from "@/services/sites/contract";
import { fakeRepo, fakeStore, fakeSupabase, providersOf, teardownDeps, type FakeStore } from "@/services/sites/__tests__/site-fakes";

const T1 = "11111111-1111-4111-8111-111111111111";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const ROOT = "root-run";
const GATE_SIGNAL = "The site's smoke check failed: the booking form returns a 500\nEvidence: POST /api/data/bookings -> 500";

type RunRow = Omit<ConductorRow, "status" | "kind"> & {
  status: ConductorRow["status"] | "provisioning";
  kind?: ConductorRow["kind"] | "undo";
  reason?: { failure_class: BuildFailureClass; failure_reason: string };
};

let store: FakeStore;

async function world(opts: { live?: boolean } = {}) {
  const created = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: ROOT, company_name: "Shop", started_by_user_id: null });
  await store.transition(T1, created.id, ["provisioning"], "building");
  await store.update(T1, created.id, { github_full_name: `praxis-built/${created.label}` });
  await store.claimProvider(T1, created.id, "github_repo", { name: created.label, owner: "praxis-built" });
  await store.setProviderState(T1, created.id, "github_repo", "created");
  if (opts.live) {
    Object.assign(store.sites.get(created.id)!, { status: "live", live_deploy_id: "d-old", live_sha: "aaaaaaa", desired_sha: "aaaaaaa", live_url: `https://${created.hostname}` });
  }
  const site_id = created.id;
  const runs = new Map<string, RunRow>();
  const ticks: string[] = [];
  const outcomes: SiteDeployOutcome[] = [];
  const steps: Array<Parameters<SiteDeployHandler["step"]>[0]> = [];
  const statusAtStep: string[] = [];
  const beforeOutcome: Array<() => Promise<void>> = [];
  const handler: SiteDeployHandler = {
    step: vi.fn(async (i): Promise<SiteDeployOutcome> => {
      steps.push(i);
      statusAtStep.push(store.sites.get(i.site_id)!.status);
      await store.update(i.tenant_id, i.site_id, { desired_sha: i.sha });
      await beforeOutcome.shift()?.();
      return outcomes.shift() ?? { kind: "waiting" };
    }),
  };
  setSiteWiring({ deployHandler: handler });
  const headOf = vi.fn(async (_repo: string): Promise<{ sha: string } | { error: string }> => ({ sha: HEAD }));
  const republisher = createSiteRepublisher({
    resolveDailyCap: async () => 25,
    tryAcquireBuildSlot: async (p) => {
      if ([...runs.values()].some((r) => r.tenant_id === p.tenant_id && (r.status === "provisioning" || r.status === "active"))) {
        throw new DoubleBuildInFlight(p.tenant_id);
      }
      const id = `cr_${runs.size + 1}`;
      runs.set(id, { id, tenant_id: p.tenant_id, objective: p.objective, status: "provisioning", max_usd: p.max_usd, spend_usd: 0, kind: "build_app", goal_graph: [] });
      return id;
    },
    updateConductorRunStatus: async (p) => {
      const row = runs.get(p.conductor_run_id)!;
      row.status = p.status;
      if (p.goal_graph) row.goal_graph = JSON.parse(JSON.stringify(p.goal_graph)) as ConductorNode[];
    },
    stageReservedGraph: async (p) => {
      runs.get(p.conductor_run_id)!.goal_graph = p.goal_graph;
    },
    activateReserved: async (p) => {
      const row = runs.get(p.conductor_run_id)!;
      if (row.status === "active") return "already_active" as const;
      if (row.status !== "provisioning") return "gone" as const;
      row.status = "active";
      row.goal_graph = p.goal_graph;
      return "activated" as const;
    },
    requestTick: async (id) => {
      ticks.push(id);
    },
  });
  const dispatch = vi.fn(async () => ({ ok: true as const, child_run_id: "x" }));
  const dispatchRepair = vi.fn(async () => ({ ok: true as const, child_run_id: "fix" }));
  const consumeBudget = vi.fn(async (id: string, usd: number): Promise<"charged" | "over_cap"> => {
    const row = runs.get(id)!;
    if (row.max_usd !== null && row.spend_usd + usd > row.max_usd) {
      row.status = "halted";
      return "over_cap";
    }
    row.spend_usd += usd;
    return "charged";
  });
  const child = { status: "success" as "running" | "success" | "failed" };
  const sleeps: number[] = [];
  const siteDeploy = makeSiteDeployDeps({ store, headOf, org: () => "praxis-built" });
  const deps: ConductorTickDeps = {
    load: async (id) => {
      const row = runs.get(id);
      return row && row.status !== "provisioning" ? (row as ConductorRow) : null;
    },
    childStatus: async () => child.status,
    consumeBudget,
    dispatch,
    dispatchRepair,
    saveGraph: async (id, g) => {
      runs.get(id)!.goal_graph = JSON.parse(JSON.stringify(g)) as ConductorNode[];
    },
    setStatus: async (id, s, reason) => {
      const row = runs.get(id)!;
      row.status = s;
      row.reason = reason;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    hostingStatus: vi.fn(async () => "ready" as const),
    staticPublish: { plan: vi.fn(), request: vi.fn(), rollback: vi.fn() },
    siteDeploy,
  };
  const publish = async () => {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    await handleSitePublish({ params: { site_id }, body: {}, headers: {} } as unknown as Request, res as unknown as Response, {
      store,
      headOf,
      republisher,
      rootRunStatus: async () => "done",
      discardHeldSlot: async ({ conductor_run_id }) => {
        const row = runs.get(conductor_run_id);
        if (!row || row.kind !== "build_app" || (row.status !== "provisioning" && row.status !== "active")) throw new Error("no held slot");
        row.kind = "undo";
        row.status = "failed";
      },
    });
    return res as unknown as { statusCode: number; body: { ok?: boolean; conductor_run_id?: string; error?: { code: string; message: string } } };
  };
  const site = () => store.sites.get(site_id)!;
  return { site_id, site, runs, ticks, outcomes, steps, statusAtStep, beforeOutcome, deps, siteDeploy, publish, dispatch, dispatchRepair, consumeBudget, sleeps, headOf, republisher, child };
}

function reaperDeps(site_id: string, runState: SiteRunState) {
  const repo = fakeRepo();
  return {
    candidates: async () => [{ tenant_id: T1, site_id, status: store.sites.get(site_id)!.status, tenant_slug: "real-co" }],
    teardown: teardownDeps(store, repo, fakeSupabase(store)),
    runState: async () => runState,
    enabled: () => true,
    envScope: () => ({ allowed: true }),
    now: () => new Date("2026-10-10T00:00:00Z"),
    deleted: repo.deleted,
  };
}

beforeEach(() => {
  h.repairMax = 1;
  store = fakeStore();
});

afterEach(() => resetSiteWiring());

describe("a failed first Publish never strands the site", () => {
  it("the publish fails: the run is failed with its reason, the site is back to building with it, and nothing was charged", async () => {
    const w = await world();
    w.outcomes.push({ kind: "failed", reason: "The site's build sandbox is gone. Start the build again." });

    const first = await w.publish();
    expect(first.statusCode).toBe(200);
    const run_id = first.body.conductor_run_id!;
    expect(w.ticks).toEqual([run_id]);
    expect(await conductorTick(run_id, w.deps)).toEqual({ action: "completed", final: "failed" });

    expect(w.steps).toEqual([{ tenant_id: T1, conductor_run_id: run_id, site_id: w.site_id, sha: HEAD, attempt: 1, brief: w.runs.get(run_id)!.objective }]);
    expect(w.runs.get(run_id)).toMatchObject({
      status: "failed",
      reason: { failure_class: "deploy_failed", failure_reason: "The site's build sandbox is gone. Start the build again." },
    });
    expect(w.site()).toMatchObject({
      status: "building",
      last_error: "The site's build sandbox is gone. Start the build again.",
      live_deploy_id: null,
      live_sha: null,
      desired_sha: HEAD,
    });
    expect(w.dispatch).not.toHaveBeenCalled();
    expect(w.consumeBudget).not.toHaveBeenCalled();
  });

  it("the Publish button works again after the failure, and the second publish takes the site live", async () => {
    const w = await world();
    w.outcomes.push({ kind: "failed", reason: "The site was published but it is not serving yet." });
    const first = await w.publish();
    await conductorTick(first.body.conductor_run_id!, w.deps);
    expect(w.site().status).toBe("building");

    w.outcomes.push({ kind: "live", url: "https://shop.zaviagent.com", verified_at: "2026-10-02T00:00:00.000Z" });
    const second = await w.publish();
    expect(second.statusCode).toBe(200);
    expect(second.body.conductor_run_id).not.toBe(first.body.conductor_run_id);
    expect(w.site().status).toBe("building");
    expect(await conductorTick(second.body.conductor_run_id!, w.deps)).toEqual({ action: "completed", final: "done" });
    expect(w.site()).toMatchObject({ status: "live", last_error: null });
    expect([...w.runs.values()].map((r) => r.status)).toEqual(["failed", "done"]);
  });

  it("the reaper keeps the site after a failed first publish, however long ago it was", async () => {
    const w = await world();
    w.outcomes.push({ kind: "failed", reason: "Site hosting is not configured." });
    const first = await w.publish();
    await conductorTick(first.body.conductor_run_id!, w.deps);
    w.site().updated_at = "2026-10-03T00:00:00.000Z";

    const d = reaperDeps(w.site_id, "done");
    const r = await reapSites(d);
    expect(r.skipped).toEqual([{ site_id: w.site_id, reason: "build_finished" }]);
    expect(r.reaped).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(d.deleted).toEqual([]);
    expect(w.site().status).toBe("building");
    expect(providersOf(store, T1, w.site_id).map((p) => p.state)).toEqual(["created"]);
  });

  it("a check that fails at the first publish gets a fix pass on the site's repo, and the publish then goes live from the fixed commit", async () => {
    const FIXED = "fedcba9876543210fedcba9876543210fedcba98";
    const w = await world();
    w.outcomes.push({ kind: "repair", signal: GATE_SIGNAL }, { kind: "live", url: "https://shop.zaviagent.com", verified_at: "2026-10-02T00:00:00.000Z" });
    const first = await w.publish();
    const run_id = first.body.conductor_run_id!;

    w.child.status = "running";
    expect(await conductorTick(run_id, w.deps)).toEqual({ action: "site_repair_dispatched", node_id: expect.any(String), child_run_id: "fix", attempt: 1 });
    expect(w.dispatch).not.toHaveBeenCalled();
    expect(w.dispatchRepair).toHaveBeenCalledTimes(1);
    const fix = (w.dispatchRepair.mock.calls[0] as unknown as [{ tenant_id: string; conductor_run_id: string; attempt: number; target_agent_slug: string; payload: Record<string, unknown>; failure_signal: string }])[0];
    expect(fix).toMatchObject({ tenant_id: T1, conductor_run_id: run_id, attempt: 1, target_agent_slug: "engineer", failure_signal: GATE_SIGNAL });
    expect(fix.payload).toMatchObject({
      stage: "build",
      refine_mode: true,
      repair_mode: true,
      repair_attempt: 1,
      failure_signal: GATE_SIGNAL,
      site_id: w.site_id,
      target: { github_full_name: w.site().github_full_name },
    });
    expect(fix.payload.customer_origin).toBeUndefined();
    expect(fix.payload.site_sha).toBeUndefined();
    expect(fix.payload.republish).toBeUndefined();
    const run = w.runs.get(run_id)!;
    expect(run.status).toBe("active");
    expect(w.consumeBudget).toHaveBeenCalledTimes(1);
    expect(run.spend_usd).toBeGreaterThan(0);
    expect(w.site().status).toBe("publishing");

    expect(await conductorTick(run_id, w.deps)).toEqual({ action: "waiting", in_flight: 1 });
    expect(w.steps).toHaveLength(1);

    w.headOf.mockImplementation(async () => ({ sha: FIXED }));
    w.child.status = "success";
    expect(await conductorTick(run_id, w.deps)).toEqual({ action: "completed", final: "done" });
    expect(w.steps.map((s) => s.sha)).toEqual([HEAD, FIXED]);
    expect(w.runs.get(run_id)!.status).toBe("done");
    expect(w.site()).toMatchObject({ status: "live", last_error: null, desired_sha: FIXED });
    expect(w.dispatchRepair).toHaveBeenCalledTimes(1);
  });

  it("budget exhaustion before a first-publish fix leaves the site retryable", async () => {
    const w = await world();
    w.outcomes.push({ kind: "repair", signal: GATE_SIGNAL });
    const first = await w.publish();
    const run_id = first.body.conductor_run_id!;
    w.runs.get(run_id)!.max_usd = 0;
    expect(await conductorTick(run_id, w.deps)).toEqual({ action: "halted" });
    expect(w.dispatchRepair).not.toHaveBeenCalled();
    expect(w.runs.get(run_id)!.status).toBe("halted");
    expect(w.site()).toMatchObject({ status: "building", last_error: "Build budget reached before the site fix." });
    w.outcomes.push({ kind: "live", url: "https://shop.zaviagent.com", verified_at: "2026-10-02T00:00:00.000Z" });
    const second = await w.publish();
    expect(second.statusCode).toBe(200);
    expect(await conductorTick(second.body.conductor_run_id!, w.deps)).toEqual({ action: "completed", final: "done" });
  });

  it("when the fix passes run out, the publish fails with the check's reason and the site goes back to building, not failed", async () => {
    const w = await world();
    w.outcomes.push({ kind: "repair", signal: GATE_SIGNAL }, { kind: "repair", signal: GATE_SIGNAL });
    const first = await w.publish();
    const run_id = first.body.conductor_run_id!;
    expect(await conductorTick(run_id, w.deps)).toMatchObject({ action: "site_repair_dispatched", attempt: 1 });
    expect(await conductorTick(run_id, w.deps)).toEqual({ action: "completed", final: "failed" });

    expect(w.dispatchRepair).toHaveBeenCalledTimes(1);
    expect(w.steps).toHaveLength(2);
    const run = w.runs.get(run_id)!;
    expect(run.status).toBe("failed");
    expect(run.reason?.failure_class).toBe("repair_exhausted");
    expect(run.reason?.failure_reason).toContain(GATE_SIGNAL);
    expect(w.site().status).toBe("building");
    expect(w.site().last_error).toContain("The site's smoke check failed");

    w.outcomes.push({ kind: "live", url: "https://shop.zaviagent.com", verified_at: "2026-10-02T00:00:00.000Z" });
    const again = await w.publish();
    expect(again.statusCode).toBe(200);
  });

  it("a live site's republish whose check fails still fails as it did, with no engineer dispatched and nothing charged", async () => {
    const w = await world({ live: true });
    w.outcomes.push({ kind: "repair", signal: GATE_SIGNAL });
    const first = await w.publish();
    const run_id = first.body.conductor_run_id!;
    expect(await conductorTick(run_id, w.deps)).toEqual({ action: "completed", final: "failed" });

    expect(w.runs.get(run_id)!.reason).toEqual({ failure_class: "deploy_failed", failure_reason: GATE_SIGNAL });
    expect(w.dispatchRepair).not.toHaveBeenCalled();
    expect(w.dispatch).not.toHaveBeenCalled();
    expect(w.consumeBudget).not.toHaveBeenCalled();
    expect(w.site()).toMatchObject({ status: "live", live_deploy_id: "d-old", last_error: null });
  });

  it("an undo republish of a never-published site never gets a fix pass: only a Publish the owner pressed does", async () => {
    const w = await world();
    w.outcomes.push({ kind: "repair", signal: GATE_SIGNAL });
    const run_id = await w.republisher.reserve({ tenant_id: T1, site: w.site() });
    await w.republisher.start({ tenant_id: T1, conductor_run_id: run_id, site: w.site(), sha: HEAD });
    w.runs.get(run_id)!.objective = "[refine] undo";
    expect(await conductorTick(run_id, w.deps)).toEqual({ action: "completed", final: "failed" });

    expect(w.runs.get(run_id)!.reason).toEqual({ failure_class: "deploy_failed", failure_reason: GATE_SIGNAL });
    expect(w.dispatchRepair).not.toHaveBeenCalled();
    expect(w.consumeBudget).not.toHaveBeenCalled();
  });

  it("a publish of a site that was activated once before gets no fix pass", async () => {
    const w = await world();
    Object.assign(w.site(), { live_deploy_id: "d-before", live_sha: "aaaaaaa" });
    w.outcomes.push({ kind: "repair", signal: GATE_SIGNAL });
    const first = await w.publish();
    expect(await conductorTick(first.body.conductor_run_id!, w.deps)).toEqual({ action: "completed", final: "failed" });
    expect(w.dispatchRepair).not.toHaveBeenCalled();
    expect(w.site()).toMatchObject({ status: "live", last_error: GATE_SIGNAL, live_deploy_id: "d-before" });
  });

  it("with fix passes switched off the reason is still the check's own", async () => {
    h.repairMax = 0;
    const w = await world();
    w.outcomes.push({ kind: "repair", signal: GATE_SIGNAL });
    const first = await w.publish();
    await conductorTick(first.body.conductor_run_id!, w.deps);
    const run = w.runs.get(first.body.conductor_run_id!)!;
    expect(run.reason).toEqual({ failure_class: "repair_exhausted", failure_reason: GATE_SIGNAL });
    expect(w.site()).toMatchObject({ status: "building", last_error: GATE_SIGNAL });
  });

  it("a deploy step that keeps throwing fails the publish and still leaves the site building", async () => {
    const w = await world();
    const first = await w.publish();
    const run_id = first.body.conductor_run_id!;
    setSiteWiring({
      deployHandler: {
        step: vi.fn(async () => {
          throw new Error("e2b unreachable");
        }),
      },
    });
    let last: unknown;
    for (let i = 0; i < 10 && w.runs.get(run_id)!.status === "active"; i++) last = await conductorTick(run_id, w.deps);
    expect(last).toEqual({ action: "completed", final: "failed" });
    const reason = `${SITE_PUBLISH_PLATFORM_RETRY}\nPublishing kept failing: e2b unreachable`;
    expect(w.runs.get(run_id)!.reason?.failure_reason).toBe(reason);
    expect(w.site()).toMatchObject({ status: "building", last_error: reason });
    expect(publishReason(reason, "deploy_failed")).toBe(SITE_PUBLISH_PLATFORM_RETRY);
  });

  it("a settle that hits a database blip is retried, so the site does not stay publishing behind a dead run", async () => {
    const w = await world();
    w.outcomes.push({ kind: "failed", reason: "Site hosting is not configured." });
    const first = await w.publish();
    const run_id = first.body.conductor_run_id!;
    const settle = w.siteDeploy.settle!;
    let calls = 0;
    w.deps.siteDeploy = {
      ...w.siteDeploy,
      settle: async (input) => {
        calls += 1;
        if (calls <= 2) throw new Error("db blip");
        return settle(input);
      },
    };
    expect(await conductorTick(run_id, w.deps)).toEqual({ action: "completed", final: "failed" });
    expect(calls).toBe(3);
    expect(w.sleeps).toEqual([250, 1000]);
    expect(w.site()).toMatchObject({ status: "building", last_error: "Site hosting is not configured." });
  });

  it("the settle is told this is an edit or publish run, with the run's tenant and site", async () => {
    const w = await world();
    w.outcomes.push({ kind: "failed", reason: "nope" });
    const first = await w.publish();
    const seen: unknown[] = [];
    w.deps.siteDeploy = { ...w.siteDeploy, settle: async (input) => void seen.push(input) };
    await conductorTick(first.body.conductor_run_id!, w.deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tenant_id: T1,
      site_id: w.site_id,
      outcome: "failed",
      reason: "nope",
      refine_run: true,
      conductor_run_id: first.body.conductor_run_id,
    });
  });
});

describe("a first publish that is activated and then fails verification", () => {
  const NOT_SERVING = "The site was published but shop.zaviagent.com is not serving it yet.";

  async function activatedThenUnverified() {
    const w = await world();
    w.beforeOutcome.push(async () => {
      expect(await store.activateIfDesired(T1, w.site_id, HEAD, "d-new", "https://shop.zaviagent.com")).toBe(true);
    });
    w.outcomes.push({ kind: "failed", reason: NOT_SERVING });
    const first = await w.publish();
    expect(await conductorTick(first.body.conductor_run_id!, w.deps)).toEqual({ action: "completed", final: "failed" });
    return { w, first };
  }

  it("settles the site live with the reason, because its hostname is public, and keeps the activated deploy", async () => {
    const { w, first } = await activatedThenUnverified();
    expect(w.statusAtStep).toEqual(["publishing"]);
    expect(w.runs.get(first.body.conductor_run_id!)!.reason).toEqual({ failure_class: "deploy_failed", failure_reason: NOT_SERVING });
    expect(w.site()).toMatchObject({ status: "live", last_error: NOT_SERVING, live_deploy_id: "d-new", live_sha: HEAD, desired_sha: HEAD });
  });

  it("build status shows the public address, never Not published", async () => {
    const { w } = await activatedThenUnverified();
    expect(siteLiveUrl(w.site())).toBe("https://shop.zaviagent.com");
    expect(sitePublishedUrl(w.site())).toBe("https://shop.zaviagent.com");
  });

  it.each(["dead", "done"] as const)("is never reaped, even 24 hours later behind a %s run", async (runState) => {
    const { w } = await activatedThenUnverified();
    w.site().updated_at = "2026-10-03T00:00:00.000Z";
    const d = reaperDeps(w.site_id, runState);
    const r = await reapSites(d);
    expect(r.reaped).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(d.deleted).toEqual([]);
    expect(w.site()).toMatchObject({ status: "live", live_deploy_id: "d-new" });
    expect(providersOf(store, T1, w.site_id).map((p) => p.state)).toEqual(["created"]);
  });

  it("the same commit is already published, so a second Publish starts nothing", async () => {
    const { w } = await activatedThenUnverified();
    const second = await w.publish();
    expect(second.statusCode).toBe(409);
    expect(second.body.error?.code).toBe("already_published");
  });
});

describe("a failed chat edit on a never-published site", () => {
  it("fails the edit run and leaves the site building, so the site can still be edited and published", async () => {
    const w = await world();
    const graph: ConductorNode[] = [
      {
        id: "edit",
        status: "failed",
        target_agent_slug: "engineer",
        payload: { stage: "build", refine_mode: true, site_id: w.site_id },
        estimate_usd: 0,
        child_run_id: "child-1",
        error: "The change could not be applied.",
        failure_class: "stage_failed",
      },
    ];
    w.runs.set("edit-run", { id: "edit-run", tenant_id: T1, objective: "[refine] make the header blue", status: "active", max_usd: 2, spend_usd: 0, kind: "build_app", goal_graph: graph });
    const out = await conductorTick("edit-run", w.deps);
    expect(out).toMatchObject({ action: "completed", final: "failed" });
    expect(w.runs.get("edit-run")!.status).toBe("failed");
    expect(w.site()).toMatchObject({ status: "building", last_error: "The change could not be applied." });

    w.outcomes.push({ kind: "live", url: "https://shop.zaviagent.com", verified_at: "2026-10-02T00:00:00.000Z" });
    const published = await w.publish();
    expect(published.statusCode).toBe(200);
  });
});

describe("what stays as it was", () => {
  it("a failed republish of a live site leaves it live and untouched", async () => {
    const w = await world({ live: true });
    w.outcomes.push({ kind: "failed", reason: "The site's smoke check failed: checkout" });
    const first = await w.publish();
    expect(first.statusCode).toBe(200);
    expect(await conductorTick(first.body.conductor_run_id!, w.deps)).toEqual({ action: "completed", final: "failed" });
    expect(w.statusAtStep).toEqual(["live"]);
    expect(w.site()).toMatchObject({ status: "live", live_deploy_id: "d-old", live_sha: "aaaaaaa", last_error: null, live_url: expect.stringMatching(/^https:\/\//) });

    w.site().updated_at = "2026-10-03T00:00:00.000Z";
    const d = reaperDeps(w.site_id, "done");
    const r = await reapSites(d);
    expect(r.reaped).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(w.site().status).toBe("live");
  });

  it("a root build that fails still settles its never-live site failed, and the reaper still clears it after 24 hours", async () => {
    const w = await world();
    const graph: ConductorNode[] = [
      { id: "p", status: "done", target_agent_slug: "", payload: { stage: "provision" }, estimate_usd: 0, child_run_id: null },
      { id: "d", status: "pending", target_agent_slug: "", payload: { stage: "deploy", site_id: w.site_id, site_sha: HEAD }, estimate_usd: 0, child_run_id: null },
    ];
    w.runs.set(ROOT, { id: ROOT, tenant_id: T1, objective: "Build product: Shop", status: "active", max_usd: 10, spend_usd: 0, kind: "build_app", goal_graph: graph });
    w.outcomes.push({ kind: "failed", reason: "Site hosting is not configured." });
    expect(await conductorTick(ROOT, w.deps)).toEqual({ action: "completed", final: "failed" });
    expect(w.site()).toMatchObject({ status: "failed", last_error: "Site hosting is not configured." });

    w.site().updated_at = "2026-10-03T00:00:00.000Z";
    const d = reaperDeps(w.site_id, "dead");
    const r = await reapSites(d);
    expect(r.pending).toEqual([w.site_id]);
    expect(w.site().status).toBe("deleting");
  });
});
