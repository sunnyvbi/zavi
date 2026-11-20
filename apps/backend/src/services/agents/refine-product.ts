
import { designBriefFromGraph } from "@/services/sites/site-brief-context";
import { siteDesignStore } from "@/services/sites/site-design-store";
import { briefForChosenLook } from "@/services/sites/design-directions";
import { classifySiteEdit, type SiteEditSize } from "@/services/sites/site-edit-route";
import { carriesWorkspacePhotos } from "./app-edit-intent";
import { ownChatImagePaths } from "@/services/workspace-files/site-photos";
import { MAX_REFINE_IMAGES } from "./refine-request-images";
import { userRequestFor } from "./refine-display";
import { MAX_SCOPED_MESSAGE, type SelectedElementScope } from "@/services/sites/selected-element";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { UNDO_CLAIM_STALE_MS, UNDO_CLAIM_STATUS } from "@/services/agents/refine-undo";
import { resolveDailyCapUsd } from "@/services/agents/budget";
import { readProvisionedRepoHeadSha } from "@/services/provisioning/github-repo";
import { OldSiteFrozen } from "@/services/sites/old-site-freeze";
import { loadTenantAppPolicy } from "@/services/agents/pipeline-policy-store";
import { buildDatabaseReclaimed, NON_REFINE_BUILD_FILTER } from "@/services/autopilot/build-liveness";
import {
  DEFAULT_APP_PIPELINE_POLICY,
  type AppPipelinePolicy,
} from "@/services/agents/pipeline-policy";
import { SITE_FIRST_PUBLISH_FIX_ESTIMATE_USD, type ConductorNode } from "@/services/agents/conductor";
import { stampConductorOwner } from "@/services/agents/conductor-owner";
import type { SiteRow } from "@/services/sites/contract";
import { siteBackendKindOf, type SiteBackendKind } from "@/services/sites/site-backend";
import {
  rowHasSiteMarker,
  SITE_MARKER_SELECT,
  siteIdFromGraph,
  siteIdFromMarkerRow,
} from "@/services/sites/site-run";
import {
  assertRefineCreditsAvailable,
  InsufficientCreditsForBuild,
  makeBalanceReader,
  type BalanceState,
} from "@/services/agents/build-credit-preflight";
import { TIER_PRICE_USD } from "@/services/billing/tiers";
import type { ProvisionedTarget } from "@/services/agents/autopilot-pipeline-contract";
import {
  AUTOPILOT_BUILD_STACK,
  STAGE_AGENT,
} from "@/services/agents/autopilot-pipeline-contract";
import {
  DEFAULT_PRODUCT_BUILD_MAX_USD,
  MAX_PRODUCT_BUILD_MAX_USD,
  PRODUCT_BUILD_PROVISION_ESTIMATE_USD,
  MAX_PRODUCT_REFINES_PER_DAY,
  ProvisionBudgetExceeded,
  DoubleBuildInFlight,
  TooManyBuildsToday,
} from "@/services/agents/start-product-build";
import { claimSiteEditLease, type SiteEditLease } from "@/services/sites/site-preview-lease";

export const DEFAULT_REFINE_MAX_USD = 5;

const REFINE_PROVISION_ESTIMATE_USD = 0;

export const SITE_FAST_EDIT_ESTIMATE_USD = 0.5;

export class NoProvisionedRepo extends Error {
  constructor(public readonly tenant_id: string) {
    super(
      "no provisioned product to refine — build a product first via /api/workspace/autopilot/build-product",
    );
    this.name = "NoProvisionedRepo";
  }
}

export class ConductorRunNotFound extends Error {
  constructor(public readonly conductor_run_id: string) {
    super(`conductor_run ${conductor_run_id} not found for this tenant`);
    this.name = "ConductorRunNotFound";
  }
}

export class BuildRetired extends Error {
  constructor(public readonly tenant_id: string) {
    super("This app was retired. Start a new build to keep going.");
    this.name = "BuildRetired";
  }
}

export class FleetHalted extends Error {
  constructor() {
    super("the platform is globally halted — new refines are paused");
    this.name = "FleetHalted";
  }
}

export class AppFrozen extends Error {
  constructor(public readonly tenant_id: string) {
    super("this app's pipeline is frozen — refines are paused for it");
    this.name = "AppFrozen";
  }
}

export class SiteRequired extends Error {
  constructor(
    public readonly tenant_id: string,
    public readonly reason: "ambiguous" | "unreadable",
  ) {
    super(
      reason === "ambiguous"
        ? "This workspace has more than one site. Open the site you want to change under Build and ask there."
        : "We couldn't check which site to change just now, so nothing was started. Try again in a moment.",
    );
    this.name = "SiteRequired";
  }
}

export class SiteUnavailable extends Error {
  constructor(
    public readonly site_id: string,
    public readonly status: string,
  ) {
    super(
      status === "failed"
        ? "This site's build didn't finish, so it can't be changed. Start a new build to try again."
        : "This site is being deleted, so it can't be changed.",
    );
    this.name = "SiteUnavailable";
  }
}

export class SitePreviewRestarting extends Error {
  constructor(public readonly site_id: string) {
    super("this site's preview is restarting; send your change once it is back");
    this.name = "SitePreviewRestarting";
  }
}

export class UndoInProgress extends Error {
  constructor(public readonly tenant_id: string) {
    super("an undo is still running for this app; wait for it to finish, then send your change");
    this.name = "UndoInProgress";
  }
}

export class InvalidRefineMessage extends Error {
  constructor(public readonly reason: "empty" | "too_short" | "too_long") {
    super(
      reason === "empty" || reason === "too_short"
        ? "describe what you want changed in at least 8 characters"
        : "refine message exceeds 4000 chars",
    );
    this.name = "InvalidRefineMessage";
  }
}

export const FREE_EDITS_LIMIT = 2;

export class FreeEditsUsed extends Error {
  public readonly limit = FREE_EDITS_LIMIT;
  constructor() {
    super(
      `You've used your ${FREE_EDITS_LIMIT} free edits. Editing your app needs Starter ($${TIER_PRICE_USD.starter}/mo), or buy credits.`,
    );
    this.name = "FreeEditsUsed";
  }
}

export class PhotoRetryTaken extends Error {
  constructor() {
    super("That free photo retry was just used. Send it again to run it as a normal change.");
    this.name = "PhotoRetryTaken";
  }
}

export type FreeEditState = {
  applies: boolean;
  used: number;
  limit: number;
  retry_waived: boolean;
};

export type RefineProductInput = {
  tenant_id: string;
  message: string;
  request?: string | null;
  retry_of?: string | null;
  small_edit?: boolean;
  conductor_run_id?: string | null;
  source_suggestion_id?: string | null;
  max_usd?: number | null;
  remediation_attempt?: number | null;
  chat_thread_id?: string | null;
  photo_paths?: ReadonlyArray<string> | null;
  image_paths?: ReadonlyArray<string> | null;
  selected_element?: SelectedElementScope | null;
  singleton_app?: boolean;
  site_inline_edits?: ReadonlyArray<SiteInlineEditRef> | null;
  photo_retry?: boolean;
};

export type SiteInlineEditRef = { id: string; updated_at: string };

const SITE_INLINE_EDITS_MAX = 200;

