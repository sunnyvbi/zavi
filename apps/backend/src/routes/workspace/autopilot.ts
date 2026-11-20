
import { logEvent } from "@/services/logging/logEvent";
import { METRIC_REGISTRY, classifyGoalMetricKey } from "@/services/analytics/metric-registry";
import { rolledPeriodStart, valueKindRefusal } from "@/services/growth/goal-trajectory";
import { templateChoiceFrom } from "@/services/sites/site-templates";
import { refineAwaitsReview, refineDisplayText } from "@/services/agents/refine-display";
import { BUILD_CONDUCTOR_RUN_ID_KEY } from "@/services/billing/tiers";
import { continueBuild } from "@/services/agents/continue-build";
import type { Request, Response } from "express";
import { recordMetricSnapshot } from "@/services/analytics/record-metric-snapshot";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { BUILD_INTERNAL_FAILURE, buildRunPanel, founderBuildFailure, type RunActivityRow, type RunPanel } from "@zavi/shared";
import { createPaymentTool } from "@/services/tools/stripe/create_payment";
import { ExpectedToolError, type ToolContext } from "@/services/tools/types";
import { loadTenantRole, requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import { presentationStatus } from "@/services/agents/run-display-state";
import {
  tenantAppIsLive,
  isRefineRun,
  NON_REFINE_BUILD_FILTER,
  buildDatabaseReclaimed,
} from "@/services/autopilot/build-liveness";
import { getBoolSetting, getStringSetting, setTenantSetting } from "@/services/settings";
import { MAX_IDEA_IMAGES, storeIdeaImages, validateIdeaImages } from "@/services/onboarding/idea-reference-images";
import { exportFigmaFrame } from "@/services/build/figma-frame";
import { hasInternalJargon } from "@/services/agents/internal-jargon";
import { plainEditLine } from "@/services/build/edit-plain-change";
import { isProductBuilderEnabled } from "@/agents/engineer/product-builder-flag";
import {
  isProductBuilderUnavailable,
  respondProductBuilderUnavailable,
} from "@/agents/engineer/product-builder-unavailable";
import {
  buildRequestKeyFrom,
  DuplicateBuildRequest,
  stampBuildRequestKey,
} from "@/services/agents/build-request-key";
import { isLiveEditPayload, readLiveEditState } from "@/services/build/live-edit";
import { classifyAppEdit } from "@/services/agents/app-edit-intent";
import { sanitizePreviewPath } from "@/services/sandbox/engineer-preview";
import { provisionCompany } from "@/services/provisioning";
import { InsufficientCreditsForBuild } from "@/services/agents/build-credit-preflight";
import { refusalFor } from "@/services/agents/refusal";
import { requestConductorTick } from "@/services/agents/conductor-kick";
import { inngest } from "../../../workers/client";
import {
  startProductBuild,
  MAX_PRODUCT_BUILD_MAX_USD,
  ProvisionBudgetExceeded,
  DoubleBuildInFlight,
  TooManyBuildsToday,
  InvalidCompanyName,
  BuildRepoNotProvisioned,
  buildSetupFailedBody,
} from "@/services/agents/start-product-build";
import {
  refineProduct,
  realRefineProductDeps,
  findExistingRefineForSuggestion,
  assertRefineAllowed,
  NoProvisionedRepo,
  ConductorRunNotFound,
  OldSiteFrozen,
  SiteRequired,
  SiteUnavailable,
  BuildRetired,
  InvalidRefineMessage,
  PhotoRetryTaken,
  FleetHalted,
  AppFrozen,
  FreeEditsUsed,
  SitePreviewRestarting,
  UndoInProgress,
  DEFAULT_REFINE_MAX_USD,
} from "@/services/agents/refine-product";
import { parseRefineImagePaths, refineRequestImagePaths } from "@/services/agents/refine-request-images";
import { MAX_EXCLUDE, generateBuildChips, takeMoreSlot } from "@/services/agents/build-chips-generate";
import { readBuiltAppSuggestionContext } from "@/services/agents/build-suggestion-context";
import { generateBuildPlan } from "@/services/agents/plan-generate";
import { saveOwnerChatFacts } from "@/services/company/owner-chat-facts";
import { isGoneSite, resolveAppForRequest, sendAppSelectionError, type RequestedApp } from "@/services/sites/app-identity";
import { isSafeRepoName } from "@/services/sites/legacy-app";
import { MAX_SCOPED_MESSAGE, parseSelectedElement, type SelectedElementScope } from "@/services/sites/selected-element";
import { generateClarifyQuestions } from "@/services/agents/clarify-questions-generate";
import { PHOTO_RETRY_MESSAGE, readSitePhotos } from "@/services/sites/site-photos";
import {
  refineUndo,
  refineRestore,
  DraftNotPublished,
  NoUndoableRefine,
  NotProvisioned,
  NothingToRestore,
  ChangeAwaitingApproval,
  UndoBlocked,
  UndoCommitNotFound,
  isChangeRunPayload,
  isNoChangeRunPayload,
  isPublishRunPayload,
  isStaleUndoClaim,
} from "@/services/agents/refine-undo";
import { getVersionPreview, startVersionPreview } from "@/services/build/version-preview";
import { PREWARM_SKIPPED, siteVersionErrorRetryable, siteVersionJob, siteVersionPreview } from "@/services/sites/site-versions";
import {
  awaitsPublishOnRequest,
  claimPublishPreviewKick,
  deriveAppReady,
  holdReadyForSmokeGate,
  publishUrlFromResources,
  sitePublishState,
  waitingForDatabase,
  type SitePublishRun,
} from "@/services/build/app-ready";
import {
  loadUnpublishedSiteChanges,
  unpublishedSiteChanges,
  type UnpublishedChangeView,
} from "@/services/sites/site-pending";
import type { ConductorNode } from "@/services/agents/conductor";
import { getLatestDeployStatus } from "@/services/pipeline/deploy-truth";
import { ownerAdminAccess, resendOwnerLoginLink, type OwnerAdminAccess } from "@/services/build/build-live-email";
import { stageExpectedMs } from "@/services/build/stage-expected";
import { buildChatThreadIds, buildChatThreadsOn } from "@/services/build/build-chat-thread";
import { siteIsSuspended } from "@/services/website/site-offline";
import { getRestoreStatus, RESTORE_COMMIT_SHA_RE } from "@/services/pipeline/restore-status";
import type { GateEvidence } from "@/services/agents/refine-gate";
import { validateCompanyName } from "@/services/provisioning/tenant-slug";
import {
  groupBuildSessions,
  isRefineRow,
  PROVISION_MARKER_SELECT,
  replacesOldApp,
  SESSION_RUN_SELECT,
  refineIdsForSession,
  type ReplaceEvidenceRow,
  type SessionRunRow,
} from "@/services/agents/build-sessions";

const BUILD_SESSIONS_WINDOW = 400;
const BUILD_SESSIONS_ROOTS_MAX = 1000;
import { buildSessionOfThread, type BindingDb } from "@/services/agents/build-session-binding";
import { isSiteGraph, rowHasSiteMarker, siteIdFromGraph, siteIdFromMarkerRow, siteMarkersOf, SITE_MARKER_SELECT } from "@/services/sites/site-run";
import { siteStore } from "@/services/sites/store";
import { readFirstView } from "@/services/sites/first-view";
import {
  activeSiteRunExists,
  sitePreviewRestartable,
  sitePreviewState,
} from "@/services/sites/site-preview-restart";
import { wakeSitePreview } from "@/services/sites/site-preview-wake";
import { claimSiteLease, releaseSiteLease, siteLeaseHeld } from "@/services/sites/site-preview-lease";
import {
  OLD_SITE_FROZEN_CODE,
  OLD_SITE_FROZEN_MESSAGE,
  OLD_SITE_FROZEN_STATUS,
  oldSiteFrozenBody,
} from "@/services/sites/old-site-freeze";
import type { SiteRow } from "@/services/sites/contract";
import {
  isVisibleSite,
  loadSiteSandboxPreview,
  siteGraphStages,
  siteDeployedUrl,
  siteLiveState,
  siteLiveUrl,
  siteOwnerAdmin,
  sitePublishedUrl,
  sitePreview,
  sitePreviewDeadPending,
  siteRepoUrl,
  siteSessionSummary,
  siteStatusBlock,
  type SiteLiveState,
} from "@/services/sites/site-build-status";

const BUILD_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import {
  sanitizeFetchedContent,
  xmlEscapeContent,
  decodeXmlEntities,
} from "@/services/onboarding/enrichment/sanitize";
import { detectGoalJunk } from "@/services/autopilot/goal-metric-vocab";
import { FOUNDER_ENTERED_SOURCE, setGoalMeasurementMode, writeCreatedGoalMeasurement } from "@/services/autopilot/goal-measurement";
import { MAX_ACTIVE_GOALS } from "@/services/autopilot/goal-limits";
import { validateMeasurementMode } from "@/services/autopilot/goal-measurement-mode";
import { classifyTargetMetric, measureGoalMetric } from "@/services/autopilot/goal-metric-resolver";
import { sendGoalAttention } from "@/services/growth/goal-attention";
import { clearCgoPauseReasons, enteredDay, goalRev, goalTimeZone, goalTrajectoryView, syncGoalWork } from "@/services/growth/goal-owner";
import { writeAutopilotGoal, type GoalActor } from "@/services/growth/goal-write";
import { lookAwaitingSiteId } from "@/services/sites/look-wait";
import {
  coerceTrustLevel,
  TRUST_LEVELS,
  TRUST_LADDER_CLASS,
  type TrustLevel,
} from "@/services/decisions/trust-ladder";
import {
  nodeFailureText,
  childFailureMessage,
  durationMs,
  founderFailureView,
  founderStageError,
  isFailedChildStatus,
  stageRetryCount,
  summarizeBuildFailure,
  type BuildChildRun,
  type BuildStageNode,
} from "@/services/agents/build-failure";

type DecisionClassRow = {
  slug: string;
  description: string | null;
  default_autonomy: string;
  never_auto: boolean | null;
  click_allowlistable: boolean | null;
};

type OverrideRow = {
  decision_class: string;
  autonomy: string | null;
  max_daily_usd: number | null;
  max_per_action_usd: number | null;
};

type LedgerRow = {
  id: string;
  conductor_run_id: string | null;
  node_id: string | null;
  action: string | null;
  target_agent_slug: string | null;
  child_run_id: string | null;
  outcome: string | null;
  error: string | null;
  evidence: unknown | null;
  created_at: string;
};

export type TrustLadderBlock = {
  level: TrustLevel;
  daily_plans_30d: {
    approved: number;
    rejected: number;
    expired: number;
    pending: number;
  };
  measured_outcomes_30d: {
    total: number;
    by_tier: Record<string, number> | null;
  };
};

async function loadTrustLadderBlock(tenant_id: string): Promise<TrustLadderBlock> {
  const block: TrustLadderBlock = {
    level: "L0",
    daily_plans_30d: { approved: 0, rejected: 0, expired: 0, pending: 0 },
    measured_outcomes_30d: { total: 0, by_tier: null },
  };
  const svc = serviceClient();
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();

  try {
    block.level = coerceTrustLevel(
      await getStringSetting("autopilot_trust_level", tenant_id),
    );
  } catch {
  }

  try {
    const { data } = await svc
      .from("decisions")
      .select("status")
      .eq("tenant_id", tenant_id)
      .eq("decision_class", TRUST_LADDER_CLASS)
      .gte("emitted_at", sinceIso)
      .limit(1000);
    for (const r of (data ?? []) as Array<{ status: string | null }>) {
      if (r.status === "acted" || r.status === "approved") block.daily_plans_30d.approved += 1;
      else if (r.status === "rejected") block.daily_plans_30d.rejected += 1;
      else if (r.status === "expired") block.daily_plans_30d.expired += 1;
      else block.daily_plans_30d.pending += 1;
    }
  } catch {
  }

  try {
    const withTier = await svc
      .from("action_outcomes")
      .select("outcome_tier")
      .eq("tenant_id", tenant_id)
      .eq("reconcile_status", "measured")
      .gte("created_at", sinceIso)
      .limit(1000);
    if (!withTier.error) {
      const rows = (withTier.data ?? []) as Array<{ outcome_tier: string | null }>;
      block.measured_outcomes_30d.total = rows.length;
      const by_tier: Record<string, number> = {};
      for (const r of rows) {
        const t = typeof r.outcome_tier === "string" && r.outcome_tier ? r.outcome_tier : "untiered";
        by_tier[t] = (by_tier[t] ?? 0) + 1;
      }
      block.measured_outcomes_30d.by_tier = by_tier;
    } else {
      const { count } = await svc
        .from("action_outcomes")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenant_id)
        .eq("reconcile_status", "measured")
        .gte("created_at", sinceIso);
      block.measured_outcomes_30d.total = count ?? 0;
    }
  } catch {
  }

  return block;
}

export async function getAutopilot(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);

  const [
    classesRes,
    overridesRes,
    fleetRes,
    ledgerRes,
    autopilotEnabled,
    resourcesRes,
    buildAppIntent,
    companyScaleSegment,
    buildRunsRes,
    trustLadder,
  ] = await Promise.all([
      supabase
        .from("decision_classes")
        .select("slug, description, default_autonomy, never_auto, click_allowlistable")
        .order("slug"),

      supabase
        .from("tenant_decision_class_overrides")
        .select("decision_class, autonomy, max_daily_usd, max_per_action_usd")
        .eq("tenant_id", auth.tenant_id),

      supabase.rpc("is_fleet_halted"),

      supabase
        .from("autopilot_action_ledger")
        .select(
          "id, conductor_run_id, node_id, action, target_agent_slug, child_run_id, outcome, error, evidence, created_at",
        )
        .eq("tenant_id", auth.tenant_id)
        .order("created_at", { ascending: false })
        .limit(50),

      Promise.resolve(true),

      supabase
        .from("tenant_resources")
        .select("resource_kind, mode, status, provider, external_ref, updated_at")
        .eq("tenant_id", auth.tenant_id),

      getStringSetting("build_app_intent", auth.tenant_id),

      getStringSetting("company_scale_segment", auth.tenant_id),

      supabase
        .from("conductor_runs")
        .select("status, goal_graph, created_at")
        .eq("tenant_id", auth.tenant_id)
        .eq("kind", "build_app")
        .or(NON_REFINE_BUILD_FILTER)
        .is("goal_graph->0->payload->>site_id", null)
        .is("goal_graph->1->payload->>site_id", null)
        .is("goal_graph->2->payload->>site_id", null)
        .order("created_at", { ascending: false })
        .limit(1),

      loadTrustLadderBlock(auth.tenant_id),
    ]);

  if (classesRes.error) {
    res.status(500).json({
      error: { code: "classes_query_failed", message: classesRes.error.message },
    });
    return;
  }

  const overrideMap = new Map<string, OverrideRow>();
  for (const o of ((overridesRes.data ?? []) as OverrideRow[])) {
    overrideMap.set(o.decision_class, o);
  }

  const classes = ((classesRes.data ?? []) as DecisionClassRow[]).map((dc) => {
    const ov = overrideMap.get(dc.slug);
    const never_auto = dc.never_auto === true;
    const effective = never_auto
      ? "approval"
      : ov?.autonomy ?? dc.default_autonomy;
    return {
      slug: dc.slug,
      description: dc.description,
      default_autonomy: dc.default_autonomy,
      tenant_override: ov?.autonomy ?? null,
      effective,
      never_auto,
      click_allowlistable: dc.click_allowlistable === true,
      max_daily_usd: ov?.max_daily_usd ?? null,
      max_per_action_usd: ov?.max_per_action_usd ?? null,
    };
  });

  const fleet_halted: boolean =
    fleetRes.error || fleetRes.data === null ? false : Boolean(fleetRes.data);

  const ledger = ((ledgerRes.data ?? []) as LedgerRow[]).map((r) => ({
    id: r.id,
    conductor_run_id: r.conductor_run_id,
    node_id: r.node_id,
    action: r.action,
    target_agent_slug: r.target_agent_slug,
    child_run_id: r.child_run_id,
    outcome: r.outcome,
    error:
      r.conductor_run_id && typeof r.error === "string" && r.error.trim()
        ? founderBuildFailure({ message: r.error })?.message ?? BUILD_INTERNAL_FAILURE
        : r.error,
    evidence: r.evidence,
    created_at: r.created_at,
  }));

  const anyBuildShipped = tenantAppIsLive(buildRunsRes.data);

  type ResourceRow = {
    resource_kind: string;
    mode: string;
    status: string;
    provider: string | null;
    external_ref: Record<string, unknown> | null;
    updated_at?: string | null;
  };
  const resourceRows = (resourcesRes.data ?? []) as ResourceRow[];
  const buildRetired = buildDatabaseReclaimed(
    resourceRows,
    (buildRunsRes.data?.[0] as { created_at?: string | null } | undefined) ?? null,
  );
  const resources = resourceRows.map((r) => {
    if (buildRetired && r.resource_kind === "domain" && r.external_ref) {
      return {
        resource_kind: r.resource_kind,
        mode: r.mode,
        status: r.status,
        provider: r.provider,
        external_ref: { ...r.external_ref, status: "retired" },
      };
    }
    if (buildRetired && r.resource_kind === "hosting") {
      return {
        resource_kind: r.resource_kind,
        mode: r.mode,
        status: "torn_down",
        provider: r.provider,
        external_ref: r.external_ref ? { ...r.external_ref, url: undefined } : r.external_ref,
      };
    }
    const external_ref =
      r.resource_kind === "hosting" &&
      r.status === "ready" &&
      !anyBuildShipped &&
      r.external_ref
        ? { ...r.external_ref, url: undefined }
        : r.external_ref;
    return {
      resource_kind: r.resource_kind,
      mode: r.mode,
      status: r.status,
      provider: r.provider,
      external_ref,
    };
  });

  const buildAppIntentSafe: "fresh" | "existing" =
    buildAppIntent === "fresh" ? "fresh" : "existing";

  const SCALE_SEGMENTS = ["pre_revenue", "early", "scaling", "mature"] as const;
  const companyScaleSegmentSafe: "" | (typeof SCALE_SEGMENTS)[number] =
    (SCALE_SEGMENTS as readonly string[]).includes(companyScaleSegment)
      ? (companyScaleSegment as (typeof SCALE_SEGMENTS)[number])
      : "";

  const productBuilderEnabled = await isProductBuilderEnabled().catch(() => false);
  res.json({
    classes,
    fleet_halted,
    autopilot_enabled: autopilotEnabled,
    ledger,
    resources,
    product_builder_enabled: productBuilderEnabled,
    build_app_intent: buildAppIntentSafe,
    company_scale_segment: companyScaleSegmentSafe,
    trust_ladder: trustLadder,
    build_retired: buildRetired,
  });
}

type AutonomyValue = "auto" | "approval" | "forbidden";

export async function postAutopilotSettings(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as {
    decision_class?: string;
    autonomy?: string;
    max_daily_usd?: number | null;
    max_per_action_usd?: number | null;
    money_model?: string;
  };

  if (!body.decision_class || typeof body.decision_class !== "string") {
    res.status(400).json({
      error: { code: "bad_request", message: "decision_class is required" },
    });
    return;
  }

  if (body.money_model !== undefined) {
    if (body.money_model !== "path_a" && body.money_model !== "path_b") {
      res.status(400).json({
        error: { code: "bad_request", message: "money_model must be 'path_a' or 'path_b'" },
      });
      return;
    }
    if (body.decision_class !== "stripe.create_connected_account") {
      res.status(400).json({
        error: {
          code: "bad_request",
          message: "money_model can only be set on the stripe.create_connected_account class",
        },
      });
      return;
    }
  }

  const validAutonomy: AutonomyValue[] = ["auto", "approval", "forbidden"];
  if (!body.autonomy || !validAutonomy.includes(body.autonomy as AutonomyValue)) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: "autonomy must be one of: auto, approval, forbidden",
      },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);

  const { error: autonomyErr } = await supabase.rpc("set_tenant_autonomy", {
    p_tenant_id: auth.tenant_id,
    p_decision_class: body.decision_class,
    p_autonomy: body.autonomy as AutonomyValue,
  });
  if (autonomyErr) {
    res.status(500).json({
      error: { code: "set_autonomy_failed", message: autonomyErr.message },
    });
    return;
  }

  const hasCaps =
    body.max_daily_usd !== undefined || body.max_per_action_usd !== undefined;
  if (hasCaps) {
    const { error: capsErr } = await supabase.rpc("set_tenant_class_caps", {
      p_tenant_id: auth.tenant_id,
      p_decision_class: body.decision_class,
      p_max_daily_usd: body.max_daily_usd ?? null,
      p_max_per_action_usd: body.max_per_action_usd ?? null,
    });
    if (capsErr) {
      res.status(500).json({
        error: { code: "set_caps_failed", message: capsErr.message },
      });
      return;
    }
  }

  if (body.money_model !== undefined) {
    const { error: mmErr } = await supabase.rpc("set_tenant_money_model", {
      p_tenant_id: auth.tenant_id,
      p_money_model: body.money_model,
    });
    if (mmErr) {
      res.status(500).json({
        error: { code: "set_money_model_failed", message: mmErr.message },
      });
      return;
    }
  }

  res.json({ ok: true });
}

