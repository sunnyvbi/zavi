import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tenantQueries: Array<Record<string, unknown>> = [];
let nextRuns: Array<{ id: string; created_at: string }> = [];
let markRow: { goal_graph: unknown; updated_at: string } | null = null;
let markWrites: Array<Array<{ id: string }>> = [];
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    const q: Record<string, unknown> = { filters: [] as unknown[] };
    tenantQueries.push(q);
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["from", "select", "eq", "gt", "neq", "order", "update", "is"]) {
      chain[m] = (...a: unknown[]) => {
        (q.filters as unknown[]).push([m, ...a]);
        return chain;
      };
    }
    chain.limit = async () => ({ data: nextRuns, error: null });
    chain.maybeSingle = async () => ({ data: markRow, error: null });
    chain.then = (...a: unknown[]) => (a[0] as (v: unknown) => void)({ data: markWrites.shift() ?? [], error: null });
    return chain;
  },
}));

import { newSiteDeployId } from "@/services/hosting/site-publish";
import {
  __resetSiteVersionJobs,
  ERR_NEVER_PUBLISHED,
  ERR_NO_COMMIT,
  ERR_PREVIEW_FAILED,
  ERR_UNREADABLE,
  PREWARM_SKIPPED,
  realSiteVersionDeps,
  siteVersionErrorRetryable,
  siteVersionJob,
  siteVersionPreview,
  type SiteVersionDeps,
  type SiteVersionMark,
  type SiteVersionRun,
} from "../site-versions";
import type { SiteRow } from "../contract";

const T = "11111111-1111-4111-8111-111111111111";
const SITE = "cdeba3f4-8e92-4c9d-82ef-4f5766df2b0e";
const REPO = "Zavi-Latest-Build/yoga-studio-b896bdf2-cdeba3";
const BUILD_SHA = "1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e";
const EDIT_SHA = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00";
const STAGED = newSiteDeployId(Date.parse("2026-10-06T07:10:00Z"));

const site = (patch: Partial<SiteRow> = {}) =>
  ({ id: SITE, tenant_id: T, status: "building", live_sha: null, live_deploy_id: null, github_full_name: REPO, root_conductor_run_id: "build-1", ...patch }) as SiteRow;

const unpublishedGraph = [
  { id: "provision", status: "done", payload: { stage: "provision", site_id: SITE } },
  { id: "build", status: "done", payload: { stage: "build", site_id: SITE } },
];