function siteInlineEditRefs(v: unknown): SiteInlineEditRef[] {
  if (!Array.isArray(v)) return [];
  const out: SiteInlineEditRef[] = [];
  for (const r of v) {
    const id = (r as { id?: unknown } | null)?.id;
    const updated_at = (r as { updated_at?: unknown } | null)?.updated_at;
    if (typeof id !== "string" || !id || typeof updated_at !== "string" || !updated_at) continue;
    out.push({ id, updated_at });
    if (out.length >= SITE_INLINE_EDITS_MAX) break;
  }
  return out;
}

export type RefineProductResult = {
  conductor_run_id: string;
  parent_conductor_run_id: string | null;
  target: ProvisionedTarget;
  direct_merge_enabled: boolean;
  site_id: string;
  stop_at_preview?: boolean;
};

export async function siteChangesWaitForPublish(
  tenant_id: string,
  resolve: ((tenant_id: string) => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (!resolve) return false;
  try {
    return (await resolve(tenant_id)) === true;
  } catch {
    return true;
  }
}

export type PriorRefineTurn = {
  message: string;
  status: string;
  outcome?: string;
};

export type RefineDiffSummary = {
  summary: string | null;
  commit_sha: string | null;
  pr_url: string | null;
  files_changed: number;
  file_paths: string[];
  actions: { create: number; modify: number; delete: number };
};

export const REFINE_DIFF_SUMMARY_MAX_PATHS = 25;

export function extractRefineDiffSummary(
  output: string | null | undefined,
): RefineDiffSummary | null {
  if (!output || typeof output !== "string") return null;
  const m = output.match(/<pr_proposal>\s*(\{[\s\S]*?\})\s*<\/pr_proposal>/i);
  if (!m) return null;
  let env: {
    summary?: unknown;
    commit_sha?: unknown;
    sha?: unknown;
    pr_url?: unknown;
    files?: unknown;
  };
  try {
    env = JSON.parse(m[1]);
  } catch {
    return null;
  }

  const summary =
    typeof env.summary === "string" && env.summary.trim().length > 0
      ? env.summary.trim().slice(0, 280)
      : null;

  const rawSha =
    typeof env.commit_sha === "string"
      ? env.commit_sha
      : typeof env.sha === "string"
        ? env.sha
        : "";
  const trimmedSha = rawSha.trim();
  const commit_sha = /^[0-9a-f]{7,40}$/i.test(trimmedSha) ? trimmedSha : null;

  const pr_url =
    typeof env.pr_url === "string" && /^https?:\/\//i.test(env.pr_url.trim())
      ? env.pr_url.trim()
      : null;

  const actions = { create: 0, modify: 0, delete: 0 };
  const file_paths: string[] = [];
  let files_changed = 0;
  if (Array.isArray(env.files)) {
    for (const f of env.files) {
      if (!f || typeof f !== "object") continue;
      const path = (f as { path?: unknown }).path;
      const action = (f as { action?: unknown }).action;
      if (typeof path !== "string" || path.trim().length === 0) continue;
      files_changed += 1;
      if (file_paths.length < REFINE_DIFF_SUMMARY_MAX_PATHS) {
        file_paths.push(path.trim());
      }
      if (action === "create" || action === "modify" || action === "delete") {
        actions[action] += 1;
      }
    }
  }
  file_paths.sort();

  return { summary, commit_sha, pr_url, files_changed, file_paths, actions };
}

export type RefineProductDeps = {
  loadProvisionedTarget: (tenant_id: string) => Promise<ProvisionedTarget | null>;
  loadSiteDesignBrief?: (tenant_id: string, root_conductor_run_id: string) => Promise<Record<string, unknown> | null>;
  loadPriorRefines: (
    tenant_id: string,
    limit: number,
    site_id?: string | null,
  ) => Promise<PriorRefineTurn[]>;
  verifyConductorRunOwnership: (
    conductor_run_id: string,
    tenant_id: string,
  ) => Promise<boolean>;
  loadBuildRetired?: (tenant_id: string) => Promise<boolean>;
  loadConductorRunKind: (
    conductor_run_id: string,
    tenant_id: string,
  ) => Promise<string | null>;
  tryAcquireBuildSlot: (params: {
    tenant_id: string;
    objective: string;
    max_usd: number;
    provision_estimate: number;
    max_per_day: number;
    daily_cap_usd: number;
    is_refine: boolean;
    site_id?: string | null;
  }) => Promise<string>;
  countSitePublishesToday?: (tenant_id: string) => Promise<number>;
  updateConductorRunStatus: (params: {
    conductor_run_id: string;
    status: "active" | "failed";
    goal_graph?: ConductorNode[];
  }) => Promise<void>;
  resolveDailyCap: (tenant_id: string) => Promise<number>;
  loadRepoHeadSha: (
    github_full_name: string,
    default_branch: string,
  ) => Promise<string | null>;
  resolveRefineDirectMergeEnabled: (tenant_id: string) => Promise<boolean>;
  isFleetHalted: () => Promise<boolean>;
  loadAppPolicy: (tenant_id: string) => Promise<AppPipelinePolicy>;
  loadFreeEditState?: (tenant_id: string, retry_of: string | null) => Promise<FreeEditState | null>;
  claimFreeEdit?: (tenant_id: string, conductor_run_id: string, retry_of: string | null) => Promise<boolean>;
  photoRetryFree?: (tenant_id: string, site_id: string) => Promise<boolean>;
  claimPhotoRetry?: (tenant_id: string, site_id: string, conductor_run_id: string) => Promise<boolean>;
  readBalance?: (tenant_id: string) => Promise<BalanceState | null>;
  hasPendingUndoClaim?: (tenant_id: string) => Promise<boolean>;
  claimSiteEditLease?: (tenant_id: string, site_id: string) => Promise<SiteEditLease>;
  loadSiteForRun?: (tenant_id: string, conductor_run_id: string) => Promise<SiteRow | null>;
  listSites?: (tenant_id: string) => Promise<SiteRow[]>;
  markSiteEdited?: (tenant_id: string, site_id: string) => Promise<void>;
  wakeSite?: (hostname: string) => Promise<unknown>;
  resolveSiteFastEditNode?: (tenant_id: string) => Promise<boolean>;
  resolveSiteEditAutoRoute?: (tenant_id: string) => Promise<boolean>;
  resolveSiteEditTimingLog?: (tenant_id: string) => Promise<boolean>;
  resolveBuildPublishOnRequest?: (tenant_id: string) => Promise<boolean>;
};

async function realLoadProvisionedTarget(
  tenant_id: string,
): Promise<ProvisionedTarget | null> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("tenant_resources")
    .select("resource_kind, mode, external_ref")
    .eq("tenant_id", tenant_id)
    .in("resource_kind", ["repo", "db"]);
  if (error) {
    throw new Error(`tenant_resources read failed: ${error.message}`);
  }
  if (!data || data.length === 0) return null;
  type Row = {
    resource_kind: string;
    mode: string;
    external_ref: Record<string, unknown> | null;
  };
  const rows = data as Row[];
  const repo = rows.find((r) => r.resource_kind === "repo");
  if (!repo || repo.mode !== "provisioned") return null;
  const target: ProvisionedTarget = {};
  const repoRef = repo.external_ref ?? {};
  if (typeof repoRef.repo_url === "string") target.repo_url = repoRef.repo_url;
  if (typeof repoRef.github_full_name === "string") {
    target.github_full_name = repoRef.github_full_name;
  }
  if (typeof repoRef.default_branch === "string") {
    target.default_branch = repoRef.default_branch;
  }
  const db = rows.find((r) => r.resource_kind === "db");
  if (db && db.mode === "provisioned") {
    const dbRef = db.external_ref ?? {};
    if (typeof dbRef.neon_project_id === "string") {
      target.neon_project_id = dbRef.neon_project_id;
    }
  }
  if (!target.github_full_name) return null;
  return target;
}

