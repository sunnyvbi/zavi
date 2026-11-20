
import { EmitNoWriteError } from "./emit-no-write";
import { attachCgoReply } from "@/services/growth/cgo-brief";
import { connectGateSlugFor } from "./connect-gate";
import { ASSISTANT_BLOCKED_AGENTS, ASSISTANT_BLOCKED_MESSAGE, assistantAdChangeNeedsPerson, isAssistantRun } from "@/services/mcp/assistant-policy";
import { createHash } from "node:crypto";
import { sitePrClassOfRun } from "@/services/channels/site-pr-run";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { getAnthropic, estimateCostUsd } from "@/services/anthropic";
import { assessRunCompletion, resultTerminalStatus, REFUSED_COMPLETION_ERROR, type CompletionAssessment } from "./run-completion";
import { scrubSecretsFromText } from "@/services/mcp/egress-secret-scrub";
import { routingDecisionForPersist } from "@/services/agents/model-router";
import { mergeBrainProvenance } from "./brain-provenance";
import { isContextLengthError } from "./context-budget";
import { shouldStoreRawTranscripts } from "./retention-policy";
import { validateDecisionEvidenceInBody } from "./decision-evidence";
import { loadAgentDefinition, getDispatcher } from "./registry";
import { ensureAgentRunnable } from "./ensure-runnable";
import { workerId } from "./boot-role";
import { runOriginForTrigger } from "./run-origin";
import { asClaimedRow } from "./claim-result";
import { isFleetHalted, FleetHaltedError } from "./fleet-halt";
import { isTenantDisabled, TenantDisabledError } from "@/services/tenants/disabled";
import {
  checkSandboxRepoAccess,
  SandboxRepoAccessRequiredError,
} from "@/services/sandbox/repo-access-gate";
import { resolveSandboxMode } from "@/services/sandbox/sandbox-enablement-flag";
import {
  resolveDailyCapUsd,
  estimateRunCost,
  consumeBudgetOrReject,
  releaseBudgetReservation,
  utcDay,
} from "./budget";
import { loadTenantConfig } from "./tenant";
import {
  loadAgentEpisodic,
  loadAgentEpisodicRelevant,
  loadMemoryDocs,
  type MemoryDocs,
} from "@/services/memory/loader";
import {
  ENGINEER_V2_EPISODIC_K,
  engineerTaskText,
  loadEngineerCostV2Config,
} from "./engineer-cost-v2";
import { readMemoryMode } from "./memory-mode";
import { redoRefusesClass, runCarriesRedo } from "./redo-mode";
import { isTopActionRun, topActionFiledNothing, topActionProposalCap, topActionProposalProblem, topActionRefusesClass } from "@/services/channels/top-actions";
import { extractEntities } from "@/services/memory/extract";
import { runGeneric } from "./generic-dispatcher";
import { stripLeadNarration } from "./lead-narration";
import { runChat } from "./chat-dispatcher";
import { willBeInfraRetried, isUsageLimitError } from "./infra-retry";
import { recordChildTerminalAndCheckBatch } from "./batch-fanout-rollup";
import {
  isActiveConductorRun,
  requestTickForFinishedChild,
} from "./conductor-kick";
import { postProcessors } from "@/agents/index";
import { logEvent } from "@/services/logging/logEvent";
import { applyPuntGuard } from "./punt-guard";
import { notifyChatApprovalPending, postSlackApprovalsOnPause } from "@/services/connectors/chat-approval-notify";
import { track } from "@/services/analytics/mixpanel";
import { logReview } from "@/services/logging/log-review";
import { runPreEmitHarness } from "@/services/agents/reasoning-harness";
import { findInternalJargon } from "./internal-jargon";
import { plainDirectEngineerReply } from "./direct-reply-plain-words";
import { isHandoffChildPayload } from "./handoff-result";
import { hasReplyCards, newReplyCardsState, settleReplyCards } from "./reply-cards";
import { readTenantWorkingRunSlugs, readWorkingHandoffChildSlugs } from "./thread-handoff-children";
import {
  verifyCapGrounding,
  CAP_VALIDATOR_AGENTS,
} from "./cap-grounding-verifier";
import {
  hasInflightHandoffClaim,
  hasWorkUnderwayClaim,
  reconcileSideEffectClaims,
} from "./side-effect-claim-reconciler";
import {
  verifyActionAndLiveReadClaims,
  removeUnbackedActionClaims,
  actionClaimGuardEnabled,
  verifyToolBrokenClaim,
  toolBrokenClaimGuardEnabled,
} from "./claim-grounding-verifier";
import { STATUS_PHRASES } from "./run-status-projection";
import {
  verifyRoasSampleGrounding,
  ROAS_SAMPLE_VALIDATOR_AGENTS,
} from "./roas-sample-grounding-verifier";
import { verifyCappedAggregate } from "./capped-aggregate-verifier";
import {
  checkLensCitation,
  LENS_CITATION_AGENTS,
} from "./lens-citation-verifier";
import {
  verifyNoFabricatedBlocker,
  FABRICATED_BLOCKER_VALIDATOR_AGENTS,
} from "./fabricated-blocker-verifier";
import {
  verifyNoUnverifiedAbsence,
  UNVERIFIED_ABSENCE_VALIDATOR_AGENTS,
} from "./unverified-absence-verifier";
import {
  verifyDocOnlyClaims,
  DOC_ONLY_CLAIM_AGENTS,
} from "./doc-only-claim-verifier";
import {
} from "./unverified-absence-verifier";
import {
  verifyConnectorAbsence,
  CONNECTOR_ABSENCE_VALIDATOR_AGENTS,
  verifyNegativeExistence,
  removeFalseAbsenceSentences,
  NEGATIVE_EXISTENCE_VALIDATOR_AGENTS,
} from "./negative-existence-grounding-verifier";
import {
  verifyEngineerTestClaim,
  ENGINEER_VERIFY_VALIDATOR_AGENTS,
} from "./engineer-unverified-claim-verifier";
import { verifyDeferredPromise } from "./receipt-verifier";
import {
  verifyEntityTractionGrounding,
  ENTITY_TRACTION_VALIDATOR_AGENTS,
} from "./entity-traction-grounding-verifier";
import { resolveEntityTractionMode } from "./_entity-traction-flag-check";
import {
  verifyExternalArtifactClaims,
  externalArtifactGuardMode,
  EXTERNAL_ARTIFACT_VALIDATOR_AGENTS,
} from "./external-artifact-claim-verifier";
import { logDecisionNotTaken } from "@/services/agents/log-decision-not-taken";
import { ENGINEER_NO_REPO_NOTE, ENGINEER_NO_REPO_REASON, resolveEngineerDispatchRepo, withEngineerRepo } from "@/services/agents/engineer-dispatch-repo";
import { isInsufficientCreditsError } from "@/services/agents/credits";
import { isCustomAgentSlug, isPlanUpgradeError, type Tier } from "@/services/billing/tiers";
import {
  agentDisplayName,
  planUpgradeErrorBody,
  planUpgradeMessage,
  requiredTierFromDbError,
} from "@/services/agents/entitlement";
import { extractPlaybookRunId, stampPlaybookRunId } from "@/playbooks/stamp";
import { getPlaybook } from "@/playbooks";
import { serviceClient, serverClientFromBearer } from "@/services/supabase";
import { toJsonSafe } from "@/services/json-safe";
import { isDbToolName } from "@zavi/shared/db-guard";
import { deleteCheckpointsAtRunEnd, scrubPreviewsForRunEnd } from "@/services/data-gateway/scrub";
import { inheritStaffModel } from "./staff-model-inherit";
import { checkStaffModelCap } from "@/services/auth/staff-model-access";
import { canUserAccessAgentRun } from "@/services/auth/members";
import { resolveSlackActor, resolveEmailActor, resolveWhatsAppActor, buildRunActor } from "@/services/agents/actor-envelope";
import { resolveRunOwner, runIdentityInputs, runMayUseThread, slackSenderOf, NO_OWNER, type RunOwner } from "@/services/agents/run-owner";
import { isUntrustedContextPayload, carriesCapturedPageContext } from "@/services/agents/untrusted-context";
import { isVerifiedMemberReplyRun } from "@/services/agents/email-reply-trust";
import { resolveFounderChatOrder } from "@/services/growth/founder-order";
import { serverFounderMarks } from "@/services/growth/founder-marks";
import { UNKNOWN_ORDER_PREFIX } from "@/services/growth/move-group";
import type { ActorAuthorityEnvelopeV1 } from "@/services/agents/actor-envelope";
import type { TenantId } from "@/services/tenant-client";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { inngest } from "@/../workers/client";
import { emitTeamNoteRunEnd } from "@/services/team-notes/emit-run-end";
import { makeEmitProgress } from "./progress";
import { emitThreadEvent } from "./thread-event";
import { runEndTrigger } from "./thread-event-types";
import {
  PAUSED_AWAITING_APPROVAL,
  isApprovePauseResumeEnabled,
  shouldPauseForApproval,
  isInteractiveResumeTrigger,
} from "./approve-resume";
import {
  PAUSED_AWAITING_CHILD,
  calledAskAgent,
  isAskChildPayload,
  shouldPauseForChild,
  onParentSettled,
} from "./ask-agent";
import { maybeEmitInlineConfirmCard } from "./build-inline-decision";
import { handOffChatCardDelivery, requestFounderAdvice, tellFounderAboutCard, type HandOffOutcome } from "@/services/approvals/chat-card-delivery";
import { cardAroundCgoDoor, decisionsFiledByRun, filedByThisRun, takesCgoDoor } from "@/services/approvals/chat-card-door";
import { maybeAttachOnGoalHint } from "./on-goal-hint";
import { isUserInitiatedSpendApplyEnabled } from "@/services/tools/meta-ads/write/_user-initiated-flag-check";
import { isUrgentFlagsAsCardsEnabled } from "./_urgent-cards-flag-check";
import { decideProvenanceEmit } from "./provenance-emit-gate";
import { isProvenanceEmitGateEnabled } from "./_provenance-emit-gate-flag-check";
import { selectTerminalChatEmit } from "./chat-reply-text";
import {
  deriveOutcome,
  type RunOutcome,
  EMPTY_COMPLETION_ERROR,
  isReplyExpectingTrigger,
  shouldFailEmptyCompletion,
} from "./outcome-model";
import { presentationStatus, runHasDeliverable } from "./run-display-state";
import type { ToolCallTrace } from "@/services/tools/types";
import { queuedMemoryProposal } from "@/services/agents/should-distill";
import {
  TRUNCATED_SCOPE_DOMAIN_AGENTS,
  SELF_CONTRADICTION_DOMAIN_AGENTS,
} from "@/services/agents/guard-domains";
import { runGroundingChecks, hasHardGroundingFlag } from "./eval/grounding-checks";
import {
  isAutopilotClassRun,
  autopilotStageOf,
  AUTOPILOT_ENFORCED_FLAG,
} from "./autopilot-decision-class";
import {
  scrubAgentEgress,
  scrubParsedOverflow,
  isPiiScrubAgent,
  type ScrubOpts,
} from "./scrub-agent-egress";
import { notifyThreadOwner, sendPushForEvent } from "@/services/notifications/push-fanout";
import { isGrowthPageOnlyClass } from "@/services/approvals/growth-page-only";
import {
  parseOpenActionsFromEnvelope,
  persistOpenActions,
  resolveOldestOpenUrgentOnProposal,
} from "./open-actions";
import {
  parseDecideTodayForLedger,
  persistAdvisorRecommendations,
  parseCloseRecommendationsFromEnvelope,
  closeAdvisorRecommendations,
} from "./advisor-recommendations";
import {
  applyTrustGuard,
  extractUserMessageFromPayload,
} from "./post-text-trust-guard";

const GROUNDING_GATE_AGENTS = new Set([
  "engineer",
  "performance-marketer",
  "chief-of-staff",
  "operator",
  "pm",
  "qa",
  "growth-lead",
  "dispute-response",
  "support-lead",
  "research",
]);
import type {
  AgentContext,
  AgentRun,
  AgentRunSummary,
  AgentTrigger,
  DispatcherResult,
} from "./types";
import { recordBilledCredits } from "@/services/billing/flat-pricing";

export { FleetHaltedError } from "./fleet-halt";
export { TenantDisabledError } from "@/services/tenants/disabled";

export class AgentNotFoundError extends Error {
  constructor(slug: string) {
    super(`Agent "${slug}" not found in src/agents/`);
    this.name = "AgentNotFoundError";
  }
}

export class SafetyGateError extends Error {
  constructor(slug: string, reason: string) {
    super(`Agent "${slug}" rejected by safety gate: ${reason}`);
    this.name = "SafetyGateError";
  }
}

export class BudgetExceededError extends Error {
  constructor(slug: string, capUsd: number) {
    super(`Agent "${slug}" rejected: tenant daily budget cap ($${capUsd}) reached`);
    this.name = "BudgetExceededError";
  }
}

export class BuildCreditsExhaustedError extends Error {
  constructor(slug: string) {
    super(`Agent "${slug}" rejected: no build credits remaining this period`);
    this.name = "BuildCreditsExhaustedError";
  }
}

export class InsufficientCreditsError extends Error {
  constructor(slug: string) {
    super(`Agent "${slug}" rejected: out of credits — top up to keep running`);
    this.name = "InsufficientCreditsError";
  }
}

export class PlanUpgradeRequiredError extends Error {
  readonly code = "plan_upgrade_required" as const;
  constructor(
    readonly agent_slug: string,
    readonly required_tier: Tier,
  ) {
    super(planUpgradeMessage(agent_slug, required_tier));
    this.name = "PlanUpgradeRequiredError";
  }
  get body() {
    return planUpgradeErrorBody(this.agent_slug, this.required_tier);
  }
}

const RECENT_RUNS_DEFAULT_HOURS = 24;

export const BROWSER_OPERATOR_ALLOWED_TRIGGERS: ReadonlySet<AgentTrigger> = new Set<AgentTrigger>([]);

export type EnqueueAgentRunInput = {
  agent_slug: string;
  tenant_id: string;
  trigger: AgentTrigger;
  payload?: unknown;
  before_dispatch?: (run_id: string) => Promise<unknown>;
  cron_dedupe_key?: string | null;
  user_access_token?: string;
  setup_draft_attempt?: 1 | 2 | 3;
  custom_trigger_id?: string | null;
  parent_run_id?: string | null;
  actor_user_id?: string | null;
};

export async function stampRunActor(
  run_id: string,
  trigger: AgentTrigger,
  payload: unknown,
  verifiedActor: string | null = null,
): Promise<void> {
  try {
    let actor_user_id: string | null = null;
    let actor_source: string = trigger;
    if (verifiedActor) {
      const { data: row } = await serviceClient()
        .from("agent_runs")
        .select("tenant_id")
        .eq("id", run_id)
        .maybeSingle<{ tenant_id: string | null }>();
      if (row?.tenant_id) {
        const { data: member } = await serviceClient()
          .from("tenant_users")
          .select("user_id")
          .eq("tenant_id", row.tenant_id)
          .eq("user_id", verifiedActor)
          .maybeSingle<{ user_id: string }>();
        actor_user_id = member?.user_id ?? null;
      }
    } else if (trigger === "email" || trigger === "whatsapp") {
      const { data: row } = await serviceClient()
        .from("agent_runs")
        .select("tenant_id")
        .eq("id", run_id)
        .maybeSingle<{ tenant_id: string | null }>();
      if (row?.tenant_id) {
        actor_user_id = trigger === "email"
          ? await resolveEmailActor(serviceClient(), row.tenant_id, payload)
          : await resolveWhatsAppActor(serviceClient(), row.tenant_id, payload);
      }
    } else if (trigger === "slack") {
      const slack =
        payload && typeof payload === "object"
          ? (payload as { slack?: { user?: unknown; team_id?: unknown } }).slack
          : undefined;
      const slackUser = typeof slack?.user === "string" ? slack.user : "";
      const slackTeam = typeof slack?.team_id === "string" ? slack.team_id : undefined;
      const { data: row } = await serviceClient()
        .from("agent_runs")
        .select("tenant_id")
        .eq("id", run_id)
        .maybeSingle<{ tenant_id: string | null }>();
      if (row?.tenant_id) {
        const env = await resolveSlackActor(
          serviceClient(),
          row.tenant_id,
          slackUser,
          slackTeam,
          { linkOnMiss: true },
        );
        actor_user_id = env.actor_user_id;
        actor_source = env.actor_source;
      }
    }
    const { error } = await serviceClient()
      .from("agent_runs")
      .update(actor_user_id ? { actor_user_id, actor_source } : { actor_source })
      .eq("id", run_id);
    if (error) {
      void logEvent({
        level: "warn",
        source: "runner.actor-stamp",
        code: "actor_stamp_failed",
        message: "actor attribution stamp failed (non-fatal)",
        meta: { code: error.code ?? null },
      });
    }
  } catch {
  }
}

