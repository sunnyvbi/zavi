
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { realSiteReaperDeps, reapSites, SITE_REAPED_FAILED, type SiteReaperCandidate, type SiteReaperDeps } from "../site-reaper";
import type { SiteStatus } from "../contract";
import { fakeRepo, fakeStore, fakeSupabase, providersOf, teardownDeps, type FakeStore } from "./site-fakes";

const T1 = "11111111-1111-4111-8111-111111111111";
let store: FakeStore;

async function siteWith(status: SiteStatus, run: string) {
  const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: run, company_name: "Shop", started_by_user_id: null });
  await store.claimProvider(T1, s.id, "github_repo", { name: s.label, owner: "praxis-built" });
  await store.setProviderState(T1, s.id, "github_repo", "created");
  await store.transition(T1, s.id, ["provisioning"], status);
  store.sites.get(s.id)!.updated_at = "2026-09-30T00:00:00.000Z";
  return s;
}

function deps(cands: SiteReaperCandidate[], over: Partial<SiteReaperDeps> = {}): SiteReaperDeps & { deleted: string[] } {
  const repo = fakeRepo();
  const d = {
    candidates: async () => cands,
    runState: async () => "dead" as const,
    teardown: teardownDeps(store, repo, fakeSupabase(store)),
    enabled: () => true,
    envScope: () => ({ allowed: true }),
    now: () => new Date("2026-10-02T00:00:00Z"),
    ...over,
    deleted: repo.deleted,
  };
  return d;
}

beforeEach(() => {
  store = fakeStore();
});