async function realLoadSiteDesignBrief(tenant_id: string, root_conductor_run_id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("goal_graph")
    .eq("id", root_conductor_run_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`design brief read failed: ${error.message}`);
  const graph = (data as { goal_graph?: unknown } | null)?.goal_graph;
  const brief = designBriefFromGraph(graph);
  const siteId = siteIdFromGraph(graph);
  if (!siteId) return brief;
  const row = await siteDesignStore()
    .get(tenant_id, siteId)
    .catch(() => null);
  return row ? (briefForChosenLook(row) as unknown as Record<string, unknown>) : brief;
}

async function realLoadPriorRefines(
  tenant_id: string,
  limit: number,
  site_id: string | null = null,
): Promise<PriorRefineTurn[]> {
  const sb = serviceClient();
  let query = sb
    .from("conductor_runs")
    .select("status, goal_graph, objective, created_at")
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .eq("goal_graph->0->payload->>refine_mode", "true");
  query = site_id
    ? query.eq("goal_graph->0->payload->>site_id", site_id)
    : query.is("goal_graph->0->payload->>site_id", null);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(Math.max(1, limit) * 2);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[refine-product] loadPriorRefines read failed for tenant=${tenant_id}: ${error.message}`,
    );
    return [];
  }
  type Node = {
    child_run_id?: string | null;
    payload?: { refine_mode?: unknown; idea?: unknown };
  };
  type Row = {
    status: string;
    goal_graph: Node[] | null;
    objective: string | null;
    created_at: string;
  };
  const rows = (data ?? []) as Row[];
  const refines = rows.filter((r) => {
    const node = (r.goal_graph ?? [])[0];
    return node?.payload?.refine_mode === true && siteIdFromGraph(r.goal_graph) === site_id;
  });
  if (refines.length === 0) return [];

  const childIds = Array.from(
    new Set(
      refines
        .map((r) => r.goal_graph?.[0]?.child_run_id)
        .filter((x): x is string => typeof x === "string" && x.length > 0),
    ),
  );
  const outputById = new Map<string, string>();
  if (childIds.length > 0) {
    const { data: arRows } = await sb
      .from("agent_runs")
      .select("id, output_text")
      .eq("tenant_id", tenant_id)
      .in("id", childIds);
    for (const r of (arRows ?? []) as Array<{
      id: string;
      output_text: string | null;
    }>) {
      if (typeof r.output_text === "string") outputById.set(r.id, r.output_text);
    }
  }

  function extractSummary(output: string | undefined): string | undefined {
    if (!output) return undefined;
    const m = output.match(/<pr_proposal>\s*(\{[\s\S]*?\})\s*<\/pr_proposal>/i);
    if (!m) return undefined;
    try {
      const env = JSON.parse(m[1]) as { summary?: unknown; refused?: unknown; reason_code?: unknown; customer_summary?: unknown };
      if (typeof env.summary === "string" && env.summary.trim().length > 0) {
        return env.summary.trim().slice(0, 280);
      }
      if (env.refused === true && typeof env.customer_summary === "string" && env.customer_summary.trim()) {
        const code = typeof env.reason_code === "string" ? env.reason_code : "refused";
        return `${code === "needs_input" ? "Asked the founder" : "Answered without a change"}: ${env.customer_summary.trim()}`.slice(0, 280);
      }
    } catch {
    }
    return undefined;
  }

  function stripPrefix(s: string | null): string {
    if (!s) return "";
    return s.replace(/^\[refine\]\s+/i, "").trim();
  }

  return refines.slice(0, limit).map((r) => {
    const node = (r.goal_graph ?? [])[0];
    const out = node?.child_run_id ? outputById.get(node.child_run_id) : undefined;
    const turn: PriorRefineTurn = {
      message: stripPrefix(r.objective).slice(0, 1000),
      status: r.status,
    };
    const summary = extractSummary(out);
    if (summary) turn.outcome = summary;
    return turn;
  });
}

async function realVerifyConductorRunOwnership(
  conductor_run_id: string,
  tenant_id: string,
): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("id")
    .eq("id", conductor_run_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`conductor_runs ownership read failed: ${error.message}`);
  return Boolean(data);
}

export async function realLoadBuildRetired(tenant_id: string): Promise<boolean> {
  const sb = serviceClient();
  const [resources, builds] = await Promise.all([
    sb.from("tenant_resources").select("resource_kind, status, updated_at").eq("tenant_id", tenant_id),
    sb
      .from("conductor_runs")
      .select("created_at")
      .eq("tenant_id", tenant_id)
      .eq("kind", "build_app")
      .or(NON_REFINE_BUILD_FILTER)
      .is("goal_graph->0->payload->>site_id", null)
      .is("goal_graph->1->payload->>site_id", null)
      .is("goal_graph->2->payload->>site_id", null)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  if (resources.error || builds.error) return false;
  return buildDatabaseReclaimed(resources.data, builds.data?.[0] ?? null);
}

async function realLoadConductorRunKind(
  conductor_run_id: string,
  tenant_id: string,
): Promise<string | null> {
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("kind")
    .eq("id", conductor_run_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) {
    throw new Error(`conductor_runs kind read failed: ${error.message}`);
  }
  const kind = (data as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind : null;
}

async function realTryAcquireBuildSlot(params: {
  tenant_id: string;
  objective: string;
  max_usd: number;
  provision_estimate: number;
  max_per_day: number;
  daily_cap_usd: number;
  is_refine: boolean;
  site_id?: string | null;
}): Promise<string> {
  const svc = serviceClient();
  const base = {
    p_tenant_id: params.tenant_id,
    p_objective: params.objective,
    p_max_usd: params.max_usd,
    p_provision_estimate: params.provision_estimate,
    p_max_per_day: params.max_per_day,
    p_daily_cap_usd: params.daily_cap_usd,
  };
  const missingFunction = (e: { code?: string; message?: string } | null) =>
    !!e && (e.code === "PGRST202" || /could not find the function/i.test(e.message || ""));
  const withRefine = { ...base, p_is_refine: params.is_refine };
  let { data, error } = await svc.rpc(
    "try_acquire_build_slot",
    params.site_id ? { ...withRefine, p_site_id: params.site_id } : withRefine,
  );
  if (params.site_id && missingFunction(error)) {
    ({ data, error } = await svc.rpc("try_acquire_build_slot", withRefine));
  }
  if (missingFunction(error)) {
    ({ data, error } = await svc.rpc("try_acquire_build_slot", base));
  }
  if (error) {
    const msg = error.message || "";
    if (msg.includes("double_build")) {
      throw new DoubleBuildInFlight(params.tenant_id);
    }
    if (msg.includes("daily_limit")) {
      throw new TooManyBuildsToday(
        params.tenant_id,
        params.max_per_day,
        params.max_per_day,
      );
    }
    if (msg.includes("over_cap")) {
      throw new ProvisionBudgetExceeded(params.provision_estimate);
    }
    throw new Error(`try_acquire_build_slot failed: ${error.message}`);
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("try_acquire_build_slot returned no id");
  }
  return data;
}

async function realUpdateConductorRunStatus(params: {
  conductor_run_id: string;
  status: "active" | "failed";
  goal_graph?: ConductorNode[];
}): Promise<void> {
  const patch: Record<string, unknown> = {
    status: params.status,
    updated_at: new Date().toISOString(),
  };
  if (params.goal_graph !== undefined) patch.goal_graph = params.status === "active" ? stampConductorOwner(params.goal_graph) : params.goal_graph;
  const { error } = await serviceClient()
    .from("conductor_runs")
    .update(patch)
    .eq("id", params.conductor_run_id);
  if (error) throw new Error(`conductor_runs update failed: ${error.message}`);
}

export async function findExistingRefineForSuggestion(
  tenant_id: string,
  suggestion_id: string,
): Promise<{ conductor_run_id: string; status: string } | null> {
  const tid = (tenant_id ?? "").trim();
  const sid = (suggestion_id ?? "").trim();
  if (!tid || !sid) return null;

  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("id, status")
    .eq("tenant_id", tid)
    .eq("kind", "build_app")
    .eq("goal_graph->0->payload->>source_suggestion_id", sid)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[refine-product] findExistingRefineForSuggestion read failed for tenant=${tid} suggestion=${sid}: ${error.message}`,
    );
    return null;
  }
  const row = (data as Array<{ id: string; status: string | null }> | null)?.[0] ?? null;
  return row ? { conductor_run_id: row.id, status: row.status ?? "unknown" } : null;
}

