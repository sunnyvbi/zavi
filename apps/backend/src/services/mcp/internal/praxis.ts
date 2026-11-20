
import type { ToolEffect } from "@/services/tools/types";
import { ownChatImagePaths } from "@/services/workspace-files/site-photos";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpCallResult, McpTool } from "../types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { enqueueAgentRun } from "@/services/agents/runner";
import {
  checkAgentTier,
  everyPlanSentence,
  loadTierGateConfig,
  planWallMessage,
  resolveTenantTier,
} from "@/services/agents/entitlement";
import { POST_CREATIVE_CHANNELS } from "@/services/billing/plan-summary";
import {
  FOUNDER_DIRECT_AGENT_MENTION_KEY,
  asPlanUpgradeRequired,
  isCustomAgentSlug,
  isEngineerBackendRun,
  type Tier,
} from "@/services/billing/tiers";

function staffModelCapHandoffResult(start: number) {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: "staff_model_cap",
      retryable: false,
      message: STAFF_MODEL_CAP_MESSAGE,
    }),
    ms: Date.now() - start,
  };
}
function planWallInstruction(): string {
  return everyPlanSentence()
    ? "Tell the user which plan this needs, what every plan can still do, and that they can upgrade in Settings → Billing."
    : "Tell the user which plan this needs and that they can upgrade in Settings → Billing.";
}
function planUpgradeHandoffResult(slug: string, required_tier: Tier, start: number) {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: "plan_upgrade_required",
      required_tier,
      message: `${planWallMessage(slug, required_tier)} ${planWallInstruction()}`,
      ...(POST_CREATIVE_CHANNELS.has(slug)
        ? {
            do_it_yourself:
              "If the ask was to design or write posts, do it yourself now on any plan: make the images with report__render_social_image and put the captions in your reply. Only publishing or running the channel needs the plan; say that in one line after the posts, not instead of them.",
          }
        : {}),
    }),
    ms: Date.now() - start,
  };
}
function assistantBlockedResult(message: string, start: number) {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({ error: "not_available_from_assistant", message }),
    ms: Date.now() - start,
  };
}
import {
  ASSISTANT_BLOCKED_AGENTS,
  ASSISTANT_BLOCKED_MESSAGE,
  ASSISTANT_BUILD_BLOCKED_MESSAGE,
  isAssistantRun,
} from "@/services/mcp/assistant-policy";
import { StaffModelCapError, STAFF_MODEL_CAP_MESSAGE } from "@/services/agents/staff-model-inherit";
import {
  isA2aAttachmentForwardingEnabled,
  extractParentAttachmentRefs,
  extractParentSlackImageRefs,
  lookbackThreadAttachmentsWithExpiry,
  EXPIRED_UPLOAD_NOTE,
  FORWARDING_OFF_NOTE,
  parentTurnHadAttachment,
  type AttachmentRef,
} from "@/services/agents/a2a-attachment-forwarding";
import { ASK_WAIT_MS, askRefusalFor, isAskAgentEnabled } from "@/services/agents/ask-agent";
import { isPmInteractiveHandoffEnabled } from "@/services/agents/pm-interactive-handoff-flag";
import { isHeavyDispatchConfirmEnabled } from "@/services/agents/heavy-dispatch-confirm-flag";
import { isHeavyDispatch, reserveEstimateFor, creditsToUsd } from "@/services/agents/credits";
import { appBuildScope, type AppBuildScope } from "@/services/agents/whole-app-intent";
import {
  armHeavyDispatchPending,
} from "@/services/agents/heavy-dispatch-pending";
import { logHandoffIntent } from "@/services/agents/handoff-intent";
import { extractParentVideoPaths } from "@/services/agents/a2a-attachment-forwarding";
import { channelAgentSlugs } from "@/services/agents/channel-agents";
import { lockedChannelMessageForAgent } from "@/services/channels/lock";
import {
  admitDirectChannelRun,
  refusedHandoffPayload,
  stampDirectChannelRun,
  stampDirectChannelRunWithin,
} from "@/services/channels/direct-run";
import { getVisibleAgentSlugs } from "@/services/agents/visibility";
import { executeOperatorAction } from "@/services/decisions/operator-action-execute";
import { serviceClient } from "@/services/supabase";
import {
  tenantAppIsLive,
  isRefineRun,
  NON_REFINE_BUILD_FILTER,
  buildDatabaseReclaimed,
} from "@/services/autopilot/build-liveness";
import { siteIdFromGraph } from "@/services/sites/site-run";
import { isVisibleSite, siteLiveUrl } from "@/services/sites/site-build-status";
import type { SiteRow } from "@/services/sites/contract";
import {
  customDomainsFor,
  sitePublishNeedsState,
  sitePublishStates,
  type SitePreviewRow,
  type SitePublishReads,
  type SitePublishRunRow,
  type SitePublishState,
} from "@/services/sites/site-publish-state";
import { oldSiteFrozenBody } from "@/services/sites/old-site-freeze";
import { extractUserMessageFromPayload } from "@/services/agents/post-text-trust-guard";
import { FOUNDER_REF_UNREADABLE, founderMessageRefForChild, type FounderMessageRef } from "@/services/approvals/founder-message";
import { loadUrlGroundingSources, ungroundedHosts } from "@/services/launch-video/url-grounding";
import { assertSafeUrl } from "@/services/onboarding/enrichment/url-guard";
import { normalizeCaptureUrl } from "@/services/launch-video/capture-bridge";
import {
  checkDelegationAllowed,
  checkFanoutDelegationsAllowed,
  recordDelegation,
  readLineageContext,
  buildChildLineagePayload,
  type LineageContext,
  type DelegationGuardResult,
} from "@/services/agents/delegation-guard";
import {
  buildDelegationContext,
  type DelegationContextInput,
  type RecentFinding,
  type RecallHit,
  type ThreadMessageExcerpt,
} from "@/services/agents/delegation-context";
import { inngest } from "../../../../workers/client";
import { renderLaneKeys } from "../../../../workers/functions/_render-launch-video-lanes";
import { decomposeMessage } from "@/agents/engineer/decompose";
import { pickRepoForTask } from "@/services/sandbox/repo-picker";
import { getScopedRepoFullNames } from "@/services/connectors/github/scoped-repos";
import { repoIsEmpty } from "@/services/connectors/github/oauth";
import {
  checkSandboxRepoAccess,
  isUmbrellaProvisionedTenant,
  UMBRELLA_CONNECTOR_ACCOUNT_LOGIN,
} from "@/services/sandbox/repo-access-gate";
import { isProductBuilderEnabled } from "@/agents/engineer/product-builder-flag";
import { buildSessionOfRun, type BindingDb } from "@/services/agents/build-session-binding";
import { requestConductorTick } from "@/services/agents/conductor-kick";
import { validateCompanyName } from "@/services/provisioning/tenant-slug";
import {
  sanitizeFetchedContent,
  xmlEscapeContent,
} from "@/services/onboarding/enrichment/sanitize";
import {
  refineProduct,
  InvalidRefineMessage,
  NoProvisionedRepo,
  BuildRetired,
  FleetHalted,
  AppFrozen,
  SitePreviewRestarting,
  UndoInProgress,
  FreeEditsUsed,
  SiteRequired,
  SiteUnavailable,
  OldSiteFrozen,
  ConductorRunNotFound,
  realRefineProductDeps,
} from "@/services/agents/refine-product";
import {
  startProductBuild,
  DoubleBuildInFlight,
  TooManyBuildsToday,
  ProvisionBudgetExceeded,
  BuildRepoNotProvisioned,
  realStartProductBuildDeps,
} from "@/services/agents/start-product-build";
import { validateCronExpression } from "../../../../workers/functions/cron-match";
import { slackFetch } from "@/services/tools/slack/_client";
import {
  findSecretLiteral,
  STANDING_ORDER_PROMPT_MAX,
  type StandingOrder,
} from "@/services/agents/standing-orders";
import { getSchedule } from "@/services/agents/schedules";
import {
  deriveDeliverTarget,
  type ReminderChatRouting,
  resolveWhen,
  formatLocal,
  isValidTz,
  reminderWhenSchema,
  REMINDER_NOTE_MAX,
} from "@/services/agents/reminders";
import {
  CUSTOM_AGENT_INSTRUCTIONS_MAX,
  CUSTOM_AGENT_NAME_MAX,
  CUSTOM_AGENT_ROLE_MAX,
  CUSTOM_AGENT_TOOLS_MAX,
  CUSTOM_AGENT_TRIGGERS_MAX,
  customAgentDraftSchema,
  customDeliverSchema,
  customAgentNameNorm,
  customAgentReservedNames,
  customTriggerSchema,
  instructionsRejection,
  isReservedCustomAgentName,
  recordCustomAgentCard,
  resolveCustomTriggers,
  watchRefusal,
  type CustomAgentDraft,
  type CustomDeliver,
  type CustomTrigger,
} from "@/services/agents/custom-agents";
import {
  WHATSAPP_NOT_OWNER_REPLY,
  buildSlackConfirmBlocks,
  buildWhatsAppConfirmMessage,
  buildWhatsAppConfirmText,
  customAgentPageUrl,
  draftSummaryText,
  issueCustomAgentConfirm,
  whatsappOwnerUserId,
  type ConfirmAction,
} from "@/services/agents/custom-agent-chat";
import { refusalFor } from "@/services/agents/refusal";
import { InsufficientCreditsForBuild, requiredBuildCredits } from "@/services/agents/build-credit-preflight";
import { isTenantAdminOrOwner } from "@/services/auth/members";
import { tierRank } from "@/services/billing/tiers";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { resolveCustomWriteRun } from "@/services/agents/custom-agent-writes";
import { intakeToVideoBrief, launchVideoIntakeSchema, launchVideoIntakeBase } from "@/services/launch-video/brief-mapper";
import { resolveScriptVariants } from "@/services/launch-video/script-variants";
import { isRenderLaunchVideoEnabled, isGenerativeVideoEnabled } from "@/services/agents/_render-launch-video-flag-check";
import {
  generativeVideoIntakeSchema,
  requestedVideoAspect,
  shouldRefuseGeneratedEndorsement,
} from "@/services/launch-video/generative-video-intake";
import { ExpectedToolError } from "@/services/tools/types";
import { channelVideoBlock } from "@/services/launch-video/video-block";
import { billedVideoCredits } from "@/services/launch-video/video-estimate";
import {
  buildRequestedVideoCard,
  countRequestedVideoCardsToday,
  createRequestedVideoRun,
  REQUESTED_VIDEO_DAILY_CAP,
  failRequestedVideoRun,
  fileGeneratedVideoCard,
  holdRequestedVideoLock,
  releaseRequestedVideoLock,
  whereToApprove,
} from "@/services/tools/generated-video/propose_video";
import { autostartChatVideo } from "@/services/tools/generated-video/starter-autostart";
import { CARD_IN_CHAT_NEXT, showVideoCardInChat } from "@/services/tools/generated-video/chat-card";
import { PRESENTER_GENDERS } from "@/services/launch-video/presenter";
import { checkTestimonialProvenance } from "@/services/launch-video/testimonial-grounding";
import { resolveVideoDeliveryTarget, NO_DELIVERY_SURFACE_MESSAGE } from "@/services/launch-video/delivery-target";
import { describeIntakeGaps } from "@/services/launch-video/intake-gaps";

const delegationContextInputSchema = z
  .object({
    mode: z.enum(["intent_only", "full"]).default("intent_only").describe(
      "How much of the parent run's context to forward to the child. " +
        "'intent_only' (default) = legacy: only the intent string. " +
        "'full' = also attach the parent's recent tool findings, recall hits, " +
        "and a capped thread excerpt — PII/secret-scrubbed + size-capped at " +
        "~16KB. Use 'full' ONLY when the specialist would otherwise re-derive " +
        "what the operator has already established this run.",
    ),
    include: z
      .array(z.enum(["recent_findings", "recall", "thread_excerpt"]))
      .optional()
      .describe(
        "Narrow which slices ride along when mode='full'. Omit to include all three.",
      ),
    full_build: z
      .boolean()
      .optional()
      .describe(
        "Set true for a WHOLE application or game from scratch. The server uses this together with the intent to choose build versus edit and show the Start confirmation. Include an explicit request for a separate or standalone product in the intent; otherwise a connected repository may be used.",
      ),
  })
  .optional();

const handoffInput = z.object({
  target_agent_slug: z
    .string()
    .min(1)
    .describe(
      "Slug of a currently visible specialist agent (e.g. 'engineer', 'dispute-response', 'pm'). Hidden agents and 'operator' itself are rejected.",
    ),
  intent: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "What the user wants the specialist to do. Include the user's wording VERBATIM (key constraints, identifiers, IDs, quoted phrases). Add a one-line distilled summary at the top, then the verbatim quote. Do NOT add operator commentary or your own interpretation. 8000 char cap leaves room for evidence/logs the user pasted.",
    ),
  context: delegationContextInputSchema,
  for_channel: z
    .enum(["youtube_organic"])
    .optional()
    .describe(
      "Only with target 'generated_video': set 'youtube_organic' when the user says the video is for YouTube. Its cards then wait for approval on the YouTube channel instead of AI UGC Videos.",
    ),
});

const askAgentInput = z.object({
  target_agent_slug: z
    .string()
    .min(1)
    .describe("Slug of a currently visible specialist to ask (not operator, not yourself)."),
  intent: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "The question. A one-line summary first, then the user's wording VERBATIM (IDs, URLs, quoted phrases). No commentary.",
    ),
});

const proposeDispatchInput = z.object({
  target_agent_slug: z
    .string()
    .min(1)
    .describe(
      "Slug of a currently-visible specialist (e.g. 'dispute-response', 'support-lead', 'pm'). Validated against the tenant's visible fleet; 'chief-of-staff'/'operator'/hidden/unknown are rejected.",
    ),
  intent: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "One-line instruction for the specialist. Quote the founder-relevant specifics (IDs, amounts, the fire). No commentary.",
    ),
});

const HANDOFF_PARALLEL_CAP = 5;
const HANDOFF_PARALLEL_DEADLINE_MS = 60_000;

const handoffParallelInput = z.object({
  targets: z
    .array(
      z.object({
        target_agent_slug: z.string().min(1).max(64),
        intent: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(HANDOFF_PARALLEL_CAP)
    .describe(
      `Up to ${HANDOFF_PARALLEL_CAP} specialist handoffs to run in parallel. Each {target_agent_slug, intent}. Use ONLY when the sub-questions are genuinely independent (different specialists, no ordering dependency). For a single handoff use praxis__handoff. Each intent follows the same verbatim-quote rule as praxis__handoff.`,
    ),
  context: delegationContextInputSchema,
});

const actionInputShape = z.object({
  verb: z
    .enum(["file-jira-issue", "file-linear-issue", "post-slack-message"])
    .describe(
      "What action to perform. Required. " +
        "file-jira-issue requires {project_key, summary, description_markdown}. " +
        "file-linear-issue requires {team_id, title, description_markdown}. " +
        "post-slack-message requires {channel_id, text}.",
    ),
  project_key: z
    .string()
    .min(2)
    .max(20)
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional()
    .describe("Jira project key (UPPERCASE, e.g. 'SCRUM'). Required iff verb=file-jira-issue."),
  summary: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Jira issue title. Required iff verb=file-jira-issue."),
  description_markdown: z
    .string()
    .min(1)
    .max(32000)
    .optional()
    .describe("Issue body (markdown). Required for verb=file-jira-issue OR verb=file-linear-issue. The downstream Jira/Linear handler keys on this exact field name — `description` (without `_markdown`) is silently dropped."),
  issue_type: z
    .enum(["Task", "Bug", "Story"])
    .default("Task")
    .describe("Jira issue type. Used iff verb=file-jira-issue. Defaults to Task."),
  team_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Linear team UUID. Required iff verb=file-linear-issue."),
  title: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Linear issue title. Required iff verb=file-linear-issue."),
  channel_id: z
    .string()
    .regex(/^[CGD][A-Z0-9]+$/)
    .optional()
    .describe("Slack channel ID (e.g. C0123ABC). NOT a channel name. Required iff verb=post-slack-message."),
  text: z
    .string()
    .min(1)
    .max(8000)
    .optional()
    .describe("Slack message text. Required iff verb=post-slack-message."),
  thread_ts: z
    .string()
    .regex(/^\d+\.\d+$/)
    .optional()
    .describe("Optional Slack thread parent ts to reply in-thread (e.g. 1234567890.123456). Only for verb=post-slack-message."),
});

const actionInput = actionInputShape.superRefine((v, ctx) => {
  if (v.verb === "file-jira-issue") {
    if (!v.project_key) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "project_key required for verb=file-jira-issue", path: ["project_key"] });
    if (!v.summary) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "summary required for verb=file-jira-issue", path: ["summary"] });
    if (!v.description_markdown) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "description_markdown required for verb=file-jira-issue", path: ["description_markdown"] });
  } else if (v.verb === "file-linear-issue") {
    if (!v.team_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "team_id required for verb=file-linear-issue", path: ["team_id"] });
    if (!v.title) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "title required for verb=file-linear-issue", path: ["title"] });
    if (!v.description_markdown) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "description_markdown required for verb=file-linear-issue", path: ["description_markdown"] });
  } else if (v.verb === "post-slack-message") {
    if (!v.channel_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "channel_id required for verb=post-slack-message", path: ["channel_id"] });
    if (!v.text) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "text required for verb=post-slack-message", path: ["text"] });
  }
});

const proposeStandingOrderInput = z.object({
  cron_expression: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Standard 5-field cron (UTC), e.g. '0 16 * * 1' = Mondays 9am PT. Minimum cadence 5 minutes.",
    ),
  prompt: z
    .string()
    .min(1)
    .max(STANDING_ORDER_PROMPT_MAX)
    .describe(
      "The recurring brief, in the user's wording (e.g. 'Post stalled approvals + GMV summary'). Read-only work only — the scheduled run cannot file tickets or hand off. Never include credentials.",
    ),
  destination: z
    .enum(["this_thread", "slack_channel"])
    .describe(
      "Where the result posts. 'this_thread' = the current conversation (chat thread, or the current Slack channel on a Slack turn). 'slack_channel' = an explicit channel (requires slack_channel_id).",
    ),
  slack_channel_id: z
    .string()
    .regex(/^[CGD][A-Z0-9]+$/)
    .optional()
    .describe(
      "Slack channel ID (C0..., NOT a name). Required iff destination=slack_channel.",
    ),
});

const proposeResearchWatchInput = z.object({
  cron_expression: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Standard 5-field cron (UTC), e.g. '0 16 * * 1' = Mondays 9am PT. Weekly cadence is the common case for a competitor/topic watch.",
    ),
  prompt: z
    .string()
    .min(1)
    .max(STANDING_ORDER_PROMPT_MAX)
    .describe(
      "The watch ask, in the user's wording — name the competitor/topic AND say 'report only what changed since the last report' (e.g. 'Watch <Competitor> pricing + plan changes; report only what changed since last week'). Read-only web research. Never include credentials.",
    ),
  destination: z
    .enum(["this_thread", "slack_channel"])
    .describe(
      "Where the change-brief posts. 'this_thread' = the current research chat thread. 'slack_channel' = an explicit channel (requires slack_channel_id).",
    ),
  slack_channel_id: z
    .string()
    .regex(/^[CGD][A-Z0-9]+$/)
    .optional()
    .describe(
      "Slack channel ID (C0..., NOT a name). Required iff destination=slack_channel.",
    ),
});

const secondOpinionInput = z.object({
  claim: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "The claim to check. Ignored: this tool is switched off.",
    ),
  evidence: z
    .unknown()
    .optional()
    .describe(
      "Ignored: this tool is switched off.",
    ),
});

const remindInput = z.object({
  mode: z.enum(["ping", "run"]),
  note: z.string().min(1).max(REMINDER_NOTE_MAX),
  when: reminderWhenSchema,
  tz: z.string().max(64).optional(),
});

const listRemindersInput = z.object({});
const listProductBuildsInput = z.object({});

const cancelReminderInput = z.object({
  reminder_id: z.string().uuid(),
});

const enableDatabaseInput = z.object({
  reason: z.string().max(200).optional(),
});

const proposeCustomAgentInput = z.object({
  name: z.string().min(1).max(CUSTOM_AGENT_NAME_MAX),
  role: z.string().max(CUSTOM_AGENT_ROLE_MAX).optional(),
  instructions: z.string().min(1).max(CUSTOM_AGENT_INSTRUCTIONS_MAX),
  tools: z.array(z.string().min(1).max(120)).max(CUSTOM_AGENT_TOOLS_MAX).optional(),
  triggers: z.array(customTriggerSchema).max(CUSTOM_AGENT_TRIGGERS_MAX).optional(),
  agent: z.string().min(1).max(CUSTOM_AGENT_NAME_MAX).optional(),
});

const runSiteCheckInput = z.object({
  url: z.string().min(1).max(2048).describe("The website to check, e.g. acme.com or https://acme.com"),
});

const listOpenCardsInput = z.object({});
const showCardInput = z.object({
  card_id: z.string().uuid().describe("The waiting card's id: a decision_id from a propose result, or a card_id from praxis__list_open_cards."),
});

const TOOL_NAMES = [
  "handoff",
  "handoff_parallel",
  "ask_agent",
  "action",
  "propose_dispatch",
  "propose_standing_order",
  "propose_research_watch",
  "render_video",
  "render_launch_video",
  "second_opinion",
  "remind",
  "list_reminders",
  "cancel_reminder",
  "list_product_builds",
  "propose_custom_agent",
  "enable_database",
  "run_site_check",
  "list_open_cards",
  "show_card",
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

const renderVideoInputSchema = launchVideoIntakeBase.partial().extend({
  generative_intent: z.enum(["talking_head", "cinematic", "social"]).optional(),
  prompt: z.string().max(2000).optional(),
  script: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "script (REQUIRED for generative_intent 'talking_head', ≤150 words): the exact line the presenter speaks. Write it yourself from the request in plain words.",
    ),
  premium: z.boolean().optional(),
  presenter_gender: z
    .enum(PRESENTER_GENDERS)
    .optional()
    .describe("talking_head only: the presenter described in `prompt`. Set it so the portrait and the voice match."),
  voice: z.string().max(40).optional().describe("talking_head only: a named voice for the presenter. Omit to get one that matches presenter_gender."),
});

