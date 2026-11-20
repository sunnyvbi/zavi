
import { serviceClient } from "@/services/supabase";
import { refineAwaitsReview } from "@/services/agents/refine-display";
import {
  assertProvisionedRepoTarget,
  type ProvisionedRepoGateDeps,
  realProvisionedRepoGateDeps,
} from "@/services/provisioning/provisioned-repo-gate";
import {
  compareBranches,
  AUTOPILOT_PAT_SENTINEL,
  isProvisionedUmbrellaOwner,
  listBranchesImpl,
  listCommitsImpl,
  readBranchSha,
  readCommitParentSha,
  resolveInstallationId,
  restoreCommitOnMain,
  revertCommitOnMain,
} from "@/services/mcp/internal/github";
import { SITE_REPO_DIR, type SiteRow, type SiteSandbox } from "@/services/sites/contract";
import type { ConductorNode } from "@/services/agents/conductor";
import { siteIdFromGraph } from "@/services/sites/site-run";
import { OldSiteFrozen } from "@/services/sites/old-site-freeze";
import { claimSiteEditLease, type SiteEditLease } from "@/services/sites/site-preview-lease";
import type { SiteRepublisher } from "@/services/agents/refine-product";

export class NoUndoableRefine extends Error {
  constructor(public readonly tenant_id: string) {
    super(
      "no shipped refine to undo — only the most-recent successful refine is undoable",
    );
    this.name = "NoUndoableRefine";
  }
}

export class NotProvisioned extends Error {
  constructor(public readonly reason: string) {
    super(`refine-undo refused: ${reason}`);
    this.name = "NotProvisioned";
  }
}

export class UndoCommitNotFound extends Error {
  constructor() {
    super("the saved version of that change could not be found, so it cannot be undone");
    this.name = "UndoCommitNotFound";
  }
}

export type UndoBlockedReason = "build_in_progress" | "newer_change" | "unpublished_draft" | "undo_in_progress";

export class UndoBlocked extends Error {
  constructor(public readonly reason: UndoBlockedReason, message: string) {
    super(message);
    this.name = "UndoBlocked";
  }
}

export type RefineUndoInput = {
  tenant_id: string;
  guarded?: boolean;
  conductor_run_id?: string | null;
  workspace_only?: boolean;
};

export type RefineUndoResult = {
  undo_conductor_run_id: string;
  reverted_conductor_run_id: string;
  reverted_commit_sha: string;
  new_commit_sha: string;
  branch: string;
  republished?: boolean;
  republish_pending?: boolean;
  history_recorded?: boolean;
  draft_reset?: boolean;
  preview_only?: true;
  preview_stale?: true;
};

export type UndoClaimParams = {
  tenant_id: string;
  objective: string;
  parent_conductor_run_id: string;
  reverted_commit_sha: string;
  branch: string;
  site_id?: string;
  preview_only?: boolean;
};

export type RefineUndoDeps = {
  isOnDefaultBranch?: (p: {
    tenant_id: string;
    installation_id: number;
    owner: string;
    repo: string;
    sha: string;
    default_branch: string;
  }) => Promise<boolean>;
  loadLatestShippedRefine: (
    tenant_id: string,
  ) => Promise<{
    conductor_run_id: string;
    child_run_id: string | null;
    output_text: string | null;
    parsed: Record<string, unknown> | null;
  } | null>;
  loadProvisionedTarget: (tenant_id: string) => Promise<{
    github_full_name: string;
    default_branch: string;
  } | null>;
  assertProvisionedRepo: ProvisionedRepoGateDeps;
  resolveInstallation: (tenant_id: string, github_full_name?: string) => Promise<number>;
  readBranchHeadSha: (params: {
    tenant_id: string;
    installation_id: number;
    owner: string;
    repo: string;
    branch: string;
  }) => Promise<string | null>;
  listRecentCommits: (params: {
    tenant_id: string;
    installation_id: number;
    owner: string;
    repo: string;
    branch: string;
    max_results: number;
  }) => Promise<Array<{ sha: string; message: string; author_date?: string }>>;
  listBranches?: (params: {
    tenant_id: string;
    installation_id: number;
    owner: string;
    repo: string;
  }) => Promise<Array<{ name: string; sha: string }>>;
  revertOnMain: (params: {
    tenant_id: string;
    installation_id: number;
    owner: string;
    repo: string;
    base_branch: string;
    commit_sha: string;
    expected_head_sha?: string;
  }) => Promise<{ reverted: true; branch: string; new_commit_sha: string }>;
  insertUndoRun: (params: {
    tenant_id: string;
    objective: string;
    parent_conductor_run_id: string;
    reverted_commit_sha: string;
    new_commit_sha: string;
    branch: string;
    kind?: "undo" | "restore";
    site_id?: string;
  }) => Promise<string>;
  loadShippedRefineById?: (
    tenant_id: string,
    conductor_run_id: string,
  ) => Promise<ShippedRefine | null>;
  loadEarliestShippedRefine?: (tenant_id: string) => Promise<ShippedRefine | null>;
  loadBuildCheckpointSha?: (tenant_id: string, conductor_run_id: string) => Promise<string | null>;
  loadBuildRootRun?: (tenant_id: string, conductor_run_id: string) => Promise<{ created_at: string | null } | null>;
  loadRestoreRun?: (tenant_id: string, conductor_run_id: string) => Promise<{ commit_sha: string; label: string } | null>;
  readCommitParentSha?: (params: {
    tenant_id: string;
    installation_id: number;
    owner: string;
    repo: string;
    commit_sha: string;
  }) => Promise<string | null>;
  restoreOnMain?: (params: {
    tenant_id: string;
    installation_id: number;
    owner: string;
    repo: string;
    base_branch: string;
    commit_sha: string;
    label?: string;
  }) => Promise<{ restored: true; branch: string; new_commit_sha: string; noop: boolean }>;
  hasActiveBuild?: (tenant_id: string) => Promise<boolean>;
  readBranchRefSha?: (params: {
    tenant_id: string;
    installation_id: number;
    owner: string;
    repo: string;
    branch: string;
  }) => Promise<string | null>;
  claimUndoRun?: (params: UndoClaimParams) => Promise<string>;
  settleUndoRun?: (params: UndoClaimParams & { id: string; new_commit_sha: string }) => Promise<void>;
  releaseUndoRun?: (params: { tenant_id: string; id: string }) => Promise<void>;
  checkLiveEditDraft?: (tenant_id: string) => Promise<"clear" | "unpublished">;
  resetLiveEditDraft?: (tenant_id: string, new_main_sha: string) => Promise<"reset" | "deleted" | "skipped">;
  loadSiteOfRun?: (tenant_id: string, conductor_run_id: string) => Promise<SiteRow | null>;
  loadLatestShippedRefineForSite?: (tenant_id: string, site_id: string) => Promise<ShippedRefine | null>;
  siteRepublish?: SiteRepublisher;
  resolveBuildPublishOnRequest?: (tenant_id: string) => Promise<boolean>;
  discardHeldSlot?: (params: { tenant_id: string; conductor_run_id: string }) => Promise<void>;
  syncSitePreview?: (params: { tenant_id: string; site: SiteRow; sha: string }) => Promise<void>;
  markPreviewStale?: (tenant_id: string, site_id: string) => Promise<void>;
  claimSiteEditLease?: (tenant_id: string, site_id: string) => Promise<SiteEditLease>;
};