describe("reapSites", () => {
  it("tears down a dead (fell_back_old) site's providers", async () => {
    const s = await siteWith("fell_back_old", "r1");
    const d = deps([{ tenant_id: T1, site_id: s.id, status: "fell_back_old", tenant_slug: "real-co" }]);
    const r = await reapSites(d);
    expect(r.reaped).toEqual([s.id]);
    expect(d.deleted).toEqual([`praxis-built/${s.label}`]);
    expect(providersOf(store, T1, s.id).every((p) => p.state === "deleted")).toBe(true);
  });

  it("cleans up a DELETED site that still holds a provider (a deploy finished after deletion; re-review F2)", async () => {
    const s = await siteWith("deleted", "r-del");
    const d = deps([{ tenant_id: T1, site_id: s.id, status: "deleted", tenant_slug: "real-co" }]);
    const r = await reapSites(d);
    expect(r.reaped).toEqual([s.id]);
    expect(d.deleted).toEqual([`praxis-built/${s.label}`]);
    expect(providersOf(store, T1, s.id).every((p) => p.state === "deleted")).toBe(true);
  });

  it("never touches a LIVE customer site, even if the candidate list says otherwise", async () => {
    const s = await siteWith("live", "r1");
    const d = deps([{ tenant_id: T1, site_id: s.id, status: "fell_back_old", tenant_slug: "real-co" }]);
    const r = await reapSites(d);
    expect(r.reaped).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ site_id: s.id, reason: "status_live" });
    expect(d.deleted).toEqual([]);
  });

  it("is hard-OFF when the env scope refuses (staging)", async () => {
    const s = await siteWith("failed", "r1");
    const d = deps([{ tenant_id: T1, site_id: s.id, status: "failed", tenant_slug: null }], {
      envScope: () => ({ allowed: false, reason: "staging" }),
    });
    const r = await reapSites(d);
    expect(r.refused).toBe("staging");
    expect(d.deleted).toEqual([]);
  });

  it("dry-run (INFRA_REAPER_ENABLED off) deletes nothing", async () => {
    const s = await siteWith("failed", "r1");
    const d = deps([{ tenant_id: T1, site_id: s.id, status: "failed", tenant_slug: null }], { enabled: () => false });
    const r = await reapSites(d);
    expect(r.dry_run).toBe(true);
    expect(d.deleted).toEqual([]);
  });

  it("a finished 'deleting' site ends 'deleted'", async () => {
    const s = await siteWith("deleting", "r1");
    await reapSites(deps([{ tenant_id: T1, site_id: s.id, status: "deleting", tenant_slug: null }]));
    expect((await store.get(T1, s.id))?.status).toBe("deleted");
  });

  it("a reaped 'deleting' site schedules its repo for the grace period instead of failing every pass", async () => {
    const s = await siteWith("deleting", "r-first");
    store.sites.get(s.id)!.last_error = SITE_REAPED_FAILED;
    const r = await reapSites(deps([{ tenant_id: T1, site_id: s.id, status: "deleting", tenant_slug: null }]));
    expect(r.skipped).toEqual([]);
    expect(r.pending).toEqual([s.id]);
    expect(providersOf(store, T1, s.id).find((p) => p.kind === "github_repo")?.state).toBe("delete_scheduled");
  });

  it("asks for candidates older than 24h", async () => {
    let cutoff = "";
    await reapSites(deps([], { candidates: async (c) => { cutoff = c; return []; } }));
    expect(cutoff).toBe("2026-10-01T00:00:00.000Z");
  });

  describe("sites stranded in provisioning/building (S4 F3)", () => {
    async function stranded(status: "provisioning" | "building", updated_at: string) {
      const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: `run-${status}`, company_name: "Shop", started_by_user_id: null });
      await store.claimProvider(T1, s.id, "github_repo", { name: s.label, owner: "praxis-built" });
      await store.setProviderState(T1, s.id, "github_repo", "created");
      if (status === "building") await store.transition(T1, s.id, ["provisioning"], "building");
      store.sites.get(s.id)!.updated_at = updated_at;
      return s;
    }
    const OLD = "2026-09-30T00:00:00.000Z";
    const FRESH = "2026-10-01T12:00:00.000Z";

    it.each(["provisioning", "building"] as const)("tears down a %s site older than 24h whose run is dead, and marks it failed", async (status) => {
      const s = await stranded(status, OLD);
      const runState = async () => "dead" as const;
      const d = deps([{ tenant_id: T1, site_id: s.id, status, tenant_slug: "real-co" }], { runState });
      const r = await reapSites(d);
      expect(r.pending).toEqual([s.id]);
      expect(d.deleted).toEqual([]);
      expect(providersOf(store, T1, s.id).find((p) => p.kind === "github_repo")?.state).toBe("delete_scheduled");
      expect((await store.get(T1, s.id))?.status).toBe("deleting");
    });

    it("never touches a stranded-looking site younger than 24h (the fresh row decides)", async () => {
      const s = await stranded("provisioning", FRESH);
      const d = deps([{ tenant_id: T1, site_id: s.id, status: "provisioning", tenant_slug: null }], { runState: async () => "dead" });
      const r = await reapSites(d);
      expect(r.reaped).toEqual([]);
      expect(r.skipped[0]).toMatchObject({ site_id: s.id, reason: "stranded_too_young" });
      expect(d.deleted).toEqual([]);
      expect((await store.get(T1, s.id))?.status).toBe("provisioning");
    });

    it("never touches a stranded site whose build run is still live (a paused build)", async () => {
      const s = await stranded("building", OLD);
      const seen: Array<[string, string | null]> = [];
      const d = deps([{ tenant_id: T1, site_id: s.id, status: "building", tenant_slug: null }], {
        runState: async (t, run) => (seen.push([t, run]), "live" as const),
      });
      const r = await reapSites(d);
      expect(seen).toEqual([[T1, "run-building"]]);
      expect(r.skipped[0]).toMatchObject({ site_id: s.id, reason: "run_live" });
      expect(d.deleted).toEqual([]);
    });

    it("fails closed when the run check is unavailable or throws", async () => {
      const s = await stranded("building", OLD);
      const c = [{ tenant_id: T1, site_id: s.id, status: "building" as const, tenant_slug: null }];
      const r1 = await reapSites(deps(c, { runState: undefined }));
      expect(r1.skipped[0]).toMatchObject({ reason: "run_check_unavailable" });
      const d2 = deps(c, { runState: async () => { throw new Error("db down"); } });
      const r2 = await reapSites(d2);
      expect(r2.skipped[0].reason).toMatch(/^error: db down/);
      expect(d2.deleted).toEqual([]);
      expect((await store.get(T1, s.id))?.status).toBe("building");
    });

    it("claims a stranded site atomically (site_claim_stranded) with the cutoff; a Retry that revived the run in between wins", async () => {
      const s = await stranded("building", OLD);
      const calls: unknown[][] = [];
      const lost = deps([{ tenant_id: T1, site_id: s.id, status: "building", tenant_slug: null }], {
        runState: async () => "dead",
        claimStranded: async (...a) => (calls.push(a), false),
      });
      const r = await reapSites(lost);
      expect(calls).toEqual([[T1, s.id, "2026-10-01T00:00:00.000Z", "Cleaned up: the build stopped while setting up this site."]]);
      expect(r.skipped[0]).toMatchObject({ site_id: s.id, reason: "status_changed" });
      expect(lost.deleted).toEqual([]);
      expect((await store.get(T1, s.id))?.status).toBe("building");

      const won = deps([{ tenant_id: T1, site_id: s.id, status: "building", tenant_slug: null }], {
        runState: async () => "dead",
        claimStranded: async (t, id, _c, last_error) => (Object.assign(store.sites.get(id)!, { status: "deleting", last_error }), t === T1),
      });
      expect((await reapSites(won)).pending).toEqual([s.id]);
    });

    it("a stranded site with NO provider (setup failed before its first claim) is claimed and ends deleted", async () => {
      const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "run-bare", company_name: "Shop", started_by_user_id: null });
      store.sites.get(s.id)!.updated_at = OLD;
      const d = deps([{ tenant_id: T1, site_id: s.id, status: "provisioning", tenant_slug: null }], {
        runState: async () => "dead",
        claimStranded: async (_t, id) => (store.sites.get(id)!.status = "deleting", true),
      });
      expect((await reapSites(d)).reaped).toEqual([s.id]);
      expect((await store.get(T1, s.id))?.status).toBe("deleted");
    });

    it("never touches a building site whose build run finished done, however old it is: it is an unpublished site, not a stranded one", async () => {
      const s = await stranded("building", "2026-07-01T00:00:00.000Z");
      const seen: Array<[string, string | null]> = [];
      const claims: unknown[][] = [];
      const d = deps([{ tenant_id: T1, site_id: s.id, status: "building", tenant_slug: "real-co" }], {
        runState: async (t, run) => (seen.push([t, run]), "done" as const),
        claimStranded: async (...a) => (claims.push(a), true),
      });
      const r = await reapSites(d);
      expect(seen).toEqual([[T1, "run-building"]]);
      expect(r.skipped).toEqual([{ site_id: s.id, reason: "build_finished" }]);
      expect(r.reaped).toEqual([]);
      expect(r.pending).toEqual([]);
      expect(claims).toEqual([]);
      expect(d.deleted).toEqual([]);
      expect(providersOf(store, T1, s.id).map((p) => [p.kind, p.state])).toEqual([["github_repo", "created"]]);
      const after = await store.get(T1, s.id);
      expect(after?.status).toBe("building");
      expect(after?.last_error ?? null).toBeNull();
    });

    it("a finished build survives every hourly pass, with or without the atomic claim", async () => {
      const s = await stranded("building", OLD);
      const cand = [{ tenant_id: T1, site_id: s.id, status: "building" as const, tenant_slug: "real-co" }];
      for (let pass = 0; pass < 3; pass++) {
        const d = deps(cand, { runState: async () => "done" });
        await reapSites(d);
        expect(d.deleted).toEqual([]);
      }
      expect((await store.get(T1, s.id))?.status).toBe("building");
      expect(providersOf(store, T1, s.id).find((p) => p.kind === "github_repo")?.state).toBe("created");
    });

    it("the exemption is not a blanket one: of three old building sites only the one whose run finished done is kept", async () => {
      const mk = async (run: string) => {
        const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: run, company_name: `Shop ${run}`, started_by_user_id: null });
        await store.claimProvider(T1, s.id, "github_repo", { name: s.label, owner: "praxis-built" });
        await store.setProviderState(T1, s.id, "github_repo", "created");
        await store.transition(T1, s.id, ["provisioning"], "building");
        store.sites.get(s.id)!.updated_at = OLD;
        return s;
      };
      const finished = await mk("run-done");
      const failed = await mk("run-failed");
      const vanished = await mk("run-vanished");
      const states: Record<string, "done" | "dead"> = { "run-done": "done", "run-failed": "dead", "run-vanished": "dead" };
      const d = deps(
        [finished, failed, vanished].map((s) => ({ tenant_id: T1, site_id: s.id, status: "building" as const, tenant_slug: "real-co" })),
        { runState: async (_t, run) => states[String(run)] },
      );
      const r = await reapSites(d);
      expect(r.skipped).toEqual([{ site_id: finished.id, reason: "build_finished" }]);
      expect(r.pending.sort()).toEqual([failed.id, vanished.id].sort());
      expect((await store.get(T1, finished.id))?.status).toBe("building");
      expect((await store.get(T1, failed.id))?.status).toBe("deleting");
      expect((await store.get(T1, vanished.id))?.status).toBe("deleting");
      expect(providersOf(store, T1, finished.id).find((p) => p.kind === "github_repo")?.state).toBe("created");
      expect(providersOf(store, T1, failed.id).find((p) => p.kind === "github_repo")?.state).toBe("delete_scheduled");
      expect(providersOf(store, T1, vanished.id).find((p) => p.kind === "github_repo")?.state).toBe("delete_scheduled");
    });

    it("a site still provisioning behind a done run is not a finished build and is still cleared", async () => {
      const s = await stranded("provisioning", OLD);
      const d = deps([{ tenant_id: T1, site_id: s.id, status: "provisioning", tenant_slug: "real-co" }], { runState: async () => "done" });
      const r = await reapSites(d);
      expect(r.pending).toEqual([s.id]);
      expect((await store.get(T1, s.id))?.status).toBe("deleting");
    });

    it("a run state it does not know is never read as dead", async () => {
      const s = await stranded("building", OLD);
      const d = deps([{ tenant_id: T1, site_id: s.id, status: "building", tenant_slug: null }], {
        runState: (async () => undefined) as unknown as SiteReaperDeps["runState"],
      });
      const r = await reapSites(d);
      expect(r.skipped).toEqual([{ site_id: s.id, reason: "run_check_unavailable" }]);
      expect(d.deleted).toEqual([]);
      expect((await store.get(T1, s.id))?.status).toBe("building");
    });

    it("a finished build that went back to building after the listing is still kept (the fresh row and its run decide)", async () => {
      const s = await stranded("building", OLD);
      const d = deps([{ tenant_id: T1, site_id: s.id, status: "provisioning", tenant_slug: "real-co" }], { runState: async () => "done" });
      const r = await reapSites(d);
      expect(r.skipped).toEqual([{ site_id: s.id, reason: "build_finished" }]);
      expect((await store.get(T1, s.id))?.status).toBe("building");
    });

    it("dry-run neither transitions nor deletes a stranded site", async () => {
      const s = await stranded("provisioning", OLD);
      const d = deps([{ tenant_id: T1, site_id: s.id, status: "provisioning", tenant_slug: null }], { enabled: () => false, runState: async () => "dead" });
      await reapSites(d);
      expect(d.deleted).toEqual([]);
      expect((await store.get(T1, s.id))?.status).toBe("provisioning");
    });
  });
});