const TOOL_SCHEMAS: Record<ToolName, z.ZodTypeAny> = {
  handoff: handoffInput,
  handoff_parallel: handoffParallelInput,
  ask_agent: askAgentInput,
  action: actionInputShape,
  propose_dispatch: proposeDispatchInput,
  propose_standing_order: proposeStandingOrderInput,
  propose_research_watch: proposeResearchWatchInput,
  render_video: renderVideoInputSchema,
  render_launch_video: renderVideoInputSchema,
  second_opinion: secondOpinionInput,
  remind: remindInput,
  list_reminders: listRemindersInput,
  cancel_reminder: cancelReminderInput,
  list_product_builds: listProductBuildsInput,
  propose_custom_agent: proposeCustomAgentInput,
  enable_database: enableDatabaseInput,
  run_site_check: runSiteCheckInput,
  list_open_cards: listOpenCardsInput,
  show_card: showCardInput,
};

const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  handoff:
    "Dispatch the user's request to a specialist agent and return the run id. Use when (a) the user asked for an action operator can't do read-only — request review, file ticket, draft chargeback evidence, ship a fix — AND (b) one of the visible specialists clearly owns that action. NEVER use for plain questions answerable with a read tool — that's a fan-out anti-pattern. The specialist's terminal output is posted back into THIS chat thread automatically; do not ask the user to wait elsewhere. Optional `context.mode` controls how much of THIS run's context is forwarded — default is intent-only; pass `context: {mode: 'full'}` ONLY when the specialist would otherwise re-derive what you've already established.",
  handoff_parallel:
    "Fan out to up to 5 specialists AT ONCE for genuinely independent sub-questions. Returns immediately with {batch_id, run_ids}; the combined result of all children is posted back into THIS chat thread as a single message when they finish (or after a 60s deadline). Use ONLY when the sub-tasks are independent (different specialists, no ordering dependency). For one handoff use praxis__handoff. Same verbatim-intent rule per target. Optional `context.mode` shares your gathered context with EVERY sibling.",
  ask_agent:
    "Ask a specialist a QUESTION and get its answer back in THIS reply. Use it instead of praxis__handoff when the user expects the answer now (a check, a lookup, the owning specialist's read) rather than a job done later. After it returns ok, END YOUR TURN with one short line saying who you are checking with; call no more tools. The answer comes back to you as your next turn and you reply with it. If the specialist takes more than 5 minutes, its answer posts in this thread by itself. One ask per turn. Not for builds or code changes (praxis__handoff). If it returns ask_agent_unavailable, use praxis__handoff.",
  action:
    "Emit a direct, single-step write action — file a Jira ticket, file a Linear issue, or post a Slack message. Use ONLY when the user gave you ALL the required args in their ask AND the action is a single write (no specialist reasoning needed). Returns a decision_id once the tiered-autonomy gate clears (auto for operator's classes). NEVER use for multi-step asks (RICE-rank + file, draft evidence + submit) — those go through praxis__handoff. NEVER use for money path (refunds, payouts) — handoff to dispute-response or payouts-recon instead.",
  propose_dispatch:
    "chief-of-staff only. Propose dispatching a specialist to act on something surfaced in this conversation. Emits an APPROVAL-GATED decision (lands in Needs you — nothing runs until the founder clicks Approve), so use it freely when your investigation concludes a specialist owns the fix. Returns a decision_id. This does NOT run the specialist directly; it queues the one-click card. Use for a single owned action; for pure questions just answer in prose.",
  propose_standing_order:
    "operator only. LEGACY, kept so existing standing orders keep working. Do NOT use it for a new recurring ask: use praxis__propose_custom_agent. Emits an APPROVAL-GATED decision; returns a decision_id.",
  propose_research_watch:
    "research only. LEGACY, kept so existing watches keep working. Do NOT use it for a new ask to keep watching something: use praxis__propose_custom_agent. Emits an APPROVAL-GATED decision; returns a decision_id.",
  render_video:
    "operator only. Render a short product VIDEO (1080p mp4) and post it back into THIS thread. The OPTIONAL `video_type` picks the KIND of video (default 'launch'): 'launch' = a public launch-ANNOUNCEMENT for LinkedIn/Twitter/investors/followers (hook = 'Introducing <Product>'/positioning, traction up front, CTA = 'Learn more'/'We're live' — NOT in-app how-to copy); 'ad' = a 15-30s punchy conversion ad (hook→value→proof→one hard CTA); 'explainer' = teaches how it works (problem→show-the-product→features→CTA); 'social' = a ~15s single-point clip; 'story' = a founder/journey arc. Pick the type from what the USER asked for; default to 'launch'. Set `platform` (where they'll post) and/or `aspects` (16:9|1:1|9:16) for the output format(s); for two takes of the SAME video pass `scripts` (A/B variants — opt-in, multiplies media spend). Use AFTER you have gathered: a one-liner, the audience, tone (clean|bold|playful|enterprise), 1-3 real headline `metrics` (each {stat,label} — LEAD WITH TRACTION; or the legacy single `proof` stat), 1-8 key features (each {title, detail, and an OPTIONAL real `meta` proof tag like '600+ hosts' or '4.9★' shown as the card footer — fill ONLY from real verifiable data, omit otherwise), and the CTA text + URL. GROUNDING IS MANDATORY for EVERY type: every meta/metric/claim must be a real, verifiable number from the customer's own site or connected data — NEVER invent stats, prices, cities, ratings, counts, superlatives, '#1', 'guaranteed', or fake urgency; leave a field out if you don't have a real figure. THE SAME RULE APPLIES TO `url` AND `cta_url`, AND THEY ARE ENFORCED SERVER-SIDE: a URL is a real-world redirect for the customer's own audience, so it must come from the CUSTOMER (they typed it, or it is their recorded product URL) — NEVER from you. If you asked for the URL and they haven't answered, ASK AGAIN; a 'go ahead' is not an answer to an unanswered question. Do NOT guess a domain, do NOT reuse an example from this description, and do NOT fill a missing `url` just because a validation error listed it — the render will be refused. (The per-tenant brand colors + logo are applied automatically — do NOT ask for them.) Returns IMMEDIATELY with an ack — the render runs out-of-band (a few minutes) and the finished video is delivered to this thread automatically; do NOT wait or poll. It is a v1 draft, not a final film. Gated to enabled workspaces — a disabled workspace gets a polite 'not enabled' note. GENERATIVE VIDEO (a REAL person speaking to camera, or a cinematic/social clip — NOT motion-graphics): when the user wants an actual talking-head / spokesperson / founder-pitch / avatar video, or a cinematic or fast social clip generated by an AI model, pass `generative_intent` = 'talking_head' | 'cinematic' | 'social' PLUS `prompt` (what to show) and, for talking_head, `script` (the exact words to speak). Optionally `aspect_ratio`. (`premium` is accepted but IGNORED — one model per intent now.) This files a priced card on AI UGC Videos. In a web chat the card appears right in that chat and the video starts when the founder presses Make video on it; from Slack the first card can start at once. The result says which. Use `generative_intent` for 'make a video of a person talking', 'a spokesperson video', 'a cinematic shot', 'a TikTok clip'; use the motion-graphic fields above for a launch/announcement/explainer deck.",
  render_launch_video:
    "operator only. PERMANENT ALIAS of praxis__render_video (the general name — prefer that). Identical params + behavior on the same schema. A motion-graphics VIDEO (1080p mp4) of any `video_type` (default 'launch') is made from a short intake and posted back into THIS thread; it returns immediately and renders out-of-band as a v1 draft. With `generative_intent` it files a priced card on AI UGC Videos; the result says whether the video started or waits for Make video. All the grounding rules of render_video apply. Gated to enabled workspaces.",
  remind:
    "YOU CAN SET REMINDERS AND TIMERS. Never tell the user to use Slack's /remind or a phone timer — this tool IS that feature. Use it whenever the user asks to be reminded, nudged, pinged, or to have something re-checked later ('remind me in 1min', 'ping me at 3pm'). `mode`: 'ping' just echoes `note` back to the user at the time (no agent run, no cost). 'run' re-runs YOU at that time with `note` as the prompt and posts the result, for work done later ('in 2h re-check the deploy'). Recurring work ('every Monday tell me X') is a custom agent (praxis__propose_custom_agent), not a recurring 'run'; a recurring 'run' needs a paid plan. `when` is one of: {kind:'in', seconds} for a relative delay (minimum 60); {kind:'at', local_time:'YYYY-MM-DDTHH:mm'} for a specific LOCAL wall-clock time; {kind:'recurring', cron:'0 9 * * 1-5'} for a repeating schedule, where the cron is in the USER'S LOCAL time. NEVER convert to UTC yourself and never pass a UTC timestamp — the backend resolves the timezone and will tell you the exact local time it landed on. Pass `tz` (IANA, e.g. 'Asia/Kolkata') ONLY if the user named a timezone; otherwise omit it and the workspace default is used. Delivery is automatic and server-chosen — there is no channel argument and you do not pick where it goes. On Slack it arrives as a DIRECT MESSAGE to the person who asked (not a reply in the channel they asked from), so say 'I'll DM you' rather than 'I'll reply here'. On web chat, WhatsApp, Telegram and Discord it comes back on that same conversation. It is NOT available on an email turn: there is no delivery rail back into an email thread, so the tool refuses with `remind_no_surface`. On email, say plainly that you cannot set a reminder from email and offer to set it if they ask from chat or Slack. Do NOT promise a reminder you cannot deliver. Returns {reminder_id, fires_at_local}: tell the user that exact local time back so they can catch a wrong timezone immediately.",
  list_reminders:
    "List this workspace's pending reminders (id, what, when, mode). Use when the user asks what reminders they have, or before cancelling one so you can name the right id.",
  list_product_builds:
    "THE ONLY source of truth for questions about the workspace's PRODUCT BUILDS — 'are any of my builds live', 'did my app deploy', 'what stage is my build on', 'have I built anything'. Takes no arguments. A PRODUCT BUILD IS NOT AN AGENT RUN: an agent run is a single dispatch of one agent (including the turn you are answering right now), and several are in flight on any busy workspace. NEVER answer a question about builds by counting agent runs, and never treat a `recent_runs` entry as a build. Call this tool before you say anything about build state; if you did not call it, say you have not checked. FOR 'IS IT LIVE', READ `currently_live` — it is a computed boolean, and `live_reason` explains it. `live_url` is the address that verdict is about: whenever it is non-null you MUST paste that exact URL into your reply, because the chat frames a live preview of the app from it and a reply that says 'it is live' without the URL leaves the user with nothing to open. Never invent or guess that address — if `live_url` is null, say the build is live but the address is not recorded yet. A workspace can hold SEVERAL apps (its original app plus one site per site build): `apps` lists each with its own `currently_live` and `live_url`, `currently_live` at the top is true when ANY app is live, and each build row's `site_id` says which app it belongs to (null = the original app). When more than one app is live, name each one with its own URL. DO NOT infer liveness from any build's `status`: a `done` on an older build does NOT mean that app is live, because a newer fresh build OF THE SAME APP re-seeds it (such rows are marked `superseded`; a build of a different site never supersedes another). `product_builds` is an exact count of FRESH builds; `refines` (edits to an existing app) are counted separately and are not builds. `builds` is only the most recent 20 rows — when `builds_truncated` is true, do not describe that list as the complete history. WHAT THIS DOES NOT KNOW: it derives liveness from build state and does NOT probe the live URL (`live_check` says so), so it cannot tell you an app is down right now; say that rather than claiming the site is up. `product_builds: 0` means the workspace has never built a product — that is a true and useful answer, not a failure. A site with a newer version than its live one, or a stopped publish, carries `publish`: quote its `last_problem` (already in the founder's words), give `preview_url` when set (else `open_in_zavi`); `custom_domains` says, per kind of app, whether and where a domain can be set.",
  propose_custom_agent:
    "operator (and research on web chat). Draft a custom agent when the user wants a job done on its own, again and again ('every morning send me a standup of what you did', 'check my competitors weekly', 'tell me when X changes'). Creates NOTHING: the user gets a card and confirms with one click. `instructions` = a complete brief the agent can follow alone. `triggers`: {kind:'schedule', cron} in the user's LOCAL time, or {kind:'watch', interval_minutes (min 15), condition}; a watch condition must name the web page URL to watch or a connected source by name, or the server refuses it. For a report of Zavi's own work, the instructions must name praxis_corpus__query_recent_runs, praxis_corpus__query_pending_decisions and praxis_corpus__read_run_output. Delivery is chosen by the server. To CHANGE an existing custom agent, pass `agent` = its current name plus the full new draft. On Slack and WhatsApp the user confirms with a Confirm button the server sends.",
  run_site_check:
    "Run Zavi's growth site check on a website, the same scored card anyone gets at zaviagent.com/start: Google, AI answers, SEO basics, design and vs competitors, each out of 20, plus the search term it checked. Use it whenever the founder asks to check, score, test or audit a site (theirs or a competitor's); do NOT tell them to go to /start themselves. Pass `url` (e.g. acme.com). It waits up to 90 seconds and returns {status:'done', total, out_of, scores, search_term, card_url, credits_charged}. If the check needs longer it returns {status:'pending', card_url}: say it's running, share the link, and say the result will be posted in this same thread (the server posts it; do not wait or poll). {status:'deduped'} means the site was checked in the last 24h: that card is reused and nothing is charged. {status:'refused', reason, message}: tell the founder the message plainly (e.g. not enough credits). Costs what the check actually spends, at most 195 credits. At most 1 new check per run. Results are public cards that can appear on the growth leaderboard.",
  enable_database:
    "Give this site its OWN database. Call it BEFORE you write any code that stores data or has login/signup (saved form submissions, user accounts, sessions, any table). It records the need; the server then creates an isolated Postgres database for this site and sets server-only DATABASE_URL and SESSION_SECRET on the host before your code is published. You get no credentials: read process.env.DATABASE_URL in server code only. Optional `reason`: a few words on what needs it. Safe to call more than once. Do NOT call it for a static site with no stored data.",
  cancel_reminder:
    "Cancel a pending reminder by id. Use when the user says to cancel/stop/forget a reminder. Call praxis__list_reminders first if you don't already have the id.",
  second_opinion:
    "Not enabled: always returns {status:'not_enabled'} and asks no model. Do not call it; weigh your claim against the evidence yourself.",
  list_open_cards:
    "The cards waiting for the founder's tap right now (ad changes, other approvals, channel cards), newest first: card_id, what it changes, where it is approved, and its move_key: cards with one move_key are one move (one card to approve); never ask to approve cards with different move_keys together. Read it before saying a change is done or waiting.",
  show_card:
    "Show a card that is already waiting in THIS chat, so the founder can tap it here. It files nothing new and approves nothing: a yes typed in chat does not approve a card, only the founder's tap on it does. Chat turns only.",
};

const TOOL_EFFECTS: Record<ToolName, ToolEffect> = {
  handoff: "write",
  handoff_parallel: "write",
  ask_agent: "write",
  action: "write",
  propose_dispatch: "write",
  propose_standing_order: "write",
  propose_research_watch: "write",
  render_video: "write",
  render_launch_video: "write",
  second_opinion: "read",
  remind: "write",
  list_reminders: "read",
  cancel_reminder: "write",
  list_product_builds: "read",
  propose_custom_agent: "write",
  enable_database: "write",
  run_site_check: "write",
  list_open_cards: "read",
  show_card: "write",
};

const ACTION_VERB_TO_CLASS: Record<
  "file-jira-issue" | "file-linear-issue" | "post-slack-message",
  string
> = {
  "file-jira-issue": "operator.file-jira-issue",
  "file-linear-issue": "operator.file-linear-issue",
  "post-slack-message": "operator.post-slack-message",
};

const RENDER_VIDEO_OFF_NEXT =
  "For a video ad, hand off to generated_video and tell the founder only what that handoff says, without mentioning this tool or that it is off. For any other video, relay the message.";

export function listPraxisTools(): McpTool[] {
  return TOOL_NAMES.map((name) => {
    const schema = zodToJsonSchema(TOOL_SCHEMAS[name]);
    if (schema.type !== "object") {
      throw new Error(`praxis tool ${name} must be a top-level z.object()`);
    }
    return {
      server_id: "praxis",
      tool_name: name,
      description: TOOL_DESCRIPTIONS[name],
      effect: TOOL_EFFECTS[name],
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type DelegationContextSource = DelegationContextInput;

export type PraxisToolCtx = {
  tenant_id: string;
  run_id?: string;
  agent_slug?: string;
  trigger?: string;
  chat_thread_id?: string;
  user_id?: string;
  actor?: import("@/services/agents/actor-envelope").ActorAuthorityEnvelopeV1;
  tool_use_id?: string;
  slack_routing?: {
    channel_id: string;
    thread_ts: string;
    original_ts: string;
    event_id: string;
    team_id?: string;
  };
  email_routing?: {
    thread_id: string;
    email_message_id: string;
    rfc_message_id: string | null;
    from: string;
    envelope_to: string;
    identity_id: string | null;
  };
  emit_decision?: (decision_class: string, body: unknown, opts?: { selfDispatch?: boolean }) => Promise<string>;
  delegation_context_source?: DelegationContextSource;
  heavy_confirm_preclaimed?: boolean;
  writes_suppressed?: boolean;
  redo?: boolean;
  founder_chat_order?: boolean;
  founder_order_unverified?: boolean;
  user_turn_message_id?: string;
};

type OperatorGate =
  | {
      ok: true;
      surface: "chat" | "slack" | "mcp" | "email" | "teams" | "telegram" | "discord" | "whatsapp" | "imessage" | "scheduled";
    }
  | { ok: false; error: string; message: string };

async function gateOperatorOrCustomCaller(
  ctx: PraxisToolCtx,
  toolLabel: string,
  extraChatOnlySlug?: string,
): Promise<OperatorGate> {
  if (!isCustomAgentSlug(ctx.agent_slug)) {
    return gateOperatorCaller(ctx, toolLabel, extraChatOnlySlug);
  }
  const run = await resolveCustomWriteRun(ctx.tenant_id, ctx.run_id, ctx.agent_slug);
  if (run.state !== "admitted") {
    return {
      ok: false,
      error: `${toolLabel}_not_authorized`,
      message: `${toolLabel} is only available to an active custom agent in its own run.`,
    };
  }
  if (ctx.trigger === "cron" || ctx.trigger === "manual") return { ok: true, surface: "scheduled" };
  return gateOperatorCaller({ ...ctx, agent_slug: "operator" }, toolLabel);
}

function gateOperatorCaller(
  ctx: PraxisToolCtx,
  toolLabel: string,
  extraChatOnlySlug?: string,
): OperatorGate {
  const isChat = ctx.trigger === "chat";
  const isSlack = ctx.trigger === "slack";
  const isMcp = ctx.trigger === "mcp";
  const isEmail = ctx.trigger === "email";
  const isTeams = ctx.trigger === "teams";
  const isTelegram = ctx.trigger === "telegram";
  const isDiscord = ctx.trigger === "discord";
  const isWhatsApp = ctx.trigger === "whatsapp";
  const isIMessage = ctx.trigger === "imessage";
  const isOperator = ctx.agent_slug === "operator";
  const isExtraChatCaller =
    !!extraChatOnlySlug &&
    ctx.agent_slug === extraChatOnlySlug &&
    isChat;
  const callerAuthorized = isOperator || isExtraChatCaller;
  if (
    !callerAuthorized ||
    (!isChat && !isSlack && !isMcp && !isEmail && !isTeams && !isTelegram && !isDiscord && !isWhatsApp && !isIMessage) ||
    (isChat && !ctx.user_id)
  ) {
    return {
      ok: false,
      error: `${toolLabel}_not_authorized`,
      message: `${toolLabel} is only available to the operator agent inside a chat turn from an authenticated user, an inbound Slack message, an MCP ask, an inbound email, an inbound Teams message, an inbound Telegram message, an inbound Discord message, an inbound WhatsApp message, or an inbound iMessage.`,
    };
  }
  if (isChat && !ctx.chat_thread_id) {
    return {
      ok: false,
      error: `${toolLabel}_no_thread`,
      message: `${toolLabel} is only valid inside an operator chat turn.`,
    };
  }
  if (isSlack && !ctx.slack_routing?.event_id) {
    console.warn(
      `[praxis/${toolLabel}] blocked: trigger=slack but slack_routing missing ` +
        `(has_object=${ctx.slack_routing != null}, has_event_id=${!!ctx.slack_routing?.event_id}, run_id=${ctx.run_id})`,
    );
    return {
      ok: false,
      error: `${toolLabel}_no_thread`,
      message: `${toolLabel} from Slack requires slack_routing (channel + event_id).`,
    };
  }
  if (isEmail && !ctx.email_routing?.email_message_id) {
    return {
      ok: false,
      error: `${toolLabel}_no_thread`,
      message: `${toolLabel} from email requires email_routing (thread + inbound message id).`,
    };
  }
  return {
    ok: true,
    surface: isMcp
      ? "mcp"
      : isSlack
        ? "slack"
        : isEmail
          ? "email"
          : isTeams
            ? "teams"
            : isTelegram
              ? "telegram"
              : isDiscord
                ? "discord"
                : isWhatsApp
                  ? "whatsapp"
                  : isIMessage
                    ? "imessage"
                    : "chat",
  };
}

async function patchParentRunPayload(
  run_id: string | undefined,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!run_id) return;
  try {
    const sb = serviceClient();
    const { data: row } = await sb
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .maybeSingle<{ payload: Record<string, unknown> | null }>();
    const payload = {
      ...((row?.payload as Record<string, unknown>) ?? {}),
      ...patch,
    };
    await sb.from("agent_runs").update({ payload }).eq("id", run_id);
  } catch (e) {
    console.warn(
      `[praxis__handoff] parent run payload patch failed (run ${run_id}): ${(e as Error).message}`,
    );
  }
}

async function readParentLineage(
  run_id: string | undefined,
): Promise<LineageContext> {
  if (!run_id) return { lineage_id: null, depth: 0 };
  try {
    const sb = serviceClient();
    const { data: row } = await sb
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .maybeSingle<{ payload: Record<string, unknown> | null }>();
    return readLineageContext(row?.payload ?? null);
  } catch (e) {
    console.warn(
      `[praxis__handoff] parent lineage read failed (run ${run_id}): ${(e as Error).message} — treating as root`,
    );
    return { lineage_id: null, depth: 0 };
  }
}

function delegationRefusedResult(
  guard: Extract<DelegationGuardResult, { ok: false }>,
  start: number,
): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: `handoff_${guard.reason}`,
      escalate: guard.escalate,
      message: guard.message,
    }),
    ms: Date.now() - start,
  };
}