export async function postAutopilotBuildProduct(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireOwnerOrAdmin(auth, res))) return;

  let builderOn: boolean;
  try {
    builderOn = await isProductBuilderEnabled();
  } catch (e) {
    if (!isProductBuilderUnavailable(e)) throw e;
    respondProductBuilderUnavailable(res);
    return;
  }
  if (!builderOn) {
    res.status(403).json({
      error: { code: "product_builder_disabled", message: "Product builder is not enabled." },
    });
    return;
  }

  const body = (req.body ?? {}) as {
    company_name?: unknown;
    idea?: unknown;
    max_usd?: unknown;
    reference_images?: unknown;
    await_look_pick?: unknown;
    template?: unknown;
    figma?: unknown;
  };

  const rawCompanyName = typeof body.company_name === "string" ? body.company_name : "";
  const company_name = rawCompanyName.trim();
  if (!company_name || company_name.length > 100) {
    res.status(400).json({
      error: { code: "bad_request", message: "company_name (1–100 chars) is required" },
    });
    return;
  }

  const nameRejection = validateCompanyName(rawCompanyName);
  if (nameRejection) {
    res.status(400).json({
      error: { code: "invalid_company_name", message: InvalidCompanyName.messageFor(nameRejection) },
    });
    return;
  }

  const MIN_IDEA_LEN = 8;
  const idea = typeof body.idea === "string" ? body.idea.trim() : "";
  if (idea.length < MIN_IDEA_LEN || idea.length > 4000) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: `idea (${MIN_IDEA_LEN}–4000 chars) is required. Describe what you want to build`,
      },
    });
    return;
  }

  const templateChoice = templateChoiceFrom(body.template, idea);
  if (!templateChoice.ok) {
    res.status(400).json({ error: { code: templateChoice.code, message: templateChoice.message } });
    return;
  }

  const cleanIdea = xmlEscapeContent(sanitizeFetchedContent(idea));

  let max_usd: number | undefined;
  if (body.max_usd !== undefined) {
    if (typeof body.max_usd !== "number" || !Number.isFinite(body.max_usd) || body.max_usd < 0) {
      res.status(400).json({
        error: { code: "bad_request", message: "max_usd must be a number >= 0" },
      });
      return;
    }
    if (body.max_usd > MAX_PRODUCT_BUILD_MAX_USD) {
      res.status(400).json({
        error: { code: "bad_request", message: `max_usd exceeds the ceiling of ${MAX_PRODUCT_BUILD_MAX_USD}` },
      });
      return;
    }
    max_usd = body.max_usd;
  }

  const ideaAttach =
    body.reference_images !== undefined &&
    (await getBoolSetting("build_idea_attach").catch(() => false));
  const ideaImages = ideaAttach ? await validateIdeaImages(body.reference_images) : { ok: true as const, jpegs: [] };
  if (!ideaImages.ok) {
    res.status(400).json({ error: { code: "invalid_reference_images", message: ideaImages.message } });
    return;
  }

  const figmaRequested = body.figma !== undefined && body.figma !== null;
  let figmaOn = false;
  if (figmaRequested) {
    try {
      figmaOn = await getBoolSetting("build_figma_handoff", auth.tenant_id);
    } catch {
      res.status(503).json({ error: { code: "figma_unavailable", message: "We couldn't check Figma imports. Try again before starting the build." } });
      return;
    }
    if (!figmaOn) {
      res.status(409).json({ error: { code: "figma_disabled", message: "Figma imports are not available for this workspace." } });
      return;
    }
  }
  let figmaJpeg: Buffer | null = null;
  if (figmaOn) {
    if (ideaImages.jpegs.length >= MAX_IDEA_IMAGES) {
      res.status(400).json({ error: { code: "too_many_reference_images", message: `A build takes at most ${MAX_IDEA_IMAGES} reference images including the Figma frame.` } });
      return;
    } else {
      const frame = await exportFigmaFrame(auth.tenant_id, body.figma);
      if (frame.ok) figmaJpeg = frame.jpeg;
      else {
        res.status(503).json({ error: { code: "figma_unavailable", message: frame.note } });
        return;
      }
    }
  }

  let ideaUrls: string[] = [];
  if (ideaImages.jpegs.length > 0) {
    try {
      ideaUrls = await storeIdeaImages(auth.tenant_id, ideaImages.jpegs);
    } catch {
      res.status(503).json({
        error: { code: "reference_images_unavailable", message: "Your reference images could not be stored. Try again before starting the build." },
      });
      return;
    }
    if (ideaUrls.length !== ideaImages.jpegs.length) {
      res.status(503).json({
        error: { code: "reference_images_unavailable", message: "Your reference images could not be stored. Try again before starting the build." },
      });
      return;
    }
  }

  try {
    const figmaUrls = figmaJpeg ? await storeIdeaImages(auth.tenant_id, [figmaJpeg]).catch(() => []) : [];
    if (figmaJpeg && figmaUrls.length === 0) {
      res.status(503).json({ error: { code: "figma_unavailable", message: "The Figma frame could not be stored. Try again before starting the build." } });
      return;
    }
    const reference_images = [...figmaUrls, ...ideaUrls];
    const requestKey = buildRequestKeyFrom(req.headers?.["idempotency-key"]);
    const result = await startProductBuild({
      tenant_id: auth.tenant_id,
      company_name,
      idea: cleanIdea,
      max_usd,
      started_by_user_id: auth.user_id,
      ...(reference_images.length ? { reference_images } : {}),
      ...(body.await_look_pick === true ? { await_look_pick: true } : {}),
      ...(templateChoice.template ? { site_template: templateChoice.template } : {}),
      ...(requestKey
        ? { onRunCreated: (run_id: string) => stampBuildRequestKey(auth.tenant_id, run_id, requestKey) }
        : {}),
    });
    await requestConductorTick(inngest, result.conductor_run_id);
    res.json({
      ok: true,
      conductor_run_id: result.conductor_run_id,
      target: result.target,
      first_build_free: result.first_build_free === true,
      provisioned: result.provision.provisioned,
      connected: result.provision.connected,
      pending_creds: result.provision.pending_creds,
      failed: result.provision.failed,
    });
  } catch (e) {
    if (e instanceof DuplicateBuildRequest) {
      res.json({ ok: true, conductor_run_id: e.conductor_run_id, replayed_after_stale: true });
      return;
    }
    if (e instanceof InvalidCompanyName) {
      res.status(400).json({
        error: { code: "invalid_company_name", message: (e as Error).message },
      });
      return;
    }
    if (e instanceof DoubleBuildInFlight) {
      let inflight:
        | { run_id: string; status: string; created_at: string; can_cancel: boolean }
        | null = null;
      try {
        const rls = serverClientFromBearer(auth.access_token);
        const { data: row } = await rls
          .from("conductor_runs")
          .select("id, status, created_at")
          .eq("tenant_id", auth.tenant_id)
          .in("status", ["provisioning", "active"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (row) {
          inflight = {
            run_id: row.id as string,
            status: row.status as string,
            created_at: row.created_at as string,
            can_cancel: true,
          };
        }
      } catch {
      }
      res.status(409).json({
        error: {
          code: "build_already_in_progress",
          message: "A build is already running.",
        },
        ...(inflight ?? {}),
      });
      return;
    }
    if (e instanceof TooManyBuildsToday) {
      res.status(429).json({
        error: { code: "daily_build_limit_reached", message: (e as Error).message },
      });
      return;
    }
    if (e instanceof InsufficientCreditsForBuild) {
      res.status(402).json({
        error: {
          code: "insufficient_credits_for_build",
          message: refusalFor({
            kind: "credits_for_build",
            required_credits: e.required_credits,
            remaining_credits: e.remaining_credits,
            free_plan: e.free_plan,
          }).message,
          required_credits: e.required_credits,
          remaining_credits: e.remaining_credits,
          free_plan: e.free_plan,
        },
      });
      return;
    }
    if (e instanceof ProvisionBudgetExceeded) {
      res.status(402).json({
        error: { code: "provision_budget_exceeded", message: (e as Error).message },
      });
      return;
    }
    if (e instanceof BuildRepoNotProvisioned) {
      res.status(503).json({ error: buildSetupFailedBody(e) });
      return;
    }
    res.status(500).json({
      error: { code: "build_product_failed", message: (e as Error).message },
    });
  }
}

export async function getAutopilotRuns(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const supabase = serverClientFromBearer(auth.access_token);

  const appParam = req.query?.app;
  if (appParam !== undefined && appParam !== "workspace") {
    res.status(400).json({ error: { code: "bad_request", message: "app must be 'workspace'" } });
    return;
  }
  let runsQuery = supabase
    .from("conductor_runs")
    .select("id, objective, status, goal_graph, spend_usd, max_usd, created_at, updated_at")
    .eq("tenant_id", auth.tenant_id);
  if (appParam === "workspace") {
    runsQuery = runsQuery
      .is("goal_graph->0->payload->>site_id", null)
      .is("goal_graph->1->payload->>site_id", null)
      .is("goal_graph->2->payload->>site_id", null);
  }
  const { data: rows, error } = await runsQuery.order("created_at", { ascending: false }).limit(20);
  if (error) {
    res.status(500).json({ error: { code: "runs_list_failed", message: error.message } });
    return;
  }

  const { data: resRows } = await supabase
    .from("tenant_resources")
    .select("resource_kind, status, external_ref, updated_at")
    .eq("tenant_id", auth.tenant_id);
  const repo = resRows?.find((r) => r.resource_kind === "repo");
  const hosting = resRows?.find((r) => r.resource_kind === "hosting");
  const repo_url =
    typeof (repo?.external_ref as { repo_url?: string } | null)?.repo_url === "string"
      ? (repo?.external_ref as { repo_url: string }).repo_url
      : null;
  type Node = { id?: string; status?: string; payload?: { stage?: string } };
  const ageMs = (iso?: string) => (iso ? Date.now() - new Date(iso).getTime() : 0);
  const runSiteIds = new Map<string, string>();
  for (const r of rows ?? []) {
    const siteId = siteIdFromGraph(r.goal_graph);
    if (siteId) runSiteIds.set(r.id as string, siteId);
  }
  const sitesById = new Map<string, SiteRow>();
  if (runSiteIds.size > 0) {
    try {
      for (const s of await siteStore().listForTenant(auth.tenant_id)) {
        if (s.tenant_id === auth.tenant_id && isVisibleSite(s)) sitesById.set(s.id, s);
      }
    } catch {
    }
  }
  const runs = (rows ?? []).map((r) => {
    const graph = (r.goal_graph as Node[] | null) ?? [];
    const siteId = runSiteIds.get(r.id as string) ?? null;
    const site = siteId ? sitesById.get(siteId) ?? null : null;
    const node_summary = graph.map((n) => ({
      stage: n.payload?.stage ?? "?",
      status: n.status ?? "?",
    }));
    const stalled =
      r.status === "active" && ageMs(r.updated_at as string | undefined) > 15 * 60_000 && !lookAwaitingSiteId(graph);
    return {
      id: r.id,
      objective: r.objective,
      status: r.status,
      spend_usd: Number(r.spend_usd ?? 0),
      max_usd: r.max_usd === null ? null : Number(r.max_usd),
      created_at: r.created_at,
      updated_at: r.updated_at,
      node_summary,
      stalled,
      site_id: siteId,
      site: site
        ? {
            id: site.id,
            hostname: site.hostname,
            session_id: site.root_conductor_run_id,
            repo_url: siteRepoUrl(site),
            live_url: siteLiveUrl(site),
          }
        : null,
    };
  });

  const { data: latestBuildRows } = await supabase
    .from("conductor_runs")
    .select("status, goal_graph, created_at")
    .eq("tenant_id", auth.tenant_id)
    .eq("kind", "build_app")
    .or(NON_REFINE_BUILD_FILTER)
    .is("goal_graph->0->payload->>site_id", null)
    .is("goal_graph->1->payload->>site_id", null)
    .is("goal_graph->2->payload->>site_id", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const anyShipped =
    tenantAppIsLive(latestBuildRows) &&
    !buildDatabaseReclaimed(resRows, latestBuildRows?.[0] ?? null);
  const live_url =
    hosting?.status === "ready" &&
    anyShipped &&
    typeof (hosting?.external_ref as { url?: string } | null)?.url === "string"
      ? (hosting?.external_ref as { url: string }).url
      : null;

  res.json({
    runs,
    target: { repo_url, live_url },
  });
}

export type BuildPreview = {
  url: string | null;
  compiling?: boolean;
  kind: "none" | "instant" | "early" | "final";
};

export type SandboxPreviewState = {
  url: string | null;
  status: string | null;
  port?: number | null;
};

export function parseRepoFullName(repoUrl: string | null): string | null {
  if (!repoUrl || typeof repoUrl !== "string") return null;
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

const SUCCESS_TERMINAL_RUN = new Set(["done", "completed", "succeeded"]);

export function realAppShipped(
  stages: ReadonlyArray<{ stage: string; status: string }>,
  runStatus?: string | null,
): boolean {
  const byStage = new Map(stages.map((s) => [s.stage, s.status]));
  const deploy = byStage.get("deploy");
  const build = byStage.get("build");
  const qa = byStage.get("qa");
  if (deploy === undefined && build === undefined) return false;
  if (runStatus && SUCCESS_TERMINAL_RUN.has(runStatus)) return true;
  if (deploy !== undefined) return deploy === "done";
  return build === "done" && (qa === undefined || qa === "done" || qa === "skipped");
}

export { tenantAppIsLive, isRefineRun, NON_REFINE_BUILD_FILTER };

const PREVIEW_PROBE_TIMEOUT_MS = 2500;

type PreviewFetchLike = (
  url: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

export async function probePreviewLiveness(
  url: string,
  fetchFn: PreviewFetchLike = (globalThis as { fetch: PreviewFetchLike }).fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREVIEW_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method: "GET", signal: controller.signal });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function derivePreview(
  hostingStatus: string | null | undefined,
  hostingUrl: string | null,
  stages: ReadonlyArray<{ stage: string; status: string }>,
  runStatus: string | null | undefined,
  sandboxPreview?: SandboxPreviewState | null,
): BuildPreview {
  if (hostingStatus !== "ready" || !hostingUrl) {
    if (sandboxPreview && sandboxPreview.status === "live" && sandboxPreview.url) {
      return { url: sandboxPreview.url, kind: "instant" };
    }
    return { url: null, kind: "none" };
  }

  if (realAppShipped(stages, runStatus)) return { url: hostingUrl, kind: "final" };

  const failedTerminal =
    runStatus === "failed" ||
    runStatus === "halted" ||
    runStatus === "cancelled" ||
    runStatus === "canceled";
  const hasBuildPipeline = stages.some((s) => s.stage === "build" || s.stage === "deploy");
  if (failedTerminal || !hasBuildPipeline) return { url: null, kind: "none" };
  if (sandboxPreview && sandboxPreview.status === "live" && sandboxPreview.url) {
    return { url: sandboxPreview.url, kind: "instant" };
  }
  return { url: hostingUrl, kind: "early" };
}

export function earlyRenderServesThisRun(
  hostingCreatedAt: string | null,
  runCreatedAt: string | null,
  stages: ReadonlyArray<{ stage: string; status: string }>,
): boolean {
  const hostingAt = hostingCreatedAt ? Date.parse(hostingCreatedAt) : NaN;
  const runAt = runCreatedAt ? Date.parse(runCreatedAt) : NaN;
  if (!Number.isFinite(hostingAt) || !Number.isFinite(runAt) || hostingAt < runAt) return false;
  return stages.some((s) => s.stage === "scaffold" && (s.status === "done" || s.status === "skipped"));
}

const EARLY_PROBE_TTL_MS = 5000;
const EARLY_PROBE_CACHE_MAX = 500;

const earlyProbeCache = new Map<string, { at: number; live: boolean }>();

export async function probeEarlyPreviewCached(
  url: string,
  nowMs: number = Date.now(),
  probe: (u: string) => Promise<boolean> = probePreviewLiveness,
): Promise<boolean> {
  const hit = earlyProbeCache.get(url);
  if (hit && nowMs - hit.at < EARLY_PROBE_TTL_MS) return hit.live;
  const live = await probe(url);
  if (earlyProbeCache.size >= EARLY_PROBE_CACHE_MAX) {
    for (const [k, v] of earlyProbeCache) {
      if (nowMs - v.at >= EARLY_PROBE_TTL_MS) earlyProbeCache.delete(k);
    }
    if (earlyProbeCache.size >= EARLY_PROBE_CACHE_MAX) {
      const oldest = earlyProbeCache.keys().next();
      if (!oldest.done) earlyProbeCache.delete(oldest.value);
    }
  }
  earlyProbeCache.set(url, { at: nowMs, live });
  return live;
}

export type SandboxProbe = "ok" | "compiling" | "dead";

const NEXT_COMPILE_ERROR_RE = /id="__next_error__"|nextjs__container_errors|nextjs__container_build_error/;

export async function probeSandboxPreview(
  url: string,
  fetchFn: PreviewFetchLike = (globalThis as { fetch: PreviewFetchLike }).fetch,
): Promise<SandboxProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREVIEW_PROBE_TIMEOUT_MS);
  try {
    const res = (await fetchFn(url, { method: "GET", signal: controller.signal })) as {
      status: number;
      text?: () => Promise<string>;
    };
    const body = typeof res.text === "function" ? (await res.text().catch(() => "")).slice(0, 200_000) : "";
    if (NEXT_COMPILE_ERROR_RE.test(body)) return "compiling";
    return res.status >= 200 && res.status < 400 ? "ok" : "dead";
  } catch {
    return "dead";
  } finally {
    clearTimeout(timer);
  }
}

const sandboxProbeCache = new Map<string, { at: number; state: SandboxProbe }>();

export async function probeSandboxPreviewCached(
  url: string,
  nowMs: number = Date.now(),
  probe: (u: string) => Promise<SandboxProbe> = probeSandboxPreview,
): Promise<SandboxProbe> {
  const hit = sandboxProbeCache.get(url);
  if (hit && nowMs - hit.at < EARLY_PROBE_TTL_MS) return hit.state;
  const state = await probe(url);
  if (sandboxProbeCache.size >= EARLY_PROBE_CACHE_MAX) sandboxProbeCache.clear();
  sandboxProbeCache.set(url, { at: nowMs, state });
  return state;
}

export function __resetEarlyProbeCache(): void {
  earlyProbeCache.clear();
}

export function applyEarlyProbeToPreview(
  hostingStatus: string | null | undefined,
  hostingUrl: string | null,
  stages: ReadonlyArray<{ stage: string; status: string }>,
  runStatus: string | null | undefined,
  sandboxPreview: SandboxPreviewState | null | undefined,
  earlyRenderDead: boolean,
): BuildPreview {
  return derivePreview(
    earlyRenderDead ? undefined : hostingStatus,
    earlyRenderDead ? null : hostingUrl,
    stages,
    runStatus,
    sandboxPreview,
  );
}

const RUN_STOPPED: ReadonlySet<string> = new Set(["failed", "halted", "paused"]);

function buildStageRow(
  stage: string,
  n: BuildStageNode | undefined,
  childById: Map<string, BuildChildRun>,
  showRetries = false,
  expected: { site: boolean } | null = null,
  runStopped = false,
) {
  const retry_count = stageRetryCount(n);
  const expected_ms = expected ? stageExpectedMs(stage, expected.site) : null;
  const child = n?.child_run_id ? childById.get(n.child_run_id) : null;
  const started_at = n?.started_at ?? child?.started_at ?? null;
  const finished_at = n?.finished_at ?? child?.finished_at ?? null;
  const rawError = (n ? nodeFailureText(n) : null) ??
    (isFailedChildStatus(child?.status) ? childFailureMessage(child) : null);
  const status = n?.status === "dispatched" ? "running" : ((n?.status as string | undefined) ?? "pending");
  return {
    stage,
    status,
    error: founderStageError(rawError, status, n?.failure_class, runStopped),
    failure_class: n?.failure_class ?? null,
    started_at,
    finished_at,
    duration_ms: durationMs(started_at, finished_at),
    run_id: n?.child_run_id ?? null,
    agent: n?.target_agent_slug ?? child?.agent_slug ?? null,
    agent_status: child?.status ?? null,
    last_progress_at: child?.last_progress_at ?? null,
    retry_count,
    ...(showRetries && retry_count > 0 ? { attempt: retry_count + 1 } : {}),
    ...(expected_ms !== null ? { expected_ms } : {}),
    checkpoint: (n as { checkpoint?: unknown } | undefined)?.checkpoint ?? null,
  };
}

const BUILD_USAGE_TTL_MS = 15000;
const BUILD_USAGE_CACHE_MAX = 500;
const buildUsageCache = new Map<string, { at: number; value: { used_usd: number | null; used_credits: number | null } }>();

async function threadBuildSession(
  supabase: ReturnType<typeof serverClientFromBearer>,
  tenant_id: string,
  user_id: string,
  thread_id: string,
): Promise<string | null | undefined> {
  const { data, error } = await supabase
    .from("agent_threads")
    .select("id")
    .eq("id", thread_id)
    .eq("tenant_id", tenant_id)
    .eq("user_id", user_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`thread read failed: ${error.message}`);
  if (!data) return undefined;
  return buildSessionOfThread(supabase as unknown as BindingDb, tenant_id, thread_id);
}

async function latestSitePublishRun(
  supabase: ReturnType<typeof serverClientFromBearer>,
  tenant_id: string,
  site_id: string,
): Promise<SitePublishRun | null> {
  try {
    const { data, error } = await supabase
      .from("conductor_runs")
      .select("id, status, created_at, failure_class, goal_graph")
      .eq("tenant_id", tenant_id)
      .eq("kind", "build_app")
      .eq("goal_graph->0->payload->>site_id", site_id)
      .eq("goal_graph->0->payload->>republish", "true")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return null;
    const row = ((data ?? []) as Array<{ status?: unknown; created_at?: unknown; failure_class?: unknown; goal_graph?: unknown }>)[0];
    if (!row || siteIdFromGraph(row.goal_graph) !== site_id.toLowerCase()) return null;
    const node = (row.goal_graph as Array<{ payload?: { republish?: unknown; site_capacity_wait_since?: unknown } | null; error?: unknown; failure_class?: unknown; site_repair_pending?: unknown }>)[0];
    if (node?.payload?.republish !== true) return null;
    return {
      status: typeof row.status === "string" ? row.status : null,
      waiting_database: waitingForDatabase(node as { payload?: Record<string, unknown> | null }),
      repairing: node.site_repair_pending === true,
      created_at: typeof row.created_at === "string" ? row.created_at : null,
      reason: typeof node.error === "string" ? node.error : null,
      failure_class:
        typeof row.failure_class === "string" ? row.failure_class
        : typeof node.failure_class === "string" ? node.failure_class : null,
    };
  } catch {
    return null;
  }
}

const UNPUBLISHED_CHANGES_SHOWN = 10;

export async function unpublishedChangesBlock(
  supabase: ReturnType<typeof serverClientFromBearer>,
  tenant_id: string,
  site: SiteRow,
  changes: UnpublishedChangeView[],
  loadRun: typeof latestSitePublishRun = latestSitePublishRun,
  capped = false,
): Promise<{
  count: number;
  capped?: true;
  changes: Array<{ id: string; kind: "edit" | "undo"; at: string; message: string | null }>;
  publish: ReturnType<typeof sitePublishState>;
}> {
  const newest = changes[changes.length - 1];
  const run = await loadRun(supabase, tenant_id, site.id);
  const relevant =
    run && newest && Date.parse(run.created_at ?? "") >= Date.parse(newest.at) ? run : null;
  return {
    count: changes.length,
    ...(capped ? { capped: true as const } : {}),
    changes: changes
      .slice(-UNPUBLISHED_CHANGES_SHOWN)
      .reverse()
      .map((c) => ({ id: c.id, kind: c.kind, at: c.at, message: c.message ? decodeXmlEntities(c.message) : null })),
    publish: sitePublishState({ site_status: site.status, site_updated_at: site.updated_at, run: relevant }),
  };
}

export const SITE_PREVIEW_CONFIG_CHECK_MS = 5 * 60 * 1000;
const sitePreviewConfigChecks = new Map<string, number>();

export function __resetSitePreviewConfigChecks(): void {
  sitePreviewConfigChecks.clear();
}

export function claimSitePreviewConfigCheck(site_id: string, now: number = Date.now()): boolean {
  const last = sitePreviewConfigChecks.get(site_id);
  if (last !== undefined && now - last < SITE_PREVIEW_CONFIG_CHECK_MS) return false;
  sitePreviewConfigChecks.set(site_id, now);
  return true;
}

export function shouldWakeSitePreview(input: {
  site: SiteRow;
  run_status: unknown;
  preview_kind: "none" | "instant" | "final";
  sandbox: { preview_status: string | null } | null;
  unpublished?: boolean;
}): boolean {
  const { site } = input;
  if (input.run_status !== "done" || !site.github_full_name) return false;
  if (input.sandbox?.preview_status === "starting") return false;
  if (input.unpublished === true && siteDeployedUrl(site) !== null) return input.preview_kind !== "instant";
  if (input.sandbox === null) return false;
  if (input.preview_kind !== "none") return false;
  return site.status === "building" && siteDeployedUrl(site) === null;
}

export async function getAutopilotBuildStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const supabase = serverClientFromBearer(auth.access_token);

  type Node = BuildStageNode;
  let runIdParam =
    typeof req.query.run_id === "string" ? req.query.run_id.trim() : "";
  if (runIdParam && !BUILD_SESSION_UUID_RE.test(runIdParam)) {
    res.status(400).json({ error: { code: "bad_request", message: "run_id must be a uuid" } });
    return;
  }
  const appParam = req.query.app;
  if (appParam !== undefined && appParam !== "workspace") {
    res.status(400).json({ error: { code: "bad_request", message: "app must be 'workspace'" } });
    return;
  }
  let workspaceOnly = appParam === "workspace";
  const threadParam = req.query.thread_id;
  if (threadParam !== undefined) {
    if (runIdParam || appParam !== undefined) {
      res.status(400).json({
        error: { code: "bad_request", message: "thread_id cannot be combined with run_id or app" },
      });
      return;
    }
    if (typeof threadParam !== "string" || !BUILD_SESSION_UUID_RE.test(threadParam.trim())) {
      res.status(400).json({ error: { code: "bad_request", message: "thread_id must be a uuid" } });
      return;
    }
    let bound: string | null | undefined;
    try {
      bound = await threadBuildSession(supabase, auth.tenant_id, auth.user_id, threadParam.trim().toLowerCase());
    } catch (e) {
      res.status(500).json({ error: { code: "build_status_failed", message: (e as Error).message } });
      return;
    }
    if (bound === undefined) {
      res.status(404).json({ error: { code: "thread_not_found", message: "thread not found" } });
      return;
    }
    if (bound) runIdParam = bound;
    else workspaceOnly = true;
  }
  const runsQuery = supabase
    .from("conductor_runs")
    .select("id, objective, status, failure_class, paused_at, goal_graph, spend_usd, max_usd, created_at, updated_at")
    .eq("tenant_id", auth.tenant_id)
    .eq("kind", "build_app");
  const { data: rows, error } = runIdParam
    ? await runsQuery.eq("id", runIdParam).limit(1)
    : workspaceOnly
      ? await runsQuery
          .or(NON_REFINE_BUILD_FILTER)
          .is("goal_graph->0->payload->>site_id", null)
          .is("goal_graph->1->payload->>site_id", null)
          .is("goal_graph->2->payload->>site_id", null)
          .order("created_at", { ascending: false })
          .limit(1)
      : await runsQuery
          .or(NON_REFINE_BUILD_FILTER)
          .order("created_at", { ascending: false })
          .limit(1);
  if (error) {
    res
      .status(500)
      .json({ error: { code: "build_status_failed", message: error.message } });
    return;
  }

  const buildRun = (rows ?? []).find(
    (r) =>
      ((r.goal_graph as Node[] | null) ?? [])[0]?.payload?.refine_mode !== true &&
      !(workspaceOnly && isSiteGraph(r.goal_graph)),
  );

  if (!buildRun) {
    if (runIdParam) {
      res.status(404).json({
        error: { code: "build_not_found", message: "build not found" },
      });
      return;
    }
    res.json({ run: null, target: { repo_url: null, live_url: null } });
    return;
  }

  const graph = (buildRun.goal_graph as Node[] | null) ?? [];
  const childIds = graph
    .map((node) => node.child_run_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const readChildRuns = async (): Promise<BuildChildRun[]> => {
    if (childIds.length === 0) return [];
    const { data: childRows, error: childError } = await supabase
      .from("agent_runs")
      .select(
        "id, agent_slug, status, started_at, finished_at, last_progress_at, error, parse_error",
      )
      .eq("tenant_id", auth.tenant_id)
      .in("id", childIds);
    if (childError) {
      return [];
    }
    const children = (childRows ?? []) as BuildChildRun[];
    const failedNodeChildIds = new Set(
      graph.filter((node) => node.status === "failed").map((node) => node.child_run_id),
    );
    const needOutput = children
      .filter(
        (child) =>
          (isFailedChildStatus(child.status) || failedNodeChildIds.has(child.id)) &&
          !child.error?.trim() &&
          !child.parse_error?.trim(),
      )
      .map((child) => child.id);
    if (needOutput.length === 0) return children;
    const { data: outputRows } = await supabase
      .from("agent_runs")
      .select("id, output_text")
      .eq("tenant_id", auth.tenant_id)
      .in("id", needOutput);
    const outputById = new Map(
      ((outputRows ?? []) as Array<{ id: string; output_text?: string | null }>).map((row) => [row.id, row.output_text ?? null]),
    );
    return children.map((child) =>
      outputById.has(child.id) ? { ...child, output_text: outputById.get(child.id) } : child,
    );
  };

  const readUsage = async (): Promise<{ used_usd: number | null; used_credits: number | null }> => {
    if (runIdParam) return { used_usd: null, used_credits: null };
    const usageKey = `${auth.tenant_id}:${buildRun.id}`;
    const cachedUsage = buildUsageCache.get(usageKey);
    if (cachedUsage && Date.now() - cachedUsage.at < BUILD_USAGE_TTL_MS) return cachedUsage.value;
    const value = await computeUsage();
    if (value.used_usd !== null && value.used_credits !== null) {
      if (buildUsageCache.size >= BUILD_USAGE_CACHE_MAX) {
        const oldest = buildUsageCache.keys().next();
        if (!oldest.done) buildUsageCache.delete(oldest.value);
      }
      buildUsageCache.delete(usageKey);
      buildUsageCache.set(usageKey, { at: Date.now(), value });
    }
    return value;
  };

  const computeUsage = async (): Promise<{ used_usd: number | null; used_credits: number | null }> => {
    const { data: costRows, error: costErr } = await supabase
      .from("agent_runs")
      .select("id, cost_usd")
      .eq("tenant_id", auth.tenant_id)
      .eq(`payload->>${BUILD_CONDUCTOR_RUN_ID_KEY}`, buildRun.id);
    if (costErr) return { used_usd: null, used_credits: null };
    const rows = (costRows ?? []) as Array<{ id: string; cost_usd?: unknown }>;
    const usd = rows.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);
    if (rows.length === 0) return { used_usd: usd, used_credits: 0 };
    const { data: settled, error: settledErr } = await supabase
      .from("tenant_credit_ledger")
      .select("amount")
      .eq("tenant_id", auth.tenant_id)
      .eq("kind", "settle")
      .in("run_id", rows.map((r) => r.id));
    if (settledErr) return { used_usd: usd, used_credits: null };
    return {
      used_usd: usd,
      used_credits: (settled ?? []).reduce(
        (sum, r) => sum + (Number((r as { amount?: unknown }).amount) || 0),
        0,
      ),
    };
  };

  const readCancelRows = () =>
    supabase
      .from("autopilot_action_ledger")
      .select("evidence")
      .eq("tenant_id", auth.tenant_id)
      .eq("conductor_run_id", buildRun.id)
      .eq("action", "undo")
      .order("created_at", { ascending: false })
      .limit(1);

  const siteId = siteIdFromGraph(graph);
  if (siteId) {
    let site: Awaited<ReturnType<ReturnType<typeof siteStore>["get"]>>;
    try {
      site = await siteStore().get(auth.tenant_id, siteId);
    } catch (e) {
      res.status(500).json({ error: { code: "build_status_failed", message: (e as Error).message } });
      return;
    }
    if (!site) {
      res.status(404).json({ error: { code: "build_not_found", message: "build not found" } });
      return;
    }
    const [siteChildRuns, siteUsage, { data: siteCancelRows }, siteShowRetries, siteMovesInStage] = await Promise.all([
      readChildRuns(),
      readUsage(),
      readCancelRows(),
      buildRetriesShown(auth.tenant_id),
      buildProgressMovesInStage(auth.tenant_id),
    ]);
    const siteChildById = new Map(siteChildRuns.map((child) => [child.id, child]));
    const siteByStage = new Map<string, Node>();
    for (const n of graph) {
      const st = n.payload?.stage;
      if (typeof st === "string" && !siteByStage.has(st)) siteByStage.set(st, n);
    }
    const siteStages = siteGraphStages(graph).map((stage) =>
      buildStageRow(stage, siteByStage.get(stage), siteChildById, siteShowRetries, siteMovesInStage ? { site: true } : null, RUN_STOPPED.has(buildRun.status as string)),
    );
    const siteCancelKind = (siteCancelRows?.[0]?.evidence as { kind?: unknown } | null)?.kind;
    const siteFailure = summarizeBuildFailure({
      runStatus: buildRun.status,
      graph,
      children: siteChildById,
      cancelReason:
        siteCancelKind === "stale_slot_reap" || siteCancelKind === "user_cancel" ? siteCancelKind : null,
    });
    const visible = isVisibleSite(site);
    const siteLive: SiteLiveState = visible
      ? await siteLiveState(site, {
          offlineCheck: await siteOfflineCheckOn(auth.tenant_id),
          verify: verifySiteServesDeploy,
        })
      : { live_url: null, site_offline: false };
    const siteUrl = siteLive.live_url;
    let unpublished: UnpublishedChangeView[] = [];
    let unpublishedCapped = false;
    let unpublishedUnknown = false;
    if (visible && siteDeployedUrl(site)) {
      try {
        const read = await loadUnpublishedSiteChanges(supabase, auth.tenant_id, site.id);
        unpublished = read.changes;
        unpublishedCapped = read.capped;
      } catch (e) {
        unpublishedUnknown = true;
        console.warn(`getAutopilotBuildStatus: unpublished changes unreadable for site ${site.id}: ${(e as Error).message ?? e}`);
      }
    }
    let siteSandboxRow: Awaited<ReturnType<typeof loadSiteSandboxPreview>> = null;
    const sitePreviewBlock = visible
      ? await sitePreview(auth.tenant_id, site, {
          unpublishedChanges: unpublished.length > 0 || unpublishedUnknown,
          loadSandbox: async (tenantId, repo) => (siteSandboxRow = await loadSiteSandboxPreview(tenantId, repo)),
          probe: (url) => probeSandboxPreviewCached(url),
          clearDead: async (rowId) => {
            await serviceClient().rpc("clear_sandbox_preview", { p_id: rowId, p_final_status: "dead" });
          },
        })
      : { url: null, kind: "none" as const };
    const siteRunActive =
      visible &&
      ((sitePreviewBlock.kind === "none" && sitePreviewRestartable(site, buildRun.status)) ||
        (unpublished.length > 0 && siteDeployedUrl(site) !== null && sitePreviewBlock.kind !== "instant"))
        ? await activeSiteRunExists(supabase, auth.tenant_id, site.id)
        : false;
    let siteLease = visible && sitePreviewRestartable(site, buildRun.status) ? await siteLeaseHeld(auth.tenant_id, site.id) : null;
    if (siteLease === "restart" && sitePreviewBlock.kind !== "none") {
      void releaseSiteLease(auth.tenant_id, site.id, { kind: "restart" });
      siteLease = null;
    }
    let siteWakeToken: string | null = null;
    if (
      visible &&
      !siteRunActive &&
      siteLease !== "restart" &&
      shouldWakeSitePreview({ site, run_status: buildRun.status, preview_kind: sitePreviewBlock.kind, sandbox: siteSandboxRow, unpublished: unpublished.length > 0 }) &&
      claimPublishPreviewKick(buildRun.id)
    ) {
      const claim = await claimSiteLease(auth.tenant_id, site.id, "wake");
      if (claim.token !== null) siteWakeToken = claim.token;
      else if (claim.held === "restart") siteLease = "restart";
    }
    const siteWakeKicked = siteWakeToken !== null;
    const sitePreviewNow = visible
      ? sitePreviewState({
          site,
          run_status: buildRun.status,
          preview_kind: sitePreviewBlock.kind,
          sandbox_status: (siteSandboxRow as { preview_status: string | null } | null)?.preview_status ?? null,
          sandbox_updated_at: (siteSandboxRow as { updated_at?: string | null } | null)?.updated_at ?? null,
          waking: siteWakeKicked || siteLease === "wake" || sitePreviewDeadPending(siteSandboxRow),
          site_run_active: siteRunActive,
          restarting: siteLease === "restart",
        })
      : null;
    if (siteWakeKicked) {
      const tenantId = auth.tenant_id;
      const wakeSiteId = unpublished.length > 0 ? site.id : null;
      const leaseSiteId = site.id;
      const wakeToken = siteWakeToken as string;
      const wakeSite = site;
      const wakeRunId = buildRun.id;
      void (async () => {
        const { previewEnabled } = await import("@/services/sandbox/preview");
        if (!previewEnabled()) return;
        if (wakeSiteId) {
          const [{ createSiteSandboxResolver }, { siteStore: store }] = await Promise.all([
            import("@/services/sites/sandbox-resolver"),
            import("@/services/sites/store"),
          ]);
          await createSiteSandboxResolver({ store: store() }).forSite(tenantId, wakeSiteId);
        }
        await wakeSitePreview({ tenant_id: tenantId, run_id: wakeRunId, site: wakeSite });
      })()
        .catch((e) => {
          console.warn(`getAutopilotBuildStatus: site preview wake failed for ${buildRun.id}: ${(e as Error).message ?? e}`);
        })
        .finally(() => releaseSiteLease(tenantId, leaseSiteId, { token: wakeToken }));
    } else if (visible && sitePreviewBlock.kind === "instant" && claimSitePreviewConfigCheck(site.id)) {
      const tenantId = auth.tenant_id;
      const node = { payload: { target: { github_full_name: site.github_full_name } } } as unknown as ConductorNode;
      void import("@/services/agents/conductor-driver")
        .then(({ kickSandboxPreview }) => kickSandboxPreview({ tenant_id: tenantId, node, site: true, onlyIfAnswering: true }))
        .catch((e) => {
          console.warn(`getAutopilotBuildStatus: site preview config check failed for ${buildRun.id}: ${(e as Error).message ?? e}`);
        });
    }
    const siteDeployed = visible ? sitePublishedUrl(site) : null;
    const sitePublish =
      visible && awaitsPublishOnRequest(buildRun, graph, siteDeployed)
        ? { site_status: site.status, site_updated_at: site.updated_at, run: await latestSitePublishRun(supabase, auth.tenant_id, site.id) }
        : null;
    const siteReady = deriveAppReady(buildRun, graph, { url: siteDeployed, current: visible, site_publish: sitePublish });
    const siteChanges =
      unpublished.length > 0
        ? await unpublishedChangesBlock(supabase, auth.tenant_id, site, unpublished, latestSitePublishRun, unpublishedCapped)
        : null;
    const siteAnnounce = await liveAnnounced(auth.tenant_id, siteUrl);
    const siteAdmin = siteUrl ? siteOwnerAdmin(site, siteUrl, await siteAutoOwnerOn(auth.tenant_id)) : null;
    const firstView = visible && buildRun.status === "active" ? await readFirstView(supabase, auth.tenant_id, buildRun.id) : null;
    const sitePhotos = visible ? await readSitePhotos(supabase, auth.tenant_id, buildRun.id) : null;
    res.json({
      run: {
        id: buildRun.id,
        objective: decodeXmlEntities(buildRun.objective),
        status: buildRun.status,
        spend_usd: Number(buildRun.spend_usd ?? 0),
        max_usd: buildRun.max_usd === null ? null : Number(buildRun.max_usd),
        used_usd: siteUsage.used_usd,
        used_credits: siteUsage.used_credits,
        created_at: buildRun.created_at,
        updated_at: buildRun.updated_at,
        stages: siteStages,
        failure: founderFailureView(siteFailure, siteStages),
        ...(firstView ? { first_view: firstView } : {}),
      },
      target: {
        repo_url: siteRepoUrl(site),
        live_url: siteUrl,
        ...(siteAdmin ?? {}),
        ...(siteLive.site_offline ? { site_offline: true } : {}),
        ...(siteAnnounce ? { live_announce: true, live_announce_url: siteUrl } : {}),
      },
      preview: sitePreviewBlock,
      ...(sitePreviewNow ? { preview_state: sitePreviewNow } : {}),
      ...(sitePhotos ? { photos: sitePhotos } : {}),
      is_current: visible,
      app_ready: siteReady.app_ready,
      publish: siteReady.publish,
      site: { ...siteStatusBlock(site), live_url: siteUrl, published: siteDeployed !== null, ...(siteChanges ? { unpublished_changes: siteChanges } : {}), ...(unpublishedUnknown ? { unpublished_changes_unknown: true } : {}) },
    });
    return;
  }

  const [
    { data: resRows },
    childRuns,
    { used_usd, used_credits },
    { data: cancelRows },
    { data: latestFreshBuildRaw, error: latestFreshErrRaw },
    showRetries,
    movesInStage,
  ] = await Promise.all([
    supabase
      .from("tenant_resources")
      .select("resource_kind, status, external_ref, created_at, updated_at")
      .eq("tenant_id", auth.tenant_id),
    readChildRuns(),
    readUsage(),
    readCancelRows(),
    supabase
      .from("conductor_runs")
      .select("id, status, failure_class, goal_graph, created_at")
      .eq("tenant_id", auth.tenant_id)
      .eq("kind", "build_app")
      .or(NON_REFINE_BUILD_FILTER)
      .order("created_at", { ascending: false })
      .limit(LATEST_FRESH_WINDOW),
    buildRetriesShown(auth.tenant_id),
    buildProgressMovesInStage(auth.tenant_id),
  ]);

  let latestFreshBuild = newestAppReplacingBuild(latestFreshBuildRaw);
  let latestFreshErr = latestFreshErrRaw;
  if (!latestFreshErrRaw && isSiteGraph((latestFreshBuildRaw?.[0] as { goal_graph?: unknown } | undefined)?.goal_graph)) {
    const { data: olderRows, error: olderErr } = await supabase
      .from("conductor_runs")
      .select(`id, status, failure_class, created_at, ${PROVISION_MARKER_SELECT}, ${SITE_MARKER_SELECT}`)
      .eq("tenant_id", auth.tenant_id)
      .eq("kind", "build_app")
      .or(NON_REFINE_BUILD_FILTER)
      .is("goal_graph->0->payload->>site_id", null)
      .is("goal_graph->1->payload->>site_id", null)
      .is("goal_graph->2->payload->>site_id", null)
      .order("created_at", { ascending: false })
      .limit(LATEST_FRESH_WINDOW);
    latestFreshErr = olderErr;
    latestFreshBuild = newestAppReplacingBuild(
      ((olderRows ?? []) as Array<{ s0?: unknown; s1?: unknown; s2?: unknown }>).filter((r) => !rowHasSiteMarker(r)) as typeof latestFreshBuildRaw,
    );
  }

  const repo = resRows?.find((r) => r.resource_kind === "repo");
  const hosting = resRows?.find((r) => r.resource_kind === "hosting");
  const repo_url =
    typeof (repo?.external_ref as { repo_url?: string } | null)?.repo_url === "string"
      ? (repo?.external_ref as { repo_url: string }).repo_url
      : null;
  const hostingUrl =
    typeof (hosting?.external_ref as { url?: string } | null)?.url === "string"
      ? (hosting?.external_ref as { url: string }).url
      : null;

  const STAGES = ["provision", "spec", "scaffold", "build"] as const;
  const childById = new Map(childRuns.map((child) => [child.id, child]));

  const cancelKind = (cancelRows?.[0]?.evidence as { kind?: unknown } | null)?.kind;
  const cancelReason =
    cancelKind === "stale_slot_reap" || cancelKind === "user_cancel" ? cancelKind : null;

  const byStage = new Map<string, Node>();
  for (const n of graph) {
    const s = n.payload?.stage;
    if (typeof s === "string" && !byStage.has(s)) byStage.set(s, n);
  }
  const stages = STAGES.map((stage) =>
    buildStageRow(stage, byStage.get(stage), childById, showRetries, movesInStage ? { site: false } : null, RUN_STOPPED.has(buildRun.status as string)),
  );
  const failure = summarizeBuildFailure({
    runStatus: buildRun.status,
    graph,
    children: childById,
    cancelReason,
  });

  const gateStages = graph
    .map((n) => ({ stage: n.payload?.stage ?? "", status: (n.status as string | undefined) ?? "" }))
    .filter((s) => s.stage !== "");

  const latestFreshId = (latestFreshBuild?.[0] as { id?: string } | undefined)?.id ?? null;
  const newestFreshId = (latestFreshBuildRaw?.[0] as { id?: string } | undefined)?.id ?? null;
  const is_current = !runIdParam
    ? true
    : latestFreshErr
      ? false
      : latestFreshId === null ||
        latestFreshId === buildRun.id ||
        (newestFreshId === buildRun.id && !replacesOldApp(buildRun as ReplaceEvidenceRow));
  const retired =
    !latestFreshErr &&
    buildDatabaseReclaimed(
      resRows,
      (latestFreshBuild?.[0] as { created_at?: string | null } | undefined) ?? null,
    );
  const publishUrl = publishUrlFromResources(resRows, hostingUrl);
  if (!is_current || retired) {
    const stale = deriveAppReady(buildRun, graph, { url: publishUrl, current: false });
    res.json({
      run: {
        id: buildRun.id,
        objective: decodeXmlEntities(buildRun.objective),
        status: buildRun.status,
        spend_usd: Number(buildRun.spend_usd ?? 0),
        max_usd: buildRun.max_usd === null ? null : Number(buildRun.max_usd),
        used_usd,
        used_credits,
        created_at: buildRun.created_at,
        updated_at: buildRun.updated_at,
        stages,
        failure: founderFailureView(failure, stages),
      },
      target: { repo_url, live_url: null },
      preview: { url: null, kind: "none" },
      is_current: false,
      retired,
      app_ready: stale.app_ready,
      publish: stale.publish,
    });
    return;
  }
  const storedLiveUrl =
    hosting?.status === "ready" && tenantAppIsLive(latestFreshBuild) ? hostingUrl : null;
  const site_offline = await siteOffline(auth.tenant_id, storedLiveUrl);
  const live_url = site_offline ? null : storedLiveUrl;

  let sandboxPreview: SandboxPreviewState | null = null;
  let sandboxPreviewRowId: string | null = null;
  const repoFullName = parseRepoFullName(repo_url);
  if (repoFullName) {
    const svc = serviceClient();
    const { data: sbRow } = await svc
      .from("tenant_sandbox")
      .select("id, preview_url, preview_status, preview_port")
      .eq("tenant_id", auth.tenant_id)
      .eq("repo_full_name", repoFullName)
      .maybeSingle();
    if (sbRow) {
      sandboxPreviewRowId = (sbRow as { id: string }).id;
      sandboxPreview = {
        url: (sbRow as { preview_url: string | null }).preview_url,
        status: (sbRow as { preview_status: string | null }).preview_status,
        port: (sbRow as { preview_port: number | null }).preview_port,
      };
    }
  }

  let provisionalPreview = derivePreview(
    hosting?.status as string | undefined,
    hostingUrl,
    gateStages,
    buildRun.status as string | undefined,
    sandboxPreview,
  );
  let sandboxProbed = false;
  let sandboxCompiling = false;
  if (
    provisionalPreview.kind === "instant" &&
    hosting?.status === "ready" &&
    sandboxPreview?.url &&
    sandboxPreviewRowId
  ) {
    sandboxProbed = true;
    const sandboxState = await probeSandboxPreviewCached(sandboxPreview.url);
    if (sandboxState === "compiling") sandboxCompiling = true;
    if (sandboxState === "dead") {
      try {
        await serviceClient().rpc("clear_sandbox_preview", {
          p_id: sandboxPreviewRowId,
          p_final_status: "dead",
        });
      } catch (e) {
        console.warn(
          `getAutopilotBuildStatus: clear_sandbox_preview(dead) failed for ${sandboxPreviewRowId}: ${(e as Error).message ?? e}`,
        );
      }
      sandboxPreview = null;
      provisionalPreview = derivePreview(
        hosting?.status as string | undefined,
        hostingUrl,
        gateStages,
        buildRun.status as string | undefined,
        sandboxPreview,
      );
    }
  }
  let earlyRenderDead = false;
  if (provisionalPreview.kind === "early" && provisionalPreview.url) {
    earlyRenderDead =
      !earlyRenderServesThisRun(
        (hosting as { created_at?: string | null } | undefined)?.created_at ?? null,
        buildRun.created_at as string | null,
        gateStages,
      ) || !(await probeEarlyPreviewCached(provisionalPreview.url));
  }

  if (
    !sandboxProbed &&
    sandboxPreview?.status === "live" &&
    sandboxPreview.url &&
    sandboxPreviewRowId &&
    (hosting?.status !== "ready" || earlyRenderDead)
  ) {
    const sandboxState = await probeSandboxPreviewCached(sandboxPreview.url);
    if (sandboxState === "compiling") sandboxCompiling = true;
    if (sandboxState === "dead") {
      try {
        await serviceClient().rpc("clear_sandbox_preview", {
          p_id: sandboxPreviewRowId,
          p_final_status: "dead",
        });
      } catch (e) {
        console.warn(
          `getAutopilotBuildStatus: clear_sandbox_preview(dead) failed for ${sandboxPreviewRowId}: ${(e as Error).message ?? e}`,
        );
      }
      sandboxPreview = null;
    }
  }

  const preview = applyEarlyProbeToPreview(
    hosting?.status as string | undefined,
    hostingUrl,
    gateStages,
    buildRun.status as string | undefined,
    sandboxPreview,
    earlyRenderDead,
  );

  if (preview.kind === "instant" && sandboxPreviewRowId) {
    try {
      await serviceClient().rpc("touch_sandbox_preview_viewed", { p_id: sandboxPreviewRowId });
    } catch {
    }
  }

  const appReady = deriveAppReady(buildRun, graph, { url: publishUrl, current: true });
  if (
    appReady.app_ready &&
    appReady.publish.status === "publishing" &&
    repoFullName &&
    sandboxPreview?.status !== "live" &&
    sandboxPreview?.status !== "starting" &&
    claimPublishPreviewKick(buildRun.id)
  ) {
    const tenantId = auth.tenant_id;
    const node = { payload: { target: { github_full_name: repoFullName } } } as unknown as ConductorNode;
    void import("@/services/agents/conductor-driver")
      .then(({ kickSandboxPreview }) => kickSandboxPreview({ tenant_id: tenantId, node }))
      .catch((e) => {
        console.warn(`getAutopilotBuildStatus: publish preview kick failed for ${buildRun.id}: ${(e as Error).message ?? e}`);
      });
  }

  const shownReady = holdReadyForSmokeGate(appReady, await smokeGateOn(auth.tenant_id), buildRun, graph);
  res.json({
    run: {
      id: buildRun.id,
      objective: decodeXmlEntities(buildRun.objective),
      status: buildRun.status,
      spend_usd: Number(buildRun.spend_usd ?? 0),
      max_usd: buildRun.max_usd === null ? null : Number(buildRun.max_usd),
      used_usd,
      used_credits,
      created_at: buildRun.created_at,
      updated_at: buildRun.updated_at,
      stages,
      failure: founderFailureView(failure, stages),
    },
    target: {
      repo_url,
      live_url,
      ...(await siteAdminUrl(auth.tenant_id, live_url).then((a) => ({
        admin_url: a?.adminUrl ?? null,
        ...(a ? { admin_setup_email: a.ownerEmail } : {}),
      }))),
      ...(site_offline ? { site_offline: true } : {}),
      ...((await liveAnnounced(auth.tenant_id, live_url))
        ? { live_announce: true, live_announce_url: publishUrlFromResources(resRows, live_url) }
        : {}),
    },
    preview: preview.kind === "instant" && sandboxCompiling ? { ...preview, compiling: true } : preview,
    is_current: true,
    app_ready: shownReady.app_ready,
    publish: shownReady.publish,
  });
}