export type ShippedRefine = {
  conductor_run_id: string;
  child_run_id: string | null;
  output_text: string | null;
  parsed: Record<string, unknown> | null;
  message?: string | null;
  created_at?: string | null;
  finished_at?: string | null;
  next_started_at?: string | null;
  awaiting_review?: boolean;
};

export class ChangeAwaitingApproval extends Error {
  constructor() {
    super("that change is still waiting for approval; approve it from the chat instead of reverting to it");
    this.name = "ChangeAwaitingApproval";
  }
}

export class DraftNotPublished extends Error {
  constructor() {
    super("that change is only in your preview; publish or discard it instead");
    this.name = "DraftNotPublished";
  }
}

function isDraftCommit(parsed: Record<string, unknown> | null | undefined): boolean {
  return typeof parsed?.live_edit_draft_sha === "string" && parsed.live_edit_draft_sha.length > 0;
}

async function assertNotUnpublishedDraft(
  deps: RefineUndoDeps,
  parsed: Record<string, unknown> | null | undefined,
  p: { tenant_id: string; installation_id: number; owner: string; repo: string; sha: string; default_branch: string },
): Promise<void> {
  if (!isDraftCommit(parsed)) return;
  const onDefault = deps.isOnDefaultBranch ? await deps.isOnDefaultBranch(p).catch(() => false) : false;
  if (!onDefault) throw new DraftNotPublished();
}

async function realIsOnDefaultBranch(p: {
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  sha: string;
  default_branch: string;
}): Promise<boolean> {
  const cmp = await compareBranches({
    tenant_id: p.tenant_id,
    installation_id: p.installation_id,
    owner: p.owner,
    repo: p.repo,
    base: p.sha,
    head: p.default_branch,
  });
  return cmp !== null && cmp.behind_by === 0;
}

export const RUN_WINDOW_BEFORE_MS = 2 * 60 * 1000;
export const RUN_WINDOW_AFTER_MS = 15 * 60 * 1000;

export function commitShaInRunWindow(
  commits: Array<{ sha: string; author_date?: string }>,
  run: { created_at?: string | null; finished_at?: string | null; next_started_at?: string | null },
): string | null {
  const start = Date.parse(run.created_at ?? "");
  const end = Date.parse(run.finished_at ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const lo = start - RUN_WINDOW_BEFORE_MS;
  const next = Date.parse(run.next_started_at ?? "");
  const hi = Math.min(end + RUN_WINDOW_AFTER_MS, Number.isFinite(next) ? next - 1 : Number.POSITIVE_INFINITY);
  let best: { sha: string; at: number } | null = null;
  for (const c of commits) {
    const at = Date.parse(c.author_date ?? "");
    if (!Number.isFinite(at) || at < lo || at > hi) continue;
    if (!best || at > best.at) best = { sha: c.sha, at };
  }
  return best ? validSha(best.sha) : null;
}

export class NothingToRestore extends Error {
  constructor(public readonly reason: string) {
    super(`nothing to restore: ${reason}`);
    this.name = "NothingToRestore";
  }
}

export type RefineRestoreInput = {
  tenant_id: string;
  conductor_run_id: string;
  purpose?: "restore" | "preview";
};

export type RefineRestoreResult = {
  restore_conductor_run_id: string | null;
  restored_conductor_run_id: string;
  restored_commit_sha: string;
  new_commit_sha: string;
  branch: string;
  noop: boolean;
  history_recorded: boolean;
};

export type VersionCommit = {
  commit_sha: string;
  label: string;
  target: { github_full_name: string; default_branch: string };
  installation_id: number;
};

async function realLoadLatestShippedRefine(
  tenant_id: string,
): Promise<{
  conductor_run_id: string;
  child_run_id: string | null;
  output_text: string | null;
  parsed: Record<string, unknown> | null;
} | null> {
  const sb = serviceClient();
  const recent = () =>
    sb
      .from("conductor_runs")
      .select("id, status, goal_graph, created_at")
      .eq("tenant_id", tenant_id);
  let { data, error } = await recent().order("created_at", { ascending: false }).limit(30);
  if (!error && ((data ?? []) as Array<{ goal_graph?: unknown }>).some((r) => siteIdFromGraph(r.goal_graph) !== null)) {
    ({ data, error } = await recent()
      .is("goal_graph->0->payload->>site_id", null)
      .is("goal_graph->1->payload->>site_id", null)
      .is("goal_graph->2->payload->>site_id", null)
      .order("created_at", { ascending: false })
      .limit(30));
  }
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  type Node = {
    child_run_id?: string | null;
    payload?: { refine_mode?: unknown; stage?: unknown };
  };
  type Row = { id: string; status: string; goal_graph: Node[] | null; created_at?: string | null };
  const rows = (data ?? []) as Row[];
  const shippedIndex = rows.findIndex((r) => {
    if (r.status !== "done") return false;
    const node = (r.goal_graph ?? [])[0];
    return node?.payload?.refine_mode === true;
  });
  if (shippedIndex < 0) return null;
  const shipped = rows[shippedIndex];
  const revertedSince = rows.slice(0, shippedIndex).some((r) => {
    if (r.status === "failed" || isStaleUndoClaim(r)) return false;
    const stage = (r.goal_graph ?? [])[0]?.payload?.stage;
    return stage === "undo" || stage === "restore";
  });
  if (revertedSince) return null;
  const childId = (shipped.goal_graph ?? [])[0]?.child_run_id ?? null;
  let output_text: string | null = null;
  let parsed: Record<string, unknown> | null = null;
  if (childId) {
    const { data: ar } = await sb
      .from("agent_runs")
      .select("output_text, parsed")
      .eq("tenant_id", tenant_id)
      .eq("id", childId)
      .maybeSingle();
    output_text = (ar?.output_text as string | null) ?? null;
    const rawParsed = (ar as { parsed?: unknown } | null)?.parsed;
    parsed =
      rawParsed && typeof rawParsed === "object" && !Array.isArray(rawParsed)
        ? (rawParsed as Record<string, unknown>)
        : null;
  }
  return {
    conductor_run_id: shipped.id,
    child_run_id: childId,
    output_text,
    parsed,
  };
}

async function loadChildEnvelope(
  tenant_id: string,
  childId: string | null,
): Promise<{ output_text: string | null; parsed: Record<string, unknown> | null }> {
  if (!childId) return { output_text: null, parsed: null };
  const { data: ar } = await serviceClient()
    .from("agent_runs")
    .select("output_text, parsed")
    .eq("tenant_id", tenant_id)
    .eq("id", childId)
    .maybeSingle();
  const rawParsed = (ar as { parsed?: unknown } | null)?.parsed;
  return {
    output_text: (ar?.output_text as string | null) ?? null,
    parsed:
      rawParsed && typeof rawParsed === "object" && !Array.isArray(rawParsed)
        ? (rawParsed as Record<string, unknown>)
        : null,
  };
}

type RefineNode = { child_run_id?: string | null; payload?: { refine_mode?: unknown; republish?: unknown } };

export function directEditEnvelope(goalGraph: RefineNode[] | null | undefined): { output_text: string | null; parsed: Record<string, unknown> | null } {
  const payload = (goalGraph ?? [])[0]?.payload as { direct_text_edit?: unknown; direct_commit_sha?: unknown } | undefined;
  const sha = payload?.direct_text_edit === true ? validSha(payload.direct_commit_sha) : null;
  return { output_text: null, parsed: sha ? { commit_sha: sha, merged: true } : null };
}

async function refineEnvelope(
  tenant_id: string,
  goalGraph: RefineNode[] | null | undefined,
): Promise<{ output_text: string | null; parsed: Record<string, unknown> | null }> {
  const childId = (goalGraph ?? [])[0]?.child_run_id ?? null;
  return childId ? loadChildEnvelope(tenant_id, childId) : directEditEnvelope(goalGraph);
}

export function isChangeRunPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { refine_mode?: unknown; republish?: unknown };
  return p.refine_mode === true && p.republish !== true;
}

