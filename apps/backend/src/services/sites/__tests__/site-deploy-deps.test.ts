
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/settings", () => ({ getNumberSetting: vi.fn(async () => 1) }));

import { makeSiteDeployDeps, SITE_PUBLISH_UNAVAILABLE } from "../site-deploy-deps";
import { nodePayloadCheckpoints } from "../deploy-checkpoints";
import type { SiteDeployHandler } from "../contract";
import { fakeStore, type FakeStore } from "./site-fakes";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
let store: FakeStore;

async function site(tenant: string, run: string) {
  const s = await store.getOrCreateForRun({ tenant_id: tenant, root_conductor_run_id: run, company_name: "Shop", started_by_user_id: null });
  await store.transition(tenant, s.id, ["provisioning"], "building");
  return store.update(tenant, s.id, { github_full_name: `praxis-built/${s.label}` });
}

beforeEach(() => {
  store = fakeStore();
});

describe("makeSiteDeployDeps", () => {
  it("step without a wired handler fails plainly", async () => {
    const d = makeSiteDeployDeps({ store, handler: () => null });
    expect(await d.step({ tenant_id: T1, conductor_run_id: "c", site_id: "s", sha: "x", attempt: 1, checkpoint: {} })).toEqual({ kind: "failed", reason: SITE_PUBLISH_UNAVAILABLE });
  });

  it("step delegates to the wired handler", async () => {
    const h: SiteDeployHandler = { step: vi.fn(async () => ({ kind: "waiting" as const })) };
    const d = makeSiteDeployDeps({ store, handler: () => h });
    await d.step({ tenant_id: T1, conductor_run_id: "c", site_id: "s", sha: "x", attempt: 1, checkpoint: {} });
    expect(h.step).toHaveBeenCalledWith({ tenant_id: T1, conductor_run_id: "c", site_id: "s", sha: "x", attempt: 1 });
  });

  it("no site database capacity (pool or publish-gate validation shard) is a capacity WAIT, with a sweep asked for; other errors still throw", async () => {
    const { NoShardCapacity } = await import("@/services/site-shards/contract");
    const { TestSiteUnavailable } = await import("@/services/site-shards/test-site");
    const errors: unknown[] = [new NoShardCapacity("prod"), new TestSiteUnavailable("no validation shard has room", true)];
    const h: SiteDeployHandler = { step: vi.fn(async () => { throw errors.shift(); }) };
    const requestCapacitySweep = vi.fn(async () => undefined);
    const d = makeSiteDeployDeps({ store, handler: () => h, requestCapacitySweep });
    const input = { tenant_id: T1, conductor_run_id: "c", site_id: "s", sha: "x", attempt: 1, checkpoint: {} };
    expect(await d.step(input)).toEqual({ kind: "waiting", reason: "database_capacity" });
    expect(await d.step(input)).toEqual({ kind: "waiting", reason: "database_capacity" });
    expect(requestCapacitySweep).toHaveBeenCalledTimes(2);
    requestCapacitySweep.mockRejectedValueOnce(new Error("inngest down"));
    errors.push(new NoShardCapacity("prod"));
    expect(await d.step(input)).toEqual({ kind: "waiting", reason: "database_capacity" });
    for (const e of [new TestSiteUnavailable("supabase 500"), new TestSiteUnavailable("this site already has the maximum number of live test sites"), new Error("r2 blip")]) {
      errors.push(e);
      await expect(d.step(input)).rejects.toBe(e);
    }
  });

  it("the handler's checkpoint store reads and writes THIS deploy node's bag", async () => {
    const cps = nodePayloadCheckpoints<{ deploy_id: string }>();
    const h: SiteDeployHandler = {
      step: vi.fn(async () => {
        const prev = await cps.get("k");
        await cps.set("k", { deploy_id: prev ? `${prev.deploy_id}+` : "d1" });
        return { kind: "waiting" as const };
      }),
    };
    const d = makeSiteDeployDeps({ store, handler: () => h });
    const bagA: Record<string, unknown> = {};
    const bagB: Record<string, unknown> = {};
    await d.step({ tenant_id: T1, conductor_run_id: "c1", site_id: "a", sha: "x", attempt: 1, checkpoint: bagA });
    await d.step({ tenant_id: T1, conductor_run_id: "c1", site_id: "a", sha: "x", attempt: 1, checkpoint: bagA });
    await d.step({ tenant_id: T1, conductor_run_id: "c2", site_id: "b", sha: "y", attempt: 1, checkpoint: bagB });
    expect(bagA).toEqual({ k: { deploy_id: "d1+" } });
    expect(bagB).toEqual({ k: { deploy_id: "d1" } });
    await expect(cps.get("k")).rejects.toThrow(/outside a conductor deploy step/);
  });

  it("headSha reads THIS site's repo, and nothing for another tenant's site", async () => {
    const a = await site(T1, "r1");
    const b = await site(T1, "r2");
    const headOf = vi.fn(async (full: string) => ({ sha: `sha-of-${full}` }));
    const d = makeSiteDeployDeps({ store, headOf, org: () => "praxis-built" });
    expect(await d.headSha({ tenant_id: T1, site_id: a.id })).toBe(`sha-of-${a.github_full_name}`);
    expect(await d.headSha({ tenant_id: T1, site_id: b.id })).toBe(`sha-of-${b.github_full_name}`);
    expect(await d.headSha({ tenant_id: T2, site_id: a.id })).toBeNull();
  });

  it("a failed head read throws GitHub's answer, never a bare null", async () => {
    const a = await site(T1, "r1");
    const d = makeSiteDeployDeps({ store, org: () => "praxis-built", headOf: async () => ({ error: "GitHub answered 404" }) });
    await expect(d.headSha({ tenant_id: T1, site_id: a.id })).rejects.toThrow(/GitHub answered 404/);
  });

  it("ownsSite: only sites whose repo is in this server's provisioning org", async () => {
    const a = await site(T1, "r1");
    const mine = makeSiteDeployDeps({ store, org: () => "Praxis-Built" });
    const other = makeSiteDeployDeps({ store, org: () => "zavi-latest-build" });
    expect(await mine.ownsSite!({ tenant_id: T1, site_id: a.id })).toBe(true);
    expect(await other.ownsSite!({ tenant_id: T1, site_id: a.id })).toBe(false);
    const fresh = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "r9", company_name: "Shop", started_by_user_id: null });
    expect(await other.ownsSite!({ tenant_id: T1, site_id: fresh.id })).toBe(true);
  });

  it("markDesired moves building → publishing only; the desired commit moves with the publish generation (never around its lease)", async () => {
    const a = await site(T1, "r1");
    const d = makeSiteDeployDeps({ store });
    const before = store.sites.get(a.id)?.desired_sha ?? null;
    await d.markDesired({ tenant_id: T1, site_id: a.id, sha: "s1" });
    expect(store.sites.get(a.id)).toMatchObject({ status: "publishing", desired_sha: before });
  });

  it("settle: live marks the site live; failed never downgrades a live site", async () => {
    const a = await site(T1, "r1");
    const d = makeSiteDeployDeps({ store });
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome: "live" });
    expect(store.sites.get(a.id)?.status).toBe("live");
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome: "failed", reason: "x" });
    expect(store.sites.get(a.id)?.status).toBe("live");
    const b = await site(T1, "r2");
    await d.settle!({ tenant_id: T1, site_id: b.id, outcome: "failed", reason: "gate failed" });
    expect(store.sites.get(b.id)).toMatchObject({ status: "failed", last_error: "gate failed" });
  });

  it.each([
    ["failed", false, "The site was published but alpha.zaviagent.com is not serving it yet."],
    ["failed", true, "The site's smoke check failed: login"],
    ["paused", false, "The build stopped."],
  ] as const)("settle %s (edit run: %s) on a first publish whose deploy already went live: the site is settled live, never failed or building", async (outcome, refine_run, reason) => {
    const a = await site(T1, `r-served-${outcome}-${refine_run}`);
    const d = makeSiteDeployDeps({ store });
    await d.markDesired({ tenant_id: T1, site_id: a.id, sha: "s1" });
    await store.update(T1, a.id, { desired_sha: "s1" });
    expect(await store.activateIfDesired(T1, a.id, "s1", "d00000000a-0123abcd", `https://${a.hostname}`)).toBe(true);
    expect(store.sites.get(a.id)?.status).toBe("publishing");
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome, reason, ...(refine_run ? { refine_run: true } : {}) });
    expect(store.sites.get(a.id)).toMatchObject({
      status: "live",
      live_deploy_id: "d00000000a-0123abcd",
      live_sha: "s1",
      last_error: reason,
    });
  });

  it("settle paused: a publishing site goes back to building with the reason; a retry re-enters publishing via markDesired's CAS; a live site is untouched", async () => {
    const a = await site(T1, "r3");
    const d = makeSiteDeployDeps({ store });
    await d.markDesired({ tenant_id: T1, site_id: a.id, sha: "s1" });
    expect(store.sites.get(a.id)?.status).toBe("publishing");
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome: "paused", reason: "The site's smoke check failed: login" });
    expect(store.sites.get(a.id)).toMatchObject({ status: "building", last_error: "The site's smoke check failed: login" });
    await d.markDesired({ tenant_id: T1, site_id: a.id, sha: "s2" });
    expect(store.sites.get(a.id)?.status).toBe("publishing");
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome: "live" });
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome: "paused", reason: "x" });
    expect(store.sites.get(a.id)).toMatchObject({ status: "live", last_error: null });
  });

  it("settle failed for an edit or publish run: a site that was never live goes back to building with the reason, never failed", async () => {
    const d = makeSiteDeployDeps({ store });
    const publishing = await site(T1, "r-pub");
    await d.markDesired({ tenant_id: T1, site_id: publishing.id, sha: "s1" });
    expect(store.sites.get(publishing.id)?.status).toBe("publishing");
    await store.update(T1, publishing.id, { desired_sha: "s1" });
    await d.settle!({ tenant_id: T1, site_id: publishing.id, outcome: "failed", reason: "The site's smoke check failed: login", refine_run: true });
    expect(store.sites.get(publishing.id)).toMatchObject({
      status: "building",
      last_error: "The site's smoke check failed: login",
      live_deploy_id: null,
      desired_sha: "s1",
    });

    const building = await site(T1, "r-edit");
    await d.settle!({ tenant_id: T1, site_id: building.id, outcome: "failed", reason: "x".repeat(900), refine_run: true });
    expect(store.sites.get(building.id)?.status).toBe("building");
    expect(store.sites.get(building.id)?.last_error).toBe("x".repeat(500));

    await store.update(T1, publishing.id, { desired_sha: "s2" });
    await d.markDesired({ tenant_id: T1, site_id: publishing.id, sha: "s2" });
    expect(store.sites.get(publishing.id)).toMatchObject({ status: "publishing", desired_sha: "s2" });
    await d.settle!({ tenant_id: T1, site_id: publishing.id, outcome: "live" });
    expect(store.sites.get(publishing.id)).toMatchObject({ status: "live", last_error: null });
  });

  it("settle failed for the root build run is unchanged: the never-live site is failed", async () => {
    const d = makeSiteDeployDeps({ store });
    const a = await site(T1, "r-root");
    await d.markDesired({ tenant_id: T1, site_id: a.id, sha: "s1" });
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome: "failed", reason: "gate failed" });
    expect(store.sites.get(a.id)).toMatchObject({ status: "failed", last_error: "gate failed" });
    const b = await site(T1, "r-root-2");
    await d.settle!({ tenant_id: T1, site_id: b.id, outcome: "failed", reason: "gate failed", refine_run: false });
    expect(store.sites.get(b.id)?.status).toBe("failed");
  });

  it("settle failed for an edit or publish run never touches a site whose status is live, paused or waking", async () => {
    const d = makeSiteDeployDeps({ store });
    for (const status of ["live", "paused", "waking"] as const) {
      const s = await site(T1, `r-${status}`);
      Object.assign(store.sites.get(s.id)!, { status, live_deploy_id: "d1", live_sha: "s0", desired_sha: "s0", last_error: null });
      await d.settle!({ tenant_id: T1, site_id: s.id, outcome: "failed", reason: "x", refine_run: true });
      expect(store.sites.get(s.id), status).toMatchObject({ status, last_error: null, live_deploy_id: "d1", live_sha: "s0" });
    }
  });

  it("settle failed for a first publish that was activated but never verified: the site is public, so it settles live with the reason, never building or failed", async () => {
    const d = makeSiteDeployDeps({ store });
    const a = await site(T1, "r-unverified");
    await d.markDesired({ tenant_id: T1, site_id: a.id, sha: "s1" });
    await store.update(T1, a.id, { desired_sha: "s1" });
    expect(await store.activateIfDesired(T1, a.id, "s1", "d1", `https://${a.hostname}`)).toBe(true);
    expect(store.sites.get(a.id)).toMatchObject({ status: "publishing", live_deploy_id: "d1" });
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome: "failed", reason: "The site was published but it is not serving yet.", refine_run: true });
    expect(store.sites.get(a.id)).toMatchObject({
      status: "live",
      last_error: "The site was published but it is not serving yet.",
      live_deploy_id: "d1",
      live_sha: "s1",
    });

    await d.settle!({ tenant_id: T1, site_id: a.id, outcome: "failed", reason: "again", refine_run: true });
    expect(store.sites.get(a.id)).toMatchObject({ status: "live", last_error: "The site was published but it is not serving yet.", live_deploy_id: "d1" });
  });

  it.each([
    ["failed", false, "failed"],
    ["failed", true, "building"],
    ["paused", false, "building"],
  ] as const)("settle %s (edit run: %s) is one compare-and-set with no read that could fail first", async (outcome, refine_run, to) => {
    const a = await site(T1, `r-blip-${outcome}-${refine_run}`);
    await makeSiteDeployDeps({ store }).markDesired({ tenant_id: T1, site_id: a.id, sha: "s1" });
    const get = vi.fn(async () => {
      throw new Error("sites read failed");
    });
    const transition = vi.fn(store.transition);
    const settleStopped = vi.fn(store.settleStopped);
    const d = makeSiteDeployDeps({ store: { ...store, get, transition, settleStopped } });
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome, reason: "x", ...(refine_run ? { refine_run: true } : {}) });
    expect(get).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(settleStopped.mock.calls).toEqual([[T1, a.id, to, "x", undefined, undefined]]);
    expect(store.sites.get(a.id)).toMatchObject({ status: to, last_error: "x" });
  });

  it("markDesired reports the site's publish generation (the run's stop-settle fence floor)", async () => {
    const a = await site(T1, "r-gen-floor");
    Object.assign(store.sites.get(a.id)!, { publish_generation: 4 });
    expect(await makeSiteDeployDeps({ store }).markDesired({ tenant_id: T1, site_id: a.id, sha: "s1" })).toEqual({ publish_generation: 4 });
    expect(await makeSiteDeployDeps({ store }).markDesired({ tenant_id: T1, site_id: a.id, sha: "s2" })).toEqual({});
  });

  it("a stop settle carries the run's generation: a NEWER publish that began since is not overwritten", async () => {
    const a = await site(T1, "r-gen-fence");
    await makeSiteDeployDeps({ store }).markDesired({ tenant_id: T1, site_id: a.id, sha: "s1" });
    Object.assign(store.sites.get(a.id)!, { status: "publishing", publish_generation: 3 });
    const d = makeSiteDeployDeps({ store });
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome: "failed", reason: "stopped", refine_run: true, generation: 2 });
    expect(store.sites.get(a.id)).toMatchObject({ status: "publishing" });
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome: "paused", reason: "stopped", generation: 3 });
    expect(store.sites.get(a.id)).toMatchObject({ status: "building", last_error: "stopped" });
  });

  it("a run's OWN begun publish always settles, even when its saved generation lags (publish_run_id)", async () => {
    const a = await site(T1, "r-own-pub");
    Object.assign(store.sites.get(a.id)!, { status: "publishing", publish_generation: 7, publish_run_id: "run-me" });
    const d = makeSiteDeployDeps({ store });
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome: "failed", reason: "x", conductor_run_id: "run-other" });
    expect(store.sites.get(a.id)).toMatchObject({ status: "publishing" });
    await d.settle!({ tenant_id: T1, site_id: a.id, outcome: "paused", reason: "stopped", conductor_run_id: "run-me", generation: 6 });
    expect(store.sites.get(a.id)).toMatchObject({ status: "building" });
  });

  it("settle failed for an edit or publish run reads the site with the run's tenant: another tenant's site is not moved", async () => {
    const theirs = await site(T2, "r-theirs");
    Object.assign(store.sites.get(theirs.id)!, { status: "publishing" });
    const d = makeSiteDeployDeps({ store });
    await d.settle!({ tenant_id: T1, site_id: theirs.id, outcome: "failed", reason: "x", refine_run: true }).catch(() => undefined);
    expect(store.sites.get(theirs.id)).toMatchObject({ status: "publishing", last_error: null });
  });

  it("repairMaxAttempts reads fast_build_repair_attempts", async () => {
    const d = makeSiteDeployDeps({ store });
    expect(await d.repairMaxAttempts(T1)).toBe(1);
  });
});