const unpublishedBuild: SiteVersionRun = {
  id: "build-1",
  created_at: "2026-10-06T06:17:02.299Z",
  status: "done",
  goal_graph: unpublishedGraph,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(opts: { runs?: SiteVersionRun[]; sha?: string | null; firstPublish?: SiteVersionRun | null; stored?: string[]; hold?: (input: { run_id: string; mark: SiteVersionMark; while_starting?: boolean }) => boolean } = {}) {
  const held: Array<() => void> = [];
  const runs = [...(opts.runs ?? [unpublishedBuild])];
  const stored = new Set(opts.stored ?? []);
  const stages: Array<ReturnType<typeof deferred<{ deploy_id: string }>>> = [];
  const minted: string[] = [];
  const deps: SiteVersionDeps = {
    loadRun: vi.fn(async (t, id) => (t === T ? (runs.find((r) => r.id === id) ?? null) : null)),
    loadFirstPublish: vi.fn(async () => opts.firstPublish ?? null),
    changedBetween: vi.fn(async () => false),
    loadSite: vi.fn(async (_t, id) => (id === SITE ? site() : null)),
    hasDeploy: vi.fn(async ({ deploy_id }) => stored.has(deploy_id)),
    versionPreviewUrl: vi.fn(async ({ deploy_id }) => {
      minted.push(deploy_id);
      return { url: `https://yoga.zaviagent.com/__zavi_preview/${deploy_id}/?t=x&zavi_embed=1`, expires_at: "2026-10-06T08:00:00.000Z" };
    }),
    versionSha: vi.fn(async () => (opts.sha === undefined ? BUILD_SHA : opts.sha)),
    stageVersion: vi.fn(async () => {
      const d = deferred<{ deploy_id: string }>();
      stages.push(d);
      return d.promise;
    }),
    claimRun: vi.fn(async ({ tenant_id, run_id, expect, mark, while_starting }) => {
      await Promise.resolve();
      if (opts.hold?.({ run_id, mark, while_starting })) await new Promise<void>((r) => held.push(r));
      const i = runs.findIndex((r) => r.id === run_id);
      if (tenant_id !== T || i < 0) return { won: false as const, mark: null };
      const [first, ...rest] = runs[i].goal_graph as Array<{ payload?: Record<string, unknown> }>;
      const current = (first.payload?.version_preview ?? null) as SiteVersionMark | null;
      if ((current?.claim ?? null) !== expect) return { won: false as const, mark: current };
      if (while_starting && (current?.status !== "starting" || current.deploy_id !== null)) return { won: false as const, mark: current };
      runs[i] = { ...runs[i], goal_graph: [{ ...first, payload: { ...first.payload, version_preview: mark } }, ...rest] };
      return { won: true as const };
    }),
  };
  const markOn = (id = "build-1") => ((runs.find((r) => r.id === id)!.goal_graph as Array<{ payload?: Record<string, unknown> }>)[0].payload?.version_preview ?? null) as SiteVersionMark | null;
  const finishStage = async (deploy_id: string) => {
    stored.add(deploy_id);
    stages[stages.length - 1].resolve({ deploy_id });
    await new Promise((r) => setTimeout(r, 0));
  };
  const failStage = async () => {
    stages[stages.length - 1].reject(new Error("npm run build failed (exit 1)"));
    await new Promise((r) => setTimeout(r, 0));
  };
  const finishAt = async (n: number, deploy_id: string) => {
    stored.add(deploy_id);
    stages[n].resolve({ deploy_id });
    await new Promise((r) => setTimeout(r, 0));
  };
  const releaseHeartbeats = async () => {
    held.splice(0).forEach((r) => r());
    await new Promise((r) => setTimeout(r, 0));
  };
  const patchMark = (id: string, patch: Partial<SiteVersionMark>) => {
    const i = runs.findIndex((r) => r.id === id);
    const [first, ...rest] = runs[i].goal_graph as Array<{ payload?: Record<string, unknown> }>;
    runs[i] = { ...runs[i], goal_graph: [{ ...first, payload: { ...first.payload, version_preview: { ...(first.payload?.version_preview as object), ...patch } } }, ...rest] };
  };
  return { deps, stages, minted, finishStage, failStage, finishAt, markOn, held, releaseHeartbeats, patchMark };
}

beforeEach(() => {
  __resetSiteVersionJobs?.();
  tenantQueries.length = 0;
  nextRuns = [];
  markRow = null;
  markWrites = [];
});

describe("a version that was never published is built from its own commit", () => {
  it("starts building that exact commit instead of refusing with never published, then opens it", async () => {
    const h = harness();
    const first = await siteVersionPreview(T, "build-1", h.deps);
    expect(first).toEqual({ kind: "starting" });
    expect(first).not.toEqual({ kind: "unavailable", error: ERR_NEVER_PUBLISHED });
    expect(h.deps.versionSha).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T, run: unpublishedBuild }));
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
    expect(h.deps.stageVersion).toHaveBeenCalledWith({ tenant_id: T, site_id: SITE, sha: BUILD_SHA });

    expect(await siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "starting", url: null });
    await h.finishStage(STAGED);
    expect(await siteVersionJob(T, "build-1", h.deps)).toMatchObject({
      status: "live",
      url: `https://yoga.zaviagent.com/__zavi_preview/${STAGED}/?t=x&zavi_embed=1`,
      expires_at: "2026-10-06T08:00:00.000Z",
    });
    expect(h.minted).toEqual([STAGED]);
  });

  it("opening it again reuses the built copy, and repeated clicks while it builds start one build", async () => {
    const h = harness();
    await siteVersionPreview(T, "build-1", h.deps);
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
    await h.finishStage(STAGED);
    expect(await siteVersionPreview(T, "build-1", h.deps)).toMatchObject({ kind: "live", deploy_id: STAGED });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
  });

  it("a built copy that cleanup deleted is built again, not shown as a broken link", async () => {
    const h = harness();
    await siteVersionPreview(T, "build-1", h.deps);
    await h.finishStage(STAGED);
    (h.deps.hasDeploy as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(2);
  });

  it("a failed build is a retryable error, and Try again really builds again", async () => {
    const h = harness();
    await siteVersionPreview(T, "build-1", h.deps);
    await h.failStage();
    const dead = await siteVersionJob(T, "build-1", h.deps);
    expect(dead).toMatchObject({ status: "dead", error: ERR_PREVIEW_FAILED, retryable: true });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(2);
    await h.finishStage(STAGED);
    expect(await siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "live" });
  });

  it("a version with no commit says so honestly, starts nothing, and is not retryable", async () => {
    const h = harness({ sha: null });
    const out = await siteVersionPreview(T, "build-1", h.deps);
    expect(out).toEqual({ kind: "unavailable", error: ERR_NO_COMMIT });
    expect(siteVersionErrorRetryable(ERR_NO_COMMIT)).toBe(false);
    expect(siteVersionErrorRetryable(ERR_NEVER_PUBLISHED)).toBe(false);
    expect(siteVersionErrorRetryable(ERR_PREVIEW_FAILED)).toBe(true);
    expect(h.deps.stageVersion).not.toHaveBeenCalled();
    expect(await siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "dead", url: null });
  });

  it("a malformed commit from the lookup is treated as no commit, never handed to the build", async () => {
    const h = harness({ sha: "main; rm -rf /" });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_NO_COMMIT });
    expect(h.deps.stageVersion).not.toHaveBeenCalled();
  });

  it("a run that did not finish keeps saying it was never published and builds nothing", async () => {
    const h = harness({ runs: [{ ...unpublishedBuild, status: "failed" }] });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_NEVER_PUBLISHED });
    expect(h.deps.versionSha).not.toHaveBeenCalled();
    expect(h.deps.stageVersion).not.toHaveBeenCalled();
  });

  it("a published version still opens its stored publish and never builds anything", async () => {
    const published = newSiteDeployId(Date.parse("2026-10-06T06:30:00Z"));
    const firstPublish: SiteVersionRun = {
      id: "publish-1",
      created_at: "2026-10-06T06:25:00.000Z",
      status: "done",
      goal_graph: [{ id: "site-republish", status: "done", payload: { stage: "deploy", refine_mode: true, republish: true, site_id: SITE, parent_conductor_run_id: "build-1", site_live_deploy_id: published } }],
    };
    const h = harness({ firstPublish, stored: [published] });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toMatchObject({ kind: "live", deploy_id: published });
    expect(h.deps.versionSha).not.toHaveBeenCalled();
    expect(h.deps.stageVersion).not.toHaveBeenCalled();
  });
});