export function isPublishRunPayload(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && (payload as { republish?: unknown }).republish === true;
}

export function isNoChangeRunPayload(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && (payload as { no_change?: unknown }).no_change === true;
}

function isShippedRefineRow(r: { status: string; goal_graph: RefineNode[] | null }): boolean {
  const payload = (r.goal_graph ?? [])[0]?.payload;
  return r.status === "done" && isChangeRunPayload(payload) && !isNoChangeRunPayload(payload);
}

async function realLoadShippedRefineById(
  tenant_id: string,
  conductor_run_id: string,
): Promise<ShippedRefine | null> {
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("id, status, goal_graph, objective, created_at, updated_at")
    .eq("tenant_id", tenant_id)
    .eq("id", conductor_run_id)
    .maybeSingle();
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  const row = data as { id: string; status: string; goal_graph: RefineNode[] | null; objective: string | null; created_at: string | null; updated_at: string | null } | null;
  if (!row || !isShippedRefineRow(row)) return null;
  const childId = (row.goal_graph ?? [])[0]?.child_run_id ?? null;
  const env = await refineEnvelope(tenant_id, row.goal_graph);
  return {
    conductor_run_id: row.id,
    child_run_id: childId,
    message: row.objective,
    created_at: row.created_at,
    finished_at: row.updated_at,
    next_started_at: await realLoadNextBuildRunStart(tenant_id, row.created_at),
    awaiting_review: refineAwaitsReview(row.goal_graph, env.parsed?.merged === true),
    ...env,
  };
}

async function realLoadSiteOfRun(tenant_id: string, conductor_run_id: string): Promise<SiteRow | null> {
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("goal_graph")
    .eq("tenant_id", tenant_id)
    .eq("id", conductor_run_id)
    .maybeSingle();
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  const site_id = siteIdFromGraph((data as { goal_graph?: unknown } | null)?.goal_graph);
  if (!site_id) return null;
  const { siteStore } = await import("@/services/sites/store");
  return siteStore().get(tenant_id, site_id);
}

export async function realLoadLatestShippedRefineForSite(tenant_id: string, site_id: string): Promise<ShippedRefine | null> {
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("id, status, goal_graph, objective, created_at, updated_at")
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .eq("goal_graph->0->payload->>site_id", site_id)
    .eq("goal_graph->0->payload->>refine_mode", "true")
    .is("goal_graph->0->payload->>republish", null)
    .is("goal_graph->0->payload->>no_change", null)
    .eq("status", "done")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; status: string; goal_graph: RefineNode[] | null; objective: string | null; created_at: string | null; updated_at: string | null }>;
  const row = rows.find((r) => r.status === "done" && isShippedRefineRow(r) && siteIdFromGraph(r.goal_graph) === site_id);
  if (!row) return null;
  const childId = (row.goal_graph ?? [])[0]?.child_run_id ?? null;
  const env = await refineEnvelope(tenant_id, row.goal_graph);
  return {
    conductor_run_id: row.id,
    child_run_id: childId,
    message: row.objective,
    created_at: row.created_at,
    finished_at: row.updated_at,
    awaiting_review: refineAwaitsReview(row.goal_graph, env.parsed?.merged === true),
    ...env,
  };
}

async function realLoadEarliestShippedRefine(tenant_id: string): Promise<ShippedRefine | null> {
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("id, status, goal_graph, objective, created_at, updated_at")
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .eq("goal_graph->0->payload->>refine_mode", "true")
    .is("goal_graph->0->payload->>site_id", null)
    .eq("status", "done")
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; status: string; goal_graph: RefineNode[] | null; objective: string | null; created_at: string | null; updated_at: string | null }>;
  const first = rows.find(isShippedRefineRow);
  if (!first) return null;
  const childId = (first.goal_graph ?? [])[0]?.child_run_id ?? null;
  const env = await loadChildEnvelope(tenant_id, childId);
  return {
    conductor_run_id: first.id,
    child_run_id: childId,
    message: first.objective,
    created_at: first.created_at,
    finished_at: first.updated_at,
    next_started_at: await realLoadNextBuildRunStart(tenant_id, first.created_at),
    awaiting_review: refineAwaitsReview(first.goal_graph, env.parsed?.merged === true),
    ...env,
  };
}

type GraphNode = { checkpoint?: { commit_sha?: unknown } | null; payload?: Record<string, unknown> | null };

export function checkpointShaFromGraph(nodes: GraphNode[] | null | undefined): string | null {
  let sha: string | null = null;
  for (const n of nodes ?? []) {
    const v = validSha(n?.checkpoint?.commit_sha);
    if (v) sha = v;
  }
  return sha;
}

export function preRefineShaFromGraph(nodes: GraphNode[] | null | undefined): string | null {
  for (const n of nodes ?? []) {
    const v = validSha(n?.payload?.pre_refine_sha);
    if (v) return v;
  }
  return null;
}

async function realLoadBuildCheckpointSha(tenant_id: string, conductor_run_id: string): Promise<string | null> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("conductor_runs")
    .select("id, goal_graph, created_at")
    .eq("tenant_id", tenant_id)
    .eq("id", conductor_run_id)
    .maybeSingle();
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  const row = data as { goal_graph?: GraphNode[] | null; created_at?: string | null } | null;
  const own = checkpointShaFromGraph(row?.goal_graph);
  if (own) return own;
  const { data: later, error: laterErr } = await sb
    .from("conductor_runs")
    .select("id, goal_graph")
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .is("goal_graph->0->payload->>site_id", null)
    .gte("created_at", row?.created_at ?? "1970-01-01")
    .order("created_at", { ascending: true })
    .limit(200);
  if (laterErr) throw new Error(`conductor_runs read failed: ${laterErr.message}`);
  for (const r of (later ?? []) as Array<{ id: string; goal_graph?: GraphNode[] | null }>) {
    if (r.id === conductor_run_id) continue;
    if ((r.goal_graph ?? [])[0]?.payload?.refine_mode !== true) break;
    const pre = preRefineShaFromGraph(r.goal_graph);
    if (pre) return pre;
  }
  return null;
}

async function realLoadNextBuildRunStart(tenant_id: string, after: string | null): Promise<string | null> {
  if (!after) return null;
  const { data } = await serviceClient()
    .from("conductor_runs")
    .select("created_at")
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .is("goal_graph->0->payload->>site_id", null)
    .gt("created_at", after)
    .order("created_at", { ascending: true })
    .limit(1);
  const next = (data as Array<{ created_at?: string | null }> | null)?.[0]?.created_at;
  return typeof next === "string" ? next : null;
}