function resolveDelegationContext(
  ctx: PraxisToolCtx,
  parsedContext:
    | { mode: "intent_only" | "full"; include?: ("recent_findings" | "recall" | "thread_excerpt")[] }
    | undefined,
): ReturnType<typeof buildDelegationContext> | null {
  if (!parsedContext || parsedContext.mode !== "full") return null;
  const source = ctx.delegation_context_source;
  if (!source) return null;
  return buildDelegationContext({
    recent_findings: source.recent_findings as readonly RecentFinding[] | undefined,
    recall: source.recall as readonly RecallHit[] | undefined,
    thread_excerpt: source.thread_excerpt as readonly ThreadMessageExcerpt[] | undefined,
    include: parsedContext.include,
  });
}

async function resolveForwardedVideoPaths(ctx: PraxisToolCtx): Promise<string[]> {
  try {
    if (!ctx.run_id) return [];
    if (!(await isA2aAttachmentForwardingEnabled())) return [];
    const sb = serviceClient();
    const { data: parentRow } = await sb
      .from("agent_runs")
      .select("payload")
      .eq("id", ctx.run_id)
      .maybeSingle<{ payload: Record<string, unknown> | null }>();
    return extractParentVideoPaths(parentRow?.payload ?? null, ctx.tenant_id);
  } catch (e) {
    console.warn(
      `[praxis__handoff] video forwarding resolve skipped (run ${ctx.run_id}): ${(e as Error).message}`,
    );
    return [];
  }
}

async function resolveForwardedAttachmentRefs(
  ctx: PraxisToolCtx,
): Promise<{ refs: AttachmentRef[]; expiredUpload: boolean; forwardingOff: boolean }> {
  const none = { refs: [] as AttachmentRef[], expiredUpload: false, forwardingOff: false };
  try {
    if (!ctx.run_id) return none;
    const sb = serviceClient();
    if (!(await isA2aAttachmentForwardingEnabled())) {
      const { data: parentRow } = await sb
        .from("agent_runs")
        .select("payload")
        .eq("id", ctx.run_id)
        .maybeSingle<{ payload: Record<string, unknown> | null }>();
      return { ...none, forwardingOff: parentTurnHadAttachment(parentRow?.payload ?? null, ctx.tenant_id) };
    }
    const { data: parentRow } = await sb
      .from("agent_runs")
      .select("payload")
      .eq("id", ctx.run_id)
      .maybeSingle<{ payload: Record<string, unknown> | null }>();
    const refs = extractParentAttachmentRefs(parentRow?.payload ?? null, ctx.tenant_id);
    if (refs.length > 0) return { refs, expiredUpload: false, forwardingOff: false };
    return { ...(await lookbackThreadAttachmentsWithExpiry(sb, ctx.tenant_id, parentRow?.payload ?? null)), forwardingOff: false };
  } catch (e) {
    console.warn(
      `[praxis__handoff] attachment forwarding resolve skipped (run ${ctx.run_id}): ${(e as Error).message}`,
    );
    return none;
  }
}

async function resolveForwardedSlackImages(ctx: PraxisToolCtx): Promise<unknown[]> {
  try {
    if (!ctx.run_id) return [];
    if (!(await isA2aAttachmentForwardingEnabled())) return [];
    const { data: parentRow } = await serviceClient()
      .from("agent_runs")
      .select("payload")
      .eq("id", ctx.run_id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle<{ payload: Record<string, unknown> | null }>();
    return extractParentSlackImageRefs(parentRow?.payload ?? null);
  } catch (e) {
    console.warn(
      `[praxis__handoff] Slack image forwarding resolve skipped (run ${ctx.run_id}): ${(e as Error).message}`,
    );
    return [];
  }
}

async function callRenderLaunchVideo(
  ctx: PraxisToolCtx,
  args: unknown,
  start: number,
  toolName: "render_video" | "render_launch_video" = "render_launch_video",
): Promise<McpCallResult> {
  const fail = (error: string, message: string): McpCallResult => ({
    ok: false,
    is_error: true,
    content: JSON.stringify({ error, message }),
    ms: Date.now() - start,
  });

  const gate = gateOperatorCaller(ctx, toolName);
  if (!gate.ok) return fail(gate.error, gate.message);
  if (!ctx.run_id) {
    return fail(`${toolName}_no_run`, `${toolName} requires an active run context.`);
  }

  const rawArgs = (args ?? {}) as Record<string, unknown>;
  if (rawArgs.generative_intent) {
    const gPrompt = [rawArgs.prompt, rawArgs.one_liner, rawArgs.script]
      .map((s) => (typeof s === "string" ? s : ""))
      .join(" ")
      .trim();
    if (shouldRefuseGeneratedEndorsement(rawArgs.generative_intent as never, gPrompt)) {
      return fail(
        "render_video_testimonial_no_talking_head",
        "A testimonial / social-proof video must NOT be an AI presenter — a generated 'happy customer' is a fabricated endorsement (FTC endorsement-law + trust risk). " +
          "Re-call render_video WITHOUT generative_intent, set video_type:'testimonial', and pass `testimonials` = the customer's REAL review quotes (each {quote, attribution, rating?, source}), pulled from their connected review data. NEVER invent a quote, a name, or a rating.",
      );
    }
    if (!(await isGenerativeVideoEnabled(ctx.tenant_id))) {
      return {
        ok: true,
        is_error: false,
        content: JSON.stringify({ status: "not_enabled", message: "Video generation isn't enabled for your workspace yet.", next: RENDER_VIDEO_OFF_NEXT }),
        ms: Date.now() - start,
      };
    }
    const gBlock = await channelVideoBlock(ctx.tenant_id);
    if (gBlock) {
      return {
        ok: true,
        is_error: false,
        content: JSON.stringify({
          status: "not_enabled",
          message: `${gBlock.charAt(0).toUpperCase()}${gBlock.slice(1)}. Nothing was charged.`,
          next: "Tell the founder in your own words that this AI video cannot be made on their workspace right now and that nothing was charged. If the message names a plan, say which plan includes AI videos and that they can upgrade on the Billing page. Do not quote this message or name this tool.",
        }),
        ms: Date.now() - start,
      };
    }
    const gIntake = generativeVideoIntakeSchema.safeParse({
      prompt: rawArgs.prompt ?? rawArgs.one_liner ?? "",
      intent: rawArgs.generative_intent,
      premium: rawArgs.premium ?? false,
      aspect_ratio: requestedVideoAspect(rawArgs.generative_intent, rawArgs.aspect_ratio),
      script: rawArgs.script,
      presenter_gender: rawArgs.presenter_gender,
      voice: rawArgs.voice,
    });
    if (!gIntake.success) {
      return fail(`${toolName}_invalid_input`, describeIntakeGaps(gIntake.error));
    }
    if (ctx.writes_suppressed) {
      return {
        ok: true,
        is_error: false,
        content: JSON.stringify({ status: "not_filed", message: "Draft run: nothing was written." }),
        ms: Date.now() - start,
      };
    }
    if (ctx.redo) {
      return fail(
        "redo_scope",
        "This run is redoing one action you were asked to rewrite. It cannot set up a new video as well. Rewrite the action; ask for the video on a normal turn.",
      );
    }
    const gNotFiled = "Zavi could not put this video on the AI UGC Videos channel just now, so nothing was made or charged. Try again in a minute.";
    let gEstimate: number;
    try {
      gEstimate = await billedVideoCredits(gIntake.data);
    } catch {
      return fail("render_video_card_not_filed", gNotFiled);
    }
    const gAdmission = await admitDirectChannelRun(ctx.tenant_id, "generated_video", undefined, {
      chat: ctx.founder_chat_order === true,
      accepted: gEstimate,
    });
    if (!gAdmission.allowed) {
      return {
        ok: true,
        is_error: false,
        content: JSON.stringify({
          status: "not_filed",
          message: `${gAdmission.message} Nothing was made or charged.`,
          next: "Tell the founder in your own words that this AI video was not set up and why, and that nothing was charged. Do not quote this message or name this tool.",
        }),
        ms: Date.now() - start,
      };
    }
    const gCheckFailed = "Zavi could not check today's video requests just now, so nothing was set up or charged. Try again in a minute.";
    let gLocked: boolean;
    try {
      gLocked = await holdRequestedVideoLock(ctx.tenant_id);
    } catch {
      return fail("render_video_card_not_filed", gCheckFailed);
    }
    if (!gLocked) return fail("render_video_card_not_filed", gCheckFailed);
    try {
      let gFiledToday: number;
      try {
        gFiledToday = await countRequestedVideoCardsToday(ctx.tenant_id);
      } catch {
        return fail("render_video_card_not_filed", gCheckFailed);
      }
      if (gFiledToday >= REQUESTED_VIDEO_DAILY_CAP) {
        return {
          ok: true,
          is_error: false,
          content: JSON.stringify({
            status: "not_filed",
            message: `You have asked for ${REQUESTED_VIDEO_DAILY_CAP} videos today. Make or dismiss some in Suggested ads, then ask again tomorrow.`,
            next: "Tell the founder in your own words that today's limit of video requests is reached, that nothing was made or charged, and that they can make or dismiss the waiting ones in Suggested ads and ask again tomorrow. Do not name this tool.",
          }),
          ms: Date.now() - start,
        };
      }
      let gHolder: string;
      try {
        gHolder = await createRequestedVideoRun(ctx.tenant_id, ctx.run_id);
      } catch {
        return fail("render_video_card_not_filed", gNotFiled);
      }
      let gCard: { id: string; kept: boolean; credits: number };
      try {
        gCard = await fileGeneratedVideoCard({
          tenantId: ctx.tenant_id,
          runId: gHolder,
          channelSlug: "generated_video",
          intake: gIntake.data,
          card: (credits) => buildRequestedVideoCard(gIntake.data, credits),
          payload: ctx.founder_chat_order === true ? { origin: "user_initiated_chat" } : undefined,
        });
      } catch (e) {
        await failRequestedVideoRun(ctx.tenant_id, gHolder);
        if (e instanceof ExpectedToolError && (e.code === "channel_card_already_done" || e.code === "channel_card_already_rejected")) {
          const done = e.code === "channel_card_already_done";
          return {
            ok: true,
            is_error: false,
            content: JSON.stringify({
              status: "not_filed",
              message: done
                ? "This same video was already made from an earlier card on AI UGC Videos, so Zavi did not set it up again. Nothing new was made or charged."
                : "The founder dismissed this same video earlier on AI UGC Videos, so Zavi did not set it up again. Nothing was made or charged.",
              next: done
                ? "Tell the founder in your own words that this video was already made and where it is (the AI UGC Videos channel), and that nothing new was charged. Offer to make a different version: ask what should change (the words, the scene, the length or the format), then call render_video again with that change. Do not name this tool or say try again later."
                : "Tell the founder in your own words that they dismissed this same video earlier, so it was not set up again and nothing was charged. Ask what should be different this time (the words, the scene, the length or the format), then call render_video again with that change. Do not name this tool or say try again later.",
            }),
            ms: Date.now() - start,
          };
        }
        return fail("render_video_card_not_filed", gNotFiled);
      }
      const gInChat = ctx.slack_routing ? "not_chat" : await showVideoCardInChat(ctx.tenant_id, ctx.run_id, gCard.id);
      if (gInChat === "shown") {
        return {
          ok: true,
          is_error: false,
          content: JSON.stringify({
            status: "card_in_chat",
            action_id: gCard.id,
            cost_credits: gCard.credits,
            message: `The video card is in this chat, ready to make for about ${gCard.credits.toLocaleString("en-US")} credits, charged only when it arrives. Nothing has been made or charged yet.`,
            next: CARD_IN_CHAT_NEXT,
          }),
          ms: Date.now() - start,
        };
      }
      const gStarted =
        gInChat === "not_chat"
          ? await autostartChatVideo(ctx.tenant_id, gHolder, { actionId: gCard.id, kept: gCard.kept }, {
              founder: ctx.founder_chat_order === true,
              unverified: ctx.founder_order_unverified === true,
              userId: ctx.actor?.actor_user_id ?? null,
            })
          : "not_chat";
      if (gStarted === "started") {
        return {
          ok: true,
          is_error: false,
          content: JSON.stringify({
            status: "video_started",
            action_id: gCard.id,
            cost_credits: gCard.credits,
            message: `The video is being made now for about ${gCard.credits.toLocaleString("en-US")} credits, charged only when it arrives.`,
            next: "Tell the founder the video is being made now and will appear on the AI UGC Videos channel when it is ready, with its price, charged only when it arrives. Do not ask them to press Make video. Do not name this tool.",
          }),
          ms: Date.now() - start,
        };
      }
      return {
        ok: true,
        is_error: false,
        content: JSON.stringify({
          status: "card_filed",
          action_id: gCard.id,
          cost_credits: gCard.credits,
          message: `The video is ready to make for about ${gCard.credits.toLocaleString("en-US")} credits, charged only when it arrives. Nothing has been made or charged yet.`,
          next: `Tell the founder the video is waiting for them, its price, and that it is made only when they press Make video. ${whereToApprove("generated_video")}`,
        }),
        ms: Date.now() - start,
      };
    } finally {
      await releaseRequestedVideoLock(ctx.tenant_id);
    }
  }

  const enabled = await isRenderLaunchVideoEnabled(ctx.tenant_id);
  if (!enabled) {
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify({
        status: "not_enabled",
        message: "Launch-video rendering isn't enabled for your workspace yet.",
        next: RENDER_VIDEO_OFF_NEXT,
      }),
      ms: Date.now() - start,
    };
  }

  let parsed: z.infer<typeof launchVideoIntakeSchema>;
  try {
    parsed = launchVideoIntakeSchema.parse(args);
  } catch (e) {
    return fail(
      "render_launch_video_invalid_input",
      `${describeIntakeGaps(e)} These must come from the USER or a connector — ` +
        `ASK them for anything you were not given, in ONE message, and wait. ` +
        `Do NOT re-send this call with an example, a placeholder, or a guessed value ` +
        `(an invented url/cta_url sends their real audience to a domain they may not own).`,
    );
  }

  if (parsed.video_type === "testimonial" && parsed.testimonials && parsed.testimonials.length > 0) {
    const prov = checkTestimonialProvenance(parsed.testimonials);
    if (prov.stripped.length > 0) {
      console.warn(
        `[render_video] testimonial provenance: stripped ${prov.stripped.length} unsourced quote(s) (warn-strip, run ${ctx.run_id})`,
      );
      parsed = { ...parsed, testimonials: prov.kept.length > 0 ? prov.kept : undefined };
    }
  }
  if (parsed.video_type === "testimonial" && Array.isArray(parsed.scenes) && parsed.scenes.length > 0) {
    console.warn(
      `[render_video] testimonial: stripped ${parsed.scenes.length} authored scene(s) — testimonial content must use the provenance-checked \`testimonials\` field, not hand-authored cardwall scenes (run ${ctx.run_id})`,
    );
    parsed = { ...parsed, scenes: undefined };
  }
  if (parsed.video_type === "testimonial") {
    const scripts = (parsed.scripts ?? [])
      .map((o) => ({ ...o, broll_prompt: undefined, scenes: undefined }))
      .filter((o) => Object.values(o).some((v) => v !== undefined));
    parsed = { ...parsed, broll_prompt: undefined, scripts: scripts.length > 0 ? scripts : undefined };
  }

  try {
    const sources = await loadUrlGroundingSources({
      tenant_id: ctx.tenant_id,
      chat_thread_id: ctx.chat_thread_id,
      slack_thread_ts: ctx.slack_routing?.thread_ts,
    });
    const bad = ungroundedHosts(
      [parsed.url, parsed.cta_url, parsed.capture_url].filter((u): u is string => Boolean(u)),
      sources,
    );
    if (bad.length > 0) {
      return fail(
        "render_launch_video_ungrounded_url",
        `I can't put ${bad.join(", ")} in the video — the customer never gave me that URL and it isn't their ` +
          `recorded product URL. ASK them which URL the CTA should point to, wait for their answer, and use exactly ` +
          `what they say. Do NOT guess, and do NOT reuse the example from the tool description.`,
      );
    }
  } catch (e) {
    return fail(
      "render_launch_video_url_check_failed",
      `I couldn't verify the CTA URL against the customer's own data (${(e as Error).message}). ` +
        `Ask them to confirm the URL before I render.`,
    );
  }

  if (parsed.capture_url) {
    try {
      await assertSafeUrl(normalizeCaptureUrl(parsed.capture_url));
    } catch (e) {
      return fail(
        "render_launch_video_capture_url_blocked",
        `I can't capture ${parsed.capture_url} — it isn't a reachable public https address (${(e as Error).message}). ` +
          `Give me the customer's real public product URL, or drop the real-product capture and I'll use the stylized surface.`,
      );
    }
  }

  const variants = resolveScriptVariants(parsed);
  const promptlessBroll = variants.some(
    ({ intake: v }) =>
      !v.broll_prompt?.trim() &&
      (v.scenes ?? []).some((s) => s.kind === "broll" && !s.video_prompt?.trim() && !s.prompt?.trim()),
  );
  if (promptlessBroll) {
    return fail(
      `${toolName}_invalid_input`,
      "A `broll` scene needs `video_prompt`: describe the clip to generate (a person, a scene, the product in motion). Re-send the call with it.",
    );
  }
  const asksAiClip = variants.some(({ intake: v }) => Boolean(v.broll_prompt?.trim()) || (v.scenes ?? []).some((s) => s.kind === "broll"));
  if (asksAiClip) {
    const clipBlock = await channelVideoBlock(ctx.tenant_id);
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify(
        clipBlock
          ? {
              status: "not_enabled",
              message: `${clipBlock.charAt(0).toUpperCase()}${clipBlock.slice(1)}. Nothing was charged.`,
              next: "Tell the founder in your own words that the AI clip in this video cannot be made on their workspace right now and that nothing was charged. Offer the same video without the AI clip: re-send without broll_prompt and without broll scenes if they agree. Do not quote this message or name this tool.",
            }
          : {
              status: "needs_priced_card",
              message: "An AI clip is paid generation, so it is never started from chat. Nothing was charged.",
              next: "Tell the founder in your own words that the AI clip was not made and nothing was charged, because a paid clip needs its price shown first. Offer two ways forward: file it as an ad card with generative_intent so it shows in Suggested ads with its price and they press Make video there, or make the same video without the AI clip now by re-sending without broll_prompt and without broll scenes. Do not quote this message or name this tool.",
            },
      ),
      ms: Date.now() - start,
    };
  }
  let plannedScenes: string[] | undefined;
  try {
    if (variants.length === 1) plannedScenes = intakeToVideoBrief(variants[0].intake).beats.map((b) => b.kind);
  } catch {
    plannedScenes = undefined;
  }

  const target = resolveVideoDeliveryTarget({
    slack_routing: ctx.slack_routing,
    chat_thread_id: ctx.chat_thread_id,
  });
  if (!target) {
    return fail("render_launch_video_no_destination", NO_DELIVERY_SURFACE_MESSAGE);
  }

  try {
    await inngest.send({
      name: "video.render.requested",
      id: `video-render-${ctx.run_id}`,
      data: {
        run_id: ctx.run_id,
        tenant_id: ctx.tenant_id,
        ...renderLaneKeys({ run_id: ctx.run_id, tenant_id: ctx.tenant_id }),
        intake: parsed as unknown as Record<string, unknown>,
        delivery_target: target,
        channel_id: target.kind === "slack" ? target.channel_id : undefined,
        thread_ts: target.kind === "slack" ? target.thread_ts : undefined,
        team_id: target.kind === "slack" ? target.team_id ?? null : null,
      },
    });
  } catch (e) {
    return fail("render_launch_video_enqueue_failed", `Couldn't start the render: ${(e as Error).message}`);
  }

  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      status: "rendering",
      message: "Rendering your video now — I'll post it in this thread in ~3-5 min.",
      ...(plannedScenes
        ? {
            planned_scenes: plannedScenes,
            note: "Describe only planned_scenes to the customer, as a plan. A generated clip (broll) can still drop if generation fails.",
          }
        : {}),
    }),
    ms: Date.now() - start,
  };
}

function callSecondOpinion(start: number): McpCallResult {
  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      status: "not_enabled",
      message: "A second opinion isn't enabled for your workspace.",
    }),
    ms: Date.now() - start,
  };
}

async function isStaffConsoleRun(ctx: PraxisToolCtx): Promise<boolean> {
  if (!ctx.run_id) return false;
  try {
    const { data } = await serviceClient()
      .from("agent_runs")
      .select("payload")
      .eq("id", ctx.run_id)
      .maybeSingle<{ payload: Record<string, unknown> | null }>();
    return (data?.payload as { origin?: unknown } | null)?.origin === "staff_console";
  } catch (e) {
    console.warn(
      `[praxis/handoff] staff-console origin read failed for run ${ctx.run_id}: ${(e as Error).message}`,
    );
    return false;
  }
}

async function latestUserTurn(
  ctx: PraxisToolCtx,
): Promise<{ words: string | null; imagePaths: string[] }> {
  if (!ctx.chat_thread_id) return { words: null, imagePaths: [] };
  try {
    const base = serviceClient()
      .from("agent_thread_messages")
      .select("body, attachments")
      .eq("tenant_id", ctx.tenant_id)
      .eq("thread_id", ctx.chat_thread_id)
      .eq("sender_role", "user");
    const { data } = await (ctx.user_turn_message_id
      ? base.eq("id", ctx.user_turn_message_id)
      : base.order("created_at", { ascending: false }).limit(1)
    ).maybeSingle<{ body: string; attachments: unknown }>();
    const attachments = Array.isArray(data?.attachments) ? (data!.attachments as unknown[]) : [];
    const imagePaths = attachments
      .map((a) => (a && typeof a === "object" ? (a as { path?: unknown; kind?: unknown }) : null))
      .filter((a) => a !== null && (a.kind === undefined || a.kind === "image"))
      .map((a) => a!.path);
    return {
      words: typeof data?.body === "string" ? data.body : null,
      imagePaths: ownChatImagePaths(ctx.tenant_id, imagePaths),
    };
  } catch {
    return { words: null, imagePaths: [] };
  }
}

