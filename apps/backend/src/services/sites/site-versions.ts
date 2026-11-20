import { randomUUID } from "node:crypto";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { SiteRow } from "./contract";
import { siteIdFromGraph } from "./site-run";

export type SiteVersionRun = { id: string; created_at: string; goal_graph: unknown; status?: string };

export type SiteVersionDeps = {
  loadRun: (tenant_id: string, run_id: string) => Promise<SiteVersionRun | null>;
  loadFirstPublish: (tenant_id: string, root_run_id: string, after: string) => Promise<SiteVersionRun | null>;
  changedBetween: (input: { tenant_id: string; site_id: string; run_id: string; after: string; before: string }) => Promise<boolean>;
  loadSite: (tenant_id: string, site_id: string) => Promise<SiteRow | null>;
  hasDeploy: (input: { tenant_id: string; site_id: string; deploy_id: string }) => Promise<boolean>;
  versionPreviewUrl: (input: { tenant_id: string; site_id: string; deploy_id: string }) => Promise<{ url: string; expires_at: string }>;
  versionSha?: (input: { tenant_id: string; site: SiteRow; run: SiteVersionRun }) => Promise<string | null>;
  stageVersion?: (input: { tenant_id: string; site_id: string; sha: string; shouldYield?: () => Promise<boolean> }) => Promise<{ deploy_id: string }>;
  claimRun?: (input: SiteVersionClaimInput) => Promise<SiteVersionClaim>;
  siteBusy?: (input: { tenant_id: string; site_id: string }) => Promise<boolean>;
};

export type SiteVersionPreviewOptions = { prewarm?: boolean };

export type SiteVersionMark = {
  status: "starting" | "live" | "dead";
  site_id: string;
  sha: string;
  deploy_id: string | null;
  error: string | null;
  started_at: string;
  claim: string | null;
  heartbeat_at: string | null;
};

export type SiteVersionClaim = { won: true } | { won: false; mark: SiteVersionMark | null };

export type SiteVersionClaimInput = { tenant_id: string; run_id: string; expect: string | null; mark: SiteVersionMark; while_starting?: boolean };

type ClaimResult = SiteVersionClaim | { won: false; failed: true };

export type SiteVersionPreview =
  | { kind: "not_site" }
  | { kind: "live"; url: string; deploy_id: string; expires_at: string }
  | { kind: "starting" }
  | { kind: "unavailable"; error: string };

export const ERR_SITE_GONE = "This site was deleted, so its earlier versions are gone.";
export const ERR_NEVER_PUBLISHED = "This version was never published, so there is nothing to show.";
export const ERR_NOT_KEPT = "This version is too old to open. Zavi keeps copies of your most recent versions only.";
export const ERR_NOT_RECORDED = "This version was published before Zavi started keeping a copy of each version, so it can't be opened.";
export const ERR_UNREADABLE = "Zavi couldn't open this version just now. Try again.";
export const ERR_NO_COMMIT = "Zavi has no saved copy of this version's code, so it can't be shown.";
export const ERR_PREVIEW_FAILED = "Zavi couldn't build a preview of this version just now. Try again.";
export const PREWARM_SKIPPED = "prewarm_skipped";

export function siteVersionErrorRetryable(error: string | null | undefined): boolean {
  return error === ERR_UNREADABLE || error === ERR_PREVIEW_FAILED;
}

export const SITE_VERSION_STAGE_DEADLINE_MS = 20 * 60 * 1000;
export const SITE_VERSION_HEARTBEAT_MS = 30 * 1000;
export const SITE_VERSION_ORPHAN_MS = 2 * 60 * 1000;
export const SITE_VERSION_TERMINAL_RETRY_MS = [5_000, 10_000, 20_000, 30_000, 45_000];
const SITE_VERSION_JOB_TTL_MS = 6 * 60 * 60 * 1000;
const SHA_RE = /^[0-9a-f]{7,40}$/;

type StageJob = {
  status: "starting" | "live" | "dead";
  site_id: string;
  sha: string;
  deploy_id: string | null;
  error: string | null;
  started_at: number;
  claim: string | null;
  runs: Set<string>;
  final?: boolean;
  prewarm?: boolean;
};

const stageJobs = new Map<string, StageJob>();
const runJobs = new Map<string, string>();

export function __resetSiteVersionJobs(): void {
  stageJobs.clear();
  runJobs.clear();
}