async function realLoadBuildRootRun(tenant_id: string, conductor_run_id: string): Promise<{ created_at: string | null } | null> {
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("id, kind, goal_graph, created_at")
    .eq("tenant_id", tenant_id)
    .eq("id", conductor_run_id)
    .maybeSingle();
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  const row = data as { kind?: string; goal_graph?: RefineNode[] | null; created_at?: string | null } | null;
  if (!row || row.kind !== "build_app") return null;
  if ((row.goal_graph ?? [])[0]?.payload?.refine_mode === true) return null;
  return { created_at: row.created_at ?? null };
}

export function undoRowVersionSha(payload: Record<string, unknown> | null | undefined): string | null {
  return validSha(payload?.stage === "undo" ? payload?.new_commit_sha : payload?.reverted_commit_sha);
}

async function realLoadRestoreRun(tenant_id: string, conductor_run_id: string): Promise<{ commit_sha: string; label: string } | null> {
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("id, kind, objective, goal_graph")
    .eq("tenant_id", tenant_id)
    .eq("id", conductor_run_id)
    .maybeSingle();
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  const row = data as { kind?: string; objective?: string | null; goal_graph?: GraphNode[] | null } | null;
  if (!row || row.kind !== "undo") return null;
  const payload = (row.goal_graph ?? [])[0]?.payload ?? null;
  const sha = undoRowVersionSha(payload);
  if (!sha) return null;
  const label = String(row.objective ?? "").replace(/^\[(restore|undo)\]\s*/i, "").trim();
  return { commit_sha: sha, label: label || "an earlier version" };
}

export async function realLoadProvisionedTarget(
  tenant_id: string,
): Promise<{ github_full_name: string; default_branch: string } | null> {
  const { data, error } = await serviceClient()
    .from("tenant_resources")
    .select("mode, external_ref")
    .eq("tenant_id", tenant_id)
    .eq("resource_kind", "repo")
    .maybeSingle();
  if (error) throw new Error(`tenant_resources(repo) read failed: ${error.message}`);
  if (!data || (data as { mode?: string }).mode !== "provisioned") return null;
  const ref = ((data as { external_ref?: Record<string, unknown> }).external_ref ?? {}) as {
    github_full_name?: string;
    default_branch?: string;
  };
  if (typeof ref.github_full_name !== "string" || !ref.github_full_name) return null;
  return {
    github_full_name: ref.github_full_name,
    default_branch:
      typeof ref.default_branch === "string" && ref.default_branch
        ? ref.default_branch
        : "main",
  };
}

async function realInsertUndoRun(params: {
  tenant_id: string;
  objective: string;
  parent_conductor_run_id: string;
  reverted_commit_sha: string;
  new_commit_sha: string;
  branch: string;
  kind?: "undo" | "restore";
  site_id?: string;
}): Promise<string> {
  const kind = params.kind ?? "undo";
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .insert({
      tenant_id: params.tenant_id,
      objective: params.objective,
      kind: "undo",
      status: "done",
      goal_graph: [
        {
          id: `${kind}-${Date.now().toString(36)}`,
          status: "done",
          payload: {
            stage: kind,
            refine_mode: false,
            parent_conductor_run_id: params.parent_conductor_run_id,
            reverted_commit_sha: params.reverted_commit_sha,
            new_commit_sha: params.new_commit_sha,
            branch: params.branch,
            ...(params.site_id ? { site_id: params.site_id } : {}),
          },
        },
      ],
      spend_usd: 0,
      max_usd: 0,
    })
    .select("id")
    .single();
  if (error) throw new Error(`conductor_runs insert failed: ${error.message}`);
  return (data as { id: string }).id;
}

export const UNDO_CLAIM_STATUS = "proposed";
export const UNDO_CLAIM_STALE_MS = 10 * 60 * 1000;

export function isStaleUndoClaim(
  row: { status: string; created_at?: string | null; goal_graph?: unknown[] | null },
  now: number = Date.now(),
): boolean {
  if (row.status !== UNDO_CLAIM_STATUS) return false;
  const payload = ((row.goal_graph ?? [])[0] as { payload?: { undo_claim?: unknown } } | undefined)?.payload;
  if (payload?.undo_claim !== true) return false;
  const at = row.created_at ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(at) && now - at > UNDO_CLAIM_STALE_MS;
}

function undoClaimGraph(params: UndoClaimParams, node_id: string, status: string, new_commit_sha: string | null) {
  return [
    {
      id: node_id,
      status,
      payload: {
        stage: "undo",
        refine_mode: false,
        undo_claim: true,
        parent_conductor_run_id: params.parent_conductor_run_id,
        reverted_commit_sha: params.reverted_commit_sha,
        new_commit_sha,
        branch: params.branch,
        ...(params.site_id ? { site_id: params.site_id } : {}),
        ...(params.site_id && params.preview_only ? { preview_only: true } : {}),
      },
    },
  ];
}

function undoClaimNodeId(id: string): string {
  return `undo-${id}`;
}

async function realClaimUndoRun(params: UndoClaimParams): Promise<string> {
  const sb = serviceClient();
  const { error: staleError } = await sb
    .from("conductor_runs")
    .update({ status: "failed", updated_at: new Date().toISOString() })
    .eq("tenant_id", params.tenant_id)
    .eq("kind", "undo")
    .eq("status", UNDO_CLAIM_STATUS)
    .lt("created_at", new Date(Date.now() - UNDO_CLAIM_STALE_MS).toISOString());
  if (staleError) throw new Error(`conductor_runs stale undo claim release failed: ${staleError.message}`);
  const { data, error } = await sb
    .from("conductor_runs")
    .insert({
      tenant_id: params.tenant_id,
      objective: params.objective,
      kind: "undo",
      status: UNDO_CLAIM_STATUS,
      goal_graph: undoClaimGraph(params, `undo-claim-${Date.now().toString(36)}`, UNDO_CLAIM_STATUS, null),
      spend_usd: 0,
      max_usd: 0,
    })
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new UndoBlocked("undo_in_progress", "this change is already being undone");
    }
    throw new Error(`conductor_runs undo claim failed: ${error.message}`);
  }
  return (data as { id: string }).id;
}

