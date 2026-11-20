
import { randomUUID } from "node:crypto";
import {
  APP_DATABASE_SETUP_FAILED_COPY,
  appSetupFailureCopy,
  builderPolicyRefusalCopy,
  isBuilderPolicyRefusal,
} from "./run-failure-code";
import { isConfigError, isProviderAuthError, isRepoAccessDenied } from "./infra-retry";
import type { ScreenCheckRecord } from "@/services/qa/post-deploy-screen-check";
import { siteIdFromGraph } from "@/services/sites/site-run";
import { LOOK_PARKED_AT_KEY, lookAutoStartAt, lookAutoStartDue, type LookParkCheck } from "@/services/sites/look-wait";
import { STRUCTURAL_EDIT_ESTIMATE_USD, escalateFastEdit, isSiteRepairRequest } from "@/services/sites/site-edit-route";
import { SITE_VISION_CHECKPOINT_KEY, VISION_FIX_MARK } from "@/services/sites/site-vision-review";
import { SITE_DATABASE_SLOW, SITE_PUBLISH_PLATFORM_RETRY } from "@zavi/shared";
import { SITE_PREP_PLATFORM_FAILURE_RE } from "./outcome-model";

export const SITE_PREP_PLATFORM_COPY = "Zavi could not get your site's workspace ready for this change. Nothing was changed. Try again.";

export type ConductorNodeStatus = "pending" | "dispatched" | "done" | "failed";

export type ClassCapDecision = "charged" | "over_cap" | "read_error";

export type ConductorNode = {
  id: string;
  status: ConductorNodeStatus;
  target_agent_slug: string;
  payload: Record<string, unknown>;
  estimate_usd: number;
  last_charge_usd?: number;
  last_charge_key?: string;
  checkpoint?: {
    kind: "pushed" | "no_change";
    commit_sha: string | null;
    verified_at: string;
  };
  child_run_id?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  failure_class?: BuildFailureClass | null;
  repair_attempts?: number;
  last_failure_signal?: string | null;
  acceptance_attempts?: number;
  acceptance_reprobe_pending?: boolean;
  acceptance_reprobe_after?: number | null;
  screen_check?: ScreenCheckRecord;
  hosting_verified_at?: string;
  site_repair_attempts?: number;
  site_repair_pending?: boolean;
};

export type BuildFailureClass =
  | "stage_failed"
  | "dispatch_failed"
  | "provider_capacity"
  | "repair_exhausted"
  | "acceptance_failed"
  | "deploy_failed"
  | "budget_halted"
  | "class_cap_halted"
  | "stale_reaped"
  | "user_cancelled"
  | "provision_failed"
  | "coach_precedence"
  | "app_database_setup"
  | "unknown";

export const BUILD_FAILURE_CLASSES = [
  "stage_failed",
  "dispatch_failed",
  "provider_capacity",
  "repair_exhausted",
  "acceptance_failed",
  "deploy_failed",
  "budget_halted",
  "class_cap_halted",
  "stale_reaped",
  "user_cancelled",
  "provision_failed",
  "coach_precedence",
  "app_database_setup",
  "unknown",
] as const satisfies readonly BuildFailureClass[];

export const PUSH_GATE_DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;

export function coerceFailureClass(value: unknown): BuildFailureClass {
  return typeof value === "string" && (BUILD_FAILURE_CLASSES as readonly string[]).includes(value)
    ? (value as BuildFailureClass)
    : "unknown";
}

export function boundFailureReason(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;
  const sliced = raw.slice(0, 4000);
  const last = sliced.charCodeAt(sliced.length - 1);
  const trimmed = last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
  return trimmed || fallback;
}

export type ConductorRow = {
  id: string;
  tenant_id: string;
  objective: string;
  goal_graph: ConductorNode[];
  status: "active" | "halted" | "done" | "failed" | "paused";
  max_usd: number | null;
  spend_usd: number;
  kind?: "build_app" | "company_goal";
  goal_id?: string | null;
};

export type ChildTerminalStatus = "running" | "success" | "failed" | "held";

export type RepairConfig = {
  enabled: boolean;
  maxAttempts: number;
  repairableStages: string[];
};

export type JourneyFixClaim =
  | { status: "claimed"; token: string }
  | { status: "already_used" }
  | { status: "unavailable"; reason: string };

export type SiteDeployStepOutcome =
  | { kind: "waiting"; reason?: "database_capacity" }
  | { kind: "live"; url: string; verified_at: string; deploy_id?: string }
  | {
      kind: "repair";
      signal: string;
      journeys?: { names: string[]; must_pass: string[]; fingerprints?: Record<string, string> };
      free_fix?: "brief_journey";
    }
  | { kind: "failed"; reason: string };

export type SiteDeployDeps = {
  step: (input: {
    tenant_id: string;
    conductor_run_id: string;
    site_id: string;
    sha: string;
    attempt: number;
    checkpoint: Record<string, unknown>;
    brief?: string;
    kept_journeys?: { names: string[]; must_pass: string[]; fingerprints?: Record<string, string> };
  }) => Promise<SiteDeployStepOutcome>;
  headSha: (input: { tenant_id: string; site_id: string }) => Promise<string | null>;
  ownsSite?: (input: { tenant_id: string; site_id: string }) => Promise<boolean>;
  markDesired: (input: { tenant_id: string; site_id: string; sha: string }) => Promise<{ publish_generation?: number } | void>;
  settle?: (input: {
    tenant_id: string;
    site_id: string;
    outcome: "live" | "failed" | "paused";
    reason?: string;
    conductor_run_id?: string;
    refine_requested_at?: string;
    refine_run?: boolean;
    generation?: number;
  }) => Promise<void>;
  repairMaxAttempts: (tenant_id: string) => Promise<number>;
  claimJourneyFix?: (input: { tenant_id: string; site_id: string; conductor_run_id: string; attempt: number }) => Promise<JourneyFixClaim>;
  releaseJourneyFix?: (input: { tenant_id: string; site_id: string; token: string }) => Promise<void>;
  claimVisionFix?: (input: { tenant_id: string; site_id: string; conductor_run_id: string; attempt: number }) => Promise<JourneyFixClaim>;
  releaseVisionFix?: (input: { tenant_id: string; site_id: string; conductor_run_id: string; token: string }) => Promise<void>;
  neverPublished?: (input: { tenant_id: string; site_id: string }) => Promise<boolean>;
};

export type ConductorTickResult =
  | { action: "noop"; reason: string }
  | { action: "waiting"; in_flight: number; awaiting?: "look"; auto_start_at?: string }
  | { action: "halted" }
  | { action: "completed"; final: "done" | "failed" | "paused" }
  | { action: "dispatched"; node_id: string; child_run_id: string }
  | { action: "dispatch_failed"; node_id: string; reason: string }
  | { action: "repair_dispatched"; node_id: string; child_run_id: string; attempt: number }
  | { action: "completed_after_repair_exhausted"; node_id: string; root_cause: string; attempts: number; paused?: true }
  | { action: "class_over_cap"; node_id: string; decision_class: string }
  | { action: "class_read_error"; node_id: string; decision_class: string }
  | { action: "acceptance_repair_dispatched"; node_id: string; child_run_id: string; attempt: number }
  | { action: "site_repair_dispatched"; node_id: string; child_run_id: string; attempt: number }
  | { action: "completed_provider_capacity"; node_id: string; root_cause: string; attempts: number; paused?: true }
  | { action: "completed_app_database_setup"; node_id: string; root_cause: string; attempts: number; paused?: true }
  | { action: "completed_platform_config_error"; node_id: string; root_cause: string; attempts: number; paused?: true };

export type ProviderErrorClass = { transient: boolean; reason: string };

export function classifyProviderError(signal: string | null | undefined): ProviderErrorClass {
  const s = (signal ?? "").toLowerCase();
  if (!s) return { transient: false, reason: "" };

  const STRONG: RegExp[] = [
    /out of extra usage/,
    /usage limit (reached|exceeded|hit)/,
    /overloaded_error/,
    /insufficient[ _]?quota/,
    /\b529\b/,
  ];
  const WEAK: RegExp[] = [
    /\brate[ _-]?limit(ed|ing)?\b/,
    /too many requests/,
    /\b429\b/,
    /\boverloaded\b/,
    /(quota|capacity)[^\n]{0,30}(exceeded|exhausted|reached|limit)/,
  ];
  const PROVIDER_CTX =
    /(anthropic|claude|openai|\bllm\b|claude code|extra usage|usage limit|model (is )?overloaded|resets[^\n]{0,20}utc)/;

  if (isProviderAuthError(s) && /claude code/.test(s)) {
    return {
      transient: true,
      reason: "Your AI team lost its connection to the model provider. No code changes were made — retry in a bit.",
    };
  }
  const hit = STRONG.some((re) => re.test(s)) || (WEAK.some((re) => re.test(s)) && PROVIDER_CTX.test(s));
  return hit
    ? {
        transient: true,
        reason:
          "Your AI team hit provider capacity (LLM usage limit). No code changes were made — retry in a bit.",
      }
    : { transient: false, reason: "" };
}

export { APP_DATABASE_SETUP_FAILED_COPY };

const REPAIRLESS_CONFIG_ERROR_RES: readonly RegExp[] = [
  /^resolve-repo-creds: GITHUB_PROVISION_TOKEN not configured\b/,
  /^resolve-repo-creds: GitHub App not connected for this tenant\b/,
  /^resolve-repo-creds: GitHub is connected but no repositories are selected\b/,
  /^resolve-repo-creds: payload\.repo_hint missing and no repos are accessible\b/,
  /^resolve-repo-creds: tenant \S+ is an umbrella-provisioned app\b/,
  /^resolve-repo-creds: (?:autopilot target|repo_hint) "[^"]*" must be 'owner\/name'/,
  /^resolve-repo-creds: refusing autopilot target "[^"]*" — provisioned-repo gate failed \((?!query_error\))/,
];

export const REPO_ACCESS_DENIED_COPY =
  "Zavi couldn't open this app's code (access to its repository was refused), so nothing was changed.";

export function isRepairlessConfigError(signal: string | null | undefined): boolean {
  if (typeof signal !== "string" || !isConfigError(signal)) return false;
  return REPAIRLESS_CONFIG_ERROR_RES.some((re) => re.test(signal));
}

export function classifyAppDatabaseError(signal: string | null | undefined): {
  app_database: boolean;
  reason: string;
} {
  return /\bapp_database_setup_failed:/.test(signal ?? "")
    ? { app_database: true, reason: appSetupFailureCopy(signal) }
    : { app_database: false, reason: "" };
}

export type StaticPublishPlan = { action: "publish"; sha: string } | { action: "rollback" } | { action: "none" };