export class MissingTenantId extends Error {
  constructor() {
    super("enqueueAgentRun: tenant_id required");
    this.name = "MissingTenantId";
  }
}

export async function enqueueAgentRun(
  input: EnqueueAgentRunInput,
): Promise<{ run_id: string }> {
  if (!input.tenant_id || !input.tenant_id.trim()) {
    throw new MissingTenantId();
  }
  if (input.setup_draft_attempt !== undefined) {
    if (
      input.agent_slug !== "cgo" ||
      input.trigger !== "a2a" ||
      input.user_access_token ||
      input.cron_dedupe_key ||
      ![1, 2, 3].includes(input.setup_draft_attempt)
    ) {
      throw new Error("enqueueAgentRun: setup_draft_attempt is only for a server-written cgo a2a run with no dedupe key");
    }
  }
  if (isAssistantRun(input.trigger) && ASSISTANT_BLOCKED_AGENTS.has(input.agent_slug)) {
    throw new SafetyGateError(input.agent_slug, ASSISTANT_BLOCKED_MESSAGE);
  }

  if (await isFleetHalted()) {
    throw new FleetHaltedError();
  }

  if (await isTenantDisabled(input.tenant_id, "open")) {
    throw new TenantDisabledError();
  }

  if (input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) && "staff_model" in input.payload) {
    const { staff_model: _dropped, ...rest } = input.payload as Record<string, unknown>;
    input = { ...input, payload: rest as typeof input.payload };
  }
  if (
    input.parent_run_id &&
    (input.payload == null || (typeof input.payload === "object" && !Array.isArray(input.payload)))
  ) {
    const inherited = await inheritStaffModel(
      {
        payload: input.payload as Record<string, unknown> | null | undefined,
        parent_run_id: input.parent_run_id,
        tenant_id: input.tenant_id,
      },
      {
        readParentPayload: async (id, tenantId) => {
          const { data, error } = await serviceClient()
            .from("agent_runs")
            .select("payload")
            .eq("id", id)
            .eq("tenant_id", tenantId)
            .maybeSingle<{ payload: unknown }>();
          if (error) throw new Error(error.message);
          return data?.payload ?? null;
        },
        checkCap: () => checkStaffModelCap(serviceClient()),
      },
    );
    input = { ...input, payload: inherited.payload };
  }

  const agent = await loadAgentDefinition(input.agent_slug, input.tenant_id);
  if (!agent) {
    throw new AgentNotFoundError(input.agent_slug);
  }
  const enqueueSandboxMode = await resolveSandboxMode(agent, input.tenant_id);
  agent.metadata_praxis.requires_sandbox = enqueueSandboxMode.requires_sandbox;
  const enqueueEagerSandbox =
    enqueueSandboxMode.requires_sandbox && !enqueueSandboxMode.lazyEligible;
  if (!agent.metadata_praxis.manual_only && input.trigger === "manual") {
    await logEvent({
      level: "warn",
      source: "runner.safety_gate",
      code: "manual_only_required",
      tenant_id: input.tenant_id,
      meta: { agent_slug: input.agent_slug },
    });
    throw new SafetyGateError(
      input.agent_slug,
      'manual_only must be true (set "manual_only: true" under metadata.praxis in agent.md)',
    );
  }
  if (
    input.agent_slug === "browser-operator" &&
    !BROWSER_OPERATOR_ALLOWED_TRIGGERS.has(input.trigger)
  ) {
    await logEvent({
      level: "warn",
      source: "runner.safety_gate",
      code: "browser_operator_scheduled_dispatch_blocked",
      tenant_id: input.tenant_id,
      meta: {
        agent_slug: input.agent_slug,
        trigger: input.trigger,
        allowed_triggers: [...BROWSER_OPERATOR_ALLOWED_TRIGGERS],
      },
    });
    throw new SafetyGateError(
      input.agent_slug,
      `browser-operator is retired: browsing is the browser__task tool every ` +
        `agent can call. Trigger "${input.trigger}" is not permitted.`,
    );
  }

  if (agent.metadata_praxis.side_effects && !agent.metadata_praxis.decision_class) {
    void recordEnqueueRejection({
      tenant_id: input.tenant_id,
      agent_slug: input.agent_slug,
      reason: "side_effects_without_decision_class",
      payload: input.payload,
      trigger: input.trigger,
    });
    throw new SafetyGateError(
      input.agent_slug,
      'side_effects:true requires decision_class to be set (all external writes must route through tiered autonomy)',
    );
  }

  const userWritesRow =
    (input.trigger === "manual" || input.trigger === "chat") && !!input.user_access_token;
  const gates = await ensureAgentRunnable(input.tenant_id, input.agent_slug, {
    origin: runOriginForTrigger(input.trigger),
    run: {
      trigger: input.trigger,
      enqueuedByUser: userWritesRow,
      payload: input.payload,
      cronDedupeKey: input.cron_dedupe_key ?? null,
    },
  });
  if (!gates.runnable) {
    if (gates.reason === "plan_upgrade_required") {
      void recordEnqueueRejection({
        tenant_id: input.tenant_id,
        agent_slug: input.agent_slug,
        reason: "plan_upgrade_required",
        payload: input.payload,
        trigger: input.trigger,
      });
      throw new PlanUpgradeRequiredError(input.agent_slug, gates.required_tier ?? "pro");
    }
    const auditReason =
      gates.reason === "tenant_hidden_override" || gates.reason === "staff_locked_hide"
        ? "kill_switch"
        : gates.reason;
    void recordEnqueueRejection({
      tenant_id: input.tenant_id,
      agent_slug: input.agent_slug,
      reason: auditReason,
      payload: input.payload,
      trigger: input.trigger,
    });
    throw new SafetyGateError(
      input.agent_slug,
      gates.reason === "tenant_hidden_override" || gates.reason === "staff_locked_hide"
        ? `agent turned off for this workspace; turn it back on in the agent's settings`
        : gates.detail,
    );
  }

  if (enqueueEagerSandbox) {
    const repoAccess = await checkSandboxRepoAccess(input.tenant_id, input.payload);
    const deferToConnectGate =
      repoAccess === "not_connected" &&
      (await connectGateSlugFor({
        tenant_id: input.tenant_id,
        agent,
        trigger: input.trigger,
        payload: input.payload,
      })) !== null;
    if (repoAccess !== "ok" && !deferToConnectGate) {
      void recordEnqueueRejection({
        tenant_id: input.tenant_id,
        agent_slug: input.agent_slug,
        reason: "config_error_no_repo_access",
        payload: input.payload,
        trigger: input.trigger,
      });
      throw new SandboxRepoAccessRequiredError(input.agent_slug, repoAccess);
    }
  }

  const dailyCap = await resolveDailyCapUsd(input.tenant_id);
  let budgetCharge: { estimate: number; day: string } | null = null;
  if (dailyCap > 0) {
    const charge = { estimate: estimateRunCost(agent.metadata_praxis.cost_class), day: utcDay() };
    const charged = await consumeBudgetOrReject({
      tenant_id: input.tenant_id,
      estimate: charge.estimate,
      dailyCap,
      day: charge.day,
    });
    if (!charged) {
      void recordEnqueueRejection({
        tenant_id: input.tenant_id,
        agent_slug: input.agent_slug,
        reason: "budget_exceeded",
        payload: input.payload,
        trigger: input.trigger,
      });
      void logDecisionNotTaken({
        tenant_id: input.tenant_id,
        rejection_type: "cap_exceeded",
        agent_slug: input.agent_slug,
        decision_class: "agent.run",
        reason_code: "budget_exceeded",
      });
      throw new BudgetExceededError(input.agent_slug, dailyCap);
    }
    budgetCharge = charge;
  }

  input = { ...input, payload: toJsonSafe(input.payload) };
  const rpcClient =
    userWritesRow && input.user_access_token
      ? serverClientFromBearer(input.user_access_token)
      : serviceClient();

  const { data: run_id, error } =
    input.setup_draft_attempt !== undefined
      ? await rpcClient.rpc("enqueue_setup_draft", {
          p_tenant_id: input.tenant_id,
          p_agent_hash: agent.content_hash,
          p_payload: (input.payload ?? null) as object | null,
          p_attempt: input.setup_draft_attempt,
        })
      : await rpcClient.rpc("enqueue_agent_run", {
          p_tenant_id: input.tenant_id,
          p_agent_slug: input.agent_slug,
          p_agent_hash: agent.content_hash,
          p_trigger: input.trigger,
          p_payload: (input.payload ?? null) as object | null,
          p_cron_dedupe_key: input.cron_dedupe_key ?? null,
        });
  if ((error || !run_id) && budgetCharge) {
    await releaseBudgetReservation({ tenant_id: input.tenant_id, ...budgetCharge });
  }
  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("insufficient_build_credits") || msg.includes("build_credits_locked")) {
      void recordEnqueueRejection({
        tenant_id: input.tenant_id,
        agent_slug: input.agent_slug,
        reason: "build_credits_exhausted",
        payload: input.payload,
        trigger: input.trigger,
      });
      void logDecisionNotTaken({
        tenant_id: input.tenant_id,
        rejection_type: "cap_exceeded",
        agent_slug: input.agent_slug,
        decision_class: "agent.run",
        reason_code: "build_credits_exhausted",
      });
      throw new BuildCreditsExhaustedError(input.agent_slug);
    }
    if (isPlanUpgradeError(error)) {
      void recordEnqueueRejection({
        tenant_id: input.tenant_id,
        agent_slug: input.agent_slug,
        reason: "plan_upgrade_required",
        payload: input.payload,
        trigger: input.trigger,
      });
      throw new PlanUpgradeRequiredError(input.agent_slug, requiredTierFromDbError(error));
    }
    if (isInsufficientCreditsError(error)) {
      void recordEnqueueRejection({
        tenant_id: input.tenant_id,
        agent_slug: input.agent_slug,
        reason: "insufficient_credits",
        payload: input.payload,
        trigger: input.trigger,
      });
      void logDecisionNotTaken({
        tenant_id: input.tenant_id,
        rejection_type: "cap_exceeded",
        agent_slug: input.agent_slug,
        decision_class: "agent.run",
        reason_code: "insufficient_credits",
      });
      throw new InsufficientCreditsError(input.agent_slug);
    }
    throw new Error(`enqueue_agent_run failed: ${msg}`);
  }
  if (!run_id) {
    return { run_id: "" };
  }

  if (isCustomAgentSlug(input.agent_slug)) {
    try {
      const { error: stampErr } = await tenantRpc(asTenantId(input.tenant_id), "stamp_custom_agent_run", {
        p_run_id: run_id as string,
        p_trigger_id: input.custom_trigger_id ?? null,
      });
      if (stampErr) console.warn(`[runner] stamp_custom_agent_run failed for ${run_id}: ${stampErr.message}`);
    } catch (e) {
      console.warn(`[runner] stamp_custom_agent_run threw for ${run_id}: ${(e as Error).message}`);
    }
  }

  const actorStamp = stampRunActor(run_id as string, input.trigger, input.payload, input.actor_user_id ?? null);
  if (input.trigger !== "slack") await actorStamp;
  track("agent_run_created", {
    tenant_id: input.tenant_id,
    agent_slug: input.agent_slug,
    trigger: input.trigger,
  });

  if (input.before_dispatch) {
    try {
      await input.before_dispatch(run_id as string);
    } catch (e) {
      console.warn(`[enqueueAgentRun] before_dispatch threw for run_id=${run_id}: ${(e as Error).message}`);
    }
  }

  try {
    await inngest.send(
      buildRunRequestedEvent({
        run_id: run_id as string,
        tenant_id: input.tenant_id,
        agent_slug: input.agent_slug,
        trigger: input.trigger,
        batch_id: null,
      }),
    );
  } catch (e) {
    console.warn(
      `[enqueueAgentRun] inngest.send failed for run_id=${run_id} — ` +
        `row queued; queued-stuck-scan will re-emit. err=${(e as Error).message}`,
    );
  }

  return { run_id: run_id as string };
}

export type ClaimedAgentRun = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: AgentTrigger;
  payload: unknown;
  batch_id?: string | null;
  enqueued_by?: string | null;
  cron_dedupe_key?: string | null;
  queue_ms?: number | null;
};

export async function claimAgentRun(run_id: string): Promise<ClaimedAgentRun | null> {
  const { data, error } = await serviceClient().rpc("claim_agent_run", {
    p_run_id: run_id,
    p_worker_id: workerId(),
  });
  if (error) {
    throw new Error(`claim_agent_run failed for ${run_id}: ${error.message}`);
  }
  const claimed = asClaimedRow(data);
  if (!claimed) return null;
  const row = claimed as unknown as {
    id: string;
    tenant_id: string;
    agent_slug: string;
    trigger: AgentTrigger;
    payload: unknown;
    batch_id?: string | null;
    enqueued_by?: string | null;
    cron_dedupe_key?: string | null;
    enqueued_at?: string | null;
    started_at?: string | null;
  };
  await recordBilledCredits({
    runId: row.id,
    tenantId: row.tenant_id,
    agentSlug: row.agent_slug,
    trigger: row.trigger,
    payload: row.payload,
    cronDedupeKey: row.cron_dedupe_key ?? null,
  });
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    agent_slug: row.agent_slug,
    trigger: row.trigger,
    payload: row.payload ?? null,
    enqueued_by: row.enqueued_by ?? null,
    cron_dedupe_key: row.cron_dedupe_key ?? null,
    batch_id: row.batch_id ?? null,
    queue_ms: queueMs(row.enqueued_at, row.started_at),
  };
}