function evictStageJobs(now: number): void {
  for (const [k, j] of stageJobs) {
    if (now - j.started_at > SITE_VERSION_JOB_TTL_MS && j.status !== "starting") stageJobs.delete(k);
  }
  for (const [k, v] of runJobs) if (!stageJobs.has(v)) runJobs.delete(k);
}

function recordedSha(graph: unknown): string | null {
  for (const n of [...nodesOf(graph)].reverse()) {
    const sha = (n as { checkpoint?: { commit_sha?: unknown } }).checkpoint?.commit_sha;
    if (typeof sha === "string" && SHA_RE.test(sha.trim().toLowerCase())) return sha.trim().toLowerCase();
  }
  return null;
}

function rawMark(graph: unknown): Record<string, unknown> | null {
  const m = nodesOf(graph)[0]?.payload?.version_preview;
  return m && typeof m === "object" ? (m as Record<string, unknown>) : null;
}

function claimOf(graph: unknown): string | null {
  const c = rawMark(graph)?.claim;
  return typeof c === "string" ? c : null;
}

function markOf(graph: unknown): SiteVersionMark | null {
  const m = rawMark(graph) as Partial<SiteVersionMark> | null;
  if (!m) return null;
  if (m.status !== "starting" && m.status !== "live" && m.status !== "dead") return null;
  if (typeof m.site_id !== "string" || typeof m.sha !== "string" || typeof m.started_at !== "string") return null;
  return {
    status: m.status,
    site_id: m.site_id,
    sha: m.sha,
    deploy_id: typeof m.deploy_id === "string" ? m.deploy_id : null,
    error: typeof m.error === "string" ? m.error : null,
    started_at: m.started_at,
    claim: typeof m.claim === "string" ? m.claim : null,
    heartbeat_at: typeof m.heartbeat_at === "string" ? m.heartbeat_at : null,
  };
}

function markStale(mark: SiteVersionMark, now: number): boolean {
  const started = Date.parse(mark.started_at);
  if (!Number.isFinite(started) || now - started > SITE_VERSION_STAGE_DEADLINE_MS) return true;
  const beat = Date.parse(mark.heartbeat_at ?? mark.started_at);
  return !mark.deploy_id && (!Number.isFinite(beat) || now - beat > SITE_VERSION_ORPHAN_MS);
}

function jobOfMark(mark: SiteVersionMark, now: number): StageJob {
  return { status: mark.status, site_id: mark.site_id, sha: mark.sha, deploy_id: mark.deploy_id, error: mark.error, started_at: now, claim: mark.claim, runs: new Set() };
}

function markOfJob(job: StageJob): SiteVersionMark {
  return {
    status: job.status,
    site_id: job.site_id,
    sha: job.sha,
    deploy_id: job.deploy_id,
    error: job.error,
    started_at: new Date(job.started_at).toISOString(),
    claim: job.claim,
    heartbeat_at: new Date().toISOString(),
  };
}

function startingMarkOf(job: StageJob): SiteVersionMark {
  return { ...markOfJob(job), status: "starting", deploy_id: null, error: null };
}