async function runBuildSession(ctx: PraxisToolCtx): Promise<string | null> {
  if (!ctx.run_id) return null;
  return buildSessionOfRun(serviceClient() as unknown as BindingDb, ctx.tenant_id, ctx.run_id);
}

async function tenantHasOpenSites(tenant_id: string): Promise<boolean> {
  try {
    const sites = (await realRefineProductDeps.listSites?.(tenant_id)) ?? [];
    return sites.some((s) => !["failed", "fell_back_old", "deleting", "deleted"].includes(s.status));
  } catch {
    return false;
  }
}

async function routeUmbrellaAppEditToRefine(
  ctx: PraxisToolCtx,
  intent: string,
  start: number,
): Promise<McpCallResult> {
  const done = (
    message: string,
    extra?: Record<string, unknown>,
  ): McpCallResult => ({
    ok: true,
    is_error: false,
    content: JSON.stringify({
      ok: true,
      routed_to: "refine_product",
      message,
      ...extra,
    }),
    ms: Date.now() - start,
  });
  try {
    const turn = await latestUserTurn(ctx);
    const buildSession = await runBuildSession(ctx);
    const result = await refineProduct({
      tenant_id: ctx.tenant_id,
      message: intent,
      request: turn.words,
      chat_thread_id: ctx.chat_thread_id ?? null,
      photo_paths: turn.imagePaths,
      ...(buildSession ? { conductor_run_id: buildSession } : {}),
    });
    await requestConductorTick(inngest, result.conductor_run_id);
    return done(
      result.direct_merge_enabled && result.stop_at_preview === true
        ? "I've started that change to your site. When it's built, it's ready to review in your " +
            "preview and I'll post back here. Your live site doesn't change until you click Publish."
        : result.direct_merge_enabled
        ? "I've started that change to your app — the engineer is building it now. It deploys to " +
            "your live site automatically once it's done (no PR to merge, nothing for you to do), " +
            "and I'll post back here when it's going live."
        : "I've started that change to your app — the engineer is building it now. It'll come back " +
            "as a pull request with a preview to review, and your live site redeploys with the " +
            "update once it's merged.",
      {
        conductor_run_id: result.conductor_run_id,
        target: result.target?.github_full_name ?? null,
      },
    );
  } catch (e) {
    if (e instanceof InvalidRefineMessage) {
      return done(
        "I couldn't quite tell what to change from that — can you describe the tweak to your " +
          "app in a bit more detail (what should change, and to what)?",
      );
    }
    if (e instanceof NoProvisionedRepo) {
      return done(
        "I don't see a built app to modify yet. Once your app has finished building I can make " +
          "changes to it.",
      );
    }
    if (e instanceof SiteRequired) {
      return done(
        e.reason === "ambiguous"
          ? "You have more than one site, so I can't tell which one to change from here and " +
              "I haven't changed anything. Open that site under Build and ask me there."
          : "I couldn't check which of your sites to change just now, so nothing was started. " +
              "Please try again in a moment.",
      );
    }
    if (e instanceof SiteUnavailable) {
      return done(`${e.message} Nothing was started.`);
    }
    if (e instanceof OldSiteFrozen) {
      const { error } = oldSiteFrozenBody();
      return done(error.message, { code: error.code, action: error.action });
    }
    if (e instanceof ConductorRunNotFound) {
      return done(
        "That build isn't the one I can change any more, so nothing was started. Open your " +
          "current site under Build and ask me there.",
      );
    }
    if (e instanceof BuildRetired) {
      return done(
        "This app was retired when we upgraded the builder, so it's offline and can't be " +
          "changed. Start a new build from the Build page to get a fresh app.",
      );
    }
    if (e instanceof DoubleBuildInFlight) {
      return done(
        "A change to your app is already in progress — I'll hold off on this one so the two " +
          "don't collide. Try again once the current change lands.",
      );
    }
    if (e instanceof TooManyBuildsToday) {
      return done(
        "You've hit today's limit for app changes. This one will have to wait until tomorrow.",
      );
    }
    if (e instanceof FreeEditsUsed) {
      return done(`${e.message} Nothing was started.`);
    }
    if (e instanceof InsufficientCreditsForBuild) {
      return done(
        refusalFor({
          kind: "credits_for_build",
          required_credits: e.required_credits,
          remaining_credits: e.remaining_credits,
          free_plan: e.free_plan,
          scope: e.scope,
        }).message,
      );
    }
    if (e instanceof ProvisionBudgetExceeded) {
      return done(
        "This change would go over the spending cap for your app right now, so I didn't start " +
          "it. Raise the cap or try again later.",
      );
    }
    if (e instanceof InsufficientCreditsForBuild) {
      return done(
        refusalFor({
          kind: "credits_for_build",
          required_credits: e.required_credits,
          remaining_credits: e.remaining_credits,
        }).message,
      );
    }
    if (e instanceof FleetHalted) {
      return done(
        "App changes are paused for maintenance at the moment. Please try again shortly.",
      );
    }
    if (e instanceof UndoInProgress) {
      return done("An undo is still running for your app. Once it finishes I can make this change.");
    }
    if (e instanceof SitePreviewRestarting) {
      return done("This site's preview is restarting. Once it is back I can make this change.");
    }
    if (e instanceof AppFrozen) {
      return done(
        "Changes to this app are currently frozen. Once it's unfrozen I can make this change.",
      );
    }
    // eslint-disable-next-line no-console
    console.error(
      `[praxis__handoff] umbrella app-edit refine failed for tenant=${ctx.tenant_id}: ${(e as Error).message}`,
    );
    return done(
      "I hit a problem starting that change to your app just now. I've logged it — please try " +
        "again in a moment.",
    );
  }
}

async function tenantBuildName(tenant_id: string): Promise<string> {
  let displayName: string | null = null;
  try {
    const { data } = await serviceClient()
      .from("tenants")
      .select("display_name")
      .eq("id", tenant_id)
      .maybeSingle<{ display_name: string | null }>();
    displayName = typeof data?.display_name === "string" ? data.display_name.trim().slice(0, 100) : null;
  } catch {
    displayName = null;
  }
  return displayName && !validateCompanyName(displayName) ? displayName : "My App";
}

type AppBuildRoute = "refine" | "fresh_build" | "fresh_build_unavailable" | null;

async function appBuildRouteFor(
  ctx: PraxisToolCtx,
  surface: string,
  target: string,
  scope: AppBuildScope,
): Promise<AppBuildRoute> {
  const wholeAppBuild = scope !== "existing";
  if (isHeavyDispatch(target) && scope === "separate_app") {
    return surface === "chat" && (await isProductBuilderEnabled().catch(() => false))
      ? "fresh_build"
      : "fresh_build_unavailable";
  }
  if (
    target === "engineer" &&
    !wholeAppBuild &&
    (await isUmbrellaProvisionedTenant(ctx.tenant_id))
  ) {
    return "refine";
  }
  if (target === "engineer" && !wholeAppBuild) {
    let bound: string | null;
    try {
      bound = await runBuildSession(ctx);
    } catch {
      return "refine";
    }
    if (bound) return "refine";
    if (
      (await tenantHasOpenSites(ctx.tenant_id)) &&
      (await checkSandboxRepoAccess(ctx.tenant_id, undefined)) === "not_connected"
    ) {
      return "refine";
    }
  }
  if (
    surface === "chat" &&
    isHeavyDispatch(target) &&
    wholeAppBuild &&
    (await checkSandboxRepoAccess(ctx.tenant_id, undefined)) === "not_connected" &&
    (await isProductBuilderEnabled().catch(() => false))
  ) {
    return "fresh_build";
  }
  return null;
}

async function freshBuildQuoteCredits(tenant_id: string): Promise<number> {
  const free = realStartProductBuildDeps.isFirstBuildFree
    ? await realStartProductBuildDeps.isFirstBuildFree(tenant_id).catch(() => false)
    : false;
  return free ? 0 : requiredBuildCredits();
}

async function callerMayChangeApp(ctx: PraxisToolCtx): Promise<boolean> {
  const userId = ctx.user_id ?? ctx.actor?.actor_user_id ?? null;
  if (userId) return isTenantAdminOrOwner(serviceClient() as never, userId, ctx.tenant_id);
  const source = ctx.actor?.actor_source;
  return source !== "slack" && source !== "chat" && ctx.trigger !== "slack" && ctx.trigger !== "chat";
}

async function routeFreshBuildToProductBuild(
  ctx: PraxisToolCtx,
  intent: string,
  start: number,
): Promise<McpCallResult> {
  const refused = (message: string): McpCallResult => ({
    ok: false,
    is_error: true,
    content: JSON.stringify({ error: "product_build_not_started", message }),
    ms: Date.now() - start,
  });
  const turn = await latestUserTurn(ctx);
  const raw = [intent, turn.words ?? ""].map((s) => s.trim()).find((s) => s.length >= 8) ?? "";
  if (!raw) {
    return refused("Tell me a little more about the app you want, and I'll start the build.");
  }
  const idea = xmlEscapeContent(sanitizeFetchedContent(raw.slice(0, 4000)));
  const user_id = ctx.user_id ?? ctx.actor?.actor_user_id ?? null;
  try {
    const result = await startProductBuild({
      tenant_id: ctx.tenant_id,
      company_name: await tenantBuildName(ctx.tenant_id),
      idea,
      started_by_user_id: user_id,
    });
    await requestConductorTick(inngest, result.conductor_run_id);
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify({
        ok: true,
        routed_to: "product_build",
        conductor_run_id: result.conductor_run_id,
        message: "Started building your app. You can follow it on the Build page.",
      }),
      ms: Date.now() - start,
    };
  } catch (e) {
    if (e instanceof DoubleBuildInFlight) {
      return refused("A build is already running. Stop it on the Build page before starting another.");
    }
    if (e instanceof TooManyBuildsToday) {
      return refused("You've reached today's build limit. Try again tomorrow.");
    }
    if (e instanceof InsufficientCreditsForBuild) {
      return refused(
        refusalFor({
          kind: "credits_for_build",
          required_credits: e.required_credits,
          remaining_credits: e.remaining_credits,
          free_plan: e.free_plan,
        }).message,
      );
    }
    if (e instanceof ProvisionBudgetExceeded) {
      return refused("This build would go over today's spending cap, so it didn't start. Try again later.");
    }
    if (e instanceof BuildRepoNotProvisioned) {
      return refused(e.message);
    }
    console.error(
      `[praxis__handoff] fresh product build failed for tenant=${ctx.tenant_id}: ${(e as Error).message}`,
    );
    return refused("Something went wrong starting the build. Try again.");
  }
}

type HandoffRepoTarget =
  | { kind: "hint"; repo: string }
  | { kind: "unset" }
  | { kind: "ask"; repos: string[] };

async function resolveHandoffRepo(
  ctx: PraxisToolCtx,
  intent: string,
): Promise<HandoffRepoTarget> {
  const umbrellaPrefix = `${UMBRELLA_CONNECTOR_ACCOUNT_LOGIN}/`;
  const connectedRepos = await getScopedRepoFullNames(ctx.tenant_id);
  const repos = connectedRepos.filter((r) => !r.startsWith(umbrellaPrefix));
  if (repos.length === 0) return { kind: "unset" };

  if (ctx.chat_thread_id) {
    try {
      const { data } = await serviceClient()
        .from("agent_threads")
        .select("repo_full_name")
        .eq("id", ctx.chat_thread_id)
        .eq("tenant_id", ctx.tenant_id)
        .maybeSingle();
      const sticky = (data as { repo_full_name?: unknown } | null)?.repo_full_name;
      if (typeof sticky === "string" && repos.includes(sticky)) {
        return { kind: "hint", repo: sticky };
      }
    } catch {
    }
  }

  if (repos.length === 1) return { kind: "hint", repo: repos[0] };

  try {
    const decision = await pickRepoForTask({
      task_description: intent,
      repos,
      tenant_id: ctx.tenant_id,
    });
    if (decision && decision.decision === "pick" && repos.includes(decision.repo)) {
      return { kind: "hint", repo: decision.repo };
    }
  } catch (e) {
    console.warn(
      `[praxis__handoff] engineer repo-pick failed; asking the user instead: ${(e as Error).message}`,
    );
  }
  return { kind: "ask", repos };
}

function repoPickRequiredResult(
  repos: string[],
  intent: string,
  start: number,
  reason?: string,
): McpCallResult {
  const body = `${reason ? `${reason} ` : ""}I need a repo to work in. Pick one:\n${repos
    .map((r) => `  • ${r}`)
    .join("\n")}\n\nReply with the name. I'll remember it for this conversation so I don't ask again here.`;
  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      ok: true,
      needs_repo_pick: true,
      message: `${body}\n\nAsk the user this and wait for their pick. Do NOT say you've handed off; you haven't yet.`,
      meta: {
        awaiting_repo_pick: true,
        repos,
        pending_task_description: intent,
      },
    }),
    ms: Date.now() - start,
  };
}

async function resolveParentUserText(ctx: PraxisToolCtx): Promise<string> {
  try {
    if (!ctx.run_id) return "";
    const sb = serviceClient();
    const { data, error } = await sb
      .from("agent_runs")
      .select("payload")
      .eq("id", ctx.run_id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (error || !data) return "";
    const fromPayload = extractUserMessageFromPayload(data.payload).trim();
    if (fromPayload) return fromPayload;
    const msgId = (data.payload as Record<string, unknown> | null)?.user_message_id;
    if (typeof msgId !== "string" || !msgId) return "";
    const { data: msg, error: msgErr } = await tenantClient(asTenantId(ctx.tenant_id))
      .from("agent_thread_messages")
      .select("body")
      .eq("id", msgId)
      .eq("sender_role", "user")
      .maybeSingle();
    const body = (msg as { body?: unknown } | null)?.body;
    return !msgErr && typeof body === "string" ? body.trim() : "";
  } catch {
    return "";
  }
}

async function founderRefForChild(ctx: PraxisToolCtx): Promise<FounderMessageRef | "unreadable" | null> {
  return founderMessageRefForChild(ctx.tenant_id, ctx.run_id, { strict: true }).catch(() => "unreadable" as const);
}

function stampFounderRef(payload: Record<string, unknown>, ref: FounderMessageRef | "unreadable" | null): void {
  delete payload.founder_message_ref;
  delete payload[FOUNDER_REF_UNREADABLE];
  if (ref === "unreadable") payload[FOUNDER_REF_UNREADABLE] = true;
  else if (ref) payload.founder_message_ref = ref;
}

type PinnedMention = { state: "none" } | { state: "pinned"; target: string } | { state: "unreadable" };

async function readPinnedMentionTarget(ctx: PraxisToolCtx): Promise<PinnedMention> {
  if (!ctx.run_id) return { state: "none" };
  try {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("payload")
      .eq("id", ctx.run_id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle<{ payload: Record<string, unknown> | null }>();
    if (error || !data) return { state: "unreadable" };
    const target = (data.payload as Record<string, unknown> | null)?.mention_target;
    return typeof target === "string" && target.length > 0 ? { state: "pinned", target } : { state: "none" };
  } catch {
    return { state: "unreadable" };
  }
}

function pinUnreadableResult(start: number): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: "handoff_pin_unreadable",
      message: "This turn could not be checked just now. Tell the user in one line that it did not go through and ask them to send it again. Do NOT call praxis__handoff again this turn.",
    }),
    ms: Date.now() - start,
  };
}