describe("a preview job survives losing the process that started it", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("another worker answering the poll reports the build in progress, then the built copy, never the legacy job", async () => {
    const h = harness();
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    __resetSiteVersionJobs();
    expect(await siteVersionJob(T, "build-1", h.deps)).toEqual({ status: "starting", url: null, expires_at: null, error: null, retryable: true });
    await h.finishStage(STAGED);
    __resetSiteVersionJobs();
    expect(await siteVersionJob(T, "build-1", h.deps)).toEqual({
      status: "live",
      url: `https://yoga.zaviagent.com/__zavi_preview/${STAGED}/?t=x&zavi_embed=1`,
      expires_at: "2026-10-06T08:00:00.000Z",
      error: null,
      retryable: true,
    });
    expect(h.deps.hasDeploy).toHaveBeenCalledWith({ tenant_id: T, site_id: SITE, deploy_id: STAGED });
  });

  it("a second click on another worker while the build runs starts no second build", async () => {
    const h = harness();
    await siteVersionPreview(T, "build-1", h.deps);
    __resetSiteVersionJobs();
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
    await h.finishStage(STAGED);
    __resetSiteVersionJobs();
    expect(await siteVersionPreview(T, "build-1", h.deps)).toMatchObject({ kind: "live", deploy_id: STAGED });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
  });

  it("a build lost to a restart is reported failed once its deadline passes, and Try again builds again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T07:00:00.000Z"));
    const h = harness();
    await siteVersionPreview(T, "build-1", h.deps);
    __resetSiteVersionJobs();
    vi.setSystemTime(new Date("2026-10-06T07:01:00.000Z"));
    expect(await siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "starting" });
    vi.setSystemTime(new Date("2026-10-06T07:21:00.000Z"));
    expect(await siteVersionJob(T, "build-1", h.deps)).toEqual({ status: "dead", url: null, expires_at: null, error: ERR_PREVIEW_FAILED, retryable: true });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(2);
  });

  it("a failed build on another worker is reported failed, not left polling", async () => {
    const h = harness();
    await siteVersionPreview(T, "build-1", h.deps);
    await h.failStage();
    __resetSiteVersionJobs();
    expect(await siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "dead", error: ERR_PREVIEW_FAILED, retryable: true });
  });

  it("another tenant asking about the run sees nothing and the run is never read unscoped", async () => {
    const h = harness();
    await siteVersionPreview(T, "build-1", h.deps);
    __resetSiteVersionJobs();
    const other = "22222222-2222-4222-8222-222222222222";
    expect(await siteVersionJob(other, "build-1", h.deps)).toBeNull();
    expect(h.deps.loadRun).toHaveBeenLastCalledWith(other, "build-1");
  });

  it("the claim is written onto this tenant's finished run only, guarded by the claim it expects and the run's updated_at", async () => {
    const mark: SiteVersionMark = { status: "starting", site_id: SITE, sha: BUILD_SHA, deploy_id: null, error: null, started_at: "2026-10-06T07:00:00.000Z", claim: "c-new", heartbeat_at: "2026-10-06T07:00:00.000Z" };
    markRow = { goal_graph: unpublishedBuild.goal_graph, updated_at: "2026-10-06T06:40:00.000Z" };
    markWrites = [[], [{ id: "build-1" }]];
    expect(await realSiteVersionDeps.claimRun!({ tenant_id: T, run_id: "build-1", expect: null, mark })).toEqual({ won: true });
    const writes = tenantQueries.filter((q) => (q.filters as unknown[][]).some((f) => f[0] === "update"));
    expect(writes).toHaveLength(2);
    for (const q of tenantQueries) {
      const filters = q.filters as unknown[][];
      expect(filters).toContainEqual(["eq", "tenant_id", T]);
      expect(filters).toContainEqual(["eq", "id", "build-1"]);
      expect(filters).toContainEqual(["eq", "status", "done"]);
    }
    expect(writes[1].filters as unknown[][]).toContainEqual(["eq", "updated_at", "2026-10-06T06:40:00.000Z"]);
    expect(writes[1].filters as unknown[][]).toContainEqual(["is", "goal_graph->0->payload->version_preview->>claim", null]);
    const update = (writes[1].filters as unknown[][]).find((f) => f[0] === "update")![1] as { goal_graph: Array<{ payload: Record<string, unknown> }> };
    expect(update.goal_graph[0].payload).toEqual({ stage: "provision", site_id: SITE, version_preview: mark });
    expect(update.goal_graph[1]).toEqual(unpublishedGraph[1]);
    expect(Object.keys(update)).toEqual(["goal_graph"]);
  });

  it("a claim another worker already replaced is never overwritten", async () => {
    const theirs: SiteVersionMark = { status: "starting", site_id: SITE, sha: BUILD_SHA, deploy_id: null, error: null, started_at: "2026-10-06T07:00:00.000Z", claim: "c-theirs", heartbeat_at: "2026-10-06T07:00:00.000Z" };
    markRow = { goal_graph: [{ ...unpublishedGraph[0], payload: { stage: "provision", site_id: SITE, version_preview: theirs } }], updated_at: "2026-10-06T06:40:00.000Z" };
    const mine = { ...theirs, claim: "c-mine", status: "live" as const, deploy_id: STAGED };
    expect(await realSiteVersionDeps.claimRun!({ tenant_id: T, run_id: "build-1", expect: "c-mine", mark: mine })).toEqual({ won: false, mark: theirs });
    expect(tenantQueries.some((q) => (q.filters as unknown[][]).some((f) => f[0] === "update"))).toBe(false);
    markRow = { goal_graph: markRow.goal_graph, updated_at: "2026-10-06T06:40:00.000Z" };
    markWrites = [[{ id: "build-1" }]];
    expect(await realSiteVersionDeps.claimRun!({ tenant_id: T, run_id: "build-1", expect: "c-theirs", mark: { ...theirs, heartbeat_at: "2026-10-06T07:00:30.000Z" } })).toEqual({ won: true });
    const write = tenantQueries.find((q) => (q.filters as unknown[][]).some((f) => f[0] === "update"))!;
    expect(write.filters as unknown[][]).toContainEqual(["eq", "goal_graph->0->payload->version_preview->>claim", "c-theirs"]);
  });

  it("a stale heartbeat is failed right away on a fresh process, and the next click reclaims it and starts exactly one build", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T07:00:00.000Z"));
    const h = harness();
    await siteVersionPreview(T, "build-1", h.deps);
    const first = h.markOn()!;
    vi.resetModules();
    const fresh = await import("../site-versions");
    vi.setSystemTime(new Date("2026-10-06T07:01:30.000Z"));
    expect(await fresh.siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "starting" });
    vi.setSystemTime(new Date("2026-10-06T07:02:30.000Z"));
    expect(await fresh.siteVersionJob(T, "build-1", h.deps)).toEqual({ status: "dead", url: null, expires_at: null, error: ERR_PREVIEW_FAILED, retryable: true });
    const [a, b] = await Promise.all([fresh.siteVersionPreview(T, "build-1", h.deps), fresh.siteVersionPreview(T, "build-1", h.deps)]);
    expect([a, b]).toEqual([{ kind: "starting" }, { kind: "starting" }]);
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(2);
    expect(h.markOn()).toMatchObject({ status: "starting", deploy_id: null });
    expect(h.markOn()!.claim).not.toBe(first.claim);
  });

  it("two clicks on two workers at once start exactly one build, and the loser reports the winner's build in progress", async () => {
    const h = harness();
    vi.resetModules();
    const workerA = await import("../site-versions");
    vi.resetModules();
    const workerB = await import("../site-versions");
    const [a, b] = await Promise.all([workerA.siteVersionPreview(T, "build-1", h.deps), workerB.siteVersionPreview(T, "build-1", h.deps)]);
    expect([a, b]).toEqual([{ kind: "starting" }, { kind: "starting" }]);
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
    expect(await workerB.siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "starting" });
    await h.finishStage(STAGED);
    expect(await workerB.siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "live", url: expect.stringContaining(STAGED) });
  });

  it("a late finish from a reclaimed attempt cannot overwrite the new claim", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T07:00:00.000Z"));
    const h = harness();
    vi.resetModules();
    const workerA = await import("../site-versions");
    vi.resetModules();
    const workerB = await import("../site-versions");
    await workerA.siteVersionPreview(T, "build-1", h.deps);
    vi.setSystemTime(new Date("2026-10-06T07:03:00.000Z"));
    expect(await workerB.siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(2);
    const reclaimed = h.markOn()!;
    const LATE = newSiteDeployId(Date.parse("2026-10-06T07:04:00Z"));
    await h.finishAt(0, LATE);
    expect(h.markOn()).toEqual(reclaimed);
    vi.resetModules();
    const workerC = await import("../site-versions");
    expect(await workerC.siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "starting" });
    await h.finishAt(1, STAGED);
    expect(h.markOn()).toMatchObject({ status: "live", deploy_id: STAGED, claim: reclaimed.claim });
  });

  it("the build's process keeps its heartbeat fresh so a long build is never mistaken for a lost one", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-06T07:00:00.000Z"));
    const h = harness();
    await siteVersionPreview(T, "build-1", h.deps);
    const claim = h.markOn()!.claim;
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(30_000);
    expect(h.markOn()).toMatchObject({ status: "starting", claim, heartbeat_at: "2026-10-06T07:05:00.000Z" });
    vi.resetModules();
    const fresh = await import("../site-versions");
    expect(await fresh.siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "starting" });
  });

  it("a claim that cannot be recorded fails closed: no build starts, and the answer is retryable", async () => {
    const h = harness();
    (h.deps.claimRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("conductor_runs write failed: connection reset"));
    const out = await siteVersionPreview(T, "build-1", h.deps);
    expect(out).toEqual({ kind: "unavailable", error: ERR_UNREADABLE });
    expect(siteVersionErrorRetryable(ERR_UNREADABLE)).toBe(true);
    expect(h.deps.stageVersion).not.toHaveBeenCalled();
    expect(h.markOn()).toBeNull();
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
  });

  it("a heartbeat that lands after the build finished never turns the finished record back into starting", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-06T07:00:00.000Z"));
    const h = harness({ hold: ({ mark, while_starting }) => while_starting === true && mark.status === "starting" });
    await siteVersionPreview(T, "build-1", h.deps);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.held).toHaveLength(1);
    await h.finishStage(STAGED);
    expect(h.markOn()).toMatchObject({ status: "live", deploy_id: STAGED });
    await h.releaseHeartbeats();
    expect(h.markOn()).toMatchObject({ status: "live", deploy_id: STAGED });
    expect(h.deps.claimRun).toHaveBeenCalledWith(expect.objectContaining({ while_starting: true, mark: expect.objectContaining({ status: "starting" }) }));
    vi.resetModules();
    const fresh = await import("../site-versions");
    expect(await fresh.siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "live" });
  });

  it("a deadline failure that lands after the build finished never erases the finished deploy", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-06T07:00:00.000Z"));
    const h = harness({ hold: ({ mark }) => mark.status === "dead" });
    await siteVersionPreview(T, "build-1", h.deps);
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 1);
    expect(h.held).toHaveLength(1);
    (h.deps.hasDeploy as ReturnType<typeof vi.fn>).mockImplementation(async ({ deploy_id }: { deploy_id: string }) => deploy_id === STAGED);
    h.stages[0].resolve({ deploy_id: STAGED });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.markOn()).toMatchObject({ status: "live", deploy_id: STAGED });
    h.held.splice(0).forEach((r) => r());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.markOn()).toMatchObject({ status: "live", deploy_id: STAGED, error: null });
    expect(h.deps.claimRun).toHaveBeenCalledWith(expect.objectContaining({ while_starting: true, mark: expect.objectContaining({ status: "dead" }) }));
    expect(h.deps.claimRun).toHaveBeenCalledWith(expect.objectContaining({ while_starting: true, mark: expect.objectContaining({ status: "live" }) }));
    vi.resetModules();
    const fresh = await import("../site-versions");
    expect(await fresh.siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "live", url: expect.stringContaining(STAGED) });
  });

  it("a run whose join is recorded only after the shared build finished still ends live", async () => {
    const second: SiteVersionRun = { ...unpublishedBuild, id: "build-2", created_at: "2026-10-06T06:40:00.000Z" };
    const h = harness({ runs: [unpublishedBuild, second], hold: ({ run_id, while_starting }) => run_id === "build-2" && !while_starting });
    await siteVersionPreview(T, "build-1", h.deps);
    const joining = siteVersionPreview(T, "build-2", h.deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.held).toHaveLength(1);
    await h.finishStage(STAGED);
    expect(h.markOn("build-1")).toMatchObject({ status: "live", deploy_id: STAGED });
    h.held.splice(0).forEach((r) => r());
    await joining;
    await new Promise((r) => setTimeout(r, 0));
    expect(h.markOn("build-2")).toMatchObject({ status: "live", deploy_id: STAGED, sha: BUILD_SHA });
    vi.resetModules();
    const fresh = await import("../site-versions");
    expect(await fresh.siteVersionJob(T, "build-2", h.deps)).toMatchObject({ status: "live", url: expect.stringContaining(STAGED) });
    expect(await fresh.siteVersionPreview(T, "build-2", h.deps)).toMatchObject({ kind: "live", deploy_id: STAGED });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
  });

  it("a finished build whose record write fails is retried while the heartbeat keeps the record fresh, then stops beating", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const t0 = Date.parse("2026-10-06T07:00:00.000Z");
    vi.setSystemTime(t0);
    const h = harness();
    const claimRun = h.deps.claimRun as ReturnType<typeof vi.fn>;
    const real = claimRun.getMockImplementation()!;
    let liveFailures = 0;
    claimRun.mockImplementation(async (input: { mark: SiteVersionMark }) => {
      if (input.mark.status === "live" && liveFailures < 2) {
        liveFailures += 1;
        throw new Error("conductor_runs write failed: 503");
      }
      return real(input);
    });
    (h.deps.hasDeploy as ReturnType<typeof vi.fn>).mockImplementation(async ({ deploy_id }: { deploy_id: string }) => deploy_id === STAGED);
    await siteVersionPreview(T, "build-1", h.deps);
    await vi.advanceTimersByTimeAsync(112_000);
    h.stages[0].resolve({ deploy_id: STAGED });
    await vi.advanceTimersByTimeAsync(0);
    expect(liveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(liveFailures).toBe(2);
    expect(h.markOn()).toMatchObject({ status: "starting", deploy_id: null, heartbeat_at: new Date(t0 + 120_000).toISOString() });
    vi.resetModules();
    const fresh = await import("../site-versions");
    vi.setSystemTime(t0 + 121_000);
    expect(await fresh.siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "starting" });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(h.markOn()).toMatchObject({ status: "live", deploy_id: STAGED });
    const beatsAfter = claimRun.mock.calls.filter(([i]) => (i as { mark: SiteVersionMark }).mark.status === "starting").length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(claimRun.mock.calls.filter(([i]) => (i as { mark: SiteVersionMark }).mark.status === "starting").length).toBe(beatsAfter);
    expect(h.markOn()).toMatchObject({ status: "live", deploy_id: STAGED });
    expect(await fresh.siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "live" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
  });

  it("a finished build refused because another claim took the record is not retried", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-06T07:00:00.000Z"));
    const h = harness();
    const claimRun = h.deps.claimRun as ReturnType<typeof vi.fn>;
    await siteVersionPreview(T, "build-1", h.deps);
    h.patchMark("build-1", { claim: "c-other" });
    h.stages[0].resolve({ deploy_id: STAGED });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const liveWrites = claimRun.mock.calls.filter(([i]) => (i as { mark: SiteVersionMark }).mark.status === "live");
    expect(liveWrites).toHaveLength(1);
    expect(h.markOn()).toMatchObject({ status: "starting", claim: "c-other" });
    expect(claimRun.mock.calls.filter(([i]) => (i as { mark: SiteVersionMark }).mark.status === "starting")).toHaveLength(1);
  });

  it("a record that never lands after every retry is reported loudly, and this process keeps serving the build it has", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-06T07:00:00.000Z"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness();
    const claimRun = h.deps.claimRun as ReturnType<typeof vi.fn>;
    const real = claimRun.getMockImplementation()!;
    claimRun.mockImplementation(async (input: { mark: SiteVersionMark }) => {
      if (input.mark.status === "live") throw new Error("conductor_runs write failed: 503");
      return real(input);
    });
    (h.deps.hasDeploy as ReturnType<typeof vi.fn>).mockImplementation(async ({ deploy_id }: { deploy_id: string }) => deploy_id === STAGED);
    await siteVersionPreview(T, "build-1", h.deps);
    h.stages[0].resolve({ deploy_id: STAGED });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(claimRun.mock.calls.filter(([i]) => (i as { mark: SiteVersionMark }).mark.status === "live")).toHaveLength(6);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toMatch(new RegExp(`ALERT.*run build-1.*tenant ${T}.*sha ${BUILD_SHA}`));
    const beats = claimRun.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(claimRun.mock.calls.length).toBe(beats);
    expect(vi.getTimerCount()).toBe(0);
    expect(await siteVersionPreview(T, "build-1", h.deps)).toMatchObject({ kind: "live", deploy_id: STAGED });
    expect(await siteVersionJob(T, "build-1", h.deps)).toMatchObject({ status: "live" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("a heartbeat write is refused by the database unless the record is still starting with no deploy", async () => {
    const starting: SiteVersionMark = { status: "starting", site_id: SITE, sha: BUILD_SHA, deploy_id: null, error: null, started_at: "2026-10-06T07:00:00.000Z", claim: "c-1", heartbeat_at: "2026-10-06T07:00:00.000Z" };
    const graphWith = (m: SiteVersionMark) => [{ ...unpublishedGraph[0], payload: { stage: "provision", site_id: SITE, version_preview: m } }];
    markRow = { goal_graph: graphWith(starting), updated_at: "2026-10-06T06:40:00.000Z" };
    markWrites = [[{ id: "build-1" }]];
    const beat = { ...starting, heartbeat_at: "2026-10-06T07:00:30.000Z" };
    expect(await realSiteVersionDeps.claimRun!({ tenant_id: T, run_id: "build-1", expect: "c-1", mark: beat, while_starting: true })).toEqual({ won: true });
    const write = tenantQueries.find((q) => (q.filters as unknown[][]).some((f) => f[0] === "update"))!;
    expect(write.filters as unknown[][]).toContainEqual(["eq", "goal_graph->0->payload->version_preview->>claim", "c-1"]);
    expect(write.filters as unknown[][]).toContainEqual(["eq", "goal_graph->0->payload->version_preview->>status", "starting"]);
    expect(write.filters as unknown[][]).toContainEqual(["is", "goal_graph->0->payload->version_preview->>deploy_id", null]);
    tenantQueries.length = 0;
    const live = { ...starting, status: "live" as const, deploy_id: STAGED };
    markRow = { goal_graph: graphWith(live), updated_at: "2026-10-06T06:40:00.000Z" };
    expect(await realSiteVersionDeps.claimRun!({ tenant_id: T, run_id: "build-1", expect: "c-1", mark: beat, while_starting: true })).toEqual({ won: false, mark: live });
    expect(tenantQueries.some((q) => (q.filters as unknown[][]).some((f) => f[0] === "update"))).toBe(false);
  });

  it("a second run of the same commit joins the build in progress and is recorded too, so a fresh process reports its real state", async () => {
    const second: SiteVersionRun = { ...unpublishedBuild, id: "build-2", created_at: "2026-10-06T06:40:00.000Z" };
    const h = harness({ runs: [unpublishedBuild, second] });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    expect(await siteVersionPreview(T, "build-2", h.deps)).toEqual({ kind: "starting" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
    expect(h.markOn("build-2")).toMatchObject({ status: "starting", sha: BUILD_SHA, claim: h.markOn("build-1")!.claim });
    vi.resetModules();
    const fresh = await import("../site-versions");
    expect(await fresh.siteVersionJob(T, "build-2", h.deps)).toMatchObject({ status: "starting" });
    await h.finishStage(STAGED);
    expect(h.markOn("build-2")).toMatchObject({ status: "live", deploy_id: STAGED });
    expect(await fresh.siteVersionJob(T, "build-2", h.deps)).toMatchObject({ status: "live", url: expect.stringContaining(STAGED) });
  });

  it("a run of the same commit opened after the shared build finished is recorded as that build", async () => {
    const third: SiteVersionRun = { ...unpublishedBuild, id: "build-3", created_at: "2026-10-06T06:50:00.000Z" };
    const h = harness({ runs: [unpublishedBuild, third] });
    await siteVersionPreview(T, "build-1", h.deps);
    await h.finishStage(STAGED);
    expect(await siteVersionPreview(T, "build-3", h.deps)).toMatchObject({ kind: "live", deploy_id: STAGED });
    expect(h.markOn("build-3")).toMatchObject({ status: "live", deploy_id: STAGED });
    vi.resetModules();
    const fresh = await import("../site-versions");
    expect(await fresh.siteVersionJob(T, "build-3", h.deps)).toMatchObject({ status: "live" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
  });

  it("a run that is not a site still falls through to the legacy preview", async () => {
    const h = harness({ runs: [{ id: "app-1", created_at: unpublishedBuild.created_at, status: "done", goal_graph: [{ id: "build", status: "done", payload: { stage: "build" } }] }] });
    expect(await siteVersionJob(T, "app-1", h.deps)).toBeNull();
  });
});

describe("which commit a version is", () => {
  const realFetch = globalThis.fetch;
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.GITHUB_PROVISION_TOKEN = "ghs_test";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.GITHUB_PROVISION_TOKEN;
  });

  it("a commit recorded on the run wins, with no GitHub call", async () => {
    const run = { ...unpublishedBuild, goal_graph: [{ id: "build", status: "done", checkpoint: { kind: "pushed", commit_sha: EDIT_SHA.toUpperCase() }, payload: { stage: "build", site_id: SITE } }] };
    expect(await realSiteVersionDeps.versionSha!({ tenant_id: T, site: site(), run })).toBe(EDIT_SHA);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is main as it was just before the site's next run started, so a later change is never shown as this version", async () => {
    nextRuns = [{ id: "refine-1", created_at: "2026-10-06T06:57:30.450Z" }];
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [{ sha: BUILD_SHA.toUpperCase() }] });
    expect(await realSiteVersionDeps.versionSha!({ tenant_id: T, site: site(), run: unpublishedBuild })).toBe(BUILD_SHA);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`/repos/${REPO}/commits?sha=main&per_page=1`);
    expect(new URL(url).searchParams.get("until")).toBe("2026-10-06T06:57:29.450Z");
    const filters = tenantQueries[0].filters as unknown[][];
    expect(filters).toContainEqual(["eq", "goal_graph->0->payload->>site_id", SITE]);
    expect(filters).toContainEqual(["gt", "created_at", unpublishedBuild.created_at]);
    expect(filters).toContainEqual(["neq", "id", "build-1"]);
  });

  it("the newest version is main's head", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [{ sha: EDIT_SHA }] });
    expect(await realSiteVersionDeps.versionSha!({ tenant_id: T, site: site(), run: unpublishedBuild })).toBe(EDIT_SHA);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("until")).toBeNull();
  });

  it("an empty repo has no commit; an unreadable one is an error, not a missing version", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({}) });
    expect(await realSiteVersionDeps.versionSha!({ tenant_id: T, site: site(), run: unpublishedBuild })).toBeNull();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });
    await expect(realSiteVersionDeps.versionSha!({ tenant_id: T, site: site(), run: unpublishedBuild })).rejects.toThrow(/502/);
  });
});