async function claimMark(
  tenant_id: string,
  run_id: string,
  expect: string | null,
  job: StageJob,
  deps: SiteVersionDeps,
  while_starting = false,
  mark: SiteVersionMark = markOfJob(job),
): Promise<ClaimResult> {
  if (!deps.claimRun) return { won: true };
  try {
    return await deps.claimRun({ tenant_id, run_id, expect, mark, ...(while_starting ? { while_starting } : {}) });
  } catch (e) {
    console.warn(`[site-versions] recording the preview of ${run_id} failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return { won: false, failed: true };
  }
}

async function saveMarkFor(tenant_id: string, run_id: string, job: StageJob, deps: SiteVersionDeps, mark?: SiteVersionMark): Promise<ClaimResult> {
  const r = await claimMark(tenant_id, run_id, job.claim, job, deps, true, mark ?? markOfJob(job));
  if (!r.won && !("failed" in r)) job.runs.delete(run_id);
  return r;
}

async function heartbeatMarks(tenant_id: string, job: StageJob, deps: SiteVersionDeps): Promise<void> {
  await Promise.all([...job.runs].map((run_id) => saveMarkFor(tenant_id, run_id, job, deps, startingMarkOf(job))));
}

async function finalizeMarks(tenant_id: string, job: StageJob, deps: SiteVersionDeps, stop: () => void): Promise<void> {
  await Promise.all(
    [...job.runs].map(async (run_id) => {
      for (let attempt = 0; ; attempt++) {
        const r = await saveMarkFor(tenant_id, run_id, job, deps);
        if (!("failed" in r)) return;
        const wait = SITE_VERSION_TERMINAL_RETRY_MS[attempt];
        if (wait === undefined) {
          console.error(
            `[site-versions] ALERT could not record the ${job.status} preview of run ${run_id} (tenant ${tenant_id}, site ${job.site_id}, sha ${job.sha}, deploy ${job.deploy_id ?? "none"}) after ${attempt + 1} attempts`,
          );
          return;
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, wait);
          t.unref?.();
        });
      }
    }),
  );
  job.final = true;
  stop();
}

async function joinJob(tenant_id: string, run: SiteVersionRun, job: StageJob, deps: SiteVersionDeps): Promise<SiteVersionPreview | null> {
  if (job.runs.has(run.id)) return null;
  const current = claimOf(run.goal_graph);
  if (current !== null && current === job.claim) {
    job.runs.add(run.id);
    return null;
  }
  job.runs.add(run.id);
  const joined = await claimMark(tenant_id, run.id, current, job, deps);
  if (joined.won) {
    job.runs.add(run.id);
    if (job.status !== "starting") await saveMarkFor(tenant_id, run.id, job, deps);
    return null;
  }
  job.runs.delete(run.id);
  if ("failed" in joined) return { kind: "unavailable", error: ERR_UNREADABLE };
  return await lostTo(tenant_id, joined.mark, job.site_id, job.sha, deps);
}

async function lostTo(tenant_id: string, winner: SiteVersionMark | null, site_id: string, sha: string, deps: SiteVersionDeps): Promise<SiteVersionPreview> {
  if (winner?.status === "live" && winner.site_id === site_id && winner.sha === sha) {
    const live = await liveFromJob(tenant_id, jobOfMark(winner, Date.now()), deps);
    if (live) return live;
  }
  return { kind: "starting" };
}

async function liveFromJob(tenant_id: string, job: StageJob, deps: SiteVersionDeps): Promise<SiteVersionPreview | null> {
  if (!job.deploy_id || !(await deps.hasDeploy({ tenant_id, site_id: job.site_id, deploy_id: job.deploy_id }))) return null;
  const { url, expires_at } = await deps.versionPreviewUrl({ tenant_id, site_id: job.site_id, deploy_id: job.deploy_id });
  return { kind: "live", url, deploy_id: job.deploy_id, expires_at };
}

async function previewFromCommit(
  tenant_id: string,
  run: SiteVersionRun,
  site: SiteRow,
  deps: SiteVersionDeps,
  opts: SiteVersionPreviewOptions = {},
): Promise<SiteVersionPreview> {
  const now = Date.now();
  evictStageJobs(now);
  const skipped: SiteVersionPreview = { kind: "unavailable", error: PREWARM_SKIPPED };
  const runKey = `${tenant_id}:${run.id}`;
  const known = runJobs.get(runKey);
  const prior = known ? stageJobs.get(known) : undefined;
  if (prior && !opts.prewarm) prior.prewarm = false;
  if (prior?.status === "starting") return { kind: "starting" };
  if (prior?.status === "live") {
    const live = await liveFromJob(tenant_id, prior, deps);
    if (live) return live;
  }
  if (opts.prewarm && prior?.status === "dead") return skipped;
  const raw = await deps.versionSha!({ tenant_id, site, run });
  const sha = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!SHA_RE.test(sha)) return { kind: "unavailable", error: ERR_NO_COMMIT };
  const key = `${tenant_id}:${site.id}:${sha}`;
  runJobs.set(runKey, key);
  const shared = stageJobs.get(key);
  if (shared && !opts.prewarm) shared.prewarm = false;
  if (shared?.status === "starting") return (await joinJob(tenant_id, run, shared, deps)) ?? { kind: "starting" };
  if (shared?.status === "live") {
    const live = await liveFromJob(tenant_id, shared, deps);
    if (live) {
      await joinJob(tenant_id, run, shared, deps);
      return live;
    }
  }
  const mark = markOf(run.goal_graph);
  const same = mark && mark.site_id === site.id && mark.sha === sha ? mark : null;
  if (same?.status === "starting" && !markStale(same, now)) return { kind: "starting" };
  if (same?.status === "live") {
    const live = await liveFromJob(tenant_id, jobOfMark(same, now), deps);
    if (live) return live;
  }
  if (opts.prewarm) {
    if (shared?.status === "dead" || same?.status === "dead") return skipped;
    if (deps.siteBusy && (await deps.siteBusy({ tenant_id, site_id: site.id }).catch(() => true))) return skipped;
  }
  const job: StageJob = {
    status: "starting",
    site_id: site.id,
    sha,
    deploy_id: null,
    error: null,
    started_at: now,
    claim: randomUUID(),
    runs: new Set([run.id]),
    ...(opts.prewarm ? { prewarm: true } : {}),
  };
  const busy = deps.siteBusy;
  const shouldYield = opts.prewarm && busy
    ? async () => {
        if (job.prewarm !== true) return false;
        const isBusy = await busy({ tenant_id, site_id: site.id }).catch(() => true);
        return isBusy && job.prewarm === true;
      }
    : undefined;
  const claimed = await claimMark(tenant_id, run.id, claimOf(run.goal_graph), job, deps);
  if ("failed" in claimed) return { kind: "unavailable", error: ERR_UNREADABLE };
  if (!claimed.won) return await lostTo(tenant_id, claimed.mark, site.id, sha, deps);
  stageJobs.set(key, job);
  const deadline = setTimeout(() => {
    if (stageJobs.get(key) === job && job.status === "starting") {
      job.status = "dead";
      job.error = ERR_PREVIEW_FAILED;
      void finalizeMarks(tenant_id, job, deps, stop);
    }
  }, SITE_VERSION_STAGE_DEADLINE_MS);
  deadline.unref?.();
  const heartbeat = setInterval(() => {
    if (job.final) return;
    void heartbeatMarks(tenant_id, job, deps).then(() => {
      if (job.runs.size === 0) clearInterval(heartbeat);
    });
  }, SITE_VERSION_HEARTBEAT_MS);
  heartbeat.unref?.();
  const stop = () => clearInterval(heartbeat);
  void deps.stageVersion!({ tenant_id, site_id: site.id, sha, ...(shouldYield ? { shouldYield } : {}) })
    .then(async ({ deploy_id }) => {
      job.status = "live";
      job.deploy_id = deploy_id;
      job.error = null;
      await finalizeMarks(tenant_id, job, deps, stop);
    })
    .catch((e: unknown) => {
      console.warn(`[site-versions] staging ${sha.slice(0, 7)} of site ${site.id} failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      job.status = "dead";
      job.error = ERR_PREVIEW_FAILED;
      return finalizeMarks(tenant_id, job, deps, stop);
    })
    .finally(() => clearTimeout(deadline));
  return { kind: "starting" };
}