async function smokeGateOn(tenantId: string): Promise<boolean> {
  try {
    return await getBoolSetting("build_smoke_gate", tenantId);
  } catch {
    return false;
  }
}

export async function buildProgressMovesInStage(tenantId: string): Promise<boolean> {
  try {
    return await getBoolSetting("build_progress_moves_in_stage", tenantId);
  } catch {
    return false;
  }
}

export async function buildRetriesShown(tenantId: string): Promise<boolean> {
  try {
    return await getBoolSetting("build_progress_shows_retries", tenantId);
  } catch {
    return false;
  }
}

export async function editChangeSummaryShown(tenantId: string): Promise<boolean> {
  try {
    return await getBoolSetting("build_edit_change_summary", tenantId);
  } catch {
    return false;
  }
}

export async function editChangeFallbackShown(tenantId: string): Promise<boolean> {
  try {
    return await getBoolSetting("build_edit_change_summary_fallback", tenantId);
  } catch {
    return false;
  }
}

function parsedFiles(parsed: unknown): Array<{ path?: unknown; action?: unknown }> {
  const files = parsed && typeof parsed === "object" ? (parsed as { files?: unknown }).files : null;
  return Array.isArray(files) ? files.filter((f): f is { path?: unknown; action?: unknown } => !!f && typeof f === "object") : [];
}