export const realRefineProductDeps: RefineProductDeps = {
  loadSiteForRun: async (tenant_id, conductor_run_id) => {
    const { data, error } = await serviceClient()
      .from("conductor_runs")
      .select(SITE_MARKER_SELECT)
      .eq("tenant_id", tenant_id)
      .eq("id", conductor_run_id)
      .maybeSingle();
    if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
    const marker = data as { s0?: unknown; s1?: unknown; s2?: unknown } | null;
    if (!rowHasSiteMarker(marker)) return null;
    const { siteStore } = await import("@/services/sites/store");
    const store = siteStore();
    const root = await store.getByRun(tenant_id, conductor_run_id);
    if (root) return root;
    const pointed = siteIdFromMarkerRow(marker);
    return pointed ? store.get(tenant_id, pointed) : null;
  },
  listSites: async (tenant_id) => {
    const { siteStore } = await import("@/services/sites/store");
    return siteStore().listForTenant(tenant_id);
  },
  markSiteEdited: async (tenant_id, site_id) => {
    const { siteStore } = await import("@/services/sites/store");
    await siteStore().update(tenant_id, site_id, { last_edit_at: new Date().toISOString() });
    try {
      await (await import("@/services/sites/site-preview-snapshot")).sitePreviewSnapshotStore().markChanged(tenant_id, site_id);
    } catch (e) {
      console.warn(`[refine-product] preview change mark failed for site=${site_id}: ${(e as Error)?.message ?? e}`);
    }
  },
  wakeSite: async (hostname) => {
    const { wakeSiteByHostname } = await import("@/services/sites/wiring");
    return wakeSiteByHostname(hostname);
  },
  loadProvisionedTarget: realLoadProvisionedTarget,
  loadSiteDesignBrief: realLoadSiteDesignBrief,
  loadPriorRefines: realLoadPriorRefines,
  verifyConductorRunOwnership: realVerifyConductorRunOwnership,
  loadBuildRetired: realLoadBuildRetired,
  loadConductorRunKind: realLoadConductorRunKind,
  tryAcquireBuildSlot: realTryAcquireBuildSlot,
  countSitePublishesToday: realCountSitePublishesToday,
  updateConductorRunStatus: realUpdateConductorRunStatus,
  resolveDailyCap: (tenant_id) => resolveDailyCapUsd(tenant_id),
  loadRepoHeadSha: (github_full_name, default_branch) =>
    readProvisionedRepoHeadSha(github_full_name, default_branch),
  resolveRefineDirectMergeEnabled: (tenant_id) =>
    getBoolSetting("refine_direct_merge_enabled", tenant_id),
  resolveSiteFastEditNode: (tenant_id) => getBoolSetting("site_fast_edit_node", tenant_id),
  resolveSiteEditAutoRoute: (tenant_id) => getBoolSetting("site_edit_auto_route", tenant_id),
  resolveSiteEditTimingLog: (tenant_id) => getBoolSetting("site_edit_timing_log", tenant_id),
  resolveBuildPublishOnRequest: (tenant_id) => getBoolSetting("build_publish_on_request", tenant_id),
  isFleetHalted: async () => {
    const { data, error } = await serviceClient().rpc("is_fleet_halted");
    if (error) throw new Error(`is_fleet_halted failed: ${error.message}`);
    return data === true;
  },
  loadAppPolicy: (tenant_id) => loadTenantAppPolicy(tenant_id),
  loadFreeEditState: realLoadFreeEditState,
  claimFreeEdit: realClaimFreeEdit,
  photoRetryFree: (tenant_id, site_id) => import("@/services/sites/site-photos").then((m) => m.photoRetryFree(tenant_id, site_id)),
  claimPhotoRetry: (tenant_id, site_id, run_id) => import("@/services/sites/site-photos").then((m) => m.claimPhotoRetry(tenant_id, site_id, run_id)),
  readBalance: (tenant_id) => makeBalanceReader(serviceClient() as never)(tenant_id),
  hasPendingUndoClaim: realHasPendingUndoClaim,
  claimSiteEditLease: (tenant_id, site_id) => claimSiteEditLease(tenant_id, site_id),
};

async function realHasPendingUndoClaim(tenant_id: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("id, goal_graph")
    .eq("tenant_id", tenant_id)
    .eq("kind", "undo")
    .eq("status", UNDO_CLAIM_STATUS)
    .gte("created_at", new Date(Date.now() - UNDO_CLAIM_STALE_MS).toISOString())
    .limit(5);
  if (error) throw new Error(`conductor_runs undo claim read failed: ${error.message}`);
  return ((data ?? []) as Array<{ goal_graph: Array<{ payload?: { undo_claim?: unknown } }> | null }>).some(
    (r) => (r.goal_graph ?? [])[0]?.payload?.undo_claim === true,
  );
}

async function realLoadFreeEditState(
  tenant_id: string,
  retry_of: string | null,
): Promise<FreeEditState | null> {
  const { data, error } = await serviceClient().rpc("free_edit_state", {
    p_tenant_id: tenant_id,
    p_retry_of: retry_of,
  });
  if (error || !data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.applies !== "boolean" || typeof d.used !== "number") return null;
  return {
    applies: d.applies,
    used: d.used,
    limit: typeof d.limit === "number" ? d.limit : FREE_EDITS_LIMIT,
    retry_waived: d.retry_waived === true,
  };
}