export type ConductorTickDeps = {
  load: (conductor_run_id: string) => Promise<ConductorRow | null>;
  sleep?: (ms: number) => Promise<void>;
  childStatus: (child_run_id: string) => Promise<ChildTerminalStatus>;
  verifyStagePush?: (args: {
    tenant_id: string;
    child_run_id: string | null;
    repo_full_name: string | null;
  }) => Promise<"landed" | "missing" | "unknown" | "refused" | "diverted">;
  childNoActionSignal?: (args: {
    tenant_id: string;
    child_run_id: string;
  }) => Promise<string | null>;
  childDeclaredOutcome?: (args: { tenant_id: string; child_run_id: string }) => Promise<"no_change" | "needs_input" | "refused" | null>;
  childRouteMiss?: (args: { tenant_id: string; child_run_id: string }) => Promise<boolean>;
  pushGateMaxWaitMs?: () => number;
  consumeBudget: (conductor_run_id: string, estimate_usd: number) => Promise<"charged" | "over_cap">;
  refundBudget?: (conductor_run_id: string, amount_usd: number, refund_key: string) => Promise<void>;
  consumeBudgetOnce?: (
    conductor_run_id: string,
    estimate_usd: number,
    charge_key: string,
  ) => Promise<"charged" | "already_charged" | "over_cap">;
  refundBudgetOnce?: (conductor_run_id: string, charge_key: string) => Promise<void>;
  isActive?: (conductor_run_id: string) => Promise<boolean>;
  stopChild?: (tenant_id: string, child_run_id: string) => Promise<void>;
  childDidNoWork?: (child_run_id: string) => Promise<boolean>;
  noChangeCheckpoint?: (args: {
    tenant_id: string;
    conductor_run_id: string;
    child_run_id: string;
    earlier_stage_landed: boolean;
  }) => Promise<{ commit_sha: string | null } | null>;
  stageCommitSha?: (args: { tenant_id: string; child_run_id: string }) => Promise<string | null>;
  consumeClassBudget?: (
    tenant_id: string,
    decision_class: string,
    estimate_usd: number,
  ) => Promise<ClassCapDecision>;
  decisionClassForStage?: (stage: string | null | undefined) => string | null;
  updateGoalProgress?: (tenant_id: string, goal_id: string, current_value: number) => Promise<void>;
  childOutput?: (child_run_id: string) => Promise<string | null>;
  dispatch: (input: {
    tenant_id: string;
    conductor_run_id: string;
    node_id: string;
    target_agent_slug: string;
    payload: Record<string, unknown>;
  }) => Promise<{ ok: true; child_run_id: string; adopted?: boolean } | { ok: false; reason: string }>;
  saveGraph: (conductor_run_id: string, goal_graph: ConductorNode[], reconcile_spend_delta: number) => Promise<void>;
  setStatus: (
    conductor_run_id: string,
    status: "done" | "failed" | "halted" | "paused",
    reason?: { failure_class: BuildFailureClass; failure_reason: string },
  ) => Promise<void>;
  repairConfig?: RepairConfig;
  captureFailureSignal?: (child_run_id: string) => Promise<string | null>;
  dispatchRepair?: (input: {
    tenant_id: string;
    conductor_run_id: string;
    node_id: string;
    attempt: number;
    target_agent_slug: string;
    payload: Record<string, unknown>;
    failure_signal: string;
  }) => Promise<{ ok: true; child_run_id: string; adopted?: boolean } | { ok: false; reason: string }>;
  hostingStatus?: (
    tenant_id: string,
    node?: ConductorNode,
  ) => Promise<"ready" | "failed" | "provisioning" | "none">;
  siteDeploy?: SiteDeployDeps;
  siteAwaitsLook?: (input: { tenant_id: string; site_id: string }) => Promise<boolean>;
  checkLookPark?: (input: { tenant_id: string; conductor_run_id: string }) => Promise<LookParkCheck>;
  autoPickLook?: (input: { tenant_id: string; site_id: string }) => Promise<boolean>;
  startPreview?: (input: { tenant_id: string; node: ConductorNode }) => void;
  ingestAppArtifact?: (input: {
    tenant_id: string;
    graph: ConductorNode[];
    deploy_node: ConductorNode;
  }) => void;
  clearInlineEditsOnRefine?: (tenant_id: string) => void;
  clearSiteInlineEditsOnRefine?: (input: {
    tenant_id: string;
    site_id: string;
    rows: ReadonlyArray<{ id: string; updated_at: string }>;
  }) => void;
  screenCheck?: (input: { tenant_id: string }) => Promise<ScreenCheckRecord>;
  staticPublish?: {
    plan: (input: { tenant_id: string; refine: boolean }) => Promise<StaticPublishPlan>;
    request: (input: { tenant_id: string; conductor_run_id: string; sha: string }) => Promise<unknown>;
    rollback: (input: { tenant_id: string }) => Promise<unknown>;
  };
  requestScreenCheck?: (input: {
    tenant_id: string;
    conductor_run_id: string;
    node_id: string;
  }) => Promise<unknown>;
  acceptanceProbe?: (input: {
    tenant_id: string;
    conductor_run_id: string;
    node: ConductorNode;
    refine?: boolean;
  }) => Promise<{ mode: "shadow" | "enforce"; pass: boolean; signal: string }>;
  acceptanceRepairMaxAttempts?: number;
  now?: () => number;
  resolveRefineGate?: (input: {
    tenant_id: string;
    conductor_run_id: string;
    engineer_run_id: string | null;
    qa_run_id: string | null;
  }) => Promise<unknown>;
};

export const DEFAULT_ACCEPTANCE_REPAIR_MAX_ATTEMPTS = 2;

export const ACCEPTANCE_REPROBE_GRACE_MS = 4 * 60 * 1000;

function stageOf(node: ConductorNode): string {
  const s = (node.payload as { stage?: unknown } | null | undefined)?.stage;
  return typeof s === "string" ? s : "";
}

function tickIso(deps: ConductorTickDeps): string {
  return new Date(deps.now ? deps.now() : Date.now()).toISOString();
}

export async function recordScreenCheck(
  screenCheck: (input: { tenant_id: string }) => Promise<ScreenCheckRecord>,
  tenant_id: string,
  nowIso: () => string,
): Promise<ScreenCheckRecord> {
  try {
    return await screenCheck({ tenant_id });
  } catch (e) {
    return {
      status: "skipped",
      checked_at: nowIso(),
      reason: `screen check threw: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
    };
  }
}

function clearNodeFailure(node: ConductorNode): void {
  node.error = null;
  node.failure_class = null;
  node.finished_at = null;
}

function reasonFromGraph(
  graph: ConductorNode[],
): { failure_class: BuildFailureClass; failure_reason: string } {
  const failed = graph.find((n) => n.status === "failed");
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const message =
    str(failed?.error) ||
    str(failed?.last_failure_signal) ||
    (failed ? `Stage "${stageOf(failed)}" failed without recording a reason.` : "");
  return {
    failure_class: failed
      ? coerceFailureClass(failed.failure_class ?? "stage_failed")
      : "unknown",
    failure_reason: boundFailureReason(
      message,
      "The build ended without recording a reason. This is a gap in our instrumentation, not a diagnosis.",
    ),
  };
}

const DISPATCH_IN_FLIGHT = "dispatch_in_flight";

async function stoppedMidTick(conductor_run_id: string, deps: ConductorTickDeps): Promise<boolean> {
  if (!deps.isActive) return false;
  try {
    return !(await deps.isActive(conductor_run_id));
  } catch {
    return true;
  }
}

async function cancelledDuringDispatch(conductor_run_id: string, deps: ConductorTickDeps): Promise<boolean> {
  if (!deps.isActive || !deps.stopChild) return false;
  try {
    return !(await deps.isActive(conductor_run_id));
  } catch {
    return false;
  }
}

async function refundCharge(
  node: ConductorNode,
  conductor_run_id: string,
  deps: ConductorTickDeps,
  refund_key: string,
): Promise<void> {
  const amt = node.last_charge_usd ?? 0;
  if (node.last_charge_key && deps.refundBudgetOnce) {
    if (amt <= 0) return;
    try {
      await deps.refundBudgetOnce(conductor_run_id, node.last_charge_key);
      node.last_charge_usd = 0;
      delete node.last_charge_key;
    } catch {
    }
    return;
  }
  if (!deps.refundBudget || amt <= 0) return;
  try {
    await deps.refundBudget(conductor_run_id, amt, refund_key);
    node.last_charge_usd = 0;
  } catch {
  }
}

async function refundAdoptedCharge(
  node: ConductorNode,
  conductor_run_id: string,
  deps: ConductorTickDeps,
): Promise<void> {
  if (node.last_charge_key) return;
  const charged = node.last_charge_usd ?? 0;
  await refundCharge(node, conductor_run_id, deps, tickRefundKey(node));
  node.last_charge_usd = charged;
}

async function refundUnlessKeyed(node: ConductorNode, conductor_run_id: string, deps: ConductorTickDeps): Promise<void> {
  if (node.last_charge_key) return;
  await refundCharge(node, conductor_run_id, deps, tickRefundKey(node));
}

function repairChargeKey(node: ConductorNode, kind: "site" | "acceptance" | "stage", attempt: number): string {
  const epoch = (node.payload as { resume_epoch?: unknown } | undefined)?.resume_epoch;
  return `repair:${kind}:${node.id}:e${typeof epoch === "number" ? epoch : 0}:a${attempt}`;
}

async function chargeRepairOnce(
  node: ConductorNode,
  conductor_run_id: string,
  deps: ConductorTickDeps,
  estimate: number,
  charge_key: string,
): Promise<"charged" | "over_cap"> {
  if (deps.consumeBudgetOnce) {
    const d = await deps.consumeBudgetOnce(conductor_run_id, estimate, charge_key);
    if (d === "over_cap") return "over_cap";
    node.last_charge_usd = estimate;
    node.last_charge_key = charge_key;
    return "charged";
  }
  const d = await deps.consumeBudget(conductor_run_id, estimate);
  if (d === "charged") {
    node.last_charge_usd = estimate;
    delete node.last_charge_key;
  }
  return d;
}

const NEVER_PAUSE: ReadonlySet<BuildFailureClass> = new Set<BuildFailureClass>([
  "user_cancelled",
  "provision_failed",
  "coach_precedence",
]);

export function pausableFailure(
  row: ConductorRow,
  graph: ConductorNode[],
  reason: { failure_class: BuildFailureClass } | undefined,
): boolean {
  if (row.kind !== "build_app") return false;
  if ((graph[0]?.payload as { refine_mode?: unknown } | undefined)?.refine_mode === true) return false;
  if (reason && NEVER_PAUSE.has(reason.failure_class)) return false;
  return graph.some((n) => {
    const stage = stageOf(n);
    return (stage === "scaffold" || stage === "build") && n.status === "done";
  });
}

async function setFailedOrPaused(
  row: ConductorRow,
  graph: ConductorNode[],
  conductor_run_id: string,
  deps: ConductorTickDeps,
  reason?: { failure_class: BuildFailureClass; failure_reason: string },
): Promise<"failed" | "paused"> {
  const status = pausableFailure(row, graph, reason) ? "paused" : "failed";
  if (status === "paused") {
    await settleSiteAfterStop(row, graph, deps, status, reason);
    await deps.setStatus(conductor_run_id, status, reason);
  } else {
    await deps.setStatus(conductor_run_id, status, reason);
    await settleSiteAfterStop(row, graph, deps, status, reason);
  }
  return status;
}

async function settleSiteAfterStop(
  row: ConductorRow,
  graph: ConductorNode[],
  deps: ConductorTickDeps,
  outcome: "failed" | "paused",
  reason?: { failure_class: BuildFailureClass; failure_reason: string },
): Promise<void> {
  const settle = deps.siteDeploy?.settle;
  if (!settle) return;
  const site_id = graph.map(siteIdOf).find((v): v is string => !!v);
  if (!site_id) return;
  const refineRun = (graph[0]?.payload as { refine_mode?: unknown } | undefined)?.refine_mode === true;
  const generation = runPublishGeneration(graph, site_id);
  const input = {
    tenant_id: row.tenant_id,
    site_id,
    conductor_run_id: row.id,
    outcome,
    reason: reason?.failure_reason ?? (outcome === "failed" ? "The build failed." : "The build stopped."),
    ...(refineRun ? { refine_run: true } : {}),
    ...(generation !== undefined ? { generation } : {}),
  };
  const attempts = outcome === "paused" || refineRun ? SITE_SETTLE_BACKOFF_MS.length + 1 : 1;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; i <= attempts; i++) {
    try {
      await settle(input);
      return;
    } catch (e) {
      if (i < attempts) {
        await sleep(SITE_SETTLE_BACKOFF_MS[i - 1]);
        continue;
      }
      console.warn(
        `[conductor] could not settle ${outcome} site ${site_id} of run ${row.id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      );
    }
  }
}

function notePublishGeneration(node: ConductorNode, generation: number | undefined): void {
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return;
  const prior = (node.payload as { site_publish_generation?: unknown }).site_publish_generation;
  if (typeof prior === "number" && prior >= generation) return;
  (node.payload as Record<string, unknown>).site_publish_generation = generation;
}

function noteCheckpointGenerations(node: ConductorNode, checkpoint: Record<string, unknown>): void {
  for (const entry of Object.values(checkpoint)) {
    const g = entry && typeof entry === "object" ? (entry as { generation?: unknown }).generation : undefined;
    notePublishGeneration(node, typeof g === "number" ? g : undefined);
  }
}