export async function editUndoShown(tenantId: string): Promise<boolean> {
  try {
    return await getBoolSetting("build_edit_undo", tenantId);
  } catch {
    return false;
  }
}

export function declaredOutcomeOfPayload(payload: unknown): "no_change" | "needs_input" | "refused" {
  const v = payload && typeof payload === "object" ? (payload as { declared_outcome?: unknown }).declared_outcome : null;
  return v === "needs_input" || v === "refused" ? v : "no_change";
}

export const SITE_EDIT_ROLES = ["owner", "admin", "member"] as const;

async function callerCanUndo(auth: AuthedRequest): Promise<boolean> {
  try {
    const role = await loadTenantRole(auth);
    return role !== null && (SITE_EDIT_ROLES as readonly string[]).includes(role);
  } catch {
    return false;
  }
}

const REFINE_SETTLED_STATUS = new Set(["done", "failed", "halted"]);

export function undoableRefineId(
  rowsAsc: ReadonlyArray<{
    id: string;
    status: string;
    kind?: string | null;
    goal_graph: unknown[] | null;
    created_at?: string | null;
  }>,
  now: number = Date.now(),
): string | null {
  let candidate: string | null = null;
  for (const r of rowsAsc) {
    const first = (r.goal_graph ?? [])[0] as { payload?: unknown } | undefined;
    if (r.kind === "undo" && (r.status === "failed" || isStaleUndoClaim(r, now))) {
      continue;
    } else if (r.kind !== "undo" && isPublishRunPayload(first?.payload)) {
      continue;
    } else if (r.kind !== "undo" && r.status === "done" && isNoChangeRunPayload(first?.payload)) {
      continue;
    } else if (r.kind === "undo" || !isChangeRunPayload(first?.payload)) {
      candidate = null;
    } else if (r.status === "done") {
      candidate = r.id;
    } else if (!REFINE_SETTLED_STATUS.has(r.status)) {
      candidate = null;
    }
  }
  return candidate;
}

const CONVENTIONAL_PREFIX_RE = /^(?:feat|fix|chore|refactor|style|docs|perf|test|build|ci)(?:\([^)]*\))?!?:\s*/i;

const BRACKET_PREFIX_RE = /^(?:\[[^\]]*\]\s*)+/;
const DEV_TITLE_TERM_RE =
  /\b(?:hydration|refactor(?:s|ed|ing)?|hooks?|components?|props?|lint(?:s|ing|er)?|eslint|typecheck(?:s|ing)?|tests?|deps|bump(?:s|ed)?|merge[sd]?|wip)\b/i;
const HOOK_NAME_RE = /\buse[A-Z]\w*/;

function plainChangeLine(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const firstLine = (raw.trim().split("\n")[0] ?? "").trim();
  if (!firstLine || /^\[incomplete\]/i.test(firstLine)) return null;
  const text = firstLine.replace(BRACKET_PREFIX_RE, "").replace(CONVENTIONAL_PREFIX_RE, "").trim();
  if (!text || hasInternalJargon(text) || DEV_TITLE_TERM_RE.test(text) || HOOK_NAME_RE.test(text)) return null;
  return capChangeText(text.charAt(0).toUpperCase() + text.slice(1));
}

function plainChangeText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || hasInternalJargon(text)) return null;
  return capChangeText(text);
}

function capChangeText(text: string): string {
  return text.length > 280 ? `${text.slice(0, 279).trimEnd()}…` : text;
}

export function directEditChangeSummary(payload: unknown): string | null {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!p || p.direct_text_edit !== true) return null;
  return plainChangeText(p.customer_summary);
}

export function refineChangeSummary(
  outputText: string | null,
  parsed: unknown,
  outcome: unknown,
): string | null {
  const p = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const o = outcome && typeof outcome === "object" ? (outcome as Record<string, unknown>) : {};
  let envelope: Record<string, unknown> = {};
  const m = typeof outputText === "string"
    ? outputText.match(/<pr_proposal>\s*(\{[\s\S]*?\})\s*<\/pr_proposal>/i)
    : null;
  if (m) {
    try {
      const value = JSON.parse(m[1]) as unknown;
      if (value && typeof value === "object") envelope = value as Record<string, unknown>;
    } catch {
      envelope = {};
    }
  }
  return (
    plainChangeText(p.customer_summary) ??
    plainChangeText(o.customer_summary) ??
    plainChangeText(envelope.customer_summary) ??
    plainChangeLine(p.title) ??
    plainChangeLine(envelope.title)
  );
}

export async function liveAnnounced(tenantId: string, liveUrl: string | null): Promise<boolean> {
  if (!liveUrl) return false;
  try {
    return await getBoolSetting("build_live_announcement", tenantId);
  } catch {
    return false;
  }
}

export async function siteOffline(tenantId: string, liveUrl: string | null): Promise<boolean> {
  if (!liveUrl) return false;
  try {
    if (!(await getBoolSetting("build_site_offline_status", tenantId))) return false;
    return (await siteIsSuspended(liveUrl)) === true;
  } catch {
    return false;
  }
}

async function siteAutoOwnerOn(tenantId: string): Promise<boolean> {
  try {
    return await getBoolSetting("build_auto_site_owner", tenantId);
  } catch {
    return false;
  }
}

async function siteOfflineCheckOn(tenantId: string): Promise<boolean> {
  try {
    return await getBoolSetting("build_site_offline_status", tenantId);
  } catch {
    return false;
  }
}

const SITE_LIVE_PROBE_TIMEOUT_MS = 5_000;

async function verifySiteServesDeploy(hostname: string, deployId: string): Promise<boolean> {
  const { verifySiteDeploy } = await import("@/services/hosting/site-publish");
  const r = await verifySiteDeploy(hostname, deployId, {
    verifyAttempts: 1,
    fetchFn: (url, init) =>
      fetch(url, { ...(init as RequestInit), signal: AbortSignal.timeout(SITE_LIVE_PROBE_TIMEOUT_MS) }) as never,
  });
  return r.ok;
}

export async function siteAdminUrl(tenantId: string, liveUrl: string | null): Promise<OwnerAdminAccess | null> {
  return ownerAdminAccess(tenantId, liveUrl);
}

const LATEST_FRESH_WINDOW = 20;

export function newestAppReplacingBuild<T>(rows: T[] | null | undefined): T[] | null | undefined {
  if (!rows) return rows;
  const replacing = rows.find((r) => replacesOldApp(r as ReplaceEvidenceRow));
  return replacing ? [replacing] : rows.slice(0, 1);
}

export async function getAutopilotBuildSessions(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const supabase = serverClientFromBearer(auth.access_token);

  const { data: rowsDesc, error } = await supabase
    .from("conductor_runs")
    .select(SESSION_RUN_SELECT)
    .eq("tenant_id", auth.tenant_id)
    .eq("kind", "build_app")
    .order("created_at", { ascending: false })
    .limit(BUILD_SESSIONS_WINDOW);
  if (error) {
    res.status(500).json({
      error: { code: "build_sessions_failed", message: error.message },
    });
    return;
  }
  let rows = ((rowsDesc ?? []) as SessionRunRow[]).slice().reverse();

  if (rows.length >= BUILD_SESSIONS_WINDOW) {
    const { data: rootsDesc, error: rootsErr } = await supabase
      .from("conductor_runs")
      .select(SESSION_RUN_SELECT)
      .eq("tenant_id", auth.tenant_id)
      .eq("kind", "build_app")
      .or(NON_REFINE_BUILD_FILTER)
      .order("created_at", { ascending: false })
      .limit(BUILD_SESSIONS_ROOTS_MAX);
    if (rootsErr) {
      res.status(500).json({
        error: { code: "build_sessions_failed", message: rootsErr.message },
      });
      return;
    }
    const oldest = rows[0]?.created_at ?? "";
    const seen = new Set(rows.map((r) => r.id));
    const older = ((rootsDesc ?? []) as SessionRunRow[])
      .filter((r) => !seen.has(r.id) && !isRefineRow(r) && r.created_at < oldest)
      .reverse();
    rows = [...older, ...rows];
  }

  const [siteNames, siteRepoChip, siteListDetails, oneOldSite] = await Promise.all(
    (["build_site_own_name", "build_site_keeps_own_repo", "build_site_list_details", "build_old_flow_one_site_guard"] as const).map((key) =>
      getBoolSetting(key, auth.tenant_id).catch(() => true),
    ),
  );
  const { sessions, current_session_id } = groupBuildSessions(rows, { markReplaced: oneOldSite });
  const [[publishWaitsForApp, recentRowsStable, mobileActions, chipsWrapMobile, publishOnRequest, figmaHandoff], chatThreadFollowsBuild] = await Promise.all([
    Promise.all(
      (
        [
          "build_publish_waits_for_app",
          "build_recent_rows_stable",
          "build_mobile_actions",
          "home_chips_wrap_mobile",
          "build_publish_on_request",
          "build_figma_handoff",
        ] as const
      ).map((key) => getBoolSetting(key, auth.tenant_id).catch(() => true)),
    ),
    buildChatThreadsOn(auth.tenant_id),
  ]);
  let chatThreads = new Map<string, string[]>();
  if (chatThreadFollowsBuild) {
    try {
      chatThreads = await buildChatThreadIds(supabase, auth.tenant_id, auth.user_id);
    } catch (e) {
      console.warn(`getAutopilotBuildSessions: build chat threads read failed: ${(e as Error).message ?? e}`);
    }
  }

  let sitesByRun = new Map<string, ReturnType<typeof siteSessionSummary>>();
  if (rows.some((row) => rowHasSiteMarker(row))) {
    try {
      const sites = await siteStore().listForTenant(auth.tenant_id);
      sitesByRun = new Map(
        sites
          .filter((site) => isVisibleSite(site) && typeof site.root_conductor_run_id === "string")
          .map((site) => [
            site.root_conductor_run_id as string,
            siteSessionSummary(site, { name: siteNames, repo: siteRepoChip }),
          ]),
      );
    } catch (e) {
      console.warn(`getAutopilotBuildSessions: sites read failed: ${(e as Error).message ?? e}`);
    }
  }
  const oldPipelineRoots = new Set(
    rows
      .filter((row) => !isRefineRow(row) && !rowHasSiteMarker(row) && (row.status === "done" || row.status === "paused"))
      .map((row) => row.id),
  );
  const withSites = sessions.map((session) => {
    const site = sitesByRun.get(session.id);
    if (site) return { ...session, site };
    return oldPipelineRoots.has(session.id) ? { ...session, old_pipeline: true as const } : session;
  });
  res.json({
    sessions: chatThreads.size
      ? withSites.map((session) => {
          const threads = chatThreads.get(session.id);
          return threads ? { ...session, chat_thread_ids: threads } : session;
        })
      : withSites,
    current_session_id,
    flags: { site_names: siteNames, site_repo_chip: siteRepoChip, site_list_details: siteListDetails },
    ui_flags: {
      publish_waits_for_app: publishWaitsForApp,
      chat_thread_follows_build: chatThreadFollowsBuild,
      recent_rows_stable: recentRowsStable,
      mobile_actions: mobileActions,
      chips_wrap_mobile: chipsWrapMobile,
      publish_on_request: publishOnRequest,
      figma_handoff: figmaHandoff,
    },
  });
}