async function realClaimFreeEdit(
  tenant_id: string,
  conductor_run_id: string,
  retry_of: string | null,
): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("claim_free_edit", {
    p_tenant_id: tenant_id,
    p_conductor_run_id: conductor_run_id,
    p_retry_of: retry_of,
  });
  if (error) throw new Error(`claim_free_edit failed: ${error.message}`);
  return data === true;
}

export const PRIOR_REFINES_PROMPT_CONTEXT = 3;

export async function assertRefineAllowed(
  tenant_id: string,
  deps: RefineProductDeps = realRefineProductDeps,
): Promise<void> {
  let halted = true;
  try {
    halted = await deps.isFleetHalted();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[refine-product] is_fleet_halted read threw for tenant=${tenant_id} — failing CLOSED (halted): ${(e as Error).message}`,
    );
    halted = true;
  }
  if (halted) throw new FleetHalted();

  let policy: AppPipelinePolicy = DEFAULT_APP_PIPELINE_POLICY;
  try {
    policy = await deps.loadAppPolicy(tenant_id);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[refine-product] app-policy read threw for tenant=${tenant_id} — failing OPEN (not frozen): ${(e as Error).message}`,
    );
    policy = DEFAULT_APP_PIPELINE_POLICY;
  }
  if (policy.freeze === true) throw new AppFrozen(tenant_id);
}

export function buildRefineGoalGraph(params: {
  message: string;
  target: ProvisionedTarget;
  parent_conductor_run_id: string | null;
  prior_refines: PriorRefineTurn[];
  remediation_attempt: number | null;
  source_suggestion_id: string | null;
  pre_refine_sha: string | null;
  direct_merge_enabled: boolean;
  chat_thread_id: string | null;
  user_request?: string | null;
  retry_of?: string | null;
  chat_photo_paths?: ReadonlyArray<string>;
  request_image_paths?: ReadonlyArray<string>;
  small_edit?: boolean;
  site_id?: string | null;
  site_backend?: SiteBackendKind | null;
  fast_edit?: boolean;
  refine_requested_at?: string | null;
  stop_at_preview?: boolean;
  site_inline_edits?: ReadonlyArray<SiteInlineEditRef>;
  design_brief?: Record<string, unknown> | null;
  edit_size?: SiteEditSize | null;
  edit_routed?: "auto" | null;
  photo_retry?: boolean;
  selected_element?: SelectedElementScope | null;
}): ConductorNode[] {
  const {
    message,
    target,
    parent_conductor_run_id,
    prior_refines,
    remediation_attempt,
    source_suggestion_id,
    pre_refine_sha,
    direct_merge_enabled,
    chat_thread_id,
    user_request,
    retry_of,
    chat_photo_paths,
    request_image_paths,
    small_edit,
    site_id,
    site_backend,
    fast_edit,
    refine_requested_at,
    stop_at_preview,
    site_inline_edits,
    design_brief,
    edit_size,
    edit_routed,
    photo_retry,
    selected_element,
  } = params;
  const fastEdit = fast_edit === true && small_edit === true && !!site_id;
  const node: ConductorNode = {
    id: `refine-${Date.now().toString(36)}`,
    status: "pending",
    target_agent_slug: STAGE_AGENT.build,
    payload: {
      stage: "build",
      stack: AUTOPILOT_BUILD_STACK,
      idea: message,
      company_name: "your product",
      target,
      refine_mode: true,
      customer_origin: true,
      prior_refines,
      parent_conductor_run_id,
      ...(typeof remediation_attempt === "number" && remediation_attempt > 0
        ? { remediation_attempt }
        : {}),
      ...(source_suggestion_id ? { source_suggestion_id } : {}),
      ...(chat_thread_id ? { chat_thread_id } : {}),
      ...(user_request ? { user_request } : {}),
      ...(selected_element ? { selected_element } : {}),
      ...(retry_of ? { retry_of } : {}),
      ...(small_edit === true ? { small_edit: true } : {}),
      direct_merge_enabled,
      ...(site_id ? { site_id } : {}),
      ...(site_id && photo_retry === true ? { photo_retry: true } : {}),
      ...(site_id && site_backend ? { site_backend } : {}),
      ...(fastEdit ? { fast_edit: true } : {}),
      ...(site_id && refine_requested_at ? { refine_requested_at } : {}),
      ...(stop_at_preview === true && site_id && direct_merge_enabled ? { stop_at_preview: true } : {}),
      ...(chat_photo_paths && chat_photo_paths.length > 0 ? { chat_photo_paths: [...chat_photo_paths] } : {}),
      ...(request_image_paths && request_image_paths.length > 0 ? { request_image_paths: [...request_image_paths] } : {}),
      ...(site_id && site_inline_edits && site_inline_edits.length > 0 ? { site_inline_edits: [...site_inline_edits] } : {}),
      ...(site_id && design_brief ? { design_brief } : {}),
      ...(site_id && edit_size ? { edit_size } : {}),
      ...(fastEdit && edit_routed === "auto" ? { edit_routed } : {}),
    },
    estimate_usd: fastEdit ? SITE_FAST_EDIT_ESTIMATE_USD : 3.0,
    child_run_id: null,
  };

  if (!direct_merge_enabled) {
    return [node];
  }

  if (stop_at_preview === true && site_id) {
    return [node];
  }

  const deployNode: ConductorNode = {
    id: `refine-deploy-${Date.now().toString(36)}`,
    status: "pending",
    target_agent_slug: "",
    payload: {
      stage: "deploy",
      target,
      ...(site_id ? { site_id } : {}),
      ...(site_id && refine_requested_at ? { refine_requested_at } : {}),
      refine_deploy_enqueued_at: Date.now(),
      ...(pre_refine_sha ? { pre_refine_sha } : {}),
    },
    estimate_usd: 0,
    child_run_id: null,
  };

  return [node, deployNode];
}

const SITE_NOT_EDITABLE = new Set(["failed", "fell_back_old", "deleting", "deleted"]);

export async function resolveUnboundSite(
  tenant_id: string,
  deps: Pick<RefineProductDeps, "listSites" | "loadProvisionedTarget" | "loadBuildRetired">,
): Promise<SiteRow | null> {
  if (!deps.listSites) return null;
  let sites: SiteRow[];
  try {
    sites = await deps.listSites(tenant_id);
  } catch {
    throw new SiteRequired(tenant_id, "unreadable");
  }
  const open = sites.filter((s) => s.tenant_id === tenant_id && !SITE_NOT_EDITABLE.has(s.status));
  if (open.length === 0) return null;

  let singleton = false;
  try {
    const retired = (await deps.loadBuildRetired?.(tenant_id)) === true;
    if (!retired) {
      const target = await deps.loadProvisionedTarget(tenant_id);
      const repo = (target?.github_full_name ?? "").toLowerCase();
      singleton = repo.length > 0 && !open.some((s) => (s.github_full_name ?? "").toLowerCase() === repo);
    }
  } catch {
    throw new SiteRequired(tenant_id, "unreadable");
  }
  if (open.length === 1 && !singleton) return open[0];
  throw new SiteRequired(tenant_id, "ambiguous");
}