export type SiteVersionJobView = { status: "starting" | "live" | "dead"; url: string | null; expires_at: string | null; error: string | null; retryable: boolean };

export async function siteVersionJob(tenant_id: string, run_id: string, deps: SiteVersionDeps = realSiteVersionDeps): Promise<SiteVersionJobView | null> {
  const key = runJobs.get(`${tenant_id}:${run_id}`);
  const job = key ? stageJobs.get(key) : undefined;
  if (!job) return await siteVersionJobFromRun(tenant_id, run_id, deps);
  if (job.status === "starting") return { status: "starting", url: null, expires_at: null, error: null, retryable: true };
  if (job.status === "dead") return { status: "dead", url: null, expires_at: null, error: job.error ?? ERR_PREVIEW_FAILED, retryable: true };
  try {
    const live = await liveFromJob(tenant_id, job, deps);
    if (live && live.kind === "live") return { status: "live", url: live.url, expires_at: live.expires_at, error: null, retryable: true };
    job.status = "dead";
    job.error = ERR_PREVIEW_FAILED;
    return { status: "dead", url: null, expires_at: null, error: ERR_PREVIEW_FAILED, retryable: true };
  } catch (e) {
    console.warn(`[site-versions] ${run_id}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return { status: "dead", url: null, expires_at: null, error: ERR_UNREADABLE, retryable: true };
  }
}

async function siteVersionJobFromRun(tenant_id: string, run_id: string, deps: SiteVersionDeps): Promise<SiteVersionJobView | null> {
  try {
    const run = await deps.loadRun(tenant_id, run_id);
    const site_id = run ? siteIdFromGraph(run.goal_graph) : null;
    if (!run || !site_id) return null;
    const site = await deps.loadSite(tenant_id, site_id);
    if (site?.status === "fell_back_old") return null;
    if (!site || site.status === "deleting" || site.status === "deleted") return { status: "dead", url: null, expires_at: null, error: ERR_SITE_GONE, retryable: false };
    const mark = markOf(run.goal_graph);
    if (!mark || mark.site_id !== site_id) return { status: "dead", url: null, expires_at: null, error: ERR_PREVIEW_FAILED, retryable: true };
    if (mark.status === "starting") {
      if (!markStale(mark, Date.now())) return { status: "starting", url: null, expires_at: null, error: null, retryable: true };
      return { status: "dead", url: null, expires_at: null, error: ERR_PREVIEW_FAILED, retryable: true };
    }
    if (mark.status === "live") {
      const live = await liveFromJob(tenant_id, jobOfMark(mark, Date.now()), deps);
      if (live && live.kind === "live") return { status: "live", url: live.url, expires_at: live.expires_at, error: null, retryable: true };
    }
    return { status: "dead", url: null, expires_at: null, error: mark.error ?? ERR_PREVIEW_FAILED, retryable: true };
  } catch (e) {
    console.warn(`[site-versions] ${run_id}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return { status: "dead", url: null, expires_at: null, error: ERR_UNREADABLE, retryable: true };
  }
}

type NodeLike = { status?: unknown; payload?: Record<string, unknown> | null };

function nodesOf(graph: unknown): NodeLike[] {
  return Array.isArray(graph) ? (graph as NodeLike[]) : [];
}

function publishNode(graph: unknown): NodeLike | null {
  const done = nodesOf(graph).filter((n) => n?.payload?.stage === "deploy" && n.status === "done" && typeof n.payload?.site_id === "string");
  return done[done.length - 1] ?? null;
}

function isRefineRun(graph: unknown): boolean {
  return nodesOf(graph).some((n) => n?.payload?.refine_mode === true);
}

function shaOf(node: NodeLike): string | null {
  const sha = node.payload?.site_desired_sha ?? node.payload?.site_sha;
  return typeof sha === "string" && sha ? sha.toLowerCase() : null;
}

export async function siteVersionPreview(
  tenant_id: string,
  run_id: string,
  deps: SiteVersionDeps = realSiteVersionDeps,
  opts: SiteVersionPreviewOptions = {},
): Promise<SiteVersionPreview> {
  let run: SiteVersionRun | null;
  try {
    run = await deps.loadRun(tenant_id, run_id);
  } catch (e) {
    console.warn(`[site-versions] ${run_id}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return { kind: "unavailable", error: ERR_UNREADABLE };
  }
  try {
    const site_id = run ? siteIdFromGraph(run.goal_graph) : null;
    if (!run || !site_id) return { kind: "not_site" };
    const site = await deps.loadSite(tenant_id, site_id);
    if (site?.status === "fell_back_old") return { kind: "not_site" };
    if (!site || site.status === "deleting" || site.status === "deleted") return { kind: "unavailable", error: ERR_SITE_GONE };

    let node = publishNode(run.goal_graph);
    const refine = isRefineRun(run.goal_graph);
    const ownDeploy = nodesOf(run.goal_graph).some((n) => n?.payload?.stage === "deploy");
    if (!node && (!refine || !ownDeploy)) {
      const parent = nodesOf(run.goal_graph)[0]?.payload?.parent_conductor_run_id;
      const root = refine ? (site.root_conductor_run_id ?? (typeof parent === "string" ? parent : null)) : run.id;
      const first = root ? await deps.loadFirstPublish(tenant_id, root, run.created_at) : null;
      if (first && siteIdFromGraph(first.goal_graph) === site_id) {
        const superseded = await deps.changedBetween({ tenant_id, site_id, run_id: run.id, after: run.created_at, before: first.created_at });
        if (!superseded) node = publishNode(first.goal_graph);
      }
    }
    if (!node && run.status === "done" && deps.versionSha && deps.stageVersion) return await previewFromCommit(tenant_id, run, site, deps, opts);
    if (!node) return { kind: "unavailable", error: ERR_NEVER_PUBLISHED };

    const recorded = node.payload?.site_live_deploy_id;
    let deploy_id: string;
    if (typeof recorded === "string" && recorded) {
      deploy_id = recorded;
    } else {
      const sha = shaOf(node);
      if (!sha || !site.live_deploy_id || (site.live_sha ?? "").toLowerCase() !== sha) return { kind: "unavailable", error: ERR_NOT_RECORDED };
      deploy_id = site.live_deploy_id;
    }
    if (!(await deps.hasDeploy({ tenant_id, site_id, deploy_id }))) return { kind: "unavailable", error: ERR_NOT_KEPT };

    const { url, expires_at } = await deps.versionPreviewUrl({ tenant_id, site_id, deploy_id });
    return { kind: "live", url, deploy_id, expires_at };
  } catch (e) {
    console.warn(`[site-versions] ${run_id}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return { kind: "unavailable", error: ERR_UNREADABLE };
  }
}

async function realLoadRun(tenant_id: string, run_id: string): Promise<SiteVersionRun | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("conductor_runs")
    .select("id, created_at, goal_graph, status")
    .eq("tenant_id", tenant_id)
    .eq("id", run_id)
    .maybeSingle();
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  return (data as SiteVersionRun | null) ?? null;
}

async function realLoadFirstPublish(tenant_id: string, root_run_id: string, after: string): Promise<SiteVersionRun | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("conductor_runs")
    .select("id, created_at, goal_graph")
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .eq("status", "done")
    .eq("goal_graph->0->payload->>parent_conductor_run_id", root_run_id)
    .eq("goal_graph->0->payload->>republish", "true")
    .gte("created_at", after)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  return ((data as SiteVersionRun[] | null) ?? [])[0] ?? null;
}