export async function getAutopilotRunDetail(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const id = String(req.params.id ?? "").trim();
  if (!id || id.length > 128) {
    res.status(400).json({ error: { code: "bad_request", message: "id is required" } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);

  const { data: run, error: runErr } = await supabase
    .from("conductor_runs")
    .select("id, objective, status, goal_graph, spend_usd, max_usd, created_at, updated_at")
    .eq("id", id)
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle();

  if (runErr) {
    res.status(500).json({ error: { code: "run_query_failed", message: runErr.message } });
    return;
  }
  if (!run) {
    res.status(404).json({
      error: { code: "conductor_run_not_found", message: "conductor run not found" },
    });
    return;
  }

  const { data: resRows } = await supabase
    .from("tenant_resources")
    .select("resource_kind, status, external_ref, updated_at")
    .eq("tenant_id", auth.tenant_id);
  const repo = resRows?.find((r) => r.resource_kind === "repo");
  const hosting = resRows?.find((r) => r.resource_kind === "hosting");
  let repo_url =
    typeof (repo?.external_ref as { repo_url?: string } | null)?.repo_url === "string"
      ? (repo?.external_ref as { repo_url: string }).repo_url
      : null;
  type Node = {
    id?: string;
    status?: string;
    payload?: { stage?: string; [k: string]: unknown };
    child_run_id?: string | null;
    finished_at?: string | null;
    started_at?: string | null;
    error?: string | null;
    last_failure_signal?: string | null;
    failure_class?: string | null;
    repair_attempts?: number | null;
    target_agent_slug?: string | null;
  };
  const graph = (run.goal_graph as Node[] | null) ?? [];

  const { data: latestBuildRows } = await supabase
    .from("conductor_runs")
    .select("status, goal_graph, created_at")
    .eq("tenant_id", auth.tenant_id)
    .eq("kind", "build_app")
    .or(NON_REFINE_BUILD_FILTER)
    .is("goal_graph->0->payload->>site_id", null)
    .is("goal_graph->1->payload->>site_id", null)
    .is("goal_graph->2->payload->>site_id", null)
    .order("created_at", { ascending: false })
    .limit(1);
  let live_url =
    hosting?.status === "ready" &&
    tenantAppIsLive(latestBuildRows) &&
    !buildDatabaseReclaimed(resRows, latestBuildRows?.[0] ?? null) &&
    typeof (hosting?.external_ref as { url?: string } | null)?.url === "string"
      ? (hosting?.external_ref as { url: string }).url
      : null;
  const runSiteId = siteIdFromGraph(graph);
  if (runSiteId) {
    let site: Awaited<ReturnType<ReturnType<typeof siteStore>["get"]>> = null;
    try {
      site = await siteStore().get(auth.tenant_id, runSiteId);
    } catch {
      site = null;
    }
    repo_url = site ? siteRepoUrl(site) : null;
    live_url = isVisibleSite(site) ? siteLiveUrl(site) : null;
  }

  const childRunIds = Array.from(
    new Set(
      graph
        .map((n) => n.child_run_id)
        .filter((x): x is string => typeof x === "string" && x.length > 0),
    ),
  );

  type AgentRunRow = {
    id: string;
    agent_slug: string;
    status: string;
    enqueued_at: string | null;
    started_at: string | null;
    finished_at: string | null;
    cost_usd: number | string | null;
    cost_tokens: number | null;
    error: string | null;
    parse_error?: string | null;
    output_text?: string | null;
    last_progress_at?: string | null;
  };
  let agentRuns: AgentRunRow[] = [];
  if (childRunIds.length > 0) {
    const { data: arRows, error: arErr } = await supabase
      .from("agent_runs")
      .select(
        "id, agent_slug, status, enqueued_at, started_at, finished_at, last_progress_at, cost_usd, cost_tokens, error, parse_error, outcome, output_text",
      )
      .eq("tenant_id", auth.tenant_id)
      .in("id", childRunIds);
    if (arErr) {
      res.status(500).json({
        error: { code: "agent_runs_query_failed", message: arErr.message },
      });
      return;
    }
    agentRuns = (arRows ?? []) as AgentRunRow[];
  }

  const { data: ledgerRows, error: ledgerErr } = await supabase
    .from("autopilot_action_ledger")
    .select(
      "id, node_id, action, target_agent_slug, child_run_id, outcome, error, spend_delta, evidence, created_at",
    )
    .eq("tenant_id", auth.tenant_id)
    .eq("conductor_run_id", id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (ledgerErr) {
    res.status(500).json({
      error: { code: "ledger_query_failed", message: ledgerErr.message },
    });
    return;
  }

  const ageMs = (iso?: string | null) =>
    iso ? Date.now() - new Date(iso).getTime() : 0;
  const stalled =
    run.status === "active" && ageMs(run.updated_at as string | undefined) > 15 * 60_000 && !lookAwaitingSiteId(run.goal_graph);
  const detailChildById = new Map(agentRuns.map((child) => [child.id, child]));
  const detailRunStopped = run.status === "failed" || run.status === "halted" || run.status === "paused";
  const founderLine = (raw: unknown): string | null =>
    typeof raw === "string" && raw.trim() ? founderBuildFailure({ message: raw })?.message ?? BUILD_INTERNAL_FAILURE : null;

  res.json({
    run: {
      id: run.id,
      objective: run.objective,
      status: run.status,
      spend_usd: Number(run.spend_usd ?? 0),
      max_usd: run.max_usd === null ? null : Number(run.max_usd),
      created_at: run.created_at,
      updated_at: run.updated_at,
      stalled,
      goal_graph: graph.map((n) => {
        const child = n.child_run_id ? detailChildById.get(n.child_run_id) : null;
        return {
          id: n.id ?? null,
          stage: n.payload?.stage ?? null,
          status: n.status ?? "pending",
          child_run_id: n.child_run_id ?? null,
          started_at: n.started_at ?? child?.started_at ?? null,
          finished_at: n.finished_at ?? child?.finished_at ?? null,
          error: founderStageError(
            n.error ?? n.last_failure_signal ?? child?.error ?? child?.parse_error ?? null,
            n.status ?? "pending",
            (n.failure_class ?? null) as Parameters<typeof founderStageError>[2],
            detailRunStopped,
          ),
          failure_class: n.failure_class ?? null,
          retry_count: Number.isFinite(n.repair_attempts) ? Number(n.repair_attempts) : 0,
          checkpoint: (n as { checkpoint?: unknown }).checkpoint ?? null,
          agent: n.target_agent_slug ?? child?.agent_slug ?? null,
          last_progress_at: child?.last_progress_at ?? null,
        };
      }),
    },
    target: { repo_url, live_url },
    agent_runs: agentRuns.map((r) => ({
      id: r.id,
      agent_slug: r.agent_slug,
      status: r.status,
      presentation_status: presentationStatus({
        status: r.status,
        outcome: (r as { outcome?: { deliverable?: string | null } | null }).outcome ?? null,
        outputText: (r as { output_text?: string | null }).output_text ?? null,
      }),
      side_effect_kind:
        (r as { outcome?: { side_effect?: { kind?: string } } | null }).outcome?.side_effect
          ?.kind ?? null,
      enqueued_at: r.enqueued_at,
      started_at: r.started_at,
      finished_at: r.finished_at,
      cost_usd: Number(r.cost_usd ?? 0),
      cost_tokens: r.cost_tokens ?? 0,
      error: founderLine(r.error),
    })),
    ledger: (ledgerRows ?? []).map((r) => ({
      id: r.id,
      node_id: r.node_id,
      action: r.action,
      target_agent_slug: r.target_agent_slug,
      child_run_id: r.child_run_id,
      outcome: r.outcome,
      error: founderLine(r.error),
      spend_delta: Number(r.spend_delta ?? 0),
      evidence: r.evidence,
      created_at: r.created_at,
    })),
  });
}

const LIVE_REFINE_STATUS = new Set(["provisioning", "active"]);
const REFINE_PANEL_KINDS = ["plan", "reasoning", "tool_call", "file_read", "file_edit", "file_create"];
const REFINE_PANEL_MAX_EVENTS = 200;

async function liveRefinePanels(
  tenantId: string,
  childRunIds: string[],
): Promise<Map<string, RunPanel>> {
  const panels = new Map<string, RunPanel>();
  if (childRunIds.length === 0) return panels;
  const sb = tenantClient(asTenantId(tenantId));
  await Promise.all(
    childRunIds.map(async (runId) => {
      try {
        const { data, error } = await sb
          .from("thread_event")
          .select("id, kind, body")
          .eq("agent_run_id", runId)
          .in("kind", REFINE_PANEL_KINDS)
          .order("id", { ascending: false })
          .limit(REFINE_PANEL_MAX_EVENTS);
        if (error) return;
        const rows: RunActivityRow[] = ((data ?? []) as Array<{
          id: number;
          kind: string;
          body: Record<string, unknown> | null;
        }>)
          .slice()
          .reverse()
          .map((r) => ({ id: String(r.id), kind: r.kind, body: r.body ?? {} }));
        panels.set(runId, buildRunPanel(rows, { state: "running" }));
      } catch {
        return;
      }
    }),
  );
  return panels;
}

export async function getAutopilotRefines(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sessionIdParam =
    typeof req.query.session_id === "string" ? req.query.session_id.trim() : "";
  if (sessionIdParam && !BUILD_SESSION_UUID_RE.test(sessionIdParam)) {
    res.status(400).json({ error: { code: "bad_request", message: "session_id must be a uuid" } });
    return;
  }
  const maxLimit = sessionIdParam ? 200 : 25;
  const defaultLimit = sessionIdParam ? 200 : 5;
  const rawLimit = Number(req.query.limit ?? defaultLimit);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(maxLimit, Math.floor(rawLimit)))
    : defaultLimit;

  const supabase = serverClientFromBearer(auth.access_token);

  type ConductorRow = {
    id: string;
    objective: string | null;
    status: string;
    goal_graph: unknown[] | null;
    spend_usd: number | string | null;
    max_usd: number | string | null;
    created_at: string;
    updated_at: string;
    kind?: string | null;
  };
  let rows: ConductorRow[] = [];
  let sessionRefineIds: Set<string> | null = null;
  let sessionUndoRows: ConductorRow[] = [];
  let undoCandidateId: string | null = null;
  let previewOnlyIds: Set<string> = new Set();
  if (sessionIdParam) {
    const { data: root, error: rootErr } = await supabase
      .from("conductor_runs")
      .select(`id, created_at, ${SITE_MARKER_SELECT}`)
      .eq("id", sessionIdParam)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    if (rootErr) {
      res
        .status(500)
        .json({ error: { code: "refines_list_failed", message: rootErr.message } });
      return;
    }
    if (!root) {
      res.status(404).json({ error: { code: "build_not_found", message: "build not found" } });
      return;
    }
    const rootSiteId = siteIdFromMarkerRow(root as { s0?: unknown; s1?: unknown; s2?: unknown });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const thisApp = (q: any): any =>
      rootSiteId
        ? q.eq("goal_graph->0->payload->>site_id", rootSiteId)
        : q
            .is("goal_graph->0->payload->>site_id", null)
            .is("goal_graph->1->payload->>site_id", null)
            .is("goal_graph->2->payload->>site_id", null);
    const { data: sessionRows, error: sessionErr } = await thisApp(
      supabase
        .from("conductor_runs")
        .select(
          "id, objective, status, goal_graph, spend_usd, max_usd, created_at, updated_at, kind",
        )
        .eq("tenant_id", auth.tenant_id)
        .in("kind", ["build_app", "undo"])
        .gte("created_at", (root as { created_at: string }).created_at),
    )
      .order("created_at", { ascending: true })
      .limit(200);
    if (sessionErr) {
      res
        .status(500)
        .json({ error: { code: "refines_list_failed", message: sessionErr.message } });
      return;
    }
    const allAsc = ((sessionRows ?? []) as ConductorRow[]).filter((r) =>
      rootSiteId ? siteIdFromGraph(r.goal_graph) === rootSiteId : !isSiteGraph(r.goal_graph),
    );
    if (rootSiteId && !allAsc.some((r) => r.id === sessionIdParam)) {
      const { data: rootRow, error: rootRowErr } = await supabase
        .from("conductor_runs")
        .select("id, objective, status, goal_graph, spend_usd, max_usd, created_at, updated_at, kind")
        .eq("id", sessionIdParam)
        .eq("tenant_id", auth.tenant_id)
        .maybeSingle();
      if (rootRowErr) {
        res.status(500).json({ error: { code: "refines_list_failed", message: rootRowErr.message } });
        return;
      }
      if (rootRow) allAsc.unshift(rootRow as ConductorRow);
    }
    let undoWindowAsc = allAsc;
    if ((sessionRows ?? []).length >= 200) {
      const { data: newestRows, error: newestErr } = await thisApp(
        supabase
          .from("conductor_runs")
          .select("id, status, goal_graph, created_at, kind")
          .eq("tenant_id", auth.tenant_id)
          .in("kind", ["build_app", "undo"])
          .gte("created_at", (root as { created_at: string }).created_at),
      )
        .order("created_at", { ascending: false })
        .limit(200);
      if (newestErr) {
        res
          .status(500)
          .json({ error: { code: "refines_list_failed", message: newestErr.message } });
        return;
      }
      undoWindowAsc = [...((newestRows ?? []) as ConductorRow[])]
        .reverse()
        .filter((r) => (rootSiteId ? siteIdFromGraph(r.goal_graph) === rootSiteId : !isSiteGraph(r.goal_graph)));
    }
    undoCandidateId = undoableRefineId(undoWindowAsc);
    if (rootSiteId) {
      try {
        const read = await loadUnpublishedSiteChanges(supabase, auth.tenant_id, rootSiteId);
        previewOnlyIds = new Set(read.changes.map((c) => c.id));
      } catch (e) {
        console.warn(`refines: unpublished changes unreadable for site ${rootSiteId}: ${(e as Error).message ?? e}`);
        const seen = new Map([...allAsc, ...undoWindowAsc].map((r) => [r.id, r]));
        previewOnlyIds = new Set(unpublishedSiteChanges([...seen.values()]).map((c) => c.id));
      }
    }
    const asc = allAsc.filter((r) => r.kind !== "undo");
    const projected: SessionRunRow[] = asc.map((r) => {
      const first = (r.goal_graph ?? [])[0] as
        | { payload?: { refine_mode?: unknown; parent_conductor_run_id?: unknown } }
        | undefined;
      return {
        id: r.id,
        objective: r.objective,
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
        refine_mode: first?.payload?.refine_mode,
        parent_id: first?.payload?.parent_conductor_run_id,
        ...siteMarkersOf(r.goal_graph),
      };
    });
    sessionRefineIds = new Set(refineIdsForSession(projected, sessionIdParam));
    rows = asc.filter((r) => sessionRefineIds!.has(r.id)).reverse();
    const keptUndoIds = new Set<string>();
    sessionUndoRows = allAsc
      .filter((r) => {
        if (r.kind !== "undo" || r.status !== "done") return false;
        const parent = revertParentId(r.goal_graph);
        const keep =
          parent === sessionIdParam ||
          (parent !== null && (sessionRefineIds!.has(parent) || keptUndoIds.has(parent)));
        if (keep) keptUndoIds.add(r.id);
        return keep;
      })
      .reverse();
  } else {
    const { data, error } = await supabase
      .from("conductor_runs")
      .select(
        "id, objective, status, goal_graph, spend_usd, max_usd, created_at, updated_at",
      )
      .eq("tenant_id", auth.tenant_id)
      .is("goal_graph->0->payload->>site_id", null)
      .is("goal_graph->1->payload->>site_id", null)
      .is("goal_graph->2->payload->>site_id", null)
      .order("created_at", { ascending: false })
      .limit(limit * 3);

    if (error) {
      res
        .status(500)
        .json({ error: { code: "refines_list_failed", message: error.message } });
      return;
    }
    rows = ((data ?? []) as ConductorRow[]).filter((r) => !isSiteGraph(r.goal_graph));
  }

  type Node = {
    status?: string;
    child_run_id?: string | null;
    finished_at?: string | null;
    payload?: {
      stage?: string;
      refine_mode?: unknown;
      idea?: unknown;
      preview_url?: unknown;
    };
  };

  const refineRows = (rows as Array<{
    id: string;
    objective: string | null;
    status: string;
    goal_graph: Node[] | null;
    spend_usd: number | string | null;
    max_usd: number | string | null;
    created_at: string;
    updated_at: string;
  }>)
    .filter((r) => isChangeRunPayload((r.goal_graph ?? [])[0]?.payload))
    .slice(0, limit);

  const childRunIds = Array.from(
    new Set(
      refineRows
        .map((r) => r.goal_graph?.[0]?.child_run_id)
        .filter((x): x is string => typeof x === "string" && x.length > 0),
    ),
  );

  type AgentRunRow = {
    id: string;
    status: string;
    finished_at: string | null;
    output_text: string | null;
    parsed: {
      pr_url?: unknown;
      pr_head_branch?: unknown;
      gate_evidence?: unknown;
      preview_path?: unknown;
    } | null;
    outcome: {
      deliverable?: unknown;
      side_effect?: { kind?: unknown; reason?: unknown } | null;
    } | null;
  };
  let agentRuns: AgentRunRow[] = [];
  if (childRunIds.length > 0) {
    const { data: arRows, error: arErr } = await supabase
      .from("agent_runs")
      .select("id, status, finished_at, output_text, parsed, outcome")
      .eq("tenant_id", auth.tenant_id)
      .in("id", childRunIds);
    if (arErr) {
      res.status(500).json({
        error: { code: "agent_runs_query_failed", message: arErr.message },
      });
      return;
    }
    agentRuns = (arRows ?? []) as AgentRunRow[];
  }
  const arById = new Map(agentRuns.map((r) => [r.id, r]));

  function extractSummary(output: string | null): string | null {
    if (!output || typeof output !== "string") return null;
    const m = output.match(/<pr_proposal>\s*(\{[\s\S]*?\})\s*<\/pr_proposal>/i);
    if (m) {
      try {
        const env = JSON.parse(m[1]) as { summary?: unknown; pr_url?: unknown };
        if (typeof env.summary === "string" && env.summary.trim().length > 0) {
          return env.summary.trim().slice(0, 280);
        }
      } catch {
      }
    }
    return null;
  }

  function extractPrUrl(output: string | null): string | null {
    if (!output || typeof output !== "string") return null;
    const m = output.match(/<pr_proposal>\s*(\{[\s\S]*?\})\s*<\/pr_proposal>/i);
    if (m) {
      try {
        const env = JSON.parse(m[1]) as { pr_url?: unknown };
        if (typeof env.pr_url === "string" && env.pr_url.length > 0) {
          return env.pr_url;
        }
      } catch {
      }
    }
    return null;
  }

  type ChangedFile = { path: string; action: string };
  function extractFiles(output: string | null): ChangedFile[] {
    if (!output || typeof output !== "string") return [];
    const m = output.match(/<pr_proposal>\s*(\{[\s\S]*?\})\s*<\/pr_proposal>/i);
    if (!m) return [];
    try {
      const env = JSON.parse(m[1]) as { files?: unknown };
      if (!Array.isArray(env.files)) return [];
      const out: ChangedFile[] = [];
      for (const f of env.files) {
        if (!f || typeof f !== "object") continue;
        const path = (f as { path?: unknown }).path;
        const action = (f as { action?: unknown }).action;
        if (typeof path !== "string" || path.length === 0) continue;
        out.push({
          path: path.slice(0, 512),
          action: typeof action === "string" ? action : "modify",
        });
        if (out.length >= 20) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  function extractGateEvidence(raw: unknown): GateEvidence | null {
    if (!raw || typeof raw !== "object") return null;
    const g = raw as Record<string, unknown>;
    const verdict = g.gate_verdict;
    if (verdict !== "pass" && verdict !== "fail") return null;
    const tests = g.tests as { passed?: unknown; failed?: unknown } | undefined;
    const preview = g.preview_smoke as
      | { verdict?: unknown; evidence_md?: unknown }
      | undefined;
    const pv = preview?.verdict;
    const previewVerdict: GateEvidence["preview_smoke"]["verdict"] =
      pv === "pass" || pv === "fail" || pv === "skipped" ? pv : "skipped";
    const out: GateEvidence = {
      build_ok: g.build_ok === true,
      tests: {
        passed: Number.isFinite(Number(tests?.passed)) ? Number(tests?.passed) : 0,
        failed: Number.isFinite(Number(tests?.failed)) ? Number(tests?.failed) : 0,
      },
      typecheck_ok:
        g.typecheck_ok === true ? true : g.typecheck_ok === false ? false : null,
      preview_smoke: {
        verdict: previewVerdict,
        evidence_md:
          typeof preview?.evidence_md === "string"
            ? preview.evidence_md.slice(0, 1000)
            : "",
      },
      gate_verdict: verdict,
    };
    if (Array.isArray(g.protected_paths)) {
      const hits = g.protected_paths
        .filter((h): h is { path: string; glob: string } => {
          if (!h || typeof h !== "object") return false;
          const hp = (h as { path?: unknown }).path;
          const hg = (h as { glob?: unknown }).glob;
          return typeof hp === "string" && hp.length > 0 && typeof hg === "string";
        })
        .slice(0, 20)
        .map((h) => ({ path: h.path.slice(0, 512), glob: h.glob.slice(0, 256) }));
      if (hits.length > 0) out.protected_paths = hits;
    }
    return out;
  }

  function extractPreviewUrl(graph: Node[] | null): string | null {
    for (const n of graph ?? []) {
      const u = n?.payload?.preview_url;
      if (typeof u === "string" && /^https?:\/\//i.test(u)) return u.slice(0, 2000);
    }
    return null;
  }

  function stripRefinePrefix(s: string | null): string {
    if (!s) return "";
    return s.replace(/^\[refine\]\s+/i, "").trim();
  }

  function extractNoShip(
    status: string,
    outcome: AgentRunRow["outcome"] | undefined,
  ): { message: string; reason: string | null } | null {
    if (!outcome || typeof outcome !== "object") return null;
    const terminalNoShip = status === "halted" || status === "failed";
    if (!terminalNoShip) return null;
    const se = outcome.side_effect ?? null;
    const deliverable =
      typeof outcome.deliverable === "string" && outcome.deliverable.trim().length > 0
        ? outcome.deliverable.trim().slice(0, 500)
        : null;
    if (!deliverable) return null;
    const reason = typeof se?.reason === "string" && se.reason.length > 0 ? se.reason : null;
    return { message: deliverable, reason };
  }

  const askedIn = new Map<string, string>();
  const wordless = refineRows.filter((r) => {
    const payload = r.goal_graph?.[0]?.payload as { user_request?: unknown; chat_thread_id?: unknown } | undefined;
    return typeof payload?.user_request !== "string" && typeof payload?.chat_thread_id === "string";
  });
  if (wordless.length > 0) {
    const threadIds = [
      ...new Set(
        wordless.map((r) => (r.goal_graph?.[0]?.payload as { chat_thread_id: string }).chat_thread_id),
      ),
    ];
    const { data: userTurns } = await supabase
      .from("agent_thread_messages")
      .select("thread_id, body, created_at")
      .eq("tenant_id", auth.tenant_id)
      .eq("sender_role", "user")
      .in("thread_id", threadIds)
      .order("created_at", { ascending: false })
      .limit(500);
    for (const r of wordless) {
      const thread = (r.goal_graph?.[0]?.payload as { chat_thread_id: string }).chat_thread_id;
      const before = Date.parse(r.created_at);
      const turn = ((userTurns ?? []) as Array<{ thread_id: string; body: string; created_at: string }>).find(
        (m) => m.thread_id === thread && Date.parse(m.created_at) <= before + 1000,
      );
      if (turn?.body?.trim()) askedIn.set(r.id, turn.body.trim());
    }
  }

  const livePanels = await liveRefinePanels(
    auth.tenant_id,
    refineRows
      .filter((r) => LIVE_REFINE_STATUS.has(r.status))
      .map((r) => r.goal_graph?.[0]?.child_run_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  let pendingDraftShas: Set<string> | null = null;
  let liveEditDraftMissing = false;
  let liveEditUnreadable = false;
  if (refineRows.some((r) => isLiveEditPayload(r.goal_graph?.[0]?.payload))) {
    try {
      const le = await readLiveEditState(auth.tenant_id);
      pendingDraftShas = pendingDraftShasOf(le);
      liveEditDraftMissing = le.enabled && !le.draft.exists;
    } catch {
      pendingDraftShas = null;
      liveEditUnreadable = true;
    }
  }
  const changeSummaryOn = await editChangeSummaryShown(auth.tenant_id);
  const changeFallbackOn = changeSummaryOn ? await editChangeFallbackShown(auth.tenant_id) : false;
  const undoOn = sessionIdParam ? await editUndoShown(auth.tenant_id) : false;
  const canUndo = undoOn ? await callerCanUndo(auth) : false;
  const refines = refineRows.map((r) => {
    const node = r.goal_graph?.[0];
    const ar = node?.child_run_id ? arById.get(node.child_run_id) : undefined;
    const noShip = extractNoShip(r.status, ar?.outcome);
    const legacySummary = extractSummary(ar?.output_text ?? null);
    const liveEditDraft = refineStillInDraft(node?.payload, ar?.parsed, pendingDraftShas, liveEditUnreadable);
    const noCode = r.status === "done" && isNoChangeRunPayload(node?.payload);
    const declared = noCode ? declaredOutcomeOfPayload(node?.payload) : null;
    const declaredMessage =
      declared && declared !== "no_change"
        ? (refineChangeSummary(ar?.output_text ?? null, ar?.parsed, ar?.outcome) ??
          (typeof ar?.outcome?.deliverable === "string" && ar.outcome.deliverable.trim()
            ? ar.outcome.deliverable.trim().slice(0, 500)
            : null))
        : null;
    const draft = noCode ? false : previewOnlyIds.has(r.id) ? true : liveEditDraft;
    const discarded = liveEditDraftMissing && isLiveEditPayload(node?.payload);
    const awaitingReview =
      refineAwaitsReview(r.goal_graph, (ar?.parsed as { merged?: unknown } | null | undefined)?.merged === true);
    return {
      id: r.id,
      message: decodeXmlEntities(
        askedIn.get(r.id) ?? refineDisplayText(r.goal_graph, stripRefinePrefix(r.objective)),
      ),
      status: r.status,
      failure_message: noShip?.message ?? null,
      no_ship_reason: noShip?.reason ?? null,
      no_change: declared === "no_change",
      declared_outcome: declared,
      declared_message: declaredMessage,
      awaiting_review: awaitingReview,
      retry_of:
        typeof (node?.payload as { retry_of?: unknown } | undefined)?.retry_of === "string"
          ? ((node?.payload as { retry_of: string }).retry_of)
          : null,
      selected_element: pickedElementLabel((node?.payload as { selected_element?: unknown } | undefined)?.selected_element),
      chat_thread_id:
        typeof (node?.payload as { chat_thread_id?: unknown } | undefined)?.chat_thread_id === "string"
          ? (node?.payload as { chat_thread_id: string }).chat_thread_id
          : null,
      spend_usd: Number(r.spend_usd ?? 0),
      max_usd: r.max_usd === null ? null : Number(r.max_usd),
      created_at: r.created_at,
      updated_at: r.updated_at,
      finished_at: ar?.finished_at ?? node?.finished_at ?? null,
      summary:
        legacySummary ??
        (changeSummaryOn && r.status === "done" && !discarded
          ? (directEditChangeSummary(node?.payload) ??
            refineChangeSummary(ar?.output_text ?? null, ar?.parsed, ar?.outcome) ??
            (changeFallbackOn ? plainEditLine([...extractFiles(ar?.output_text ?? null), ...parsedFiles(ar?.parsed)]) : null))
          : null),
      pr_url:
        typeof ar?.parsed?.pr_url === "string" && ar.parsed.pr_url.length > 0
          ? ar.parsed.pr_url
          : extractPrUrl(ar?.output_text ?? null),
      pr_head_branch:
        typeof ar?.parsed?.pr_head_branch === "string" &&
        ar.parsed.pr_head_branch.length > 0
          ? ar.parsed.pr_head_branch
          : null,
      files: extractFiles(ar?.output_text ?? null),
      gate_evidence: extractGateEvidence(ar?.parsed?.gate_evidence),
      preview_url: extractPreviewUrl(r.goal_graph),
      engineer_run_id: typeof node?.child_run_id === "string" ? node.child_run_id : null,
      preview_path: refinePreviewPath(ar?.parsed),
      panel: (node?.child_run_id && livePanels.get(node.child_run_id)) || null,
      ...(draft === null ? {} : { draft }),
      discarded,
      kind: "change" as const,
      ...(undoOn
        ? {
            undoable:
              canUndo &&
              r.id === undoCandidateId &&
              r.status === "done" &&
              liveEditDraft !== true &&
              !awaitingReview &&
              !discarded,
          }
        : {}),
    };
  });

  const reverts = sessionUndoRows.map((r) => {
    const stage = revertStage(r.goal_graph);
    return {
      id: r.id,
      message: revertMessage(r.objective, stage),
      status: "done",
      failure_message: null,
      no_ship_reason: null,
      awaiting_review: false,
      retry_of: null,
      spend_usd: 0,
      max_usd: 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
      finished_at: r.updated_at,
      summary: null,
      pr_url: null,
      pr_head_branch: null,
      files: [] as Array<{ path: string; action: string }>,
      gate_evidence: null,
      preview_url: null,
      engineer_run_id: null,
      preview_path: null,
      panel: null,
      draft: previewOnlyIds.has(r.id),
      kind: stage,
      parent_conductor_run_id: revertParentId(r.goal_graph),
    };
  });

  if (reverts.length === 0) {
    res.json({ refines });
    return;
  }
  const feed = [...refines, ...reverts].sort(
    (a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0),
  );
  res.json({ refines: feed });
}

export function refinePreviewPath(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  return sanitizePreviewPath((parsed as { preview_path?: unknown }).preview_path);
}

export function pendingDraftShasOf(state: {
  enabled: boolean;
  draft: { exists: boolean; changes: Array<{ sha: string }> };
}): Set<string> | null {
  if (!state.enabled) return null;
  return new Set(state.draft.changes.map((c) => c.sha));
}

export function refineStillInDraft(
  payload: unknown,
  parsed: unknown,
  pendingDraftShas: Set<string> | null,
  stateUnreadable = false,
): boolean | null {
  if (!isLiveEditPayload(payload)) return false;
  const sha = (parsed as { live_edit_draft_sha?: unknown } | null | undefined)?.live_edit_draft_sha;
  if (typeof sha !== "string" || !sha) return true;
  if (stateUnreadable) return null;
  if (!pendingDraftShas) return true;
  return pendingDraftShas.has(sha);
}

function revertPayload(
  graph: unknown[] | null,
): { stage?: unknown; parent_conductor_run_id?: unknown } | undefined {
  const first = (graph ?? [])[0] as
    | { payload?: { stage?: unknown; parent_conductor_run_id?: unknown } }
    | undefined;
  return first?.payload;
}

function revertParentId(graph: unknown[] | null): string | null {
  const parent = revertPayload(graph)?.parent_conductor_run_id;
  return typeof parent === "string" && parent.length > 0 ? parent : null;
}

function revertStage(graph: unknown[] | null): "restore" | "undo" {
  return revertPayload(graph)?.stage === "restore" ? "restore" : "undo";
}

function revertMessage(objective: string | null, stage: "restore" | "undo"): string {
  const text = (objective ?? "").trim();
  const restore = text.match(/^\[restore\]\s*(.*)$/i);
  if (restore) {
    const label = decodeXmlEntities(restore[1].trim());
    return label ? `Reverted to ${label}` : "Reverted to an earlier version";
  }
  if (/^\[undo\]/i.test(text) || stage === "undo") return "Undid the last change";
  return "Reverted to an earlier version";
}

function pickedElementLabel(raw: unknown): { tag: string; text: string | null; path: string | null } | null {
  const scope = parseSelectedElement(raw);
  if (!scope || scope === "invalid") return null;
  return { tag: scope.tag, text: scope.text ?? null, path: scope.path ?? null };
}

const RETRYABLE_REFINE_STATUSES = new Set(["failed", "halted"]);

type RetryableRefine = {
  id: string;
  idea: string;
  request: string | null;
  selected_element: SelectedElementScope | null;
  image_paths: string[];
};

type RetryLookup =
  | { ok: true; refine: RetryableRefine }
  | { ok: false; status: number; code: string; message: string; retried_by?: string };

const NOT_RETRYABLE: RetryLookup = {
  ok: false,
  status: 404,
  code: "refine_not_retryable",
  message: "That change can't be retried. Describe it again in the chat.",
};

const OLD_SITE_RETRY: RetryLookup = {
  ok: false,
  status: OLD_SITE_FROZEN_STATUS,
  code: OLD_SITE_FROZEN_CODE,
  message: OLD_SITE_FROZEN_MESSAGE,
};

async function loadRetryableRefine(
  tenantId: string,
  accessToken: string,
  id: string,
  sessionId: string | null,
): Promise<RetryLookup> {
  const supabase = serverClientFromBearer(accessToken);
  const { data } = await supabase
    .from("conductor_runs")
    .select("id, status, created_at, goal_graph")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  const row = data as { id: string; status: string; created_at: string; goal_graph: unknown } | null;
  if (!row || !RETRYABLE_REFINE_STATUSES.has(row.status)) return NOT_RETRYABLE;
  const payload = (Array.isArray(row.goal_graph) ? row.goal_graph[0] : null)?.payload as
    | {
        refine_mode?: unknown;
        idea?: unknown;
        user_request?: unknown;
        chat_thread_id?: unknown;
        parent_conductor_run_id?: unknown;
        selected_element?: unknown;
        request_image_paths?: unknown;
      }
    | undefined;
  if (payload?.refine_mode !== true || typeof payload.idea !== "string" || !payload.idea.trim()) return NOT_RETRYABLE;
  if (!siteIdFromGraph(row.goal_graph)) return OLD_SITE_RETRY;
  if (sessionId !== null && payload.parent_conductor_run_id !== sessionId) {
    return {
      ok: false,
      status: 409,
      code: "retry_session_mismatch",
      message: "That change belongs to a different build. Open that build to retry it.",
    };
  }
  const { data: retries, error: retriesError } = await supabase
    .from("conductor_runs")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("goal_graph->0->payload->>retry_of", row.id)
    .limit(1);
  if (retriesError) {
    console.error(`[refine-retry] retry lookup failed for run=${row.id}: ${retriesError.message}`);
    return { ok: false, status: 503, code: "retry_check_failed", message: "Could not check that change. Try again." };
  }
  const existing = ((retries ?? []) as Array<{ id: string }>)[0];
  if (existing) {
    return {
      ok: false,
      status: 409,
      code: "refine_already_retried",
      message: "That change was already retried. Retry the latest attempt instead.",
      retried_by: existing.id,
    };
  }
  let request = typeof payload.user_request === "string" ? payload.user_request : null;
  if (!request && typeof payload.chat_thread_id === "string") {
    const { data: turn } = await supabase
      .from("agent_thread_messages")
      .select("body")
      .eq("tenant_id", tenantId)
      .eq("thread_id", payload.chat_thread_id)
      .eq("sender_role", "user")
      .lte("created_at", new Date(Date.parse(row.created_at) + 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const body = (turn as { body?: unknown } | null)?.body;
    request = typeof body === "string" && body.trim() ? body.trim() : null;
  }
  const picked = parseSelectedElement(payload.selected_element);
  return {
    ok: true,
    refine: {
      id: row.id,
      idea: payload.idea,
      request,
      selected_element: picked && picked !== "invalid" ? picked : null,
      image_paths: refineRequestImagePaths(tenantId, payload),
    },
  };
}

export const REFINE_FAILED_MESSAGE = "That change could not start. Try again in a minute.";

async function holdRefineWhileBuilding(
  tenant_id: string,
  user_id: string | null,
  conductor_run_id: string,
  message: string,
): Promise<string | null> {
  if (!BUILD_SESSION_UUID_RE.test(conductor_run_id)) return null;
  let siteId: string | null;
  try {
    siteId = (await realRefineProductDeps.loadSiteForRun?.(tenant_id, conductor_run_id))?.id ?? null;
  } catch {
    return null;
  }
  if (!siteId) return null;
  const { holdBusySiteChange } = await import("./website-chat");
  return holdBusySiteChange({ tenant_id, site_id: siteId, conductor_run_id, message, user_id });
}

export async function postAutopilotRefineProduct(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, SITE_EDIT_ROLES, res))) return;

  if (!(await isProductBuilderEnabled())) {
    res.status(403).json({
      error: { code: "product_builder_disabled", message: "Product builder is not enabled." },
    });
    return;
  }

  const body = (req.body ?? {}) as {
    conductor_run_id?: unknown;
    message?: unknown;
    max_usd?: unknown;
    retry_of?: unknown;
    small_edit?: unknown;
    app?: unknown;
    photo_retry?: unknown;
    selection?: unknown;
    image_paths?: unknown;
  };

  const photoRetry = body.photo_retry === true;
  if (photoRetry) {
    if (typeof body.conductor_run_id !== "string" || !body.conductor_run_id.trim() || body.retry_of != null || body.app != null) {
      res.status(400).json({ error: { code: "bad_request", message: "photo_retry needs conductor_run_id and takes no retry_of or app" } });
      return;
    }
    body.message = PHOTO_RETRY_MESSAGE;
  }

  const selection = photoRetry ? null : parseSelectedElement(body.selection);
  if (selection === "invalid") {
    res.status(400).json({ error: { code: "bad_request", message: "selection is not a valid element" } });
    return;
  }

  if (body.app !== undefined && body.app !== null) {
    if (body.app !== "workspace") {
      res.status(400).json({ error: { code: "bad_request", message: "app must be 'workspace'" } });
      return;
    }
    if (body.conductor_run_id !== undefined && body.conductor_run_id !== null) {
      res.status(400).json({ error: { code: "bad_request", message: "app=workspace takes no conductor_run_id" } });
      return;
    }
  }
  const workspaceApp = body.app === "workspace";

  const attached = parseRefineImagePaths(auth.tenant_id, body.image_paths);
  if (!attached.ok) {
    res.status(400).json({ error: { code: "invalid_image_paths", message: attached.message } });
    return;
  }
  if (attached.paths.length > 0 && (photoRetry || workspaceApp || body.retry_of != null)) {
    res.status(400).json({ error: { code: "bad_request", message: "image_paths go with a new change to a build" } });
    return;
  }

  let retry: RetryableRefine | null = null;
  if (body.retry_of !== undefined && body.retry_of !== null) {
    const retryOf = typeof body.retry_of === "string" ? body.retry_of.trim() : "";
    if (!BUILD_SESSION_UUID_RE.test(retryOf)) {
      res.status(400).json({ error: { code: "bad_request", message: "retry_of must be a uuid" } });
      return;
    }
    const sessionId =
      typeof body.conductor_run_id === "string" && body.conductor_run_id.trim() ? body.conductor_run_id.trim() : null;
    const found = await loadRetryableRefine(auth.tenant_id, auth.access_token, retryOf, sessionId);
    if (!found.ok && found.code === OLD_SITE_FROZEN_CODE) {
      res.status(OLD_SITE_FROZEN_STATUS).json(oldSiteFrozenBody());
      return;
    }
    if (!found.ok) {
      res.status(found.status).json({
        error: { code: found.code, message: found.message },
        ...(found.retried_by ? { retried_by: found.retried_by } : {}),
      });
      return;
    }
    retry = found.refine;
  }

  const rawMessage = retry ? retry.idea : typeof body.message === "string" ? body.message : "";
  const message = rawMessage.trim();
  const scope = retry ? retry.selected_element : selection;
  const MIN_MESSAGE_LEN = scope || (retry ? retry.image_paths : attached.paths).length > 0 ? 2 : 8;
  const MAX_LEN = scope ? MAX_SCOPED_MESSAGE : 4000;
  if (message.length < MIN_MESSAGE_LEN || message.length > MAX_LEN) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: `message (${MIN_MESSAGE_LEN}–${MAX_LEN} chars) is required. Describe what you want changed`,
      },
    });
    return;
  }

  const cleanMessage = retry ? message : xmlEscapeContent(sanitizeFetchedContent(message));
  if (!retry && !photoRetry) void saveOwnerChatFacts(auth, message);

  let max_usd: number | undefined;
  if (body.max_usd !== undefined) {
    if (typeof body.max_usd !== "number" || !Number.isFinite(body.max_usd) || body.max_usd < 0) {
      res.status(400).json({
        error: { code: "bad_request", message: "max_usd must be a number >= 0" },
      });
      return;
    }
    if (body.max_usd > MAX_PRODUCT_BUILD_MAX_USD) {
      res.status(400).json({
        error: {
          code: "bad_request",
          message: `max_usd exceeds the ceiling of ${MAX_PRODUCT_BUILD_MAX_USD}`,
        },
      });
      return;
    }
    max_usd = body.max_usd;
  }

  let conductor_run_id: string | null = null;
  if (body.conductor_run_id !== undefined && body.conductor_run_id !== null) {
    if (typeof body.conductor_run_id !== "string") {
      res.status(400).json({
        error: { code: "bad_request", message: "conductor_run_id must be a string" },
      });
      return;
    }
    const id = body.conductor_run_id.trim();
    if (id.length === 0 || id.length > 128) {
      res.status(400).json({
        error: { code: "bad_request", message: "conductor_run_id length 1–128 required" },
      });
      return;
    }
    conductor_run_id = id;
  }

  const imagePaths = retry ? retry.image_paths : attached.paths;
  const fixRunId = conductor_run_id;
  if (!retry && !workspaceApp && fixRunId && imagePaths.length === 0) {
    const fast = await (async () => {
      const { tryPreviewDepsFix, realPreviewDepsFixDeps, unresolvedPackageImports } = await import("@/services/sites/preview-deps-fix");
      if (!unresolvedPackageImports(message)) return null;
      const onRepairFailed = async (result: string) => {
        console.warn(`[refine-product] preview deps fast path ended ${result}, sending the fix to the agent`);
        const fallback = await refineProduct({
          tenant_id: auth.tenant_id,
          message: cleanMessage,
          request: null,
          retry_of: null,
          conductor_run_id: fixRunId,
          max_usd: max_usd ?? DEFAULT_REFINE_MAX_USD,
          ...(selection ? { selected_element: selection } : {}),
        });
        await requestConductorTick(inngest, fallback.conductor_run_id);
      };
      return tryPreviewDepsFix(
        { tenant_id: auth.tenant_id, conductor_run_id: fixRunId, message, onRepairFailed },
        await realPreviewDepsFixDeps(),
      );
    })().catch((e) => {
      console.warn(`[refine-product] preview deps fast path failed, sending the fix to the agent: ${(e as Error)?.message ?? e}`);
      return null;
    });
    if (fast?.handled) {
      res.json({
        ok: true,
        conductor_run_id: null,
        parent_conductor_run_id: fixRunId,
        target: "preview_deps",
        fast_fix: { kind: "deps_reinstall", packages: fast.packages },
      });
      return;
    }
  }

  try {
    const result = await refineProduct({
      tenant_id: auth.tenant_id,
      message: cleanMessage,
      request: retry?.request ?? null,
      retry_of: retry?.id ?? null,
      conductor_run_id,
      max_usd: max_usd ?? DEFAULT_REFINE_MAX_USD,
      ...(body.small_edit === true && !retry && !photoRetry && classifyAppEdit(message) === "simple" ? { small_edit: true } : {}),
      ...(workspaceApp ? { singleton_app: true } : {}),
      ...(photoRetry ? { photo_retry: true } : {}),
      ...(scope ? { selected_element: scope } : {}),
      ...(imagePaths.length > 0 ? { image_paths: imagePaths } : {}),
    });
    await requestConductorTick(inngest, result.conductor_run_id);
    res.json({
      ok: true,
      conductor_run_id: result.conductor_run_id,
      parent_conductor_run_id: result.parent_conductor_run_id,
      target: result.target,
    });
  } catch (e) {
    if (e instanceof InvalidRefineMessage) {
      res.status(400).json({
        error: { code: "invalid_refine_message", message: (e as Error).message },
      });
      return;
    }
    if (
      (e instanceof DoubleBuildInFlight || e instanceof NoProvisionedRepo) &&
      !retry &&
      !photoRetry &&
      !scope &&
      !workspaceApp &&
      imagePaths.length === 0 &&
      conductor_run_id
    ) {
      const held = await holdRefineWhileBuilding(auth.tenant_id, auth.user_id ?? null, conductor_run_id, cleanMessage);
      if (held) {
        res.status(202).json({ ok: true, queued: true, chat: held });
        return;
      }
    }
    if (e instanceof PhotoRetryTaken) {
      res.status(409).json({ error: { code: "photo_retry_taken", message: (e as Error).message } });
      return;
    }
    if (e instanceof NoProvisionedRepo) {
      res.status(409).json({
        error: { code: "no_provisioned_repo", message: (e as Error).message },
      });
      return;
    }
    if (e instanceof ConductorRunNotFound) {
      res.status(404).json({
        error: { code: "conductor_run_not_found", message: (e as Error).message },
      });
      return;
    }
    if (e instanceof BuildRetired) {
      res.status(409).json({
        error: { code: "build_retired", message: (e as Error).message },
      });
      return;
    }
    if (e instanceof UndoInProgress) {
      res.status(409).json({
        error: { code: "undo_in_progress", message: (e as Error).message },
      });
      return;
    }
    if (e instanceof SitePreviewRestarting) {
      res.status(409).json({
        error: { code: "preview_restarting", message: "This site's preview is restarting. Send your change again once it is back." },
      });
      return;
    }
    if (e instanceof OldSiteFrozen) {
      res.status(OLD_SITE_FROZEN_STATUS).json(oldSiteFrozenBody());
      return;
    }
    if (e instanceof SiteRequired) {
      res.status(e.reason === "ambiguous" ? 409 : 503).json({
        error: {
          code: e.reason === "ambiguous" ? "site_required" : "site_unreadable",
          message: (e as Error).message,
        },
      });
      return;
    }
    if (e instanceof SiteUnavailable) {
      res.status(409).json({ error: { code: "site_unavailable", message: (e as Error).message } });
      return;
    }
    if (e instanceof DoubleBuildInFlight) {
      res.status(409).json({
        error: {
          code: "build_already_in_progress",
          message: "another build or refine is already in progress for this tenant",
        },
      });
      return;
    }
    if (e instanceof TooManyBuildsToday) {
      res.status(429).json({
        error: { code: "daily_build_limit_reached", message: (e as Error).message },
      });
      return;
    }
    if (e instanceof FreeEditsUsed) {
      res.status(402).json({
        error: {
          code: "free_edits_used",
          message: refusalFor({ kind: "free_edits_used", message: e.message }).message,
          free_edits_limit: e.limit,
        },
      });
      return;
    }
    if (e instanceof InsufficientCreditsForBuild) {
      res.status(402).json({
        error: {
          code: "insufficient_credits_for_build",
          message: refusalFor({
            kind: "credits_for_build",
            required_credits: e.required_credits,
            remaining_credits: e.remaining_credits,
            free_plan: e.free_plan,
            scope: e.scope,
          }).message,
          required_credits: e.required_credits,
          remaining_credits: e.remaining_credits,
          free_plan: e.free_plan,
        },
      });
      return;
    }
    if (e instanceof ProvisionBudgetExceeded) {
      res.status(402).json({
        error: { code: "provision_budget_exceeded", message: (e as Error).message },
      });
      return;
    }
    if (e instanceof FleetHalted) {
      res.status(503).json({
        error: { code: "fleet_halted", message: (e as Error).message },
      });
      return;
    }
    if (e instanceof AppFrozen) {
      res.status(423).json({
        error: { code: "app_frozen", message: (e as Error).message },
      });
      return;
    }
    console.error(`[refine-product] tenant=${auth.tenant_id} failed: ${String((e as Error)?.message ?? e).slice(0, 500)}`);
    res.status(500).json({
      error: { code: "refine_product_failed", message: REFINE_FAILED_MESSAGE },
    });
  }
}

export async function postAutopilotUndoNode(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireOwnerOrAdmin(auth, res))) return;

  const run_id = String(req.params.run_id ?? "").trim();
  const node_id = String(req.params.node_id ?? "").trim();

  if (!run_id || run_id.length > 128) {
    res.status(400).json({
      error: { code: "bad_request", message: "run_id is required" },
    });
    return;
  }
  if (!node_id || node_id.length > 256) {
    res.status(400).json({
      error: { code: "bad_request", message: "node_id is required" },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data: ownership, error: ownershipErr } = await supabase
    .from("conductor_runs")
    .select("id")
    .eq("id", run_id)
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle();

  if (ownershipErr) {
    res.status(500).json({
      error: { code: "ownership_query_failed", message: ownershipErr.message },
    });
    return;
  }
  if (!ownership) {
    res.status(404).json({
      error: { code: "conductor_run_not_found", message: "conductor run not found" },
    });
    return;
  }

  const svc = serviceClient();
  const { data, error } = await svc.rpc("undo_dispatched_node", {
    p_tenant_id: auth.tenant_id,
    p_conductor_run_id: run_id,
    p_node_id: node_id,
  });

  if (error) {
    res.status(500).json({
      error: { code: "undo_failed", message: error.message },
    });
    return;
  }

  type UndoResult =
    | { ok: true; ledger_id: string }
    | {
        ok: false;
        reason:
          | "conductor_run_not_found"
          | "node_not_found"
          | "not_dispatched"
          | "no_dispatch_ledger"
          | "window_expired";
        status?: string;
        elapsed_minutes?: number;
        window_minutes?: number;
      };
  const result = (data ?? { ok: false, reason: "node_not_found" }) as UndoResult;

  if (result.ok) {
    res.json({ ok: true, ledger_id: result.ledger_id });
    return;
  }

  switch (result.reason) {
    case "conductor_run_not_found":
      res.status(404).json({
        error: { code: "conductor_run_not_found", message: "conductor run not found" },
      });
      return;
    case "node_not_found":
      res.status(404).json({
        error: { code: "node_not_found", message: `node ${node_id} not found in run` },
      });
      return;
    case "not_dispatched":
      res.status(409).json({
        error: {
          code: "not_dispatched",
          message: `node is in status '${result.status ?? "unknown"}'. Only dispatched nodes can be undone`,
        },
      });
      return;
    case "no_dispatch_ledger":
      res.status(409).json({
        error: {
          code: "no_dispatch_ledger",
          message: "no dispatch ledger row for this node, cannot determine undo window",
        },
      });
      return;
    case "window_expired":
      res.status(410).json({
        error: {
          code: "window_expired",
          message: `undo window expired (elapsed ${result.elapsed_minutes ?? 0}m, window ${result.window_minutes ?? 0}m)`,
          elapsed_minutes: result.elapsed_minutes ?? 0,
          window_minutes: result.window_minutes ?? 0,
        },
      });
      return;
    default:
      res.status(500).json({
        error: { code: "undo_failed", message: "unknown undo result" },
      });
  }
}

const CONTINUE_STATUS: Record<string, number> = {
  not_found: 404,
  not_paused: 409,
  not_resumable: 409,
  budget_spent: 409,
  expired: 410,
  superseded: 409,
  another_build_running: 409,
  changed_concurrently: 409,
  site_setup_failed: 503,
};

export async function postAutopilotContinueRun(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireOwnerOrAdmin(auth, res))) return;
  const run_id = String(req.params.run_id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(run_id)) {
    res.status(400).json({ error: { code: "bad_request", message: "run_id is required" } });
    return;
  }
  try {
    const r = await continueBuild(auth.tenant_id, run_id);
    if (!r.ok && r.code === "old_site_frozen") {
      res.status(OLD_SITE_FROZEN_STATUS).json(oldSiteFrozenBody());
      return;
    }
    if (!r.ok) {
      res.status(CONTINUE_STATUS[r.code] ?? 409).json({
        error: {
          code: r.code,
          message: r.message,
          ...(r.retryable !== undefined ? { retryable: r.retryable } : {}),
          ...(r.reason_code ? { reason_code: r.reason_code } : {}),
        },
      });
      return;
    }
    res.json({ ok: true, run_id: r.run_id });
  } catch (e) {
    res.status(500).json({ error: { code: "continue_failed", message: (e as Error).message } });
  }
}

export async function postAutopilotCancelRun(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const run_id = String(req.params.run_id ?? "").trim();
  if (!run_id || run_id.length > 128) {
    res.status(400).json({
      error: { code: "bad_request", message: "run_id is required" },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data: ownership, error: ownershipErr } = await supabase
    .from("conductor_runs")
    .select("id")
    .eq("id", run_id)
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle();

  if (ownershipErr) {
    res.status(500).json({
      error: { code: "ownership_query_failed", message: ownershipErr.message },
    });
    return;
  }
  if (!ownership) {
    res.status(404).json({
      error: { code: "conductor_run_not_found", message: "conductor run not found" },
    });
    return;
  }

  const svc = serviceClient();
  const { data, error } = await svc.rpc("cancel_conductor_run", {
    p_tenant_id: auth.tenant_id,
    p_conductor_run_id: run_id,
    p_reason: "user_cancel",
  });

  if (error) {
    res.status(500).json({
      error: { code: "cancel_failed", message: error.message },
    });
    return;
  }

  type CancelResult =
    | {
        ok: true;
        cancelled: boolean;
        prior_status?: string;
        ledger_id?: string;
      }
    | { ok: false; reason: "conductor_run_not_found" };
  const result = (data ?? { ok: false, reason: "conductor_run_not_found" }) as CancelResult;

  if (!result.ok) {
    res.status(404).json({
      error: { code: "conductor_run_not_found", message: "conductor run not found" },
    });
    return;
  }

  if (result.cancelled) {
    try {
      const { dropHeldChanges } = await import("@/services/sites/queued-change");
      await dropHeldChanges(auth.tenant_id, run_id);
    } catch (e) {
      await logEvent({
        level: "warn",
        source: "autopilot.cancel",
        code: "held_change_drop_failed",
        tenant_id: auth.tenant_id,
        error: e,
      }).catch(() => undefined);
    }
  }

  res.json({
    ok: true,
    cancelled: result.cancelled,
    prior_status: result.prior_status ?? null,
    ledger_id: result.ledger_id ?? null,
  });
}

const WAIVER_MAX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const WAIVER_MAX_DAILY_USD = 100;

export async function postAutopilotWaiver(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as {
    decision_class?: unknown;
    expires_at?: unknown;
    max_daily_usd?: unknown;
    cooling_off_seconds?: unknown;
  };

  if (typeof body.decision_class !== "string" || body.decision_class.trim() === "") {
    res.status(400).json({
      error: { code: "bad_request", message: "decision_class (string) is required" },
    });
    return;
  }
  const decision_class = body.decision_class.trim();

  if (typeof body.expires_at !== "string" || body.expires_at.trim() === "") {
    res.status(400).json({
      error: { code: "bad_request", message: "expires_at (ISO timestamp string) is required" },
    });
    return;
  }
  const expiresMs = Date.parse(body.expires_at);
  if (!Number.isFinite(expiresMs)) {
    res.status(400).json({
      error: { code: "bad_request", message: "expires_at must be a valid ISO timestamp" },
    });
    return;
  }
  const nowMs = Date.now();
  if (expiresMs <= nowMs) {
    res.status(400).json({
      error: { code: "bad_request", message: "expires_at must be in the future" },
    });
    return;
  }
  if (expiresMs > nowMs + WAIVER_MAX_EXPIRY_MS) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: `expires_at exceeds 7-day ceiling (max ${WAIVER_MAX_EXPIRY_MS / 1000}s from now)`,
      },
    });
    return;
  }

  if (
    typeof body.max_daily_usd !== "number" ||
    !Number.isFinite(body.max_daily_usd) ||
    body.max_daily_usd < 0
  ) {
    res.status(400).json({
      error: { code: "bad_request", message: "max_daily_usd must be a number >= 0" },
    });
    return;
  }
  if (body.max_daily_usd > WAIVER_MAX_DAILY_USD) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: `max_daily_usd exceeds $${WAIVER_MAX_DAILY_USD} ceiling`,
      },
    });
    return;
  }

  let cooling_off_seconds = 0;
  if (body.cooling_off_seconds !== undefined && body.cooling_off_seconds !== null) {
    if (
      typeof body.cooling_off_seconds !== "number" ||
      !Number.isFinite(body.cooling_off_seconds) ||
      !Number.isInteger(body.cooling_off_seconds) ||
      body.cooling_off_seconds < 0
    ) {
      res.status(400).json({
        error: {
          code: "bad_request",
          message: "cooling_off_seconds must be a non-negative integer",
        },
      });
      return;
    }
    cooling_off_seconds = body.cooling_off_seconds;
  }

  const { error } = await serviceClient().rpc("grant_autopilot_waiver", {
    p_tenant_id: auth.tenant_id,
    p_decision_class: decision_class,
    p_expires_at: new Date(expiresMs).toISOString(),
    p_max_daily_usd: body.max_daily_usd,
    p_cooling_off_seconds: cooling_off_seconds,
  });
  if (error) {
    res.status(500).json({
      error: { code: "grant_waiver_failed", message: error.message },
    });
    return;
  }

  res.json({
    ok: true,
    decision_class,
    expires_at: new Date(expiresMs).toISOString(),
    max_daily_usd: body.max_daily_usd,
    cooling_off_seconds,
  });
}