describe("reapSites — failed sites are claimed before teardown", () => {
  it("a failed site past 24h moves to deleting, keeps its repo 7 days, and leaves the site list", async () => {
    const s = await siteWith("failed", "r1");
    const d = deps([{ tenant_id: T1, site_id: s.id, status: "failed", tenant_slug: "real-co" }]);
    const r = await reapSites(d);
    expect(r.pending).toEqual([s.id]);
    expect(d.deleted).toEqual([]);
    expect((await store.get(T1, s.id))?.status).toBe("deleting");
    expect(providersOf(store, T1, s.id).find((p) => p.kind === "github_repo")?.state).toBe("delete_scheduled");
  });

  it("a site a Retry revived (failed -> building) between listing and teardown is not touched", async () => {
    const s = await siteWith("failed", "r1");
    const d = deps([{ tenant_id: T1, site_id: s.id, status: "failed", tenant_slug: "real-co" }], { runState: async () => "dead" });
    const realGet = d.teardown.store.get.bind(d.teardown.store);
    let first = true;
    d.teardown.store.get = async (t, id) => {
      const row = await realGet(t, id);
      if (first && row) {
        first = false;
        await store.transition(T1, s.id, ["failed"], "building", { last_error: null });
      }
      return row;
    };
    const r = await reapSites(d);
    expect(r.reaped).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ site_id: s.id, reason: "status_changed" });
    expect((await store.get(T1, s.id))?.status).toBe("building");
    expect(providersOf(store, T1, s.id).find((p) => p.kind === "github_repo")?.state).toBe("created");
  });

  it("a later pass over the deleting site purges the repo only once its grace is due, then ends deleted", async () => {
    const s = await siteWith("failed", "r1");
    const cand = [{ tenant_id: T1, site_id: s.id, status: "failed" as const, tenant_slug: "real-co" }];
    await reapSites(deps(cand));
    const realNow = store.now;
    store.now = () => realNow() + 8 * 86_400_000;
    const d2 = deps([{ ...cand[0], status: "deleting" }]);
    const r = await reapSites(d2);
    expect(d2.deleted).toEqual([`praxis-built/${s.label}`]);
    expect(r.reaped).toEqual([s.id]);
    expect((await store.get(T1, s.id))?.status).toBe("deleted");
  });
});

