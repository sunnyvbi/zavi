import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runs: [] as Array<{ id: string; tenant_id: string; status: string | null }>,
  reads: [] as Array<{ table: string; columns: unknown; filters: Record<string, unknown> }>,
  failRead: null as null | string,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let columns: unknown;
      type RunQuery = {
        select: (c: unknown) => RunQuery;
        eq: (k: string, v: unknown) => RunQuery;
        maybeSingle: () => Promise<{ data: { status: string | null } | null; error: { message: string } | null }>;
      };
      const b: RunQuery = {
        select: (c: unknown) => {
          columns = c;
          return b;
        },
        eq: (k: string, v: unknown) => {
          filters[k] = v;
          return b;
        },
        maybeSingle: async () => {
          h.reads.push({ table, columns, filters: { ...filters } });
          if (h.failRead) return { data: null, error: { message: h.failRead } };
          if (table !== "conductor_runs") return { data: null, error: null };
          const row = h.runs.find((r) => Object.entries(filters).every(([k, v]) => (r as Record<string, unknown>)[k] === v));
          return { data: row ? { status: row.status } : null, error: null };
        },
      };
      return b;
    },
  }),
}));
vi.mock("../teardown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../teardown")>();
  return { ...actual, realSiteTeardownDeps: () => ({}) as ReturnType<typeof actual.realSiteTeardownDeps> };
});

import { realSiteReaperDeps, reapSites, type SiteReaperDeps } from "../site-reaper";
import { fakeRepo, fakeStore, fakeSupabase, providersOf, teardownDeps, type FakeStore } from "./site-fakes";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const OLD = "2026-09-01T00:00:00.000Z";

let store: FakeStore;
const runState = () => realSiteReaperDeps().runState!;

async function buildingSite(run: string | null, name: string) {
  const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: run ?? `placeholder-${name}`, company_name: name, started_by_user_id: null });
  await store.claimProvider(T1, s.id, "github_repo", { name: s.label, owner: "praxis-built" });
  await store.setProviderState(T1, s.id, "github_repo", "created");
  await store.transition(T1, s.id, ["provisioning"], "building");
  const row = store.sites.get(s.id)!;
  row.updated_at = OLD;
  if (run === null) row.root_conductor_run_id = null;
  return s;
}

function deps(site_ids: string[]): SiteReaperDeps & { deleted: string[] } {
  const repo = fakeRepo();
  return {
    candidates: async () => site_ids.map((site_id) => ({ tenant_id: T1, site_id, status: "building" as const, tenant_slug: "real-co" })),
    teardown: teardownDeps(store, repo, fakeSupabase(store)),
    runState: runState(),
    enabled: () => true,
    envScope: () => ({ allowed: true }),
    now: () => new Date("2026-10-02T00:00:00Z"),
    deleted: repo.deleted,
  };
}

beforeEach(() => {
  store = fakeStore();
  h.runs = [];
  h.reads = [];
  h.failRead = null;
});

describe("the reaper's real run-state read", () => {
  it.each([
    ["provisioning", "live"],
    ["active", "live"],
    ["paused", "live"],
    ["done", "done"],
    ["failed", "dead"],
    ["halted", "dead"],
    ["cancelled", "dead"],
    ["", "dead"],
  ])("a run in status %j reads as %s", async (status, expected) => {
    h.runs = [{ id: "run-1", tenant_id: T1, status }];
    expect(await runState()(T1, "run-1")).toBe(expected);
  });

  it("a run with a null status, a run that vanished and a site with no run all read as dead", async () => {
    h.runs = [{ id: "run-null", tenant_id: T1, status: null }];
    expect(await runState()(T1, "run-null")).toBe("dead");
    expect(await runState()(T1, "run-missing")).toBe("dead");
    h.reads = [];
    expect(await runState()(T1, null)).toBe("dead");
    expect(h.reads).toEqual([]);
  });

  it("reads only this tenant's run: another tenant's done run with the same id is not seen", async () => {
    h.runs = [{ id: "run-1", tenant_id: T2, status: "done" }];
    expect(await runState()(T1, "run-1")).toBe("dead");
    expect(h.reads).toEqual([{ table: "conductor_runs", columns: "status", filters: { tenant_id: T1, id: "run-1" } }]);
    expect(await runState()(T2, "run-1")).toBe("done");
  });

  it("a failed read throws instead of answering dead", async () => {
    h.failRead = "connection reset";
    await expect(runState()(T1, "run-1")).rejects.toThrow(/conductor_runs read failed: connection reset/);
  });
});

describe("reapSites with the real run-state read", () => {
  it("keeps the finished build and clears the failed, vanished, run-less and foreign-run sites beside it", async () => {
    const finished = await buildingSite("run-done", "Finished");
    const failed = await buildingSite("run-failed", "Failed");
    const vanished = await buildingSite("run-vanished", "Vanished");
    const runless = await buildingSite(null, "Runless");
    const foreign = await buildingSite("run-foreign", "Foreign");
    h.runs = [
      { id: "run-done", tenant_id: T1, status: "done" },
      { id: "run-failed", tenant_id: T1, status: "failed" },
      { id: "run-foreign", tenant_id: T2, status: "done" },
    ];
    const d = deps([finished.id, failed.id, vanished.id, runless.id, foreign.id]);
    const r = await reapSites(d);

    expect(r.skipped).toEqual([{ site_id: finished.id, reason: "build_finished" }]);
    expect(r.pending.sort()).toEqual([failed.id, vanished.id, runless.id, foreign.id].sort());
    expect(d.deleted).toEqual([]);
    expect((await store.get(T1, finished.id))?.status).toBe("building");
    expect(providersOf(store, T1, finished.id).map((p) => p.state)).toEqual(["created"]);
    for (const s of [failed, vanished, runless, foreign]) {
      expect((await store.get(T1, s.id))?.status, s.label).toBe("deleting");
      expect(providersOf(store, T1, s.id).map((p) => p.state), s.label).toEqual(["delete_scheduled"]);
    }
  });

  it.each(["provisioning", "active", "paused"])("a building site behind a %s run is left alone as before", async (status) => {
    const s = await buildingSite("run-live", "Live");
    h.runs = [{ id: "run-live", tenant_id: T1, status }];
    const d = deps([s.id]);
    const r = await reapSites(d);
    expect(r.skipped).toEqual([{ site_id: s.id, reason: "run_live" }]);
    expect((await store.get(T1, s.id))?.status).toBe("building");
  });

  it("an unreadable run never costs a site: the read error skips it", async () => {
    const s = await buildingSite("run-done", "Finished");
    h.runs = [{ id: "run-done", tenant_id: T1, status: "done" }];
    h.failRead = "statement timeout";
    const d = deps([s.id]);
    const r = await reapSites(d);
    expect(r.reaped).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/^error: conductor_runs read failed: statement timeout/);
    expect((await store.get(T1, s.id))?.status).toBe("building");
    expect(providersOf(store, T1, s.id).map((p) => p.state)).toEqual(["created"]);
  });
});