async function realSettleUndoRun(params: UndoClaimParams & { id: string; new_commit_sha: string }): Promise<void> {
  const { error } = await serviceClient()
    .from("conductor_runs")
    .update({
      status: "done",
      goal_graph: undoClaimGraph(params, undoClaimNodeId(params.id), "done", params.new_commit_sha),
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", params.tenant_id)
    .eq("id", params.id)
    .eq("status", UNDO_CLAIM_STATUS);
  if (error) throw new Error(`conductor_runs undo settle failed: ${error.message}`);
}

async function realReleaseUndoRun(params: { tenant_id: string; id: string }): Promise<void> {
  const { error } = await serviceClient()
    .from("conductor_runs")
    .update({ status: "failed", updated_at: new Date().toISOString() })
    .eq("tenant_id", params.tenant_id)
    .eq("id", params.id)
    .eq("status", UNDO_CLAIM_STATUS);
  if (error) throw new Error(`conductor_runs undo release failed: ${error.message}`);
}

async function realReadBranchHeadSha(params: {
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  branch: string;
}): Promise<string | null> {
  const { branches } = await listBranchesImpl(params.tenant_id, params.installation_id, {
    owner: params.owner,
    repo: params.repo,
    max_results: 100,
  });
  return branches.find((b) => b.name === params.branch)?.sha ?? null;
}

async function realListRecentCommits(params: {
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  branch: string;
  max_results: number;
}): Promise<Array<{ sha: string; message: string }>> {
  const { commits } = await listCommitsImpl(params.tenant_id, params.installation_id, {
    owner: params.owner,
    repo: params.repo,
    branch: params.branch,
    max_results: params.max_results,
  });
  return commits.map((c) => ({ sha: c.sha, message: c.message, author_date: (c as { author_date?: string }).author_date }));
}

export async function resolveInstallationForRepo(tenant_id: string, github_full_name?: string): Promise<number> {
  const owner = (github_full_name ?? "").split("/")[0];
  if (isProvisionedUmbrellaOwner(owner)) return AUTOPILOT_PAT_SENTINEL;
  return resolveInstallationId(tenant_id);
}

async function realListBranches(params: {
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
}): Promise<Array<{ name: string; sha: string }>> {
  const res = (await listBranchesImpl(params.tenant_id, params.installation_id, {
    owner: params.owner,
    repo: params.repo,
  } as Parameters<typeof listBranchesImpl>[2])) as { branches?: Array<{ name: string; sha: string }> };
  return (res.branches ?? []).map((b) => ({ name: b.name, sha: b.sha }));
}

export const MAX_BRANCH_CANDIDATES = 30;

export async function realDiscardHeldSlot(params: { tenant_id: string; conductor_run_id: string }): Promise<void> {
  const { error } = await serviceClient()
    .from("conductor_runs")
    .update({ kind: "undo", status: "failed", updated_at: new Date().toISOString() })
    .eq("tenant_id", params.tenant_id)
    .eq("id", params.conductor_run_id)
    .eq("kind", "build_app")
    .eq("status", "provisioning");
  if (error) throw new Error(`conductor_runs held slot discard failed: ${error.message}`);
}

const SITE_REPO_FULL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
export const SITE_PREVIEW_SYNC_TIMEOUT_MS = 60_000;

export type SitePreviewSyncDeps = {
  sandboxFor: (tenant_id: string, site_id: string) => Promise<SiteSandbox | null>;
  fetchToken: () => string | null;
  kickPreview: (tenant_id: string, github_full_name: string) => Promise<void> | void;
  previewChanged?: (tenant_id: string, site_id: string) => Promise<void>;
};

async function realSitePreviewSyncDeps(): Promise<SitePreviewSyncDeps> {
  const [{ createSiteSandboxResolver }, { siteStore }, { kickSandboxPreview }] = await Promise.all([
    import("@/services/sites/sandbox-resolver"),
    import("@/services/sites/store"),
    import("@/services/agents/conductor-driver"),
  ]);
  return {
    previewChanged: async (tenant_id, site_id) => (await import("@/services/sites/site-preview-snapshot-capture")).notePreviewChanged(tenant_id, site_id),
    sandboxFor: (tenant_id, site_id) => createSiteSandboxResolver({ store: siteStore() }).forSite(tenant_id, site_id),
    fetchToken: () => process.env.GITHUB_PROVISION_TOKEN?.trim() || null,
    kickPreview: (tenant_id, github_full_name) =>
      kickSandboxPreview({ tenant_id, node: { payload: { target: { github_full_name } } } as unknown as ConductorNode, site: true }),
  };
}

export async function syncSitePreviewToCommit(
  params: { tenant_id: string; site: SiteRow; sha: string },
  injected?: SitePreviewSyncDeps,
): Promise<void> {
  const repo = (params.site.github_full_name ?? "").trim();
  const sha = validSha(params.sha)?.toLowerCase() ?? null;
  if (!SITE_REPO_FULL_RE.test(repo) || !sha) throw new Error("site preview sync: invalid repo or commit");
  const deps = injected ?? (await realSitePreviewSyncDeps());
  const sandbox = await deps.sandboxFor(params.tenant_id, params.site.id);
  if (!sandbox) {
    await deps.previewChanged?.(params.tenant_id, params.site.id).catch(() => undefined);
    return;
  }
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  const redact: string[] = [];
  const token = deps.fetchToken();
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
    redact.push(token, basic);
  }
  const r = await sandbox.run(
    [
      `{ git cat-file -e ${sha}^{commit} 2>/dev/null || git fetch --quiet --no-tags https://github.com/${repo}.git ${sha}; }`,
      `git checkout -q -f -B main ${sha}`,
      `git reset -q --hard ${sha}`,
      `git clean -fdq`,
      `echo "__head=$(git rev-parse HEAD)"`,
    ].join(" && "),
    { cwd: SITE_REPO_DIR, timeoutMs: SITE_PREVIEW_SYNC_TIMEOUT_MS, env, redact },
  );
  if (r.exitCode !== 0) throw new Error(`site preview sync: git failed (exit ${r.exitCode}): ${(r.stderr ?? "").slice(0, 300)}`);
  const head = (r.stdout.match(/^__head=([0-9a-f]+)$/m)?.[1] ?? "").toLowerCase();
  if (!head.startsWith(sha)) {
    throw new Error(`site preview sync: HEAD mismatch (expected ${sha.slice(0, 7)}, got ${head.slice(0, 7) || "<none>"})`);
  }
  await deps.previewChanged?.(params.tenant_id, params.site.id).catch(() => undefined);
  void Promise.resolve()
    .then(() => deps.kickPreview(params.tenant_id, repo))
    .catch(() => undefined);
}

async function realSyncSitePreview(params: { tenant_id: string; site: SiteRow; sha: string }): Promise<void> {
  await syncSitePreviewToCommit(params);
}

export const realRefineUndoDeps: RefineUndoDeps = {
  isOnDefaultBranch: realIsOnDefaultBranch,
  loadLatestShippedRefine: realLoadLatestShippedRefine,
  loadProvisionedTarget: realLoadProvisionedTarget,
  assertProvisionedRepo: realProvisionedRepoGateDeps,
  resolveInstallation: resolveInstallationForRepo,
  readBranchHeadSha: realReadBranchHeadSha,
  listRecentCommits: realListRecentCommits,
  listBranches: realListBranches,
  revertOnMain: revertCommitOnMain,
  insertUndoRun: realInsertUndoRun,
  loadShippedRefineById: realLoadShippedRefineById,
  loadEarliestShippedRefine: realLoadEarliestShippedRefine,
  loadBuildCheckpointSha: realLoadBuildCheckpointSha,
  loadBuildRootRun: realLoadBuildRootRun,
  loadRestoreRun: realLoadRestoreRun,
  readCommitParentSha,
  restoreOnMain: restoreCommitOnMain,
  hasActiveBuild: async (tenant_id) => {
    const { realLiveEditDeps } = await import("@/services/build/live-edit");
    return realLiveEditDeps.hasActiveBuild(tenant_id);
  },
  readBranchRefSha: readBranchSha,
  claimUndoRun: realClaimUndoRun,
  settleUndoRun: realSettleUndoRun,
  releaseUndoRun: realReleaseUndoRun,
  checkLiveEditDraft: async (tenant_id) => {
    const { checkDraftBeforeUndo } = await import("@/services/build/live-edit");
    return checkDraftBeforeUndo(tenant_id);
  },
  resetLiveEditDraft: async (tenant_id, new_main_sha) => {
    const { resetDraftAfterUndo } = await import("@/services/build/live-edit");
    return resetDraftAfterUndo(tenant_id, new_main_sha);
  },
  loadSiteOfRun: realLoadSiteOfRun,
  loadLatestShippedRefineForSite: realLoadLatestShippedRefineForSite,
  siteRepublish: {
    reserve: async (input) => (await import("@/services/agents/refine-product")).realSiteRepublisher.reserve(input),
    stage: async (input) => (await import("@/services/agents/refine-product")).realSiteRepublisher.stage(input),
    start: async (input) => (await import("@/services/agents/refine-product")).realSiteRepublisher.start(input),
    release: async (input) => (await import("@/services/agents/refine-product")).realSiteRepublisher.release(input),
  },
  resolveBuildPublishOnRequest: async (tenant_id) => {
    const { getBoolSetting } = await import("@/services/settings");
    return getBoolSetting("build_publish_on_request", tenant_id);
  },
  discardHeldSlot: realDiscardHeldSlot,
  syncSitePreview: realSyncSitePreview,
  markPreviewStale: async (tenant_id, site_id) => {
    await (await import("@/services/sites/site-preview-snapshot")).sitePreviewSnapshotStore().markChanged(tenant_id, site_id);
  },
  claimSiteEditLease: (tenant_id, site_id) => claimSiteEditLease(tenant_id, site_id),
};

const SHA_RE = /^[0-9a-f]{7,40}$/i;

function validSha(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const sha = raw.trim();
  return SHA_RE.test(sha) ? sha : null;
}

export function extractCommitSha(output: string | null): string | null {
  if (!output || typeof output !== "string") return null;
  const m = output.match(/<pr_proposal>\s*(\{[\s\S]*?\})\s*<\/pr_proposal>/i);
  if (!m) return null;
  try {
    const env = JSON.parse(m[1]) as { commit_sha?: unknown; sha?: unknown };
    return validSha(env.commit_sha) ?? validSha(env.sha);
  } catch {
    return null;
  }
}

export function extractShippedCommitSha(
  parsed: Record<string, unknown> | null,
  output_text: string | null,
): string | null {
  return validSha(parsed?.commit_sha) ?? extractCommitSha(output_text);
}

const FALLBACK_COMMIT_WINDOW = 30;

async function resolveShaViaBranchLookup(args: {
  deps: RefineUndoDeps;
  parsed: Record<string, unknown> | null;
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  github_full_name: string;
  default_branch: string;
  run?: { created_at?: string | null; finished_at?: string | null; next_started_at?: string | null } | null;
}): Promise<string | null> {
  const parsed = args.parsed;
  const envelopeRepo = typeof parsed?.repo === "string" ? parsed.repo.trim() : "";
  const headBranch =
    typeof parsed?.head_branch === "string" ? parsed.head_branch.trim() : "";
  const hasWindow = !!args.run?.created_at && !!args.run?.finished_at;
  if (!hasWindow && (!envelopeRepo || !headBranch)) return null;
  if (envelopeRepo && envelopeRepo !== args.github_full_name) return null;
  try {
    const commits = await args.deps.listRecentCommits({
      tenant_id: args.tenant_id,
      installation_id: args.installation_id,
      owner: args.owner,
      repo: args.repo,
      branch: args.default_branch,
      max_results: FALLBACK_COMMIT_WINDOW,
    });
    const onDefaultBranch = new Set(commits.map((c) => c.sha));
    const branchSha = headBranch
      ? validSha(
          await args.deps.readBranchHeadSha({
            tenant_id: args.tenant_id,
            installation_id: args.installation_id,
            owner: args.owner,
            repo: args.repo,
            branch: headBranch,
          }),
        )
      : null;
    if (branchSha && onDefaultBranch.has(branchSha)) return branchSha;
    const title =
      typeof parsed?.title === "string"
        ? (parsed.title.split("\n")[0] ?? "").trim()
        : "";
    if (title) {
      const hit = commits.find((c) => (c.message ?? "").trim() === title);
      if (hit) return validSha(hit.sha);
    }
    if (hasWindow) {
      const onMain = commitShaInRunWindow(commits, args.run!);
      if (onMain) return onMain;
      if (args.deps.listBranches) {
        const branches = (
          await args.deps.listBranches({
            tenant_id: args.tenant_id,
            installation_id: args.installation_id,
            owner: args.owner,
            repo: args.repo,
          })
        )
          .filter((b) => b.name !== args.default_branch && !onDefaultBranch.has(b.sha))
          .slice(0, MAX_BRANCH_CANDIDATES);
        const heads: Array<{ sha: string; author_date?: string }> = [];
        for (const b of branches) {
          const head = await args.deps.listRecentCommits({
            tenant_id: args.tenant_id,
            installation_id: args.installation_id,
            owner: args.owner,
            repo: args.repo,
            branch: b.name,
            max_results: 1,
          });
          if (head[0]) heads.push(head[0]);
        }
        return commitShaInRunWindow(heads, args.run!);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function refineUndo(
  input: RefineUndoInput,
  deps: RefineUndoDeps = realRefineUndoDeps,
): Promise<RefineUndoResult> {
  const tenant_id = (input.tenant_id ?? "").trim();
  if (!tenant_id) throw new Error("refineUndo: tenant_id is required");

  let site: SiteRow | null = null;
  const pinned = (input.conductor_run_id ?? "").trim();
  if (pinned && deps.loadSiteOfRun) site = await deps.loadSiteOfRun(tenant_id, pinned);
  if (site && input.workspace_only) throw new NoUndoableRefine(tenant_id);
  if (site) return refineUndoSite(tenant_id, site, pinned, deps);

  const latest = await deps.loadLatestShippedRefine(tenant_id);
  if (!latest) throw new NoUndoableRefine(tenant_id);
  if (!pinned && deps.loadSiteOfRun) {
    site = await deps.loadSiteOfRun(tenant_id, latest.conductor_run_id);
    if (site && input.workspace_only) throw new NoUndoableRefine(tenant_id);
    if (site) return refineUndoSite(tenant_id, site, "", deps);
  }
  throw new OldSiteFrozen(tenant_id);
}

async function undoStopsAtPreview(deps: RefineUndoDeps, tenant_id: string): Promise<boolean> {
  if (!deps.resolveBuildPublishOnRequest) return false;
  try {
    return (await deps.resolveBuildPublishOnRequest(tenant_id)) === true;
  } catch {
    return true;
  }
}

function sameCommit(head: string, sha: string): boolean {
  const h = head.trim().toLowerCase();
  const c = sha.trim().toLowerCase();
  return c.length > 0 && h.startsWith(c);
}

async function refineUndoSite(
  tenant_id: string,
  site: SiteRow,
  pinned_refine_id: string,
  deps: RefineUndoDeps,
): Promise<RefineUndoResult> {
  const lease: { release?: () => Promise<void> } = {};
  try {
    return await refineUndoSiteLeased(tenant_id, site, pinned_refine_id, deps, lease);
  } finally {
    if (lease.release) await lease.release().catch(() => undefined);
  }
}

async function refineUndoSiteLeased(
  tenant_id: string,
  site: SiteRow,
  pinned_refine_id: string,
  deps: RefineUndoDeps,
  lease: { release?: () => Promise<void> },
): Promise<RefineUndoResult> {
  if (site.tenant_id !== tenant_id) throw new NotProvisioned("site does not belong to tenant");
  if (!site.github_full_name || ["failed", "fell_back_old", "deleting", "deleted"].includes(site.status)) {
    throw new NotProvisioned("the site has no publishable repo");
  }
  if (!deps.loadLatestShippedRefineForSite || !deps.siteRepublish) {
    throw new NotProvisioned("site undo is not available");
  }
  const claimed = await deps.claimSiteEditLease?.(tenant_id, site.id);
  if (claimed && "held" in claimed) {
    throw new UndoBlocked(
      "build_in_progress",
      claimed.held === "edit" ? "a change to this site is starting; undo once it is done" : "this site's preview is restarting; undo once it is back",
    );
  }
  if (claimed) lease.release = claimed.release;
  const latest = await deps.loadLatestShippedRefineForSite(tenant_id, site.id);
  if (!latest) throw new NoUndoableRefine(tenant_id);
  if (latest.awaiting_review) throw new ChangeAwaitingApproval();
  if (pinned_refine_id && pinned_refine_id !== latest.conductor_run_id && pinned_refine_id !== site.root_conductor_run_id) {
    throw new NoUndoableRefine(tenant_id);
  }
  const github_full_name = site.github_full_name;
  const default_branch = "main";
  const gate = await assertProvisionedRepoTarget(tenant_id, github_full_name, deps.assertProvisionedRepo);
  if (!gate.ok) throw new NotProvisioned(gate.reason);
  const gateSite = (gate as { site_id?: string }).site_id;
  if (gateSite && gateSite !== site.id) throw new NotProvisioned("repo belongs to another site");
  const installation_id = await deps.resolveInstallation(tenant_id, github_full_name);
  const [owner, repo] = github_full_name.split("/");
  if (!owner || !repo) throw new NotProvisioned("invalid github_full_name");

  let reverted_commit_sha = extractShippedCommitSha(latest.parsed, latest.output_text);
  if (!reverted_commit_sha) {
    reverted_commit_sha = await resolveShaViaBranchLookup({
      deps,
      parsed: latest.parsed,
      tenant_id,
      installation_id,
      owner,
      repo,
      github_full_name,
      default_branch,
    });
  }
  if (!reverted_commit_sha) throw new NoUndoableRefine(tenant_id);
  await assertNotUnpublishedDraft(deps, latest.parsed, {
    tenant_id,
    installation_id,
    owner,
    repo,
    sha: reverted_commit_sha,
    default_branch,
  });

  return guardedSiteUndo(deps, {
    tenant_id,
    site,
    installation_id,
    owner,
    repo,
    default_branch,
    parent_conductor_run_id: latest.conductor_run_id,
    reverted_commit_sha,
  });
}

async function guardedSiteUndo(
  deps: RefineUndoDeps,
  a: {
    tenant_id: string;
    site: SiteRow;
    installation_id: number;
    owner: string;
    repo: string;
    default_branch: string;
    parent_conductor_run_id: string;
    reverted_commit_sha: string;
  },
): Promise<RefineUndoResult> {
  const { tenant_id, site, installation_id, owner, repo, default_branch, reverted_commit_sha } = a;
  const republisher = deps.siteRepublish!;
  const readHead = deps.readBranchRefSha ?? deps.readBranchHeadSha;
  const { claimUndoRun, settleUndoRun, releaseUndoRun } = deps;
  if (!claimUndoRun || !settleUndoRun || !releaseUndoRun) {
    throw new NotProvisioned("site undo is not available");
  }

  const previewOnly = await undoStopsAtPreview(deps, tenant_id);
  let republish_run_id: string;
  try {
    republish_run_id = await republisher.reserve({ tenant_id, site });
  } catch (e) {
    if ((e as Error | null)?.name === "DoubleBuildInFlight") {
      throw new UndoBlocked("build_in_progress", "a change or build is still running; wait for it to finish");
    }
    throw e;
  }
  const releaseSlot = async () => {
    if (previewOnly && deps.discardHeldSlot) {
      try {
        await deps.discardHeldSlot({ tenant_id, conductor_run_id: republish_run_id });
        return;
      } catch (e) {
        console.warn(`[refine-undo] held slot ${republish_run_id} not discarded tenant=${tenant_id}: ${(e as Error)?.message ?? e}`);
      }
    }
    await republisher.release({ tenant_id, conductor_run_id: republish_run_id }).catch((e: unknown) => {
      console.warn(`[refine-undo] republish slot ${republish_run_id} not released tenant=${tenant_id}: ${(e as Error)?.message ?? e}`);
    });
  };

  if (!previewOnly) try {
    await republisher.stage({ tenant_id, conductor_run_id: republish_run_id, site });
  } catch (e) {
    await releaseSlot();
    throw e;
  }

  let head: string | null;
  try {
    head = await readHead({ tenant_id, installation_id, owner, repo, branch: default_branch });
  } catch (e) {
    await releaseSlot();
    throw e;
  }
  if (!head || !sameCommit(head, reverted_commit_sha)) {
    await releaseSlot();
    throw new UndoBlocked("newer_change", "the site changed after this edit, so undoing it would also remove the newer change");
  }

  const claim: UndoClaimParams = {
    tenant_id,
    objective: `[undo] revert ${reverted_commit_sha.slice(0, 7)}`.slice(0, 500),
    parent_conductor_run_id: a.parent_conductor_run_id,
    reverted_commit_sha,
    branch: default_branch,
    site_id: site.id,
    ...(previewOnly ? { preview_only: true } : {}),
  };
  let claimId: string;
  try {
    claimId = await claimUndoRun(claim);
  } catch (e) {
    await releaseSlot();
    throw e;
  }

  let revert: { reverted: true; branch: string; new_commit_sha: string };
  try {
    revert = await deps.revertOnMain({
      tenant_id,
      installation_id,
      owner,
      repo,
      base_branch: default_branch,
      commit_sha: reverted_commit_sha,
      expected_head_sha: head,
    });
  } catch (e) {
    await releaseUndoRun({ tenant_id, id: claimId }).catch((relErr: unknown) => {
      console.warn(`[refine-undo] undo claim ${claimId} not released tenant=${tenant_id}: ${(relErr as Error)?.message ?? relErr}`);
    });
    await releaseSlot();
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "revert_head_moved" || code === "fast_forward_rejected") {
      throw new UndoBlocked("newer_change", "the site changed while undoing, so nothing was undone");
    }
    throw e;
  }

  let history_recorded = true;
  try {
    await settleUndoRun({ ...claim, branch: revert.branch, id: claimId, new_commit_sha: revert.new_commit_sha });
  } catch (e) {
    history_recorded = false;
    console.warn(
      `[refine-undo] commit ${revert.new_commit_sha.slice(0, 7)} is on ${owner}/${repo}@${revert.branch} but site undo row ${claimId} was not settled: ${(e as Error)?.message ?? e}`,
    );
  }
  let republished = false;
  let preview_stale = false;
  let republish_pending = false;
  if (previewOnly) {
    try {
      if (!deps.syncSitePreview) throw new Error("preview sync is not wired");
      await deps.syncSitePreview({ tenant_id, site, sha: revert.new_commit_sha });
    } catch (e) {
      preview_stale = true;
      console.warn(`[refine-undo] site ${site.id} preview not moved to ${revert.new_commit_sha.slice(0, 7)} tenant=${tenant_id}: ${(e as Error)?.message ?? e}`);
      await deps.markPreviewStale?.(tenant_id, site.id).catch((markErr: unknown) => {
        console.warn(`[refine-undo] site ${site.id} snapshot not marked stale tenant=${tenant_id}: ${(markErr as Error)?.message ?? markErr}`);
      });
    }
    await releaseSlot();
  } else {
    republished = true;
  let stagedRun: string | null = republish_run_id;
  try {
    try {
      await republisher.start({ tenant_id, conductor_run_id: republish_run_id, site, sha: revert.new_commit_sha });
    } catch (e) {
      if ((e as Error | null)?.name !== "SiteRepublishGone") throw e;
      stagedRun = null;
      const fresh = await republisher.reserve({ tenant_id, site });
      try {
        await republisher.stage({ tenant_id, conductor_run_id: fresh, site });
      } catch (stageErr) {
        await republisher.release({ tenant_id, conductor_run_id: fresh }).catch(() => undefined);
        throw stageErr;
      }
      stagedRun = fresh;
      await republisher.start({ tenant_id, conductor_run_id: fresh, site, sha: revert.new_commit_sha });
    }
  } catch (e) {
    republished = false;
    republish_pending = stagedRun !== null && (e as Error | null)?.name !== "SiteRepublishGone";
    console.error(
      JSON.stringify({
        evt: republish_pending ? "site_undo.republish_deferred" : "site_undo.republish_lost",
        tenant_id,
        site_id: site.id,
        conductor_run_id: stagedRun ?? republish_run_id,
        new_commit_sha: revert.new_commit_sha,
        error: String((e as Error)?.message ?? e).slice(0, 300),
      }),
    );
  }

  }

  return {
    undo_conductor_run_id: claimId,
    reverted_conductor_run_id: a.parent_conductor_run_id,
    reverted_commit_sha,
    new_commit_sha: revert.new_commit_sha,
    branch: revert.branch,
    republished,
    republish_pending,
    history_recorded,
    draft_reset: true,
    ...(previewOnly ? { preview_only: true as const } : {}),
    ...(preview_stale ? { preview_stale: true as const } : {}),
  };
}

async function resolveRefineSha(args: {
  deps: RefineUndoDeps;
  refine: ShippedRefine;
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  github_full_name: string;
  default_branch: string;
}): Promise<string | null> {
  const stamped = extractShippedCommitSha(args.refine.parsed, args.refine.output_text);
  if (stamped) return stamped;
  return resolveShaViaBranchLookup({
    deps: args.deps,
    parsed: args.refine.parsed,
    tenant_id: args.tenant_id,
    installation_id: args.installation_id,
    owner: args.owner,
    repo: args.repo,
    github_full_name: args.github_full_name,
    default_branch: args.default_branch,
    run: { created_at: args.refine.created_at, finished_at: args.refine.finished_at, next_started_at: args.refine.next_started_at },
  });
}

export async function resolveVersionCommit(
  input: RefineRestoreInput,
  deps: RefineUndoDeps = realRefineUndoDeps,
): Promise<VersionCommit> {
  const tenant_id = (input.tenant_id ?? "").trim();
  const conductor_run_id = (input.conductor_run_id ?? "").trim();
  if (!tenant_id) throw new Error("refineRestore: tenant_id is required");
  if (!conductor_run_id) throw new Error("refineRestore: conductor_run_id is required");
  const loadById = deps.loadShippedRefineById;
  const loadEarliest = deps.loadEarliestShippedRefine;
  const readParent = deps.readCommitParentSha;
  const restoreOnMain = deps.restoreOnMain;
  if (!loadById || !loadEarliest || !readParent || !restoreOnMain) {
    throw new Error("refineRestore: restore deps are not wired");
  }
  if (deps.loadSiteOfRun) {
    const site = await deps.loadSiteOfRun(tenant_id, conductor_run_id);
    if (site && site.status !== "fell_back_old") {
      throw new NotProvisioned("restoring an earlier version is not available for this site yet");
    }
  }

  const target = await deps.loadProvisionedTarget(tenant_id);
  if (!target) throw new NotProvisioned("no provisioned repo for tenant");
  const gate = await assertProvisionedRepoTarget(tenant_id, target.github_full_name, deps.assertProvisionedRepo);
  if (!gate.ok) throw new NotProvisioned(gate.reason);
  const installation_id = await deps.resolveInstallation(tenant_id, target.github_full_name);
  const [owner, repo] = target.github_full_name.split("/");
  if (!owner || !repo) throw new NotProvisioned("invalid github_full_name");
  const shaArgs = { deps, tenant_id, installation_id, owner, repo, github_full_name: target.github_full_name, default_branch: target.default_branch };

  let commit_sha: string | null = null;
  let label = "";
  const refine = await loadById(tenant_id, conductor_run_id);
  const restored = refine || !deps.loadRestoreRun ? null : await deps.loadRestoreRun(tenant_id, conductor_run_id);
  if (refine) {
    if (input.purpose === "restore" && refine.awaiting_review) throw new ChangeAwaitingApproval();
    commit_sha = await resolveRefineSha({ ...shaArgs, refine });
    if (!commit_sha) throw new NothingToRestore("that version's commit could not be found");
    if (input.purpose === "restore") {
      await assertNotUnpublishedDraft(deps, refine.parsed, {
        tenant_id,
        installation_id,
        owner,
        repo,
        sha: commit_sha,
        default_branch: target.default_branch,
      });
    }
    label = refine.message ?? "";
  } else if (restored) {
    commit_sha = restored.commit_sha;
    label = restored.label;
  } else {
    if (deps.loadBuildRootRun) {
      const root = await deps.loadBuildRootRun(tenant_id, conductor_run_id);
      if (!root) throw new NothingToRestore("that version no longer exists");
    }
    label = "the original build";
    commit_sha = deps.loadBuildCheckpointSha
      ? await deps.loadBuildCheckpointSha(tenant_id, conductor_run_id)
      : null;
    if (!commit_sha) {
      const earliest = await loadEarliest(tenant_id);
      if (!earliest) {
        throw new NothingToRestore("the app has not changed since it was built");
      }
      const earliestSha = await resolveRefineSha({ ...shaArgs, refine: earliest });
      if (!earliestSha) throw new NothingToRestore("the original build's commit could not be found");
      commit_sha = await readParent({ tenant_id, installation_id, owner, repo, commit_sha: earliestSha });
      if (!commit_sha) throw new NothingToRestore("the original build has no commit to go back to");
    }
  }

  return {
    commit_sha,
    label,
    target: { github_full_name: target.github_full_name, default_branch: target.default_branch },
    installation_id,
  };
}

export async function refineRestore(
  input: RefineRestoreInput,
  deps: RefineUndoDeps = realRefineUndoDeps,
): Promise<RefineRestoreResult> {
  const tenant_id = (input.tenant_id ?? "").trim();
  const conductor_run_id = (input.conductor_run_id ?? "").trim();
  if (!tenant_id) throw new Error("refineRestore: tenant_id is required");
  if (!conductor_run_id) throw new Error("refineRestore: conductor_run_id is required");
  if (deps.loadSiteOfRun) {
    const site = await deps.loadSiteOfRun(tenant_id, conductor_run_id);
    if (site && site.status !== "fell_back_old") {
      throw new NotProvisioned("restoring an earlier version is not available for this site yet");
    }
  }
  throw new OldSiteFrozen(tenant_id);
}