describe("reapSites — a site that went live behind a stopped or failed run", () => {
  async function servingSite(status: SiteStatus, run: string) {
    const s = await siteWith(status, run);
    Object.assign(store.sites.get(s.id)!, {
      live_sha: "abc1234",
      live_deploy_id: "d00000000a-0123abcd",
      live_url: `https://${s.hostname}`,
      updated_at: "2026-09-29T00:00:00Z",
    });
    return s;
  }

  it("a failed site that is serving a deploy is never torn down; it is settled live", async () => {
    const s = await servingSite("failed", "r-failed");
    const d = deps([{ tenant_id: T1, site_id: s.id, status: "failed", tenant_slug: "real-co" }], { runState: async () => "dead" });
    const r = await reapSites(d);
    expect(r.reaped).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(r.skipped).toEqual([{ site_id: s.id, reason: "serving" }]);
    expect(d.deleted).toEqual([]);
    expect(store.sites.get(s.id)).toMatchObject({ status: "live", live_deploy_id: "d00000000a-0123abcd" });
    expect(providersOf(store, T1, s.id).find((p) => p.kind === "github_repo")?.state).toBe("created");
  });

  it.each(["building", "provisioning"] as const)("a stranded %s site behind a halted run that is serving a deploy is never claimed or torn down", async (status) => {
    const s = await servingSite(status, `r-${status}`);
    const claims: string[] = [];
    const d = deps([{ tenant_id: T1, site_id: s.id, status, tenant_slug: "real-co" }], {
      runState: async () => "dead",
      claimStranded: async (tenant_id, site_id) => {
        claims.push(site_id);
        return !!(await store.transition(tenant_id, site_id, [status], "deleting"));
      },
    });
    const r = await reapSites(d);
    expect(claims).toEqual([]);
    expect(r.reaped).toEqual([]);
    expect(r.skipped).toEqual([{ site_id: s.id, reason: "serving" }]);
    expect(d.deleted).toEqual([]);
    expect(store.sites.get(s.id)?.status).toBe("live");
  });

  it("dry-run leaves a serving site's status alone and deletes nothing", async () => {
    const s = await servingSite("failed", "r-dry");
    const d = deps([{ tenant_id: T1, site_id: s.id, status: "failed", tenant_slug: "real-co" }], { enabled: () => false });
    const r = await reapSites(d);
    expect(r.skipped).toEqual([{ site_id: s.id, reason: "serving" }]);
    expect(store.sites.get(s.id)?.status).toBe("failed");
    expect(d.deleted).toEqual([]);
  });

  it("a failed site that never went live is still claimed for cleanup", async () => {
    const s = await siteWith("failed", "r-never");
    const d = deps([{ tenant_id: T1, site_id: s.id, status: "failed", tenant_slug: "real-co" }]);
    await reapSites(d);
    expect(store.sites.get(s.id)?.status).toBe("deleting");
  });
});