export async function deleteAutopilotWaiver(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const decision_class =
    typeof req.params?.decision_class === "string" ? req.params.decision_class.trim() : "";
  if (!decision_class) {
    res.status(400).json({
      error: { code: "bad_request", message: "decision_class path parameter is required" },
    });
    return;
  }

  const { data, error } = await serviceClient().rpc("revoke_autopilot_waiver", {
    p_tenant_id: auth.tenant_id,
    p_decision_class: decision_class,
  });
  if (error) {
    res.status(500).json({
      error: { code: "revoke_waiver_failed", message: error.message },
    });
    return;
  }
  const obj = (data ?? {}) as { ok?: boolean; had_waiver?: boolean };
  if (!obj.had_waiver) {
    res.status(404).json({
      error: {
        code: "no_active_waiver",
        message: `no active waiver on decision_class "${decision_class}" for this tenant`,
      },
    });
    return;
  }
  res.json({ ok: true, decision_class });
}

export async function getAutopilotWaivers(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("tenant_decision_class_overrides")
    .select("decision_class, waiver_expires_at, waiver_max_daily_usd, waiver_cooling_off_seconds")
    .eq("tenant_id", auth.tenant_id)
    .not("waiver_expires_at", "is", null)
    .gt("waiver_expires_at", nowIso)
    .order("waiver_expires_at", { ascending: true });
  if (error) {
    res.status(500).json({
      error: { code: "list_waivers_failed", message: error.message },
    });
    return;
  }
  type Row = {
    decision_class: string;
    waiver_expires_at: string;
    waiver_max_daily_usd: number | string | null;
    waiver_cooling_off_seconds: number | null;
  };
  const waivers = ((data ?? []) as Row[]).map((r) => ({
    decision_class: r.decision_class,
    expires_at: r.waiver_expires_at,
    max_daily_usd:
      r.waiver_max_daily_usd === null
        ? null
        : typeof r.waiver_max_daily_usd === "string"
          ? Number(r.waiver_max_daily_usd)
          : r.waiver_max_daily_usd,
    cooling_off_seconds: r.waiver_cooling_off_seconds ?? 0,
  }));
  res.json({ waivers });
}