function queueMs(enqueuedAt: string | null | undefined, startedAt: string | null | undefined): number | null {
  const ms = Date.parse(startedAt ?? "") - Date.parse(enqueuedAt ?? "");
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export async function buildContext(claim: ClaimedAgentRun, runId: string): Promise<AgentContext> {
  const memoryMode = readMemoryMode(claim.payload);
  const suppressSkillRuntime =
    !!claim.payload &&
    typeof claim.payload === "object" &&
    (claim.payload as Record<string, unknown>).suppress_skill_runtime === true;
  const EMPTY_ANCHORS = {
    company: "",
    ops: "",
    policies: "",
    disputes: "",
    support: "",
  } as const;
  const payloadThreadId =
    claim.payload && typeof claim.payload === "object"
      ? ((claim.payload as { thread_id?: unknown }).thread_id as string | undefined)
      : undefined;
  const validatesA2aThread =
    claim.trigger === "a2a" &&
    typeof payloadThreadId === "string" &&
    payloadThreadId.length > 0;

  const memoryP: Promise<MemoryDocs> =
    memoryMode === "off"
      ? Promise.resolve({ ...EMPTY_ANCHORS })
      : loadMemoryDocs(claim.tenant_id);
  const engineerCostV2P: Promise<boolean> =
    claim.agent_slug === "engineer"
      ? loadEngineerCostV2Config().then((c) => c.enabled)
      : Promise.resolve(false);
  const episodicP: Promise<string> =
    memoryMode === "off"
      ? Promise.resolve("")
      : claim.agent_slug === "engineer"
        ? engineerCostV2P.then((on) =>
            on
              ? loadAgentEpisodicRelevant(
                  claim.tenant_id,
                  claim.agent_slug,
                  engineerTaskText(claim.payload),
                  { k: ENGINEER_V2_EPISODIC_K, run_id: runId },
                )
              : loadAgentEpisodic(claim.tenant_id, claim.agent_slug),
          )
        : loadAgentEpisodic(claim.tenant_id, claim.agent_slug);
  const ownThreadP: Promise<boolean> = validatesA2aThread
    ? (async () => {
        const { data } = await serviceClient()
          .from("agent_threads")
          .select("id")
          .eq("id", payloadThreadId as string)
          .eq("tenant_id", claim.tenant_id)
          .maybeSingle<{ id: string }>();
        return !!data && (await threadUsable(claim.tenant_id, runId, payloadThreadId as string));
      })()
    : Promise.resolve(false);
  const ownerP: Promise<RunOwner> =
    claim.trigger === "chat" || claim.trigger === "handoff"
      ? resolveRunOwner(serviceClient(), claim.tenant_id, runId)
      : Promise.resolve(NO_OWNER);

  const [agentR, tenantConfigR, memoryR, episodicR, ownThreadR, ownerR, costV2R] =
    await Promise.allSettled([
      loadAgentDefinition(claim.agent_slug, claim.tenant_id),
      loadTenantConfig(claim.tenant_id),
      memoryP,
      episodicP,
      ownThreadP,
      ownerP,
      engineerCostV2P,
    ]);
  const engineerCostV2 = costV2R.status === "fulfilled" && costV2R.value === true;

  if (agentR.status === "rejected") throw agentR.reason;
  const agent = agentR.value;
  if (!agent) {
    throw new AgentNotFoundError(claim.agent_slug);
  }
  const sandboxMode = await resolveSandboxMode(agent, claim.tenant_id);
  agent.metadata_praxis.requires_sandbox = sandboxMode.requires_sandbox;
  const lazySandboxEligible = sandboxMode.lazyEligible;

  if (tenantConfigR.status === "rejected") throw tenantConfigR.reason;
  const tenantConfig = tenantConfigR.value;

  if (memoryR.status === "rejected") throw memoryR.reason;
  const memory = memoryR.value;

  let episodic = "";
  if (episodicR.status === "fulfilled") {
    episodic = episodicR.value;
  } else {
    console.warn(
      `[buildContext] loadAgentEpisodic failed for tenant=${claim.tenant_id} agent=${claim.agent_slug}: ${(episodicR.reason as Error)?.message}`,
    );
  }
  const anthropic = getAnthropic();

  if (ownThreadR.status === "rejected") throw ownThreadR.reason;
  let thread_id: string | undefined;
  if (claim.trigger === "chat") {
    thread_id =
      typeof payloadThreadId === "string" && payloadThreadId.length > 0
        ? payloadThreadId
        : undefined;
  } else if (validatesA2aThread) {
    thread_id = ownThreadR.value ? payloadThreadId : undefined;
  } else {
    thread_id = undefined;
  }

  const playbookRunId = extractPlaybookRunId(claim.payload);
  const playbookSlug =
    claim.trigger === "playbook" && claim.payload && typeof claim.payload === "object"
      ? ((claim.payload as { playbook_slug?: unknown }).playbook_slug as string | undefined)
      : undefined;
  const playbook = playbookSlug ? getPlaybook(playbookSlug) : undefined;

  if (ownerR.status === "rejected") throw ownerR.reason;
  const runIdentity = runIdentityInputs(claim.trigger, ownerR.value, claim.payload, claim.enqueued_by);
  const userId = runIdentity.userId;

  let slackRouting:
    | {
        channel_id: string;
        thread_ts: string;
        original_ts: string;
        event_id: string;
        team_id?: string;
      }
    | undefined;
  if (slackSenderOf(claim.trigger, claim.enqueued_by, claim.payload)) {
    const s = (claim.payload as { slack?: Record<string, unknown> }).slack;
    if (s && typeof s.channel_id === "string" && typeof s.event_id === "string") {
      slackRouting = {
        channel_id: s.channel_id,
        thread_ts: typeof s.thread_ts === "string" ? s.thread_ts : "",
        original_ts:
          typeof s.original_ts === "string"
            ? s.original_ts
            : typeof s.thread_ts === "string"
              ? s.thread_ts
              : "",
        event_id: s.event_id,
        team_id: typeof s.team_id === "string" ? s.team_id : undefined,
      };
    }
  }

  let emailRouting:
    | {
        thread_id: string;
        email_message_id: string;
        rfc_message_id: string | null;
        from: string;
        envelope_to: string;
        identity_id: string | null;
      }
    | undefined;
  if (
    claim.trigger === "email" &&
    claim.payload &&
    typeof claim.payload === "object"
  ) {
    const e = (claim.payload as { email?: Record<string, unknown> }).email;
    if (
      e &&
      typeof e.thread_id === "string" &&
      typeof e.email_message_id === "string"
    ) {
      emailRouting = {
        thread_id: e.thread_id,
        email_message_id: e.email_message_id,
        rfc_message_id: typeof e.rfc_message_id === "string" ? e.rfc_message_id : null,
        from: typeof e.from === "string" ? e.from : "",
        envelope_to: typeof e.envelope_to === "string" ? e.envelope_to : "",
        identity_id: typeof e.identity_id === "string" ? e.identity_id : null,
      };
    }
  }

  let priorMessages: MessageParam[] | undefined;

  const citedNotes = new Map<string, { title: string; score: number }>();

  const provenanceToolCalls: { current: readonly ToolCallTrace[] } = {
    current: [],
  };
  const topActionReturned = new Set<string>();
  const doorTried = new Set<string>();

  const slackPayload = slackSenderOf(claim.trigger, claim.enqueued_by, claim.payload);
  const inheritedActor = runIdentity.inheritedActor;
  const actor = await buildRunActor(serviceClient(), claim.trigger, {
    tenant_id: claim.tenant_id,
    enqueued_by: userId ?? null,
    slack_user_id: typeof slackPayload?.user === "string" ? slackPayload.user : null,
    slack_team_id: typeof slackPayload?.team_id === "string" ? slackPayload.team_id : null,
    inherited_actor: inheritedActor,
    link_slack_on_miss: true,
  });

  const founderOrder = await resolveFounderChatOrder(serviceClient(), {
    id: claim.id,
    tenant_id: claim.tenant_id,
    trigger: claim.trigger,
    payload: claim.payload,
    enqueued_by: claim.enqueued_by === undefined ? undefined : claim.enqueued_by,
    agent_slug: claim.agent_slug,
  });
  const founderChatOrder = founderOrder.founder;

  return {
    agent,
    tenant_id: claim.tenant_id,
    actor,
    lazySandboxEligible,
    tenantConfig,
    memory,
    episodic,
    ...(engineerCostV2 ? { engineer_cost_v2: true } : {}),
    memory_mode: memoryMode,
    suppress_skill_runtime: suppressSkillRuntime,
    anthropic,
    runId,
    trigger: claim.trigger,
    untrusted_context: isUntrustedContextPayload(claim.payload),
    captured_page_context: carriesCapturedPageContext(claim.payload),
    verified_member_email_reply: await isVerifiedMemberReplyRun(claim),
    top_action_run: isTopActionRun(claim.payload, claim.trigger),
    founder_chat_order: founderChatOrder,
    founder_order_unverified: founderOrder.unverified === true,
    founder_order_tell: founderOrder.founder && !founderOrder.card_thread_id,
    ...(founderOrder.founder
      ? { founder_order_group: founderOrder.order_root_id ?? (founderOrder.unverified ? `${UNKNOWN_ORDER_PREFIX}${claim.id}` : claim.id) }
      : {}),
    batch_id: claim.batch_id ?? null,
    playbook,
    thread_id,
    mention_target:
      typeof (claim.payload as Record<string, unknown> | null)?.mention_target ===
      "string"
        ? ((claim.payload as Record<string, unknown>).mention_target as string)
        : undefined,
    userId,
    ...(ownerR.value.broken ? { runOwnerBroken: true } : {}),
    slackRouting,
    emailRouting,
    priorMessages,
    citedNotes,
    provenanceToolCalls,
    scanRecentRuns: (windowHours = RECENT_RUNS_DEFAULT_HOURS) =>
      scanRecentRuns(claim.tenant_id, windowHours),
    emitDecision: async (decision_class: string, body: unknown, emitOpts?: { selfDispatch?: boolean }) => {
      body = serverFounderMarks(
        decision_class,
        body,
        founderOrder.founder
          ? { group: founderOrder.order_root_id ?? (founderOrder.unverified ? `${UNKNOWN_ORDER_PREFIX}${claim.id}` : claim.id), unverified: founderOrder.unverified === true }
          : null,
      );
      if (redoRefusesClass(runCarriesRedo(claim.payload), decision_class)) {
        await logDecisionNotTaken({
          tenant_id: claim.tenant_id,
          rejection_type: "condition_unmet",
          agent_run_id: runId,
          agent_slug: agent.slug,
          decision_class,
          reason_code: "redo_scope",
        });
        void logEvent({
          level: "warn",
          source: "agent.redo-scope",
          code: "decision_blocked_redo_scope",
          tenant_id: claim.tenant_id,
          run_id: runId,
          meta: { agent_slug: agent.slug, decision_class },
        });
        throw new EmitNoWriteError(
          `redo_scope blocked decision (${decision_class}): a redo may only emit the action it is rewriting`,
        );
      }

      if (topActionRefusesClass(claim.payload, decision_class)) {
        await logDecisionNotTaken({
          tenant_id: claim.tenant_id,
          rejection_type: "condition_unmet",
          agent_run_id: runId,
          agent_slug: agent.slug,
          decision_class,
          reason_code: "top_action_scope",
        });
        throw new EmitNoWriteError(
          `top_action_scope blocked decision (${decision_class}): a top-action run may only file its action's cards`,
        );
      }
      const topActionProblem = topActionProposalProblem(claim.payload, decision_class, body);
      if (topActionProblem) {
        await logDecisionNotTaken({
          tenant_id: claim.tenant_id,
          rejection_type: "condition_unmet",
          agent_run_id: runId,
          agent_slug: agent.slug,
          decision_class,
          reason_code: "top_action_mismatch",
        });
        throw new EmitNoWriteError(`top_action_mismatch blocked decision (${decision_class}): ${topActionProblem}`);
      }
      const topActionCap = topActionProposalCap(claim.payload);
      const topActionFiled =
        topActionCap === null
          ? 0
          : await (async () => {
              const { count, error } = await serviceClient()
                .from("decisions")
                .select("id", { count: "exact", head: true })
                .eq("tenant_id", claim.tenant_id)
                .eq("agent_run_id", runId)
                .neq("status", "rejected");
              return error ? Number.POSITIVE_INFINITY : (count ?? 0);
            })();
      if (topActionCap !== null && Math.max(topActionFiled, topActionReturned.size) >= topActionCap) {
        await logDecisionNotTaken({
          tenant_id: claim.tenant_id,
          rejection_type: "condition_unmet",
          agent_run_id: runId,
          agent_slug: agent.slug,
          decision_class,
          reason_code: "top_action_cap",
        });
        throw new EmitNoWriteError(
          `top_action_cap blocked decision (${decision_class}): this action files ${topActionCap} card(s) and it is already staged; do not stage it again`,
        );
      }

      const mergedBody = stampPlaybookRunId(mergeBrainProvenance(body, citedNotes), playbookRunId);
      validateDecisionEvidenceInBody(mergedBody, {
        decision_class,
      });

      let bodyToEmit: unknown = mergedBody;
      try {
        const gateOn = await isProvenanceEmitGateEnabled();
        if (gateOn) {
          const gate = decideProvenanceEmit({
            enabled: true,
            agentSlug: agent.slug,
            body: mergedBody,
            toolCalls: provenanceToolCalls.current,
          });
          if (gate.disposition === "block") {
            await logDecisionNotTaken({
              tenant_id: claim.tenant_id,
              rejection_type: "condition_unmet",
              agent_run_id: runId,
              agent_slug: agent.slug,
              decision_class,
              reason_code: "provenance_missing",
            });
            void logEvent({
              level: "warn",
              source: "agent.provenance-emit-gate",
              code: "decision_blocked_provenance_missing",
              tenant_id: claim.tenant_id,
              run_id: runId,
              meta: {
                agent_slug: agent.slug,
                decision_class,
                count: gate.ungrounded_amounts.length,
              },
            });
            throw new EmitNoWriteError(
              `provenance_emit_gate blocked decision (${decision_class}): unprovenanced cap claim`,
            );
          }
          if (gate.disposition === "route_to_review") {
            bodyToEmit = gate.body;
            void logEvent({
              level: "warn",
              source: "agent.provenance-emit-gate",
              code: "decision_routed_provenance_review",
              tenant_id: claim.tenant_id,
              run_id: runId,
              meta: {
                agent_slug: agent.slug,
                decision_class,
                count: gate.ungrounded_amounts.length,
              },
            });
          }
        }
      } catch (e) {
        if (
          e instanceof Error &&
          e.message.startsWith("provenance_emit_gate blocked")
        ) {
          throw e;
        }
        console.warn(
          `[emitDecision] provenance gate threw (fail-open, emitting ungated): ${(e as Error).message}`,
        );
        bodyToEmit = mergedBody;
      }

      bodyToEmit = await maybeAttachOnGoalHint({
        tenant_id: claim.tenant_id,
        trigger: claim.trigger,
        decisionClass: decision_class,
        body: bodyToEmit,
      });

      const sitePrHold =
        decision_class === "engineer.ship-pr" &&
        claim.agent_slug === "engineer" &&
        sitePrClassOfRun({ enqueued_by: claim.enqueued_by ?? null, payload: claim.payload }) !== null;
      const autonomyOverride = sitePrHold ? "approval" : undefined;

      const withRepo = await withEngineerRepo(decision_class, bodyToEmit, (hint) =>
        resolveEngineerDispatchRepo(claim.tenant_id, hint),
      );
      if (withRepo === null) {
        await logDecisionNotTaken({
          tenant_id: claim.tenant_id,
          rejection_type: "condition_unmet",
          agent_run_id: runId,
          agent_slug: agent.slug,
          decision_class,
          reason_code: ENGINEER_NO_REPO_REASON,
        });
        void logEvent({
          level: "warn",
          source: "agent.engineer-repo-gate",
          code: "decision_blocked_engineer_no_repo",
          tenant_id: claim.tenant_id,
          run_id: runId,
          meta: { agent_slug: agent.slug, decision_class },
        });
        throw new EmitNoWriteError(
          `${ENGINEER_NO_REPO_REASON} blocked decision (${decision_class}): this workspace has no connected or Zavi-built repo. ${ENGINEER_NO_REPO_NOTE}`,
        );
      }
      bodyToEmit = withRepo;

      const filedBefore = takesCgoDoor(decision_class) ? await decisionsFiledByRun(claim.tenant_id, runId) : null;
      const { data, error } = await serviceClient().rpc("emit_decision", {
        p_tenant_id: claim.tenant_id,
        p_agent_run_id: runId,
        p_decision_class: decision_class,
        p_body: bodyToEmit as object,
        ...(autonomyOverride ? { p_autonomy_override: autonomyOverride } : {}),
      });
      if (error) {
        throw new Error(`emit_decision failed (${decision_class}): ${error.message}`);
      }
      const decision_id = data as string;
      if (topActionCap !== null) topActionReturned.add(decision_id);

      const emitInlineCard = () =>
        maybeEmitInlineConfirmCard(
          {
            decision_id,
            decision_class,
            body: bodyToEmit,
            run_trigger: claim.trigger,
            thread_id: thread_id ?? null,
            agent_run_id: runId,
            agent_slug: agent.slug,
            tenant_id: claim.tenant_id,
            founder_chat_order: founderChatOrder,
            founder_card_thread_id: founderOrder.card_thread_id,
            founder_card_agent_slug: founderOrder.card_agent_slug,
            founder_card_run_id: founderOrder.card_run_id,
          },
          {
            isSpendFlagOn: isUserInitiatedSpendApplyEnabled,
            isUrgentCardsFlagOn: isUrgentFlagsAsCardsEnabled,
            emit: emitThreadEvent,
            showInChat: async (id: string) => {
              const { attachCardToChat } = await import("@/services/approvals/chat-card-attach");
              return attachCardToChat({ tenant_id: claim.tenant_id, run_id: runId, card_id: id, table: "decisions" });
            },
            alreadyEmitted: async (id: string) => {
              let q = serviceClient()
                .from("thread_event")
                .select("id")
                .eq("tenant_id", claim.tenant_id)
                .eq("kind", "decision")
                .eq("body->>decision_id", id);
              if (founderOrder.card_thread_id) q = q.eq("thread_id", founderOrder.card_thread_id);
              const { data, error } = await q.limit(1);
              if (error) throw new Error(`thread_event read failed: ${error.message}`);
              return ((data ?? []) as unknown[]).length > 0;
            },
            decisionIsOpen: async (id: string) => {
              const { data, error } = await serviceClient()
                .from("decisions")
                .select("status")
                .eq("id", id)
                .eq("tenant_id", claim.tenant_id)
                .maybeSingle();
              if (error) throw new Error(`decision status read failed: ${error.message}`);
              return (data as { status?: unknown } | null)?.status === "proposed";
            },
            onFounderCardEmitted: (id: string) => {
              void requestFounderAdvice(id, claim.tenant_id, runId);
            },
          },
        );
      let inlineHandOff: HandOffOutcome | null = null;
      try {
        await emitInlineCard();
      } catch (first) {
        try {
          await emitInlineCard();
        } catch (e) {
          inlineHandOff = await handOffChatCardDelivery({
            tenant_id: claim.tenant_id,
            run_id: founderOrder.card_run_id ?? runId,
            card_id: decision_id,
            decision_class,
            error: `${(first as Error).message} / ${(e as Error).message}`,
          });
        }
      }

      let customDispatched = false;
      if (!emitOpts?.selfDispatch && isCustomAgentSlug(agent.slug)) {
        const { dispatchCustomAgentDecision, handCustomDecisionToHuman } = await import("./custom-agent-decisions");
        if (assistantAdChangeNeedsPerson(claim.trigger, decision_class)) {
          await handCustomDecisionToHuman(claim.tenant_id, decision_id, runId);
        } else {
          customDispatched =
            (await dispatchCustomAgentDecision({
              tenant_id: claim.tenant_id,
              run_id: runId,
              slug: agent.slug,
              decision_id,
              decision_class,
              body: bodyToEmit,
            })) === "dispatched";
        }
      }

      let cgoApproved = false;
      if (!customDispatched && takesCgoDoor(decision_class)) {
        const firstTry = !doorTried.has(decision_id);
        doorTried.add(decision_id);
        const reused = !firstTry || !(await filedByThisRun(claim.tenant_id, decision_id, runId, filedBefore));
        let cardInChat = false;
        ({ cgoApproved, cardInChat } = await cardAroundCgoDoor({
          reused,
          tenant_id: claim.tenant_id,
          run_id: runId,
          trigger: claim.trigger,
          has_thread: !!thread_id,
          decision_id,
          decision_class,
          body: bodyToEmit,
          agent_slug: agent.slug,
          prior_handoff: inlineHandOff,
        }));
        const metaOrGoogle = /^(meta_ads|google_ads)\./.test(decision_class);
        if (founderOrder.founder && !founderOrder.card_thread_id && claim.trigger !== "slack" && !cgoApproved && !cardInChat && inlineHandOff !== "queued" && inlineHandOff !== "told" && metaOrGoogle) {
          void tellFounderAboutCard(claim.tenant_id, decision_id);
        }
        if (reused && claim.trigger === "slack" && metaOrGoogle && !cgoApproved) {
          void postSlackApprovalsOnPause({ tenant_id: claim.tenant_id, run_id: runId, decision_ids: [decision_id] }).catch(() => {});
        }
      }

      if (!customDispatched && !cgoApproved && !isGrowthPageOnlyClass(decision_class)) void sendPushForEvent({
        tenant_id: claim.tenant_id,
        kind: "approval",
        agent_slug: agent.slug,
        thread_id: thread_id ?? null,
        title: `${agent.slug} needs your approval`,
        body: "A new decision is waiting for you.",
      }).catch(() => {
      });

      return decision_id;
    },
    emitProgress: makeEmitProgress(runId, claim.tenant_id),
  };
}

async function applyOperatorTrustGuard(
  ctx: AgentContext,
  payload: unknown,
  result: DispatcherResult,
): Promise<DispatcherResult> {
  try {
    const userMessage = extractUserMessageFromPayload(payload);
    if (userMessage && result.output_text) {
      const guard = await applyTrustGuard({
        tenant_id: ctx.tenant_id,
        run_id: ctx.runId,
        agent_slug: ctx.agent.slug,
        user_message: userMessage,
        agent_text: result.output_text,
      });
      if (guard.fired) {
        result.output_text = guard.text;
        const parsed = (result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {});
        const meta = (parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {});
        result.parsed = {
          ...parsed,
          metadata: { ...meta, trust_seatbelt_fired: true, trust_seatbelt_category: guard.category },
        };
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] post-text trust guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (CAP_VALIDATOR_AGENTS.has(ctx.agent.slug) && result.output_text) {
      const cap = verifyCapGrounding({
        reply: result.output_text,
        toolCalls: result.tool_calls,
      });
      if (cap.hedged) {
        const parsed = (result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {});
        const meta = (parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {});
        result.parsed = {
          ...parsed,
          metadata: {
            ...meta,
            cap_grounding_fired: true,
            cap_grounding_amounts: cap.flags.ungrounded_amounts,
          },
        };
        void logEvent({
          level: "warn",
          source: "agent.cap-grounding",
          code: "cap_grounding_hedged",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            ungrounded_amounts: cap.flags.ungrounded_amounts,
            count: cap.flags.ungrounded_amounts.length,
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] cap grounding guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (ROAS_SAMPLE_VALIDATOR_AGENTS.has(ctx.agent.slug) && result.output_text) {
      const roas = verifyRoasSampleGrounding({
        reply: result.output_text,
        toolCalls: result.tool_calls,
      });
      if (roas.hedged) {
        const parsed = (result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {});
        const meta = (parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {});
        result.parsed = {
          ...parsed,
          metadata: {
            ...meta,
            roas_sample_grounding_fired: true,
            roas_sample_grounding_count: roas.flags.ungrounded_sentences.length,
          },
        };
        void logEvent({
          level: "warn",
          source: "agent.roas-sample-grounding",
          code: "roas_sample_grounding_hedged",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            count: roas.flags.ungrounded_sentences.length,
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] roas sample grounding guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (result.output_text) {
      const capped = verifyCappedAggregate({
        reply: result.output_text,
        toolCalls: result.tool_calls,
      });
      if (capped.hedged) {
        const parsed = (result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {});
        const meta = (parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {});
        result.parsed = {
          ...parsed,
          metadata: {
            ...meta,
            capped_aggregate_fired: true,
            capped_aggregate_count: capped.flags.ungrounded_sentences.length,
          },
        };
        void logEvent({
          level: "warn",
          source: "agent.capped-aggregate",
          code: "capped_aggregate_hedged",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            count: capped.flags.ungrounded_sentences.length,
            capped_tools: capped.flags.capped_tools,
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] capped aggregate guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (LENS_CITATION_AGENTS.has(ctx.agent.slug) && result.output_text) {
      const lens = checkLensCitation(ctx.agent.slug, result.output_text);
      if (lens.judgmentClass) {
        logReview({
          feature: "lens_citation",
          event: "advisory",
          outcome: lens.cited ? "cited" : "uncited",
          run_id: ctx.runId,
          tenant_id: ctx.tenant_id,
          meta: { agent_slug: ctx.agent.slug, review_n: lens.hitCount },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] lens-citation advisory check threw (run already succeeded, log-only): ${(e as Error).message}`,
    );
  }

  try {
    if (
      FABRICATED_BLOCKER_VALIDATOR_AGENTS.has(ctx.agent.slug) &&
      result.output_text
    ) {
      const fb = verifyNoFabricatedBlocker({
        reply: result.output_text,
        toolCalls: result.tool_calls,
      });
      if (fb.hedged) {
        const parsed = (result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {});
        const meta = (parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {});
        result.parsed = {
          ...parsed,
          metadata: {
            ...meta,
            fabricated_blocker_seatbelt_fired: true,
            fabricated_blocker_phrases: fb.flags.matched_phrases,
          },
        };
        void logEvent({
          level: "warn",
          source: "agent.fabricated-blocker",
          code: "fabricated_blocker_hedged",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            count: fb.flags.matched_phrases.length,
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] fabricated-blocker guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (UNVERIFIED_ABSENCE_VALIDATOR_AGENTS.has(ctx.agent.slug)) {
      if (result.output_text) {
        const ua = verifyNoUnverifiedAbsence({
          reply: result.output_text,
          toolCalls: result.tool_calls,
          codeSearchAvailable: result.code_search_available,
        });
        if (ua.hedged) {
          void logEvent({
            level: "warn",
            source: "agent.unverified-absence",
            code: "unverified_absence_hedged",
            tenant_id: ctx.tenant_id,
            run_id: ctx.runId,
            meta: {
              agent_slug: ctx.agent.slug,
              count: ua.flags.matched_phrases.length,
            },
          });
        }
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] unverified-absence guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (DOC_ONLY_CLAIM_AGENTS.has(ctx.agent.slug)) {
      if (Array.isArray(result.assistant_turns)) {
        for (let i = 0; i < result.assistant_turns.length; i++) {
          const turn = result.assistant_turns[i];
          if (typeof turn !== "string" || turn.length === 0) continue;
          const dc = verifyDocOnlyClaims({
            agentSlug: ctx.agent.slug,
            text: turn,
            toolCalls: result.tool_calls,
          });
          if (dc.changed) result.assistant_turns[i] = dc.text;
        }
      }
      if (result.output_text) {
        const dc = verifyDocOnlyClaims({
          agentSlug: ctx.agent.slug,
          text: result.output_text,
          toolCalls: result.tool_calls,
        });
        if (dc.changed) {
          result.output_text = dc.text;
          void logEvent({
            level: "warn",
            source: "agent.doc-only-claim",
            code: "doc_only_claims_reshaped",
            tenant_id: ctx.tenant_id,
            run_id: ctx.runId,
            meta: { agent_slug: ctx.agent.slug, reshaped: dc.reshaped },
          });
        }
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] doc-only-claim guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (CONNECTOR_ABSENCE_VALIDATOR_AGENTS.has(ctx.agent.slug) && result.output_text) {
      const ca = await verifyConnectorAbsence({
        tenant_id: ctx.tenant_id,
        reply: result.output_text,
        toolCalls: result.tool_calls,
      });
      if (ca.hedged) {
        const parsed = (result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {});
        const meta = (parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {});
        result.parsed = {
          ...parsed,
          metadata: {
            ...meta,
            connector_absence_correction_fired: true,
            connector_absence_connectors: ca.flags.connectors_falsely_claimed_absent,
          },
        };
        void logEvent({
          level: "warn",
          source: "agent.connector-absence",
          code: "connector_absence_corrected",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            count: ca.flags.connectors_falsely_claimed_absent.length,
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] connector-absence guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (ENGINEER_VERIFY_VALIDATOR_AGENTS.has(ctx.agent.slug) && result.output_text) {
      const parsedObj =
        result.parsed && typeof result.parsed === "object"
          ? (result.parsed as {
              verify?: { status?: unknown; reason?: unknown } | null;
              pr_url?: unknown;
              stale_committed_dist?: ReadonlyArray<{
                pkgRoot?: unknown;
                srcFiles?: unknown;
              }> | null;
            })
          : undefined;
      const ev = verifyEngineerTestClaim({
        reply: result.output_text,
        verify: parsedObj?.verify,
        pr_url: parsedObj?.pr_url,
        stale_committed_dist: parsedObj?.stale_committed_dist,
        side_effect_kind: result.side_effect?.kind,
      });
      if (ev.hedged) {
        const parsed = (result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {});
        const meta = (parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {});
        result.parsed = {
          ...parsed,
          metadata: {
            ...meta,
            engineer_verify_correction_fired: true,
            engineer_verify_phrases: ev.matched_phrases,
          },
        };
        void logEvent({
          level: "warn",
          source: "agent.engineer-verify",
          code: "engineer_verify_corrected",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            count: ev.matched_phrases.length,
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] engineer-verify guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (
      NEGATIVE_EXISTENCE_VALIDATOR_AGENTS.has(ctx.agent.slug) &&
      result.output_text
    ) {
      const ne = await verifyNegativeExistence({
        tenant_id: ctx.tenant_id,
        reply: result.output_text,
      });
      if (ne.hedged) {
        result.output_text = ne.without_false_claims;
        if (typeof result.customer_summary === "string" && result.customer_summary) {
          const cs = removeFalseAbsenceSentences(
            result.customer_summary,
            ne.flags.false_claims,
          );
          if (cs !== result.customer_summary) result.customer_summary = undefined;
        }
        const parsed =
          result.parsed && typeof result.parsed === "object"
            ? (result.parsed as Record<string, unknown>)
            : {};
        const meta =
          parsed.metadata && typeof parsed.metadata === "object"
            ? (parsed.metadata as Record<string, unknown>)
            : {};
        result.parsed = {
          ...parsed,
          metadata: {
            ...meta,
            negative_existence_correction_fired: true,
            negative_existence_symbols: ne.flags.corrected_symbols,
          },
        };
        void logEvent({
          level: "warn",
          source: "agent.negative-existence",
          code: "negative_existence_corrected",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            count: ne.flags.corrected_symbols.length,
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] negative-existence guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    const etMode = ENTITY_TRACTION_VALIDATOR_AGENTS.has(ctx.agent.slug)
      ? await resolveEntityTractionMode()
      : "off";
    if (etMode !== "off" && result.output_text) {
      const et = verifyEntityTractionGrounding({
        reply: result.output_text,
        toolCalls: result.tool_calls,
        userMessage: extractUserMessageFromPayload(payload),
      });
      if (et.hedged) {
        const parsed = (result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {});
        const meta = (parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {});
        result.parsed = {
          ...parsed,
          metadata: {
            ...meta,
            entity_traction_grounding_fired: true,
            entity_traction_grounding_mode: etMode,
            entity_traction_grounding_classes: et.flags.classes,
          },
        };
        void logEvent({
          level: "warn",
          source: "agent.entity-traction-grounding",
          code:
            etMode === "hedge"
              ? "entity_traction_grounding_hedged"
              : "entity_traction_grounding_shadow",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            classes: et.flags.classes,
            count: et.flags.classes.length,
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] entity/traction grounding guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    const eaMode = EXTERNAL_ARTIFACT_VALIDATOR_AGENTS.has(ctx.agent.slug)
      ? externalArtifactGuardMode()
      : "off";
    if (eaMode !== "off" && result.output_text) {
      const ea = verifyExternalArtifactClaims({
        reply: result.output_text,
        toolCalls: result.tool_calls,
        userMessage: extractUserMessageFromPayload(payload),
        promptSnapshot: result.prompt_snapshot,
      });
      if (ea.hedged) {
        const parsed = (result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {});
        const meta = (parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {});
        const classes = ea.flags.map((f) => f.claimClass);
        result.parsed = {
          ...parsed,
          metadata: {
            ...meta,
            external_artifact_claim_fired: true,
            external_artifact_claim_mode: eaMode,
            external_artifact_claim_classes: classes,
          },
        };
        void logEvent({
          level: "warn",
          source: "agent.external-artifact-claim",
          code:
            eaMode === "warn"
              ? "external_artifact_claim_warned"
              : "external_artifact_claim_shadow",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            classes,
            count: classes.length,
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] external-artifact claim guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (actionClaimGuardEnabled() && result.output_text) {
      const acParsed =
        result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {};
      const acDispatched = acParsed.dispatched_actions;
      const ac = verifyActionAndLiveReadClaims({
        reply: result.output_text,
        toolCalls: result.tool_calls,
        dispatchedActions: Array.isArray(acDispatched)
          ? acDispatched
          : undefined,
      });
      if (ac.flagged) {
        const parsed = (result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {});
        const meta = (parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {});
        result.parsed = {
          ...parsed,
          metadata: {
            ...meta,
            action_claim_guard_fired: true,
            action_claim_flagged: ac.flags.action_claim,
          },
        };
        void logEvent({
          level: "warn",
          source: "agent.action-claim-grounding",
          code: "action_claim_flagged",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            action: ac.flags.action_claim,
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] action-claim grounding guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (toolBrokenClaimGuardEnabled() && result.output_text) {
      const tb = verifyToolBrokenClaim({
        reply: result.output_text,
        toolCalls: result.tool_calls,
      });
      if (tb.flagged) {
        const parsed = (result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {});
        const meta = (parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {});
        result.parsed = {
          ...parsed,
          metadata: {
            ...meta,
            tool_broken_claim_guard_fired: true,
          },
        };
        void logEvent({
          level: "warn",
          source: "agent.tool-broken-claim-grounding",
          code: "tool_broken_claim_flagged",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            matched_patterns: tb.flags.matched_patterns,
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] tool-broken-claim grounding guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (result.output_text) {
      const rec = reconcileSideEffectClaims({
        agent_slug: ctx.agent.slug,
        output_text: result.output_text,
        parsed: result.parsed,
        tool_calls: result.tool_calls,
        parse_ok: result.parse_ok,
        thread_children_working: hasInflightHandoffClaim(result.output_text)
          ? await readWorkingHandoffChildSlugs(serviceClient(), ctx.tenant_id, ctx.thread_id)
          : undefined,
        tenant_runs_working: hasWorkUnderwayClaim(result.output_text)
          ? await readTenantWorkingRunSlugs(serviceClient(), ctx.tenant_id, ctx.runId)
          : undefined,
        ...(isAssistantRun(ctx.trigger) ? { surface: "mcp" as const, run_id: ctx.runId } : {}),
      });
      if (rec.mismatch) {
        if (rec.corrected) {
          result.output_text = rec.text;
          const parsed = (result.parsed && typeof result.parsed === "object"
            ? (result.parsed as Record<string, unknown>)
            : {});
          const meta = (parsed.metadata && typeof parsed.metadata === "object"
            ? (parsed.metadata as Record<string, unknown>)
            : {});
          result.parsed = {
            ...parsed,
            metadata: {
              ...meta,
              side_effect_claim_corrected: true,
              side_effect_claim_type: rec.mismatch.claim_type,
            },
          };
        }
        void logEvent({
          level: "warn",
          source: "agent.side-effect-claim",
          code: rec.corrected
            ? "side_effect_claim.sentence_removed"
            : "side_effect_claim_mismatch_logged",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            stage: rec.mismatch.claim_type,
            count: rec.removed_sentences ?? 0,
            surface: "persist",
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] side-effect-claim reconciler threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    const unbacked = (text: string) =>
      removeUnbackedActionClaims({
        text,
        toolCalls: result.tool_calls,
        parsed: result.parsed,
        sideEffectKind: result.side_effect?.kind,
      });
    if (result.output_text) {
      const ua = unbacked(result.output_text);
      if (ua.removed > 0) result.output_text = ua.text;
    }
    if (typeof result.customer_summary === "string" && result.customer_summary) {
      const ua = unbacked(result.customer_summary);
      if (ua.removed > 0) result.customer_summary = ua.text;
    }
    if (Array.isArray(result.assistant_turns)) {
      result.assistant_turns = result.assistant_turns.map((turn) => {
        if (typeof turn !== "string" || turn.length === 0) return turn;
        const ua = unbacked(turn);
        if (ua.removed === 0) return turn;
        return ua.text === STATUS_PHRASES.no_change ? "" : ua.text;
      });
    }
  } catch (e) {
    console.warn(
      `[runDispatch] unbacked action-claim removal threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    if (
      ctx.agent.slug === "engineer" &&
      ctx.trigger !== "handoff" &&
      !isHandoffChildPayload(p) &&
      result.output_text
    ) {
      const plain = plainDirectEngineerReply({
        text: result.output_text,
        parse_ok: result.parse_ok,
        side_effect: result.side_effect,
        customer_summary: result.customer_summary,
      });
      if (plain.mode !== "unchanged") result.output_text = plain.text;
    }
  } catch (e) {
    console.warn(
      `[runDispatch] plain-words pass threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (result.output_text) {
      const dpParsed =
        result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {};
      const dpDispatched = dpParsed.dispatched_actions;
      const dpDispatchedArr = Array.isArray(dpDispatched) ? dpDispatched : undefined;
      const dp = verifyDeferredPromise({
        reply: result.output_text,
        toolCalls: result.tool_calls,
        dispatchedActions: dpDispatchedArr,
      });
      if (dp.hedged) {
        const parsed = (result.parsed && typeof result.parsed === "object"
          ? (result.parsed as Record<string, unknown>)
          : {});
        const meta = (parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {});
        result.parsed = {
          ...parsed,
          metadata: {
            ...meta,
            deferred_promise_hedged: true,
            deferred_promise_matched: dp.flags.matched,
          },
        };
        void logEvent({
          level: "warn",
          source: "agent.deferred-promise",
          code: "deferred_promise_hedged",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            matched: dp.flags.matched,
            count: dp.flags.matched.length,
          },
        });
      }
    }
  } catch (e) {
    console.warn(
      `[runDispatch] deferred-promise guard threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  try {
    if (ctx.trigger !== "chat" && result.output_text) {
      const jargon = findInternalJargon(result.output_text);
      if (jargon.length > 0) {
        void logEvent({
          level: "warn",
          source: "reply.internal_jargon",
          code: "reply.internal_jargon_detected",
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          meta: {
            agent_slug: ctx.agent.slug,
            surface: "persist",
            families: jargon.join(","),
            count: jargon.length,
          },
        });
      }
    }
  } catch {
  }

  try {
    if (result.output_text) {
      await runPreEmitHarness({
        surface: "prose",
        agent_slug: ctx.agent.slug,
        tenant_id: ctx.tenant_id,
        run_id: ctx.runId,
        body: result.output_text,
        evidence: result.tool_calls,
      });
    }
  } catch (e) {
    console.warn(
      `[runDispatch] prose grounding shadow threw (run already succeeded): ${(e as Error).message}`,
    );
  }

  return result;
}

export async function runDispatch(
  ctx: AgentContext,
  payload: unknown,
): Promise<DispatcherResult> {
  if (ctx.trigger === "chat") {
    try {
      return await applyOperatorTrustGuard(ctx, payload, await runChat(ctx, payload));
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (
        ctx.thread_id &&
        /No conversation found with session|sdk_session_(load|append) failed|session resume/i.test(
          msg,
        )
      ) {
        console.warn(
          `[runDispatch] stale/failed SDK session resume for thread=${ctx.thread_id}; clearing sdk_session_id + retrying without resume`,
        );
        try {
          await serviceClient()
            .from("agent_threads")
            .update({ sdk_session_id: null })
            .eq("id", ctx.thread_id)
            .eq("tenant_id", ctx.tenant_id);
        } catch (clearErr) {
          console.warn(
            `[runDispatch] clear stale sdk_session_id failed (thread=${ctx.thread_id}): ${(clearErr as Error).message}`,
          );
        }
        return await applyOperatorTrustGuard(ctx, payload, await runChat(ctx, payload));
      }
      throw e;
    }
  }
  const bespoke = getDispatcher(ctx.agent.slug);
  if (bespoke) return await applyOperatorTrustGuard(ctx, payload, attachCgoReply(payload, await applyPuntGuard({ ctx, payload, result: await bespoke(ctx, payload), rerun: null })));

  const result = await applyPuntGuard({
    ctx,
    payload,
    result: await runGeneric(ctx, payload),
    rerun: (p) => runGeneric(ctx, p),
  });
  const postProcess = postProcessors[ctx.agent.slug];
  if (postProcess && ctx.draft_mode !== true) {
    try {
      await postProcess(ctx, result, payload);
    } catch (e) {
      const m = (e as Error).message ?? String(e);
      console.warn(
        `[runDispatch] postProcess(${ctx.agent.slug}) threw (run already succeeded): ${m}`,
      );
      result.parse_error = result.parse_error
        ? `${result.parse_error}; post_process_threw:${m.slice(0, 200)}`
        : `post_process_threw:${m.slice(0, 200)}`;
    }
  }
  return applyOperatorTrustGuard(ctx, payload, attachCgoReply(payload, result));
}

export async function postRunDistill(
  tenant_id: string,
  agent_slug: string,
  result: DispatcherResult | null,
): Promise<{ entities: number }> {
  if (!result || !result.output_text) return { entities: 0 };
  const { entities } = extractEntities(result.output_text);
  if (entities.length === 0) return { entities: 0 };
  let upserted = 0;
  const now = new Date().toISOString();
  for (const e of entities) {
    const { error } = await serviceClient()
      .from("memory_entity")
      .upsert(
        {
          tenant_id,
          entity_type: e.entity_type,
          canonical_name: e.canonical_name,
          attrs: e.attrs ?? {},
          last_seen_at: now,
        },
        { onConflict: "tenant_id,entity_type,canonical_name" },
      );
    if (error) {
      console.warn(
        `[postRunDistill] entity upsert failed for ${agent_slug}/${e.canonical_name}: ${error.message}`,
      );
      continue;
    }
    upserted += 1;
  }
  return { entities: upserted };
}

const PROMPT_SNAPSHOT_WARN_CHARS = 240_000;

export const PARSE_FAILED_USER_ERROR =
  "The answer came back in an unexpected format, so any follow-up actions were skipped. The text above is still the agent's work.";

export function terminalErrorForResult(result: {
  parse_ok: boolean;
}): string | null {
  return result.parse_ok ? null : PARSE_FAILED_USER_ERROR;
}

export async function resolveEgressOpts(
  run_id: string,
  agent_slug: string,
  trigger: string | undefined,
  result: DispatcherResult,
): Promise<ScrubOpts> {
  const isSlackRun = trigger === "slack";
  let artifactIdDenylist: string[] | undefined;
  if (isSlackRun) {
    try {
      const sc = serviceClient();
      const { data: runRow } = await sc
        .from("agent_runs")
        .select("tenant_id")
        .eq("id", run_id)
        .maybeSingle<{ tenant_id: string }>();
      const tenant_id = runRow?.tenant_id;
      if (tenant_id) {
        const { data: artRows } = await sc
          .from("run_artifacts")
          .select("id")
          .eq("tenant_id", tenant_id)
          .eq("run_id", run_id);
        artifactIdDenylist = (artRows ?? [])
          .map((r) => (r as { id?: string }).id)
          .filter((id): id is string => typeof id === "string" && id.length > 0);
      }
    } catch (e) {
      console.warn(
        `[persistTerminal] artifact-id denylist read failed for ${run_id}: ${(e as Error).message}`,
      );
    }
  }
  return {
    surface: isSlackRun ? "slack" : "persist",
    agentSlug: agent_slug,
    scrubPii: isPiiScrubAgent(agent_slug),
    artifactIdDenylist,
    keepEmails: result.egress_email_allowlist,
  };
}

async function threadUsable(tenant_id: string, run_id: string, thread_id: string): Promise<boolean> {
  try {
    return await runMayUseThread(serviceClient(), tenant_id, run_id, thread_id);
  } catch (e) {
    console.warn(`[runner] thread owner check failed for ${run_id}: ${(e as Error).message}`);
    return false;
  }
}

export async function persistTerminal(
  run_id: string,
  agent_slug: string,
  result: DispatcherResult | null,
  error: string | null,
  model: string,
  runPayload?: unknown,
  trigger?: string,
  runTenantId?: string,
): Promise<CompletionAssessment | void> {
  const finished_at = new Date().toISOString();
  let customerSummary: string | null = null;
  let displayScrub: { result: DispatcherResult; opts: ScrubOpts } | null = null;
  let completion: CompletionAssessment = "unknown";
  const update: Record<string, unknown> = {
    finished_at,
  };
  if (error === "run_cancelled") {
    update.status = "cancelled";
    update.error = null;
    update.parse_ok = false;
    update.cost_tokens = 0;
    update.cost_usd = 0;
  } else if (error) {
    update.status = "dispatch_error";
    update.error = error;
    update.parse_ok = false;
    update.cost_tokens = 0;
    update.cost_usd = 0;
    if (result) {
      const storeRawOnError = await shouldStoreRawTranscripts(run_id);
      update.raw_response_text = storeRawOnError ? result.raw_response_text : null;
      update.prompt_snapshot = storeRawOnError ? result.prompt_snapshot : null;
      update.input_tokens = result.usage.input_tokens;
      update.output_tokens = result.usage.output_tokens;
      update.model_used = result.routing?.model ?? model;
    }
    if (isContextLengthError(error)) {
      void logEvent({
        level: "warn",
        source: "runner.context_overflow",
        code: "context_length_exceeded",
        run_id,
        meta: { agent_slug, error_chars: error.length },
      });
    }
  } else if (result) {
    const supersededStrategy = agent_slug === "cgo" &&
      (runPayload as { stage?: unknown } | null)?.stage === "draft_strategy" &&
      !result.parse_ok && result.parse_error === "strategy_superseded";
    completion = await assessRunCompletion({ result, tenantId: runTenantId, runId: run_id, agentSlug: agent_slug, trigger, payload: runPayload });
    update.status = supersededStrategy ? "cancelled" : resultTerminalStatus(result.parse_ok, completion);
    update.error = supersededStrategy ? null : completion === "refused"
      ? REFUSED_COMPLETION_ERROR : terminalErrorForResult(result);
    if (!result.parse_ok && !supersededStrategy) {
      void logEvent({
        level: "warn",
        source: "runner.parse_failed",
        code: "envelope_parse_failed",
        message: result.parse_error ?? "no parse_error diagnostic from engine",
        run_id,
        meta: { agent_slug },
      });
    }
    const storeRaw = await shouldStoreRawTranscripts(run_id);
    update.prompt_snapshot = storeRaw ? result.prompt_snapshot : null;
    update.raw_response_text = storeRaw ? result.raw_response_text : null;
    const promptChars = result.prompt_snapshot?.length ?? 0;
    void logEvent({
      level: promptChars > PROMPT_SNAPSHOT_WARN_CHARS ? "warn" : "info",
      source: "runner.prompt_budget",
      code: "assembled_prompt_size",
      run_id,
      meta: {
        agent_slug,
        prompt_chars: promptChars,
        approx_tokens: Math.round(promptChars / 4),
      },
    });
    update.parsed = result.parsed as object | null;
    update.parse_ok = result.parse_ok;
    update.parse_error = result.parse_error ?? null;
    const isSlackRun = trigger === "slack";
    const leadless = (t: string | null | undefined) =>
      isSlackRun && typeof t === "string" ? stripLeadNarration(t).text : t;
    const egressOpts = await resolveEgressOpts(run_id, agent_slug, trigger, result);
    const egress = scrubAgentEgress(leadless(result.output_text), egressOpts);
    update.output_text = egress.text;
    if (typeof result.customer_summary === "string" && result.customer_summary) {
      customerSummary = scrubAgentEgress(result.customer_summary, egressOpts).text;
    }
    if (hasReplyCards(update.output_text as string | null) || hasReplyCards(customerSummary)) {
      const saveCards =
        trigger === "handoff" &&
        !!runTenantId &&
        typeof (runPayload as { operator_thread_id?: unknown } | null)?.operator_thread_id === "string";
      const state = newReplyCardsState();
      const cardCtx = { tenant_id: runTenantId ?? "", run_id, agent_slug };
      if (typeof update.output_text === "string") {
        update.output_text = (await settleReplyCards(update.output_text, cardCtx, { save: saveCards, state })).text;
      }
      if (customerSummary) {
        customerSummary = (await settleReplyCards(customerSummary, cardCtx, { save: saveCards, state })).text;
      }
    }
    const rawTurns = Array.isArray(result.assistant_turns) ? result.assistant_turns : [];
    if (rawTurns.length >= 2) {
      update.assistant_turns = await Promise.all(
        rawTurns.map(async (turn) => {
          const scrubbed = scrubAgentEgress(leadless(turn), egressOpts).text;
          return hasReplyCards(scrubbed)
            ? (await settleReplyCards(scrubbed, { tenant_id: runTenantId ?? "", run_id, agent_slug })).text
            : scrubbed;
        }),
      );
    }
    update.parsed = scrubParsedOverflow(update.parsed, egressOpts) as object | null;
    {
      const md = (update.parsed as { metadata?: { full_reply_markdown?: unknown } } | null)?.metadata?.full_reply_markdown;
      if (typeof md === "string" && hasReplyCards(md)) {
        const p = update.parsed as { metadata: Record<string, unknown> };
        p.metadata = { ...p.metadata, full_reply_markdown: (await settleReplyCards(md, { tenant_id: runTenantId ?? "", run_id, agent_slug })).text };
      }
    }
    displayScrub = {
      result: { ...result, output_text: typeof update.output_text === "string" ? update.output_text : egress.text, parsed: update.parsed },
      opts: egressOpts,
    };
    if (egress.hits > 0) {
      void logEvent({
        level: "warn",
        source: "runner.egress_firewall",
        code: "backend_info_redacted",
        meta: {
          agent_slug,
          surface: isSlackRun ? "slack" : "persist",
          families: egress.families.join(","),
          count: egress.hits,
          run_id_ref: run_id,
        },
      });
    }
    update.cost_tokens =
      result.usage.input_tokens +
      result.usage.output_tokens +
      (result.usage.cache_creation_input_tokens ?? 0) +
      (result.usage.cache_read_input_tokens ?? 0);
    const effectiveModel = result.routing?.model ?? model;
    update.model_used = effectiveModel;
    update.input_tokens = result.usage.input_tokens;
    update.output_tokens = result.usage.output_tokens;
    update.cache_read_tokens = result.usage.cache_read_input_tokens ?? 0;
    update.cache_creation_tokens = result.usage.cache_creation_input_tokens ?? 0;
    if (result.routing) {
      update.routing_decision = routingDecisionForPersist(result.routing);
    }
    const baseCostUsd =
      typeof result.usage.cost_usd === "number"
        ? result.usage.cost_usd
        : estimateCostUsd(effectiveModel, {
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
            cache_read_input_tokens: result.usage.cache_read_input_tokens,
          });
    update.cost_usd = baseCostUsd + (result.routing?.classifier_cost_usd ?? 0);
    if (typeof result.auth_seat === "string" && result.auth_seat.length > 0) {
      update.auth_seat = result.auth_seat;
    }
    if (result.tool_calls && result.tool_calls.length > 0) {
      update.tool_calls = result.tool_calls.map((tc) => ({
        ...tc,
        input_preview: scrubSecretsFromText(tc.input_preview).scrubbed,
        output_preview: scrubSecretsFromText(tc.output_preview).scrubbed,
      }));
    }
    if (isTopActionRun(runPayload, trigger)) {
      update.settle_at_usage = topActionFiledNothing(runPayload, trigger, result.tool_calls);
    }
    if (result.critic_lanes) {
      update.critic_lanes = result.critic_lanes;
    }
    try {
      const grounding = runGroundingChecks({
        evidence: (result.tool_calls ?? []).map((t) => ({
          name: t.name,
          status: t.status,
          input: t.input_preview,
          output: t.output_preview,
          returned_ids: t.returned_ids,
        })),
        agent_output: result.output_text,
        agentSlug: agent_slug,
        checkTruncatedScope: TRUNCATED_SCOPE_DOMAIN_AGENTS.has(agent_slug),
        checkSelfContradiction: SELF_CONTRADICTION_DOMAIN_AGENTS.has(agent_slug),
      });
      if (grounding.flags.length > 0) {
        update.grounding_flags = grounding.flags;
        const hard = hasHardGroundingFlag(grounding);
        if (hard && GROUNDING_GATE_AGENTS.has(agent_slug)) {
          update.needs_review = true;
        }
        if (hard && runPayload !== undefined && isAutopilotClassRun(runPayload)) {
          update.needs_review = true;
          update.grounding_flags = [
            ...grounding.flags,
            {
              pattern: AUTOPILOT_ENFORCED_FLAG.pattern,
              severity: AUTOPILOT_ENFORCED_FLAG.severity,
              detail: `autopilot decision class (stage=${autopilotStageOf(runPayload) ?? "provision-class"}) held for review — ungrounded stage output must not flow to the next autopilot stage unsupervised`,
            },
          ];
        }
      }
    } catch (e) {
      console.warn(
        `[grounding] check failed for run ${run_id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  let runOutcome = deriveOutcome({
    refused: completion === "refused",
    status: typeof update.status === "string" ? update.status : "failed",
    outputText: typeof update.output_text === "string" ? update.output_text : null,
    error: typeof update.error === "string" ? update.error : null,
    parseError: typeof update.parse_error === "string" ? update.parse_error : null,
    sideEffect: result?.side_effect,
    toolCalls: result?.tool_calls,
    customerSummary,
  });
  update.outcome = runOutcome;

  if (
    process.env.EMPTY_COMPLETION_GUARD_ENABLED !== "false" &&
    update.status === "success" &&
    isReplyExpectingTrigger(trigger) &&
    runOutcome.liveness_tier === "empty"
  ) {
    let decisionCount = -1;
    try {
      const sc = serviceClient();
      let guardTenantId = runTenantId;
      if (!guardTenantId) {
        const { data: tRow } = await sc
          .from("agent_runs")
          .select("tenant_id")
          .eq("id", run_id)
          .maybeSingle<{ tenant_id: string }>();
        guardTenantId = tRow?.tenant_id ?? undefined;
      }
      let q = sc
        .from("decisions")
        .select("id", { count: "exact", head: true })
        .eq("agent_run_id", run_id);
      if (guardTenantId) q = q.eq("tenant_id", guardTenantId);
      const { count, error: cErr } = await q;
      if (!cErr) decisionCount = count ?? 0;
    } catch (e) {
      console.warn(
        `[persistTerminal] empty-completion decision-count read failed for ${run_id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (
      shouldFailEmptyCompletion({
        enabled: true,
        status: update.status,
        trigger,
        livenessTier: runOutcome.liveness_tier,
        decisionCount,
      })
    ) {
      update.status = "failed";
      update.error = EMPTY_COMPLETION_ERROR;
      runOutcome = deriveOutcome({
        status: "failed",
        outputText: typeof update.output_text === "string" ? update.output_text : null,
        error: EMPTY_COMPLETION_ERROR,
        sideEffect: result?.side_effect,
        toolCalls: result?.tool_calls,
        customerSummary,
      });
      update.outcome = runOutcome;
      void logEvent({
        level: "warn",
        source: "runner.empty_completion",
        code: "empty_completion_failed",
        run_id,
        meta: { agent_slug, trigger: trigger ?? "" },
      });
    }
  }

  let pausedForApproval = false;
  if (
    update.status === "success" &&
    runTenantId &&
    isInteractiveResumeTrigger(trigger)
  ) {
    try {
      if (await isApprovePauseResumeEnabled(runTenantId)) {
        const { data: pend } = await serviceClient()
          .from("decisions")
          .select("autonomy_at_emit")
          .eq("tenant_id", runTenantId)
          .eq("agent_run_id", run_id)
          .eq("status", "proposed")
          .eq("autonomy_at_emit", "approval")
          .is("superseded_at", null)
          .or("body->>founder_chat_order.is.null,body->>founder_chat_order.neq.true")
          .limit(1)
          .maybeSingle<{ autonomy_at_emit: string }>();
        if (
          pend &&
          shouldPauseForApproval({ enabled: true, autonomy: pend.autonomy_at_emit })
        ) {
          update.status = PAUSED_AWAITING_APPROVAL;
          pausedForApproval = true;
        }
      }
    } catch (e) {
      console.warn(
        `[persistTerminal] approve-resume pause check failed for ${run_id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  let pausedForChild = false;
  const askedAgent = calledAskAgent(result?.tool_calls);
  if (update.status === "success" && !pausedForApproval && runTenantId && askedAgent) {
    try {
      if (await shouldPauseForChild(serviceClient(), run_id, runTenantId)) {
        update.status = PAUSED_AWAITING_CHILD;
        pausedForApproval = true;
        pausedForChild = true;
      }
    } catch (e) {
      console.warn(
        `[persistTerminal] ask_agent pause check failed for ${run_id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  let deleteCheckpointsAfterWin = false;
  let retentionTenantId: string | null = runTenantId ?? null;
  if (Array.isArray(update.tool_calls) && (update.tool_calls as Array<{ name: string }>).some((tc) => isDbToolName(tc.name))) {
    if (!retentionTenantId) {
      try {
        const { data: tRow } = await serviceClient()
          .from("agent_runs")
          .select("tenant_id")
          .eq("id", run_id)
          .maybeSingle<{ tenant_id: string }>();
        retentionTenantId = tRow?.tenant_id ?? null;
      } catch {
        retentionTenantId = null;
      }
    }
    const scrubbed = await scrubPreviewsForRunEnd(
      retentionTenantId,
      update.tool_calls as Array<{ name: string; output_preview?: string }>,
    );
    update.tool_calls = scrubbed.calls;
    deleteCheckpointsAfterWin = scrubbed.deleteCheckpoints;
  }

  if (!pausedForApproval && (trigger === undefined || trigger === "handoff")) {
    try {
      const { data: hRow } = await serviceClient()
        .from("agent_runs")
        .select("tenant_id, trigger, parent_run_id, payload")
        .eq("id", run_id)
        .maybeSingle<{ tenant_id: string; trigger: string | null; parent_run_id: string | null; payload: Record<string, unknown> | null }>();
      const hp = hRow?.payload;
      if (
        hRow &&
        hRow.trigger === "handoff" &&
        hp &&
        typeof hp.operator_thread_id === "string" &&
        hp.operator_thread_id.length > 0 &&
        !(typeof hp.handoff_batch_id === "string" && hp.handoff_batch_id.length > 0) &&
        !isAskChildPayload(hp) &&
        (await threadUsable(hRow.tenant_id, run_id, hp.operator_thread_id))
      ) {
        const { parentReplyPending, waitForParentReply } = await import("./handoff-result");
        const sb = serviceClient();
        await sb
          .from("agent_runs")
          .update({ last_progress_at: new Date().toISOString() })
          .eq("id", run_id)
          .eq("status", "running");
        const stopRequested = async (): Promise<boolean> => {
          const { data } = await sb
            .from("agent_runs")
            .select("stop_requested")
            .eq("id", run_id)
            .maybeSingle<{ stop_requested: boolean | null }>();
          return data?.stop_requested === true;
        };
        await waitForParentReply(
          async () =>
            !(await stopRequested()) &&
            (await parentReplyPending(sb, hRow.tenant_id, hRow.parent_run_id)),
        );
      }
    } catch {
    }
  }

  const { data: updated, error: dbErr } = await serviceClient()
    .from("agent_runs")
    .update(update)
    .eq("id", run_id)
    .eq("status", "running")
    .select("id, payload, cost_usd, tenant_id, trigger, infra_retry_count, last_progress_at");
  if (dbErr) {
    throw new Error(`persistTerminal failed for ${run_id}: ${dbErr.message}`);
  }
  const billedCostUsd = Number((updated?.[0] as { cost_usd?: unknown } | undefined)?.cost_usd);
  if (Number.isFinite(billedCostUsd)) update.cost_usd = billedCostUsd;
  if (!updated || updated.length === 0) {
    const { data: winner, error: winnerError } = await serviceClient()
      .from("agent_runs").select("status, outcome").eq("id", run_id).single();
    if (winnerError || !winner) throw new Error("Could not read the persisted run completion");
    completion = winner.status === "failed" && winner.outcome?.failure?.class === "policy_refusal"
      ? "refused" : "not_refused";
    try {
      const sbSafety = serviceClient();
      const { data: existing } = await sbSafety
        .from("thread_event")
        .select("id")
        .eq("agent_run_id", run_id)
        .eq("kind", "run_end")
        .limit(1);
      if (!existing || existing.length === 0) {
        const { data: row } = await sbSafety
          .from("agent_runs")
          .select("tenant_id, payload, status")
          .eq("id", run_id)
          .single();
        if (row?.status === PAUSED_AWAITING_APPROVAL || row?.status === PAUSED_AWAITING_CHILD) {
          return "not_refused";
        }
        if (row?.tenant_id) {
          const safetyThreadId =
            row.payload && typeof row.payload === "object"
              ? (((row.payload as { thread_id?: unknown }).thread_id as
                  | string
                  | undefined) ?? null)
              : null;
          await emitThreadEvent({
            agent_run_id: run_id,
            agent_slug,
            tenant_id: row.tenant_id,
            thread_id: safetyThreadId,
            kind: "run_end",
            body: { status: "error", cost_usd: null },
          });
        }
      }
    } catch (e) {
      console.warn(
        `[persistTerminal] CAS-lost safety-net run_end emit failed for ${run_id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    return completion;
  }

  try {
    const won = updated[0] as {
      tenant_id?: string;
      trigger?: string | null;
      infra_retry_count?: number | null;
      last_progress_at?: string | null;
    };
    const wonTenant = won.tenant_id ?? runTenantId ?? "";
    if (wonTenant) {
      await emitTeamNoteRunEnd({
        runId: run_id,
        tenantId: wonTenant,
        agentSlug: agent_slug,
        trigger: won.trigger ?? trigger ?? null,
        paused: pausedForApproval,
        status: typeof update.status === "string" ? update.status : "dispatch_error",
        error: typeof update.error === "string" ? update.error : null,
        willRetry:
          !result &&
          willBeInfraRetried({
            id: run_id,
            tenant_id: wonTenant,
            agent_slug,
            status: (update.status as string | undefined) ?? "dispatch_error",
            error: error ?? null,
            infra_retry_count: won.infra_retry_count ?? 0,
            last_progress_at: won.last_progress_at ?? null,
          }),
        toolCalls: result?.tool_calls,
        groundingFlags: update.grounding_flags as
          | Array<{ pattern?: string; severity?: string }>
          | undefined,
        operatorShapes: result?.operator_failure_shapes,
      });
    }
  } catch (e) {
    console.warn(
      `[persistTerminal] team-note emit failed for ${run_id}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  const wonRow = updated[0] as { payload?: unknown; tenant_id?: string };
  const conductorKicked =
    !pausedForApproval &&
    (await requestTickForFinishedChild(
      inngest,
      isActiveConductorRun,
      wonRow.payload,
      wonRow.tenant_id ?? runTenantId ?? "",
    ));

  if (deleteCheckpointsAfterWin) {
    await deleteCheckpointsAtRunEnd(
      (updated[0] as { tenant_id?: string }).tenant_id ?? retentionTenantId ?? null,
      run_id,
      typeof update.status === "string" ? update.status : null,
    );
  }

  track("agent_run_finished", {
    tenant_id: runTenantId,
    agent_slug,
    trigger,
    status: String(update.status),
    cost_usd: typeof update.cost_usd === "number" ? update.cost_usd : undefined,
  });

  logReview({
    feature: "liveness_tier",
    event: "classified",
    outcome: runOutcome.liveness_tier,
    run_id,
    meta: { agent_slug },
  });

  if (result) {
    const reqId = (
      (updated[0]?.payload ?? null) as { clarification_response?: { request_id?: unknown } } | null
    )?.clarification_response?.request_id;
    if (typeof reqId === "string") {
      const { error: consumeErr } = await serviceClient()
        .from("agent_clarification_responses")
        .update({ status: "consumed", updated_at: new Date().toISOString() })
        .eq("request_id", reqId)
        .eq("consuming_run_id", run_id)
        .neq("status", "consumed");
      if (consumeErr) {
        console.warn(
          `clarification consume hook failed for run ${run_id}: ${consumeErr.message}`,
        );
      }
    }
  }

  try {
    const sbPromote = serviceClient();
    const { data: tRow } = await sbPromote
      .from("agent_runs")
      .select("tenant_id, payload, batch_id, child_index, status, trigger")
      .eq("id", run_id)
      .single();
    const tTrigger = (tRow?.trigger as string | null) ?? "";
    const tThreadId =
      tTrigger === "chat" && tRow?.payload && typeof tRow.payload === "object"
        ? (((tRow.payload as { thread_id?: unknown }).thread_id as
            | string
            | undefined) ?? null)
        : null;
    const tTenant = tRow?.tenant_id as string | undefined;
    const tBatchId =
      typeof tRow?.batch_id === "string" && tRow.batch_id.length > 0
        ? (tRow.batch_id as string)
        : null;
    const tChildIndex =
      typeof tRow?.child_index === "number" ? (tRow.child_index as number) : null;
    const terminalStatus = (tRow?.status as string) ?? "";

    let shouldPromoteThread = true;
    if (tBatchId && tChildIndex != null && tTenant) {
      try {
        const pr_url =
          tRow?.payload && typeof tRow.payload === "object"
            ? ((tRow.payload as { pr_url?: unknown }).pr_url as
                | string
                | undefined) ?? null
            : null;
        const rollup = await recordChildTerminalAndCheckBatch({
          run_id,
          tenant_id: tTenant,
          batch_id: tBatchId,
          child_index: tChildIndex,
          status: terminalStatus,
          pr_url,
        });
        shouldPromoteThread = rollup.batch_complete;
      } catch (e) {
        console.warn(
          `[persistTerminal] batch rollup threw (batch=${tBatchId}, child=${tChildIndex}): ${(e as Error).message}`,
        );
        shouldPromoteThread = true;
      }
    }

    let steerRerouted = false;
    if (tThreadId && tTenant && !pausedForApproval) {
      try {
        const { data: rerouted, error: rerouteErr } = await sbPromote.rpc(
          "reroute_undrained_steers",
          { p_run_id: run_id, p_tenant_id: tTenant },
        );
        const verdict = rerouted as {
          rerouted?: number;
          run_id?: string;
          reason?: string;
          leased_count?: number;
        } | null;
        if (rerouteErr) {
          console.warn(
            `[persistTerminal] reroute_undrained_steers failed (run=${run_id}): ${rerouteErr.message}`,
          );
        } else if (verdict?.run_id && (verdict.rerouted ?? 0) > 0) {
          steerRerouted = true;
          if ((verdict.leased_count ?? 0) > 0) {
            void logEvent({
              level: "warn",
              source: "agent.barge_in",
              code: "steer_reroute_leased",
              run_id,
              tenant_id: tTenant,
              meta: { count: verdict.leased_count },
            });
          }
          await inngest.send(
            await buildRunRequestedEventForRunId(sbPromote, verdict.run_id, {
              tenant_id: tTenant,
            }),
          );
        } else if (
          verdict?.reason === "thread_gone" ||
          verdict?.reason === "reserve_failed" ||
          verdict?.reason === "no_user_message"
        ) {
          void logEvent({
            level: "warn",
            source: "agent.barge_in",
            code: "steer_dead_lettered",
            run_id,
            tenant_id: tTenant,
            meta: { dead_letter_reason: verdict.reason },
          });
        }
      } catch (e) {
        console.warn(
          `[persistTerminal] steer reroute threw (run=${run_id}): ${(e as Error).message}`,
        );
      }
    }

    if (shouldPromoteThread && !pausedForApproval && !steerRerouted && tThreadId && tTenant) {
      const { data: promotedId, error: promoteErr } = await sbPromote.rpc(
        "promote_next_blocked_run",
        { p_tenant_id: tTenant, p_thread_id: tThreadId },
      );
      if (promoteErr) {
        console.warn(
          `[persistTerminal] promote_next_blocked_run failed (thread=${tThreadId}): ${promoteErr.message}`,
        );
      } else if (promotedId) {
        await inngest.send(
          await buildRunRequestedEventForRunId(sbPromote, promotedId as string, {
            tenant_id: tTenant,
          }),
        );
      }
    }
  } catch (e) {
    console.warn(
      `[persistTerminal] blocked-run promotion threw: ${(e as Error).message}`,
    );
  }

  if (result) {
    try {
      const sbOpen = serviceClient();
      const { data: oaRow } = await sbOpen
        .from("agent_runs")
        .select("tenant_id, payload")
        .eq("id", run_id)
        .maybeSingle<{ tenant_id: string; payload: unknown }>();
      const oaTenant = oaRow?.tenant_id;
      const oaThread =
        oaRow?.payload && typeof oaRow.payload === "object"
          ? (((oaRow.payload as { thread_id?: unknown }).thread_id as
              | string
              | undefined) ?? null)
          : null;
      if (oaTenant && oaThread) {
        const captured = parseOpenActionsFromEnvelope(result.open_actions);
        if (captured.length > 0) {
          await persistOpenActions({
            sb: sbOpen,
            tenant_id: oaTenant,
            thread_id: oaThread,
            agent_slug,
            source_run_id: run_id,
            actions: captured,
          });
        }
        const { data: decRows } = await sbOpen
          .from("decisions")
          .select("id")
          .eq("agent_run_id", run_id)
          .limit(1);
        if (decRows && decRows.length > 0) {
          await resolveOldestOpenUrgentOnProposal({
            sb: sbOpen,
            tenant_id: oaTenant,
            thread_id: oaThread,
            agent_slug,
          });
        }
      }
    } catch (e) {
      console.warn(
        `[persistTerminal] open-actions ledger threw: ${(e as Error).message}`,
      );
    }
  }

  if (result && agent_slug === "advisor" && result.parse_ok && result.parsed) {
    try {
      const sbAdv = serviceClient();
      const { data: advRow } = await sbAdv
        .from("agent_runs")
        .select("tenant_id, payload")
        .eq("id", run_id)
        .maybeSingle<{ tenant_id: string; payload: unknown }>();
      const advTenant = advRow?.tenant_id;
      const advThread =
        advRow?.payload && typeof advRow.payload === "object"
          ? (((advRow.payload as { thread_id?: unknown }).thread_id as
              | string
              | undefined) ?? null)
          : null;
      if (advTenant) {
        const closes = parseCloseRecommendationsFromEnvelope(result.parsed);
        if (closes.length > 0) {
          await closeAdvisorRecommendations({
            sb: sbAdv,
            tenant_id: advTenant,
            resolved_run_id: run_id,
            closes,
          });
        }
        const items = parseDecideTodayForLedger(result.parsed);
        if (items.length > 0) {
          await persistAdvisorRecommendations({
            sb: sbAdv,
            tenant_id: advTenant,
            thread_id: advThread,
            source_run_id: run_id,
            items,
          });
        }
      }
    } catch (e) {
      console.warn(
        `[persistTerminal] advisor recommendation ledger threw: ${(e as Error).message}`,
      );
    }
  }

  try {
    const { data: runRow, error: lookupErr } = await serviceClient()
      .from("agent_runs")
      .select(
        "agent_slug, tenant_id, trigger, channel_slug, started_at, payload, infra_retry_count, last_progress_at, custom_agent_id, custom_trigger_id",
      )
      .eq("id", run_id)
      .single();
    if (lookupErr || !runRow) {
      throw new Error(lookupErr?.message ?? "run row not found post-update");
    }
    const agent_slug = runRow.agent_slug as string;
    const tenant_id = runRow.tenant_id as string;
    const trigger = (runRow.trigger as string | null) ?? "manual";
    const payloadThreadId =
      runRow.payload && typeof runRow.payload === "object"
        ? (((runRow.payload as { thread_id?: unknown }).thread_id as
            | string
            | undefined) ?? null)
        : null;
    const thread_id =
      payloadThreadId && (await threadUsable(tenant_id, run_id, payloadThreadId)) ? payloadThreadId : null;
    const started_at =
      (runRow.started_at as string | null) ?? new Date().toISOString();
    let envelopeName: string | undefined;
    try {
      const def = await loadAgentDefinition(agent_slug, tenant_id);
      envelopeName = def?.metadata_praxis?.output_envelope ?? undefined;
    } catch {
      envelopeName = undefined;
    }

    try {
      const { writeMemorySignal } = await import("@/services/memory/write-signal");
      await writeMemorySignal({
        run_id,
        row: { agent_slug, tenant_id, trigger, started_at, finished_at, payload: runRow.payload },
        update,
        failureShapes: result?.operator_failure_shapes,
      });
    } catch (e) {
      console.warn(
        `[runner] memory_signal write failed for ${run_id}: ${(e as Error).message}`,
      );
    }

    if (result || error) {
      const { data: existing } = await serviceClient()
        .from("thread_event")
        .select("id")
        .eq("agent_run_id", run_id)
        .eq("kind", "chat_assistant")
        .limit(1)
        .maybeSingle();

      if (!existing) {
        let bodyText: string;
        let empty = false;
        let shouldEmit = true;

        if (result) {
          const shownOpts: ScrubOpts =
            displayScrub?.opts ?? (await resolveEgressOpts(run_id, agent_slug, trigger, result));
          const emit = selectTerminalChatEmit({
            result: displayScrub?.result ?? result,
            agentSlug: agent_slug,
            envelopeName,
            trigger,
          });
          bodyText = scrubAgentEgress(emit.bodyText, shownOpts).text;
          empty = emit.empty;
          shouldEmit = emit.shouldEmit;
        } else if (error === "run_cancelled") {
          bodyText = "Stopped.";
          empty = false;
          shouldEmit = trigger === "chat";
        } else {
          const { chatFailureBubbleBody } = await import("./error-body");
          bodyText = chatFailureBubbleBody(error, agent_slug);
          empty = false;
          shouldEmit = true;
        }

        if (shouldEmit) {
          await emitThreadEvent({
            agent_run_id: run_id,
            agent_slug,
            tenant_id,
            thread_id,
            kind: "chat_assistant",
            body: {
              text: bodyText.slice(0, 8000),
              agent_run_id: run_id,
              meta: {
                trigger,
                started_at,
                ...(empty ? { empty: true } : {}),
              },
            },
          });
        }

        if (
          !result &&
          error !== "run_cancelled" &&
          trigger === "chat" &&
          thread_id &&
          !willBeInfraRetried({
            id: run_id,
            tenant_id,
            agent_slug,
            status: (update.status as string | undefined) ?? "dispatch_error",
            error: error ?? null,
            infra_retry_count:
              (runRow.infra_retry_count as number | null) ?? 0,
            last_progress_at:
              (runRow.last_progress_at as string | null) ?? null,
          })
        ) {
          const { error: bubbleErr } = await serviceClient().rpc(
            "record_agent_chat_reply",
            {
              p_thread_id: thread_id,
              p_tenant_id: tenant_id,
              p_expected_agent_slug: agent_slug,
              p_run_id: run_id,
              p_body: bodyText.slice(0, 8000),
              p_meta: {
                trigger,
                is_error: true,
                failure_class: isUsageLimitError(error) ? "usage_limit" : "error",
              },
            },
          );
          if (bubbleErr) {
            console.warn(
              `[runner] chat failure-bubble write failed for ${run_id}: ${bubbleErr.message}`,
            );
          }
        }

        if (!result && error === "run_cancelled" && trigger === "chat" && thread_id) {
          const { error: bubbleErr } = await serviceClient().rpc(
            "record_agent_chat_reply",
            {
              p_thread_id: thread_id,
              p_tenant_id: tenant_id,
              p_expected_agent_slug: agent_slug,
              p_run_id: run_id,
              p_body: bodyText,
              p_meta: {
                trigger,
                stopped: true,
              },
            },
          );
          if (bubbleErr) {
            console.warn(
              `[runner] chat stopped-bubble write failed for ${run_id}: ${bubbleErr.message}`,
            );
          }
        }
      }
    }

    const status: "success" | "error" | "failed" | "cancelled" =
      update.status === "success"
        ? "success"
        : update.status === "parse_failed"
          ? "failed"
          : update.status === "cancelled"
            ? "cancelled"
            : "error";
    const cost_usd =
      typeof update.cost_usd === "number" ? update.cost_usd : null;
    const answered = runHasDeliverable({
      status: typeof update.status === "string" ? update.status : null,
      outcome: (update.outcome as { deliverable?: string | null } | null) ?? null,
      outputText: typeof update.output_text === "string" ? update.output_text : null,
    });
    const question = result?.clarify_envelope != null;
    const endTrigger = runEndTrigger(trigger, runRow.payload);
    if (!pausedForApproval) {
      await emitThreadEvent({
        agent_run_id: run_id,
        agent_slug,
        tenant_id,
        thread_id,
        kind: "run_end",
        body: { status, cost_usd, answered, trigger: endTrigger, question },
      });
    }

    if (!pausedForApproval && !conductorKicked) {
      await requestTickForFinishedChild(inngest, isActiveConductorRun, runRow.payload, tenant_id);
    }

    if (runRow.channel_slug || trigger === "channel_recipe") {
      try {
        const reflected = await tenantRpc(asTenantId(tenant_id), "record_channel_run", {
          p_run_id: run_id,
        });
        if (reflected.error) throw new Error(reflected.error.message);
      } catch (e) {
        console.warn(
          `[runner] record_channel_run failed for ${run_id}: ${(e as Error).message}`,
        );
      }
    }

    const askChild = isAskChildPayload(runRow.payload);
    if (!pausedForApproval && !askChild && trigger === "handoff" && runRow.payload && typeof runRow.payload === "object") {
      const handoffPayload = runRow.payload as {
        operator_thread_id?: string;
        handoff_batch_id?: string;
      };
      const isBatchChild =
        typeof handoffPayload.handoff_batch_id === "string" &&
        handoffPayload.handoff_batch_id.length > 0;
      if (
        !isBatchChild &&
        typeof handoffPayload.operator_thread_id === "string" &&
        handoffPayload.operator_thread_id.length > 0 &&
        (await threadUsable(tenant_id, run_id, handoffPayload.operator_thread_id))
      ) {
        const { postHandoffResultToOperatorThread } = await import("./handoff-result");
        const { buildDelegatedChildResult } = await import("./delegation-result-schema");
        const sb = serviceClient();
        const parseFailed = update.status === "parse_failed";
        const handoffStatus: "success" | "error" | "failed" =
          status === "cancelled" ? "error" : status;
        const childResult = buildDelegatedChildResult({
          run_id,
          agent_slug,
          status: parseFailed ? "parse_failed" : handoffStatus,
          result,
          error: typeof update.error === "string"
            ? update.error
            : typeof update.parse_error === "string"
              ? update.parse_error
              : null,
        });
        const handoffThreadId = handoffPayload.operator_thread_id;
        const handoffPosted = await postHandoffResultToOperatorThread(
          {
            tenant_id,
            run_id,
            operator_thread_id: handoffPayload.operator_thread_id,
            from_agent_slug: agent_slug,
            status: handoffStatus,
            parse_failed: parseFailed,
            output_text:
              typeof update.output_text === "string" && update.output_text.length > 0
                ? update.output_text
                : childResult.output_text,
            raw_response_text: result?.raw_response_text
              ? scrubAgentEgress(result.raw_response_text, {
                  surface: "persist",
                  agentSlug: agent_slug,
                  scrubPii: isPiiScrubAgent(agent_slug),
                  keepEmails: result?.egress_email_allowlist,
                }).text
              : null,
            error: childResult.error,
            outcome: (update.outcome as RunOutcome | null | undefined) ?? null,
            parsed:
              result?.parsed && typeof result.parsed === "object"
                ? (result.parsed as Record<string, unknown>)
                : null,
            payload: runRow.payload as Record<string, unknown>,
            evidence: { receipts: childResult.receipts },
          },
          async (p) => {
            const { error } = await sb.rpc("record_handoff_chat_message", p);
            return { error: error as { message: string; code?: string } | null };
          },
        );
        if (handoffPosted) {
          void notifyThreadOwner({
            tenant_id,
            thread_id: handoffThreadId,
            agent_slug,
            body: `${agentDisplayName(agent_slug)} answered your question.`,
          }).catch(() => {});
        }
      }
    }

    if (
      !pausedForApproval &&
      trigger === "cron" &&
      runRow.payload &&
      typeof runRow.payload === "object" &&
      (runRow.payload as { reminder?: unknown }).reminder
    ) {
      try {
        const { deliverReminderRun } = await import("./reminders");
        const { chatFailureBubbleBody } = await import("./error-body");
        const { reminderDeliveryDeps } = await import("./reminder-delivery-deps");
        const rawError = typeof update.error === "string" ? update.error : null;
        const deliveryErr = await deliverReminderRun(
          {
            tenant_id,
            status,
            output_text:
              (result?.output_text && result.output_text.length > 0
                ? hasReplyCards(result.output_text) && typeof update.output_text === "string"
                  ? update.output_text
                  : result.output_text
                : result?.raw_response_text) ?? null,
            safe_error: rawError ? chatFailureBubbleBody(rawError, agent_slug) : null,
            payload: runRow.payload,
          },
          reminderDeliveryDeps({
            scrub: (text: string) =>
              scrubAgentEgress(text, {
                surface: "persist",
                agentSlug: agent_slug,
                scrubPii: isPiiScrubAgent(agent_slug),
              }).text,
            threadMeta: { agent_run_id: run_id, from_agent_slug: agent_slug },
          }),
        );
        if (deliveryErr) {
          const { isReminderDefer } = await import("./reminder-delivery-deps");
          console.error(
            isReminderDefer(deliveryErr)
              ? `[runner] reminder delivery DEFERRED after the run completed — the row is already closed and this output is lost run=${run_id}: ${deliveryErr}`
              : `[runner] reminder delivery failed run=${run_id}: ${deliveryErr}`,
          );
        }
      } catch (e) {
        console.warn(`[runner] reminder delivery threw run=${run_id}: ${(e as Error).message}`);
      }
    }

    if (
      !pausedForApproval &&
      (trigger === "cron" || trigger === "channel_recipe") &&
      runRow.payload &&
      typeof runRow.payload === "object" &&
      (runRow.payload as { standing_order?: unknown }).standing_order
    ) {
      try {
        const { deliverStandingOrderResult, standingOrderThreadOwners } = await import(
          "./standing-orders"
        );
        const { callMcpTool } = await import("@/services/mcp/execute");
        const sb = serviceClient();
        const deliveryErr = await deliverStandingOrderResult(
          {
            tenant_id,
            run_id,
            status,
            output_text:
              (result?.output_text && result.output_text.length > 0
                ? hasReplyCards(result.output_text) && typeof update.output_text === "string"
                  ? update.output_text
                  : result.output_text
                : result?.raw_response_text) ?? null,
            error: typeof update.error === "string" ? update.error : null,
            payload: runRow.payload,
            agent_slug,
          },
          {
            scrub: (text) =>
              scrubAgentEgress(text, {
                surface: "persist",
                agentSlug: agent_slug,
                scrubPii: isPiiScrubAgent(agent_slug),
              }).text,
            postToEmail: async (p) => {
              const { sendAgentResultEmail } = await import("@/email/sendAgentResult");
              const r = await sendAgentResultEmail({
                tenant_id: p.tenant_id,
                run_id: p.run_id,
                agent_slug: p.agent_slug,
                body: p.body,
              });
              return r.sent ? null : r.reason;
            },
            postToThread: async (p) => {
              const { data: thread } = await sb
                .from("agent_threads")
                .select("id")
                .eq("id", p.thread_id)
                .eq("tenant_id", p.tenant_id)
                .in("agent_slug", standingOrderThreadOwners(agent_slug))
                .maybeSingle();
              if (!thread) return "destination thread not found for tenant";
              const { error: insErr } = await sb.from("agent_thread_messages").insert({
                thread_id: p.thread_id,
                tenant_id: p.tenant_id,
                sender_role: "assistant",
                body: p.body,
                agent_run_id: p.run_id,
                meta: { from_agent_slug: agent_slug, standing_order: true },
              });
              if (insErr) return insErr.message;
              await sb
                .from("agent_threads")
                .update({ last_message_at: new Date().toISOString() })
                .eq("id", p.thread_id);
              void notifyThreadOwner({
                tenant_id: p.tenant_id,
                thread_id: p.thread_id,
                agent_slug,
                body: "Zavi posted a new message.",
              }).catch(() => {});
              return null;
            },
            postToSlack: async (p) => {
              const r = await callMcpTool(
                { tenant_id: p.tenant_id, run_id: p.run_id },
                "slack",
                "post_message",
                { channel_id: p.channel_id, text: p.text },
              );
              return r.is_error ? String(r.content).slice(0, 500) : null;
            },
          },
        );
        if (deliveryErr) {
          console.warn(
            `[runner] standing-order delivery failed for ${run_id}: ${deliveryErr}`,
          );
        }
      } catch (e) {
        console.warn(
          `[runner] standing-order delivery threw for ${run_id}: ${(e as Error).message}`,
        );
      }
    }

    if (
      !pausedForApproval &&
      trigger === "cron" &&
      isCustomAgentSlug(agent_slug)
    ) {
      try {
        const { finishCustomAgentRunProd, setupBlockKey } = await import("./custom-agent-runs");
        await finishCustomAgentRunProd(
          {
            tenant_id,
            run_id,
            agent_slug,
            custom_agent_id: typeof runRow.custom_agent_id === "string" ? runRow.custom_agent_id : null,
            custom_trigger_id: typeof runRow.custom_trigger_id === "string" ? runRow.custom_trigger_id : null,
            payload: runRow.payload,
            status,
            setup_required: setupBlockKey(result?.parsed),
            output_text:
              (result?.output_text && result.output_text.length > 0
                ? hasReplyCards(result.output_text) && typeof update.output_text === "string"
                  ? update.output_text
                  : result.output_text
                : result?.raw_response_text) ?? null,
            error: typeof update.error === "string" ? update.error : null,
            will_retry:
              status !== "success" &&
              willBeInfraRetried({
                id: run_id,
                tenant_id,
                agent_slug,
                status: (update.status as string | undefined) ?? "dispatch_error",
                error: typeof update.error === "string" ? update.error : null,
                infra_retry_count: (runRow.infra_retry_count as number | null) ?? 0,
                last_progress_at: (runRow.last_progress_at as string | null) ?? null,
              }),
          },
          (text: string) =>
            scrubAgentEgress(text, {
              surface: "persist",
              agentSlug: agent_slug,
              scrubPii: isPiiScrubAgent(agent_slug),
            }).text,
          agent_slug,
        );
      } catch (e) {
        console.warn(`[runner] custom agent finish threw run=${run_id}: ${(e as Error).message}`);
      }
    }

    if (!pausedForApproval && status === "success" && result) {
      try {
        if (trigger === "chat") {
          await inngest.send({
            name: "chat.turn_complete",
            data: { run_id, tenant_id, agent_slug },
          });
        } else if ((result.output_text?.length ?? 0) > 50 || queuedMemoryProposal(result.tool_calls)) {
          await inngest.send({
            name: "agent.run.distillable",
            data: { run_id, tenant_id, agent_slug },
          });
        }
      } catch (e) {
        console.warn(
          `[runner] failed to fire distill event for ${run_id}: ${(e as Error).message}`,
        );
      }
    }

    if (
      pausedForApproval &&
      !pausedForChild &&
      (trigger === "telegram" || trigger === "discord" || trigger === "whatsapp" || trigger === "imessage")
    ) {
      void notifyChatApprovalPending({ trigger, payload: runPayload, tenant_id }).catch(
        () => {},
      );
    }
    if (pausedForApproval && !pausedForChild && trigger === "slack" && tenant_id) {
      void postSlackApprovalsOnPause({ tenant_id, run_id }).catch(() => {});
    }
    if (
      !pausedForApproval &&
      !askChild &&
      (trigger === "slack" ||
        trigger === "email" ||
        trigger === "teams" ||
        trigger === "telegram" ||
        trigger === "discord" ||
        trigger === "whatsapp" ||
        trigger === "imessage") &&
      update.status !== "cancelled"
    ) {
      try {
        await inngest.send({
          name: "agent.run.completed",
          data: {
            run_id,
            tenant_id,
            agent_slug,
            status: update.status as
              | "success"
              | "parse_failed"
              | "failed"
              | "dispatch_error",
          },
        });
      } catch (e) {
        console.warn(
          `[runner] failed to fire agent.run.completed for ${run_id}: ${(e as Error).message}`,
        );
      }
    }

    if (askChild) {
      try {
        await inngest.send({
          name: "agent.child.completed",
          data: { child_run_id: run_id },
        });
      } catch (e) {
        console.warn(
          `[runner] failed to fire agent.child.completed for ${run_id}: ${(e as Error).message}`,
        );
      }
    }
    if (askedAgent) {
      try {
        await onParentSettled(run_id, tenant_id, {
          svc: serviceClient(),
          enqueue: enqueueAgentRun,
          sendEvent: (evt) => inngest.send(evt as never),
        });
      } catch (e) {
        console.warn(
          `[runner] ask_agent parent settle failed for ${run_id}: ${(e as Error).message}`,
        );
      }
    }

  } catch (e) {
    console.warn(
      `[runner] failed to emit terminal thread_events for ${run_id}: ${(e as Error).message}`,
    );
  }

  return completion;
}

export async function scanRecentRuns(
  tenant_id: string,
  windowHours: number,
): Promise<AgentRunSummary[]> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("id, agent_slug, tenant_id, finished_at, status, output_text")
    .eq("tenant_id", tenant_id)
    .gte("finished_at", cutoff)
    .order("finished_at", { ascending: false })
    .limit(100);
  if (error) {
    throw new Error(`scanRecentRuns failed for ${tenant_id}: ${error.message}`);
  }
  return ((data ?? []) as Array<{ id: string; agent_slug: string; tenant_id: string; finished_at: string; status: string; output_text: string }>).map((r) => ({
    id: r.id,
    agent_slug: r.agent_slug,
    tenant_id: r.tenant_id,
    finished_at: r.finished_at,
    status: r.status as AgentRunSummary["status"],
    output_text: r.output_text ?? "",
  }));
}

export type AgentRunReadOpts = { includeRawArtifacts?: boolean };

const AGENT_RUN_BASE_COLUMNS =
  "id, agent_slug, tenant_id, agent_definition_path, agent_definition_hash, trigger, started_at, enqueued_at, finished_at, status, payload, parsed, parse_ok, parse_error, output_text, cost_tokens, cost_usd, tool_calls, error, outcome";
const AGENT_RUN_RAW_COLUMNS = ", prompt_snapshot, raw_response_text";

function agentRunColumns(includeRaw: boolean): string {
  return includeRaw
    ? AGENT_RUN_BASE_COLUMNS + AGENT_RUN_RAW_COLUMNS
    : AGENT_RUN_BASE_COLUMNS;
}

export async function listAgentRuns(args: {
  agent_slug?: string;
  tenant_id?: string;
  limit?: number;
  includeRawArtifacts?: boolean;
}): Promise<AgentRun[]> {
  const includeRaw = args.includeRawArtifacts === true;
  let q = serviceClient().from("agent_runs").select(agentRunColumns(includeRaw));
  if (args.agent_slug) q = q.eq("agent_slug", args.agent_slug);
  if (args.tenant_id) q = q.eq("tenant_id", args.tenant_id);
  q = q.order("enqueued_at", { ascending: false }).limit(args.limit ?? 100);
  const { data, error } = await q;
  if (error) {
    throw new Error(`listAgentRuns failed: ${error.message}`);
  }
  return (data ?? []).map((row) =>
    mapRowToAgentRun(row as unknown as Record<string, unknown>, {
      includeRawArtifacts: includeRaw,
    }),
  );
}

export async function readRunStatusAndTenant(
  run_id: string,
): Promise<{ status: string; tenant_id: string } | null> {
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("status, tenant_id")
    .eq("id", run_id)
    .maybeSingle();
  if (error) throw new Error(`agent_runs read failed: ${error.message}`);
  const row = data as { status?: string; tenant_id?: string } | null;
  return row?.status && row.tenant_id ? { status: row.status, tenant_id: row.tenant_id } : null;
}

export async function getAgentRunById(
  tid: TenantId,
  run_id: string,
  opts: AgentRunReadOpts = {},
): Promise<AgentRun | null> {
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select(agentRunColumns(opts.includeRawArtifacts === true))
    .eq("id", run_id)
    .eq("tenant_id", tid)
    .maybeSingle();
  if (error) {
    throw new Error(`getAgentRunById failed: ${error.message}`);
  }
  if (!data) return null;
  return mapRowToAgentRun(data as unknown as Record<string, unknown>, opts);
}

export async function canCurrentUserReadRun(
  userId: string,
  runId: string,
): Promise<boolean> {
  return canUserAccessAgentRun(serviceClient(), userId, runId, { read: true });
}

function mapRowToAgentRun(
  row: Record<string, unknown>,
  opts: AgentRunReadOpts = {},
): AgentRun {
  const includeRaw = opts.includeRawArtifacts === true;
  return {
    id: row.id as string,
    agent_slug: row.agent_slug as string,
    tenant_id: row.tenant_id as string,
    agent_definition_path: (row.agent_definition_path as string) ?? "",
    agent_definition_hash: (row.agent_definition_hash as string) ?? "",
    trigger: row.trigger as AgentTrigger,
    started_at: (row.started_at as string) ?? (row.enqueued_at as string),
    finished_at: (row.finished_at as string) ?? "",
    status: row.status as AgentRun["status"],
    input_payload_raw: row.payload ?? null,
    prompt_snapshot: includeRaw ? ((row.prompt_snapshot as string) ?? "") : "",
    raw_response_text: includeRaw ? ((row.raw_response_text as string) ?? "") : "",
    parsed: row.parsed ?? null,
    parse_ok: (row.parse_ok as boolean) ?? false,
    parse_error: (row.parse_error as string) ?? undefined,
    output_text: (row.output_text as string) ?? "",
    decisions_emitted: [],
    cost_tokens: (row.cost_tokens as number) ?? 0,
    cost_usd: Number(row.cost_usd ?? 0),
    tool_calls: ((row.tool_calls as unknown) as ToolCallTrace[] | undefined) ?? undefined,
    error: (row.error as string) ?? undefined,
    outcome: ((row.outcome as RunOutcome | null) ?? null),
    presentation_status: presentationStatus({
      status: row.status as string | null,
      outcome: row.outcome as { deliverable?: string | null } | null,
      outputText: row.output_text as string | null,
    }),
  };
}

import { isAgentKilled as _isAgentKilled } from "./kill-switch";
import {
  buildRunRequestedEvent,
  buildRunRequestedEventForRunId,
} from "./run-lane";
import { notifyFounderActivity, paywallFounderEvent } from "@/services/tenants/founder-activity-alert";
const isAgentKilled = _isAgentKilled;
export { isAgentKilled };

const PERSON_TRIGGERS: ReadonlySet<string> = new Set([
  "manual", "chat", "slack", "mcp", "email", "teams", "whatsapp", "telegram", "discord", "imessage", "playbook",
]);

async function recordEnqueueRejection(args: {
  tenant_id: string;
  agent_slug: string;
  reason: string;
  payload: unknown;
  trigger: AgentTrigger;
}): Promise<void> {
  if (
    PERSON_TRIGGERS.has(args.trigger) &&
    (args.reason === "insufficient_credits" ||
      args.reason === "build_credits_exhausted" ||
      args.reason === "plan_upgrade_required")
  ) {
    void notifyFounderActivity({
      event: paywallFounderEvent(args.reason),
      tenant_id: args.tenant_id,
      details: { refused: args.reason, agent: args.agent_slug, trigger: args.trigger },
    });
  }
  track("agent_run_rejected", {
    tenant_id: args.tenant_id,
    agent_slug: args.agent_slug,
    reason: args.reason,
    trigger: args.trigger,
  });
  try {
    const fingerprint = createHash("md5")
      .update(JSON.stringify(args.payload ?? null))
      .digest("hex");
    const { error } = await serviceClient().from("enqueue_rejections").insert({
      tenant_id: args.tenant_id,
      agent_slug: args.agent_slug,
      rejection_reason: args.reason,
      body_fingerprint: fingerprint,
      trigger: args.trigger,
    });
    if (error) {
      console.warn(
        `[runner] enqueue_rejections insert failed for ${args.agent_slug}: ${error.message}`,
      );
    }
  } catch (e) {
    console.warn(
      `[runner] recordEnqueueRejection threw for ${args.agent_slug}: ${(e as Error).message}`,
    );
  }
}