async function readParentSurfaceRouting(
  ctx: PraxisToolCtx,
  payloadKey: "teams" | "telegram" | "discord" | "whatsapp" | "imessage",
  requiredFields: ReadonlyArray<
    | "conversation_reference"
    | "chat_id"
    | "channel_id"
    | "guild_id"
    | "wa_id"
    | "phone_number_id"
    | "line"
    | "handle"
  >,
): Promise<Record<string, unknown> | null> {
  try {
    if (!ctx.run_id) return null;
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("payload")
      .eq("id", ctx.run_id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle<{ payload: Record<string, unknown> | null }>();
    if (error || !data) return null;
    const routing = (data.payload as Record<string, unknown> | null)?.[payloadKey];
    if (!routing || typeof routing !== "object") return null;
    const t = routing as Record<string, unknown>;
    return requiredFields.every((f) => t[f]) ? t : null;
  } catch {
    return null;
  }
}

export async function callPraxisTool(
  ctx: PraxisToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();

  if (tool_name === "handoff" || tool_name === "handoff_parallel" || tool_name === "ask_agent") {
    if (await isStaffConsoleRun(ctx)) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "handoff_disabled_staff_console",
          message:
            "Handoff is disabled in the staff operator console. Answer directly or propose the write for the customer's approval queue.",
        }),
        ms: Date.now() - start,
      };
    }
  }

  if (tool_name === "action") {
    return callPraxisAction(ctx, args, start);
  }

  if (tool_name === "propose_dispatch") {
    return callProposeDispatch(ctx, args, start);
  }

  if (tool_name === "propose_standing_order") {
    return callProposeStandingOrder(ctx, args, start);
  }

  if (tool_name === "propose_research_watch") {
    return callProposeResearchWatch(ctx, args, start);
  }

  if (tool_name === "remind") {
    return callRemind(ctx, args, start);
  }

  if (tool_name === "list_reminders") {
    return callListReminders(ctx, start);
  }

  if (tool_name === "list_open_cards" || tool_name === "show_card") {
    const { callCardTool } = await import("./praxis-cards");
    return callCardTool(ctx, tool_name, args, start);
  }

  if (tool_name === "cancel_reminder") {
    return callCancelReminder(ctx, args, start);
  }

  if (tool_name === "list_product_builds") {
    return callListProductBuilds(ctx, start);
  }

  if (tool_name === "propose_custom_agent") {
    return callProposeCustomAgent(ctx, args, start);
  }

  if (tool_name === "enable_database") {
    return callEnableDatabase(ctx, args, start);
  }

  if (tool_name === "run_site_check") {
    const { runSiteCheck } = await import("@/services/start-card/site-check-tool");
    const result = await runSiteCheck(
      {
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        tool_use_id: ctx.tool_use_id,
        trigger: ctx.trigger,
        chat_thread_id: ctx.chat_thread_id,
        slack_routing: ctx.slack_routing,
        writes_suppressed: ctx.writes_suppressed,
      },
      args,
    );
    return { ok: true, is_error: false, content: JSON.stringify(result), ms: Date.now() - start };
  }

  if (tool_name === "handoff_parallel") {
    return callPraxisHandoffParallel(ctx, args, start);
  }

  if (tool_name === "ask_agent") {
    return callPraxisAskAgent(ctx, args, start);
  }

  if (tool_name === "render_video" || tool_name === "render_launch_video") {
    return callRenderLaunchVideo(ctx, args, start, tool_name);
  }

  if (tool_name === "second_opinion") {
    return callSecondOpinion(start);
  }

  if (tool_name !== "handoff") {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `praxis/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }

  const pmAllowed =
    ctx.agent_slug === "pm" && (await isPmInteractiveHandoffEnabled());
  const gate = await gateOperatorOrCustomCaller(
    ctx,
    "handoff",
    pmAllowed ? "pm" : undefined,
  );
  if (!gate.ok) {
    void logHandoffIntent({
      tenant_id: ctx.tenant_id,
      source_agent_slug: ctx.agent_slug ?? null,
      target_agent_slug:
        (args as { target_agent_slug?: unknown } | null)?.target_agent_slug &&
        typeof (args as { target_agent_slug?: unknown }).target_agent_slug === "string"
          ? ((args as { target_agent_slug: string }).target_agent_slug)
          : null,
      surface: ctx.trigger ?? "unknown",
      authorized: false,
      reject_reason: gate.error,
      run_id: ctx.run_id ?? null,
    });
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: gate.error, message: gate.message }),
      ms: Date.now() - start,
    };
  }

  let parsed: z.infer<typeof handoffInput>;
  try {
    parsed = handoffInput.parse(args);
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "input_invalid",
        message: (e as Error).message,
      }),
      ms: Date.now() - start,
    };
  }

  if (ctx.agent_slug === "pm" && parsed.target_agent_slug !== "engineer") {
    void logHandoffIntent({
      tenant_id: ctx.tenant_id,
      source_agent_slug: ctx.agent_slug ?? null,
      target_agent_slug: parsed.target_agent_slug,
      surface: gate.surface,
      authorized: false,
      reject_reason: "target_invalid",
      run_id: ctx.run_id ?? null,
    });
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "handoff_target_invalid",
        message: "pm may only hand off to the engineer.",
      }),
      ms: Date.now() - start,
    };
  }

  if (parsed.target_agent_slug === "operator" || parsed.target_agent_slug === ctx.agent_slug) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "handoff_self_loop",
        message: "Cannot hand off to operator from operator.",
      }),
      ms: Date.now() - start,
    };
  }

  const pin = await readPinnedMentionTarget(ctx);
  if (pin.state === "unreadable") return pinUnreadableResult(start);
  const pinnedMention = pin.state === "pinned" ? pin.target : null;
  const founderDirectMention = pinnedMention !== null && parsed.target_agent_slug === pinnedMention;
  if (pinnedMention && parsed.target_agent_slug !== pinnedMention) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "handoff_target_invalid",
        message: `This turn addressed @${pinnedMention} directly. Hand off to "${pinnedMention}", not "${parsed.target_agent_slug}".`,
      }),
      ms: Date.now() - start,
    };
  }

  const visible = await getVisibleAgentSlugs(ctx.tenant_id);
  const channels = channelAgentSlugs();
  const customTarget =
    isCustomAgentSlug(parsed.target_agent_slug) &&
    (await isActiveCustomAgentOfTenant(ctx.tenant_id, parsed.target_agent_slug));
  if (
    !customTarget &&
    !visible.has(parsed.target_agent_slug) &&
    !channels.has(parsed.target_agent_slug)
  ) {
    const specialists = Array.from(visible)
      .filter((s) => s !== "operator")
      .sort();
    const channelList = Array.from(channels).sort();
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "handoff_target_invalid",
        message: `Agent "${parsed.target_agent_slug}" is not a valid handoff target. Specialists: ${specialists.join(", ")}. Channels: ${channelList.join(", ")}.`,
      }),
      ms: Date.now() - start,
    };
  }

  if (isAssistantRun(ctx.trigger) && ASSISTANT_BLOCKED_AGENTS.has(parsed.target_agent_slug)) {
    return assistantBlockedResult(ASSISTANT_BLOCKED_MESSAGE, start);
  }

  try {
    const tierDecision = await checkAgentTier(ctx.tenant_id, parsed.target_agent_slug, {
      engineerBackendRun: isEngineerBackendRun(parsed.target_agent_slug, {
        trigger: "a2a",
        enqueuedByUser: false,
        payload: founderDirectMention ? { [FOUNDER_DIRECT_AGENT_MENTION_KEY]: true } : {},
      }),
    });
    if (!tierDecision.allowed) {
      return planUpgradeHandoffResult(parsed.target_agent_slug, tierDecision.required_tier, start);
    }
  } catch {
  }

  const inferredBuildScope = appBuildScope(parsed.intent);
  const buildScope = inferredBuildScope === "existing" && parsed.context?.full_build === true
    ? "whole_app"
    : inferredBuildScope;
  const appBuildRoute = await appBuildRouteFor(
    ctx,
    gate.surface,
    parsed.target_agent_slug,
    buildScope,
  );
  if (appBuildRoute && isAssistantRun(ctx.trigger)) {
    return assistantBlockedResult(ASSISTANT_BUILD_BLOCKED_MESSAGE, start);
  }
  if (appBuildRoute && !(await callerMayChangeApp(ctx))) {
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify({
        ok: true,
        routed_to: appBuildRoute === "refine" ? "refine_product" : "product_build",
        not_permitted: true,
        message: "Only an owner or admin of this workspace can change or build the app.",
      }),
      ms: Date.now() - start,
    };
  }

  if (appBuildRoute === "fresh_build_unavailable") {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "product_build_unavailable",
        message: gate.surface === "chat"
          ? "The app builder is unavailable, so I could not start a separate project. Your existing app has not changed."
          : "Start the separate project from Zavi chat or the Build page. Your existing app has not changed.",
      }),
      ms: Date.now() - start,
    };
  }

  if (
    !ctx.heavy_confirm_preclaimed &&
    gate.surface === "chat" &&
    isHeavyDispatch(parsed.target_agent_slug) &&
    buildScope !== "existing" &&
    (await isHeavyDispatchConfirmEnabled())
  ) {
    const est_credits =
      appBuildRoute === "fresh_build"
        ? await freshBuildQuoteCredits(ctx.tenant_id)
        : reserveEstimateFor(parsed.target_agent_slug);
    const est_usd = creditsToUsd(est_credits);
    const armed = ctx.chat_thread_id
      ? await armHeavyDispatchPending({
          tenant_id: ctx.tenant_id,
          thread_id: ctx.chat_thread_id,
          armed_run_id: ctx.run_id ?? null,
          user_id: ctx.user_id ?? null,
          target: parsed.target_agent_slug,
          intent: parsed.intent,
          context: (parsed.context as Record<string, unknown> | undefined) ?? null,
          est_credits,
        })
      : null;
    if (!armed) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "heavy_confirm_unavailable",
          message:
            "This is a large build and it could not be set up for the user to start just now. Tell them that in one line and ask them to send the request again. Do NOT call praxis__handoff again this turn.",
        }),
        ms: Date.now() - start,
      };
    }
    void logHandoffIntent({
      tenant_id: ctx.tenant_id,
      source_agent_slug: ctx.agent_slug ?? null,
      target_agent_slug: parsed.target_agent_slug,
      surface: gate.surface,
      authorized: false,
      reject_reason: "heavy_confirm_required",
      run_id: ctx.run_id ?? null,
    });
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify({
        ok: true,
        pending_confirmation: true,
        target: parsed.target_agent_slug,
        est_credits,
        est_usd,
        message: `${
          est_credits === 0
            ? "This build is free: it is this workspace's first build."
            : `This is a large build (about ${est_credits} credits, $${est_usd.toFixed(2)}).`
        } Your reply shows the user a Start button, and a plain "yes" from them also starts it; the server starts the build, not you. Tell them the cost in one line and stop. Do NOT call praxis__handoff again for this build, and do NOT say you've handed off.`,
      }),
      ms: Date.now() - start,
    };
  }

  if (appBuildRoute === "refine") {
    return routeUmbrellaAppEditToRefine(ctx, parsed.intent, start);
  }
  if (appBuildRoute === "fresh_build") {
    return routeFreshBuildToProductBuild(ctx, parsed.intent, start);
  }

  if (
    parsed.target_agent_slug === "engineer" &&
    gate.surface === "chat" &&
    ctx.agent_slug !== "pm" &&
    !founderDirectMention
  ) {
    const fanout = await maybeFanOutEngineerHandoff(ctx, parsed, start);
    if (fanout) return fanout;
  }

  const parentLineage = await readParentLineage(ctx.run_id);
  const guard = await checkDelegationAllowed({
    tenant_id: ctx.tenant_id,
    parentLineage,
    source_agent_slug: ctx.agent_slug ?? "operator",
    target_agent_slug: parsed.target_agent_slug,
  });
  if (!guard.ok) {
    return delegationRefusedResult(guard, start);
  }

  const delegationContext = resolveDelegationContext(ctx, parsed.context);

  let resolvedRepoHint: string | undefined;
  if (parsed.target_agent_slug === "engineer") {
    const repoTarget = await resolveHandoffRepo(ctx, parsed.intent);
    if (repoTarget.kind === "ask") {
      void logHandoffIntent({
        tenant_id: ctx.tenant_id,
        source_agent_slug: ctx.agent_slug ?? null,
        target_agent_slug: parsed.target_agent_slug,
        surface: gate.surface,
        authorized: false,
        reject_reason: "repo_pick_required",
        run_id: ctx.run_id ?? null,
      });
      return repoPickRequiredResult(repoTarget.repos, parsed.intent, start);
    }
    if (repoTarget.kind === "hint") {
      if (await repoIsEmpty({ tenant_id: ctx.tenant_id, repo_full_name: repoTarget.repo })) {
        void logHandoffIntent({
          tenant_id: ctx.tenant_id,
          source_agent_slug: ctx.agent_slug ?? null,
          target_agent_slug: parsed.target_agent_slug,
          surface: gate.surface,
          authorized: false,
          reject_reason: "repo_empty",
          run_id: ctx.run_id ?? null,
        });
        const reason = `${repoTarget.repo} has no branches yet.`;
        const others = (await getScopedRepoFullNames(ctx.tenant_id)).filter(
          (r) => r !== repoTarget.repo && !r.startsWith(`${UMBRELLA_CONNECTOR_ACCOUNT_LOGIN}/`),
        );
        if (others.length > 0) return repoPickRequiredResult(others, parsed.intent, start, reason);
        return {
          ok: false,
          is_error: true,
          content: JSON.stringify({
            error: "handoff_repo_empty",
            message: `${reason} The engineer cannot start there, and nothing was handed off. Ask the user to connect a repo that has code, or to add a first branch to this one. Do NOT say you've handed off.`,
          }),
          ms: Date.now() - start,
        };
      }
      resolvedRepoHint = repoTarget.repo;
    }
  }

  const parentUserText = await resolveParentUserText(ctx);

  const teamsRouting =
    gate.surface === "teams"
      ? await readParentSurfaceRouting(ctx, "teams", ["conversation_reference"])
      : null;
  const telegramRouting =
    gate.surface === "telegram"
      ? await readParentSurfaceRouting(ctx, "telegram", ["chat_id"])
      : null;
  const discordRouting =
    gate.surface === "discord"
      ? await readParentSurfaceRouting(ctx, "discord", ["channel_id"])
      : null;
  const whatsappRouting =
    gate.surface === "whatsapp"
      ? await readParentSurfaceRouting(ctx, "whatsapp", ["wa_id", "phone_number_id"])
      : null;
  const imessageRouting =
    gate.surface === "imessage"
      ? await readParentSurfaceRouting(ctx, "imessage", ["line", "handle"])
      : null;

  let childPayload: Record<string, unknown>;
  let childTrigger:
    | "slack"
    | "a2a"
    | "handoff"
    | "mcp"
    | "email"
    | "teams"
    | "telegram"
    | "discord"
    | "whatsapp"
    | "imessage";
  if (gate.surface === "slack" && ctx.slack_routing) {
    childTrigger = "slack";
    const slackImages = await resolveForwardedSlackImages(ctx);
    childPayload = {
      slack: slackImages.length > 0 ? { ...ctx.slack_routing, images: slackImages } : ctx.slack_routing,
      intent: parsed.intent,
      ...(parentUserText ? { current_user_text_raw: parentUserText } : {}),
      user_id: ctx.user_id ?? null,
      source: "slack" as const,
      slack_handoff_child: true,
    };
  } else if (gate.surface === "email" && ctx.email_routing) {
    childTrigger = "email";
    childPayload = {
      email: ctx.email_routing,
      intent: parsed.intent,
      ...(parentUserText ? { current_user_text_raw: parentUserText } : {}),
      user_id: ctx.user_id ?? null,
      source: "email" as const,
      handoff_child: true,
    };
  } else if (gate.surface === "teams" && teamsRouting) {
    childTrigger = "teams";
    childPayload = {
      teams: teamsRouting,
      intent: parsed.intent,
      ...(parentUserText ? { current_user_text_raw: parentUserText } : {}),
      user_id: ctx.user_id ?? null,
      source: "teams" as const,
      handoff_child: true,
    };
  } else if (gate.surface === "telegram" && telegramRouting) {
    childTrigger = "telegram";
    childPayload = {
      telegram: telegramRouting,
      intent: parsed.intent,
      ...(parentUserText ? { current_user_text_raw: parentUserText } : {}),
      user_id: ctx.user_id ?? null,
      source: "telegram" as const,
      handoff_child: true,
    };
  } else if (gate.surface === "discord" && discordRouting) {
    childTrigger = "discord";
    childPayload = {
      discord: discordRouting,
      intent: parsed.intent,
      ...(parentUserText ? { current_user_text_raw: parentUserText } : {}),
      user_id: ctx.user_id ?? null,
      source: "discord" as const,
      handoff_child: true,
    };
  } else if (gate.surface === "whatsapp" && whatsappRouting) {
    childTrigger = "whatsapp";
    childPayload = {
      whatsapp: whatsappRouting,
      intent: parsed.intent,
      ...(parentUserText ? { current_user_text_raw: parentUserText } : {}),
      user_id: ctx.user_id ?? null,
      source: "whatsapp" as const,
      whatsapp_handoff_child: true,
    };
  } else if (gate.surface === "imessage" && imessageRouting) {
    childTrigger = "imessage";
    childPayload = {
      imessage: imessageRouting,
      intent: parsed.intent,
      ...(parentUserText ? { current_user_text_raw: parentUserText } : {}),
      user_id: ctx.user_id ?? null,
      source: "imessage" as const,
      handoff_child: true,
    };
  } else if (gate.surface === "scheduled") {
    childTrigger = "a2a";
    childPayload = {
      intent: parsed.intent,
      message: parsed.intent,
      source_agent_slug: ctx.agent_slug ?? null,
      conversation_answer: true,
    };
  } else if (gate.surface === "mcp") {
    childTrigger = "mcp";
    childPayload = {
      intent: parsed.intent,
      message: parsed.intent,
      ...(parentUserText ? { current_user_text_raw: parentUserText } : {}),
      user_id: ctx.user_id ?? null,
      source: "mcp" as const,
      conversation_answer: true,
    };
  } else {
    childTrigger = "handoff";
    childPayload = {
      operator_thread_id: ctx.chat_thread_id,
      intent: parsed.intent,
      ...(parentUserText ? { current_user_text_raw: parentUserText } : {}),
      user_id: ctx.user_id,
      source_agent_slug: ctx.agent_slug ?? "operator",
    };
  }
  if (!childPayload.source_agent_slug) {
    childPayload.source_agent_slug = ctx.agent_slug ?? "operator";
  }
  if (ctx.actor) {
    childPayload = { ...childPayload, inherited_actor: ctx.actor };
  }
  if (delegationContext) {
    childPayload = { ...childPayload, delegation_context: delegationContext };
  }
  childPayload = buildChildLineagePayload(childPayload, {
    lineage_id: guard.lineage_id,
    childDepth: guard.childDepth,
  });
  stampFounderRef(childPayload, await founderRefForChild(ctx));
  if (founderDirectMention) childPayload[FOUNDER_DIRECT_AGENT_MENTION_KEY] = true;

  if (resolvedRepoHint) {
    childPayload.repo_hint = resolvedRepoHint;
  }
  if (parsed.target_agent_slug === "engineer") {
    childPayload.task_description = parsed.intent;
  }

  const forwarded = await resolveForwardedAttachmentRefs(ctx);
  if (forwarded.refs.length > 0) {
    childPayload.attachment_paths = forwarded.refs;
  } else if (forwarded.expiredUpload && typeof childPayload.intent === "string") {
    childPayload.intent = `${childPayload.intent}\n\n${EXPIRED_UPLOAD_NOTE}`;
  } else if (forwarded.forwardingOff && typeof childPayload.intent === "string") {
    childPayload.intent = `${childPayload.intent}\n\n${FORWARDING_OFF_NOTE}`;
  }
  const forwardedVideoPaths = await resolveForwardedVideoPaths(ctx);
  if (forwardedVideoPaths.length > 0) {
    childPayload.video_paths = forwardedVideoPaths;
  }

  const delegatedReplyFlag =
    gate.surface === "slack"
      ? "slack_reply_delegated"
      : gate.surface === "email"
        ? "email_reply_delegated"
        : gate.surface === "teams" && teamsRouting
          ? "teams_reply_delegated"
          : gate.surface === "telegram" && telegramRouting
            ? "telegram_reply_delegated"
            : gate.surface === "discord" && discordRouting
              ? "discord_reply_delegated"
              : gate.surface === "whatsapp" && whatsappRouting
                ? "whatsapp_reply_delegated"
                : gate.surface === "imessage" && imessageRouting
                  ? "imessage_reply_delegated"
                  : null;
  if (delegatedReplyFlag) {
    await patchParentRunPayload(ctx.run_id, { [delegatedReplyFlag]: true });
  }

  const channelAdmission = await admitDirectChannelRun(
    ctx.tenant_id,
    parsed.target_agent_slug,
    parsed.for_channel,
  );
  if (!channelAdmission.allowed) {
    if (delegatedReplyFlag) {
      await patchParentRunPayload(ctx.run_id, { [delegatedReplyFlag]: false });
    }
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify(refusedHandoffPayload(channelAdmission)),
      ms: Date.now() - start,
    };
  }

  let run_id: string;
  try {
    const stampChannel = channelAdmission.channel_slug;
    if (stampChannel) childPayload.channel_slug = stampChannel;
    const enqueued = await enqueueAgentRun({
      tenant_id: ctx.tenant_id,
      agent_slug: parsed.target_agent_slug,
      trigger: childTrigger,
      payload: childPayload,
      parent_run_id: ctx.run_id ?? undefined,
      ...(stampChannel
        ? {
            before_dispatch: async (rid: string) => {
              const stamped = await stampDirectChannelRunWithin(ctx.tenant_id, rid, stampChannel);
              if (stamped !== true) {
                console.warn(`[praxis__handoff] channel stamp ${stamped === "timeout" ? "timed out" : "did not land"} (run=${rid}, channel=${stampChannel}); dispatching unstamped`);
              }
            },
          }
        : {}),
    });
    run_id = enqueued.run_id;
  } catch (e) {
    if (delegatedReplyFlag) {
      await patchParentRunPayload(ctx.run_id, { [delegatedReplyFlag]: false });
    }
    if (e instanceof StaffModelCapError) return staffModelCapHandoffResult(start);
    const planRefusal = asPlanUpgradeRequired(e);
    if (planRefusal) {
      return planUpgradeHandoffResult(parsed.target_agent_slug, planRefusal.required_tier, start);
    }
    throw e;
  }

  await recordDelegation({
    tenant_id: ctx.tenant_id,
    lineage_id: guard.lineage_id,
    depth: guard.childDepth,
    parent_run_id: ctx.run_id ?? null,
    child_run_id: run_id,
    source_agent_slug: ctx.agent_slug ?? "operator",
    target_agent_slug: parsed.target_agent_slug,
  });

  if (gate.surface === "mcp") {
    await patchParentRunPayload(ctx.run_id, { delegated_child_run_id: run_id });
  }

  let joined = false;
  if (gate.surface === "scheduled" && ctx.run_id) {
    joined = await registerCustomHandoffJoin(ctx.tenant_id, ctx.run_id, run_id);
  }

  void logHandoffIntent({
    tenant_id: ctx.tenant_id,
    source_agent_slug: ctx.agent_slug ?? null,
    target_agent_slug: parsed.target_agent_slug,
    surface: gate.surface,
    authorized: true,
    run_id: ctx.run_id ?? null,
  });

  const sink =
    gate.surface === "slack"
      ? "this Slack thread"
      : gate.surface === "email"
        ? "this email thread"
        : gate.surface === "mcp"
          ? "this run (poll the same run_id)"
          : gate.surface === "scheduled"
            ? joined
              ? "this agent's scheduled message (it waits for the result)"
              : "that agent's run history"
            : "here";
  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      ok: true,
      run_id,
      target: parsed.target_agent_slug,
      delegation_mode: parsed.context?.mode ?? "intent_only",
      message:
        parsed.target_agent_slug === "generated_video"
          ? generatedVideoHandoffMessage(run_id)
          : `Handing off to @${parsed.target_agent_slug}. Run ${run_id} — I'll post the result back in ${sink} when it finishes. Its result says what it did and whether anything waits for the founder's approval; do not promise an approval step or an outcome before then.`,
    }),
    ms: Date.now() - start,
  };
}

function generatedVideoHandoffMessage(run_id: string): string {
  return `Handing off to @generated_video. Run ${run_id}. Tell the founder only that the request went to the video team, which checks it and replies here. Do not say what it will make, who or what will be in it, whether a video or ideas will come back, or what it will cost, and do not mention any other video tool or whether it is switched on.`;
}

const ASK_SURFACE_ROUTING: Record<
  "teams" | "telegram" | "discord" | "whatsapp" | "imessage",
  { fields: string[]; flag: string }
> = {
  teams: { fields: ["conversation_reference"], flag: "handoff_child" },
  telegram: { fields: ["chat_id"], flag: "handoff_child" },
  discord: { fields: ["channel_id"], flag: "handoff_child" },
  whatsapp: { fields: ["wa_id", "phone_number_id"], flag: "whatsapp_handoff_child" },
  imessage: { fields: ["line", "handle"], flag: "handoff_child" },
};