export async function refineProduct(
  input: RefineProductInput,
  deps: RefineProductDeps = realRefineProductDeps,
): Promise<RefineProductResult> {
  const lease: { release?: () => Promise<void> } = {};
  try {
    return await refineProductLeased(input, deps, lease);
  } finally {
    if (lease.release) await lease.release().catch(() => undefined);
  }
}

async function refineProductLeased(
  input: RefineProductInput,
  deps: RefineProductDeps,
  lease: { release?: () => Promise<void> },
): Promise<RefineProductResult> {
  const requested_at = new Date().toISOString();
  const tenant_id = (input.tenant_id ?? "").trim();
  const message = (input.message ?? "").trim();
  if (!tenant_id) throw new Error("refineProduct: tenant_id is required");

  if (!message) {
    throw new InvalidRefineMessage("empty");
  }
  if (message.length < (input.selected_element || ownChatImagePaths(tenant_id, input.image_paths).length > 0 ? 2 : 8)) {
    throw new InvalidRefineMessage("too_short");
  }
  if (message.length > (input.selected_element ? MAX_SCOPED_MESSAGE : 4000)) {
    throw new InvalidRefineMessage("too_long");
  }

  let parent_conductor_run_id: string | null = null;
  let site: SiteRow | null = null;
  if (input.singleton_app === true) throw new OldSiteFrozen(tenant_id);
  if (input.conductor_run_id) {
    const id = input.conductor_run_id.trim();
    if (id.length > 0) {
      const owned = await deps.verifyConductorRunOwnership(id, tenant_id);
      if (!owned) throw new ConductorRunNotFound(id);
      let kind: string | null = null;
      let kindUnreadable = false;
      try {
        kind = await deps.loadConductorRunKind(id, tenant_id);
        if (kind === null) kindUnreadable = true;
      } catch (err) {
        kindUnreadable = true;
        console.warn(
          `[refine-product] conductor run kind unreadable for ${id} (tenant ${tenant_id}): ${(err as Error)?.message ?? err}`,
        );
      }
      if (deps.loadSiteForRun) {
        let found: SiteRow | null;
        try {
          found = await deps.loadSiteForRun(tenant_id, id);
        } catch (err) {
          console.warn(
            `[refine-product] site lookup failed for run ${id} (tenant ${tenant_id}): ${(err as Error)?.message ?? err}`,
          );
          throw new SiteRequired(tenant_id, "unreadable");
        }
        if (found && found.tenant_id === tenant_id && found.status !== "fell_back_old") site = found;
      }
      if (!site && kindUnreadable) throw new SiteRequired(tenant_id, "unreadable");
      if (kind === "build_app" && !site) throw new OldSiteFrozen(tenant_id);
      parent_conductor_run_id = site?.root_conductor_run_id ?? id;
    }
  }

  if (!site && deps.listSites) {
    site = await resolveUnboundSite(tenant_id, deps);
    if (site) parent_conductor_run_id = site.root_conductor_run_id;
  }

  if (!site) {
    let retired = false;
    try {
      retired = (await deps.loadBuildRetired?.(tenant_id)) === true;
    } catch {
      retired = false;
    }
    if (retired) throw new BuildRetired(tenant_id);
    const oldApp = await deps.loadProvisionedTarget(tenant_id);
    if (oldApp?.github_full_name) throw new OldSiteFrozen(tenant_id);
    throw new NoProvisionedRepo(tenant_id);
  }

  await assertRefineAllowed(tenant_id, deps);

  if (site.status === "paused" && deps.wakeSite) {
    const hostname = site.hostname;
    void deps.wakeSite(hostname).catch((wakeErr: unknown) => {
      console.warn(`[refine-product] wake failed for ${hostname}: ${(wakeErr as Error)?.message ?? wakeErr}`);
    });
  }

  if (deps.hasPendingUndoClaim && (await deps.hasPendingUndoClaim(tenant_id))) {
    throw new UndoInProgress(tenant_id);
  }
  const claimed = await deps.claimSiteEditLease?.(tenant_id, site.id);
  if (claimed && "held" in claimed) {
    if (claimed.held === "edit") throw new DoubleBuildInFlight(tenant_id);
    throw new SitePreviewRestarting(site.id);
  }
  if (claimed) lease.release = claimed.release;
  if (site.status === "failed" || site.status === "deleting" || site.status === "deleted") {
    throw new SiteUnavailable(site.id, site.status);
  }
  if (!site.github_full_name) throw new NoProvisionedRepo(tenant_id);
  const target: ProvisionedTarget & { github_full_name: string } = {
    github_full_name: site.github_full_name,
    repo_url: `https://github.com/${site.github_full_name}`,
    default_branch: "main",
  };

  const retry_of = typeof input.retry_of === "string" && input.retry_of ? input.retry_of : null;
  const photo_retry = input.photo_retry === true;
  let photoFree = false;
  if (photo_retry && deps.photoRetryFree) {
    try {
      photoFree = (await deps.photoRetryFree(tenant_id, site.id)) === true;
    } catch {
      photoFree = false;
    }
  }
  let freeEdit: FreeEditState | null = null;
  if (!photoFree) {
    try {
      freeEdit = (await deps.loadFreeEditState?.(tenant_id, retry_of)) ?? null;
    } catch {
      freeEdit = null;
    }
  }
  const waive = !photo_retry && !!freeEdit?.applies && (freeEdit.retry_waived || freeEdit.used < freeEdit.limit);
  if (photoFree) {
  } else if (freeEdit?.applies && !waive) {
    let balance: BalanceState | null = null;
    try {
      balance = (await deps.readBalance?.(tenant_id)) ?? null;
    } catch {
      balance = null;
    }
    if (!balance) throw new FreeEditsUsed();
    try {
      await assertRefineCreditsAvailable(tenant_id, { readBalance: async () => balance });
    } catch (e) {
      if (e instanceof InsufficientCreditsForBuild) throw new FreeEditsUsed();
      throw e;
    }
  } else if (!waive) {
    await assertRefineCreditsAvailable(tenant_id, { readBalance: deps.readBalance });
  }

  const candidate =
    typeof input.max_usd === "number" && Number.isFinite(input.max_usd) && input.max_usd >= 0
      ? input.max_usd
      : DEFAULT_REFINE_MAX_USD;
  const max_usd = Math.min(candidate, MAX_PRODUCT_BUILD_MAX_USD);

  const objective = `[refine] ${message}`.slice(0, 500);
  const daily_cap_usd = await deps.resolveDailyCap(tenant_id);
  const publishesToday = await sitePublishesTodayOrNull(deps, tenant_id);
  const conductor_run_id = await deps.tryAcquireBuildSlot({
    tenant_id,
    objective,
    max_usd,
    provision_estimate: REFINE_PROVISION_ESTIMATE_USD,
    max_per_day: MAX_PRODUCT_REFINES_PER_DAY + (publishesToday ?? 0),
    daily_cap_usd,
    is_refine: true,
    site_id: site.id,
  });

  let prior_refines: PriorRefineTurn[] = [];
  try {
    prior_refines = await deps.loadPriorRefines(
      tenant_id,
      PRIOR_REFINES_PROMPT_CONTEXT,
      site.id,
    );
  } catch (priorErr) {
    // eslint-disable-next-line no-console
    console.warn(
      `[refine-product] loadPriorRefines threw for tenant=${tenant_id}: ${(priorErr as Error).message}`,
    );
    prior_refines = [];
  }

  let direct_merge_enabled = false;
  try {
    direct_merge_enabled = await deps.resolveRefineDirectMergeEnabled(tenant_id);
  } catch (settingErr) {
    // eslint-disable-next-line no-console
    console.warn(
      `[refine-product] resolveRefineDirectMergeEnabled threw for tenant=${tenant_id} — failing closed (brake ON): ${(settingErr as Error).message}`,
    );
    direct_merge_enabled = false;
  }

  const stop_at_preview = direct_merge_enabled && (await siteChangesWaitForPublish(tenant_id, deps.resolveBuildPublishOnRequest));

  let pre_refine_sha: string | null = null;
  if (direct_merge_enabled && !stop_at_preview) {
    try {
      pre_refine_sha = await deps.loadRepoHeadSha(
        target.github_full_name,
        target.default_branch ?? "main",
      );
    } catch (shaErr) {
      // eslint-disable-next-line no-console
      console.warn(
        `[refine-product] loadRepoHeadSha threw for tenant=${tenant_id} repo=${target.github_full_name}: ${(shaErr as Error).message}`,
      );
      pre_refine_sha = null;
    }
  }

  let design_brief: Record<string, unknown> | null = null;
  if (site.root_conductor_run_id && deps.loadSiteDesignBrief) {
    try {
      design_brief = await deps.loadSiteDesignBrief(tenant_id, site.root_conductor_run_id);
    } catch (briefErr) {
      console.warn(`[refine-product] design brief not loaded for tenant=${tenant_id} site=${site.id}: ${(briefErr as Error).message}`);
      design_brief = null;
    }
  }

  const route = classifySiteEdit(input.request ?? message);
  const requestImagePaths = ownChatImagePaths(tenant_id, input.image_paths).slice(0, MAX_REFINE_IMAGES);
  let routedFast = false;
  if (
    input.small_edit !== true &&
    route.lane === "fast" &&
    !retry_of &&
    !(typeof input.remediation_attempt === "number" && input.remediation_attempt > 0) &&
    !(typeof input.source_suggestion_id === "string" && input.source_suggestion_id.trim()) &&
    ownChatImagePaths(tenant_id, input.photo_paths).length === 0 &&
    requestImagePaths.length === 0 &&
    !carriesWorkspacePhotos(message)
  ) {
    try {
      routedFast = (await deps.resolveSiteEditAutoRoute?.(tenant_id)) === true;
    } catch {
      routedFast = false;
    }
  }
  const small_edit = (input.small_edit === true && requestImagePaths.length === 0) || routedFast;
  const edit_size: SiteEditSize = input.small_edit === true ? "tweak" : route.size;
  let fast_edit = false;
  try {
    fast_edit = small_edit && (await deps.resolveSiteFastEditNode?.(tenant_id)) === true;
  } catch {
    fast_edit = false;
  }
  let refine_requested_at: string | null = null;
  try {
    refine_requested_at = (await deps.resolveSiteEditTimingLog?.(tenant_id)) === true ? requested_at : null;
  } catch {
    refine_requested_at = null;
  }

  try {
    if (waive) {
      if (!deps.claimFreeEdit) throw new Error("refineProduct: claimFreeEdit dep missing");
      if (!(await deps.claimFreeEdit(tenant_id, conductor_run_id, retry_of))) throw new FreeEditsUsed();
    }
    if (photoFree) {
      if (!deps.claimPhotoRetry) throw new Error("refineProduct: claimPhotoRetry dep missing");
      if (!(await deps.claimPhotoRetry(tenant_id, site.id, conductor_run_id))) throw new PhotoRetryTaken();
    }
    const goal_graph = buildRefineGoalGraph({
      message,
      target,
      parent_conductor_run_id,
      prior_refines,
      remediation_attempt:
        typeof input.remediation_attempt === "number" && input.remediation_attempt > 0
          ? input.remediation_attempt
          : null,
      source_suggestion_id:
        typeof input.source_suggestion_id === "string" && input.source_suggestion_id.trim().length > 0
          ? input.source_suggestion_id.trim()
          : null,
      pre_refine_sha,
      direct_merge_enabled,
      chat_thread_id:
        typeof input.chat_thread_id === "string" && input.chat_thread_id.trim().length > 0
          ? input.chat_thread_id.trim()
          : null,
      user_request: userRequestFor(input.request, message),
      retry_of,
      chat_photo_paths: ownChatImagePaths(tenant_id, input.photo_paths),
      request_image_paths: requestImagePaths,
      small_edit,
      site_id: site.id,
      site_backend: siteBackendKindOf(site),
      fast_edit,
      refine_requested_at,
      stop_at_preview,
      site_inline_edits: siteInlineEditRefs(input.site_inline_edits),
      design_brief,
      edit_size,
      edit_routed: routedFast ? "auto" : null,
      photo_retry,
      selected_element: input.selected_element ?? null,
    });
    await deps.updateConductorRunStatus({
      conductor_run_id,
      status: "active",
      goal_graph,
    });
    const editedSiteId = site.id;
    await deps.markSiteEdited?.(tenant_id, editedSiteId).catch((markErr: unknown) => {
      console.warn(`[refine-product] last_edit_at stamp failed for site=${editedSiteId}: ${(markErr as Error)?.message ?? markErr}`);
    });
    return { conductor_run_id, parent_conductor_run_id, target, direct_merge_enabled, site_id: editedSiteId, stop_at_preview };
  } catch (e) {
    try {
      await deps.updateConductorRunStatus({
        conductor_run_id,
        status: "failed",
      });
    } catch (releaseErr) {
      // eslint-disable-next-line no-console
      console.warn(
        `[refine-product] slot-release UPDATE failed for run=${conductor_run_id} tenant=${tenant_id}: ${(releaseErr as Error).message}`,
      );
    }
    throw e;
  }
}