describe("prewarm: History builds the likely next pick ahead of the click", () => {
  const warm = { prewarm: true };

  it("starts the build, and the click that follows joins it (one build)", async () => {
    const h = harness();
    expect(await siteVersionPreview(T, "build-1", h.deps, warm)).toEqual({ kind: "starting" });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
    await h.finishStage(STAGED);
    expect(await siteVersionPreview(T, "build-1", h.deps)).toMatchObject({ kind: "live", deploy_id: STAGED });
  });

  it("never retries a version whose build failed (only a click does)", async () => {
    const h = harness();
    await siteVersionPreview(T, "build-1", h.deps);
    await h.failStage();
    expect(await siteVersionPreview(T, "build-1", h.deps, warm)).toEqual({ kind: "unavailable", error: PREWARM_SKIPPED });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
    __resetSiteVersionJobs();
    expect(await siteVersionPreview(T, "build-1", h.deps, warm)).toEqual({ kind: "unavailable", error: PREWARM_SKIPPED });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(1);
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    expect(h.deps.stageVersion).toHaveBeenCalledTimes(2);
  });

  it("waits out a running build or edit of the site, and an unreadable answer counts as busy", async () => {
    for (const siteBusy of [vi.fn(async () => true), vi.fn(async () => { throw new Error("db down"); })]) {
      __resetSiteVersionJobs();
      const h = harness();
      h.deps.siteBusy = siteBusy;
      expect(await siteVersionPreview(T, "build-1", h.deps, warm)).toEqual({ kind: "unavailable", error: PREWARM_SKIPPED });
      expect(siteBusy).toHaveBeenCalledWith({ tenant_id: T, site_id: SITE });
      expect(h.deps.stageVersion).not.toHaveBeenCalled();
    }
  });

  it("a prewarmed build gives way while the site gets busy, until a click makes it the founder's own", async () => {
    const h = harness();
    let busy = false;
    h.deps.siteBusy = vi.fn(async () => busy);
    await siteVersionPreview(T, "build-1", h.deps, warm);
    const input = (h.deps.stageVersion as ReturnType<typeof vi.fn>).mock.calls[0][0] as { shouldYield?: () => Promise<boolean> };
    expect(input.shouldYield).toBeTypeOf("function");
    expect(await input.shouldYield!()).toBe(false);
    busy = true;
    expect(await input.shouldYield!()).toBe(true);
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "starting" });
    expect(await input.shouldYield!()).toBe(false);
  });

  it("a click while the busy check is in flight wins: the poll answers no", async () => {
    const h = harness();
    let answer!: (v: boolean) => void;
    h.deps.siteBusy = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    (h.deps.siteBusy as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    await siteVersionPreview(T, "build-1", h.deps, warm);
    const input = (h.deps.stageVersion as ReturnType<typeof vi.fn>).mock.calls[0][0] as { shouldYield: () => Promise<boolean> };
    const poll = input.shouldYield();
    await siteVersionPreview(T, "build-1", h.deps);
    answer(true);
    expect(await poll).toBe(false);
  });

  it("a click's own build never gets a yield hook", async () => {
    const h = harness();
    h.deps.siteBusy = vi.fn(async () => true);
    await siteVersionPreview(T, "build-1", h.deps);
    const input = (h.deps.stageVersion as ReturnType<typeof vi.fn>).mock.calls[0][0] as { shouldYield?: unknown };
    expect(input.shouldYield).toBeUndefined();
  });

  it("a built copy opens at once, prewarm or not", async () => {
    const h = harness();
    h.deps.siteBusy = vi.fn(async () => true);
    await siteVersionPreview(T, "build-1", h.deps);
    await h.finishStage(STAGED);
    expect(await siteVersionPreview(T, "build-1", h.deps, warm)).toMatchObject({ kind: "live", deploy_id: STAGED });
  });
});
