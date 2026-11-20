import { describe, expect, it, vi } from "vitest";
import { recordBuiltSiteAddress, skipBuildSetupSteps, startFirstPlanAfterBuild, type BuildFirstPlanDeps } from "../build-first-plan";
import { nextSetupAttempt, setupDraftKey, type SetupDraftRun } from "@/services/growth/setup-draft";
import type { SupabaseClient } from "@supabase/supabase-js";

const T = "11111111-2222-4333-8444-555555555555";
const RUN = "conductor-1";

function world(over: Partial<{ intent: string; setupOn: boolean; refine: boolean; plan: boolean }> = {}) {
  const log: string[] = [];
  const runs: SetupDraftRun[] = [];
  let plan = over.plan ?? false;
  const deps: BuildFirstPlanDeps = {
    buildIntent: async () => over.intent ?? "fresh",
    setupOn: async () => over.setupOn ?? true,
    isRefine: async () => over.refine ?? false,
    skipSetupSteps: vi.fn(async () => {
      log.push("skip");
    }),
    hadPlanOrDraft: async () => plan || runs.length > 0,
    recordWebsite: vi.fn(async () => {
      log.push("website");
    }),
    research: vi.fn(async () => {
      log.push("research");
    }),
    start: vi.fn(async () => {
      log.push("start");
      const key = setupDraftKey(T, 1);
      if (runs.some((r) => r.cron_dedupe_key === key)) return { status: "already" as const, run_id: null };
      runs.push({ id: `run-${runs.length + 1}`, status: "queued", cron_dedupe_key: key, enqueued_at: new Date().toISOString() } as SetupDraftRun);
      return { status: "queued" as const, run_id: runs[runs.length - 1].id };
    }),
  };
  return { deps, log, runs, setPlan: (v: boolean) => (plan = v) };
}

describe("startFirstPlanAfterBuild", () => {
  it("a fresh build that finishes skips the setup steps, saves the site's address, runs the research, then starts the free first draft", async () => {
    const w = world();
    const out = await startFirstPlanAfterBuild(T, RUN, w.deps);
    expect(out).toEqual({ started: true, result: { status: "queued", run_id: "run-1" } });
    expect(w.log).toEqual(["skip", "website", "research", "start"]);
    expect(w.deps.recordWebsite).toHaveBeenCalledWith(T, RUN);
    expect(w.runs).toHaveLength(1);
  });

  it("a second build finish (or a second tick) never starts a second draft", async () => {
    const w = world();
    await startFirstPlanAfterBuild(T, RUN, w.deps);
    const again = await startFirstPlanAfterBuild(T, "conductor-2", w.deps);
    expect(again).toEqual({ started: false, reason: "already" });
    expect(w.deps.start).toHaveBeenCalledTimes(1);
    expect(w.runs).toHaveLength(1);
  });

  it("the server started first: the page's own start gets the same run, not a new attempt", async () => {
    const w = world();
    await startFirstPlanAfterBuild(T, RUN, w.deps);
    expect(nextSetupAttempt(T, w.runs, false, false, false)).toEqual({ existing: "run-1" });
  });

  it("the page started first: the server does not start anything and does not research", async () => {
    const w = world();
    w.runs.push({ id: "page-run", status: "running", cron_dedupe_key: setupDraftKey(T, 1), enqueued_at: new Date().toISOString() } as SetupDraftRun);
    expect(await startFirstPlanAfterBuild(T, RUN, w.deps)).toEqual({ started: false, reason: "already" });
    expect(w.deps.start).not.toHaveBeenCalled();
    expect(w.deps.research).not.toHaveBeenCalled();
    expect(w.deps.recordWebsite).not.toHaveBeenCalled();
  });

  it("the address could not be saved: the research and the draft still run", async () => {
    const w = world();
    (w.deps.recordWebsite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("sites read failed"));
    const out = await startFirstPlanAfterBuild(T, RUN, w.deps);
    expect(out.started).toBe(true);
    expect(w.log).toEqual(["skip", "research", "start"]);
  });

  it("a workspace that already has a plan is left alone after its steps are marked", async () => {
    const w = world({ plan: true });
    expect(await startFirstPlanAfterBuild(T, RUN, w.deps)).toEqual({ started: false, reason: "already" });
    expect(w.deps.start).not.toHaveBeenCalled();
  });

  it("the growth flow (an existing website) is never touched", async () => {
    const w = world({ intent: "existing" });
    expect(await startFirstPlanAfterBuild(T, RUN, w.deps)).toEqual({ started: false, reason: "not_fresh" });
    expect(w.deps.skipSetupSteps).not.toHaveBeenCalled();
    expect(w.deps.start).not.toHaveBeenCalled();
  });

  it("an edit (refine) build finishing starts nothing", async () => {
    const w = world({ refine: true });
    expect(await startFirstPlanAfterBuild(T, RUN, w.deps)).toEqual({ started: false, reason: "refine" });
    expect(w.deps.skipSetupSteps).not.toHaveBeenCalled();
    expect(w.deps.recordWebsite).not.toHaveBeenCalled();
  });

  it("setup switched off starts nothing", async () => {
    const w = world({ setupOn: false });
    expect(await startFirstPlanAfterBuild(T, RUN, w.deps)).toEqual({ started: false, reason: "setup_off" });
    expect(w.deps.start).not.toHaveBeenCalled();
  });

  it("a research failure does not start a draft without research; the watch picks it up", async () => {
    const w = world();
    (w.deps.research as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("vendor down"));
    await expect(startFirstPlanAfterBuild(T, RUN, w.deps)).rejects.toThrow("vendor down");
    expect(w.deps.start).not.toHaveBeenCalled();
    expect(w.deps.skipSetupSteps).toHaveBeenCalledTimes(1);
  });
});