describe("reapSites — abandoned-site rails (failed sites)", () => {
  const cand = (site_id: string) => [{ tenant_id: T1, site_id, status: "failed" as const, tenant_slug: "real-co" }];

  it("never takes a failed site whose fresh row is younger than 24h", async () => {
    const s = await siteWith("failed", "r-young");
    store.sites.get(s.id)!.updated_at = "2026-10-01T12:00:00.000Z";
    const d = deps(cand(s.id));
    const r = await reapSites(d);
    expect(r.skipped[0]).toMatchObject({ site_id: s.id, reason: "failed_too_young" });
    expect((await store.get(T1, s.id))?.status).toBe("failed");
    expect(d.deleted).toEqual([]);
  });

  it("never takes a failed site whose build run is still live (paused, can be continued)", async () => {
    const s = await siteWith("failed", "r-paused");
    const seen: Array<string | null> = [];
    const d = deps(cand(s.id), { runState: async (_t, run) => (seen.push(run), "live" as const) });
    const r = await reapSites(d);
    expect(seen).toEqual(["r-paused"]);
    expect(r.skipped[0]).toMatchObject({ site_id: s.id, reason: "run_live" });
    expect((await store.get(T1, s.id))?.status).toBe("failed");
  });

  it("fails closed for a failed site when the run check is unavailable", async () => {
    const s = await siteWith("failed", "r-norun");
    const r = await reapSites(deps(cand(s.id), { runState: undefined }));
    expect(r.skipped[0]).toMatchObject({ site_id: s.id, reason: "run_check_unavailable" });
    expect((await store.get(T1, s.id))?.status).toBe("failed");
  });

  it.each(["failed", "building"] as const)("never tears down a %s site that ever served (live deploy recorded)", async (status) => {
    const s = await siteWith(status, `r-served-${status}`);
    Object.assign(store.sites.get(s.id)!, { live_sha: "a".repeat(40), live_deploy_id: "dep-1" });
    const d = deps([{ tenant_id: T1, site_id: s.id, status, tenant_slug: "real-co" }]);
    const r = await reapSites(d);
    expect(r.skipped[0]).toMatchObject({ site_id: s.id, reason: "serving" });
    expect((await store.get(T1, s.id))?.status).toBe("live");
    expect(d.deleted).toEqual([]);
  });

  it("claims a failed site atomically (site_claim_failed) with the cutoff; a change in between wins", async () => {
    const s = await siteWith("failed", "r-claim");
    const calls: unknown[][] = [];
    const lost = deps(cand(s.id), { claimFailed: async (...a) => (calls.push(a), false) });
    const r = await reapSites(lost);
    expect(calls).toEqual([[T1, s.id, "2026-10-01T00:00:00.000Z", "Cleaned up 24 hours after the build failed."]]);
    expect(r.skipped[0]).toMatchObject({ site_id: s.id, reason: "status_changed" });
    expect((await store.get(T1, s.id))?.status).toBe("failed");
    expect(lost.deleted).toEqual([]);

    const won = deps(cand(s.id), {
      claimFailed: async (_t, id, _c, last_error) => (Object.assign(store.sites.get(id)!, { status: "deleting", last_error }), true),
    });
    expect((await reapSites(won)).pending).toEqual([s.id]);
  });

  it("logs every teardown with its tenant and site ids", async () => {
    const s = await siteWith("failed", "r-log");
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => void lines.push(String(m));
    try {
      await reapSites(deps(cand(s.id)));
    } finally {
      console.log = orig;
    }
    const evts = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.evt === "site_reaper_teardown");
    expect(evts.map((e) => e.outcome)).toEqual(["started", "pending"]);
    for (const e of evts) expect(e).toMatchObject({ tenant_id: T1, site_id: s.id, from_status: "failed" });
  });
});

describe("site reaper kill-switch (INFRA_REAPER_ENABLED)", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.INFRA_REAPER_ENABLED;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.INFRA_REAPER_ENABLED;
    else process.env.INFRA_REAPER_ENABLED = prev;
  });

  it("is LIVE when unset (Ravi 2026-10-02: runs for real from day one)", () => {
    delete process.env.INFRA_REAPER_ENABLED;
    expect(realSiteReaperDeps().enabled()).toBe(true);
  });

  it.each(["1", "true", "yes"])("stays live for %s", (v) => {
    process.env.INFRA_REAPER_ENABLED = v;
    expect(realSiteReaperDeps().enabled()).toBe(true);
  });

  it.each(["0", "false", " FALSE ", "False"])("forces dry-run for %j", (v) => {
    process.env.INFRA_REAPER_ENABLED = v;
    expect(realSiteReaperDeps().enabled()).toBe(false);
  });
});