export { OldSiteFrozen };

export {
  MAX_PRODUCT_BUILD_MAX_USD,
  ProvisionBudgetExceeded,
  DoubleBuildInFlight,
  TooManyBuildsToday,
};

export type SiteRepublisher = {
  reserve(input: { tenant_id: string; site: SiteRow; publish_request?: boolean }): Promise<string>;
  stage(input: { tenant_id: string; conductor_run_id: string; site: SiteRow; publish_request?: boolean }): Promise<void>;
  start(input: { tenant_id: string; conductor_run_id: string; site: SiteRow; sha: string; publish_request?: boolean }): Promise<void>;
  release(input: { tenant_id: string; conductor_run_id: string }): Promise<void>;
};

export type ReservedActivation = "activated" | "already_active" | "gone";

export type SiteRepublisherDeps = Pick<RefineProductDeps, "tryAcquireBuildSlot" | "updateConductorRunStatus" | "resolveDailyCap" | "countSitePublishesToday"> & {
  requestTick: (conductor_run_id: string) => Promise<unknown>;
  stageReservedGraph: (input: { conductor_run_id: string; goal_graph: ConductorNode[] }) => Promise<void>;
  activateReserved: (input: { conductor_run_id: string; goal_graph: ConductorNode[] }) => Promise<ReservedActivation>;
  sleep?: (ms: number) => Promise<void>;
};