export function runPublishGeneration(graph: ConductorNode[], site_id: string): number | undefined {
  let out: number | undefined;
  for (const n of graph) {
    if (siteIdOf(n) !== site_id) continue;
    const g = (n.payload as { site_publish_generation?: unknown } | undefined)?.site_publish_generation;
    if (typeof g === "number" && Number.isSafeInteger(g) && (out === undefined || g > out)) out = g;
  }
  return out;
}

const SITE_SETTLE_BACKOFF_MS: readonly number[] = [250, 1_000, 3_000];

function isFreshBuildCodegenNode(row: ConductorRow, graph: ConductorNode[], node: ConductorNode): boolean {
  if (row.kind !== "build_app") return false;
  if ((graph[0]?.payload as { refine_mode?: unknown } | undefined)?.refine_mode === true) return false;
  const stage = stageOf(node);
  return stage === "scaffold" || stage === "build";
}

async function withPriorOutput(
  graph: ConductorNode[],
  node: ConductorNode,
  deps: ConductorTickDeps,
): Promise<Record<string, unknown>> {
  if (!deps.childOutput) return node.payload;
  const idx = graph.findIndex((n) => n.id === node.id);
  const prior = idx > 0 ? graph[idx - 1] : null;
  if (!prior || prior.status !== "done" || !prior.child_run_id) return node.payload;
  try {
    const out = await deps.childOutput(prior.child_run_id);
    if (!out || out.trim().length === 0) return node.payload;
    const enriched: Record<string, unknown> = { ...node.payload, prior_output: out };
    if (typeof enriched.prd !== "string" || enriched.prd.length === 0) {
      enriched.prd = out;
      const spec = graph
        .slice(0, idx)
        .reverse()
        .find((n) => stageOf(n) === "spec" && n.status === "done" && n.child_run_id);
      if (spec && spec !== prior && spec.child_run_id) {
        const specOut = await deps.childOutput(spec.child_run_id).catch(() => null);
        if (specOut && specOut.trim().length > 0) enriched.prd = specOut;
      }
    }
    return enriched;
  } catch {
    return node.payload;
  }
}

async function readNoChangeVerdict(
  row: ConductorRow,
  graph: ConductorNode[],
  node: ConductorNode,
  conductor_run_id: string,
  deps: ConductorTickDeps,
): Promise<{ commit_sha: string | null } | null> {
  if (!deps.noChangeCheckpoint || !node.child_run_id) return null;
  try {
    return await deps.noChangeCheckpoint({
      tenant_id: row.tenant_id,
      conductor_run_id,
      child_run_id: node.child_run_id,
      earlier_stage_landed: graph.some(
        (other) => other.id !== node.id && other.checkpoint?.kind === "pushed",
      ),
    });
  } catch {
    return null;
  }
}

function settleNoChange(
  node: ConductorNode,
  verdict: { commit_sha: string | null },
  row: ConductorRow,
  deps: ConductorTickDeps,
): void {
  node.status = "done";
  node.finished_at = tickIso(deps);
  node.error = null;
  node.failure_class = null;
  node.checkpoint = { kind: "no_change", commit_sha: verdict.commit_sha, verified_at: tickIso(deps) };
  if (stageOf(node) === "scaffold" && deps.startPreview) {
    try {
      deps.startPreview({ tenant_id: row.tenant_id, node });
    } catch {
      return;
    }
  }
}

function settleRefineDeclared(
  graph: ConductorNode[],
  node: ConductorNode,
  outcome: "no_change" | "needs_input" | "refused",
  deps: ConductorTickDeps,
): void {
  const at = tickIso(deps);
  node.status = "done";
  node.finished_at = at;
  node.error = null;
  node.failure_class = null;
  node.payload.no_change = true;
  node.payload.declared_outcome = outcome;
  node.checkpoint = { kind: "no_change", commit_sha: null, verified_at: at };
  for (const other of graph) {
    if (other === node || other.status !== "pending" || stageOf(other) !== "deploy") continue;
    other.status = "done";
    other.finished_at = at;
    other.error = null;
    other.failure_class = null;
    other.payload.no_change = true;
  }
}

function reopenForStructuralEdit(node: ConductorNode): void {
  node.status = "pending";
  node.estimate_usd = Math.max(Number(node.estimate_usd) || 0, STRUCTURAL_EDIT_ESTIMATE_USD);
  node.error = null;
  node.failure_class = null;
  node.finished_at = null;
  node.started_at = null;
  delete node.checkpoint;
}