async function callPraxisAskAgent(
  ctx: PraxisToolCtx,
  args: unknown,
  start: number,
): Promise<McpCallResult> {
  const fail = (error: string, message: string): McpCallResult => ({
    ok: false,
    is_error: true,
    content: JSON.stringify({ error, message }),
    ms: Date.now() - start,
  });
  const unavailable = (why: string) =>
    fail("ask_agent_unavailable", `${why} Use praxis__handoff instead; its result posts in this thread.`);

  if (!(await isAskAgentEnabled())) return unavailable("Asking and waiting is switched off right now.");

  const gate = await gateOperatorOrCustomCaller(ctx, "ask_agent");
  if (!gate.ok) return fail(gate.error, gate.message);
  if (gate.surface === "mcp" || gate.surface === "scheduled") {
    return unavailable("Asking and waiting only works inside a conversation.");
  }
  if (!ctx.run_id) return fail("ask_agent_no_run", "ask_agent requires an active run.");

  const sb = serviceClient();
  const { data: selfRow, error: selfErr } = await sb
    .from("agent_runs")
    .select("payload")
    .eq("id", ctx.run_id)
    .eq("tenant_id", ctx.tenant_id)
    .maybeSingle<{ payload: Record<string, unknown> | null }>();
  if (selfErr || !selfRow) return fail("ask_agent_no_run", "ask_agent requires an active run.");
  const selfPayload = (selfRow.payload ?? {}) as Record<string, unknown>;

  const refusal = askRefusalFor(selfPayload);
  if (refusal) {
    return fail(
      "ask_agent_depth",
      refusal === "depth"
        ? "You were asked a question by another agent; you cannot ask a third. Answer with what you have."
        : "You already have the answer from your last ask. Reply to the user with it.",
    );
  }

  let parsed: z.infer<typeof askAgentInput>;
  try {
    parsed = askAgentInput.parse(args);
  } catch (e) {
    return fail("input_invalid", (e as Error).message);
  }
  const target = parsed.target_agent_slug;

  if (target === "operator" || target === ctx.agent_slug) {
    return fail("ask_agent_self_loop", "You cannot ask yourself or the operator.");
  }
  const pinned = selfPayload.mention_target;
  if (typeof pinned === "string" && pinned && pinned !== target) {
    return fail(
      "ask_agent_target_invalid",
      `This turn addressed @${pinned} directly. Ask "${pinned}", not "${target}".`,
    );
  }
  if (isHeavyDispatch(target)) {
    return fail(
      "ask_agent_target_invalid",
      `@${target} does long builds. Use praxis__handoff for it; the result posts in this thread.`,
    );
  }
  const visible = await getVisibleAgentSlugs(ctx.tenant_id);
  const channels = channelAgentSlugs();
  const customTarget =
    isCustomAgentSlug(target) && (await isActiveCustomAgentOfTenant(ctx.tenant_id, target));
  if (!customTarget && !visible.has(target) && !channels.has(target)) {
    const specialists = Array.from(visible).filter((s) => s !== "operator").sort();
    return fail(
      "ask_agent_target_invalid",
      `Agent "${target}" is not a valid target. Specialists: ${specialists.join(", ")}.`,
    );
  }
  try {
    const tierDecision = await checkAgentTier(ctx.tenant_id, target, {
      engineerBackendRun: isEngineerBackendRun(target, {
        trigger: "a2a",
        enqueuedByUser: false,
        payload: pinned === target ? { [FOUNDER_DIRECT_AGENT_MENTION_KEY]: true } : {},
      }),
    });
    if (!tierDecision.allowed) return planUpgradeHandoffResult(target, tierDecision.required_tier, start);
  } catch {
  }

  const guard = await checkDelegationAllowed({
    tenant_id: ctx.tenant_id,
    parentLineage: readLineageContext(selfPayload),
    source_agent_slug: ctx.agent_slug ?? "operator",
    target_agent_slug: target,
  });
  if (!guard.ok) return delegationRefusedResult(guard, start);

  const parentUserText = extractUserMessageFromPayload(selfPayload).trim();
  const common: Record<string, unknown> = {
    intent: parsed.intent,
    ...(parentUserText ? { current_user_text_raw: parentUserText } : {}),
    user_id: ctx.user_id ?? null,
    source_agent_slug: ctx.agent_slug ?? "operator",
    ...(pinned === target ? { [FOUNDER_DIRECT_AGENT_MENTION_KEY]: true } : {}),
  };
  let childTrigger: "slack" | "email" | "handoff" | "teams" | "telegram" | "discord" | "whatsapp" | "imessage";
  let childPayload: Record<string, unknown>;
  if (gate.surface === "slack") {
    if (!ctx.slack_routing) return unavailable("This Slack turn has no reply routing.");
    const forwardOn = await isA2aAttachmentForwardingEnabled();
    const images = forwardOn ? extractParentSlackImageRefs(selfPayload) : [];
    childTrigger = "slack";
    childPayload = {
      ...common,
      slack: images.length > 0 ? { ...ctx.slack_routing, images } : ctx.slack_routing,
      source: "slack",
      slack_handoff_child: true,
    };
  } else if (gate.surface === "email") {
    if (!ctx.email_routing) return unavailable("This email turn has no reply routing.");
    childTrigger = "email";
    childPayload = { ...common, email: ctx.email_routing, source: "email", handoff_child: true };
  } else if (gate.surface === "chat") {
    if (!ctx.chat_thread_id) return unavailable("This chat turn has no thread.");
    childTrigger = "handoff";
    childPayload = { ...common, operator_thread_id: ctx.chat_thread_id };
  } else {
    const surface = gate.surface as keyof typeof ASK_SURFACE_ROUTING;
    const spec = ASK_SURFACE_ROUTING[surface];
    const routing = selfPayload[surface];
    const r = routing && typeof routing === "object" ? (routing as Record<string, unknown>) : null;
    if (!spec || !r || !spec.fields.every((f) => r[f])) return unavailable("This conversation has no reply routing.");
    childTrigger = surface;
    childPayload = { ...common, [surface]: r, source: surface, [spec.flag]: true };
  }
  if (ctx.actor) childPayload.inherited_actor = ctx.actor;
  if (!(await isA2aAttachmentForwardingEnabled())) {
    if (parentTurnHadAttachment(selfPayload, ctx.tenant_id) && typeof childPayload.intent === "string") {
      childPayload.intent = `${childPayload.intent}\n\n${FORWARDING_OFF_NOTE}`;
    }
  } else {
    let refs = extractParentAttachmentRefs(selfPayload, ctx.tenant_id);
    if (refs.length === 0) {
      const lookback = await lookbackThreadAttachmentsWithExpiry(
        serviceClient(),
        ctx.tenant_id,
        selfPayload,
      );
      refs = lookback.refs;
      if (refs.length === 0 && lookback.expiredUpload && typeof childPayload.intent === "string") {
        childPayload.intent = `${childPayload.intent}\n\n${EXPIRED_UPLOAD_NOTE}`;
      }
    }
    if (refs.length > 0) childPayload.attachment_paths = refs;
    const videos = extractParentVideoPaths(selfPayload, ctx.tenant_id);
    if (videos.length > 0) childPayload.video_paths = videos;
  }
  childPayload = buildChildLineagePayload(childPayload, {
    lineage_id: guard.lineage_id,
    childDepth: guard.childDepth,
  });

  const channelAdmission = await admitDirectChannelRun(ctx.tenant_id, target);
  if (!channelAdmission.allowed) {
    return fail(
      channelAdmission.reason === "coming_soon"
        ? "coming_soon"
        : channelAdmission.reason === "retired"
          ? "channel_retired"
          : channelAdmission.reason === "founder_stopped"
            ? "channel_stopped"
            : "channel_budget_exhausted",
      channelAdmission.message,
    );
  }
  if (channelAdmission.channel_slug) childPayload.channel_slug = channelAdmission.channel_slug;

  const deadline_at = new Date(Date.now() + ASK_WAIT_MS).toISOString();
  const { data: askRow, error: askErr } = await sb
    .from("agent_asks")
    .insert({
      tenant_id: ctx.tenant_id,
      parent_run_id: ctx.run_id,
      parent_agent_slug: ctx.agent_slug ?? "operator",
      target_agent_slug: target,
      tool_use_id: ctx.tool_use_id ?? null,
      surface: gate.surface,
      deadline_at,
    })
    .select("id")
    .single<{ id: string }>();
  let ask_id: string;
  if (askErr || !askRow) {
    if ((askErr as { code?: string } | null)?.code !== "23505") return unavailable("The ask could not be recorded.");
    const { data: prior } = await sb
      .from("agent_asks")
      .select("id, child_run_id, target_agent_slug")
      .eq("parent_run_id", ctx.run_id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle<{ id: string; child_run_id: string | null; target_agent_slug: string }>();
    if (prior?.id && !prior.child_run_id && prior.target_agent_slug === target) {
      ask_id = prior.id;
    } else {
      return {
        ok: true,
        is_error: false,
        content: JSON.stringify({
          ok: true,
          waiting: true,
          target: prior?.target_agent_slug ?? target,
          message: `You already asked @${prior?.target_agent_slug ?? target} this turn. END YOUR TURN NOW with one short line; the answer comes back as your next turn.`,
        }),
        ms: Date.now() - start,
      };
    }
  } else {
    ask_id = askRow.id;
  }
  childPayload.ask_id = ask_id;
  childPayload.ask_parent_run_id = ctx.run_id;
  childPayload.ask_depth = 1;
  stampFounderRef(childPayload, await founderRefForChild(ctx));

  let child_run_id: string;
  const askDedupeKey = `ask-child:${ctx.tenant_id}:${ask_id}`;
  try {
    const enqueued = await enqueueAgentRun({
      tenant_id: ctx.tenant_id,
      agent_slug: target,
      trigger: childTrigger,
      payload: childPayload,
      cron_dedupe_key: askDedupeKey,
      parent_run_id: ctx.run_id ?? undefined,
    });
    child_run_id = enqueued.run_id;
    if (!child_run_id) {
      const { data: existing } = await sb
        .from("agent_runs")
        .select("id")
        .eq("cron_dedupe_key", askDedupeKey)
        .eq("tenant_id", ctx.tenant_id)
        .maybeSingle<{ id: string }>();
      if (!existing?.id) throw new Error("the ask's child run could not be found");
      child_run_id = existing.id;
    }
  } catch (e) {
    await sb.from("agent_asks").delete().eq("id", ask_id).eq("tenant_id", ctx.tenant_id);
    if (e instanceof StaffModelCapError) return staffModelCapHandoffResult(start);
    const planRefusal = asPlanUpgradeRequired(e);
    if (planRefusal) return planUpgradeHandoffResult(target, planRefusal.required_tier, start);
    return fail("ask_agent_enqueue_failed", `@${target} could not be started: ${(e as Error).message}`);
  }

  await sb
    .from("agent_asks")
    .update({ child_run_id })
    .eq("id", ask_id)
    .eq("tenant_id", ctx.tenant_id)
    .is("child_run_id", null);
  await patchParentRunPayload(ctx.run_id, { ask_waiting_on: target });
  try {
    await inngest.send({ name: "agent.ask.deadline", id: `ask-deadline-${ask_id}`, data: { ask_id } });
  } catch (e) {
    console.warn(`[praxis__ask_agent] deadline event failed for ask ${ask_id}: ${(e as Error).message}`);
  }
  if (channelAdmission.channel_slug) {
    void stampDirectChannelRun(ctx.tenant_id, child_run_id, channelAdmission.channel_slug);
  }
  await recordDelegation({
    tenant_id: ctx.tenant_id,
    lineage_id: guard.lineage_id,
    depth: guard.childDepth,
    parent_run_id: ctx.run_id,
    child_run_id,
    source_agent_slug: ctx.agent_slug ?? "operator",
    target_agent_slug: target,
  });
  void logHandoffIntent({
    tenant_id: ctx.tenant_id,
    source_agent_slug: ctx.agent_slug ?? null,
    target_agent_slug: target,
    surface: gate.surface,
    authorized: true,
    run_id: ctx.run_id,
  });

  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      ok: true,
      waiting: true,
      run_id: child_run_id,
      target,
      message: `Asked @${target}. END YOUR TURN NOW: say in one short line that you are checking with @${target}, and call no more tools. Its answer comes back to you as your next turn; reply to the user with it then.`,
    }),
    ms: Date.now() - start,
  };
}

async function maybeFanOutEngineerHandoff(
  ctx: PraxisToolCtx,
  parsed: z.infer<typeof handoffInput>,
  start: number,
): Promise<McpCallResult | null> {
  const err = (error: string, message: string): McpCallResult => ({
    ok: false,
    is_error: true,
    content: JSON.stringify({ error, message }),
    ms: Date.now() - start,
  });

  if (!ctx.run_id) return null;

  let connectedRepos: string[];
  try {
    connectedRepos = await getScopedRepoFullNames(ctx.tenant_id);
  } catch (e) {
    console.warn(
      `[praxis__handoff] connected-repo read failed; falling back to single handoff: ${(e as Error).message}`,
    );
    return null;
  }
  if (connectedRepos.length <= 1) return null;

  try {
    const sb = serviceClient();
    const { data: existing } = await sb
      .from("handoff_batches")
      .select("batch_id, child_run_ids")
      .eq("tenant_id", ctx.tenant_id)
      .eq("parent_run_id", ctx.run_id)
      .eq("status", "pending")
      .maybeSingle();
    if (existing) {
      const run_ids = (existing.child_run_ids as string[]) ?? [];
      return {
        ok: true,
        is_error: false,
        content: JSON.stringify({
          ok: true,
          batch_id: existing.batch_id,
          run_ids,
          delegation_mode: parsed.context?.mode ?? "intent_only",
          idempotent_retry: true,
          message: `Already fanned out to ${run_ids.length} engineer run(s) this turn — I'll post the combined result back here when they finish.`,
        }),
        ms: Date.now() - start,
      };
    }
  } catch (e) {
    console.warn(
      `[praxis__handoff] same-run batch dedup read failed (parent_run_id=${ctx.run_id}); proceeding: ${(e as Error).message}`,
    );
  }

  const decomposition = await decomposeMessage(parsed.intent);
  if (decomposition.kind !== "multi") return null;

  const routed: HandoffBatchChildSpec[] = [];
  for (const task of decomposition.tasks) {
    let decision: Awaited<ReturnType<typeof pickRepoForTask>>;
    try {
      decision = await pickRepoForTask({
        task_description: `${task.title}\n${task.task_description}`,
        repos: connectedRepos,
        tenant_id: ctx.tenant_id,
      });
    } catch (e) {
      console.warn(
        `[praxis__handoff] repo pick threw for task "${task.title}"; aborting fan-out, using single handoff: ${(e as Error).message}`,
      );
      return null;
    }
    if (decision.decision !== "pick") {
      return null;
    }
    routed.push({
      target_agent_slug: "engineer",
      intent: `${task.title}\n\n${task.task_description}`,
      repo_hint: decision.repo,
    });
  }

  const distinctRepos = new Set(routed.map((r) => r.repo_hint));
  if (distinctRepos.size < 2) return null;

  const parentLineage = await readParentLineage(ctx.run_id);
  const fanGuard = await checkFanoutDelegationsAllowed(
    {
      tenant_id: ctx.tenant_id,
      parentLineage,
      source_agent_slug: ctx.agent_slug ?? "operator",
    },
    routed.map(() => "engineer"),
  );
  if (!fanGuard.ok) {
    return delegationRefusedResult(fanGuard, start);
  }

  const delegationContext = resolveDelegationContext(ctx, parsed.context);

  return dispatchHandoffBatch(ctx, routed, {
    lineage_id: fanGuard.lineage_id,
    childDepth: fanGuard.childDepth,
    delegationContext,
    delegation_mode: parsed.context?.mode ?? "intent_only",
    logLabel: "praxis__handoff(engineer-multirepo)",
    start,
    err,
  });
}

async function callPraxisHandoffParallel(
  ctx: PraxisToolCtx,
  args: unknown,
  start: number,
): Promise<McpCallResult> {
  const err = (error: string, message: string): McpCallResult => ({
    ok: false,
    is_error: true,
    content: JSON.stringify({ error, message }),
    ms: Date.now() - start,
  });

  const gate = gateOperatorCaller(ctx, "handoff");
  if (!gate.ok) {
    return err(gate.error, gate.message);
  }

  if (gate.surface !== "chat") {
    return err(
      "handoff_parallel_slack_unsupported",
      `Parallel fan-out isn't available from ${gate.surface} yet — use one praxis__handoff at a time (each result comes back individually).`,
    );
  }

  let parsed: z.infer<typeof handoffParallelInput>;
  try {
    parsed = handoffParallelInput.parse(args);
  } catch (e) {
    return err("input_invalid", (e as Error).message);
  }

  if (!ctx.run_id) {
    return err(
      "handoff_no_thread",
      "Parallel fan-out needs an operator run context — retry from a normal operator chat turn.",
    );
  }

  const pin = await readPinnedMentionTarget(ctx);
  if (pin.state === "unreadable") return pinUnreadableResult(start);
  if (pin.state === "pinned") {
    return err(
      "handoff_target_invalid",
      `This turn addressed @${pin.target} directly. Use praxis__handoff to "${pin.target}" alone.`,
    );
  }

  const visible = await getVisibleAgentSlugs(ctx.tenant_id);
  const channels = channelAgentSlugs();
  for (const t of parsed.targets) {
    if (t.target_agent_slug === "operator") {
      return err("handoff_self_loop", "Cannot hand off to operator from operator.");
    }
    if (!visible.has(t.target_agent_slug) && !channels.has(t.target_agent_slug)) {
      const specialists = Array.from(visible).filter((s) => s !== "operator").sort();
      const channelList = Array.from(channels).sort();
      return err(
        "handoff_target_invalid",
        `Agent "${t.target_agent_slug}" is not a valid handoff target. Specialists: ${specialists.join(", ")}. Channels: ${channelList.join(", ")}.`,
      );
    }
  }

  const parentLineage = await readParentLineage(ctx.run_id);
  const fanGuard = await checkFanoutDelegationsAllowed(
    {
      tenant_id: ctx.tenant_id,
      parentLineage,
      source_agent_slug: ctx.agent_slug ?? "operator",
    },
    parsed.targets.map((t) => t.target_agent_slug),
  );
  if (!fanGuard.ok) {
    return delegationRefusedResult(fanGuard, start);
  }

  const delegationContext = resolveDelegationContext(ctx, parsed.context);

  return dispatchHandoffBatch(
    ctx,
    parsed.targets.map((t) => ({
      target_agent_slug: t.target_agent_slug,
      intent: t.intent,
    })),
    {
      lineage_id: fanGuard.lineage_id,
      childDepth: fanGuard.childDepth,
      delegationContext,
      delegation_mode: parsed.context?.mode ?? "intent_only",
      logLabel: "praxis__handoff_parallel",
      start,
      err,
    },
  );
}

type HandoffBatchChildSpec = {
  target_agent_slug: string;
  intent: string;
  repo_hint?: string;
};

async function dispatchHandoffBatch(
  ctx: PraxisToolCtx,
  children: HandoffBatchChildSpec[],
  opts: {
    lineage_id: string;
    childDepth: number;
    delegationContext: ReturnType<typeof resolveDelegationContext>;
    delegation_mode: string;
    logLabel: string;
    start: number;
    err: (error: string, message: string) => McpCallResult;
  },
): Promise<McpCallResult> {
  const { lineage_id, childDepth, delegationContext, delegation_mode, logLabel, start, err } = opts;

  const batch_id = randomUUID();

  const run_ids: string[] = [];
  const forwardedAttachmentRefs = await resolveForwardedAttachmentRefs(ctx);
  const forwardedVideoPaths = await resolveForwardedVideoPaths(ctx);
  const failedChildren: string[] = [];
  const stoppedChildren: string[] = [];
  let acceptedCredits = 0;
  const planBlocked: string[] = [];
  let staffCapBlocked = false;
  const batchParentUserText = await resolveParentUserText(ctx);
  const batchFounderRef = await founderRefForChild(ctx);
  for (const t of children) {
    try {
      const basePayload: Record<string, unknown> = {
        operator_thread_id: ctx.chat_thread_id,
        intent: t.intent,
        user_id: ctx.user_id,
        handoff_batch_id: batch_id,
      };
      if (batchParentUserText) {
        basePayload.current_user_text_raw = batchParentUserText;
      }
      if (t.repo_hint) {
        basePayload.repo_hint = t.repo_hint;
      }
      if (forwardedAttachmentRefs.refs.length > 0) {
        basePayload.attachment_paths = forwardedAttachmentRefs.refs;
      } else if (forwardedAttachmentRefs.expiredUpload) {
        basePayload.intent = `${t.intent}\n\n${EXPIRED_UPLOAD_NOTE}`;
      } else if (forwardedAttachmentRefs.forwardingOff) {
        basePayload.intent = `${t.intent}\n\n${FORWARDING_OFF_NOTE}`;
      }
      if (forwardedVideoPaths.length > 0) {
        basePayload.video_paths = forwardedVideoPaths;
      }
      if (delegationContext) {
        basePayload.delegation_context = delegationContext;
      }
      if (await lockedChannelMessageForAgent(t.target_agent_slug)) {
        failedChildren.push(t.target_agent_slug);
        continue;
      }
      const admission = await admitDirectChannelRun(ctx.tenant_id, t.target_agent_slug, undefined, { accepted: acceptedCredits });
      if (!admission.allowed) {
        if (admission.reason === "founder_stopped") stoppedChildren.push(t.target_agent_slug);
        failedChildren.push(t.target_agent_slug);
        continue;
      }
      if (admission.channel_slug) basePayload.channel_slug = admission.channel_slug;
      acceptedCredits += admission.estimate;
      const { run_id } = await enqueueAgentRun({
        tenant_id: ctx.tenant_id,
        agent_slug: t.target_agent_slug,
        trigger: "handoff",
        payload: (() => {
          const p = buildChildLineagePayload(basePayload, { lineage_id, childDepth });
          stampFounderRef(p, batchFounderRef);
          return p;
        })(),
        parent_run_id: ctx.run_id ?? undefined,
      });
      run_ids.push(run_id);
      if (admission.channel_slug) void stampDirectChannelRun(ctx.tenant_id, run_id, admission.channel_slug);
      await recordDelegation({
        tenant_id: ctx.tenant_id,
        lineage_id,
        depth: childDepth,
        parent_run_id: ctx.run_id ?? null,
        child_run_id: run_id,
        source_agent_slug: ctx.agent_slug ?? "operator",
        target_agent_slug: t.target_agent_slug,
      });
    } catch (e) {
      if (e instanceof StaffModelCapError) staffCapBlocked = true;
      const planRefusal = asPlanUpgradeRequired(e);
      if (planRefusal) planBlocked.push(planRefusal.message);
      failedChildren.push(t.repo_hint ?? t.target_agent_slug);
      console.warn(
        `[${logLabel}] enqueue failed for ${t.target_agent_slug}` +
          (t.repo_hint ? ` (${t.repo_hint})` : "") +
          `: ${(e as Error).message}`,
      );
    }
  }

  if (run_ids.length === 0 && stoppedChildren.length > 0 && stoppedChildren.length === failedChildren.length) {
    return err(
      "channel_stopped",
      `The founder stopped ${stoppedChildren.join(", ")}, so Zavi does not run ${stoppedChildren.length === 1 ? "it" : "them"}. Answer the request yourself with the read tools you already have, and say in one line that the founder stopped this channel.`,
    );
  }
  if (run_ids.length === 0 && staffCapBlocked) {
    return err("staff_model_cap", STAFF_MODEL_CAP_MESSAGE);
  }
  if (run_ids.length === 0 && planBlocked.length > 0) {
    return err(
      "plan_upgrade_required",
      [...Array.from(new Set(planBlocked)), everyPlanSentence(), planWallInstruction()].filter(Boolean).join(" "),
    );
  }
  if (run_ids.length === 0) {
    return err(
      "handoff_parallel_all_failed",
      "No specialist runs could be enqueued. Check the targets and retry, or fall back to a single praxis__handoff.",
    );
  }

  const deadline_at = new Date(Date.now() + HANDOFF_PARALLEL_DEADLINE_MS).toISOString();
  const sb = serviceClient();
  const { error: insErr } = await sb.from("handoff_batches").insert({
    tenant_id: ctx.tenant_id,
    parent_run_id: ctx.run_id ?? null,
    batch_id,
    operator_thread_id: ctx.chat_thread_id,
    child_run_ids: run_ids,
    deadline_at,
    status: "pending",
  });
  if (insErr) {
    console.warn(
      `[${logLabel}] handoff_batches insert failed (batch=${batch_id}): ${insErr.message}`,
    );
    try {
      for (const rid of run_ids) {
        await patchRemoveHandoffBatchId(ctx.tenant_id, rid);
      }
    } catch (e) {
      console.warn(
        `[${logLabel}] failed to clear handoff_batch_id after ledger insert failure (batch=${batch_id}): ${(e as Error).message}`,
      );
    }
    return err(
      "handoff_batch_persist_failed",
      `Enqueued ${run_ids.length} runs but could not record the batch ledger; results will post back individually instead of combined. decision_id batch=${batch_id}.`,
    );
  }

  try {
    await inngest.send({
      name: "handoff.batch.join.requested",
      data: { batch_id, tenant_id: ctx.tenant_id },
    });
  } catch (e) {
    console.warn(
      `[${logLabel}] join event send failed (batch=${batch_id}); degrading to individual posts: ${(e as Error).message}`,
    );
    let weClaimed = false;
    try {
      const sb = serviceClient();
      const { data: claimedId } = await sb.rpc("claim_handoff_batch", {
        p_batch_id: batch_id,
        p_new_status: "timed_out",
      });
      weClaimed = !!claimedId;
    } catch (e2) {
      console.warn(
        `[${logLabel}] claim_handoff_batch failed after join-send failure (batch=${batch_id}); leaving children batch-flagged: ${(e2 as Error).message}`,
      );
    }
    if (weClaimed) {
      try {
        for (const rid of run_ids) {
          await patchRemoveHandoffBatchId(ctx.tenant_id, rid);
        }
      } catch (e2) {
        console.warn(
          `[${logLabel}] failed to clear handoff_batch_id after join-send failure (batch=${batch_id}): ${(e2 as Error).message}`,
        );
      }
    }
    return err(
      "handoff_batch_join_unfired",
      `Enqueued ${run_ids.length} run(s) but could not fire the combine step; their results will post back individually instead of combined. decision_id batch=${batch_id}.`,
    );
  }

  const partialNote =
    failedChildren.length > 0
      ? ` NOTE: ${failedChildren.length} target(s) could NOT be enqueued (${failedChildren.join(", ")}) — re-hand those off.`
      : "";

  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      ok: true,
      batch_id,
      run_ids,
      delegation_mode,
      ...(failedChildren.length > 0 ? { failed_targets: failedChildren } : {}),
      message: `Fanned out to ${run_ids.length} specialist(s). I'll post the combined result back here when they finish (or in ~60s).${partialNote}`,
    }),
    ms: Date.now() - start,
  };
}