describe("recordBuiltSiteAddress", () => {
  const live = { id: "site-1", status: "live", live_url: "https://acme.zaviagent.com", live_deploy_id: "d1" };
  const run = (site: { id: string; status: string; live_url?: string | null; live_deploy_id?: string | null } | null) => {
    const record = vi.fn(async () => "recorded");
    return { record, out: recordBuiltSiteAddress(T, RUN, { siteByRun: async () => site, record }) };
  };

  it("a live site's address is handed to the one writer, for this run's site", async () => {
    const r = run(live);
    expect(await r.out).toBe("recorded");
    expect(r.record).toHaveBeenCalledWith({ tenant_id: T, site_id: "site-1", url: "https://acme.zaviagent.com" });
  });

  it("an activated site whose status has not caught up yet is still saved", async () => {
    const r = run({ ...live, status: "building" });
    expect(await r.out).toBe("recorded");
    expect(r.record).toHaveBeenCalledTimes(1);
  });

  it("a failed or deleted site, or one with no activated deploy, is not saved", async () => {
    for (const site of [{ ...live, status: "failed" }, { ...live, status: "deleting" }, { ...live, live_url: null }, { ...live, live_deploy_id: null }]) {
      const r = run(site);
      expect(await r.out).toBe("not_live");
      expect(r.record).not.toHaveBeenCalled();
    }
  });

  it("a run with no site saves nothing", async () => {
    const r = run(null);
    expect(await r.out).toBe("no_site");
    expect(r.record).not.toHaveBeenCalled();
  });
});

describe("skipBuildSetupSteps", () => {
  function fakeSvc(failOn?: string) {
    const calls: Array<{ op: string; values: unknown; filters: Array<[string, string, unknown]> }> = [];
    const svc = {
      from(table: string) {
        expect(table).toBe("tenant_first_run_progress");
        return {
          upsert(values: unknown, opts: unknown) {
            calls.push({ op: "upsert", values: { values, opts }, filters: [] });
            return Promise.resolve({ error: failOn === "upsert" ? { message: "boom" } : null });
          },
          update(values: Record<string, unknown>) {
            const entry = { op: "update", values, filters: [] as Array<[string, string, unknown]> };
            calls.push(entry);
            const chain = {
              eq(col: string, v: unknown) {
                entry.filters.push(["eq", col, v]);
                return chain;
              },
              is(col: string, v: unknown) {
                entry.filters.push(["is", col, v]);
                const failing = failOn && col.startsWith(failOn);
                return Promise.resolve({ error: failing ? { message: "boom" } : null });
              },
            };
            return chain;
          },
        };
      },
    } as unknown as SupabaseClient;
    return { svc, calls };
  }

  it("marks both steps skipped only where the founder has not already finished them", async () => {
    const { svc, calls } = fakeSvc();
    await skipBuildSetupSteps(svc, T);
    expect(calls[0]).toMatchObject({ op: "upsert", values: { values: { tenant_id: T }, opts: { onConflict: "tenant_id", ignoreDuplicates: true } } });
    expect(calls[1].values).toMatchObject({ setup_docs_skipped: true });
    expect(calls[1].filters).toEqual([["eq", "tenant_id", T], ["is", "setup_docs_at", null]]);
    expect(calls[2].values).toMatchObject({ setup_connectors_skipped: true });
    expect(calls[2].filters).toEqual([["eq", "tenant_id", T], ["is", "setup_connectors_at", null]]);
    expect(Object.keys(calls[3].values as object)).toEqual(["setup_done_at", "updated_at"]);
    expect(calls[3].filters).toEqual([["eq", "tenant_id", T], ["is", "setup_done_at", null]]);
  });

  it("a failed write throws so the conductor logs it instead of claiming the plan started", async () => {
    const { svc } = fakeSvc("setup_connectors");
    await expect(skipBuildSetupSteps(svc, T)).rejects.toThrow("setup connectors skip failed");
  });
});