function siteIdOf(node: ConductorNode): string | null {
  const v = (node.payload as { site_id?: unknown } | null | undefined)?.site_id;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export const SITE_DEPLOY_STEP_ERROR_LIMIT = 5;
export const SITE_REPAIR_NO_WORK_LIMIT = 2;

function siteRepairNoWork(node: ConductorNode): number {
  const v = node.payload.site_repair_no_work;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function resumeEpochOf(node: ConductorNode): number {
  const e = (node.payload as { resume_epoch?: unknown }).resume_epoch;
  return typeof e === "number" && Number.isFinite(e) ? e : 0;
}

function siteRepairNoWorkThisEpoch(node: ConductorNode): number {
  const v = node.payload.site_repair_no_work_epoch as { e?: unknown; n?: unknown } | undefined;
  if (!v || typeof v !== "object" || v.e !== resumeEpochOf(node)) return 0;
  return typeof v.n === "number" && Number.isFinite(v.n) && v.n > 0 ? Math.floor(v.n) : 0;
}

function siteRepairsUsed(node: ConductorNode): number {
  return Math.max(0, (node.site_repair_attempts ?? 0) - Math.min(SITE_REPAIR_NO_WORK_LIMIT, siteRepairNoWork(node)));
}

function clearSiteInlineEditsAfterRefine(row: ConductorRow, graph: ConductorNode[], deps: ConductorTickDeps): void {
  if (!deps.clearSiteInlineEditsOnRefine) return;
  const site_id = siteIdFromGraph(graph);
  if (!site_id) return;
  const engineer = graph.find((n) => {
    const p = n.payload as { refine_mode?: unknown; stage?: unknown } | null;
    return n.status === "done" && p?.refine_mode === true && p.stage === "build";
  });
  const declared = (engineer?.payload as { declared_outcome?: unknown } | undefined)?.declared_outcome;
  if (declared === "needs_input" || declared === "refused" || declared === "no_change") return;
  const carried = (engineer?.payload as { site_inline_edits?: unknown } | undefined)?.site_inline_edits;
  if (!Array.isArray(carried)) return;
  const rows = carried.filter(
    (r): r is { id: string; updated_at: string } =>
      !!r && typeof (r as { id?: unknown }).id === "string" && typeof (r as { updated_at?: unknown }).updated_at === "string",
  );
  if (rows.length === 0) return;
  try {
    deps.clearSiteInlineEditsOnRefine({ tenant_id: row.tenant_id, site_id, rows });
  } catch {
    return;
  }
}

export const SITE_CAPACITY_WAIT_MS = 15 * 60_000;

export const SITE_CAPACITY_RETRY_MS = 4 * 60_000;

async function siteDeployGate(
  conductor_run_id: string,
  row: ConductorRow,
  graph: ConductorNode[],
  node: ConductorNode,
  site_id: string,
  reconcileDelta: number,
  dirtyIn: boolean,
  deps: ConductorTickDeps,
): Promise<ConductorTickResult> {
  let dirty = dirtyIn;
  const tenant_id = row.tenant_id;
  const sd = deps.siteDeploy;
  const fail = async (reason: string, cls: BuildFailureClass): Promise<ConductorTickResult> => {
    node.started_at ??= tickIso(deps);
    failNode(node, deps, reason, cls);
    await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, reasonFromGraph(graph));
    return { action: "completed", final: ended };
  };
  const wait = async (): Promise<ConductorTickResult> => {
    if (dirty) await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    return { action: "waiting", in_flight: 0 };
  };
  if (!sd) return fail("Publishing new-stack sites is not available on this server.", "deploy_failed");
  if (sd.ownsSite) {
    let mine = true;
    try {
      mine = await sd.ownsSite({ tenant_id, site_id });
    } catch (e) {
      const n = (typeof node.payload.site_owns_errors === "number" ? node.payload.site_owns_errors : 0) + 1;
      node.payload.site_owns_errors = n;
      dirty = true;
      if (n >= SITE_DEPLOY_STEP_ERROR_LIMIT) {
        delete node.payload.site_owns_errors;
        return fail(`${SITE_PUBLISH_PLATFORM_RETRY}\nCould not read the site to publish: ${String((e as Error)?.message ?? e).slice(0, 300)}`, "deploy_failed");
      }
      return wait();
    }
    if (node.payload.site_owns_errors !== undefined) {
      delete node.payload.site_owns_errors;
      dirty = true;
    }
    if (!mine) {
      console.warn(`[conductor] site ${site_id} of run ${conductor_run_id} belongs to another environment; not publishing it here`);
      return wait();
    }
  }
  if (!node.started_at) {
    node.started_at = tickIso(deps);
    dirty = true;
  }

  const pinned = (node.payload as { site_sha?: unknown }).site_sha;
  let sha: string | null = typeof pinned === "string" && pinned.trim() ? pinned.trim() : null;
  if (!sha) {
    let headErr = "main's latest commit is unknown";
    try {
      const head = await sd.headSha({ tenant_id, site_id });
      sha = typeof head === "string" && head.trim() ? head.trim() : null;
    } catch (e) {
      headErr = String((e as Error)?.message ?? e).slice(0, 300);
      sha = null;
    }
    if (!sha) {
      const n = (typeof node.payload.site_head_errors === "number" ? node.payload.site_head_errors : 0) + 1;
      node.payload.site_head_errors = n;
      dirty = true;
      if (n >= SITE_DEPLOY_STEP_ERROR_LIMIT) {
        return fail(`${SITE_PUBLISH_PLATFORM_RETRY}\nCould not read the site's latest commit to publish: ${headErr}`, "deploy_failed");
      }
      return wait();
    }
    if (node.payload.site_head_errors !== undefined) {
      delete node.payload.site_head_errors;
      dirty = true;
    }
  }
  if (node.payload.site_desired_sha !== sha) {
    let marked: { publish_generation?: number } | void;
    try {
      marked = await sd.markDesired({ tenant_id, site_id, sha });
    } catch (e) {
      const n = (typeof node.payload.site_mark_errors === "number" ? node.payload.site_mark_errors : 0) + 1;
      node.payload.site_mark_errors = n;
      dirty = true;
      if (n >= SITE_DEPLOY_STEP_ERROR_LIMIT) {
        delete node.payload.site_mark_errors;
        return fail(`${SITE_PUBLISH_PLATFORM_RETRY}\nCould not record the commit to publish: ${String((e as Error)?.message ?? e).slice(0, 300)}`, "deploy_failed");
      }
      return wait();
    }
    delete node.payload.site_mark_errors;
    node.payload.site_desired_sha = sha;
    notePublishGeneration(node, marked ? marked.publish_generation : undefined);
    dirty = true;
  }

  {
    const since = node.payload.site_capacity_wait_since;
    const lastTry = node.payload.site_capacity_last_try;
    const nowMs = deps.now ? deps.now() : Date.now();
    if (typeof since === "number" && Number.isFinite(since) && since <= nowMs) {
      if (nowMs - since >= SITE_CAPACITY_WAIT_MS) {
        delete node.payload.site_capacity_wait_since;
        delete node.payload.site_capacity_last_try;
        console.error(`[conductor] site ${site_id} of run ${conductor_run_id}: no site database capacity after ${Math.round((nowMs - since) / 60_000)} min; failing the publish (retryable)`);
        return fail(SITE_DATABASE_SLOW, "deploy_failed");
      }
      if (typeof lastTry === "number" && Number.isFinite(lastTry) && lastTry <= nowMs && nowMs - lastTry < SITE_CAPACITY_RETRY_MS) {
        return wait();
      }
      node.payload.site_capacity_last_try = nowMs;
      dirty = true;
    }
  }

  const attempt = (node.site_repair_attempts ?? 0) + 1;
  const prior = node.payload.site_checkpoint;
  const checkpoint: Record<string, unknown> =
    prior && typeof prior === "object" && !Array.isArray(prior) ? { ...(prior as Record<string, unknown>) } : {};
  const before = JSON.stringify(checkpoint);
  let out: SiteDeployStepOutcome;
  const pendingFix = pendingJourneyFix(node, sha);
  if (pendingFix) {
    out = pendingFix;
  } else try {
    if (node.payload.site_journey_fix_pending !== undefined) {
      delete node.payload.site_journey_fix_pending;
      dirty = true;
    }
    out = await sd.step({ tenant_id, conductor_run_id, site_id, sha, attempt, checkpoint, brief: row.objective, kept_journeys: keptJourneysForStep(node) });
    if (node.payload.site_step_errors) {
      delete node.payload.site_step_errors;
      dirty = true;
    }
  } catch (e) {
    const n = (typeof node.payload.site_step_errors === "number" ? node.payload.site_step_errors : 0) + 1;
    node.payload.site_step_errors = n;
    dirty = true;
    if (JSON.stringify(checkpoint) !== before) {
      node.payload.site_checkpoint = checkpoint;
      noteCheckpointGenerations(node, checkpoint);
    }
    if (n >= SITE_DEPLOY_STEP_ERROR_LIMIT) {
      return fail(`${SITE_PUBLISH_PLATFORM_RETRY}\nPublishing kept failing: ${String((e as Error)?.message ?? e).slice(0, 300)}`, "deploy_failed");
    }
    return wait();
  }

  const freshVision = checkpoint[SITE_VISION_CHECKPOINT_KEY];
  if (freshVision !== undefined) {
    node.payload.site_vision = freshVision;
    delete checkpoint[SITE_VISION_CHECKPOINT_KEY];
    dirty = true;
  }
  if (settleVisionFix(node, out, freshVision, deps, { tenant_id, conductor_run_id, site_id })) dirty = true;

  if (JSON.stringify(checkpoint) !== before) {
    node.payload.site_checkpoint = checkpoint;
    noteCheckpointGenerations(node, checkpoint);
    dirty = true;
  }

  if (out.kind === "waiting" && out.reason === "database_capacity") {
    const nowMs = deps.now ? deps.now() : Date.now();
    const since = node.payload.site_capacity_wait_since;
    node.payload.site_capacity_last_try = nowMs;
    dirty = true;
    if (typeof since !== "number" || !Number.isFinite(since) || since > nowMs) {
      node.payload.site_capacity_wait_since = nowMs;
      console.warn(`[conductor] site ${site_id} of run ${conductor_run_id}: publish waiting for site database capacity`);
    } else if (nowMs - since >= SITE_CAPACITY_WAIT_MS) {
      delete node.payload.site_capacity_wait_since;
      delete node.payload.site_capacity_last_try;
      console.error(
        `[conductor] site ${site_id} of run ${conductor_run_id}: no site database capacity after ${Math.round((nowMs - since) / 60_000)} min; failing the publish (retryable)`,
      );
      return fail(SITE_DATABASE_SLOW, "deploy_failed");
    }
    return wait();
  }
  if (node.payload.site_capacity_wait_since !== undefined || node.payload.site_capacity_last_try !== undefined) {
    delete node.payload.site_capacity_wait_since;
    delete node.payload.site_capacity_last_try;
    dirty = true;
  }

  if (node.payload.site_journey_claim_errors !== undefined && !(out.kind === "repair" && out.free_fix === "brief_journey")) {
    delete node.payload.site_journey_claim_errors;
    dirty = true;
  }

  if (out.kind === "waiting") return wait();

  if (out.kind === "live") {
    node.status = "done";
    node.finished_at = tickIso(deps);
    node.hosting_verified_at = out.verified_at;
    if (out.deploy_id) node.payload.site_live_deploy_id = out.deploy_id;
    node.error = null;
    node.failure_class = null;
    node.last_failure_signal = null;
    delete node.payload.site_gate_kept;
    await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    const requestedAt = (node.payload as { refine_requested_at?: unknown }).refine_requested_at;
    await sd
      .settle?.({
        tenant_id,
        site_id,
        outcome: "live",
        conductor_run_id,
        ...(typeof requestedAt === "string" && requestedAt ? { refine_requested_at: requestedAt } : {}),
      })
      .catch(() => undefined);
    clearSiteInlineEditsAfterRefine(row, graph, deps);
    await deps.setStatus(conductor_run_id, "done");
    return { action: "completed", final: "done" };
  }

  if (out.kind === "failed") return fail(out.reason || "The site could not be published.", "deploy_failed");

  const signal = (out.signal || "The site did not pass its checks.").slice(0, 4000);
  const done = siteRepairsUsed(node);
  const visualFix = out.journeys?.must_pass.includes(VISION_FIX_MARK) === true;
  const fixCannotStart = siteRepairNoWorkThisEpoch(node) >= SITE_REPAIR_NO_WORK_LIMIT;
  if (fixCannotStart && !visualFix) {
    return fail(`${SITE_PUBLISH_PLATFORM_RETRY}\nThe site's fix could not start: its workspace could not be prepared.`, "deploy_failed");
  }
  let max = 1;
  if (visualFix) {
    max = done + 1;
  } else {
    try {
      max = Math.max(0, Math.floor(await sd.repairMaxAttempts(tenant_id)));
    } catch {
      max = 1;
    }
    if (visionFixRecord(node) !== null) max += 1;
  }
  const declineVisualFix = (why: string): Promise<ConductorTickResult> => {
    node.payload.site_vision_fix_used = true;
    const record = node.payload.site_vision;
    if (record && typeof record === "object" && !Array.isArray(record) && (record as { action?: unknown }).action === "repair") {
      node.payload.site_vision = { ...(record as Record<string, unknown>), action: "declined" };
    }
    dirty = true;
    console.warn(`[conductor] site ${site_id} of run ${conductor_run_id}: screenshot fix not dispatched (${why}); publishing the commit that passed its checks without it`);
    return wait();
  };
  if (visualFix && (fixCannotStart || !deps.dispatchRepair || node.payload.site_vision_fix_used === true || out.free_fix !== undefined)) {
    return declineVisualFix(fixCannotStart ? "its workspace could not be prepared" : "already used or unavailable");
  }
  let visionToken: string | null = null;
  if (visualFix) {
    let claim: JourneyFixClaim;
    if (!sd.claimVisionFix) {
      claim = { status: "unavailable", reason: "the free fix claim is not available on this server" };
    } else {
      try {
        claim = await sd.claimVisionFix({ tenant_id, site_id, conductor_run_id, attempt: (node.site_repair_attempts ?? 0) + 1 });
      } catch (e) {
        claim = { status: "unavailable", reason: String((e as Error)?.message ?? e).slice(0, 300) };
      }
    }
    if (claim?.status === "claimed" && typeof claim.token === "string" && claim.token) {
      visionToken = claim.token;
    } else {
      return declineVisualFix(
        claim?.status === "already_used" ? "this deploy already used its free fix" : `the free fix could not be reserved: ${claim?.status === "unavailable" ? claim.reason : "malformed claim answer"}`,
      );
    }
  }
  const wantsFree = out.free_fix === "brief_journey";
  if ((done >= max && !wantsFree) || !deps.dispatchRepair) {
    return fail(
      done > 0 ? `The site still failed its checks after ${done} fix attempt(s): ${signal}` : signal,
      "repair_exhausted",
    );
  }
  const buildNode = graph.find((n) => stageOf(n) === "build" && siteIdOf(n) === site_id);
  let fixFrom: { target_agent_slug: string; estimate_usd: number; payload: Record<string, unknown> };
  if (buildNode) {
    fixFrom = buildNode;
  } else {
    const firstPublish = await firstPublishFix(node, tenant_id, site_id, sd);
    if (firstPublish === "unknown") return wait();
    if (!firstPublish) {
      if (!visualFix) return fail(signal, "deploy_failed");
      if (visionToken && sd.releaseVisionFix) {
        await sd.releaseVisionFix({ tenant_id, site_id, conductor_run_id, token: visionToken }).catch(() => undefined);
      }
      return declineVisualFix("a republish has no build to fix from");
    }
    fixFrom = firstPublish;
  }
  let freeToken: string | null = null;
  if (wantsFree) {
    let claim: JourneyFixClaim;
    if (!sd.claimJourneyFix) {
      claim = { status: "unavailable", reason: "the free fix claim is not available on this server" };
    } else {
      try {
        claim = await sd.claimJourneyFix({ tenant_id, site_id, conductor_run_id, attempt: (node.site_repair_attempts ?? 0) + 1 });
      } catch (e) {
        claim = { status: "unavailable", reason: String((e as Error)?.message ?? e).slice(0, 300) };
      }
    }
    if (claim?.status === "claimed" && typeof claim.token === "string" && claim.token) {
      freeToken = claim.token;
    } else if (claim?.status !== "already_used") {
      const reason = claim?.status === "unavailable" ? claim.reason : "malformed claim answer";
      const n = (typeof node.payload.site_journey_claim_errors === "number" ? node.payload.site_journey_claim_errors : 0) + 1;
      node.payload.site_journey_claim_errors = n;
      dirty = true;
      console.warn(`[conductor] site ${site_id} of run ${conductor_run_id}: free fix claim not established (${n}/${SITE_DEPLOY_STEP_ERROR_LIMIT}): ${reason}`);
      if (n >= SITE_DEPLOY_STEP_ERROR_LIMIT) {
        delete node.payload.site_journey_claim_errors;
        delete node.payload.site_journey_fix_pending;
        return fail(`${SITE_PUBLISH_PLATFORM_RETRY}\nCould not reserve the site's free fix pass: ${reason}`, "deploy_failed");
      }
      node.payload.site_journey_fix_pending = { sha, signal: out.signal, ...(out.journeys ? { journeys: out.journeys } : {}) };
      return wait();
    }
    if (node.payload.site_journey_claim_errors !== undefined || node.payload.site_journey_fix_pending !== undefined) {
      delete node.payload.site_journey_claim_errors;
      delete node.payload.site_journey_fix_pending;
      dirty = true;
    }
  }
  const freeFix = freeToken !== null || visionToken !== null;
  if (done >= max && !freeFix) {
    return fail(
      done > 0 ? `The site still failed its checks after ${done} fix attempt(s): ${signal}` : signal,
      "repair_exhausted",
    );
  }
  const estimate = fixFrom.estimate_usd;
  const n = (node.site_repair_attempts ?? 0) + 1;
  let decision: "charged" | "over_cap";
  if (freeFix) {
    node.last_charge_usd = 0;
    node.last_charge_key = repairChargeKey(node, "site", n);
    decision = "charged";
  } else {
    decision = await chargeRepairOnce(node, conductor_run_id, deps, estimate, repairChargeKey(node, "site", n));
  }
  if (decision === "over_cap") {
    failNode(node, deps, "Build budget reached before the site fix.", "budget_halted");
    await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    await deps.setStatus(conductor_run_id, "halted", reasonFromGraph(graph));
    await settleSiteAfterStop(row, graph, deps, "paused", reasonFromGraph(graph));
    return { action: "halted" };
  }
  if (visualFix) node.payload.site_vision_fix_used = true;
  const payload: Record<string, unknown> = {
    ...fixFrom.payload,
    stage: "build",
    repair_mode: true,
    repair_attempt: n,
    failure_signal: signal,
    ...(freeToken !== null ? { brief_journey_fix: true, brief_journey_fix_token: freeToken, site_id } : {}),
    ...(visualFix ? { vision_fix: true, vision_fix_token: visionToken, site_id } : {}),
  };
  const rr = await deps.dispatchRepair({
    tenant_id,
    conductor_run_id,
    node_id: node.id,
    attempt: n,
    target_agent_slug: fixFrom.target_agent_slug,
    payload,
    failure_signal: signal,
  });
  if (!rr.ok) {
    await refundUnlessKeyed(node, conductor_run_id, deps);
    if (rr.reason === DISPATCH_IN_FLIGHT) return { action: "waiting", in_flight: 1 };
    if (freeToken && sd.releaseJourneyFix) {
      await sd.releaseJourneyFix({ tenant_id, site_id, token: freeToken }).catch(() => undefined);
    }
    if (visionToken && sd.releaseVisionFix) {
      await sd.releaseVisionFix({ tenant_id, site_id, conductor_run_id, token: visionToken }).catch(() => undefined);
    }
    node.site_repair_attempts = n;
    return fail(`The site fix could not start (${rr.reason}); ${signal}`, "dispatch_failed");
  }
  if (rr.adopted) await refundAdoptedCharge(node, conductor_run_id, deps);
  node.status = "dispatched";
  node.child_run_id = rr.child_run_id;
  node.site_repair_attempts = n;
  node.site_repair_pending = true;
  if (visualFix) {
    const before = qualifyingOf(node.payload.site_vision);
    node.payload.site_vision_fix = {
      dispatched_at: tickIso(deps),
      attempt: n,
      qualifying_before: before,
      ...(before !== null && before > 0 && qualifyingPageOf(node.payload.site_vision) === before ? { page_only: true } : {}),
    };
  }
  delete node.payload.site_checkpoint;
  if (!buildNode) delete node.payload.site_sha;
  node.last_failure_signal = signal;
  if (out.journeys) {
    const prev = keptJourneys(node);
    node.payload.site_gate_kept = {
      names: [...new Set([...(prev?.names ?? []), ...out.journeys.names])],
      must_pass: [...new Set([...(prev?.must_pass ?? []), ...out.journeys.must_pass])],
      fingerprints: { ...(out.journeys.fingerprints ?? {}), ...(prev?.fingerprints ?? {}) },
    };
  }
  await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
  return { action: "site_repair_dispatched", node_id: node.id, child_run_id: rr.child_run_id, attempt: n };
}

export type VisionFixOutcome = "fixed" | "still_flagged" | "not_rechecked" | "checks_failed" | "failed";

type VisionFixRecord = {
  dispatched_at: string;
  attempt: number;
  qualifying_before: number | null;
  page_only?: boolean;
  outcome?: VisionFixOutcome;
  ms?: number;
  qualifying_after?: number | null;
};

function visionFixRecord(node: ConductorNode): VisionFixRecord | null {
  const r = node.payload.site_vision_fix as Partial<VisionFixRecord> | undefined;
  return r && typeof r === "object" && typeof r.dispatched_at === "string" && typeof r.attempt === "number" ? (r as VisionFixRecord) : null;
}

function qualifyingOf(record: unknown): number | null {
  const c = (record as { counts?: { qualifying?: unknown } } | null | undefined)?.counts?.qualifying;
  return typeof c === "number" && Number.isFinite(c) ? c : null;
}

function qualifyingPageOf(record: unknown): number | null {
  const c = (record as { counts?: { qualifying_page?: unknown } } | null | undefined)?.counts?.qualifying_page;
  return typeof c === "number" && Number.isFinite(c) ? c : null;
}

function settleVisionFix(
  node: ConductorNode,
  out: SiteDeployStepOutcome,
  freshVision: unknown,
  deps: ConductorTickDeps,
  ids: { tenant_id: string; conductor_run_id: string; site_id: string },
): boolean {
  const rec = visionFixRecord(node);
  if (!rec || rec.outcome !== undefined || (node.site_repair_attempts ?? 0) !== rec.attempt) return false;
  if (out.kind === "waiting" && freshVision === undefined) return false;
  const fresh = freshVision as { status?: unknown; page_check?: unknown } | undefined;
  const reviewed = rec.page_only === true ? !!fresh?.page_check : fresh?.status === "reviewed";
  const after = !reviewed ? null : rec.page_only === true ? qualifyingPageOf(freshVision) : qualifyingOf(freshVision);
  const outcome: VisionFixOutcome =
    out.kind === "failed" ? "failed" : out.kind === "repair" ? "checks_failed" : !reviewed || after === null ? "not_rechecked" : after === 0 ? "fixed" : "still_flagged";
  const nowMs = deps.now ? deps.now() : Date.now();
  const started = Date.parse(rec.dispatched_at);
  const ms = Number.isFinite(started) ? Math.max(0, nowMs - started) : 0;
  node.payload.site_vision_fix = { ...rec, outcome, ms, qualifying_after: after };
  console.info(
    `[conductor] event=vision_fix_outcome tenant=${ids.tenant_id} run=${ids.conductor_run_id} site=${ids.site_id} outcome=${outcome} ms=${ms} before=${rec.qualifying_before ?? "?"} after=${after ?? "?"}`,
  );
  void import("@/services/logging/logEvent")
    .then(({ logEvent }) =>
      logEvent({
        level: "info",
        source: "site-deploy",
        code: "site_vision.fix_outcome",
        tenant_id: ids.tenant_id,
        meta: { ms, vision_fix_outcome: outcome, findings_before: rec.qualifying_before ?? -1, findings_after: after ?? -1, node_id: node.id },
      }),
    )
    .catch(() => undefined);
  return true;
}

function pendingJourneyFix(node: ConductorNode, sha: string): SiteDeployStepOutcome | null {
  const p = node.payload.site_journey_fix_pending as { sha?: unknown; signal?: unknown; journeys?: unknown } | undefined;
  if (!p || typeof p !== "object" || p.sha !== sha || typeof p.signal !== "string") return null;
  const j = p.journeys as { names?: unknown; must_pass?: unknown; fingerprints?: unknown } | undefined;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const journeys =
    j && typeof j === "object"
      ? {
          names: strings(j.names),
          must_pass: strings(j.must_pass),
          ...(j.fingerprints && typeof j.fingerprints === "object"
            ? {
                fingerprints: Object.fromEntries(
                  Object.entries(j.fingerprints as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
                ),
              }
            : {}),
        }
      : undefined;
  return { kind: "repair", signal: p.signal, free_fix: "brief_journey", ...(journeys ? { journeys } : {}) };
}

export const SITE_FIRST_PUBLISH_FIX_ESTIMATE_USD = 3;

function keptJourneys(node: ConductorNode): { names: string[]; must_pass: string[]; fingerprints: Record<string, string> } | undefined {
  const k = node.payload.site_gate_kept as { names?: unknown; must_pass?: unknown; fingerprints?: unknown } | undefined;
  if (!k || typeof k !== "object") return undefined;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const prints =
    k.fingerprints && typeof k.fingerprints === "object"
      ? Object.fromEntries(Object.entries(k.fingerprints as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
      : {};
  return { names: strings(k.names), must_pass: strings(k.must_pass), fingerprints: prints };
}

function keptJourneysForStep(node: ConductorNode): { names: string[]; must_pass: string[]; fingerprints: Record<string, string> } | undefined {
  const kept = keptJourneys(node);
  if (node.payload.site_vision_fix_used !== true) return kept;
  const base = kept ?? { names: [], must_pass: [], fingerprints: {} };
  return base.must_pass.includes(VISION_FIX_MARK) ? base : { ...base, must_pass: [...base.must_pass, VISION_FIX_MARK] };
}

async function firstPublishFix(
  node: ConductorNode,
  tenant_id: string,
  site_id: string,
  sd: SiteDeployDeps,
): Promise<{ target_agent_slug: string; estimate_usd: number; payload: Record<string, unknown> } | null | "unknown"> {
  const p = node.payload as { publish_request?: unknown; target?: { github_full_name?: unknown }; parent_conductor_run_id?: unknown };
  if (p.publish_request !== true || !sd.neverPublished) return null;
  const repo = typeof p.target?.github_full_name === "string" ? p.target.github_full_name.trim() : "";
  if (!repo) return null;
  let never: boolean;
  try {
    never = (await sd.neverPublished({ tenant_id, site_id })) === true;
  } catch {
    return "unknown";
  }
  if (!never) return null;
  return {
    target_agent_slug: "engineer",
    estimate_usd: SITE_FIRST_PUBLISH_FIX_ESTIMATE_USD,
    payload: {
      refine_mode: true,
      site_id,
      target: p.target,
      ...(typeof p.parent_conductor_run_id === "string" ? { parent_conductor_run_id: p.parent_conductor_run_id } : {}),
    },
  };
}

function tickRefundKey(node: ConductorNode): string {
  return `tick:${randomUUID()}:${node.id}`;
}

function failNode(
  node: ConductorNode,
  deps: ConductorTickDeps,
  error: string,
  failureClass: BuildFailureClass,
): void {
  const message = error.trim().slice(0, 4000) || `stage "${stageOf(node)}" failed`;
  node.status = "failed";
  node.error = message;
  node.last_failure_signal = message;
  node.failure_class = failureClass;
  node.finished_at = tickIso(deps);
}

async function captureNodeFailure(
  node: ConductorNode,
  deps: ConductorTickDeps,
): Promise<string> {
  let signal = `stage "${stageOf(node)}" failed`;
  if (deps.captureFailureSignal && node.child_run_id) {
    try {
      const captured = await deps.captureFailureSignal(node.child_run_id);
      if (captured?.trim()) signal = captured.trim().slice(0, 4000);
    } catch {
    }
  }
  return signal;
}

async function checkClassCap(
  row: ConductorRow,
  node: ConductorNode,
  deps: ConductorTickDeps,
): Promise<
  | { ok: true }
  | { ok: false; reason: "over_cap" | "read_error"; decision_class: string }
> {
  if (!deps.consumeClassBudget || !deps.decisionClassForStage) return { ok: true };
  const decision_class = deps.decisionClassForStage(stageOf(node));
  if (!decision_class) return { ok: true };
  const verdict = await deps.consumeClassBudget(
    row.tenant_id,
    decision_class,
    node.estimate_usd,
  );
  if (verdict === "charged") return { ok: true };
  return { ok: false, reason: verdict === "read_error" ? "read_error" : "over_cap", decision_class };
}

function repoOf(node: ConductorNode): string | null {
  const target = (node.payload as { target?: { github_full_name?: unknown; repo_url?: unknown } } | null)
    ?.target;
  const full = target?.github_full_name;
  if (typeof full === "string" && /^[^/]+\/[^/]+$/.test(full)) return full;
  const url = target?.repo_url;
  if (typeof url === "string") {
    const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

async function handleAcceptanceGate(
  conductor_run_id: string,
  row: ConductorRow,
  graph: ConductorNode[],
  deployNode: ConductorNode,
  reconcileDelta: number,
  deps: ConductorTickDeps,
): Promise<ConductorTickResult | null> {
  if (!deps.acceptanceProbe) return null;

  let probe: { mode: "shadow" | "enforce"; pass: boolean; signal: string } | null;
  try {
    probe = await deps.acceptanceProbe({
      tenant_id: row.tenant_id,
      conductor_run_id,
      node: deployNode,
      refine:
        typeof (deployNode.payload as { pre_refine_sha?: unknown } | undefined)?.pre_refine_sha === "string" ||
        (graph[0]?.payload as { refine_mode?: unknown } | undefined)?.refine_mode === true,
    });
  } catch {
    probe = null;
  }
  if (!probe || probe.mode === "shadow" || probe.pass) return null;

  const cap =
    typeof deps.acceptanceRepairMaxAttempts === "number" && deps.acceptanceRepairMaxAttempts > 0
      ? Math.min(Math.floor(deps.acceptanceRepairMaxAttempts), 5)
      : DEFAULT_ACCEPTANCE_REPAIR_MAX_ATTEMPTS;
  const attemptsSoFar =
    typeof deployNode.acceptance_attempts === "number" && Number.isFinite(deployNode.acceptance_attempts)
      ? deployNode.acceptance_attempts
      : 0;
  const signal = probe.signal || "acceptance gate failed";

  if (attemptsSoFar >= cap || !deps.dispatchRepair) {
    failNode(
      deployNode,
      deps,
      `acceptance gate failed after ${attemptsSoFar} repair(s): ${signal}`,
      "acceptance_failed",
    );
    await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, reasonFromGraph(graph));
    return { action: "completed", final: ended };
  }

  const sibling = graph.find(
    (n) => n.id !== deployNode.id && typeof (n.payload as { idea?: unknown })?.idea === "string",
  );
  const repairAgent =
    sibling && typeof sibling.target_agent_slug === "string" && sibling.target_agent_slug.length > 0
      ? sibling.target_agent_slug
      : "engineer";
  const repairEstimate =
    sibling && Number.isFinite(sibling.estimate_usd) && sibling.estimate_usd > 0 ? sibling.estimate_usd : 3;
  const attempt = attemptsSoFar + 1;

  const decision = await chargeRepairOnce(
    deployNode,
    conductor_run_id,
    deps,
    repairEstimate,
    repairChargeKey(deployNode, "acceptance", attempt),
  );
  if (decision === "over_cap") {
    deployNode.error = "Build budget reached during acceptance repair.";
    deployNode.failure_class = "budget_halted";
    deployNode.finished_at = tickIso(deps);
    await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    return { action: "halted" };
  }

  const sib = (sibling?.payload ?? {}) as { idea?: unknown; company_name?: unknown; target?: unknown };
  const repairPayload: Record<string, unknown> = {
    ...deployNode.payload,
    stage: "build",
    refine_mode: true,
    repair_mode: true,
    acceptance_repair: true,
    repair_attempt: attempt,
    failure_signal: signal,
  };
  if (typeof sib.idea === "string") repairPayload.idea = sib.idea;
  if (typeof sib.company_name === "string") repairPayload.company_name = sib.company_name;
  if (sib.target !== undefined) repairPayload.target = sib.target;

  if (await stoppedMidTick(conductor_run_id, deps)) {
    await refundCharge(deployNode, conductor_run_id, deps, tickRefundKey(deployNode));
    return { action: "noop", reason: "stopped" };
  }
  const rr = await deps.dispatchRepair({
    tenant_id: row.tenant_id,
    conductor_run_id,
    node_id: deployNode.id,
    attempt,
    target_agent_slug: repairAgent,
    payload: repairPayload,
    failure_signal: signal,
  });
  if (!rr.ok) {
    await refundUnlessKeyed(deployNode, conductor_run_id, deps);
    if (rr.reason === DISPATCH_IN_FLIGHT) return { action: "waiting", in_flight: 1 };
    deployNode.acceptance_attempts = attempt;
    failNode(
      deployNode,
      deps,
      `acceptance auto-repair dispatch failed (${rr.reason}); ${signal}`,
      "dispatch_failed",
    );
    await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, reasonFromGraph(graph));
    return { action: "completed", final: ended };
  }

  if (await cancelledDuringDispatch(conductor_run_id, deps)) {
    await deps.stopChild?.(row.tenant_id, rr.child_run_id).catch((e: unknown) => {
      console.warn(
        `[conductor] could not stop acceptance repair ${rr.child_run_id} of cancelled run ${conductor_run_id}: ${(e as Error)?.message}`,
      );
    });
    await refundCharge(deployNode, conductor_run_id, deps, tickRefundKey(deployNode));
    return { action: "noop", reason: "stopped" };
  }

  deployNode.status = "dispatched";
  if (rr.adopted) await refundAdoptedCharge(deployNode, conductor_run_id, deps);
  deployNode.child_run_id = rr.child_run_id;
  deployNode.acceptance_attempts = attempt;
  deployNode.acceptance_reprobe_pending = true;
  deployNode.acceptance_reprobe_after = null;
  deployNode.last_failure_signal = signal;
  deployNode.started_at = tickIso(deps);
  clearNodeFailure(deployNode);
  await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
  return {
    action: "acceptance_repair_dispatched",
    node_id: deployNode.id,
    child_run_id: rr.child_run_id,
    attempt,
  };
}

async function requestStaticPublishOnce(
  row: ConductorRow,
  graph: ConductorNode[],
  deployNode: ConductorNode,
  conductor_run_id: string,
  deps: ConductorTickDeps,
): Promise<boolean> {
  const sp = deps.staticPublish;
  if (!sp) return false;
  const p = deployNode.payload as Record<string, unknown>;
  const pre = typeof p.pre_refine_sha === "string" ? p.pre_refine_sha : null;
  const refine = pre !== null || (graph[0]?.payload as { refine_mode?: unknown } | undefined)?.refine_mode === true;
  try {
    const plan = await sp.plan({ tenant_id: row.tenant_id, refine });
    if (plan.action === "rollback") {
      await sp.rollback({ tenant_id: row.tenant_id });
      return false;
    }
    if (plan.action !== "publish" || plan.sha === pre || p.static_publish_requested_sha === plan.sha) return false;
    await sp.request({ tenant_id: row.tenant_id, conductor_run_id, sha: plan.sha });
    p.static_publish_requested_sha = plan.sha;
    return true;
  } catch {
    return false;
  }
}

export function stampRefineEngineerRun(graph: ConductorNode[], deployNode: ConductorNode): boolean {
  const p = deployNode.payload as Record<string, unknown>;
  if (typeof p.pre_refine_sha !== "string" || typeof p.refine_engineer_run_id === "string") return false;
  const engineer = graph.find((n) => n !== deployNode && n.target_agent_slug === "engineer" && typeof n.child_run_id === "string" && n.child_run_id.length > 0);
  if (!engineer?.child_run_id) return false;
  p.refine_engineer_run_id = engineer.child_run_id;
  return true;
}

export async function conductorTick(
  conductor_run_id: string,
  deps: ConductorTickDeps,
): Promise<ConductorTickResult> {
  const row = await deps.load(conductor_run_id);
  if (!row) return { action: "noop", reason: "missing" };
  if (row.status !== "active") return { action: "noop", reason: row.status };

  const graph = row.goal_graph.map((n) => ({ ...n }));
  let dirty = false;
  let reconcileDelta = 0;

  for (const node of graph) {
    if (node.status === "dispatched" && node.child_run_id) {
      if (node.site_repair_pending === true) {
        const scs = await deps.childStatus(node.child_run_id);
        if (scs !== "running") {
          if (scs === "failed") {
            try {
              if (deps.childDidNoWork && (await deps.childDidNoWork(node.child_run_id))) {
                await refundCharge(node, conductor_run_id, deps, `child:${node.child_run_id}`);
                if ((node.last_charge_usd ?? 0) === 0) {
                  node.payload.site_repair_no_work = siteRepairNoWork(node) + 1;
                  node.payload.site_repair_no_work_epoch = { e: resumeEpochOf(node), n: siteRepairNoWorkThisEpoch(node) + 1 };
                }
              }
            } catch {
            }
          }
          node.status = "pending";
          node.child_run_id = null;
          node.site_repair_pending = false;
          dirty = true;
        }
        continue;
      }
      if (node.acceptance_reprobe_pending === true) {
        const rcs = await deps.childStatus(node.child_run_id);
        if (rcs !== "running") {
          node.status = "pending";
          node.child_run_id = null;
          node.acceptance_reprobe_pending = false;
          node.acceptance_reprobe_after =
            (deps.now ? deps.now() : Date.now()) + ACCEPTANCE_REPROBE_GRACE_MS;
          delete node.payload.deploy_enqueued_at;
          dirty = true;
        }
        continue;
      }
      let cs = await deps.childStatus(node.child_run_id);
      if (row.kind === "build_app" && cs === "held") cs = "success";
      if (
        row.kind === "build_app" &&
        stageOf(node) === "refine_gate" &&
        deps.resolveRefineGate &&
        (cs === "success" || cs === "failed")
      ) {
        const gateIdx = graph.findIndex((n) => n.id === node.id);
        const engineerNode = gateIdx > 0 ? graph[gateIdx - 1] : null;
        try {
          await deps.resolveRefineGate({
            tenant_id: row.tenant_id,
            conductor_run_id,
            engineer_run_id: engineerNode?.child_run_id ?? null,
            qa_run_id: node.child_run_id,
          });
        } catch (e) {
          console.warn(
            `[conductor] resolveRefineGate threw for run ${conductor_run_id} node ${node.id}: ${(e as Error).message}`,
          );
        }
        node.status = "done";
        node.finished_at = tickIso(deps);
        node.error = null;
        node.failure_class = null;
        dirty = true;
        continue;
      }
      if (cs === "success") {
        if (
          row.kind === "build_app" &&
          deps.childDeclaredOutcome &&
          (node.payload as { refine_mode?: unknown }).refine_mode === true &&
          stageOf(node) === "build" &&
          !(typeof node.repair_attempts === "number" && node.repair_attempts > 0)
        ) {
          let declared: "no_change" | "needs_input" | "refused" | null = null;
          try {
            declared = await deps.childDeclaredOutcome({ tenant_id: row.tenant_id, child_run_id: node.child_run_id });
          } catch {
            declared = null;
          }
          let routeMiss = false;
          if (declared && node.payload.fast_edit === true && deps.childRouteMiss) {
            try {
              routeMiss = await deps.childRouteMiss({ tenant_id: row.tenant_id, child_run_id: node.child_run_id });
            } catch {
              routeMiss = false;
            }
          }
          if (routeMiss && escalateFastEdit(node.payload)) {
            reopenForStructuralEdit(node);
            console.info(`[conductor] event=refine_fast_escalated outcome=${declared} run=${conductor_run_id} tenant=${row.tenant_id} child=${node.child_run_id ?? "-"}`);
            node.child_run_id = null;
            dirty = true;
            continue;
          }
          if (declared === "no_change" && isSiteRepairRequest(node.payload.user_request ?? node.payload.idea)) {
            failNode(node, deps, "The preview repair made no verified change. Diagnose the reported error, repair dependencies or source, and verify the affected route before declaring it fixed.", "stage_failed");
            dirty = true;
            continue;
          }
          if (declared) {
            settleRefineDeclared(graph, node, declared, deps);
            console.info(`[conductor] event=refine_declared outcome=${declared} run=${conductor_run_id} tenant=${row.tenant_id} child=${node.child_run_id}`);
            dirty = true;
            continue;
          }
        }
        if (
          row.kind === "build_app" &&
          deps.childNoActionSignal &&
          (stageOf(node) === "scaffold" || stageOf(node) === "build")
        ) {
          let noActionSignal: string | null = null;
          try {
            noActionSignal = await deps.childNoActionSignal({
              tenant_id: row.tenant_id,
              child_run_id: node.child_run_id,
            });
          } catch {
            noActionSignal = null;
          }
          if (noActionSignal && isFreshBuildCodegenNode(row, graph, node)) {
            const verdict = await readNoChangeVerdict(row, graph, node, conductor_run_id, deps);
            if (verdict) {
              settleNoChange(node, verdict, row, deps);
            } else {
              failNode(node, deps, noActionSignal, "stage_failed");
            }
            dirty = true;
            continue;
          }
          if (noActionSignal) {
            failNode(node, deps, noActionSignal, "stage_failed");
            await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
            const ended = await setFailedOrPaused(
              row,
              graph,
              conductor_run_id,
              deps,
              {
                failure_class: "stage_failed",
                failure_reason: noActionSignal,
              },
            );
            return { action: "completed", final: ended };
          }
        }
        if (
          row.kind === "build_app" &&
          deps.verifyStagePush &&
          (stageOf(node) === "scaffold" || stageOf(node) === "build")
        ) {
          const nowMs = deps.now ? deps.now() : Date.now();
          if (typeof node.payload.push_check_started_at !== "number") {
            node.payload.push_check_started_at = nowMs;
            dirty = true;
          }
          let landed: "landed" | "missing" | "unknown" | "refused" | "diverted";
          try {
            landed = await deps.verifyStagePush({
              tenant_id: row.tenant_id,
              child_run_id: node.child_run_id,
              repo_full_name: repoOf(node),
            });
          } catch {
            landed = "unknown";
          }
          if (landed === "diverted") landed = isFreshBuildCodegenNode(row, graph, node) ? "refused" : "landed";
          if (landed === "refused") {
            failNode(
              node,
              deps,
              `Stage "${stageOf(node)}" finished but its code could not be pushed to the provisioned repo` +
                `${repoOf(node) ? ` (${repoOf(node)})` : ""}: the publish step failed, so nothing will land.`,
              "dispatch_failed",
            );
            dirty = true;
            continue;
          }
          if (landed === "missing") {
            const startedAt = node.payload.push_check_started_at as number;
            const waitedMs = nowMs - startedAt;
            const bound = deps.pushGateMaxWaitMs
              ? deps.pushGateMaxWaitMs()
              : PUSH_GATE_DEFAULT_MAX_WAIT_MS;
            if (waitedMs > bound) {
              failNode(
                node,
                deps,
                `Stage "${stageOf(node)}" finished but no code reached the provisioned repo` +
                  `${repoOf(node) ? ` (${repoOf(node)})` : ""} after ${Math.round(waitedMs / 60000)} min. ` +
                  `The generated code was never pushed, so the app would deploy its seed placeholder.`,
                "stage_failed",
              );
              dirty = true;
              continue;
            }
            continue;
          }
          if (landed === "landed" && isFreshBuildCodegenNode(row, graph, node)) {
            let sha: string | null = null;
            try {
              sha = deps.stageCommitSha
                ? await deps.stageCommitSha({ tenant_id: row.tenant_id, child_run_id: node.child_run_id })
                : null;
            } catch {
              sha = null;
            }
            node.checkpoint = { kind: "pushed", commit_sha: sha, verified_at: tickIso(deps) };
          }
        }
        node.status = "done";
        node.finished_at = tickIso(deps);
        node.error = null;
        node.failure_class = null;
        dirty = true;
        if (row.kind === "build_app" && stageOf(node) === "scaffold" && deps.startPreview) {
          try {
            deps.startPreview({ tenant_id: row.tenant_id, node });
          } catch {
          }
        }
        if (row.kind === "company_goal" && deps.updateGoalProgress) {
          const payload = (node.payload ?? {}) as {
            goal_id?: unknown;
            target_metric_after_reading?: unknown;
            current_value?: unknown;
          };
          const goal_id =
            typeof payload.goal_id === "string" && payload.goal_id.length > 0
              ? payload.goal_id
              : null;
          let next: number | null = null;
          if (typeof payload.current_value === "number" && Number.isFinite(payload.current_value)) {
            next = payload.current_value;
          } else if (
            typeof payload.target_metric_after_reading === "number" &&
            Number.isFinite(payload.target_metric_after_reading)
          ) {
            next = payload.target_metric_after_reading;
          }
          if (goal_id && next !== null) {
            try {
              await deps.updateGoalProgress(row.tenant_id, goal_id, next);
            } catch {
            }
          }
        }
      } else if (cs === "failed") {
        if (isFreshBuildCodegenNode(row, graph, node)) {
          const verdict = await readNoChangeVerdict(row, graph, node, conductor_run_id, deps);
          if (verdict) {
            settleNoChange(node, verdict, row, deps);
            dirty = true;
            continue;
          }
        }
        try {
          if (deps.childDidNoWork && (await deps.childDidNoWork(node.child_run_id))) {
            await refundCharge(node, conductor_run_id, deps, `child:${node.child_run_id}`);
          }
        } catch {
        }
        const failure = await captureNodeFailure(node, deps);
        const appDb = isBuilderPolicyRefusal(failure)
          ? { app_database: false, reason: "" }
          : classifyAppDatabaseError(failure);
        if (appDb.app_database) failNode(node, deps, appDb.reason, "app_database_setup");
        else failNode(node, deps, failure, "stage_failed");
        dirty = true;
      }
    }
  }

  if (row.kind === "build_app") {
    const next = graph.find((n) => n.status === "pending");
    if (
      next &&
      stageOf(next) === "qa" &&
      !graph.some((n) => n.status === "dispatched" || n.status === "failed")
    ) {
      next.status = "done";
      next.started_at ??= tickIso(deps);
      next.finished_at = tickIso(deps);
      next.error = null;
      next.failure_class = null;
      dirty = true;
    }
  }

  const inFlight = graph.filter((n) => n.status === "dispatched").length;
  const firstPending = graph.find((n) => n.status === "pending");
  const anyFailed = graph.some((n) => n.status === "failed");

  const repairCfg = deps.repairConfig;
  if (
    repairCfg?.enabled &&
    repairCfg.maxAttempts > 0 &&
    deps.dispatchRepair &&
    anyFailed &&
    inFlight === 0
  ) {
    const failedRepairable = graph.find(
      (n) =>
        n.status === "failed" &&
        n.failure_class !== "dispatch_failed" &&
        repairCfg.repairableStages.includes(stageOf(n)),
    );
    if (failedRepairable) {
      const attemptsSoFar =
        typeof failedRepairable.repair_attempts === "number" &&
        Number.isFinite(failedRepairable.repair_attempts)
          ? failedRepairable.repair_attempts
          : 0;

      let signal = `stage "${stageOf(failedRepairable)}" failed`;
      const storedSignal =
        typeof failedRepairable.error === "string" && failedRepairable.error.trim().length > 0
          ? failedRepairable.error.trim()
          : typeof failedRepairable.last_failure_signal === "string"
            ? failedRepairable.last_failure_signal.trim()
            : "";
      if (storedSignal.length > 0) {
        signal = storedSignal.slice(0, 4000);
      } else if (deps.captureFailureSignal && failedRepairable.child_run_id) {
        try {
          const s = await deps.captureFailureSignal(failedRepairable.child_run_id);
          if (s && s.trim().length > 0) signal = s.trim().slice(0, 4000);
        } catch {
        }
      }
      const policyCopy = builderPolicyRefusalCopy(signal);
      if (policyCopy) {
        failedRepairable.last_failure_signal = signal;
        failedRepairable.error = policyCopy;
        failedRepairable.failure_class = "stage_failed";
        failedRepairable.finished_at = tickIso(deps);
        await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
        const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, {
          failure_class: "stage_failed",
          failure_reason: policyCopy,
        });
        return {
          ...(ended === "paused" ? { paused: true as const } : {}),
          action: "completed_platform_config_error",
          node_id: failedRepairable.id,
          root_cause: signal,
          attempts: attemptsSoFar,
        };
      }

      const providerCapacity = classifyProviderError(signal);
      if (providerCapacity.transient) {
        failedRepairable.last_failure_signal = providerCapacity.reason;
        failedRepairable.error = providerCapacity.reason;
        failedRepairable.failure_class = "provider_capacity";
        failedRepairable.finished_at = tickIso(deps);
        await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
        const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, {
          failure_class: "provider_capacity",
          failure_reason: providerCapacity.reason,
        });
        return {
          ...(ended === "paused" ? { paused: true as const } : {}),
          action: "completed_provider_capacity",
          node_id: failedRepairable.id,
          root_cause: providerCapacity.reason,
          attempts: attemptsSoFar,
        };
      }

      const appDb =
        failedRepairable.failure_class === "app_database_setup"
          ? { app_database: true, reason: appSetupFailureCopy(signal) }
          : classifyAppDatabaseError(signal);
      if (appDb.app_database) {
        failedRepairable.last_failure_signal = appDb.reason;
        failedRepairable.error = appDb.reason;
        failedRepairable.failure_class = "app_database_setup";
        failedRepairable.finished_at = tickIso(deps);
        await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
        const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, {
          failure_class: "app_database_setup",
          failure_reason: appDb.reason,
        });
        return {
          ...(ended === "paused" ? { paused: true as const } : {}),
          action: "completed_app_database_setup",
          node_id: failedRepairable.id,
          root_cause: appDb.reason,
          attempts: attemptsSoFar,
        };
      }

      if (isRepoAccessDenied(signal)) {
        failedRepairable.last_failure_signal = signal;
        failedRepairable.error = REPO_ACCESS_DENIED_COPY;
        failedRepairable.failure_class = "dispatch_failed";
        failedRepairable.finished_at = tickIso(deps);
        await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
        const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, {
          failure_class: "dispatch_failed",
          failure_reason: REPO_ACCESS_DENIED_COPY,
        });
        return {
          ...(ended === "paused" ? { paused: true as const } : {}),
          action: "completed_platform_config_error",
          node_id: failedRepairable.id,
          root_cause: signal,
          attempts: attemptsSoFar,
        };
      }

      if (SITE_PREP_PLATFORM_FAILURE_RE.test(signal)) {
        failedRepairable.last_failure_signal = signal;
        failedRepairable.error = SITE_PREP_PLATFORM_COPY;
        failedRepairable.failure_class = "dispatch_failed";
        failedRepairable.finished_at = tickIso(deps);
        await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
        const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, {
          failure_class: "dispatch_failed",
          failure_reason: SITE_PREP_PLATFORM_COPY,
        });
        return {
          ...(ended === "paused" ? { paused: true as const } : {}),
          action: "completed_platform_config_error",
          node_id: failedRepairable.id,
          root_cause: signal,
          attempts: attemptsSoFar,
        };
      }

      if (isRepairlessConfigError(signal)) {
        failedRepairable.last_failure_signal = signal;
        failedRepairable.error = signal;
        failedRepairable.failure_class = "dispatch_failed";
        failedRepairable.finished_at = tickIso(deps);
        await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
        const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, {
          failure_class: "dispatch_failed",
          failure_reason: signal,
        });
        return {
          ...(ended === "paused" ? { paused: true as const } : {}),
          action: "completed_platform_config_error",
          node_id: failedRepairable.id,
          root_cause: signal,
          attempts: attemptsSoFar,
        };
      }

      if (attemptsSoFar >= repairCfg.maxAttempts) {
        failedRepairable.last_failure_signal = signal;
        failedRepairable.error = signal;
        failedRepairable.failure_class = "repair_exhausted";
        failedRepairable.finished_at = tickIso(deps);
        await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
        const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, {
          failure_class: "repair_exhausted",
          failure_reason: signal,
        });
        return {
          ...(ended === "paused" ? { paused: true as const } : {}),
          action: "completed_after_repair_exhausted",
          node_id: failedRepairable.id,
          root_cause: signal,
          attempts: attemptsSoFar,
        };
      }

      const attempt = attemptsSoFar + 1;
      const classGate = await checkClassCap(row, failedRepairable, deps);
      if (!classGate.ok) {
        if (classGate.reason === "read_error") {
          await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
          return {
            action: "class_read_error",
            node_id: failedRepairable.id,
            decision_class: classGate.decision_class,
          };
        }
        failedRepairable.error = `Build stopped at ${stageOf(failedRepairable)}: class spend cap reached.`;
        failedRepairable.failure_class = "class_cap_halted";
        failedRepairable.finished_at = tickIso(deps);
        await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
        await deps.setStatus(conductor_run_id, "halted", {
          failure_class: "class_cap_halted",
          failure_reason: failedRepairable.error ?? "Class spend cap reached.",
        });
        return {
          action: "class_over_cap",
          node_id: failedRepairable.id,
          decision_class: classGate.decision_class,
        };
      }
      const decision = await chargeRepairOnce(
        failedRepairable,
        conductor_run_id,
        deps,
        failedRepairable.estimate_usd,
        repairChargeKey(failedRepairable, "stage", attempt),
      );
      if (decision === "over_cap") {
        failedRepairable.error = `Build stopped at ${stageOf(failedRepairable)}: build budget reached.`;
        failedRepairable.failure_class = "budget_halted";
        failedRepairable.finished_at = tickIso(deps);
        await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
        return { action: "halted" };
      }

      const sibling = graph.find(
        (n) =>
          n.id !== failedRepairable.id &&
          typeof (n.payload as { idea?: unknown })?.idea === "string",
      );
      const sibPayload = (sibling?.payload ?? {}) as {
        idea?: unknown;
        company_name?: unknown;
        target?: unknown;
      };
      const failedPayload = failedRepairable.payload as {
        idea?: unknown;
        company_name?: unknown;
        target?: unknown;
      };
      const freshCodegenRepair = isFreshBuildCodegenNode(row, graph, failedRepairable);
      const repairPayload: Record<string, unknown> = {
        ...(freshCodegenRepair
          ? await withPriorOutput(graph, failedRepairable, deps)
          : failedRepairable.payload),
        ...(freshCodegenRepair ? {} : { refine_mode: true }),
        repair_mode: true,
        repair_attempt: attempt,
        failure_signal: signal,
      };
      if (typeof failedPayload.idea !== "string" && typeof sibPayload.idea === "string") {
        repairPayload.idea = sibPayload.idea;
      }
      if (
        typeof failedPayload.company_name !== "string" &&
        typeof sibPayload.company_name === "string"
      ) {
        repairPayload.company_name = sibPayload.company_name;
      }
      if (failedPayload.target === undefined && sibPayload.target !== undefined) {
        repairPayload.target = sibPayload.target;
      }
      if (await stoppedMidTick(conductor_run_id, deps)) {
        await refundCharge(failedRepairable, conductor_run_id, deps, tickRefundKey(failedRepairable));
        return { action: "noop", reason: "stopped" };
      }
      const rr = await deps.dispatchRepair({
        tenant_id: row.tenant_id,
        conductor_run_id,
        node_id: failedRepairable.id,
        attempt,
        target_agent_slug: failedRepairable.target_agent_slug,
        payload: repairPayload,
        failure_signal: signal,
      });
      if (!rr.ok) {
        await refundUnlessKeyed(failedRepairable, conductor_run_id, deps);
        if (rr.reason === DISPATCH_IN_FLIGHT) return { action: "waiting", in_flight: 1 };
        failedRepairable.repair_attempts = attempt;
        const dispatchError = `repair dispatch failed (${rr.reason}); last failure: ${signal}`;
        failedRepairable.last_failure_signal = dispatchError;
        failedRepairable.error = dispatchError;
        failedRepairable.failure_class = "dispatch_failed";
        failedRepairable.finished_at = tickIso(deps);
        await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
        const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, {
          failure_class: "dispatch_failed",
          failure_reason: dispatchError,
        });
        return {
          ...(ended === "paused" ? { paused: true as const } : {}),
          action: "completed_after_repair_exhausted",
          node_id: failedRepairable.id,
          root_cause: dispatchError,
          attempts: attempt,
        };
      }

      if (rr.adopted) await refundAdoptedCharge(failedRepairable, conductor_run_id, deps);
      failedRepairable.status = "dispatched";
      failedRepairable.child_run_id = rr.child_run_id;
      failedRepairable.repair_attempts = attempt;
      failedRepairable.last_failure_signal = signal;
      failedRepairable.started_at = tickIso(deps);
      delete failedRepairable.payload.push_check_started_at;
      clearNodeFailure(failedRepairable);
      await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
      return {
        action: "repair_dispatched",
        node_id: failedRepairable.id,
        child_run_id: rr.child_run_id,
        attempt,
      };
    }
  }

  if (!firstPending) {
    if (inFlight > 0) {
      if (dirty) await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
      return { action: "waiting", in_flight: inFlight };
    }
    const final = anyFailed ? "failed" : "done";
    if (dirty) await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    if (anyFailed) {
      const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, reasonFromGraph(graph));
      return { action: "completed", final: ended };
    }
    clearSiteInlineEditsAfterRefine(row, graph, deps);
    await deps.setStatus(conductor_run_id, final);
    return { action: "completed", final };
  }

  if (inFlight > 0) {
    if (dirty) await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    return { action: "waiting", in_flight: inFlight };
  }

  if (anyFailed) {
    if (dirty) await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, reasonFromGraph(graph));
    return { action: "completed", final: ended };
  }

  const siteId = siteIdOf(firstPending);
  if (row.kind === "build_app" && stageOf(firstPending) === "deploy" && siteId) {
    return siteDeployGate(conductor_run_id, row, graph, firstPending, siteId, reconcileDelta, dirty, deps);
  }

  if (row.kind === "build_app" && stageOf(firstPending) === "deploy") {
    if (
      typeof firstPending.acceptance_reprobe_after === "number" &&
      (deps.now ? deps.now() : Date.now()) < firstPending.acceptance_reprobe_after
    ) {
      if (dirty) await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
      return { action: "waiting", in_flight: 0 };
    }
    if (typeof firstPending.payload.deploy_enqueued_at !== "number") {
      firstPending.payload.deploy_enqueued_at = deps.now ? deps.now() : Date.now();
      dirty = true;
    }
    if (!deps.hostingStatus) {
      firstPending.status = "done";
      firstPending.started_at ??= tickIso(deps);
      firstPending.finished_at = tickIso(deps);
      await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
      await deps.setStatus(conductor_run_id, "done");
      return { action: "completed", final: "done" };
    }
    if (await requestStaticPublishOnce(row, graph, firstPending, conductor_run_id, deps)) dirty = true;
    let hs: "ready" | "failed" | "provisioning" | "none";
    try {
      if (stampRefineEngineerRun(graph, firstPending)) dirty = true;
      hs = await deps.hostingStatus(row.tenant_id, firstPending);
    } catch {
      hs = "provisioning";
    }
    if (hs === "ready") {
      const gate = await handleAcceptanceGate(
        conductor_run_id,
        row,
        graph,
        firstPending,
        reconcileDelta,
        deps,
      );
      if (gate) return gate;
      if (deps.screenCheck && !deps.requestScreenCheck) {
        firstPending.screen_check = await recordScreenCheck(deps.screenCheck, row.tenant_id, () =>
          tickIso(deps),
        );
      }
      firstPending.status = "done";
      firstPending.started_at ??= tickIso(deps);
      firstPending.finished_at = tickIso(deps);
      firstPending.hosting_verified_at = tickIso(deps);
      firstPending.error = null;
      firstPending.failure_class = null;
      if (deps.ingestAppArtifact) {
        try {
          deps.ingestAppArtifact({
            tenant_id: row.tenant_id,
            graph,
            deploy_node: firstPending,
          });
        } catch {
        }
      }
      if (
        deps.clearInlineEditsOnRefine &&
        typeof (firstPending.payload as { pre_refine_sha?: unknown } | null)?.pre_refine_sha ===
          "string" &&
        !siteIdFromGraph(graph)
      ) {
        try {
          deps.clearInlineEditsOnRefine(row.tenant_id);
        } catch {
        }
      }
      await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
      await deps.setStatus(conductor_run_id, "done");
      const requestScreenCheck = deps.requestScreenCheck;
      if (requestScreenCheck) {
        await Promise.resolve()
          .then(() =>
            requestScreenCheck({
              tenant_id: row.tenant_id,
              conductor_run_id,
              node_id: firstPending.id,
            }),
          )
          .catch(() => undefined);
      }
      return { action: "completed", final: "done" };
    }
    if (hs === "failed") {
      firstPending.started_at ??= tickIso(deps);
      failNode(
        firstPending,
        deps,
        "Deploy did not reach a live serving state.",
        "deploy_failed",
      );
      await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
      const ended = await setFailedOrPaused(row, graph, conductor_run_id, deps, reasonFromGraph(graph));
      return { action: "completed", final: ended };
    }
    if (dirty) await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    return { action: "waiting", in_flight: 0 };
  }

  if (row.kind === "build_app" && siteId && firstPending.payload.await_look === true) {
    let awaiting = !!deps.siteAwaitsLook;
    let park: LookParkCheck | null = null;
    if (deps.siteAwaitsLook) {
      try {
        awaiting = await deps.siteAwaitsLook({ tenant_id: row.tenant_id, site_id: siteId });
      } catch (e) {
        console.warn(`[conductor] run=${conductor_run_id} site=${siteId} look read failed, build held until the founder picks: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
    }
    if (awaiting && deps.checkLookPark) {
      try {
        park = await deps.checkLookPark({ tenant_id: row.tenant_id, conductor_run_id });
      } catch (e) {
        console.warn(`[conductor] run=${conductor_run_id} look wait check failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        return { action: "waiting", in_flight: 0 };
      }
      if (!park) return { action: "waiting", in_flight: 0 };
      if (park.state === "expired") {
        console.info(`[conductor] event=look_wait_expired run=${conductor_run_id} tenant=${row.tenant_id} site=${siteId}`);
        return { action: "completed", final: "failed" };
      }
      if (park.state === "ended" || park.state === "not_found") return { action: "noop", reason: "look_wait_ended" };
      if (park.parked_at) firstPending.payload = { ...firstPending.payload, [LOOK_PARKED_AT_KEY]: park.parked_at };
      if (park.state === "waiting" && deps.autoPickLook && lookAutoStartDue(park.parked_at, deps.now ? deps.now() : Date.now())) {
        try {
          const picked = await deps.autoPickLook({ tenant_id: row.tenant_id, site_id: siteId });
          console.info(`[conductor] event=look_auto_start run=${conductor_run_id} tenant=${row.tenant_id} site=${siteId} picked=${picked}`);
          awaiting = picked ? false : deps.siteAwaitsLook ? await deps.siteAwaitsLook({ tenant_id: row.tenant_id, site_id: siteId }) : false;
        } catch (e) {
          console.warn(`[conductor] run=${conductor_run_id} look auto start failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        }
      }
    }
    if (awaiting) {
      if (dirty) await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
      const auto_start_at = deps.autoPickLook ? lookAutoStartAt(park?.parked_at) : null;
      return { action: "waiting", in_flight: 0, awaiting: "look", ...(auto_start_at ? { auto_start_at } : {}) };
    }
    firstPending.payload = { ...firstPending.payload };
    delete firstPending.payload.await_look;
    delete firstPending.payload.await_look_since;
    delete firstPending.payload[LOOK_PARKED_AT_KEY];
    dirty = true;
  }

  const classGate = await checkClassCap(row, firstPending, deps);
  if (!classGate.ok) {
    if (classGate.reason === "read_error") {
      await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
      return {
        action: "class_read_error",
        node_id: firstPending.id,
        decision_class: classGate.decision_class,
      };
    }
    firstPending.error = `Build stopped at ${stageOf(firstPending)}: class spend cap reached.`;
    firstPending.failure_class = "class_cap_halted";
    firstPending.finished_at = tickIso(deps);
    await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    await deps.setStatus(conductor_run_id, "halted", {
      failure_class: "class_cap_halted",
      failure_reason: firstPending.error ?? "Class spend cap reached.",
    });
    return {
      action: "class_over_cap",
      node_id: firstPending.id,
      decision_class: classGate.decision_class,
    };
  }
  const decision = await deps.consumeBudget(conductor_run_id, firstPending.estimate_usd);
  if (decision === "charged") {
    firstPending.last_charge_usd = firstPending.estimate_usd;
    delete firstPending.last_charge_key;
  }
  if (decision === "over_cap") {
    firstPending.error = `Build stopped at ${stageOf(firstPending)}: build budget reached.`;
    firstPending.failure_class = "budget_halted";
    firstPending.finished_at = tickIso(deps);
    await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    return { action: "halted" };
  }

  const dispatchPayload = await withPriorOutput(graph, firstPending, deps);

  if (await stoppedMidTick(conductor_run_id, deps)) {
    await refundCharge(firstPending, conductor_run_id, deps, tickRefundKey(firstPending));
    return { action: "noop", reason: "stopped" };
  }
  const dr = await deps.dispatch({
    tenant_id: row.tenant_id,
    conductor_run_id,
    node_id: firstPending.id,
    target_agent_slug: firstPending.target_agent_slug,
    payload: dispatchPayload,
  });
  if (!dr.ok) {
    await refundCharge(firstPending, conductor_run_id, deps, tickRefundKey(firstPending));
    if (dr.reason === DISPATCH_IN_FLIGHT) return { action: "waiting", in_flight: 1 };
    firstPending.started_at ??= tickIso(deps);
    failNode(firstPending, deps, dr.reason, "dispatch_failed");
    await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
    return { action: "dispatch_failed", node_id: firstPending.id, reason: dr.reason };
  }
  if (await cancelledDuringDispatch(conductor_run_id, deps)) {
    await deps.stopChild?.(row.tenant_id, dr.child_run_id).catch((e: unknown) => {
      console.warn(
        `[conductor] could not stop child ${dr.child_run_id} of cancelled run ${conductor_run_id}: ${(e as Error)?.message}`,
      );
    });
    await refundCharge(firstPending, conductor_run_id, deps, tickRefundKey(firstPending));
    return { action: "noop", reason: "stopped" };
  }
  if (dr.adopted) await refundAdoptedCharge(firstPending, conductor_run_id, deps);
  firstPending.status = "dispatched";
  firstPending.child_run_id = dr.child_run_id;
  firstPending.started_at = tickIso(deps);
  clearNodeFailure(firstPending);
  await deps.saveGraph(conductor_run_id, graph, reconcileDelta);
  return { action: "dispatched", node_id: firstPending.id, child_run_id: dr.child_run_id };
}