async function patchRemoveHandoffBatchId(
  tenant_id: string,
  run_id: string,
): Promise<void> {
  const sb = serviceClient();
  const { data } = await sb
    .from("agent_runs")
    .select("payload")
    .eq("id", run_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  const payload = (data?.payload ?? {}) as Record<string, unknown>;
  if (!("handoff_batch_id" in payload)) return;
  const { handoff_batch_id: _drop, ...rest } = payload;
  await sb
    .from("agent_runs")
    .update({ payload: rest, updated_at: new Date().toISOString() })
    .eq("id", run_id)
    .eq("tenant_id", tenant_id);
}

async function callPraxisAction(
  ctx: PraxisToolCtx,
  args: unknown,
  start: number,
): Promise<McpCallResult> {
  const gate = await gateOperatorOrCustomCaller(ctx, "praxis_action");
  if (!gate.ok) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: gate.error, message: gate.message }),
      ms: Date.now() - start,
    };
  }

  if (typeof ctx.emit_decision !== "function") {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "praxis_action_not_authorized",
        message:
          "praxis__action is unavailable in this run context (no emit_decision wired).",
      }),
      ms: Date.now() - start,
    };
  }

  let parsed: z.infer<typeof actionInput>;
  try {
    parsed = actionInput.parse(args);
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "input_invalid",
        message: (e as Error).message,
      }),
      ms: Date.now() - start,
    };
  }

  const decisionClass = ACTION_VERB_TO_CLASS[parsed.verb];

  const { verb: _verb, ...body } = parsed;

  let decision_id: string;
  try {
    decision_id = await ctx.emit_decision(decisionClass, body, { selfDispatch: true });
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "decision_emit_failed",
        message: (e as Error).message,
      }),
      ms: Date.now() - start,
    };
  }

  const exec = await executeOperatorAction(decision_id);
  const didNotRun = exec.status === "rate_capped" || exec.not_started === true;
  if (isCustomAgentSlug(ctx.agent_slug) && didNotRun && ctx.run_id) {
    const { handCustomDecisionToHuman } = await import("@/services/agents/custom-agent-decisions");
    await handCustomDecisionToHuman(ctx.tenant_id, decision_id, ctx.run_id);
  }
  const message = buildActionMessage(parsed.verb, decision_id, exec);

  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      ok: true,
      decision_id,
      verb: parsed.verb,
      decision_class: decisionClass,
      status: exec.status,
      result: exec.result ?? null,
      already_claimed: exec.already_claimed ?? false,
      dispatch_error: exec.ok ? null : exec.error ?? "unknown",
      message,
    }),
    ms: Date.now() - start,
  };
}

async function callProposeDispatch(
  ctx: PraxisToolCtx,
  args: unknown,
  start: number,
): Promise<McpCallResult> {
  if (
    ctx.agent_slug !== "chief-of-staff" ||
    ctx.trigger !== "chat" ||
    !ctx.user_id ||
    !ctx.chat_thread_id
  ) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "propose_dispatch_not_authorized",
        message:
          "propose_dispatch is only available to chief-of-staff inside an authenticated chat turn.",
      }),
      ms: Date.now() - start,
    };
  }
  if (typeof ctx.emit_decision !== "function") {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "propose_dispatch_not_authorized",
        message: "propose_dispatch is unavailable in this run context (no emit_decision wired).",
      }),
      ms: Date.now() - start,
    };
  }

  let parsed: z.infer<typeof proposeDispatchInput>;
  try {
    parsed = proposeDispatchInput.parse(args);
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "input_invalid", message: (e as Error).message }),
      ms: Date.now() - start,
    };
  }

  const target = parsed.target_agent_slug.trim();
  if (target === "chief-of-staff" || target === "operator") {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "target_not_dispatchable",
        message: `'${target}' cannot be a dispatch target.`,
      }),
      ms: Date.now() - start,
    };
  }
  try {
    const visible = await getVisibleAgentSlugs(ctx.tenant_id);
    if (!visible.has(target)) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "target_not_visible",
          message: `'${target}' is not a visible agent for this tenant.`,
        }),
        ms: Date.now() - start,
      };
    }
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "visibility_lookup_failed", message: (e as Error).message }),
      ms: Date.now() - start,
    };
  }

  let decision_id: string;
  try {
    decision_id = await ctx.emit_decision("chief-of-staff.dispatch-specialist", {
      target_agent_slug: target,
      intent: parsed.intent,
    });
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "decision_emit_failed", message: (e as Error).message }),
      ms: Date.now() - start,
    };
  }

  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      ok: true,
      decision_id,
      target_agent_slug: target,
      decision_class: "chief-of-staff.dispatch-specialist",
      status: "pending_approval",
      message: `Queued for your approval — dispatch @${target} (decision \`${decision_id}\`). It runs once you Approve it here in this chat.`,
    }),
    ms: Date.now() - start,
  };
}

async function callProposeStandingOrder(
  ctx: PraxisToolCtx,
  args: unknown,
  start: number,
): Promise<McpCallResult> {
  const gate = gateOperatorCaller(ctx, "propose_standing_order");
  if (!gate.ok) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: gate.error, message: gate.message }),
      ms: Date.now() - start,
    };
  }
  if (typeof ctx.emit_decision !== "function") {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "propose_standing_order_not_authorized",
        message:
          "propose_standing_order is unavailable in this run context (no emit_decision wired).",
      }),
      ms: Date.now() - start,
    };
  }

  let parsed: z.infer<typeof proposeStandingOrderInput>;
  try {
    parsed = proposeStandingOrderInput.parse(args);
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "input_invalid", message: (e as Error).message }),
      ms: Date.now() - start,
    };
  }

  const cronErr = validateCronExpression(parsed.cron_expression.trim());
  if (cronErr) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "bad_cron", message: cronErr }),
      ms: Date.now() - start,
    };
  }
  const secret = findSecretLiteral(parsed.prompt);
  if (secret) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "prompt_contains_secret",
        message: `The standing-order prompt appears to contain a secret (${secret}). Scheduled prompts must never carry credentials — ask the user to rephrase without it.`,
      }),
      ms: Date.now() - start,
    };
  }

  let deliver: StandingOrder["deliver"];
  if (parsed.destination === "slack_channel") {
    if (!parsed.slack_channel_id) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "input_invalid",
          message: "slack_channel_id is required when destination=slack_channel.",
        }),
        ms: Date.now() - start,
      };
    }
    deliver = { kind: "slack_channel", channel_id: parsed.slack_channel_id };
  } else if (gate.surface === "chat" && ctx.chat_thread_id) {
    deliver = { kind: "chat_thread", thread_id: ctx.chat_thread_id };
  } else if (gate.surface === "slack" && ctx.slack_routing?.channel_id) {
    deliver = { kind: "slack_channel", channel_id: ctx.slack_routing.channel_id };
  } else {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "destination_unresolvable",
        message:
          "destination=this_thread has no resolvable thread on this surface — use destination=slack_channel with an explicit slack_channel_id.",
      }),
      ms: Date.now() - start,
    };
  }

  let replacesExisting = false;
  try {
    const existing = await getSchedule(ctx.tenant_id, "operator");
    replacesExisting = !!existing;
  } catch {
    replacesExisting = false;
  }

  let decision_id: string;
  try {
    decision_id = await ctx.emit_decision("operator.create-standing-order", {
      cron_expression: parsed.cron_expression.trim(),
      standing_order: { prompt: parsed.prompt, deliver },
    });
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "decision_emit_failed", message: (e as Error).message }),
      ms: Date.now() - start,
    };
  }

  const destLabel =
    deliver.kind === "chat_thread" ? "this thread" : `<#${deliver.channel_id}>`;
  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      ok: true,
      decision_id,
      decision_class: "operator.create-standing-order",
      status: "pending_approval",
      replaces_existing: replacesExisting,
      message:
        `Queued for your approval — standing order on \`${parsed.cron_expression.trim()}\`, posting to ${destLabel} (decision \`${decision_id}\`). It activates once you Approve it in Channels (/workspace?tab=channels).` +
        (replacesExisting
          ? " Note: this will replace your existing scheduled brief (one per workspace)."
          : ""),
    }),
    ms: Date.now() - start,
  };
}

async function callProposeResearchWatch(
  ctx: PraxisToolCtx,
  args: unknown,
  start: number,
): Promise<McpCallResult> {
  if (
    ctx.agent_slug !== "research" ||
    ctx.trigger !== "chat" ||
    !ctx.user_id ||
    !ctx.chat_thread_id
  ) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "propose_research_watch_not_authorized",
        message:
          "propose_research_watch is only available to the research agent inside a chat turn from an authenticated user.",
      }),
      ms: Date.now() - start,
    };
  }
  if (typeof ctx.emit_decision !== "function") {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "propose_research_watch_not_authorized",
        message:
          "propose_research_watch is unavailable in this run context (no emit_decision wired).",
      }),
      ms: Date.now() - start,
    };
  }

  let parsed: z.infer<typeof proposeResearchWatchInput>;
  try {
    parsed = proposeResearchWatchInput.parse(args);
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "input_invalid", message: (e as Error).message }),
      ms: Date.now() - start,
    };
  }

  const cronErr = validateCronExpression(parsed.cron_expression.trim());
  if (cronErr) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "bad_cron", message: cronErr }),
      ms: Date.now() - start,
    };
  }
  const secret = findSecretLiteral(parsed.prompt);
  if (secret) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "prompt_contains_secret",
        message: `The watch prompt appears to contain a secret (${secret}). Scheduled prompts must never carry credentials — ask the user to rephrase without it.`,
      }),
      ms: Date.now() - start,
    };
  }

  let deliver: StandingOrder["deliver"];
  if (parsed.destination === "slack_channel") {
    if (!parsed.slack_channel_id) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "input_invalid",
          message: "slack_channel_id is required when destination=slack_channel.",
        }),
        ms: Date.now() - start,
      };
    }
    deliver = { kind: "slack_channel", channel_id: parsed.slack_channel_id };
  } else {
    deliver = { kind: "chat_thread", thread_id: ctx.chat_thread_id };
  }

  let replacesExisting = false;
  try {
    const existing = await getSchedule(ctx.tenant_id, "research");
    replacesExisting = !!existing;
  } catch {
    replacesExisting = false;
  }

  let decision_id: string;
  try {
    decision_id = await ctx.emit_decision("research.create-watch", {
      cron_expression: parsed.cron_expression.trim(),
      standing_order: { prompt: parsed.prompt, deliver },
    });
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "decision_emit_failed", message: (e as Error).message }),
      ms: Date.now() - start,
    };
  }

  const destLabel =
    deliver.kind === "chat_thread" ? "this thread" : `<#${deliver.channel_id}>`;
  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      ok: true,
      decision_id,
      decision_class: "research.create-watch",
      status: "pending_approval",
      replaces_existing: replacesExisting,
      message:
        `Queued for your approval — research watch on \`${parsed.cron_expression.trim()}\`, posting change-briefs to ${destLabel} (decision \`${decision_id}\`). It activates once you Approve it in Channels (/workspace?tab=channels).` +
        (replacesExisting
          ? " Note: this will replace your existing research watch (one per workspace)."
          : ""),
    }),
    ms: Date.now() - start,
  };
}

function buildActionMessage(
  verb: "file-jira-issue" | "file-linear-issue" | "post-slack-message",
  decision_id: string,
  exec: {
    ok: boolean;
    status:
      | "executed"
      | "race_lost"
      | "pending_approval"
      | "rate_capped"
      | "rejected"
      | "failed";
    error?: string;
    result?: { external_key?: string; channel?: string; ts?: string; url?: string };
  },
): string {
  if (exec.status === "executed" && exec.result) {
    const r = exec.result;
    if ((verb === "file-jira-issue" || verb === "file-linear-issue") && r.external_key) {
      return r.url
        ? `Filed ✓ — [${r.external_key}](${r.url}).`
        : `Filed ✓ — **${r.external_key}**.`;
    }
    if (verb === "post-slack-message" && r.channel) {
      const tsPart = r.ts ? ` (ts=${r.ts})` : "";
      return `Posted ✓ to <#${r.channel}>${tsPart}.`;
    }
  }
  if (exec.status === "pending_approval") {
    return `Queued for your approval — decision_id \`${decision_id}\`. The key will backstamp here once you approve it here in this chat.`;
  }
  if (exec.status === "rate_capped") {
    return `Queued for your approval — this class hit its hourly auto-fire rate cap, so it was NOT auto-executed. decision_id \`${decision_id}\`. Approve it manually here in this chat.`;
  }
  if (exec.status === "race_lost") {
    return `${verb} already dispatched by another worker — decision_id \`${decision_id}\`. The key will appear here once dispatch completes.`;
  }
  if (exec.status === "rejected") {
    return `${verb} rejected by policy (kill_switch or forbidden autonomy) — decision_id \`${decision_id}\`. Action did NOT execute.`;
  }
  return `${verb} dispatch failed: ${exec.error ?? "unknown"} — decision_id \`${decision_id}\`. Will retry via auto-cron.`;
}

async function resolveReminderTz(
  tenant_id: string,
  explicit?: string,
  slack_user_id?: string,
  slack_team_id?: string,
): Promise<string> {
  if (explicit && isValidTz(explicit)) return explicit;

  if (slack_user_id) {
    try {
      const info = await slackFetch<{ user?: { tz?: string } }>(
        tenant_id,
        "users.info",
        { user: slack_user_id },
        slack_team_id,
      );
      const utz = info?.user?.tz;
      if (utz && isValidTz(utz)) return utz;
    } catch (e) {
      console.warn(`[praxis__remind] slack tz lookup failed, falling back to workspace zone: ${(e as Error).message}`);
    }
  }

  const { data, error } = await serviceClient()
    .from("tenants")
    .select("timezone")
    .eq("id", tenant_id)
    .maybeSingle<{ timezone: string | null }>();
  if (error) {
    console.warn(`[praxis__remind] tenant timezone read failed, falling back to UTC: ${error.message}`);
  }
  const tz = data?.timezone;
  return tz && isValidTz(tz) ? tz : "UTC";
}

async function callRemind(
  ctx: PraxisToolCtx,
  args: unknown,
  start: number,
): Promise<McpCallResult> {
  let parsed: z.infer<typeof remindInput>;
  try {
    parsed = remindInput.parse(args);
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "input_invalid", message: (e as Error).message }),
      ms: Date.now() - start,
    };
  }

  let chatRouting: ReminderChatRouting | undefined;
  if (ctx.trigger === "whatsapp") {
    const r = await readParentSurfaceRouting(ctx, "whatsapp", ["wa_id", "phone_number_id"]);
    if (r) {
      chatRouting = {
        kind: "whatsapp",
        wa_id: String(r.wa_id),
        phone_number_id: String(r.phone_number_id),
      };
    }
  } else if (ctx.trigger === "imessage") {
    const r = await readParentSurfaceRouting(ctx, "imessage", ["line", "handle"]);
    if (r) chatRouting = { kind: "imessage", line: String(r.line), handle: String(r.handle) };
  } else if (ctx.trigger === "telegram") {
    const r = await readParentSurfaceRouting(ctx, "telegram", ["chat_id"]);
    if (r) chatRouting = { kind: "telegram", chat_id: Number(r.chat_id) || String(r.chat_id) };
  } else if (ctx.trigger === "discord") {
    const r = await readParentSurfaceRouting(ctx, "discord", ["channel_id", "guild_id"]);
    if (r) {
      chatRouting = {
        kind: "discord",
        channel_id: String(r.channel_id),
        guild_id: String(r.guild_id),
      };
    }
  }

  const deliver = deriveDeliverTarget({
    chat_thread_id: ctx.chat_thread_id,
    slack_routing: ctx.slack_routing,
    slack_user_id: ctx.actor?.slack_user_id,
    chat_routing: chatRouting,
  });
  if (!deliver) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "remind_no_surface",
        message:
          "remind is only available on a live conversation (web chat, Slack, WhatsApp, iMessage, Telegram or Discord) — there is no surface to deliver back to on this run.",
      }),
      ms: Date.now() - start,
    };
  }

  const requesterSlackId = ctx.actor?.slack_user_id;
  const requesterTeamId = ctx.slack_routing?.team_id ?? ctx.actor?.slack_team_id;
  const tz = await resolveReminderTz(
    ctx.tenant_id,
    parsed.tz,
    requesterSlackId,
    requesterTeamId,
  );
  const when = resolveWhen(parsed.when, tz);
  if (!when.ok) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "bad_when", message: when.error }),
      ms: Date.now() - start,
    };
  }

  const { schedule_kind, due_at, cron_expression } = when.resolved;

  if (schedule_kind === "recurring" && parsed.mode === "run") {
    const below = await tenantBelowStarter(ctx.tenant_id);
    if (below === null) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({ error: "plan_check_unavailable", message: "Could not read this workspace's plan." }),
        ms: Date.now() - start,
      };
    }
    if (below) {
      const refusal = refusalFor({ kind: "custom_agents_plan" });
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: refusal.code,
          message: refusal.message,
          required_tier: "starter",
          note: "Tell the user this in one line, exactly as written. A one-off reminder or a ping is still available.",
        }),
        ms: Date.now() - start,
      };
    }
  }

  const { data, error } = await serviceClient().rpc("create_agent_reminder", {
    p_tenant_id: ctx.tenant_id,
    p_agent_slug: ctx.agent_slug ?? "operator",
    p_mode: parsed.mode,
    p_note: parsed.note,
    p_schedule_kind: schedule_kind,
    p_due_at: due_at.toISOString(),
    p_cron_expression: cron_expression,
    p_tz: tz,
    p_deliver: deliver,
    p_created_by: ctx.user_id ?? ctx.actor?.actor_user_id ?? null,
    p_slack_user_id: requesterSlackId ?? null,
  });

  if (error) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "remind_failed", message: error.message }),
      ms: Date.now() - start,
    };
  }

  try {
    const { scheduleReminder } = await import("../../../../workers/functions/reminder-fire");
    await scheduleReminder(String(data), due_at.toISOString());
  } catch (e) {
    console.warn(`[praxis__remind] sleeper arm failed (sweep will catch it): ${(e as Error).message}`);
  }

  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      reminder_id: data,
      mode: parsed.mode,
      schedule: schedule_kind,
      fires_at_local: formatLocal(due_at, tz),
      timezone: tz,
      recurring: schedule_kind === "recurring",
      delivers_to: deliver.kind === "slack_dm" ? "slack_dm" : deliver.kind,
      note:
        deliver.kind === "slack_dm"
          ? "Tell the user the exact fires_at_local time back so a wrong timezone is caught immediately, and that it will arrive as a DM."
          : "Tell the user the exact fires_at_local time back so a wrong timezone is caught immediately.",
    }),
    ms: Date.now() - start,
  };
}

async function callListReminders(ctx: PraxisToolCtx, start: number): Promise<McpCallResult> {
  const { data, error } = await serviceClient()
    .from("agent_reminders")
    .select("id, mode, note, schedule_kind, due_at, cron_expression, tz, agent_slug")
    .eq("tenant_id", ctx.tenant_id)
    .eq("status", "pending")
    .order("due_at", { ascending: true })
    .limit(50);

  if (error) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "list_failed", message: error.message }),
      ms: Date.now() - start,
    };
  }

  const reminders = (data ?? []).map((r) => ({
    reminder_id: r.id,
    what: r.note,
    mode: r.mode,
    fires_at_local: formatLocal(new Date(r.due_at as string), (r.tz as string) || "UTC"),
    recurring: r.schedule_kind === "recurring",
  }));

  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({ count: reminders.length, reminders }),
    ms: Date.now() - start,
  };
}

function sitePublishReads(sb: ReturnType<typeof serviceClient>): SitePublishReads {
  return {
    publishRuns: async (tenant_id, ids) => {
      const { data, error } = await sb
        .from("conductor_runs")
        .select("id, status, created_at, failure_class, failure_reason")
        .eq("tenant_id", tenant_id)
        .in("id", ids);
      if (error) throw new Error(`publish runs: ${error.message}`);
      return (data ?? []) as SitePublishRunRow[];
    },
    previews: async (tenant_id, repos) => {
      const { data, error } = await sb
        .from("tenant_sandbox")
        .select("repo_full_name, preview_url, preview_status")
        .eq("tenant_id", tenant_id)
        .in("repo_full_name", repos);
      if (error) throw new Error(`site previews: ${error.message}`);
      return (data ?? []) as SitePreviewRow[];
    },
    probe: async (url) => (await import("@/routes/workspace/autopilot")).probeSandboxPreviewCached(url),
  };
}