let publisher: Promise<import("@/services/hosting/site-publish").SitePublisherImpl> | null = null;
function sitePublisher() {
  publisher ??= (async () => {
    const [{ createSitePublisher }, { siteStore }] = await Promise.all([import("@/services/hosting/site-publish"), import("./store")]);
    return createSitePublisher({ store: siteStore(), repoFetchToken: async () => process.env.GITHUB_PROVISION_TOKEN?.trim() || null });
  })().catch((e) => {
    publisher = null;
    throw e;
  });
  return publisher;
}

async function realChangedBetween(input: { tenant_id: string; site_id: string; run_id: string; after: string; before: string }): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(input.tenant_id))
    .from("conductor_runs")
    .select("id, goal_graph")
    .eq("tenant_id", input.tenant_id)
    .eq("kind", "build_app")
    .eq("status", "done")
    .eq("goal_graph->0->payload->>site_id", input.site_id)
    .gt("created_at", input.after)
    .lt("created_at", input.before)
    .neq("id", input.run_id)
    .limit(50);
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  return ((data as Array<{ goal_graph: unknown }> | null) ?? []).some(
    (r) => isRefineRun(r.goal_graph) && !nodesOf(r.goal_graph).some((n) => n?.payload?.republish === true),
  );
}

async function realVersionSha(input: { tenant_id: string; site: SiteRow; run: SiteVersionRun }): Promise<string | null> {
  const recorded = recordedSha(input.run.goal_graph);
  if (recorded) return recorded;
  const full = (input.site.github_full_name ?? "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(full)) return null;
  const { data, error } = await tenantClient(asTenantId(input.tenant_id))
    .from("conductor_runs")
    .select("id, created_at")
    .eq("tenant_id", input.tenant_id)
    .eq("goal_graph->0->payload->>site_id", input.site.id)
    .gt("created_at", input.run.created_at)
    .neq("id", input.run.id)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  const next = ((data as Array<{ created_at: string }> | null) ?? [])[0]?.created_at ?? null;
  const token = process.env.GITHUB_PROVISION_TOKEN ?? "";
  if (!token) throw new Error("this server has no GitHub provisioning credential");
  const until = next ? `&until=${encodeURIComponent(new Date(Date.parse(next) - 1000).toISOString())}` : "";
  const res = await fetch(`https://api.github.com/repos/${full}/commits?sha=main&per_page=1${until}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (res.status === 409) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status} listing commits of ${full}`);
  const list = (await res.json()) as Array<{ sha?: unknown }> | null;
  const sha = Array.isArray(list) ? list[0]?.sha : null;
  return typeof sha === "string" ? sha.toLowerCase() : null;
}

async function realStageVersion(input: { tenant_id: string; site_id: string; sha: string; shouldYield?: () => Promise<boolean> }): Promise<{ deploy_id: string }> {
  const [{ createSiteSandboxResolver }, { siteStore }] = await Promise.all([import("./sandbox-resolver"), import("./store")]);
  const sandbox = await createSiteSandboxResolver({ store: siteStore() }).forSite(input.tenant_id, input.site_id);
  if (!sandbox) throw new Error(`site ${input.site_id} has no sandbox to build this version in`);
  const staged = await (await sitePublisher()).stage({
    tenant_id: input.tenant_id,
    site_id: input.site_id,
    sha: input.sha,
    sandbox,
    reuseInstall: true,
    ...(input.shouldYield ? { shouldYield: input.shouldYield } : {}),
  });
  return { deploy_id: staged.deploy_id };
}

async function realSiteBusy(input: { tenant_id: string; site_id: string }): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(input.tenant_id))
    .from("conductor_runs")
    .select("id")
    .eq("tenant_id", input.tenant_id)
    .eq("kind", "build_app")
    .in("status", ["active", "provisioning"])
    .eq("goal_graph->0->payload->>site_id", input.site_id)
    .limit(1);
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  if (((data as unknown[] | null) ?? []).length > 0) return true;
  const { siteLeaseHeld } = await import("./site-preview-lease");
  return (await siteLeaseHeld(input.tenant_id, input.site_id)) !== null;
}