export function chipExcludeLabels(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length <= 40)
    .slice(0, MAX_EXCLUDE);
}

export async function getAutopilotChips(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (process.env.BUILDER_SUGGESTION_CHIPS_ENABLED === "0") {
    res.json({ chips: [] });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id.trim() : "";
  if (!BUILD_SESSION_UUID_RE.test(sessionId)) {
    res.status(400).json({ error: { code: "bad_request", message: "session_id must be a uuid" } });
    return;
  }

  const { data: buildRun, error: buildError } = await supabase
    .from("conductor_runs")
    .select("id, objective, goal_graph, status, created_at")
    .eq("id", sessionId)
    .eq("tenant_id", auth.tenant_id)
    .eq("kind", "build_app")
    .maybeSingle();
  if (buildError) {
    res.status(500).json({ error: { code: "chips_failed", message: buildError.message } });
    return;
  }
  type Node = { payload?: { refine_mode?: boolean; target?: { github_full_name?: unknown; default_branch?: unknown } } | null };
  const buildGraph = (buildRun?.goal_graph as Node[] | null) ?? [];
  const rootNode = buildGraph[0];
  if (!buildRun || rootNode?.payload?.refine_mode === true) {
    res.json({ chips: [] });
    return;
  }

  const { data: refineRows, error: refineError } = await supabase
    .from("conductor_runs")
    .select("id, objective, status, created_at")
    .eq("tenant_id", auth.tenant_id)
    .eq("kind", "build_app")
    .eq("status", "done")
    .eq("goal_graph->0->payload->>parent_conductor_run_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (refineError) {
    res.status(500).json({ error: { code: "chips_failed", message: refineError.message } });
    return;
  }
  const priorRefines = (refineRows ?? [])
    .map((r) => (r.objective as string | null) ?? "")
    .filter((s) => s.length > 0);

  const target = buildGraph.find((node) => node.payload?.target)?.payload?.target;
  const fullName = typeof target?.github_full_name === "string" ? target.github_full_name : "";
  const branch = typeof target?.default_branch === "string" && target.default_branch
    ? target.default_branch
    : "main";
  const token = process.env.GITHUB_PROVISION_TOKEN ?? "";
  const readAppContext = fullName && token
    ? () => readBuiltAppSuggestionContext({ full_name: fullName, branch, token })
    : undefined;

  const newestRunId = refineRows?.[0]?.id as string | undefined;
  const more = req.query.more === "1";
  const exclude = more ? chipExcludeLabels(req.query.exclude) : [];
  let moreCapped = false;
  let chips: Awaited<ReturnType<typeof generateBuildChips>>;
  try {
    chips = await generateBuildChips({
    tenantId: auth.tenant_id,
    turnKey: `${sessionId}:${newestRunId ?? "root"}`,
    objective: buildRun.objective as string | null,
    priorRefines,
    readAppContext,
    ready: buildRun.status === "done",
    exclude,
    allowMore: async () => {
      const ok = await takeMoreSlot(supabase, auth.tenant_id, sessionId);
      moreCapped = !ok;
      return ok;
    },
    });
  } catch (e) {
    console.warn(`[chips] more claim failed for tenant=${auth.tenant_id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    res.status(503).json({ error: { code: "chips_more_unavailable", message: "Couldn't get more suggestions. Try again." } });
    return;
  }
  res.json(more ? { chips, more_capped: moreCapped } : { chips });
}

export async function postAutopilotPlan(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (process.env.BUILDER_PLAN_MODE_ENABLED === "0") {
    res.status(403).json({
      error: { code: "plan_mode_disabled", message: "Plan mode is disabled." },
    });
    return;
  }

  const body = (req.body ?? {}) as { idea?: unknown; mode?: unknown };
  const rawIdea = typeof body.idea === "string" ? body.idea.trim() : "";
  if (rawIdea.length < 8 || rawIdea.length > 4000) {
    res.status(400).json({
      error: { code: "bad_request", message: "idea (8–4000 chars) is required" },
    });
    return;
  }
  const mode = body.mode === "refine" ? "refine" : "build";
  const cleanIdea = xmlEscapeContent(sanitizeFetchedContent(rawIdea));

  let appContext: string | null = null;
  if (mode === "refine" && (body as { build_session_id?: unknown }).build_session_id !== undefined) {
    let app: RequestedApp;
    try {
      app = await resolveAppForRequest(req, serverClientFromBearer(auth.access_token), auth.tenant_id);
    } catch (e) {
      sendAppSelectionError(res, e);
      return;
    }
    const full_name = app.kind === "site" && !isGoneSite(app.site) && typeof app.site.github_full_name === "string" ? app.site.github_full_name : "";
    const token = process.env.GITHUB_PROVISION_TOKEN ?? "";
    if (isSafeRepoName(full_name) && token) {
      appContext = await readBuiltAppSuggestionContext({ full_name, branch: "main", token });
    }
  }

  try {
    const plan = await generateBuildPlan({ idea: cleanIdea, mode, appContext });
    res.json({ plan_markdown: plan });
  } catch {
    res.status(500).json({
      error: { code: "plan_failed", message: "Couldn't generate a plan. Try again." },
    });
  }
}

export async function postAutopilotClarifyQuestions(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (process.env.BUILDER_CLARIFY_QUESTIONS_ENABLED === "0") {
    res.json({ questions: [] });
    return;
  }

  const body = (req.body ?? {}) as { idea?: unknown };
  const rawIdea = typeof body.idea === "string" ? body.idea.trim() : "";
  if (rawIdea.length < 8 || rawIdea.length > 4000) {
    res.status(400).json({
      error: { code: "bad_request", message: "idea (8–4000 chars) is required" },
    });
    return;
  }
  const cleanIdea = xmlEscapeContent(sanitizeFetchedContent(rawIdea));

  try {
    const questions = await generateClarifyQuestions({
      tenantId: auth.tenant_id,
      idea: cleanIdea,
    });
    res.json({ questions });
  } catch {
    res.json({ questions: [] });
  }
}

export async function getAutopilotDeployStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const deploy = await getLatestDeployStatus(auth.tenant_id);
    res.json({ deploy });
  } catch {
    res.json({ deploy: null });
  }
}

export async function getAutopilotRestoreStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const sha = typeof req.query.commit_sha === "string" ? req.query.commit_sha.trim() : "";
  if (!RESTORE_COMMIT_SHA_RE.test(sha)) {
    res.status(400).json({
      error: { code: "bad_request", message: "commit_sha must be a 7-40 character hex commit id" },
    });
    return;
  }
  res.json(await getRestoreStatus(auth.tenant_id, sha));
}

async function requireSiteEditor(auth: AuthedRequest, res: Response): Promise<boolean> {
  try {
    return await requireTenantRole(auth, SITE_EDIT_ROLES, res);
  } catch (e) {
    console.warn(JSON.stringify({ evt: "role_check_failed", tenant_id: auth.tenant_id, error: String((e as Error)?.message ?? e).slice(0, 300) }));
    res.status(500).json({ error: { code: "role_check_failed", message: "We couldn't verify your access. Try again." } });
    return false;
  }
}

async function requireOwnerOrAdmin(auth: AuthedRequest, res: Response): Promise<boolean> {
  try {
    return await requireTenantRole(auth, ["owner", "admin"], res);
  } catch (e) {
    console.warn(JSON.stringify({ evt: "role_check_failed", tenant_id: auth.tenant_id, error: String((e as Error)?.message ?? e).slice(0, 300) }));
    res.status(500).json({ error: { code: "role_check_failed", message: "We couldn't verify your access. Try again." } });
    return false;
  }
}

export async function postAutopilotBuildAdminLink(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireOwnerOrAdmin(auth, res))) return;
  const rawRun = (req.body ?? {}) as { conductor_run_id?: unknown };
  let conductor_run_id: string | null = null;
  if (rawRun.conductor_run_id !== undefined && rawRun.conductor_run_id !== null) {
    const id = typeof rawRun.conductor_run_id === "string" ? rawRun.conductor_run_id.trim() : "";
    if (!BUILD_SESSION_UUID_RE.test(id)) {
      res.status(400).json({ error: { code: "bad_request", message: "conductor_run_id must be a uuid" } });
      return;
    }
    conductor_run_id = id;
  }
  const out = await resendOwnerLoginLink(auth.tenant_id, { conductor_run_id });
  if (out.sent) {
    res.json({ ok: true, email: out.email });
    return;
  }
  if (out.reason === "disabled") {
    res.status(404).json({ error: { code: "not_enabled", message: "Owner login links are not enabled." } });
    return;
  }
  if (out.reason === "cooldown") {
    res.setHeader("Retry-After", String(out.retryAfterS ?? 300));
    res.status(429).json({ error: { code: "too_soon", message: "A login link was sent a few minutes ago. Check your inbox." } });
    return;
  }
  if (out.reason === "send_failed") {
    res.status(502).json({ error: { code: "send_failed", message: "We couldn't send a new login link. Try again in a few minutes." } });
    return;
  }
  res.status(409).json({ error: { code: out.reason, message: "This site can't get an admin login link." } });
}

export async function postAutopilotRestoreCheckpoint(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireOwnerOrAdmin(auth, res))) return;
  if (!(await isProductBuilderEnabled())) {
    res.status(403).json({ error: { code: "product_builder_disabled", message: "Product builder is not enabled." } });
    return;
  }
  const raw = (req.body ?? {}) as { conductor_run_id?: unknown };
  const id = typeof raw.conductor_run_id === "string" ? raw.conductor_run_id.trim() : "";
  if (!id || id.length > 128) {
    res.status(400).json({ error: { code: "bad_request", message: "conductor_run_id is required" } });
    return;
  }
  try {
    const result = await refineRestore({ tenant_id: auth.tenant_id, conductor_run_id: id });
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof OldSiteFrozen) {
      res.status(OLD_SITE_FROZEN_STATUS).json(oldSiteFrozenBody());
      return;
    }
    if (e instanceof ChangeAwaitingApproval) {
      res.status(409).json({ error: { code: "awaiting_approval", message: (e as Error).message } });
      return;
    }
    if (e instanceof NothingToRestore) {
      res.status(409).json({ error: { code: "nothing_to_restore", message: (e as Error).message } });
      return;
    }
    if (e instanceof DraftNotPublished) {
      res.status(409).json({ error: { code: "draft_not_published", message: (e as Error).message } });
      return;
    }
    if (e instanceof NoUndoableRefine) {
      res.status(404).json({ error: { code: "no_undoable_refine", message: (e as Error).message } });
      return;
    }
    if (e instanceof NotProvisioned) {
      res.status(409).json({ error: { code: "not_provisioned", message: (e as Error).message } });
      return;
    }
    res.status(500).json({ error: { code: "restore_failed", message: (e as Error).message } });
  }
}

export async function postAutopilotVersionPreview(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  if (!(await isProductBuilderEnabled())) {
    res.status(403).json({ error: { code: "product_builder_disabled", message: "Product builder is not enabled." } });
    return;
  }
  const raw = (req.body ?? {}) as { conductor_run_id?: unknown; prewarm?: unknown };
  const id = typeof raw.conductor_run_id === "string" ? raw.conductor_run_id.trim() : "";
  if (!id || id.length > 128) {
    res.status(400).json({ error: { code: "bad_request", message: "conductor_run_id is required" } });
    return;
  }
  if (raw.prewarm === true) {
    const warm = await siteVersionPreview(auth.tenant_id, id, undefined, { prewarm: true });
    const status =
      warm.kind === "live" ? "live" : warm.kind === "starting" ? "starting" : warm.kind === "not_site" || warm.error === PREWARM_SKIPPED ? "skipped" : "dead";
    res.status(warm.kind === "starting" ? 202 : 200).json({ status });
    return;
  }
  const site = await siteVersionPreview(auth.tenant_id, id);
  if (site.kind === "live") {
    res.json({ status: "live", url: site.url, expires_at: site.expires_at, error: null });
    return;
  }
  if (site.kind === "starting") {
    res.status(202).json({ status: "starting", url: null, error: null });
    return;
  }
  if (site.kind === "unavailable") {
    res.json({ status: "dead", url: null, error: site.error, retryable: siteVersionErrorRetryable(site.error) });
    return;
  }
  const job = startVersionPreview({ tenant_id: auth.tenant_id, conductor_run_id: id });
  res.status(202).json(job);
}

export async function getAutopilotVersionPreview(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await isProductBuilderEnabled())) {
    res.status(403).json({ error: { code: "product_builder_disabled", message: "Product builder is not enabled." } });
    return;
  }
  const rawId = req.query.conductor_run_id;
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (!id || id.length > 128) {
    res.status(400).json({ error: { code: "bad_request", message: "conductor_run_id is required" } });
    return;
  }
  const siteJob = await siteVersionJob(auth.tenant_id, id);
  if (siteJob) {
    res.json(siteJob);
    return;
  }
  const job = await getVersionPreview({ tenant_id: auth.tenant_id, conductor_run_id: id });
  res.json(job ?? { status: "none" });
}

export async function postAutopilotRefineUndo(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireSiteEditor(auth, res))) return;
  const guarded = await editUndoShown(auth.tenant_id);

  if (!(await isProductBuilderEnabled())) {
    res.status(403).json({
      error: { code: "product_builder_disabled", message: "Product builder is not enabled." },
    });
    return;
  }

  const body = (req.body ?? {}) as {
    conductor_run_id?: unknown;
    app_id?: unknown;
    app?: unknown;
  };
  if (body.app !== undefined && body.app !== null && body.app !== "workspace") {
    res.status(400).json({ error: { code: "bad_request", message: "app must be 'workspace'" } });
    return;
  }
  const workspaceOnly = body.app === "workspace";

  let conductor_run_id: string | null = null;
  if (body.conductor_run_id !== undefined && body.conductor_run_id !== null) {
    if (typeof body.conductor_run_id !== "string") {
      res.status(400).json({
        error: { code: "bad_request", message: "conductor_run_id must be a string" },
      });
      return;
    }
    const id = body.conductor_run_id.trim();
    if (id.length === 0 || id.length > 128) {
      res.status(400).json({
        error: { code: "bad_request", message: "conductor_run_id length 1–128 required" },
      });
      return;
    }
    conductor_run_id = id;
  }

  try {
    const result = await refineUndo({
      tenant_id: auth.tenant_id,
      conductor_run_id,
      guarded,
      ...(workspaceOnly ? { workspace_only: true } : {}),
    });
    res.json({
      ok: true,
      undo_conductor_run_id: result.undo_conductor_run_id,
      reverted_conductor_run_id: result.reverted_conductor_run_id,
      reverted_commit_sha: result.reverted_commit_sha,
      new_commit_sha: result.new_commit_sha,
      branch: result.branch,
      ...(guarded || typeof result.republished === "boolean"
        ? {
            republished: result.republished === true,
            republish_pending: result.republish_pending === true,
            history_recorded: result.history_recorded === true,
            draft_reset: result.draft_reset === true,
          }
        : {}),
      ...(result.preview_only === true ? { preview_only: true as const } : {}),
      ...(result.preview_stale === true ? { preview_stale: true as const } : {}),
    });
  } catch (e) {
    if (e instanceof OldSiteFrozen) {
      res.status(OLD_SITE_FROZEN_STATUS).json(oldSiteFrozenBody());
      return;
    }
    if (e instanceof UndoBlocked) {
      res.status(409).json({ error: { code: e.reason, message: e.message } });
      return;
    }
    if (e instanceof UndoCommitNotFound) {
      res.status(409).json({ error: { code: "undo_commit_not_found", message: e.message } });
      return;
    }
    if (e instanceof DraftNotPublished) {
      res.status(409).json({ error: { code: "draft_not_published", message: (e as Error).message } });
      return;
    }
    if (e instanceof NoUndoableRefine) {
      res.status(404).json({
        error: { code: "no_undoable_refine", message: (e as Error).message },
      });
      return;
    }
    if (e instanceof NotProvisioned) {
      res.status(409).json({
        error: { code: "not_provisioned", message: (e as Error).message },
      });
      return;
    }
    res.status(500).json({
      error: { code: "refine_undo_failed", message: (e as Error).message },
    });
  }
}

type GoalRow = {
  id: string;
  objective: string;
  target_metric: string;
  target_value: number | string;
  baseline_value: number | string | null;
  current_value: number | string | null;
  due_date: string | null;
  status: string;
  priority: number;
  source: string;
  created_at: string;
  updated_at: string;
  measurement_mode: string | null;
  current_value_at: string | null;
  count_rule: unknown;
  value_kind: string | null;
  value_period_start: string | null;
};

export async function getAutopilotGoals(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .from("autopilot_goals")
    .select(
      "id, objective, target_metric, target_value, baseline_value, current_value, due_date, status, priority, source, created_at, updated_at, measurement_mode, current_value_at, count_rule, value_kind, value_period_start",
    )
    .eq("tenant_id", auth.tenant_id)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    res.status(500).json({
      error: { code: "goals_list_failed", message: error.message },
    });
    return;
  }

  const goals = ((data ?? []) as GoalRow[]).map((g) => ({
    measurement_mode: g.measurement_mode ?? null,
    id: g.id,
    objective: decodeXmlEntities(g.objective),
    target_metric: decodeXmlEntities(g.target_metric),
    target_value: Number(g.target_value),
    baseline_value: g.baseline_value === null ? null : Number(g.baseline_value),
    current_value: g.current_value === null ? null : Number(g.current_value),
    due_date: g.due_date,
    status: g.status,
    priority: g.priority,
    source: g.source,
    created_at: g.created_at,
    updated_at: g.updated_at,
    value_kind: g.value_kind ?? null,
    value_period_start: g.value_period_start ?? null,
    trajectory: goalTrajectoryView({
      id: g.id,
      target_metric: g.target_metric,
      target_value: Number(g.target_value),
      baseline_value: g.baseline_value === null ? null : Number(g.baseline_value),
      current_value: g.current_value === null ? null : Number(g.current_value),
      current_value_at: g.current_value_at,
      due_date: g.due_date,
      measurement_mode: g.measurement_mode,
      created_at: g.created_at,
      count_rule: g.count_rule,
      value_kind: g.value_kind,
      value_period_start: g.value_period_start,
    }),
  }));

  res.json({ enabled: true, goals });
}

type FieldOk<T> = { ok: true; value: T };
type FieldErr = { ok: false; code: string; message: string };
type FieldResult<T> = FieldOk<T> | FieldErr;

function validateObjective(raw: unknown): FieldResult<string> {
  const s = typeof raw === "string" ? decodeXmlEntities(raw.trim()) : "";
  if (s.length < 4 || s.length > 500) {
    return { ok: false, code: "bad_request", message: "objective (4–500 chars) is required" };
  }
  const clean = xmlEscapeContent(sanitizeFetchedContent(s));
  if (clean.trim().length === 0) {
    return { ok: false, code: "bad_request", message: "objective cannot be empty after sanitization" };
  }
  return { ok: true, value: clean };
}

function validateTargetMetric(raw: unknown): FieldResult<string> {
  const s = typeof raw === "string" ? decodeXmlEntities(raw.trim()) : "";
  if (s.length < 1 || s.length > 120) {
    return { ok: false, code: "bad_request", message: "target_metric (1–120 chars) is required" };
  }
  const clean = xmlEscapeContent(sanitizeFetchedContent(s));
  if (clean.trim().length === 0) {
    return { ok: false, code: "bad_request", message: "target_metric cannot be empty after sanitization" };
  }
  return { ok: true, value: clean };
}

function validateTargetValue(raw: unknown): FieldResult<number> {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, code: "bad_request", message: "target_value must be a finite number" };
  }
  return { ok: true, value: raw };
}

function validateBaseline(raw: unknown): FieldResult<number | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, code: "bad_request", message: "baseline_value must be a finite number" };
  }
  return { ok: true, value: raw };
}

function validateCurrentValue(raw: unknown): FieldResult<number | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, code: "bad_request", message: "current_value must be a finite number" };
  }
  return { ok: true, value: raw };
}

function validateDueDate(raw: unknown): FieldResult<string | null> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { ok: false, code: "bad_request", message: "due_date must be a YYYY-MM-DD date string" };
  }
  if (!Number.isFinite(Date.parse(raw))) {
    return { ok: false, code: "bad_request", message: "due_date is not a valid date" };
  }
  return { ok: true, value: raw };
}

function validatePriority(raw: unknown): FieldResult<number | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 100) {
    return { ok: false, code: "bad_request", message: "priority must be an integer 0–100" };
  }
  return { ok: true, value: raw };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { MAX_ACTIVE_GOALS };

async function countActiveGoals(
  tenantId: string,
): Promise<{ count: number } | { error: string }> {
  const { data, error } = await serviceClient()
    .from("autopilot_goals")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active");
  if (error) return { error: error.message };
  return { count: (data as unknown[] | null)?.length ?? 0 };
}

async function findActiveGoalLike(
  tenantId: string,
  objective: string,
  targetMetric: string,
  exact?: { target_value: number; due_date: string | null },
): Promise<{ id: string | null } | { error: string }> {
  let query = serviceClient()
    .from("autopilot_goals")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .eq("objective", objective)
    .eq("target_metric", targetMetric);
  if (exact) {
    query = query.eq("target_value", exact.target_value);
    query = exact.due_date === null ? query.is("due_date", null) : query.eq("due_date", exact.due_date);
  }
  const { data, error } = await query.limit(1);
  if (error) return { error: error.message };
  const rows = (data as { id: string }[] | null) ?? [];
  return { id: rows.length > 0 ? rows[0].id : null };
}

export async function commitGrowthPlanServiceRole(input: {
  tenant_id: string;
  objective: string;
  north_star_metric: string;
  constraint_statement: string;
  constraint_confidence: string;
  bets: Array<{
    channel_slug: string;
    intent: string;
    rationale?: string;
    expected_effect: string;
    falsifier: string;
    autorun: boolean;
  }>;
  basis_evidence?: Array<{ kind: string; source: string; statement: string }>;
}): Promise<{ ok: true; plan_id: string } | { ok: false; message: string }> {
  try {
    const { data, error } = await serviceClient().rpc("commit_growth_plan", {
      p_tenant_id: input.tenant_id,
      p_objective: input.objective,
      p_target_metric: input.north_star_metric,
      p_constraint_statement: input.constraint_statement,
      p_constraint_confidence: input.constraint_confidence,
      p_bets: input.bets,
      p_basis_evidence: input.basis_evidence ?? [],
      p_actor_kind: "agent",
      p_actor_ref: "cgo",
    } as never);
    if (error) return { ok: false, message: error.message };
    const planId = typeof data === "string" ? data : null;
    if (!planId) return { ok: false, message: "the plan did not commit" };
    await clearCgoPauseReasons(input.tenant_id);
    const { clearPlanConstraintMarks } = await import("@/services/growth/cgo-hypotheses");
    await clearPlanConstraintMarks(input.tenant_id);
    return { ok: true, plan_id: planId };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

function founderGoalValues(g: {
  objective: string;
  target_metric: string;
  target_value: number;
  baseline_value: number | null;
  due_date: string | null;
  priority: number | null;
}): Record<string, unknown> {
  return {
    objective: g.objective,
    target_metric: g.target_metric,
    target_value: g.target_value,
    baseline_value: g.baseline_value,
    current_value: g.baseline_value,
    due_date: g.due_date,
    priority: g.priority ?? 50,
    source: "founder",
  };
}

export async function createFounderGoalServiceRole(input: {
  tenant_id: string;
  objective: string;
  target_metric: string;
  humanMetric: string;
  target_value: number;
  baseline_value: number | null;
  due_date: string | null;
  priority: number | null;
  measurementMode?: "auto" | "manual_reported";
  actor: GoalActor;
}): Promise<
  | { ok: true; id: string; warning?: string }
  | { ok: false; status: number; code: string; message: string }
> {
  const duplicate = await findActiveGoalLike(
    input.tenant_id,
    input.objective,
    input.target_metric,
  );
  if ("error" in duplicate) {
    return { ok: false, status: 500, code: "goal_count_failed", message: duplicate.error };
  }
  if (duplicate.id) {
    return { ok: true, id: duplicate.id };
  }

  const active = await countActiveGoals(input.tenant_id);
  if ("error" in active) {
    return { ok: false, status: 500, code: "goal_count_failed", message: active.error };
  }
  if (active.count >= MAX_ACTIVE_GOALS) {
    return {
      ok: false,
      status: 409,
      code: "goal_limit_reached",
      message: `You can have at most ${MAX_ACTIVE_GOALS} active goals. Pause or delete one first.`,
    };
  }
  const created = await writeAutopilotGoal(input.tenant_id, {
    op: "insert",
    values: founderGoalValues(input),
    actor: input.actor,
  });
  if (created.status === "error") {
    return { ok: false, status: 500, code: "set_goal_failed", message: created.error };
  }
  if (created.status !== "written") {
    return { ok: false, status: 500, code: "set_goal_failed", message: "no goal id returned" };
  }
  const goalId = created.id;
  if (input.measurementMode) {
    const failure = await writeCreatedGoalMeasurement(
      input.tenant_id,
      goalId,
      { measurement_mode: input.measurementMode },
      input.actor,
    );
    if (failure) {
      console.warn(`[autopilot-goals] home create mode write failed for ${goalId}: ${failure}`);
      await sendGoalAttention({ tenant_id: input.tenant_id, reason: "goal_set", goal_id: goalId });
      return { ok: true, id: goalId, warning: "The goal was saved, but how it is measured was not." };
    }
  } else {
    await setGoalMeasurementMode(input.tenant_id, goalId, input.humanMetric, input.actor);
  }
  await sendGoalAttention({ tenant_id: input.tenant_id, reason: "goal_set", goal_id: goalId });
  return { ok: true, id: goalId };
}

export async function postAutopilotGoals(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const body = (req.body ?? {}) as Record<string, unknown>;

  const vObjective = validateObjective(body.objective);
  if (!vObjective.ok) {
    res.status(400).json({ error: { code: vObjective.code, message: vObjective.message } });
    return;
  }
  const cleanObjective = vObjective.value;

  const vMetric = validateTargetMetric(body.target_metric);
  if (!vMetric.ok) {
    res.status(400).json({ error: { code: vMetric.code, message: vMetric.message } });
    return;
  }
  const cleanMetric = vMetric.value;

  const vTarget = validateTargetValue(body.target_value);
  if (!vTarget.ok) {
    res.status(400).json({ error: { code: vTarget.code, message: vTarget.message } });
    return;
  }
  const target_value = vTarget.value;

  const vBaseline = validateBaseline(body.baseline_value);
  if (!vBaseline.ok) {
    res.status(400).json({ error: { code: vBaseline.code, message: vBaseline.message } });
    return;
  }
  const baseline_value = vBaseline.value;

  const vDue = validateDueDate(body.due_date);
  if (!vDue.ok) {
    res.status(400).json({ error: { code: vDue.code, message: vDue.message } });
    return;
  }
  const due_date = vDue.value;

  const vPriority = validatePriority(body.priority);
  if (!vPriority.ok) {
    res.status(400).json({ error: { code: vPriority.code, message: vPriority.message } });
    return;
  }
  const priority = vPriority.value;

  const humanObjective = decodeXmlEntities(String(body.objective).trim());
  const humanMetric = decodeXmlEntities(String(body.target_metric).trim());
  const junkReason = detectGoalJunk({
    objective: humanObjective,
    target_metric: humanMetric,
    target_value,
  });
  if (junkReason) {
    res.status(400).json({ error: { code: "goal_invalid", message: junkReason } });
    return;
  }

  const vCurrent = validateCurrentValue(body.current_value);
  if (!vCurrent.ok) {
    res.status(400).json({ error: { code: vCurrent.code, message: vCurrent.message } });
    return;
  }
  const current_value = vCurrent.value;

  const vMode = validateMeasurementMode(body.measurement_mode, humanMetric);
  if (!vMode.ok) {
    res.status(400).json({ error: { code: vMode.code, message: vMode.message } });
    return;
  }
  const measurement_mode = vMode.value ?? "manual_reported";

  const value_kind = body.value_kind == null ? null : String(body.value_kind);
  const value_period_start = body.value_period_start == null ? null : String(body.value_period_start);
  {
    const metricKey = classifyGoalMetricKey(humanMetric);
    const refusal = valueKindRefusal({
      value_kind,
      value_period_start,
      target_value,
      baseline_value,
      measurement_mode,
      due_date,
      direction: metricKey ? (METRIC_REGISTRY[metricKey]?.direction ?? null) : null,
      target_metric: humanMetric,
    });
    if (refusal) {
      res.status(400).json({ error: { code: "invalid_value_kind", message: refusal } });
      return;
    }
  }

  const duplicate = await findActiveGoalLike(auth.tenant_id, cleanObjective, cleanMetric, {
    target_value,
    due_date,
  });
  if ("error" in duplicate) {
    res.status(500).json({ error: { code: "goal_count_failed", message: duplicate.error } });
    return;
  }
  if (duplicate.id) {
    if (value_kind) {
      const { data: existing, error: readErr } = await serviceClient()
        .from("autopilot_goals")
        .select("measurement_mode")
        .eq("tenant_id", auth.tenant_id)
        .eq("id", duplicate.id)
        .maybeSingle<{ measurement_mode: string | null }>();
      if (readErr) {
        res.status(500).json({ error: { code: "goal_read_failed", message: readErr.message } });
        return;
      }
      if (!existing || existing.measurement_mode === "auto") {
        res.json({ ok: true, id: duplicate.id, duplicate: true, warnings: ["This goal is measured by a connected source, which counts its own way, so how its number counts was not changed."] });
        return;
      }
      const w = await writeAutopilotGoal(auth.tenant_id, {
        op: "update",
        goal_id: duplicate.id,
        values: { value_kind, value_period_start, updated_at: new Date().toISOString() },
        expect: { status: "active", value_kind: null, measurement_mode: existing.measurement_mode },
        actor: { source: "founder", user_id: auth.user_id },
      });
      if (w.status === "error") {
        res.status(500).json({ error: { code: "goal_update_failed", message: w.error } });
        return;
      }
      if (w.status === "not_matched") {
        res.json({ ok: true, id: duplicate.id, duplicate: true, warnings: ["This goal already says how its number counts, so that choice was not changed. Edit the goal to change it."] });
        return;
      }
    }
    res.json({ ok: true, id: duplicate.id, duplicate: true });
    return;
  }

  const active = await countActiveGoals(auth.tenant_id);
  if ("error" in active) {
    res.status(500).json({ error: { code: "goal_count_failed", message: active.error } });
    return;
  }
  if (active.count >= MAX_ACTIVE_GOALS) {
    res.status(409).json({
      error: {
        code: "goal_limit_reached",
        message: `You can have at most ${MAX_ACTIVE_GOALS} active goals. Pause or delete one first.`,
      },
    });
    return;
  }

  const created = await writeAutopilotGoal(auth.tenant_id, {
    op: "insert",
    values: {
      ...founderGoalValues({ objective: cleanObjective, target_metric: cleanMetric, target_value, baseline_value, due_date, priority }),
      ...(value_kind ? { value_kind, value_period_start, ...(value_kind === "period_total" ? { current_value: current_value ?? null } : {}) } : {}),
    },
    actor: { source: "founder", user_id: auth.user_id },
  });
  if (created.status !== "written") {
    res.status(500).json({
      error: { code: "set_goal_failed", message: created.status === "error" ? created.error : "no goal id returned" },
    });
    return;
  }
  const goalId: string = created.id;

  const warnings: string[] = [];
  if (typeof goalId === "string") {
    const failure = await writeCreatedGoalMeasurement(
      auth.tenant_id,
      goalId,
      {
        measurement_mode,
        ...(current_value !== null ? { current_value } : {}),
        ...(current_value !== null && measurement_mode !== "auto"
          ? { current_value_at: new Date().toISOString(), current_value_source: FOUNDER_ENTERED_SOURCE }
          : {}),
      },
      { source: "founder", user_id: auth.user_id },
    );
    if (failure) {
      console.warn(`[autopilot-goals] create measurement write failed for ${goalId}: ${failure}`);
      warnings.push(
        current_value !== null
          ? "The goal was saved, but its current value was not. Add it again from Edit."
          : "The goal was saved, but how it is measured was not.",
      );
    } else if (current_value !== null && measurement_mode === "manual_reported") {
      const now = new Date().toISOString();
      void recordMetricSnapshot({
        tenant_id: auth.tenant_id,
        metric_key: `goal:${goalId}`,
        value: current_value,
        status: "measured",
        source: "founder_reported",
        window_kind: "point",
        window_end: now,
        meta: { actor_user_id: auth.user_id },
      });
    }
  }

  await sendGoalAttention({ tenant_id: auth.tenant_id, reason: "goal_set", goal_id: goalId });
  res.json({ ok: true, id: goalId, ...(warnings.length > 0 ? { warnings } : {}) });
}

const MONEY_SOURCES: ReadonlySet<string> = new Set(["booking_value", "stripe_gross_revenue"]);

const PATCH_EDITABLE_KEYS = new Set([
  "objective",
  "target_metric",
  "target_value",
  "baseline_value",
  "current_value",
  "due_date",
  "priority",
  "status",
  "measurement_mode",
  "measure_source",
  "value_kind",
  "value_period_start",
]);

export async function patchAutopilotGoal(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const id = req.params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    res.status(400).json({ error: { code: "bad_request", message: "invalid goal id" } });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  const presentKeys = Object.keys(body);
  const forbidden = presentKeys.filter((k) => !PATCH_EDITABLE_KEYS.has(k));
  if (forbidden.length > 0) {
    res.status(400).json({
      error: {
        code: "invalid_goal_patch",
        message: `unknown or immutable field(s): ${forbidden.join(", ")}`,
      },
    });
    return;
  }
  const editablePresent = presentKeys.filter((k) => PATCH_EDITABLE_KEYS.has(k));
  if (editablePresent.length === 0) {
    res.status(400).json({
      error: { code: "empty_patch", message: "no editable fields supplied" },
    });
    return;
  }

  const patch: Record<string, unknown> = {};
  let reportedValue: number | null | undefined = undefined;

  if ("objective" in body) {
    const v = validateObjective(body.objective);
    if (!v.ok) { res.status(400).json({ error: { code: v.code, message: v.message } }); return; }
    patch.objective = v.value;
  }
  if ("target_metric" in body) {
    const v = validateTargetMetric(body.target_metric);
    if (!v.ok) { res.status(400).json({ error: { code: v.code, message: v.message } }); return; }
    patch.target_metric = v.value;
  }
  if ("target_value" in body) {
    const v = validateTargetValue(body.target_value);
    if (!v.ok) { res.status(400).json({ error: { code: v.code, message: v.message } }); return; }
    patch.target_value = v.value;
  }
  if ("baseline_value" in body) {
    const v = validateBaseline(body.baseline_value);
    if (!v.ok) { res.status(400).json({ error: { code: v.code, message: v.message } }); return; }
    patch.baseline_value = v.value;
  }
  if ("current_value" in body) {
    const v = validateCurrentValue(body.current_value);
    if (!v.ok) { res.status(400).json({ error: { code: v.code, message: v.message } }); return; }
    patch.current_value = v.value;
    reportedValue = v.value;
  }
  if ("due_date" in body) {
    const v = validateDueDate(body.due_date);
    if (!v.ok) { res.status(400).json({ error: { code: v.code, message: v.message } }); return; }
    patch.due_date = v.value;
  }
  if ("priority" in body) {
    if (body.priority === null) {
      res.status(400).json({ error: { code: "bad_request", message: "priority cannot be null" } });
      return;
    }
    const v = validatePriority(body.priority);
    if (!v.ok) { res.status(400).json({ error: { code: v.code, message: v.message } }); return; }
    patch.priority = v.value;
  }
  if ("status" in body) {
    const s = body.status;
    if (s !== "active" && s !== "paused") {
      res.status(400).json({
        error: { code: "bad_request", message: "status must be 'active' or 'paused'" },
      });
      return;
    }
    patch.status = s;
  }

  const junkReason = detectGoalJunk({
    objective:
      "objective" in body ? decodeXmlEntities(String(body.objective).trim()) : undefined,
    target_metric:
      "target_metric" in body ? decodeXmlEntities(String(body.target_metric).trim()) : undefined,
    target_value: "target_value" in body ? (patch.target_value as number) : undefined,
  });
  if (junkReason) {
    res.status(400).json({ error: { code: "goal_invalid", message: junkReason } });
    return;
  }
  const svc = serviceClient();

  const { data: existing, error: readErr } = await svc
    .from("autopilot_goals")
    .select("status, objective, target_metric, target_value, due_date, baseline_value, current_value, current_value_at, measurement_mode, value_kind, value_period_start")
    .eq("tenant_id", auth.tenant_id)
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    res.status(500).json({ error: { code: "goal_read_failed", message: readErr.message } });
    return;
  }
  if (!existing) {
    res.status(404).json({ error: { code: "goal_not_found", message: "no such goal" } });
    return;
  }
  const row = existing as {
    status: string;
    objective?: string | null;
    target_metric: string | null;
    target_value?: number | string | null;
    due_date?: string | null;
    baseline_value?: number | string | null;
    current_value?: number | string | null;
    current_value_at?: string | null;
    measurement_mode: string | null;
    value_kind?: string | null;
    value_period_start?: string | null;
  };
  const currentStatus = row.status;

  const metricAfter = decodeXmlEntities(
    "target_metric" in body ? String(body.target_metric).trim() : String(row.target_metric ?? ""),
  );
  const sameSpacing = (v: string) => decodeXmlEntities(v).replace(/\s+/g, " ").trim();
  const metricChanged =
    typeof patch.target_metric === "string" && sameSpacing(patch.target_metric) !== sameSpacing(String(row.target_metric ?? ""));
  if ("measurement_mode" in body) {
    const v = validateMeasurementMode(body.measurement_mode, metricAfter);
    if (!v.ok) { res.status(400).json({ error: { code: v.code, message: v.message } }); return; }
    if (v.value) patch.measurement_mode = v.value;
  } else if (metricChanged) {
    patch.measurement_mode = "manual_reported";
  }
  if ("measure_source" in body) {
    const ms = body.measure_source;
    if (ms !== null && !MONEY_SOURCES.has(String(ms))) {
      res.status(400).json({ error: { code: "invalid_measure_source", message: "measure_source must be booking_value, stripe_gross_revenue or null" } });
      return;
    }
    if (ms !== null && classifyTargetMetric(metricAfter).kind !== "booking_value") {
      res.status(400).json({ error: { code: "invalid_measure_source", message: "only a money goal (GMV, booked value) picks a source" } });
      return;
    }
    patch.measure_source = ms;
  } else if (metricChanged || patch.measurement_mode === "manual_reported") {
    patch.measure_source = null;
  }
  if (currentStatus === "met" || currentStatus === "missed") {
    res.status(409).json({
      error: { code: "goal_terminal", message: "a completed goal cannot be edited" },
    });
    return;
  }
  if (patch.status === "active" && currentStatus !== "active") {
    const active = await countActiveGoals(auth.tenant_id);
    if ("error" in active) {
      res.status(500).json({ error: { code: "goal_count_failed", message: active.error } });
      return;
    }
    if (active.count >= MAX_ACTIVE_GOALS) {
      res.status(409).json({
        error: {
          code: "goal_limit_reached",
          message: `You can have at most ${MAX_ACTIVE_GOALS} active goals. Pause or delete one first.`,
        },
      });
      return;
    }
  }

  if (metricChanged) {
    const isNew = (key: "current_value" | "baseline_value"): boolean =>
      patch[key] != null && (row[key] == null || Number(patch[key]) !== Number(row[key]));
    if (!isNew("current_value")) {
      patch.current_value = null;
      patch.current_value_at = null;
      patch.current_value_source = null;
      reportedValue = undefined;
    }
    if (!isNew("baseline_value")) patch.baseline_value = null;
    patch.count_rule = null;
    const sentKind = "value_kind" in body ? (body.value_kind == null || body.value_kind === "" ? null : String(body.value_kind)) : undefined;
    const sentStart = "value_period_start" in body ? (body.value_period_start == null || body.value_period_start === "" ? null : String(body.value_period_start)) : undefined;
    const changedNow =
      sentKind !== undefined &&
      (sentKind !== (row.value_kind ?? null) || (sentKind === "period_total" && (sentStart ?? null) !== (row.value_period_start ?? null)));
    if (!changedNow) {
      patch.value_kind = null;
      patch.value_period_start = null;
      delete body.value_kind;
      delete body.value_period_start;
    }
  }

  {
    const after = <T,>(k: string, stored: T): T => (k in patch ? (patch[k] as T) : stored);
    const autoNow = after<string | null>("measurement_mode", row.measurement_mode) === "auto";
    const sent = (k: "value_kind" | "value_period_start", stored: string | null) =>
      k in body ? (body[k] == null || body[k] === "" ? null : String(body[k])) : after<string | null>(k, stored);
    const kind = autoNow && !("value_kind" in body) ? null : sent("value_kind", row.value_kind ?? null);
    if (autoNow && !("value_kind" in body) && row.value_kind != null) {
      patch.value_kind = null;
      patch.value_period_start = null;
    }
    let start = kind === "period_total" ? sent("value_period_start", row.value_period_start ?? null) : null;
    if ("value_kind" in body || "value_period_start" in body) {
      patch.value_kind = kind;
      patch.value_period_start = start;
    }
    const dueAfter = after<string | null>("due_date", row.due_date ?? null);
    const newStartSent = "value_period_start" in body && (start ?? null) !== (row.value_period_start ?? null);
    if (kind === "period_total" && dueAfter !== (row.due_date ?? null) && !newStartSent) {
      const rolled = rolledPeriodStart({ value_kind: kind, value_period_start: start, due_date: row.due_date ?? null }, dueAfter);
      if (rolled) {
        start = rolled;
        patch.value_kind = kind;
        patch.value_period_start = rolled;
        const typedNew = "current_value" in patch && patch.current_value != null && Number(patch.current_value) !== Number(row.current_value);
        const readOn = enteredDay(row.current_value_at ?? null, await goalTimeZone(auth.tenant_id));
        if (!typedNew && (readOn == null || readOn < rolled)) {
          patch.current_value = null;
          patch.current_value_at = null;
          patch.current_value_source = null;
          reportedValue = undefined;
        }
      }
    }
    if ("value_period_start" in body && body.value_period_start != null && kind !== "period_total") {
      res.status(400).json({ error: { code: "invalid_value_kind", message: "value_period_start is only for period_total" } });
      return;
    }
    const numOrNull = (v: unknown) => (v == null || v === "" ? null : Number(v));
    const metricKey = classifyGoalMetricKey(metricAfter);
    const refusal = valueKindRefusal({
      value_kind: kind,
      value_period_start: start,
      target_value: numOrNull(after("target_value", row.target_value ?? null)),
      baseline_value: numOrNull(after("baseline_value", row.baseline_value ?? null)),
      measurement_mode: after<string | null>("measurement_mode", row.measurement_mode),
      due_date: after<string | null>("due_date", row.due_date ?? null),
      direction: metricKey ? (METRIC_REGISTRY[metricKey]?.direction ?? null) : null,
      target_metric: metricAfter,
    });
    if (refusal) {
      res.status(400).json({ error: { code: "invalid_value_kind", message: refusal } });
      return;
    }
  }

  patch.updated_at = new Date().toISOString();
  if (reportedValue != null && ((patch.measurement_mode as string | undefined) ?? row.measurement_mode) !== "auto") {
    patch.current_value_at = patch.updated_at;
    patch.current_value_source = FOUNDER_ENTERED_SOURCE;
  }
  const updated = await writeAutopilotGoal(auth.tenant_id, {
    op: "update",
    goal_id: id,
    values: patch,
    status_not_in: ["met", "missed"],
    actor: { source: "founder", user_id: auth.user_id },
  });
  if (updated.status === "error") {
    res.status(500).json({ error: { code: "goal_update_failed", message: updated.error } });
    return;
  }
  if (updated.status === "not_matched") {
    res.status(404).json({ error: { code: "goal_not_found", message: "no such goal" } });
    return;
  }

  const modeAfter = (patch.measurement_mode as string | undefined) ?? row.measurement_mode;
  if (reportedValue !== undefined && reportedValue !== null && modeAfter !== "auto") {
    const now = new Date().toISOString();
    void recordMetricSnapshot({
      tenant_id: auth.tenant_id,
      metric_key: `goal:${id}`,
      value: reportedValue,
      status: "measured",
      source: "founder_reported",
      window_kind: "point",
      window_end: now,
      meta: { actor_user_id: auth.user_id },
    });
  }

  const askOf = (r: Record<string, unknown>) => ({
    objective: String(r.objective ?? ""),
    target_metric: String(r.target_metric ?? ""),
    target_value: r.target_value == null ? null : Number(r.target_value),
    due_date: r.due_date == null ? null : String(r.due_date),
  });
  const askChanged = goalRev(askOf(row)) !== goalRev(askOf({ ...row, ...patch }));
  const statusChanged = patch.status !== undefined && patch.status !== currentStatus;
  if (askChanged || statusChanged) await sendGoalAttention({ tenant_id: auth.tenant_id, reason: "goal_set", goal_id: id });
  else await syncGoalWork(auth.tenant_id, id);

  res.json({ ok: true });
}

export async function deleteAutopilotGoal(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const id = req.params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    res.status(400).json({ error: { code: "bad_request", message: "invalid goal id" } });
    return;
  }

  const deleted = await writeAutopilotGoal(auth.tenant_id, {
    op: "delete",
    goal_id: id,
    actor: { source: "founder", user_id: auth.user_id },
  });
  if (deleted.status === "error") {
    res.status(500).json({ error: { code: "goal_delete_failed", message: deleted.error } });
    return;
  }
  if (deleted.status === "not_matched") {
    res.status(404).json({ error: { code: "goal_not_found", message: "no such goal" } });
    return;
  }
  res.json({ ok: true });
  try {
    const { loadActiveGoals, goalRev, withdrawQuestionsOffGoals } = await import("@/services/growth/goal-owner");
    const goals = await loadActiveGoals(auth.tenant_id);
    await withdrawQuestionsOffGoals(auth.tenant_id, new Map(goals.map((g) => [g.id, goalRev(g)])));
  } catch (e) {
    console.warn(`[autopilot] withdrawing questions after a goal delete failed: ${(e as Error).message}`);
  }
}

const CURRENT_VALUE_SOURCE_LABEL: Record<string, string> = {
  native_funnel: "Product analytics",
  operator_funnel: "Connected database",
  operator_db_signups: "Connected database",
  booking_value: "Bookings database (booking value)",
  stripe_gross_revenue: "Stripe",
  stripe_mrr: "Stripe",
};

export async function getAutopilotGoalCurrentValue(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const metric = typeof req.query.metric === "string" ? req.query.metric.trim().slice(0, 120) : "";
  const pickedSource = typeof req.query.source === "string" && MONEY_SOURCES.has(req.query.source) ? req.query.source : null;
  if (!metric) {
    res.status(400).json({ error: { code: "bad_request", message: "metric is required" } });
    return;
  }
  const classified = classifyTargetMetric(metric);
  if (classified.kind === "unresolved") {
    res.json({ metric, measured: false, automatic: false, reason: "unresolved_metric", source: null, source_label: "Manual" });
    return;
  }
  try {
    const outcome = await measureGoalMetric({
      tenant_id: auth.tenant_id,
      target_metric: metric,
      goal_created_at: null,
      measure_source: pickedSource,
    });
    if (!outcome.measured) {
      res.json({
        metric, measured: false, automatic: true, reason: outcome.reason, source: classified.kind,
        source_label: CURRENT_VALUE_SOURCE_LABEL[classified.kind] ?? classified.kind,
        ...(outcome.candidates ? { candidates: outcome.candidates } : {}),
      });
      return;
    }
    res.json({
      metric,
      measured: true,
      automatic: true,
      value: outcome.value,
      unit: outcome.unit,
      basis: outcome.basis ?? null,
      source: outcome.source,
      source_label: CURRENT_VALUE_SOURCE_LABEL[outcome.source] ?? outcome.source,
      measured_at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: { code: "measure_failed", message: (e as Error).message } });
  }
}