async function callListProductBuilds(
  ctx: PraxisToolCtx,
  start: number,
): Promise<McpCallResult> {
  const sb = serviceClient();
  const DETAIL_LIMIT = 20;

  const [detailRes, oldFreshRes, freshRes, totalRes, hostingRes, dbRes] = await Promise.all([
    sb
      .from("conductor_runs")
      .select("id, objective, status, goal_graph, created_at, updated_at")
      .eq("tenant_id", ctx.tenant_id)
      .eq("kind", "build_app")
      .order("created_at", { ascending: false })
      .limit(DETAIL_LIMIT),
    sb
      .from("conductor_runs")
      .select("id, objective, status, goal_graph, created_at, updated_at")
      .eq("tenant_id", ctx.tenant_id)
      .eq("kind", "build_app")
      .or(NON_REFINE_BUILD_FILTER)
      .is("goal_graph->0->payload->>site_id", null)
      .is("goal_graph->1->payload->>site_id", null)
      .is("goal_graph->2->payload->>site_id", null)
      .order("created_at", { ascending: false })
      .limit(1),
    sb
      .from("conductor_runs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenant_id)
      .eq("kind", "build_app")
      .or(NON_REFINE_BUILD_FILTER),
    sb
      .from("conductor_runs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenant_id)
      .eq("kind", "build_app"),
    sb
      .from("tenant_resources")
      .select("status, external_ref")
      .eq("tenant_id", ctx.tenant_id)
      .eq("resource_kind", "hosting")
      .eq("mode", "provisioned")
      .order("updated_at", { ascending: false })
      .limit(1),
    sb
      .from("tenant_resources")
      .select("resource_kind, status, updated_at")
      .eq("tenant_id", ctx.tenant_id)
      .eq("resource_kind", "db"),
  ]);

  const failed = (message: string): McpCallResult => ({
    ok: false,
    is_error: true,
    content: JSON.stringify({ error: "list_product_builds_failed", message }),
    ms: Date.now() - start,
  });
  const err = detailRes.error ?? oldFreshRes.error ?? freshRes.error ?? totalRes.error ?? dbRes.error;
  if (err) return failed(err.message);

  let sites: SiteRow[];
  let sitesChecked = true;
  try {
    sites = ((await realRefineProductDeps.listSites?.(ctx.tenant_id)) ?? []).filter(isVisibleSite);
  } catch (e) {
    const anySiteRun = ((detailRes.data ?? []) as Array<{ goal_graph?: unknown }>).some(
      (r) => siteIdFromGraph(r.goal_graph) !== null,
    );
    if (anySiteRun) return failed(`sites read failed: ${(e as Error).message}`);
    sites = [];
    sitesChecked = false;
  }

  type Node = { status?: string; payload?: { stage?: string; refine_mode?: boolean } };
  type RunRow = Record<string, unknown> & { goal_graph?: unknown; created_at?: string | null; status?: string | null };
  const rows = (detailRes.data ?? []) as RunRow[];
  const oldFresh =
    ((oldFreshRes.data ?? []) as RunRow[]).find((r) => !isRefineRun(r) && siteIdFromGraph(r.goal_graph) === null) ??
    null;

  const retired = oldFresh !== null && buildDatabaseReclaimed(dbRes.data, oldFresh);
  const oldLive = oldFresh !== null && !retired && tenantAppIsLive([oldFresh]);
  const hostingRow = (
    (hostingRes.error ? null : hostingRes.data) as Array<{
      status?: string | null;
      external_ref?: Record<string, unknown> | null;
    }> | null
  )?.[0];
  const hostingUrl =
    typeof hostingRow?.external_ref?.url === "string" ? hostingRow.external_ref.url : null;
  const oldLiveUrl = oldLive && hostingRow?.status === "ready" && hostingUrl ? hostingUrl : null;

  const publishStates: Map<string, SitePublishState> | null = await sitePublishStates(
    ctx.tenant_id,
    sites,
    sitePublishReads(sb),
  ).catch((e: unknown) => {
    console.warn(`[praxis__list_product_builds] publish state unread for ${ctx.tenant_id}: ${(e as Error).message ?? e}`);
    return null;
  });

  const siteApps = sites.map((site) => {
    const url = siteLiveUrl(site);
    const publish = publishStates?.get(site.id);
    return {
      kind: "site" as const,
      site_id: site.id,
      hostname: site.hostname,
      status: site.status,
      root_build_id: site.root_conductor_run_id,
      currently_live: url !== null,
      live_url: url,
      created_at: site.created_at,
      ...(publish ? { publish } : publishStates === null && sitePublishNeedsState(site) ? { publish_checked: false } : {}),
    };
  });
  const siteById = new Map(siteApps.map((a) => [a.site_id, a]));

  const appKey = (r: RunRow) => siteIdFromGraph(r.goal_graph) ?? "";
  const latestFreshOf = new Map<string, unknown>();
  for (const r of rows) {
    if (!isRefineRun(r) && !latestFreshOf.has(appKey(r))) latestFreshOf.set(appKey(r), r.id);
  }
  if (oldFresh) latestFreshOf.set("", oldFresh.id);

  const product_builds = freshRes.count ?? 0;
  const total_runs = totalRes.count ?? 0;
  const refines = Math.max(0, total_runs - product_builds);

  const builds = rows.map((r) => {
    const graph = ((r.goal_graph as Node[] | null) ?? []);
    const is_refine = isRefineRun(r);
    const site_id = siteIdFromGraph(r.goal_graph);
    const latest = latestFreshOf.get(site_id ?? "");
    return {
      build_id: r.id,
      objective: r.objective,
      status: r.status,
      is_refine,
      site_id,
      site_hostname: site_id ? siteById.get(site_id)?.hostname ?? null : null,
      superseded: !is_refine && latest !== undefined && r.id !== latest,
      decides_liveness: !is_refine && site_id === null && latest !== undefined && r.id === latest,
      stages: graph.map((n) => ({ stage: n.payload?.stage ?? "?", status: n.status ?? "?" })),
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });

  const old_live_reason =
    oldFresh === null
      ? null
      : retired
        ? "This build was retired: its database was shut down when the builder was " +
          "upgraded, so the app is offline. The founder needs to start a new build."
        : oldLive
          ? "The latest fresh build finished, so the repo serves the real app."
          : "The latest fresh build is '" +
            String(oldFresh.status) +
            "', and a fresh build re-seeds the placeholder at enqueue — so the " +
            "repo is serving the starter placeholder, not the built app.";

  const apps = [
    ...(oldFresh
      ? [
          {
            kind: "workspace_app" as const,
            site_id: null,
            root_build_id: oldFresh.id,
            currently_live: oldLive,
            live_url: oldLiveUrl,
            live_reason: old_live_reason,
          },
        ]
      : []),
    ...siteApps,
  ];
  const liveCount = siteApps.filter((a) => a.currently_live).length + (oldLive ? 1 : 0);
  const currently_live = liveCount > 0;
  const live_url = oldLive ? oldLiveUrl : siteApps.find((a) => a.currently_live)?.live_url ?? null;

  const live_reason =
    product_builds === 0
      ? "This workspace has never started a product build."
      : apps.length === 1 && old_live_reason
        ? old_live_reason
        : apps.length === 0
          ? "No app could be matched to these builds, so liveness could not be decided."
          : currently_live
            ? `${liveCount} of ${apps.length} apps in this workspace are live; ` +
              "each app's own verdict is in `apps`."
            : `None of the ${apps.length} apps in this workspace is live right now; ` +
              "each app's own verdict is in `apps`.";

  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      product_builds,
      refines,
      currently_live,
      live_reason,
      live_url,
      apps,
      custom_domains: customDomainsFor({ workspace_app: oldFresh !== null, site: siteApps.length > 0 }),
      ...(sitesChecked
        ? {}
        : { sites_checked: false, sites_note: "Sites could not be read this call; only the original app was checked." }),
      live_check: "derived from build state; the live URL was not probed this call",
      ...(product_builds === 0
        ? {
            note:
              "This workspace has never started a product build. Agent runs are a " +
              "DIFFERENT object and are not builds — do not report a count of agent " +
              "runs as an answer about builds.",
          }
        : {}),
      builds_returned: builds.length,
      builds_truncated: total_runs > builds.length,
      builds,
    }),
    ms: Date.now() - start,
  };
}

async function callEnableDatabase(
  ctx: PraxisToolCtx,
  args: unknown,
  start: number,
): Promise<McpCallResult> {
  try {
    enableDatabaseInput.parse(args ?? {});
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "input_invalid", message: (e as Error).message }),
      ms: Date.now() - start,
    };
  }

  const { data, error } = await serviceClient().rpc("request_app_database", {
    p_tenant_id: ctx.tenant_id,
  });

  if (error) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "enable_database_failed", message: error.message }),
      ms: Date.now() - start,
    };
  }

  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      recorded: true,
      status: typeof data === "string" ? data : null,
      message:
        "Database requested. It is created and DATABASE_URL + SESSION_SECRET are set on the host before your code is published. Use process.env.DATABASE_URL in server code only.",
    }),
    ms: Date.now() - start,
  };
}

async function callCancelReminder(
  ctx: PraxisToolCtx,
  args: unknown,
  start: number,
): Promise<McpCallResult> {
  let parsed: z.infer<typeof cancelReminderInput>;
  try {
    parsed = cancelReminderInput.parse(args);
  } catch (e) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "input_invalid", message: (e as Error).message }),
      ms: Date.now() - start,
    };
  }

  const { data, error } = await serviceClient().rpc("cancel_agent_reminder", {
    p_tenant_id: ctx.tenant_id,
    p_reminder_id: parsed.reminder_id,
  });

  if (error) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "cancel_failed", message: error.message }),
      ms: Date.now() - start,
    };
  }

  return {
    ok: true,
    is_error: false,
    content: JSON.stringify({
      cancelled: data === true,
      message:
        data === true
          ? "Reminder cancelled."
          : "No pending reminder with that id in this workspace (already fired, already cancelled, or not yours).",
    }),
    ms: Date.now() - start,
  };
}

async function tenantBelowStarter(tenant_id: string): Promise<boolean | null> {
  try {
    const tier = await resolveTenantTier(tenant_id, await loadTierGateConfig());
    return tierRank(tier) < tierRank("starter");
  } catch {
    return null;
  }
}

async function callProposeCustomAgent(
  ctx: PraxisToolCtx,
  args: unknown,
  start: number,
): Promise<McpCallResult> {
  const fail = (error: string, message: string, extra: Record<string, unknown> = {}): McpCallResult => ({
    ok: false,
    is_error: true,
    content: JSON.stringify({ error, message, ...extra }),
    ms: Date.now() - start,
  });

  const gate = gateOperatorCaller(ctx, "propose_custom_agent", "research");
  if (!gate.ok) return fail(gate.error, gate.message);

  let parsed: z.infer<typeof proposeCustomAgentInput>;
  try {
    parsed = proposeCustomAgentInput.parse(args);
  } catch (e) {
    const message = e instanceof z.ZodError
      ? e.issues
          .map((i) => (i.path.length && !i.message.startsWith("Unknown timezone") ? `${i.path.join(".")}: ${i.message}` : i.message))
          .join("; ")
      : (e as Error).message;
    return fail("input_invalid", message);
  }

  const below = await tenantBelowStarter(ctx.tenant_id);
  if (below === null) return fail("plan_check_unavailable", "Could not read this workspace's plan.");
  if (below) {
    const refusal = refusalFor({ kind: "custom_agents_plan" });
    if (ctx.run_id) {
      recordCustomAgentCard(ctx.run_id, {
        kind: "refusal",
        refusal: { code: "plan_upgrade_required", message: refusal.message, action: "upgrade", required_tier: "starter" },
      });
    }
    return fail(refusal.code, refusal.message, {
      required_tier: "starter",
      note: "Tell the user this in one line, exactly as written. Do not draft the agent.",
    });
  }

  let waRouting: { wa_id: string; phone_number_id: string } | null = null;
  if (ctx.trigger === "whatsapp") {
    const r = await readParentSurfaceRouting(ctx, "whatsapp", ["wa_id", "phone_number_id"]);
    if (r) waRouting = { wa_id: String(r.wa_id), phone_number_id: String(r.phone_number_id) };
    const owner = waRouting
      ? await whatsappOwnerUserId(ctx.tenant_id, waRouting.phone_number_id, waRouting.wa_id)
      : null;
    if (!owner) {
      return fail("not_owner", WHATSAPP_NOT_OWNER_REPLY, {
        note: "Tell the user this in one line, exactly as written. Do not draft the agent.",
      });
    }
  }

  const { listGlobalAgentSlugs } = await import("@/services/agents/registry");
  const reserved = customAgentReservedNames(listGlobalAgentSlugs());
  if (isReservedCustomAgentName(parsed.name, reserved)) {
    return fail("name_reserved", `"${parsed.name}" is the name of a built-in agent. Pick a different name and call again.`);
  }
  let live: Array<{ id: string; name: string }> = [];
  let liveRead = false;
  try {
    const { data, error } = await tenantClient(asTenantId(ctx.tenant_id))
      .from("custom_agents")
      .select("id, name")
      .neq("status", "archived");
    if (!error) {
      live = (data ?? []) as Array<{ id: string; name: string }>;
      liveRead = true;
    }
  } catch {
  }
  let editTarget: { id: string; name: string } | null = null;
  if (parsed.agent !== undefined) {
    const want = customAgentNameNorm(parsed.agent);
    editTarget = live.find((r) => customAgentNameNorm(r.name) === want) ?? null;
    if (!editTarget) {
      return fail(
        liveRead ? "agent_not_found" : "agent_lookup_unavailable",
        liveRead
          ? `This workspace has no custom agent called "${parsed.agent}". Check the name and call again.`
          : "Could not read this workspace's agents. Try again.",
      );
    }
  }
  const norm = customAgentNameNorm(parsed.name);
  if (live.some((r) => r.id !== editTarget?.id && customAgentNameNorm(r.name) === norm)) {
    return fail("name_taken", `This workspace already has an agent called "${parsed.name}". Pick a different name and call again.`);
  }
  const secret = instructionsRejection(parsed.instructions);
  if (secret) return fail("instructions_invalid", secret);

  const tz = await resolveReminderTz(
    ctx.tenant_id,
    undefined,
    ctx.actor?.slack_user_id,
    ctx.slack_routing?.team_id ?? ctx.actor?.slack_team_id,
  );
  const triggers: CustomTrigger[] = (parsed.triggers ?? []).map((t) =>
    t.kind === "schedule" ? { ...t, tz: t.tz ?? tz } : t,
  );
  const resolved = resolveCustomTriggers(triggers, tz);
  if (!resolved.ok) return fail("bad_trigger", resolved.error);
  const unobservable = await watchRefusal(ctx.tenant_id, triggers, {
    instructions: parsed.instructions,
    tools: parsed.tools ?? [],
  });
  if (unobservable) {
    if (ctx.run_id) {
      recordCustomAgentCard(ctx.run_id, { kind: "refusal", refusal: { code: "watch_unobservable", message: unobservable } });
    }
    return fail("watch_unobservable", unobservable, {
      note: "Tell the user this in one line, exactly as written. Do not draft the agent.",
    });
  }

  let deliver: CustomDeliver | null = null;
  if (ctx.trigger === "email") {
    deliver = { kind: "email" };
  } else {
    let chatRouting: ReminderChatRouting | undefined;
    if (ctx.trigger === "whatsapp") {
      chatRouting = waRouting
        ? { kind: "whatsapp", wa_id: waRouting.wa_id, phone_number_id: waRouting.phone_number_id }
        : undefined;
    } else if (ctx.trigger === "telegram") {
      const r = await readParentSurfaceRouting(ctx, "telegram", ["chat_id"]);
      if (r) chatRouting = { kind: "telegram", chat_id: Number(r.chat_id) || String(r.chat_id) };
    } else if (ctx.trigger === "discord") {
      const r = await readParentSurfaceRouting(ctx, "discord", ["channel_id", "guild_id"]);
      if (r) chatRouting = { kind: "discord", channel_id: String(r.channel_id), guild_id: String(r.guild_id) };
    }
    const d = deriveDeliverTarget({
      chat_thread_id: ctx.chat_thread_id,
      slack_routing: ctx.slack_routing,
      slack_user_id: ctx.actor?.slack_user_id,
      chat_routing: chatRouting,
    });
    const ok = d ? customDeliverSchema.safeParse(d) : null;
    deliver = ok?.success ? ok.data : null;
  }

  let draft: CustomAgentDraft;
  try {
    draft = customAgentDraftSchema.parse({
      name: parsed.name.trim(),
      role: parsed.role ?? "",
      instructions: parsed.instructions,
      tools: parsed.tools ?? [],
      triggers,
      deliver,
    });
  } catch (e) {
    return fail("draft_invalid", (e as Error).message);
  }
  const action: ConfirmAction = editTarget ? "update" : "create";
  const ok = (note: string): McpCallResult => ({
    ok: true,
    is_error: false,
    content: JSON.stringify({ draft, created: false, ...(editTarget ? { editing: editTarget.name } : {}), note }),
    ms: Date.now() - start,
  });

  if (ctx.trigger === "chat" && !!ctx.chat_thread_id) {
    if (editTarget) {
      return ok(
        `To change "${editTarget.name}" from the web, open its Agent Builder page: ${customAgentPageUrl(editTarget.id)} . Tell the user that in one line.`,
      );
    }
    if (ctx.run_id) recordCustomAgentCard(ctx.run_id, { kind: "draft", draft });
    return ok(
      "A card with Create, Test run and Edit is shown under your reply. Nothing exists until the user clicks Create. Say in one or two lines what the agent will do and when; do not repeat the card.",
    );
  }

  const confirmNote = (where: string) =>
    `${where} Nothing ${action === "create" ? "is created" : "changes"} until the user confirms; it works once and expires in 30 minutes. Say in one or two lines what the agent will do and when; do not repeat the card.`;

  if (ctx.trigger === "slack" && ctx.slack_routing?.channel_id && ctx.run_id) {
    let team_id = ctx.slack_routing.team_id ?? "";
    let slack_user = ctx.actor?.slack_user_id ?? "";
    try {
      const { data } = await tenantClient(asTenantId(ctx.tenant_id))
        .from("agent_runs")
        .select("payload")
        .eq("id", ctx.run_id)
        .maybeSingle<{ payload: { slack?: { team_id?: unknown; user?: unknown } } | null }>();
      const sl = data?.payload?.slack;
      if (typeof sl?.team_id === "string" && sl.team_id) team_id = sl.team_id;
      if (typeof sl?.user === "string" && sl.user) slack_user = sl.user;
    } catch {
    }
    if (!team_id || !slack_user) {
      return fail("confirm_unavailable", "Could not tell who asked in Slack, so no Confirm button can be issued. Ask the user to create it from Zavi on the web.");
    }
    try {
      const issued = await issueCustomAgentConfirm({
        tenant_id: ctx.tenant_id,
        surface: "slack",
        external_user_id: slack_user,
        slack_team_id: team_id,
        action,
        agent_id: editTarget?.id ?? null,
        draft,
        origin: {
          channel_id: ctx.slack_routing.channel_id,
          thread_ts: ctx.slack_routing.thread_ts,
          original_ts: ctx.slack_routing.original_ts,
          event_id: ctx.slack_routing.event_id,
        },
        origin_run_id: ctx.run_id,
      });
      await slackFetch(
        ctx.tenant_id,
        "chat.postMessage",
        {
          channel: ctx.slack_routing.channel_id,
          thread_ts: ctx.slack_routing.thread_ts || undefined,
          text: draftSummaryText(draft, action),
          blocks: JSON.stringify(buildSlackConfirmBlocks(draft, action, issued.code, issued.draft_hash)),
        },
        team_id,
      );
    } catch (e) {
      return fail("confirm_card_failed", `The Confirm card could not be posted (${(e as Error).message.slice(0, 200)}). Ask the user to create it from Zavi on the web.`);
    }
    return ok(confirmNote("A card with a Confirm button was posted in this thread."));
  }

  if (ctx.trigger === "whatsapp" && waRouting && ctx.run_id) {
    try {
      const issued = await issueCustomAgentConfirm({
        tenant_id: ctx.tenant_id,
        surface: "whatsapp",
        external_user_id: waRouting.wa_id,
        phone_number_id: waRouting.phone_number_id,
        action,
        agent_id: editTarget?.id ?? null,
        draft,
        origin: { message_id: await readWhatsAppOriginMessageId(ctx) },
        origin_run_id: ctx.run_id,
      });
      const { callWhatsApp } = await import("@/services/connectors/whatsapp/adapter");
      let sent = await callWhatsApp(
        waRouting.wa_id,
        buildWhatsAppConfirmMessage(draft, action, issued.code, issued.draft_hash),
      );
      if (!sent.ok) {
        sent = await callWhatsApp(waRouting.wa_id, {
          type: "text",
          text: { body: buildWhatsAppConfirmText(draft, action, issued.code), preview_url: false },
        });
      }
      if (!sent.ok) throw new Error(sent.errorMessage ?? `whatsapp send failed (${sent.status})`);
    } catch (e) {
      return fail("confirm_card_failed", `The Confirm message could not be sent (${(e as Error).message.slice(0, 200)}). Ask the user to create it from Zavi on the web.`);
    }
    return ok(confirmNote("A message with a Confirm button (or a CONFIRM code) was sent in this chat."));
  }

  return ok(
    "This surface cannot show the confirm card. Tell the user the draft in two lines and that they can create it from Zavi on the web, Slack or WhatsApp.",
  );
}

async function readWhatsAppOriginMessageId(ctx: PraxisToolCtx): Promise<string | null> {
  const r = await readParentSurfaceRouting(ctx, "whatsapp", ["wa_id", "phone_number_id"]);
  return typeof r?.message_id === "string" ? r.message_id : null;
}

async function isActiveCustomAgentOfTenant(tenant_id: string, slug: string): Promise<boolean> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("custom_agents")
      .select("id")
      .eq("slug", slug)
      .eq("status", "active")
      .maybeSingle<{ id: string }>();
    return !error && !!data;
  } catch {
    return false;
  }
}

async function registerCustomHandoffJoin(
  tenant_id: string,
  parent_run_id: string,
  child_run_id: string,
): Promise<boolean> {
  try {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "custom_agent_handoff_register", {
      p_parent_run_id: parent_run_id,
      p_child_run_id: child_run_id,
    });
    if (error) {
      console.warn(`[praxis handoff] join register failed: ${error.message}`);
      return false;
    }
    return data === true;
  } catch (e) {
    console.warn(`[praxis handoff] join register threw: ${(e as Error).message}`);
    return false;
  }
}