const SITE_REPUBLISH_MAX_USD = 1;
export const SITE_FIRST_PUBLISH_MAX_USD = SITE_REPUBLISH_MAX_USD + 3 * SITE_FIRST_PUBLISH_FIX_ESTIMATE_USD;
export const MAX_SITE_PUBLISHES_PER_DAY = 20;
const PUBLISH_IGNORES_REFINE_CAP = 2_147_483_647;

export async function realCountSitePublishesToday(tenant_id: string): Promise<number> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const { count, error } = await serviceClient()
    .from("conductor_runs")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .gte("created_at", midnight.toISOString())
    .eq("goal_graph->0->payload->>publish_request", "true");
  if (error) throw new Error(`conductor_runs publish count failed: ${error.message}`);
  return typeof count === "number" ? count : 0;
}

async function sitePublishesTodayOrNull(
  deps: Pick<RefineProductDeps, "countSitePublishesToday">,
  tenant_id: string,
): Promise<number | null> {
  if (!deps.countSitePublishesToday) return null;
  try {
    const n = await deps.countSitePublishesToday(tenant_id);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  } catch (e) {
    console.warn(`[refine-product] site publish count unreadable tenant=${tenant_id}: ${(e as Error)?.message ?? e}`);
    return null;
  }
}
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const SITE_REPUBLISH_START_ATTEMPTS = 3;
const SITE_REPUBLISH_START_BACKOFF_MS = 400;

export function siteRepublishGraph(site: SiteRow, sha: string | null, opts: { publish_request?: boolean } = {}): ConductorNode[] {
  return [
    {
      id: `site-republish-${Date.now().toString(36)}`,
      status: "pending",
      target_agent_slug: "",
      payload: {
        stage: "deploy",
        refine_mode: true,
        republish: true,
        ...(opts.publish_request === true ? { publish_request: true } : {}),
        site_id: site.id,
        ...(sha ? { site_sha: sha } : {}),
        parent_conductor_run_id: site.root_conductor_run_id,
        target: {
          github_full_name: site.github_full_name ?? undefined,
          repo_url: site.github_full_name ? `https://github.com/${site.github_full_name}` : undefined,
          default_branch: "main",
        },
      },
      estimate_usd: 0,
      child_run_id: null,
    },
  ];
}

export function createSiteRepublisher(deps: SiteRepublisherDeps): SiteRepublisher {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    async reserve({ tenant_id, site, publish_request }) {
      const daily_cap_usd = await deps.resolveDailyCap(tenant_id);
      const publishesToday = await sitePublishesTodayOrNull(deps, tenant_id);
      if (publish_request === true && publishesToday !== null && publishesToday >= MAX_SITE_PUBLISHES_PER_DAY) {
        throw new TooManyBuildsToday(tenant_id, publishesToday, MAX_SITE_PUBLISHES_PER_DAY);
      }
      let max_per_day = MAX_PRODUCT_REFINES_PER_DAY;
      if (publishesToday !== null) {
        max_per_day = publish_request === true ? PUBLISH_IGNORES_REFINE_CAP : MAX_PRODUCT_REFINES_PER_DAY + publishesToday;
      }
      return deps.tryAcquireBuildSlot({
        tenant_id,
        objective: `[refine] republish ${site.hostname}`.slice(0, 500),
        max_usd: publish_request === true && !site.live_deploy_id ? SITE_FIRST_PUBLISH_MAX_USD : SITE_REPUBLISH_MAX_USD,
        provision_estimate: REFINE_PROVISION_ESTIMATE_USD,
        max_per_day,
        daily_cap_usd,
        is_refine: true,
        site_id: site.id,
      });
    },
    async stage({ conductor_run_id, site }) {
      await deps.stageReservedGraph({ conductor_run_id, goal_graph: siteRepublishGraph(site, null) });
    },
    async start({ tenant_id, conductor_run_id, site, sha, publish_request }) {
      if (!COMMIT_SHA_RE.test(sha)) throw new Error("siteRepublish: invalid commit sha");
      const goal_graph = siteRepublishGraph(site, sha, { publish_request });
      let outcome: ReservedActivation | null = null;
      let lastErr: unknown = null;
      for (let i = 0; i < SITE_REPUBLISH_START_ATTEMPTS && outcome === null; i++) {
        if (i > 0) await sleep(SITE_REPUBLISH_START_BACKOFF_MS * 2 ** (i - 1));
        try {
          outcome = await deps.activateReserved({ conductor_run_id, goal_graph });
        } catch (e) {
          lastErr = e;
        }
      }
      if (outcome === null) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      if (outcome === "gone") {
        throw Object.assign(new Error(`siteRepublish: run ${conductor_run_id} is no longer reserved`), { name: "SiteRepublishGone" });
      }
      await Promise.resolve(deps.requestTick(conductor_run_id)).catch((e: unknown) => {
        console.warn(`[site-republish] tick request failed run=${conductor_run_id} tenant=${tenant_id} (the cron picks it up): ${(e as Error)?.message ?? e}`);
      });
    },
    async release({ conductor_run_id }) {
      await deps.updateConductorRunStatus({ conductor_run_id, status: "failed", goal_graph: [] });
    },
  };
}

async function realStageReservedGraph(params: { conductor_run_id: string; goal_graph: ConductorNode[] }): Promise<void> {
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .update({ goal_graph: params.goal_graph, updated_at: new Date().toISOString() })
    .eq("id", params.conductor_run_id)
    .eq("status", "provisioning")
    .select("id");
  if (error) throw new Error(`conductor_runs stage failed: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`conductor_runs stage: run ${params.conductor_run_id} is not reserved`);
}

export async function realActivateReserved(params: { conductor_run_id: string; goal_graph: ConductorNode[] }): Promise<ReservedActivation> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("conductor_runs")
    .update({ status: "active", goal_graph: stampConductorOwner(params.goal_graph), updated_at: new Date().toISOString() })
    .eq("id", params.conductor_run_id)
    .eq("status", "provisioning")
    .select("id");
  if (error) throw new Error(`conductor_runs activate failed: ${error.message}`);
  if (data && data.length > 0) return "activated";
  const { data: row, error: readErr } = await sb.from("conductor_runs").select("status").eq("id", params.conductor_run_id).maybeSingle();
  if (readErr) throw new Error(`conductor_runs activate re-read failed: ${readErr.message}`);
  return (row as { status?: unknown } | null)?.status === "active" ? "already_active" : "gone";
}

export const realSiteRepublisher: SiteRepublisher = createSiteRepublisher({
  tryAcquireBuildSlot: realTryAcquireBuildSlot,
  countSitePublishesToday: realCountSitePublishesToday,
  updateConductorRunStatus: realUpdateConductorRunStatus,
  stageReservedGraph: realStageReservedGraph,
  activateReserved: realActivateReserved,
  resolveDailyCap: (tenant_id) => resolveDailyCapUsd(tenant_id),
  requestTick: async (conductor_run_id) => {
    const [{ requestConductorTick }, { inngest }] = await Promise.all([
      import("@/services/agents/conductor-kick"),
      import("@/../workers/client"),
    ]);
    return requestConductorTick(inngest, conductor_run_id);
  },
});