const CLAIM_PATH = "goal_graph->0->payload->version_preview->>claim";
const MARK_STATUS_PATH = "goal_graph->0->payload->version_preview->>status";
const MARK_DEPLOY_PATH = "goal_graph->0->payload->version_preview->>deploy_id";

async function realClaimRun(input: SiteVersionClaimInput): Promise<SiteVersionClaim> {
  let current: SiteVersionMark | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await tenantClient(asTenantId(input.tenant_id))
      .from("conductor_runs")
      .select("goal_graph, updated_at")
      .eq("tenant_id", input.tenant_id)
      .eq("id", input.run_id)
      .eq("status", "done")
      .maybeSingle();
    if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
    const row = data as { goal_graph: unknown; updated_at: string } | null;
    if (!row || !Array.isArray(row.goal_graph) || row.goal_graph.length === 0) return { won: false, mark: null };
    current = markOf(row.goal_graph);
    if (claimOf(row.goal_graph) !== input.expect) return { won: false, mark: current };
    if (input.while_starting && (current?.status !== "starting" || current.deploy_id !== null)) return { won: false, mark: current };
    const [first, ...rest] = row.goal_graph as Array<Record<string, unknown>>;
    const payload = first?.payload && typeof first.payload === "object" ? (first.payload as Record<string, unknown>) : {};
    const goal_graph = [{ ...first, payload: { ...payload, version_preview: input.mark } }, ...rest];
    const update = tenantClient(asTenantId(input.tenant_id))
      .from("conductor_runs")
      .update({ goal_graph })
      .eq("tenant_id", input.tenant_id)
      .eq("id", input.run_id)
      .eq("status", "done")
      .eq("updated_at", row.updated_at);
    const claimed = input.expect === null ? update.is(CLAIM_PATH, null) : update.eq(CLAIM_PATH, input.expect);
    const guarded = input.while_starting ? claimed.eq(MARK_STATUS_PATH, "starting").is(MARK_DEPLOY_PATH, null) : claimed;
    const { data: written, error: werr } = await guarded.select("id");
    if (werr) throw new Error(`conductor_runs write failed: ${werr.message}`);
    if (((written as unknown[] | null) ?? []).length > 0) return { won: true };
  }
  return { won: false, mark: current };
}

export const realSiteVersionDeps: SiteVersionDeps = {
  loadRun: realLoadRun,
  loadFirstPublish: realLoadFirstPublish,
  changedBetween: realChangedBetween,
  loadSite: async (tenant_id, site_id) => (await import("./store")).siteStore().get(tenant_id, site_id),
  hasDeploy: async (i) => (await sitePublisher()).hasDeploy(i),
  versionPreviewUrl: async (i) => (await sitePublisher()).versionPreviewUrl(i),
  versionSha: realVersionSha,
  stageVersion: realStageVersion,
  claimRun: realClaimRun,
  siteBusy: realSiteBusy,
};
