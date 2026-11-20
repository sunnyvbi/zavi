
import { stripLegacyCriticNotes } from "@/agents/engineer/legacy-critic-notes";
import { socialPublishGate } from "@/services/connectors/social-publish-gate";
import { refuseIfSocialPostPlanLocked } from "@/routes/approvals/decision-channel";
import { checkPublishText } from "@/services/connectors/social-publish-content-guard";
import { z } from "zod";
import { createHash } from "node:crypto";
import { withMetaDecisionExec, withMetaSafety } from "@/services/tools/meta-ads/_cooldown";
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { withApprovedByFooter } from "@/services/tools/slack/provenance-footer";
import {
  resolveChannelAction,
  validateChannelPayload,
  buildConfiguredProps,
  type SocialPayload,
} from "@/services/connectors/social-channels";
import { resolveSocialPublishAccount, type SocialPublishTransport } from "@/services/connectors/social-publish-account";
import { logDecisionNotTaken } from "@/services/agents/log-decision-not-taken";
import { isActiveConductorRun, requestTickForLandedPush } from "@/services/agents/conductor-kick";
import { alert } from "@/services/logging/alert";
import { isVerifiedSiteRepoRun, siteProtectedPathHits, withoutSiteMigrationHits } from "@/services/sites/site-build-target";
import { freshAppProtectedPathHits, isFreshBuildCodegenPayload, isFreshBuildRun, withoutFreshAppHits } from "@/services/agents/fresh-build-paths";
import { stampOutcomeForDecisionId } from "@/services/memory/stamp-outcome";
import { callMcpTool } from "@/services/mcp/execute";
import { enqueueSlackOutbox } from "@/services/slack/outbox";
import {
  prProposalSchema,
  prProposalProductBuildSchema,
} from "@/agents/engineer/output-schema";
import { loadAgentDefinition } from "@/services/agents/registry";
import { jiraCreateIssue, jiraAddComment } from "@/services/mcp/internal/jira";
import { linearCreateIssue, linearAddComment } from "@/services/mcp/internal/linear";
import { postTrackerPrComment } from "@/services/agents/tracker-pr-comment";
import { digestPostHandler } from "./digest-post-handler";
import { claimDecision, releaseClaim } from "@/services/decisions/atomic-claim";
import { isEmailCardClass } from "@/services/email-cards/approve-gate";
import {
  getApprovalCardRef,
  updateApprovalCard,
} from "@/services/slack/approval-post-target";
import {
  shouldRefuseUnapprovedShipPr,
  shouldHoldInteractiveShipPr,
  shouldRefuseUnapprovedComposioWrite,
  shouldRefuseUnapprovedExactActionCard,
  shouldRefuseUnapprovedBulkEmail,
} from "@/services/decisions/ship-pr-approval-gate";
import { checkAutoFireRateCap } from "@/services/decisions/auto-fire-rate-cap";
import { resolveWaiverState } from "@/services/decisions/waiver-resolve";
import { consumeClassBudget } from "@/services/agents/class-cap";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { readTenantDisabled } from "@/services/tenants/disabled";
import { logEvent } from "@/services/logging/logEvent";
import {
  updateAdSetBudgetBodySchema,
  updateCampaignBudgetBodySchema as metaUpdateCampaignBudgetBodySchema,
  createCampaignBodySchema as metaCreateCampaignBodySchema,
  updateCampaignBodySchema as metaUpdateCampaignBodySchema,
  deleteCampaignBodySchema as metaDeleteCampaignBodySchema,
  updateAdSetBodySchema as metaUpdateAdSetBodySchema,
  updateAdBodySchema as metaUpdateAdBodySchema,
  duplicateAdBodySchema as metaDuplicateAdBodySchema,
  createCreativeBodySchema as metaCreateCreativeBodySchema,
  updateCreativeBodySchema as metaUpdateCreativeBodySchema,
  uploadAssetBodySchema as metaUploadAssetBodySchema,
  createLookalikeAudienceBodySchema as metaCreateLookalikeBodySchema,
  createCustomConversionBodySchema as metaCreateCustomConversionBodySchema,
  createLeadFormBodySchema as metaCreateLeadFormBodySchema,
  type UpdateAdSetBudgetBody,
  setStatusBodySchema,
  createAdSetBodySchema,
  duplicateAdSetBodySchema,
  duplicateCampaignBodySchema,
  createCustomAudienceBodySchema,
  createAdBodySchema as metaCreateAdBodySchema,
  launchCampaignBodySchema as metaLaunchCampaignBodySchema,
} from "@/services/tools/meta-ads/write/_decision-bodies";
import { metaUpdateAdSetBudget } from "@/services/tools/meta-ads/write/update_ad_set_budget";
import { metaUpdateCampaignBudget } from "@/services/tools/meta-ads/write/update_campaign_budget";
import {
  metaCreateCampaign,
  metaDeleteCampaign,
  metaUpdateCampaign,
  readOwnCampaign,
} from "@/services/tools/meta-ads/write/campaign_writes";
import { metaDuplicateAd, metaUpdateAd, metaUpdateAdSet } from "@/services/tools/meta-ads/write/adset_ad_writes";
import { metaCreateCreative, metaUpdateCreative, metaUploadAsset } from "@/services/tools/meta-ads/write/creative_writes";
import { metaCreateCustomConversion, metaCreateLookalikeAudience } from "@/services/tools/meta-ads/write/measurement_writes";
import { metaCreateLeadForm } from "@/services/tools/meta-ads/write/lead_form_writes";
import { metaSetStatus } from "@/services/tools/meta-ads/write/set_status";
import { readBackBudget } from "@/services/growth/budget-readback";
import { metaCreateAdSet } from "@/services/tools/meta-ads/write/create_ad_set";
import { fbGet, getAdAccountCurrency, metaAdsCreds } from "@/services/tools/meta-ads/_client";
import {
  enumerateCampaignAdSets,
  classifyCampaignBudgeting,
} from "@/services/tools/meta-ads/list_ad_sets";
import { emailSend } from "@/services/tools/email/_client";
import {
  sendOutbound,
  type OutboundWireSender,
} from "@/services/comms/outbound-send";
import { GmailSendError, sendFromConnectedGmail } from "@/services/comms/email-sender";
import { executeBulkOutboundDispatch } from "@/services/comms/bulk-outbound/dispatch";
import { sendFundraisingEmail } from "@/services/fundraising/send-provider";
import { detectCbo, toBudgetMinorUnits } from "@/services/tools/meta-ads/write/_helpers";
import {
  adBudgetRefusal,
  adBudgetStandsInForCap,
  budgetMustHold,
  commitAdSpend,
  dropAdSpendHold,
  noteAdSpendObject,
  noteAdSpendRef,
  beforeSend,
  adBudgetRebaseKey,
  prefixAdName,
  rebaseAdSpendForObject,
  releaseAdSpendForObject,
  reserveAdSpend,
  runAdBudgetChecks,
  settleAdSpendAfterError,
  type AdSpendHold,
} from "@/services/decisions/ad-budget";
import { recordZaviAdChange } from "@/services/decisions/ad-changes";
import { assertNoBudgetDrift } from "@/services/tools/meta-ads/write/_drift-guard";
import { evaluateBudgetCap } from "@/services/tools/meta-ads/write/_cap-evaluator";
import { readTenantCapAndToday } from "@/services/tools/meta-ads/write/cap-reader";
import { capGovernsDispatch } from "@/services/decisions/ads-approval-authority";
import { DECISION_STATUS_DISPATCH_FAILED } from "@/services/decisions/status";
import { BUILD_CONDUCTOR_RUN_ID_KEY } from "@/services/billing/tiers";
import {
  execPlatform,
  execPlatformLabel,
  platformWriteEnabled,
} from "@/services/channels/exec-kill-switch";
import { minMergeCap } from "@/services/tools/meta-ads/write/_user-initiated";
import {
  bodyCurrencyMismatch,
  capInAccountUnits,
  formatMoney,
  isWritableCurrency,
  minorUnitsPerMajor,
} from "@/services/tools/meta-ads/write/_currency";
import { reconstructCreateBody } from "@/services/meta-ads/strategist-gate/reconstruct";
import { emitFinalCreateIdempotent } from "@/services/meta-ads/strategist-gate/emit-idempotent";
import { findFinalCreateFor } from "@/services/meta-ads/strategist-gate/review-state";
import { isPendingStrategistBody } from "@/services/meta-ads/strategist-gate/pending-body";
import {
  updateCampaignBudgetBodySchema,
  googleSetStatusBodySchema,
  createCampaignBodySchema,
  updateCampaignBodySchema,
  createAdGroupBodySchema,
  updateAdGroupBodySchema,
  createAdBodySchema,
  addKeywordsBodySchema,
  removeResourceBodySchema,
} from "@/services/tools/google-ads/write/_decision-bodies";
import { readTenantGoogleCapAndToday } from "@/services/tools/google-ads/write/cap-reader";
import { googleUpdateCampaignBudget } from "@/services/tools/google-ads/write/update_campaign_budget";
import {
  googleSetAdGroupStatus,
  googleSetAdStatus,
  googleSetCampaignStatus,
} from "@/services/tools/google-ads/write/set_status";
import { googleCreateCampaign } from "@/services/tools/google-ads/write/create_campaign";
import { googleUpdateCampaign } from "@/services/tools/google-ads/write/update_campaign";
import { googleReplaceGeoTargets, replaceGeoTargetsBodySchema } from "@/services/tools/google-ads/write/replace_geo_targets";
import { metaReplaceAdSetGeo, replaceAdSetGeoBodySchema } from "@/services/tools/meta-ads/write/replace_ad_set_geo";
import { PAUSE_PAST_GUARD_CLASS, pausePastGuardBodySchema } from "@/services/tools/meta-ads/write/_pause-past-guard";
import { googleCreateAdGroup } from "@/services/tools/google-ads/write/create_ad_group";
import { googleUpdateAdGroup } from "@/services/tools/google-ads/write/update_ad_group";
import { googleCreateAd } from "@/services/tools/google-ads/write/create_ad";
import { googleAddKeywords } from "@/services/tools/google-ads/write/add_keywords";
import { googleRemoveResource } from "@/services/tools/google-ads/write/remove_resource";
import {
  gadsGetAd,
  gadsGetAdGroup,
  gadsGetCampaign,
  gadsGetCampaignEnd,
  gadsGetCampaignBudget,
  gadsGetBudgetGuardFacts,
  gadsCustomerId,
} from "@/services/tools/google-ads/_client";
import { videoAdGroupRefusal, videoMutateRefusal } from "@/services/tools/google-ads/write/_video-guard";
import { logoPathBelongsTo } from "@/services/tools/google-ads/write/_logo";
import { adImagePathBelongsTo } from "@/services/tools/google-ads/write/_ad-images";
import { checkCreatedPaused } from "@/services/tools/google-ads/write/_paused-postcondition";
import { cgoTestEndForRun, dayBefore, earlierEndDay, metaTestEndTime, testEndUnix } from "@/services/growth/cgo-test-end";
import { armCreatedTestStop } from "@/services/growth/test-stops";
import { dayWords } from "@/services/growth/budget-test-shape";
import { googleCurrencyRefusal } from "@/services/tools/google-ads/write/_currency-guard";
import { ExpectedToolError } from "@/services/tools/types";
import {
  buildDispatchNotice,
  BULK_OUTBOUND_INTERRUPTED_LINE,
  BULK_OUTBOUND_INVALID_LINE,
  BULK_OUTBOUND_NOT_SENT_LINE,
  bulkNotSentLine,
  buildOpenPrNotice,
  extractChatThreadId,
  extractSlackRouting,
  type SlackRouting,
  type OpenPrVerify,
} from "./dispatch-notice";

export function resolveOpenPrVerify(source: unknown): OpenPrVerify | undefined {
  if (!source || typeof source !== "object") return undefined;
  const v = (source as { verify?: unknown }).verify;
  if (!v || typeof v !== "object") return undefined;
  const status = (v as { status?: unknown }).status;
  if (
    status !== "passed" &&
    status !== "failed" &&
    status !== "couldnt_run" &&
    status !== "not_run"
  ) {
    return undefined;
  }
  const reason = (v as { reason?: unknown }).reason;
  return {
    status,
    reason: typeof reason === "string" ? reason : undefined,
  };
}
import { mdToMrkdwn } from "@/services/tools/slack/mrkdwn";
import { assertProvisionedRepoTarget } from "@/services/provisioning/provisioned-repo-gate";
import { assertUserRepoTarget } from "@/services/provisioning/user-repo-gate";
import { loadTenantProtectedGlobs, loadTenantProtectedGlobSet } from "@/services/agents/pipeline-policy-store";
import {
  findProtectedPathHits,
  coerceProtectedPathHits,
  describeProtectedHits,
} from "@/services/agents/pipeline-policy";
import { createStripeConnectProvisioner } from "@/services/provisioning/stripe-connect";
import { submitDisputeEvidenceTool } from "@/services/tools/stripe/submit_dispute_evidence";
import { createPaymentTool } from "@/services/tools/stripe/create_payment";
import { remitToTenantTool } from "@/services/tools/stripe/remit_to_tenant";
import { findHeldFundByRef } from "@/services/tools/stripe/held-funds";
import { moneyCardSealIntact } from "@/services/approvals/money-card";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";
import { recordMetricsDeclaration } from "@/services/provisioning/metrics-declaration";
import type { PushedFile } from "@/services/provisioning/app-db-on-demand";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { retireStaleBudgetProposals } from "@/services/channels/retire-stale-budget";

const proposedRuleBodySchema = z.object({
  rule_body_markdown: z.string().min(5).max(1500),
  target_agent_slug: z.string().min(1).max(64),
  rationale: z.string().max(500).optional(),
  scope: z.record(z.string(), z.unknown()).optional(),
  source_feedback_id: z.string().uuid().optional(),
  clarify_count: z.number().int().min(0).optional(),
  origin: z.string().optional(),
  global_rule_id: z.string().uuid().optional(),
});

const TRAINER_RULES_SECTION_HEADER = "## Trainer-applied rules";

const heartbeatProposalApproveBody = z.object({
  agent_slug: z.string().min(1).max(64),
  cron_expression: z.string().min(1).max(120),
  objective: z.string().min(1).max(2000),
});

const publishRoleBodySchema = z.object({
  role_id: z.string().uuid(),
  approved_questions: z.array(
    z.object({
      id: z.string(),
      prompt: z.string(),
      must_ask: z.boolean(),
      allow_followup: z.boolean(),
    }),
  ),
});

type DecisionRow = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  decision_class: string;
  body: Record<string, unknown>;
  status: string;
  handler: string | null;
  approved_by?: string | null;
  approved_by_source?: string | null;
  claim_id?: string;
};

const dispatchSpecialistBody = z.object({
  target_agent_slug: z.string().min(1),
  intent: z.string().min(1).max(2000),
  origin_decision_id: z.string().uuid().optional(),
  dispatched_by: z.string().min(1).max(64).optional(),
  repo_hint: z.string().min(1).max(140).optional(),
  site_id: z.string().uuid().optional(),
  file_hints: z.array(z.string().min(1).max(300)).max(5).optional(),
  context_summary: z.string().max(500).optional(),
  source_agent: z.string().min(1).max(64).optional(),
  goal_id: z.string().uuid().optional(),
  goal_rev: z.string().min(1).max(64).optional(),
  problem: z.string().max(40).optional().catch(undefined),
  moves_metric: z.string().max(120).optional().catch(undefined),
  boundaries: z.string().max(400).optional().catch(undefined),
  expected_output: z.string().max(400).optional().catch(undefined),
  test: z.record(z.string(), z.unknown()).optional().catch(undefined),
});
const jiraCreateBody = z.object({
  project_key: z.string().min(1),
  issue_type: z.string().min(1).default("Task"),
  summary: z.string().min(1).max(255),
  description_markdown: z.string().max(30000).default(""),
});
const jiraCommentBody = z.object({
  issue_key: z.string().min(1),
  body_markdown: z.string().min(1).max(30000),
});
const linearCreateBody = z.object({
  team_id: z.string().min(1),
  title: z.string().min(1).max(255),
  description_markdown: z.string().max(30000).default(""),
});
const linearCommentBody = z.object({
  issue_id: z.string().min(1),
  body_markdown: z.string().min(1).max(30000),
});

const emailSendBody = z.object({
  to: z.string().email("`to` must be a valid email address"),
  subject: z.string().min(1).max(200),
  body_text: z.string().min(1).max(50_000),
  body_html: z.string().max(100_000).optional(),
  reply_to: z.string().email().optional(),
  artifact_id: z.string().uuid().optional(),
});

const outboundSendBody = z.object({
  channel: z.enum(["email", "sms", "slack_dm"]).default("email"),
  to: z.string().min(1).max(320),
  subject: z.string().min(1).max(200),
  body_text: z.string().min(1).max(50_000),
  body_html: z.string().max(100_000).optional(),
});

const stripeEvidenceFieldsBody = z
  .object({
    customer_communication: z.string().min(1).max(20000).optional(),
    customer_purchase_ip: z.string().min(1).max(64).optional(),
    service_documentation: z.string().min(1).max(20000).optional(),
    receipt: z.string().min(1).max(20000).optional(),
    shipping_documentation: z.string().min(1).max(20000).optional(),
    uncategorized_text: z.string().min(1).max(20000).optional(),
  })
  .strict();

const submitDisputeEvidenceBody = z.object({
  evidence_packet: z.object({
    dispute_id: z
      .string()
      .regex(
        /^d[pu]_[A-Za-z0-9]+$/,
        "must be a Stripe dispute id (du_* or legacy dp_*)",
      ),
    evidence_fields: stripeEvidenceFieldsBody,
    recommendation: z.enum(["fight", "accept"]).optional(),
    win_band: z.enum(["High", "Medium", "Low"]).optional(),
  }),
  submit_final: z.boolean().default(false),
});

export const NEVER_AUTO_DECISION_CLASSES: ReadonlySet<string> = new Set([
  "linkedin_ads.launch_campaign",
  "linkedin_ads.resume_campaign",
  "linkedin_ads.update_campaign_budget",
  "linkedin_ads.update_targeting",
  "growth.save_business_controls",
  "chatgpt_ads.create_and_launch",
  "chatgpt_ads.update_campaign_budget",
  "chatgpt_ads.set_status",
  "browser.action",
  "dispute-response.final-submit-evidence",
  "github.open_pr_direct",
  "github.merge_pr_direct",
  "stripe.create_payment",
  "stripe.remit_to_tenant",
  "extension.money_step",
  "social.publish.v2",
  "growth-lead.outreach-drafts",
  "fundraising.outbound.send",
  "content-seo.dispatch-engineer",
  "content-design.propose-change",
  "content-seo.publish-content",
  "meta_ads.update_ad_set_budget_review",
  "meta_ads.update_campaign_budget_review",
  "meta_ads.create_campaign",
  "meta_ads.update_campaign",
  "meta_ads.delete_campaign",
  "meta_ads.update_ad_set",
  "meta_ads.update_ad",
  "meta_ads.duplicate_ad",
  "meta_ads.create_creative",
  "meta_ads.update_creative",
  "meta_ads.upload_asset",
  "meta_ads.create_lookalike_audience",
  "meta_ads.create_custom_conversion",
  "meta_ads.create_lead_form",
  "meta_ads.set_status_review",
  "meta_ads.pause_past_cut_guard",
  "google_ads.update_campaign_budget_review",
  "google_ads.set_status_review",
  "google_ads.create_campaign",
  "google_ads.remove_resource",
  "google_ads.replace_geo_targets_review",
  "meta_ads.replace_ad_set_geo_review",
  "meta_ads.create_ad_set",
  "meta_ads.duplicate_ad_set",
  "meta_ads.duplicate_campaign",
  "meta_ads.create_ad",
  "meta_ads.create_custom_audience",
  "meta_ads.launch_campaign",
  "x_ads.set_status",
  "x_ads.update_campaign",
  "x_ads.create_campaign",
  "x_ads.manage_objects",
  "tiktok_ads.set_status",
  "tiktok_ads.update_budget",
  "bulk_outbound.send",
  "email_campaign.create_and_send",
  "heartbeat.automation-proposal",
  "pm.needs_action",
]);

async function recordTicketLedger(
  d: DecisionRow,
  connector: "jira" | "linear",
  external_key: string,
): Promise<void> {
  if (!external_key) return;
  let agent_slug = "unknown";
  if (d.agent_run_id) {
    const { data } = await serviceClient()
      .from("agent_runs")
      .select("agent_slug")
      .eq("id", d.agent_run_id)
      .maybeSingle();
    agent_slug = (data as { agent_slug?: string } | null)?.agent_slug ?? "unknown";
  }
  const { error } = await serviceClient()
    .from("connector_ticket_ledger")
    .upsert(
      {
        tenant_id: d.tenant_id,
        connector,
        external_key,
        agent_run_id: d.agent_run_id,
        agent_slug,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,connector,external_key" },
    );
  if (error) {
    console.warn(
      `[dispatch-decision ${connector}] ledger upsert failed for ${external_key}: ${error.message}`,
    );
  }
}

type HandlerResult = {
  execution_details?: import("@/services/connectors/reddit-ads/execute").RedditExecutionDetails;
  ok: boolean;
  error?: string;
  code?: string;
  notice?: string;
  agent_outcome?: string;
  created?: import("@/services/channels/created-object").CreatedObject;
  cut_guard_override?: true;
  places_change?: { before: string[]; after: string[] };
  location_undo?: import("@/services/tools/meta-ads/write/replace_ad_set_geo").ReplaceAdSetGeoBody;
  receipt?: import("@/services/channels/exec-receipt").ExecReceipt;
  pr?: { url: string; number: number | null; repo: string };
  verify?: OpenPrVerify;
  outcome_unknown?: boolean;
  reconcile_queued?: boolean;
  retry_later?: boolean;
  resume_pending?: PendingResume;
  held_for_founder?: boolean;
};
type Handler = (decision: DecisionRow) => Promise<HandlerResult>;

async function stampResumeCapCounted(d: DecisionRow, daily: number | null, currency: string): Promise<boolean> {
  const exec = (d as DecisionRow & { exec_source?: string }).exec_source === "channel_actions";
  try {
    const { data, error } = await serviceClient()
      .from(exec ? "channel_actions" : "decisions")
      .update({ cap_counted: daily === null ? { daily: null, unknown: true, currency } : { daily, currency } })
      .eq("id", d.id)
      .eq("tenant_id", d.tenant_id)
      .eq(exec ? "exec_status" : "status", "dispatching")
      .select("id");
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown[]).length > 0;
  } catch (e) {
    console.warn(`[dispatch-decision] resume amount of ${d.id} not recorded: ${(e as Error).message}`);
    return false;
  }
}

function adChangeFrom(d: DecisionRow): { table: "channel_actions" | "decisions"; id: string } {
  return { table: (d as DecisionRow & { exec_source?: string }).exec_source === "channel_actions" ? "channel_actions" : "decisions", id: d.id };
}

const EMAIL_ATTACHMENT_MAX_BYTES = 18 * 1024 * 1024;
const EMAIL_ATTACHMENT_ALLOWED_MIME = new Set(["application/pdf"]);

function sanitizeFilename(raw: string): string {
  const parts = raw.replace(/\\/g, "/").split("/");
  const base = parts[parts.length - 1] ?? raw;
  const stripped = base.replace(/[\x00-\x1F\x7F]/g, "");
  return stripped.slice(0, 200) || "attachment.pdf";
}

async function loadEmailAttachment(
  decision: DecisionRow,
  artifact_id: string | undefined,
): Promise<
  | { ok: true; attachment: { filename: string; content: string; type: string } | null }
  | { ok: false; error: string }
> {
  if (!artifact_id) return { ok: true, attachment: null };
  const svc = serviceClient();
  const { data, error } = await svc
    .from("run_artifacts")
    .select("id, tenant_id, run_id, storage_path, filename, mime, bytes")
    .eq("id", artifact_id)
    .eq("tenant_id", decision.tenant_id)
    .maybeSingle();
  if (error) return { ok: false, error: `artifact_lookup_failed: ${error.message}` };
  if (!data) return { ok: false, error: `artifact_not_found: ${artifact_id}` };
  const row = data as {
    tenant_id: string;
    run_id: string | null;
    storage_path: string;
    filename: string;
    mime: string;
    bytes: number;
  };
  if (row.tenant_id !== decision.tenant_id) {
    return { ok: false, error: `artifact_tenant_mismatch: ${artifact_id}` };
  }
  if (!row.storage_path.startsWith(`${decision.tenant_id}/`)) {
    return {
      ok: false,
      error: `artifact_storage_path_mismatch: ${artifact_id} storage_path=${row.storage_path.slice(0, 80)}`,
    };
  }
  if (decision.agent_run_id && row.run_id && row.run_id !== decision.agent_run_id) {
    return { ok: false, error: `artifact_run_id_mismatch: ${artifact_id} run_id=${row.run_id}` };
  }
  if (!EMAIL_ATTACHMENT_ALLOWED_MIME.has(row.mime)) {
    return { ok: false, error: `artifact_mime_not_allowed: ${row.mime} (v1 supports application/pdf only)` };
  }
  if (row.bytes > EMAIL_ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      error: `artifact_too_large: ${row.bytes} bytes > ${EMAIL_ATTACHMENT_MAX_BYTES} byte cap`,
    };
  }
  let arrayBuf: ArrayBuffer;
  try {
    const { data: blob, error: dlErr } = await svc.storage
      .from("agent-artifacts")
      .download(row.storage_path);
    if (dlErr || !blob) {
      return { ok: false, error: `artifact_download_failed: ${dlErr?.message ?? "no blob"}` };
    }
    arrayBuf = await blob.arrayBuffer();
  } catch (e) {
    return { ok: false, error: `artifact_download_failed: ${(e as Error).message}` };
  }
  if (arrayBuf.byteLength > EMAIL_ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: `artifact_too_large: ${arrayBuf.byteLength} bytes (post-download)` };
  }
  let base64: string;
  try {
    base64 = Buffer.from(arrayBuf).toString("base64");
  } catch (e) {
    return { ok: false, error: `artifact_encode_failed: ${(e as Error).message}` };
  }
  return {
    ok: true,
    attachment: {
      filename: sanitizeFilename(row.filename),
      content: base64,
      type: row.mime,
    },
  };
}

const handleEmailSend: Handler = async (d) => {
  const pausedRefusal = await emailPausedRefusal(d.tenant_id, true);
  if (pausedRefusal) return pausedRefusal;
  const parsed = emailSendBody.safeParse(d.body);
  if (!parsed.success) {
    return {
      ok: false,
      error: `email.send body invalid: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    };
  }
  const p = parsed.data;
  const att = await loadEmailAttachment(d, p.artifact_id);
  if (!att.ok) {
    return { ok: false, error: att.error };
  }
  try {
    const result = await emailSend(d.tenant_id, {
      to: p.to,
      subject: p.subject,
      body_text: p.body_text,
      body_html: p.body_html,
      reply_to: p.reply_to,
      ...(att.attachment ? { attachments: [att.attachment] } : {}),
    });
    const attNote = att.attachment ? ` (attached \`${att.attachment.filename}\`)` : "";
    return {
      ok: true,
      notice: result.messageId
        ? `Sent email to ${p.to}${attNote} (message ${result.messageId}).`
        : `Queued email to ${p.to}${attNote} — accepted by the provider, delivery not yet confirmed.`,
    };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return {
      ok: false,
      error: err.code
        ? `${err.code}: ${err.message ?? "send failed"}`
        : err.message ?? "send failed",
    };
  }
};

const outboundEmailWireSender: OutboundWireSender = {
  async send(msg) {
    if (msg.channel !== "email") {
      return null;
    }
    try {
      const r = await emailSend(
        msg.tenant_id,
        {
          to: msg.to,
          subject: msg.subject,
          body_text: msg.body_text,
          body_html: msg.body_html,
        },
        { verifiedSenderFallback: true },
      );
      return { message_id: r.messageId };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "not_connected" || code === "email_not_connected") {
        return sendFromConnectedGmail(msg.tenant_id, {
          to: msg.to,
          subject: msg.subject,
          body_text: msg.body_text,
          body_html: msg.body_html,
        });
      }
      if (code === "email_from_not_set") {
        const viaGmail = await sendFromConnectedGmail(msg.tenant_id, {
          to: msg.to,
          subject: msg.subject,
          body_text: msg.body_text,
          body_html: msg.body_html,
        });
        if (viaGmail) return viaGmail;
      }
      throw e;
    }
  },
};

export const OUTBOUND_EMAIL_NOT_CONNECTED =
  "No email account is connected, so nothing was sent. Connect Gmail on the Email campaigns channel, then ask Zavi to send it again.";

const handleOutboundSend: Handler = async (d) => {
  const parsed = outboundSendBody.safeParse(d.body);
  if (!parsed.success) {
    return {
      ok: false,
      error: `outbound.send body invalid: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    };
  }
  const p = parsed.data;
  if (p.channel === "email") {
    const pausedRefusal = await emailPausedRefusal(d.tenant_id, true);
    if (pausedRefusal) return pausedRefusal;
  }
  try {
    const result = await sendOutbound(
      {
        tenant_id: d.tenant_id,
        channel: p.channel,
        to: p.to,
        subject: p.subject,
        body_text: p.body_text,
        body_html: p.body_html,
      },
      { wireSender: outboundEmailWireSender },
    );
    if (result.ok) {
      return {
        ok: true,
        notice: result.message_id
          ? `Sent outbound ${p.channel} to ${p.to} (message ${result.message_id}).`
          : `Queued outbound ${p.channel} to ${p.to} — accepted by the provider, delivery not yet confirmed.`,
      };
    }
    if (result.status === "blocked") {
      return {
        ok: false,
        error: `comms safety net blocked send to ${p.to}: ${result.reason}${
          result.detail ? ` (${result.detail})` : ""
        }`,
      };
    }
    return {
      ok: false,
      error:
        p.channel === "email"
          ? OUTBOUND_EMAIL_NOT_CONNECTED
          : `outbound ${p.channel} not connected for this tenant: ${result.reason}`,
    };
  } catch (e) {
    if (
      (e instanceof GmailSendError && e.outcome_unknown) ||
      (e instanceof ExpectedToolError && e.code === "email_send_outcome_unknown")
    ) {
      return { ok: false, outcome_unknown: true, code: "exec_outcome_unknown", error: e.message };
    }
    return { ok: false, error: (e as Error).message };
  }
};

async function emailPausedRefusal(tenantId: string, oneToOne = false): Promise<HandlerResult | null> {
  const { emailSendPaused } = await import("@/services/email-cards/pause");
  const { EMAIL_PAUSED_CODE, EMAIL_PAUSED_ERROR, EMAIL_PAUSED_ONE_TO_ONE_ERROR } = await import("@/services/connectors/email-campaign/execute-send");
  const paused = await emailSendPaused(tenantId).catch(() => true);
  return paused ? { ok: false, code: EMAIL_PAUSED_CODE, error: oneToOne ? EMAIL_PAUSED_ONE_TO_ONE_ERROR : EMAIL_PAUSED_ERROR } : null;
}

const BULK_SENDER_STOPPED_HOLD = "bulk_sender_stopped_hold";
const BULK_SEND_NOT_STARTED = "bulk_send_not_started";

async function bulkSendNeverStarted(tenantId: string, decisionId: string): Promise<boolean> {
  try {
    const { defaultFanoutDeps } = await import("@/services/comms/bulk-outbound/fanout");
    const { store } = await defaultFanoutDeps();
    return (await store.sendIdForDecision(tenantId, decisionId)) === null;
  } catch {
    return false;
  }
}

const handleBulkOutboundSend: Handler = async (d) => {
  const pausedRefusal = await emailPausedRefusal(d.tenant_id);
  if (pausedRefusal) return pausedRefusal;
  if (d.approved_by_source === "plan_autopilot") {
    const { plannedListSendRefusal } = await import("@/services/email-plan/list-door");
    const refusal = await plannedListSendRefusal(d.tenant_id, d.id);
    if (refusal) return { ok: false, code: refusal.code, error: refusal.sentence };
  }
  let r: Awaited<ReturnType<typeof executeBulkOutboundDispatch>>;
  try {
    r = await executeBulkOutboundDispatch({
      tenant_id: d.tenant_id,
      decision_id: d.id,
      approved_by: d.approved_by_source === "cgo" ? null : d.approved_by,
      body: d.body,
      requireVersions: true,
      deps: {
        enqueueFanout: async (send_id) => {
          await inngest.send({
            id: `bulk-email-fanout:${send_id}`,
            name: "bulk-email/fanout.requested",
            data: { send_id },
          });
        },
      },
    });
  } catch {
    if (await bulkSendNeverStarted(d.tenant_id, d.id)) return { ok: false, code: BULK_SEND_NOT_STARTED, error: BULK_SEND_NOT_STARTED };
    return {
      ok: false,
      outcome_unknown: true,
      error: `${BULK_OUTBOUND_INTERRUPTED_LINE} (bulk_outbound_dispatch_error)`,
    };
  }
  if (!r.ok && r.status === "held") return { ok: false, code: BULK_SENDER_STOPPED_HOLD, error: r.sentence };
  {
    const { bulkSendOutcome } = await import("@/services/email-cards/outcome");
    const o = r.ok
      ? bulkSendOutcome(d.tenant_id, d.id, r.state, r.counts, r.line)
      : r.status === "unconfirmed"
        ? bulkSendOutcome(d.tenant_id, d.id, r.state, r.counts, r.sentence)
      : r.status === "refused" || r.status === "failed"
        ? bulkSendOutcome(d.tenant_id, d.id, r.status, null, r.sentence, r.status === "refused" ? r.code : null)
        : null;
    if (o) await (await import("@/services/email-cards/outcome-tell")).tellEmailSendOutcomeOrQueue(o);
  }
  if (r.ok) {
    return { ok: true, notice: r.line, agent_outcome: r.line };
  }
  if (r.status === "legacy") return { ok: false, error: `${BULK_OUTBOUND_NOT_SENT_LINE} (${r.code})` };
  if (r.status === "invalid_body") return { ok: false, error: `${BULK_OUTBOUND_INVALID_LINE} (${r.code})` };
  return { ok: false, code: r.code, error: `${bulkNotSentLine(r.sentence)} (${r.code})` };
};

const fundraisingOutboundSendBody = z.object({
  investor_id: z.string().uuid().optional(),
  recipient: z.string().email().max(320),
  channel: z.enum(["email"]).default("email"),
  subject: z.string().min(1).max(200),
  body_text: z.string().min(1).max(50_000),
  sender: z.string().email().optional(),
  strategy_run_id: z.string().uuid().optional(),
  test_recipient: z.string().email().optional(),
});

const handleFundraisingOutboundSend: Handler = async (d) => {
  const pausedRefusal = await emailPausedRefusal(d.tenant_id, true);
  if (pausedRefusal) return pausedRefusal;
  const parsed = fundraisingOutboundSendBody.safeParse(d.body);
  if (!parsed.success) {
    return {
      ok: false,
      error: `fundraising.outbound.send body invalid: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    };
  }
  const p = parsed.data;
  try {
    const safetyResult = await sendOutbound(
      {
        tenant_id: d.tenant_id,
        channel: p.channel,
        to: p.recipient,
        subject: p.subject,
        body_text: p.body_text,
      },
      {
        wireSender: {
          async send() {
            return null;
          },
        },
      },
    );

    if (!safetyResult.ok && safetyResult.status === "blocked") {
      await Promise.resolve(
        serviceClient()
          .from("fundraising_send_audit")
          .insert({
            decision_id: d.id ?? null,
            run_id: d.agent_run_id ?? null,
            tenant_id: d.tenant_id,
            investor_id: p.investor_id ?? null,
            sender: p.sender ?? null,
            recipient: p.recipient,
            subject: p.subject,
            status: "blocked",
            provider: "none",
            safety_result: { reason: safetyResult.reason, detail: safetyResult.detail ?? null },
          }),
      )
        .then(({ error }) => {
          if (error) {
            console.error(
              `[dispatch-decision/fundraising] blocked audit write failed: ${error.message}`,
            );
          }
        })
        .catch((e: Error) => {
          console.error(
            `[dispatch-decision/fundraising] blocked audit write threw: ${e.message}`,
          );
        });
      return {
        ok: false,
        error: `comms safety net blocked fundraising send: ${safetyResult.reason}${
          safetyResult.detail ? ` (${safetyResult.detail})` : ""
        }`,
      };
    }

    const sendResult = await sendFundraisingEmail({
      tenant_id: d.tenant_id,
      to: p.recipient,
      subject: p.subject,
      body: p.body_text,
      sender: p.sender,
      test_recipient: p.test_recipient,
      decision_id: d.id,
      run_id: d.agent_run_id ?? undefined,
      investor_id: p.investor_id,
    });

    if (!sendResult.ok) {
      return { ok: false, error: sendResult.error };
    }

    return {
      ok: true,
      notice: sendResult.message_id
        ? `Fundraising email sent via ${sendResult.provider} (message ${sendResult.message_id}).`
        : `Fundraising email queued via ${sendResult.provider} — accepted by the provider, delivery not yet confirmed.`,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

type PushToMainOutcome =
  | { gated: true; result: HandlerResult }
  | { gated: false; reason: string; target_verified: boolean };

async function loadRunTarget(
  agent_run_id: string | null,
): Promise<{
  full_name: string;
  mode: "umbrella" | "user_repo";
  remediation_attempt: number;
  customer_origin: boolean;
  run_payload: unknown;
  conductor_run_id: string;
}> {
  if (!agent_run_id)
    return {
      full_name: "",
      mode: "umbrella",
      remediation_attempt: 0,
      customer_origin: false,
      run_payload: null,
      conductor_run_id: "",
    };
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("payload")
    .eq("id", agent_run_id)
    .maybeSingle();
  if (error) {
    console.warn(
      `[dispatch-decision push_to_main] agent_runs payload read failed for ${agent_run_id}: ${error.message}`,
    );
    return {
      full_name: "",
      mode: "umbrella",
      remediation_attempt: 0,
      customer_origin: true,
      run_payload: null,
      conductor_run_id: "",
    };
  }
  const payload = (data as { payload?: unknown } | null)?.payload;
  const target =
    payload && typeof payload === "object"
      ? (payload as {
          target?: { github_full_name?: unknown; github_target_mode?: unknown };
        }).target
      : undefined;
  const full_name =
    typeof target?.github_full_name === "string" ? target.github_full_name.trim() : "";
  const rawMode =
    typeof target?.github_target_mode === "string" ? target.github_target_mode.trim() : "";
  const mode: "umbrella" | "user_repo" = rawMode === "user_repo" ? "user_repo" : "umbrella";
  const rawAttempt =
    payload && typeof payload === "object"
      ? (payload as { remediation_attempt?: unknown }).remediation_attempt
      : undefined;
  const remediation_attempt =
    typeof rawAttempt === "number" && Number.isInteger(rawAttempt) && rawAttempt > 0
      ? rawAttempt
      : 0;
  const pl =
    payload && typeof payload === "object"
      ? (payload as { customer_origin?: unknown; refine_mode?: unknown; repair_mode?: unknown })
      : {};
  const customer_origin =
    pl.customer_origin === true ||
    (pl.refine_mode === true && pl.repair_mode !== true);
  const rawConductorId =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)[BUILD_CONDUCTOR_RUN_ID_KEY]
      : undefined;
  const conductor_run_id = typeof rawConductorId === "string" ? rawConductorId.trim() : "";
  return { full_name, mode, remediation_attempt, customer_origin, conductor_run_id, run_payload: payload };
}

async function conductorStillAllowsPush(
  tenantId: string,
  conductorRunId: string,
): Promise<boolean> {
  if (!conductorRunId) return false;
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("status")
    .eq("id", conductorRunId)
    .eq("tenant_id", tenantId)
    .eq("kind", "build_app")
    .maybeSingle();
  if (error) throw new Error(`conductor status read failed: ${error.message}`);
  return (data as { status?: unknown } | null)?.status === "active";
}

async function runIsFreshBuildCodegen(tenantId: string, conductorRunId: string, agentRunId: string | null): Promise<boolean> {
  if (!conductorRunId || !agentRunId) return false;
  try {
    const { data, error } = await serviceClient()
      .from("conductor_runs")
      .select("kind, goal_graph")
      .eq("id", conductorRunId)
      .eq("tenant_id", tenantId)
      .eq("kind", "build_app")
      .maybeSingle();
    if (error || !data) return false;
    return isFreshBuildRun(data as { kind?: unknown; goal_graph?: unknown }, agentRunId);
  } catch {
    return false;
  }
}

async function stampCommitShaOnRun(
  agent_run_id: string,
  commit_sha: string,
): Promise<void> {
  try {
    const sb = serviceClient();
    const { data, error: readErr } = await sb
      .from("agent_runs")
      .select("parsed")
      .eq("id", agent_run_id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    const prev = (data as { parsed?: unknown } | null)?.parsed;
    const base =
      prev && typeof prev === "object" && !Array.isArray(prev)
        ? (prev as Record<string, unknown>)
        : {};
    const { error: updErr } = await sb
      .from("agent_runs")
      .update({ parsed: { ...base, commit_sha } })
      .eq("id", agent_run_id);
    if (updErr) throw new Error(updErr.message);
  } catch (e) {
    console.warn(
      `[dispatch-decision push_to_main] commit_sha stamp failed for run ${agent_run_id}: ${(e as Error).message} — push already landed; refine-undo falls back to branch-head lookup`,
    );
  }
}

async function tryPushToMain(
  d: DecisionRow,
  proposal: { repo: string; base_branch: string; title: string; files: unknown },
): Promise<PushToMainOutcome> {
  if (process.env.PRODUCT_BUILDER_ENABLED === "0") {
    return { gated: false, reason: "product_builder_disabled", target_verified: false };
  }
  const proposalRepo = (proposal.repo ?? "").trim();
  const {
    full_name: runTarget,
    mode: targetMode,
    remediation_attempt: runRemediationAttempt,
    run_payload: runPayload,
    conductor_run_id: conductorRunId,
  } = await loadRunTarget(d.agent_run_id);
  if (conductorRunId && !(await conductorStillAllowsPush(d.tenant_id, conductorRunId))) {
    return {
      gated: true,
      result: { ok: false, error: "build stopped before publication" },
    };
  }
  if (!runTarget) {
    return { gated: false, reason: "no payload.target.github_full_name on run", target_verified: false };
  }
  if (runTarget !== proposalRepo) {
    return {
      gated: false,
      reason: `proposal.repo (${proposalRepo}) != payload.target (${runTarget})`,
      target_verified: false,
    };
  }
  const gate =
    targetMode === "user_repo"
      ? await assertUserRepoTarget(d.tenant_id, proposalRepo)
      : await assertProvisionedRepoTarget(d.tenant_id, proposalRepo);
  if (!gate.ok) {
    return {
      gated: false,
      reason: `${targetMode === "user_repo" ? "user-repo" : "provisioned-repo"} gate: ${gate.reason}`,
      target_verified: false,
    };
  }
  {
    const pushPaths: string[] = [];
    for (const f of proposal.files as Array<{ path?: unknown }>) {
      const p = f && typeof f === "object" ? (f as { path?: unknown }).path : undefined;
      if (typeof p === "string" && p.trim().length > 0) pushPaths.push(p.trim());
    }
    const globs = await loadTenantProtectedGlobs(d.tenant_id);
    const siteRepo = await isVerifiedSiteRepoRun({
      tenant_id: d.tenant_id,
      repo_full_name: proposalRepo,
      payload: runPayload,
    });
    const rawStampHits = coerceProtectedPathHits(
      d.body && typeof d.body === "object"
        ? (d.body as { protected_paths?: unknown }).protected_paths
        : undefined,
    );
    const ownTarget = siteRepo || (targetMode === "umbrella" && !("site_id" in gate && gate.site_id));
    const freshGlobSet =
      ownTarget &&
      isFreshBuildCodegenPayload(runPayload) &&
      (await runIsFreshBuildCodegen(d.tenant_id, conductorRunId, d.agent_run_id))
        ? await loadTenantProtectedGlobSet(d.tenant_id)
        : null;
    const siteStampHits = siteRepo ? withoutSiteMigrationHits(rawStampHits) : rawStampHits;
    const stampHits = freshGlobSet ? withoutFreshAppHits(siteStampHits, freshGlobSet.app_globs) : siteStampHits;
    const recomputed = freshGlobSet
      ? freshAppProtectedPathHits(proposal.files as Array<{ path?: string; action?: string }>, freshGlobSet, { siteRepo })
      : siteRepo
        ? siteProtectedPathHits(proposal.files as Array<{ path?: string; action?: string }>, globs)
        : findProtectedPathHits(pushPaths, globs);
    const byPath = new Map<string, { path: string; glob: string }>();
    for (const h of [...recomputed, ...stampHits]) {
      if (!byPath.has(h.path)) byPath.set(h.path, h);
    }
    const hits = [...byPath.values()];
    if (hits.length > 0) {
      return {
        gated: false,
        reason: `protected_path: ${describeProtectedHits(hits)}`,
        target_verified: true,
      };
    }
  }
  const owner = proposalRepo.split("/")[0];
  const repoName = proposalRepo.split("/")[1];
  const files: Array<{ path: string; action: "create" | "modify" | "delete"; content?: string; encoding?: "base64" }> = [];
  let missingContent = "";
  for (const f of proposal.files as Array<{ path: string; action: "create" | "modify" | "delete"; content?: string; encoding?: "base64" }>) {
    if (f.action === "delete") {
      files.push({ path: f.path, action: "delete" });
      continue;
    }
    if (typeof f.content !== "string" || f.content.length === 0) {
      missingContent = f.path;
      break;
    }
    files.push({ path: f.path, action: f.action, content: f.content, ...(f.encoding ? { encoding: f.encoding } : {}) });
  }
  if (missingContent) {
    return {
      gated: true,
      result: { ok: false, error: `push_to_main needs_full_content: ${missingContent}` },
    };
  }
  if (conductorRunId && !(await conductorStillAllowsPush(d.tenant_id, conductorRunId))) {
    return {
      gated: true,
      result: { ok: false, error: "build stopped before publication" },
    };
  }
  const r = await callMcpTool(
    { tenant_id: d.tenant_id, run_id: d.agent_run_id ?? "" },
    "github",
    "push_to_main",
    {
      owner,
      repo: repoName,
      base_branch: proposal.base_branch || "main",
      title: proposal.title,
      files,
    },
  );
  if (r.is_error) {
    console.warn(
      `[dispatch-decision push_to_main] push did NOT land on ${proposalRepo} ` +
        `(decision ${d.id}, run ${d.agent_run_id ?? "n/a"}) — repo HEAD unchanged: ${r.content}`,
    );
    return { gated: true, result: { ok: false, error: r.content } };
  }
  let commit_sha = "";
  try {
    commit_sha = (JSON.parse(r.content) as { commit_sha?: string }).commit_sha ?? "";
  } catch {
  }
  if (d.agent_run_id && /^[0-9a-f]{7,40}$/i.test(commit_sha)) {
    await stampCommitShaOnRun(d.agent_run_id, commit_sha);
  }
  if (d.agent_run_id) {
    try {
      await inngest.send({
        name: "engineer.postdeploy.verify.requested",
        data: {
          tenant_id: d.tenant_id,
          agent_run_id: d.agent_run_id,
          repo: proposalRepo,
          commit_sha,
          remediation_attempt: runRemediationAttempt,
        },
      });
    } catch (e) {
      console.warn(
        `[dispatch-decision push_to_main] verify-event send failed for run ${d.agent_run_id}: ${(e as Error).message}`,
      );
    }
  }
  await requestTickForLandedPush(inngest, isActiveConductorRun, runPayload, d.tenant_id);
  return {
    gated: true,
    result: {
      ok: true,
      notice: `✅ Pushed to \`${proposalRepo}\` main${commit_sha ? ` (\`${commit_sha.slice(0, 7)}\`)` : ""}. Render is auto-deploying it.`,
    },
  };
}

async function loadFollowupTarget(
  agent_run_id: string | null,
  tenant_id: string,
): Promise<
  | { target_pr_number: number; checkout_ref: string; target_pr_repo: string }
  | "malformed"
  | null
> {
  if (!agent_run_id) return null;
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("payload")
    .eq("id", agent_run_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) {
    console.warn(
      `[dispatch-decision update_pr_branch] payload read failed for ${agent_run_id}: ${error.message}`,
    );
    return null;
  }
  const payload = (data as { payload?: unknown } | null)?.payload;
  if (!payload || typeof payload !== "object") return null;
  const pl = payload as {
    kind?: unknown;
    target_pr_number?: unknown;
    checkout_ref?: unknown;
    target_pr_repo?: unknown;
  };
  if (pl.kind !== "engineer_pr_followup") return null;
  const target_pr_number =
    typeof pl.target_pr_number === "number" && Number.isInteger(pl.target_pr_number)
      ? pl.target_pr_number
      : null;
  const checkout_ref =
    typeof pl.checkout_ref === "string" ? pl.checkout_ref.trim() : "";
  const target_pr_repo =
    typeof pl.target_pr_repo === "string" ? pl.target_pr_repo.trim() : "";
  if (target_pr_number === null || !checkout_ref || !target_pr_repo) return "malformed";
  return { target_pr_number, checkout_ref, target_pr_repo };
}

async function tryUpdatePrBranch(
  d: DecisionRow,
  proposal: { repo: string; head_branch: string; title: string; files: unknown },
): Promise<PushToMainOutcome> {
  const followup = await loadFollowupTarget(d.agent_run_id, d.tenant_id);
  if (followup === null) {
    return { gated: false, reason: "not an engineer_pr_followup run", target_verified: false };
  }
  const followupRefused = (reason: string): PushToMainOutcome => ({
    gated: true,
    result: { ok: false, error: `update_pr_branch refused (fail-closed): ${reason}` },
  });
  if (followup === "malformed") {
    return followupRefused(
      "engineer_pr_followup payload missing/invalid required field (target_pr_number / checkout_ref / target_pr_repo)",
    );
  }
  if (proposal.head_branch !== followup.checkout_ref) {
    return followupRefused(
      `proposal.head_branch (${proposal.head_branch}) != payload.checkout_ref (${followup.checkout_ref})`,
    );
  }
  if (proposal.repo.trim() !== followup.target_pr_repo) {
    return followupRefused(
      `proposal.repo (${proposal.repo}) != payload.target_pr_repo (${followup.target_pr_repo})`,
    );
  }
  const owner = proposal.repo.split("/")[0];
  const repoName = proposal.repo.split("/")[1];
  if (!owner || !repoName) {
    return followupRefused(`malformed repo: ${proposal.repo}`);
  }
  const listRes = await callMcpTool(
    { tenant_id: d.tenant_id, run_id: d.agent_run_id ?? "" },
    "github",
    "list_open_prs",
    { owner, repo: repoName },
  );
  if (listRes.is_error) {
    return followupRefused(`list_open_prs error: ${listRes.content}`);
  }
  let openPr: { number: number; head_branch: string } | undefined;
  try {
    const parsed = JSON.parse(listRes.content) as {
      prs?: Array<{ number: number; head_branch: string }>;
    };
    openPr = (parsed.prs ?? []).find((x) => x.number === followup.target_pr_number);
  } catch {
    return followupRefused("list_open_prs returned non-JSON");
  }
  if (!openPr) {
    return followupRefused(
      `PR #${followup.target_pr_number} not OPEN for ${proposal.repo} (this tenant)`,
    );
  }
  if (openPr.head_branch !== followup.checkout_ref) {
    return followupRefused(
      `PR #${followup.target_pr_number} live head (${openPr.head_branch}) != checkout_ref (${followup.checkout_ref})`,
    );
  }

  const files: Array<{ path: string; action: "create" | "modify" | "delete"; content?: string; encoding?: "base64" }> = [];
  let missingContent = "";
  for (const f of proposal.files as Array<{ path: string; action: "create" | "modify" | "delete"; content?: string; encoding?: "base64" }>) {
    if (f.action === "delete") {
      files.push({ path: f.path, action: "delete" });
      continue;
    }
    if (typeof f.content !== "string" || f.content.length === 0) {
      missingContent = f.path;
      break;
    }
    files.push({ path: f.path, action: f.action, content: f.content, ...(f.encoding ? { encoding: f.encoding } : {}) });
  }
  if (missingContent) {
    return {
      gated: true,
      result: { ok: false, error: `update_pr_branch needs_full_content: ${missingContent}` },
    };
  }
  const r = await callMcpTool(
    {
      tenant_id: d.tenant_id,
      run_id: d.agent_run_id ?? "",
      governed_dispatch: { decision_id: d.id, server_id: "github", tool_name: "update_pr_branch" },
    },
    "github",
    "update_pr_branch",
    {
      owner,
      repo: repoName,
      pull_number: followup.target_pr_number,
      head_branch: followup.checkout_ref,
      title: proposal.title,
      files,
    },
  );
  if (r.is_error) {
    return { gated: true, result: { ok: false, error: r.content } };
  }
  let no_change = false;
  let commit_sha = "";
  try {
    const parsed = JSON.parse(r.content) as { no_change?: boolean; commit_sha?: string | null };
    no_change = parsed.no_change === true;
    commit_sha = parsed.commit_sha ?? "";
  } catch {
  }
  const prUrl = `https://github.com/${proposal.repo}/pull/${followup.target_pr_number}`;
  return {
    gated: true,
    result: {
      ok: true,
      notice: no_change
        ? `No change to push — the follow-up produced no diff against \`${followup.checkout_ref}\`. PR ${prUrl} is unchanged.`
        : `✅ Pushed a follow-up commit${commit_sha ? ` (\`${commit_sha.slice(0, 7)}\`)` : ""} to \`${followup.checkout_ref}\` on the existing PR ${prUrl}.`,
    },
  };
}

async function recordPrOpenFailure(
  agent_run_id: string | null,
  detail: string,
): Promise<void> {
  if (!agent_run_id) return;
  try {
    const { error } = await serviceClient().rpc("agent_run_set_pr_state", {
      p_run_id: agent_run_id,
      p_state: "failed_to_open",
      p_detail: detail.slice(0, 500),
    });
    if (error) {
      console.warn(
        `[dispatch-decision github.open_pr] failed_to_open stamp failed for run ${agent_run_id}: ${error.message}`,
      );
    }
  } catch (e) {
    console.warn(
      `[dispatch-decision github.open_pr] failed_to_open stamp threw for run ${agent_run_id}: ${(e as Error).message}`,
    );
  }
}

const socialPublishV2Body = z.object({
  channel: z.string().min(1),
  payload: z.object({ text: z.string() }).passthrough(),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
});

function normaliseScheduledAt(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) && t > Date.now() ? v : null;
}

async function metaCampaignIsCbo(tenant_id: string, campaign_id: string): Promise<boolean> {
  const c = (await fbGet(tenant_id, campaign_id, {
    fields: "daily_budget,lifetime_budget",
  })) as { daily_budget?: string | null; lifetime_budget?: string | null };
  return detectCbo(c);
}

async function metaRaiseBudgetRefusal(tenant_id: string, ad_set_id: string): Promise<string | null> {
  const a = (await fbGet(tenant_id, ad_set_id, {
    fields: "campaign_id,lifetime_budget",
  })) as { campaign_id?: string; lifetime_budget?: string | null };
  if (Number(a.lifetime_budget ?? 0) > 0) return "lifetime_budget";
  if (!a.campaign_id) return "campaign_unknown";
  if (await metaCampaignIsCbo(tenant_id, a.campaign_id)) return "cbo_campaign_in_budget";
  return null;
}

async function googleBudgetRefusal(tenant_id: string, campaign_id: string | null): Promise<string | null> {
  const f = await gadsGetBudgetGuardFacts(tenant_id, campaign_id);
  if ((f.currency_code ?? "").toUpperCase() !== "USD") return "non_usd_account";
  if (campaign_id !== null && f.budget_period !== "DAILY") return "non_daily_budget";
  return null;
}

const NO_AD_BUDGET_HOLD: AdSpendHold = { status: "no_budget" };

async function logAdGeoChange(d: { id: string; tenant_id: string; decision_class?: string }, platform: "google" | "meta", outcome: string, e?: unknown): Promise<void> {
  try {
    const { logEvent } = await import("@/services/logging/logEvent");
    await logEvent({
      level: outcome === "refused" ? "warn" : "info",
      source: "ad-locations",
      code: `ad_locations.${outcome}`,
      tenant_id: d.tenant_id,
      ...(e !== undefined ? { error: e } : {}),
      meta: { platform, decision_class: d.decision_class ?? null, ...(e instanceof ExpectedToolError ? { error_class: e.code } : {}) },
    });
  } catch {
  }
}

function xAdsHandler(fn: "executeXSetStatus" | "executeXUpdateCampaign" | "executeXCreateCampaign"): Handler {
  return async (d) => (await import("@/services/connectors/x-ads/execute"))[fn]({ id: d.id, exec_source: adChangeFrom(d).table, agent_run_id: d.agent_run_id, decision_class: d.decision_class, tenant_id: d.tenant_id, body: d.body, approved_by: d.approved_by, approved_by_source: d.approved_by_source });
}

const linkedinHandler = (run: (d: DecisionRow) => Promise<HandlerResult>) => async (d: DecisionRow) => {
  const { linkedinApproverRefusal } = await import("@/services/tools/linkedin-ads/_approver-role");
  const refusal = await linkedinApproverRefusal({ tenant_id: d.tenant_id, exec_class: d.decision_class, body: d.body, approved_by: d.approved_by, approved_by_source: d.approved_by_source });
  if (refusal) return refusal;
  return run(d);
};

const HANDLERS: Record<string, Handler> = {
  "composio.execute_tool": async (d) => {
    const { executeApprovedComposioWrite } = await import("@/services/connectors/composio/execute-approved");
    return executeApprovedComposioWrite({ id: d.id, tenant_id: d.tenant_id, decision_class: d.decision_class, body: d.body, approved_by: d.approved_by, approved_by_source: d.approved_by_source });
  },
  "reddit_ads.authorize_account": async (d) => (await import("@/services/connectors/reddit-ads/execute")).executeRedditAction(d),
  "reddit_ads.prepare_campaign": async (d) => (await import("@/services/connectors/reddit-ads/execute")).executeRedditAction(d),
  "reddit_ads.launch_campaign": async (d) => (await import("@/services/connectors/reddit-ads/execute")).executeRedditAction(d),
  "reddit_ads.update_budget": async (d) => (await import("@/services/connectors/reddit-ads/execute")).executeRedditAction(d),
  "reddit_ads.update_targeting": async (d) => (await import("@/services/connectors/reddit-ads/execute")).executeRedditAction(d),
  "reddit_ads.update_ad": async (d) => (await import("@/services/connectors/reddit-ads/execute")).executeRedditAction(d),
  "reddit_ads.replace_creative": async (d) => (await import("@/services/connectors/reddit-ads/execute")).executeRedditAction(d),
  "reddit_ads.set_object_status": async (d) => (await import("@/services/connectors/reddit-ads/execute")).executeRedditAction(d),
  "reddit_ads.rename_object": async (d) => (await import("@/services/connectors/reddit-ads/execute")).executeRedditAction(d),
  "reddit_ads.remove_object": async (d) => (await import("@/services/connectors/reddit-ads/execute")).executeRedditAction(d),
  "reddit_ads.set_status": async (d) => {
    const { executeRedditPause } = await import("@/services/connectors/reddit-ads/execute-pause");
    return executeRedditPause({ tenant_id: d.tenant_id, body: d.body });
  },
  "tiktok_ads.update_budget": async (d) => (await import("@/services/connectors/tiktok-ads/execute")).executeTiktokAction({ id: d.id, tenant_id: d.tenant_id, body: d.body, decision_class: d.decision_class, approved_by: d.approved_by, approved_by_source: d.approved_by_source, exec_source: adChangeFrom(d).table, agent_run_id: d.agent_run_id }),
  "tiktok_ads.update_settings": async (d) => (await import("@/services/connectors/tiktok-ads/campaign-settings")).executeTiktokSettings({ id: d.id, tenant_id: d.tenant_id, body: d.body, decision_class: d.decision_class, approved_by: d.approved_by, approved_by_source: d.approved_by_source, exec_source: adChangeFrom(d).table, agent_run_id: d.agent_run_id }),
  "tiktok_ads.set_status": async (d) => (await import("@/services/connectors/tiktok-ads/execute")).executeTiktokAction({ id: d.id, tenant_id: d.tenant_id, body: d.body, decision_class: d.decision_class, approved_by: d.approved_by, approved_by_source: d.approved_by_source, exec_source: adChangeFrom(d).table, agent_run_id: d.agent_run_id, ...((d as { test_stop_pause?: true }).test_stop_pause ? { test_stop_pause: true as const } : {}) }),
  "tiktok_ads.create_launch": async (d) => (await import("@/services/connectors/tiktok-ads/launch-execute")).executeTiktokLaunch({ id: d.id, tenant_id: d.tenant_id, body: d.body, decision_class: d.decision_class, approved_by: d.approved_by, approved_by_source: d.approved_by_source, exec_source: adChangeFrom(d).table, agent_run_id: d.agent_run_id }),
  "x_ads.set_status": xAdsHandler("executeXSetStatus"),
  "x_ads.update_campaign": xAdsHandler("executeXUpdateCampaign"),
  "x_ads.create_campaign": xAdsHandler("executeXCreateCampaign"),
  "x_ads.manage_objects": async d => (await import("@/services/connectors/x-ads/management")).executeXManageObjects(d),
  "email_campaign.create_and_send": async (d) => {
    const pausedRefusal = await emailPausedRefusal(d.tenant_id);
    if (pausedRefusal) return pausedRefusal;
    const { executeEmailCampaignSendAndTell } = await import("@/services/connectors/email-campaign/execute-send");
    const row = d as DecisionRow & { exec_source?: "channel_actions"; claim_id?: string };
    return executeEmailCampaignSendAndTell({
      id: d.id,
      tenant_id: d.tenant_id,
      body: d.body,
      approved_by_source: d.approved_by_source,
      exec_source: row.exec_source,
      claim_id: row.claim_id,
    });
  },
  "linkedin_ads.set_status": linkedinHandler(async (d) => {
    const { executeLinkedInPause } = await import("@/services/connectors/linkedin-ads/execute-pause");
    return executeLinkedInPause({ tenant_id: d.tenant_id, body: d.body, id: d.id });
  }),
  "linkedin_ads.resume_campaign": linkedinHandler(async (d) => (await import("@/services/connectors/linkedin-ads/execute-change")).executeLinkedInResume(d)),
  "linkedin_ads.update_campaign_budget": linkedinHandler(async (d) => (await import("@/services/connectors/linkedin-ads/execute-change")).executeLinkedInBudgetChange(d)),
  "linkedin_ads.update_targeting": linkedinHandler(async (d) => (await import("@/services/connectors/linkedin-ads/execute-change")).executeLinkedInTargetingChange(d)),
  "linkedin_ads.update_campaign": linkedinHandler(async (d) => (await import("@/services/connectors/linkedin-ads/execute-cards")).executeLinkedInCampaignEdit(d)),
  "linkedin_ads.update_campaign_group": linkedinHandler(async (d) => (await import("@/services/connectors/linkedin-ads/execute-cards")).executeLinkedInGroupEdit(d)),
  "linkedin_ads.archive": linkedinHandler(async (d) => (await import("@/services/connectors/linkedin-ads/execute-cards")).executeLinkedInArchive(d)),
  "linkedin_ads.set_ad_status": linkedinHandler(async (d) => (await import("@/services/connectors/linkedin-ads/execute-cards")).executeLinkedInAdStatus(d)),
  "linkedin_ads.create_ad": linkedinHandler(async (d) => (await import("@/services/connectors/linkedin-ads/execute-cards")).executeLinkedInCreateAd(d)),
  "linkedin_ads.swap_ad": linkedinHandler(async (d) => (await import("@/services/connectors/linkedin-ads/execute-cards")).executeLinkedInSwapAd(d)),
  "linkedin_ads.create_campaign": linkedinHandler(async (d) => (await import("@/services/connectors/linkedin-ads/execute-cards")).executeLinkedInCreateCampaign(d)),
  "linkedin_ads.duplicate": linkedinHandler(async (d) => (await import("@/services/connectors/linkedin-ads/execute-cards")).executeLinkedInDuplicate(d)),
  "generated_video.render.v1": async (d) => {
    const { startGeneratedVideoRender } = await import("@/services/channels/generated-video-render");
    return startGeneratedVideoRender(d as unknown as import("@/services/channels/generated-video-render").RenderRow);
  },
  "seo.create_pr.v1": async (d) => {
    const { startSeoPullRequest } = await import("@/services/channels/seo-open-pr");
    return startSeoPullRequest(d as unknown as import("@/services/channels/site-pr").SitePrRow);
  },
  "geo.create_pr.v1": async (d) => {
    const { startGeoPullRequest } = await import("@/services/channels/geo-open-pr");
    return startGeoPullRequest(d as unknown as import("@/services/channels/site-pr").SitePrRow);
  },
  "creator.hire": async (d) => {
    const { approveCreatorHire } = await import("@/services/creators/hire-approve");
    return approveCreatorHire(d as unknown as import("@/services/creators/hire-approve").CreatorHireRow);
  },
  "linkedin_ads.launch_campaign": async (d) => (await import("@/services/ads-wallet/linkedin-growth")).executeLinkedinGrowthLaunch(d),
  "chatgpt_ads.create_and_launch": async (d) => (await import("@/services/connectors/chatgpt-ads/growth-execution")).executeChatgptGrowthAction(d),
  "chatgpt_ads.update_campaign_budget": async (d) => (await import("@/services/connectors/chatgpt-ads/growth-execution")).executeChatgptGrowthAction(d),
  "chatgpt_ads.set_status": async (d) => (await import("@/services/connectors/chatgpt-ads/growth-execution")).executeChatgptGrowthAction(d),
  "chatgpt_ads.create_campaign_bundle": async (d) => {
    const { executeCampaignAction } = await import("@/services/connectors/chatgpt-ads/action-execution");
    return executeCampaignAction(d.id, d.tenant_id, d.approved_by_source === "cgo" ? null : (d.approved_by ?? null));
  },
  "linkedin_ads.create_campaign_bundle": async (d) => {
    const { executeLinkedInCampaignAction } = await import("@/services/connectors/linkedin-ads/action-execution");
    return executeLinkedInCampaignAction(d.id, d.tenant_id, d.approved_by_source === "cgo" ? null : (d.approved_by ?? null), d.claim_id);
  },
  "memory.write_meeting_atoms": async (d) => {
    const { writeMeetingAtomsToBrain } = await import("@/services/meetings/write-atoms");
    const r = await writeMeetingAtomsToBrain(serviceClient(), d.tenant_id, d.body, { approvedBy: "operator" });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, notice: `✅ Saved ${r.written} standup fact(s) to the company brain.` };
  },

  "slack.post_message": async (d) => {
    const args = d.body as { channel_id?: string; text?: string };
    if (!args.channel_id || !args.text) {
      return { ok: false, error: "slack.post_message requires {channel_id, text}" };
    }
    let text = args.text;
    try {
      const { data: appRow } = await serviceClient()
        .from("decisions")
        .select("approved_by, approved_by_source")
        .eq("id", d.id)
        .maybeSingle<{ approved_by: string | null; approved_by_source: string | null }>();
      text = await withApprovedByFooter(
        serviceClient(),
        d.tenant_id,
        appRow?.approved_by ?? null,
        args.text,
        appRow?.approved_by_source ?? null,
      );
    } catch {
    }
    const r = await callMcpTool(
      { tenant_id: d.tenant_id, run_id: d.agent_run_id ?? "" },
      "slack",
      "post_message",
      { ...args, text },
    );
    return {
      ok: !r.is_error,
      error: r.is_error ? r.content : undefined,
      notice: r.is_error ? undefined : "✅ Posted your message to Slack.",
    };
  },

  "social.publish": async (d) => {
    const body = (d.body ?? {}) as {
      channel_id?: unknown;
      text?: unknown;
      caption?: unknown;
      rendered_markdown?: unknown;
    };
    const channel_id =
      typeof body.channel_id === "string" && body.channel_id.length > 0
        ? body.channel_id
        : null;
    const text =
      (typeof body.text === "string" && body.text.length > 0 && body.text) ||
      (typeof body.caption === "string" && body.caption.length > 0 && body.caption) ||
      (typeof body.rendered_markdown === "string" &&
        body.rendered_markdown.length > 0 &&
        body.rendered_markdown) ||
      null;
    if (!channel_id || !text) {
      return {
        ok: false,
        error:
          "social.publish requires a publish target — {channel_id} and post {text|caption|rendered_markdown}. The drafted post had no resolved channel; connect a social account and re-approve.",
      };
    }
    const refused = checkPublishText(text);
    if (refused) return { ok: false, error: refused.message };
    const r = await callMcpTool(
      { tenant_id: d.tenant_id, run_id: d.agent_run_id ?? "" },
      "slack",
      "post_message",
      { channel_id, text: text.slice(0, 39000) },
    );
    return {
      ok: !r.is_error,
      error: r.is_error ? r.content : undefined,
      notice: r.is_error ? undefined : "✅ Published your social post.",
    };
  },

  "social.publish.v2": async (d) => {
    const parsed = socialPublishV2Body.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: "social.publish.v2 requires {channel, payload, scheduled_at?: ISO-8601|null}",
      };
    }
    const body = parsed.data;
    const scheduledAt = normaliseScheduledAt(body.scheduled_at);

    const planRefusal = await refuseIfSocialPostPlanLocked(d.tenant_id, body.channel);
    if (planRefusal) return { ok: false, error: planRefusal.message };

    const gate = await socialPublishGate(serviceClient(), d.tenant_id);
    if (!gate.open) {
      return {
        ok: false,
        code: "social_publish_paused",
        error: "Social publishing isn't enabled for your account yet.",
      };
    }

    let action: ReturnType<typeof resolveChannelAction>;
    try {
      action = resolveChannelAction(body.channel);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    let validated: SocialPayload;
    try {
      validated = validateChannelPayload(body.channel, body.payload);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    const refused = checkPublishText(validated);
    if (refused) return { ok: false, error: refused.message };

    let accountId: string;
    let transport: SocialPublishTransport;
    try {
      const resolved = await resolveSocialPublishAccount(d.tenant_id, body.channel);
      accountId = resolved.accountId;
      transport = resolved.transport;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    let destRowId: string | null = null;
    let destUrn: string | undefined;
    if (action.destination_required) {
      const { data: destRows } = await serviceClient()
        .from("social_destinations")
        .select("id, destination_id")
        .eq("tenant_id", d.tenant_id)
        .eq("channel", body.channel)
        .eq("account_id", accountId)
        .in("role_verified", ["ADMIN", "CONTENT"])
        .order("last_verified_at", { ascending: false, nullsFirst: false })
        .limit(2);
      if (!destRows || destRows.length === 0) {
        return {
          ok: false,
          error: `unauthorized_destination — no verified destination for ${body.channel}`,
        };
      }
      if (destRows.length > 1) {
        return {
          ok: false,
          error: `multiple ${body.channel} destinations connected; destination picker is P1`,
        };
      }
      const dest = destRows[0];
      destRowId = dest.id as string;
      destUrn = dest.destination_id as string;
    }

    const configured_props = buildConfiguredProps(
      body.channel,
      validated,
      destUrn,
    );

    const snapshot = {
      channel: body.channel,
      payload: validated,
      account_id: accountId,
      destination_id: destRowId,
      scheduled_at: scheduledAt,
    };
    const snapshot_hash = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    const idempotency_key = createHash("sha256")
      .update(`${d.id}:${body.channel}:${accountId}`)
      .digest("hex");

    const { data: createdId, error: createErr } = await serviceClient().rpc(
      "social_post_create",
      {
        p_tenant_id: d.tenant_id,
        p_decision_id: d.id,
        p_agent_run_id: d.agent_run_id ?? null,
        p_channel: body.channel,
        p_app_slug: action.app_slug,
        p_action_id: action.action_id,
        p_account_id: accountId,
        p_destination_id: destRowId,
        p_configured_props: configured_props,
        p_snapshot: snapshot,
        p_snapshot_hash: snapshot_hash,
        p_scheduled_at: scheduledAt,
        p_idempotency_key: idempotency_key,
        p_transport: transport,
      },
    );
    if (createErr) {
      return {
        ok: false,
        error: `social_post_create failed: ${createErr.message}`,
      };
    }

    let postId = (createdId as string | null) ?? null;
    if (!postId) {
      const { data: existing } = await serviceClient()
        .from("social_posts")
        .select("id, status")
        .eq("tenant_id", d.tenant_id)
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();
      if (!existing) {
        return {
          ok: false,
          error: "social_post_create returned null but no existing post found",
        };
      }
      if (existing.status === "publishing" || existing.status === "published") {
        return {
          ok: true,
          notice: `✅ This ${body.channel} post is already queued for publish.`,
        };
      }
      postId = existing.id as string;
    }

    await inngest.send({
      name: "social/publish.requested",
      data: {
        post_id: postId,
        tenant_id: d.tenant_id,
        agent_run_id: d.agent_run_id ?? null,
      },
    });

    return {
      ok: true,
      notice: scheduledAt
        ? `✅ Scheduled ${body.channel} post for ${new Date(scheduledAt).toUTCString()} — you'll get a Slack note when it's live.`
        : `✅ Queued ${body.channel} post for immediate publish — you'll get a Slack note when it's live.`,
    };
  },

  "jira.create_issue": async (d) => {
    const parsed = jiraCreateBody.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `jira.create_issue body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    try {
      const r = await jiraCreateIssue(d.tenant_id, parsed.data);
      await recordTicketLedger(d, "jira", r.key);
      return {
        ok: !!r.key,
        error: r.key ? undefined : "jira create returned no key",
        notice: r.key ? `✅ Created Jira issue \`${r.key}\`.` : undefined,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  "jira.add_comment": async (d) => {
    const parsed = jiraCommentBody.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `jira.add_comment body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    try {
      await jiraAddComment(d.tenant_id, parsed.data, { agentAuto: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  "linear.create_issue": async (d) => {
    const parsed = linearCreateBody.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `linear.create_issue body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    try {
      const r = await linearCreateIssue(d.tenant_id, parsed.data);
      await recordTicketLedger(d, "linear", r.id);
      return {
        ok: !!r.id,
        error: r.id ? undefined : "linear create returned no id",
        notice: r.id ? `✅ Created the Linear issue "${parsed.data.title}".` : undefined,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  "linear.add_comment": async (d) => {
    const parsed = linearCommentBody.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `linear.add_comment body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    try {
      await linearAddComment(d.tenant_id, parsed.data, { agentAuto: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "email.send": handleEmailSend,
  "gmail.send": handleEmailSend,

  "outbound.send": handleOutboundSend,

  "bulk_outbound.send": handleBulkOutboundSend,

  "fundraising.outbound.send": handleFundraisingOutboundSend,

  "github.open_pr": async (d) => {
    const wantsRelaxed =
      process.env.PRODUCT_BUILDER_ENABLED !== "0" &&
      d.body !== null &&
      typeof d.body === "object" &&
      ((d.body as { push_to_main?: unknown }).push_to_main === true ||
        (d.body as { defer_pr?: unknown }).defer_pr === true);
    const schema = wantsRelaxed ? prProposalProductBuildSchema : prProposalSchema;
    const proposal = schema.safeParse(d.body);
    if (!proposal.success) {
      const reason = `pr_proposal validation failed: ${proposal.error.issues.map((i) => i.message).join("; ")}`;
      await recordPrOpenFailure(d.agent_run_id, reason);
      return { ok: false, error: reason };
    }
    const p = proposal.data;
    if ((p as { defer_pr?: unknown }).defer_pr === true) {
      if ((d.body as { live_edit_draft?: unknown }).live_edit_draft === true) {
        return {
          ok: true,
          notice: "Live edit: change saved to the draft; it goes live when the founder presses Publish.",
        };
      }
      return {
        ok: true,
        notice:
          "Refine gate: change staged on a review branch; the PR opens with build/test + preview evidence after the gate runs.",
      };
    }
    if (p.push_to_main === true) {
      const outcome = await tryPushToMain(d, {
        repo: p.repo,
        base_branch: p.base_branch,
        title: p.title,
        files: p.files,
      });
      if (outcome.gated) {
        if (outcome.result.ok && Array.isArray(p.files)) {
          await recordMetricsDeclaration(d.tenant_id, p.files as PushedFile[]);
        }
        return outcome.result;
      }
      if (outcome.target_verified) {
        await alert({
          msg:
            `product build will NOT auto-deploy — push_to_main refused after the ` +
            `provisioned-target gate passed. decision=${d.id} ` +
            `run=${d.agent_run_id ?? "n/a"} repo=${p.repo} reason=${outcome.reason}. ` +
            `Falling back to open_pr; if that fails the generated app is stranded on a ` +
            `branch while main keeps serving the seed.`,
          source: "dispatch-decision",
          code: "product_build_push_refused",
          tenant_id: d.tenant_id,
        });
      }
      console.warn(
        `[dispatch-decision github.open_pr] push_to_main refused (${outcome.reason}) for decision ${d.id} repo=${p.repo} — falling back to open_pr`,
      );
    }
    if (p.push_to_main !== true) {
      const followupOutcome = await tryUpdatePrBranch(d, {
        repo: p.repo,
        head_branch: p.head_branch,
        title: p.title,
        files: p.files,
      });
      if (followupOutcome.gated) {
        return followupOutcome.result;
      }
      if (followupOutcome.reason !== "not an engineer_pr_followup run") {
        console.warn(
          `[dispatch-decision github.open_pr] follow-up branch-update refused (${followupOutcome.reason}) for decision ${d.id} repo=${p.repo} — falling back to open_pr`,
        );
      }
    }
    const perBase = (p.per_base_files ?? {}) as Record<string, typeof p.files>;
    const rawBases =
      Array.isArray(p.base_branches) && p.base_branches.length > 0
        ? p.base_branches
        : [p.base_branch];
    const bases = [...new Set(rawBases)];
    const multi = bases.length > 1;
    const owner = p.repo.split("/")[0];
    const repoName = p.repo.split("/")[1];

    type PrResult = {
      base: string;
      ok: boolean;
      pr_url?: string;
      pr_number?: number | null;
      head_branch?: string;
      error?: string;
    };
    const results: PrResult[] = [];
    for (const base of bases) {
      const srcFiles = perBase[base] ?? p.files;
      const files: Array<{ path: string; action: "create" | "modify" | "delete"; content?: string; encoding?: "base64" }> = [];
      let missingContent = "";
      for (const f of srcFiles) {
        if (f.action === "delete") {
          files.push({ path: f.path, action: "delete" });
          continue;
        }
        if (typeof f.content !== "string" || f.content.length === 0) {
          missingContent = f.path;
          break;
        }
        files.push({ path: f.path, action: f.action, content: f.content, ...(f.encoding ? { encoding: f.encoding } : {}) });
      }
      if (missingContent) {
        results.push({ base, ok: false, error: `needs_full_content: ${missingContent}` });
        continue;
      }
      let headForBase = p.head_branch;
      if (multi) {
        const slug = base.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
        headForBase = `${p.head_branch.slice(0, 120 - slug.length - 1)}-${slug}`;
      }
      const r = await callMcpTool(
        {
          tenant_id: d.tenant_id,
          run_id: d.agent_run_id ?? "",
          governed_dispatch: { decision_id: d.id, server_id: "github", tool_name: "open_pr" },
        },
        "github",
        "open_pr",
        {
          owner,
          repo: repoName,
          base_branch: base,
          head_branch: headForBase,
          title: p.title,
          body: stripLegacyCriticNotes(p.body),
          files,
          ...(typeof (d.body as { expected_base_sha?: unknown }).expected_base_sha === "string" ? { expected_base_sha: (d.body as { expected_base_sha: string }).expected_base_sha } : {}),
        },
      );
      if (r.is_error) {
        if (/branch_exists|already exists|reference already exists/i.test(r.content)) {
          let existingNumber: number | null = null;
          try {
            const listRes = await callMcpTool(
              { tenant_id: d.tenant_id, run_id: d.agent_run_id ?? "" },
              "github",
              "list_open_prs",
              { owner, repo: repoName },
            );
            if (!listRes.is_error) {
              const parsedList = JSON.parse(listRes.content) as {
                prs?: Array<{ number?: number; head_branch?: string }>;
              };
              const match = (parsedList.prs ?? []).find(
                (pr) => pr.head_branch === headForBase,
              );
              if (typeof match?.number === "number") existingNumber = match.number;
            }
          } catch {
          }
          if (existingNumber != null) {
            results.push({
              base,
              ok: true,
              pr_url: `https://github.com/${p.repo}/pull/${existingNumber}`,
              pr_number: existingNumber,
              head_branch: headForBase,
              error: "already_open",
            });
          } else {
            results.push({ base, ok: true, error: "already_open" });
          }
        } else {
          results.push({ base, ok: false, error: r.content });
        }
        continue;
      }
      let pr_url = "";
      let pr_number: number | null = null;
      try {
        const parsed = JSON.parse(r.content) as {
          url?: string;
          html_url?: string;
          number?: number;
        };
        pr_url = parsed.url ?? parsed.html_url ?? "";
        pr_number = parsed.number ?? null;
      } catch {
      }
      if (!pr_url && pr_number != null) {
        pr_url = `https://github.com/${p.repo}/pull/${pr_number}`;
      }
      if (!pr_url) {
        await logEvent({
          level: "warn",
          source: "github.open_pr",
          code: "open_pr_result_missing_url",
          tenant_id: d.tenant_id,
          run_id: d.agent_run_id,
          message: `fresh open returned no url/number for decision ${d.id} repo ${p.repo} base ${base}`,
          meta: { tool_name: "github.open_pr" },
        });
      }
      results.push({ base, ok: true, pr_url, pr_number, head_branch: headForBase });
    }

    const firstOk = results.find((x) => x.ok && x.pr_url);
    if (d.agent_run_id && firstOk?.pr_url) {
      const { error: updErr } = await serviceClient().rpc("agent_run_set_pr_meta", {
        p_run_id: d.agent_run_id,
        p_pr_url: firstOk.pr_url,
        p_pr_repo: p.repo,
        p_pr_number: firstOk.pr_number ?? null,
        p_pr_head_branch: firstOk.head_branch ?? null,
      });
      if (updErr) {
        console.warn(
          `[dispatch-decision github.open_pr] pr_url writeback failed for run ${d.agent_run_id}: ${updErr.message}`,
        );
        await logEvent({
          level: "warn",
          source: "github.open_pr",
          code: "pr_meta_writeback_failed",
          tenant_id: d.tenant_id,
          run_id: d.agent_run_id,
          message: updErr.message,
          meta: { tool_name: "github.open_pr" },
        });
      }

      try {
        const { data: runRow } = await serviceClient()
          .from("agent_runs")
          .select("agent_slug, payload")
          .eq("id", d.agent_run_id)
          .maybeSingle();
        const run = runRow as
          | { agent_slug?: string; payload?: { task_description?: unknown } | null }
          | null;
        if (run?.agent_slug === "engineer") {
          const originText =
            typeof run.payload?.task_description === "string"
              ? run.payload.task_description
              : "";
          if (originText) {
            await postTrackerPrComment({
              tenant_id: d.tenant_id,
              originText,
              pr_url: firstOk.pr_url,
              event: "opened",
            });
          }
        }
      } catch (e) {
        console.warn(
          `[dispatch-decision github.open_pr] tracker PR-open comment skipped for run ${d.agent_run_id}: ${(e as Error).message}`,
        );
      }
    }

    const failures = results.filter((x) => !x.ok);
    if (failures.length === results.length) {
      const reason = failures.map((x) => `${x.base}: ${x.error}`).join("; ");
      await recordPrOpenFailure(d.agent_run_id, reason);
      await logEvent({
        level: "error",
        source: "github.open_pr",
        code: "pr_open_failed_all_bases",
        tenant_id: d.tenant_id,
        run_id: d.agent_run_id,
        message: `decision ${d.id} repo ${p.repo}: ${reason}`.slice(0, 500),
        meta: { tool_name: "github.open_pr" },
      });
      return { ok: false, error: reason };
    }
    if (failures.length > 0) {
      console.warn(
        `[dispatch-decision github.open_pr] partial fan-out: opened ${
          results.length - failures.length
        }/${results.length}; failed → ${failures
          .map((x) => `${x.base}: ${x.error}`)
          .join("; ")}`,
      );
    }
    let supersededPrNumber: number | undefined;
    let verify = resolveOpenPrVerify(d.body);
    if (d.agent_run_id) {
      try {
        const { data: srRow } = await serviceClient()
          .from("agent_runs")
          .select("payload, parsed")
          .eq("id", d.agent_run_id)
          .eq("tenant_id", d.tenant_id)
          .maybeSingle();
        const sp = (srRow as { payload?: { superseded_pr_number?: unknown } | null } | null)
          ?.payload?.superseded_pr_number;
        if (typeof sp === "number") supersededPrNumber = sp;
        if (!verify) {
          verify = resolveOpenPrVerify((srRow as { parsed?: unknown } | null)?.parsed);
        }
      } catch {
      }
    }
    const firstOpenedPr = results.find((r) => r.ok && r.pr_url);
    return {
      ok: true,
      notice: buildOpenPrNotice(results, {
        repo: p.repo,
        title: p.title,
        head_branch: p.head_branch,
        supersededPrNumber,
        verify,
      }),
      pr: firstOpenedPr?.pr_url
        ? { url: firstOpenedPr.pr_url, number: firstOpenedPr.pr_number ?? null, repo: p.repo }
        : undefined,
      verify,
    };
  },
  "github.post_review": async (d) => {
    const args = d.body as {
      owner?: string;
      repo?: string;
      pull_number?: number;
      body?: string;
      event?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    };
    if (!args.owner || !args.repo || !args.pull_number || !args.body) {
      return {
        ok: false,
        error: "github.post_review requires {owner, repo, pull_number, body}",
      };
    }
    const r = await callMcpTool(
      { tenant_id: d.tenant_id, run_id: d.agent_run_id ?? "" },
      "github",
      "post_review",
      args,
    );
    return { ok: !r.is_error, error: r.is_error ? r.content : undefined };
  },
  "github.request_changes": async (d) => {
    const args = d.body as {
      owner?: string;
      repo?: string;
      pull_number?: number;
      body?: string;
    };
    if (!args.owner || !args.repo || !args.pull_number || !args.body) {
      return {
        ok: false,
        error: "github.request_changes requires {owner, repo, pull_number, body}",
      };
    }
    const r = await callMcpTool(
      { tenant_id: d.tenant_id, run_id: d.agent_run_id ?? "" },
      "github",
      "request_changes",
      args,
    );
    return { ok: !r.is_error, error: r.is_error ? r.content : undefined };
  },
  "github.merge_pr": async (d) => {
    const args = d.body as {
      owner?: string;
      repo?: string;
      pull_number?: number;
      commit_title?: string;
      commit_message?: string;
    };
    if (!args.owner || !args.repo || !args.pull_number || !args.commit_title) {
      return {
        ok: false,
        error: "github.merge_pr requires {owner, repo, pull_number, commit_title}",
      };
    }
    const status = await callMcpTool(
      { tenant_id: d.tenant_id, run_id: d.agent_run_id ?? "" },
      "github",
      "list_pr_status",
      { owner: args.owner, repo: args.repo, pull_number: args.pull_number },
    );
    if (status.is_error) {
      return { ok: false, error: `merge_gate_failed: status check errored — ${status.content}` };
    }
    const parsed = JSON.parse(status.content) as {
      checks_green: boolean;
      checks_total: number;
      approving_reviews: number;
    };
    if (!parsed.checks_green) {
      return {
        ok: false,
        error: `merge_gate_failed: CI not green (checks_total=${parsed.checks_total})`,
      };
    }
    if (parsed.approving_reviews < 1) {
      return {
        ok: false,
        error: `merge_gate_failed: approving_reviews=${parsed.approving_reviews} < 1`,
      };
    }
    const r = await callMcpTool(
      {
        tenant_id: d.tenant_id,
        run_id: d.agent_run_id ?? "",
        governed_dispatch: { decision_id: d.id, server_id: "github", tool_name: "squash_merge" },
      },
      "github",
      "squash_merge",
      args,
    );
    return {
      ok: !r.is_error,
      error: r.is_error ? r.content : undefined,
      notice: r.is_error
        ? undefined
        : `✅ Merged ${args.owner}/${args.repo}#${args.pull_number}.`,
    };
  },

  "stripe.create_payment": async (d) => {
    if (!moneyCardSealIntact(d.decision_class, d.body)) {
      return { ok: false, error: "stale_card: the charge no longer matches the card that was approved; nothing was charged" };
    }
    const b = d.body;
    try {
      const result = (await createPaymentTool.execute(
        {
          tenant_id: d.tenant_id,
          log: (msg: string) => console.log(`[stripe.create_payment] ${msg}`),
          run_id: d.agent_run_id ?? undefined,
        },
        {
          amount: b.amount,
          currency: b.currency,
          application_fee_amount: b.application_fee_amount,
          client_reference: b.client_reference,
          ...(typeof b.description === "string" ? { description: b.description } : {}),
          ...(typeof b.receipt_email === "string" ? { receipt_email: b.receipt_email } : {}),
        },
      )) as { payment_intent_id?: string; status?: string } | undefined;
      return {
        ok: true,
        notice: `✅ Created the charge for \`${String(b.client_reference)}\`${result?.status ? ` (${result.status})` : ""}.`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  "stripe.remit_to_tenant": async (d) => {
    if (!moneyCardSealIntact(d.decision_class, d.body)) {
      return { ok: false, error: "stale_card: the payout no longer matches the card that was approved; nothing was paid out" };
    }
    const b = d.body;
    const ref = String(b.client_reference);
    let row;
    try {
      row = await findHeldFundByRef(d.tenant_id, ref);
    } catch (e) {
      return { ok: false, error: `could not read the held collection for ${ref}: ${(e as Error).message}` };
    }
    if (
      !row ||
      row.status !== "held" ||
      row.id !== b.held_fund_id ||
      row.currency !== b.currency ||
      row.amount_minor !== b.gross_minor ||
      row.reserve_held_minor !== b.reserve_minor ||
      row.platform_fee_minor !== b.fee_minor
    ) {
      return { ok: false, error: `stale_card: the held collection for ${ref} changed since the card was approved; nothing was paid out` };
    }
    try {
      await remitToTenantTool.execute(
        {
          tenant_id: d.tenant_id,
          log: (msg: string) => console.log(`[stripe.remit_to_tenant] ${msg}`),
          run_id: d.agent_run_id ?? undefined,
        },
        { client_reference: ref, ...(typeof b.description === "string" ? { description: b.description } : {}) },
      );
      return { ok: true, notice: `✅ Paid out the held collection \`${ref}\`.` };
    } catch (e) {
      const after = await findHeldFundByRef(d.tenant_id, ref).catch(() => null);
      if (after?.status === "remitted") return { ok: true, notice: `✅ Paid out the held collection \`${ref}\`.` };
      if (!after || after.status === "remitting") {
        return { ok: false, outcome_unknown: true, error: `payout outcome unknown, check Stripe before retrying: ${(e as Error).message}` };
      }
      return { ok: false, error: (e as Error).message };
    }
  },
  "stripe.create_connected_account": async (d) => {
    const company_name =
      typeof (d.body as { company_name?: unknown })?.company_name === "string"
        ? ((d.body as { company_name: string }).company_name).trim()
        : "";
    if (!company_name || company_name.length > 100) {
      return {
        ok: false,
        error: "stripe.create_connected_account requires {company_name} (1..100 chars)",
      };
    }
    const provisioner = createStripeConnectProvisioner();
    const svc = serviceClient();
    try {
      const result = await provisioner.ensure({ tenant_id: d.tenant_id, company_name });
      const { error } = await svc.rpc("set_tenant_resource", {
        p_tenant_id: d.tenant_id,
        p_resource_kind: "stripe",
        p_mode: "provisioned",
        p_status: "ready",
        p_provider: provisioner.provider,
        p_external_ref: result.external_ref,
        p_vault_key: null,
      });
      if (error) {
        return { ok: false, error: `set_tenant_resource failed: ${error.message}` };
      }
      const acctId =
        typeof result.external_ref.stripe_account_id === "string"
          ? result.external_ref.stripe_account_id
          : "(pending)";
      return {
        ok: true,
        notice: `✅ Created Stripe connected account \`${acctId}\` for ${company_name}. The owner completes KYC via the onboarding link.`,
      };
    } catch (e) {
      if (e instanceof CredentialNotConfigured) {
        const { error } = await svc.rpc("set_tenant_resource", {
          p_tenant_id: d.tenant_id,
          p_resource_kind: "stripe",
          p_mode: "provisioned",
          p_status: "pending",
          p_provider: provisioner.provider,
          p_external_ref: {},
          p_vault_key: null,
        });
        if (error) {
          return { ok: false, error: `set_tenant_resource (pending) failed: ${error.message}` };
        }
        return {
          ok: true,
          notice: `Stripe connect is gated off (missing ${e.key}). Recorded as pending — no account created. Enable the rail to provision for real.`,
        };
      }
      return { ok: false, error: (e as Error).message };
    }
  },

  "stripe.submit_dispute_evidence": async (d) => {
    const parsed = submitDisputeEvidenceBody.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `stripe.submit_dispute_evidence body invalid: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      };
    }
    const { evidence_packet, submit_final } = parsed.data;
    const submit = submit_final === true;
    try {
      const result = (await submitDisputeEvidenceTool.execute(
        {
          tenant_id: d.tenant_id,
          log: (msg: string) =>
            console.log(`[stripe.submit_dispute_evidence] ${msg}`),
          run_id: d.agent_run_id ?? undefined,
          agent_slug: "dispute-response",
        },
        {
          dispute_id: evidence_packet.dispute_id,
          evidence: evidence_packet.evidence_fields,
          submit,
        },
      )) as {
        id: string;
        status: string;
        submitted_at: number | null;
        evidence_due_by: number | null;
        submission_count: number;
      };
      return {
        ok: true,
        notice: submit
          ? `✅ Submitted evidence to Stripe dispute \`${result.id}\` (status: ${result.status}). The dispute is now closed for further evidence.`
          : `📝 Saved as a Stripe DRAFT on dispute \`${result.id}\` (status: ${result.status}). Not submitted yet. Click "Submit for review" to actually file it before the evidence deadline, or the dispute is lost.`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "hiring.publish_role": async (d) => {
    const parsed = publishRoleBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `validation: ${parsed.error.issues[0].message}` };
    }
    const { error } = await serviceClient().rpc("publish_role", {
      p_role_id: parsed.data.role_id,
      p_approved_questions: parsed.data.approved_questions,
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  },
  "hiring.finalize_application": async (_d) => {
    return { ok: true };
  },

  "praxis.bake_rule": async (d) => {
    const parsed = proposedRuleBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `proposed_rule body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const p = parsed.data;
    const svc = serviceClient();

    let baseBody = "";
    try {
      const def = await loadAgentDefinition(p.target_agent_slug, d.tenant_id);
      baseBody = def?.body_markdown ?? "";
    } catch (e) {
      return {
        ok: false,
        error: `loadAgentDefinition(${p.target_agent_slug}) failed: ${(e as Error).message}`,
      };
    }
    if (!baseBody) {
      return {
        ok: false,
        error: `no base body resolvable for tenant=${d.tenant_id} slug=${p.target_agent_slug}`,
      };
    }

    const idx = baseBody.indexOf(TRAINER_RULES_SECTION_HEADER);
    const ruleBullet = `- ${p.rule_body_markdown.trim().replace(/\n+/g, " ")}`;
    let merged: string;
    if (idx === -1) {
      merged = `${baseBody.trimEnd()}\n\n${TRAINER_RULES_SECTION_HEADER}\n\n${ruleBullet}\n`;
    } else {
      const headerEnd = idx + TRAINER_RULES_SECTION_HEADER.length;
      const before = baseBody.slice(0, headerEnd);
      const after = baseBody.slice(headerEnd);
      const trimmedAfter = after.replace(/^\n+/, "");
      merged = `${before}\n\n${ruleBullet}\n${trimmedAfter}`;
    }

    const { data: reflipped, error: reflipErr } = await svc
      .from("decisions")
      .update({ status: "approved" })
      .eq("id", d.id)
      .eq("status", "dispatching")
      .select("id")
      .maybeSingle();
    if (reflipErr) {
      return { ok: false, error: `bake pre-flip failed: ${reflipErr.message}` };
    }
    if (!reflipped) {
      return { ok: true };
    }

    const { data: newVersion, error } = await svc
      .rpc("apply_baked_rule", {
        p_decision_id: d.id,
        p_merged_body_markdown: merged,
        p_frontmatter: {},
      })
      .single<number>();

    if (error) {
      return { ok: false, error: `apply_baked_rule RPC failed: ${error.message}` };
    }
    if (typeof newVersion !== "number") {
      return {
        ok: false,
        error: `apply_baked_rule returned non-numeric: ${JSON.stringify(newVersion)}`,
      };
    }
    return { ok: true };
  },

  "praxis.propose_global": async (_d) => {
    return { ok: true };
  },

  "meta_ads.update_ad_set_budget": async (d) => {
    const parsed = updateAdSetBudgetBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `meta_ads.update_ad_set_budget body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      const currency = await getAdAccountCurrency(d.tenant_id);
      const currencyMismatch = bodyCurrencyMismatch(p.currency, currency);
      if (currencyMismatch) return { ok: false, error: currencyMismatch };

      const expected_minor = toBudgetMinorUnits(p.expected_current_daily_budget_usd, currency);
      const live = (await fbGet(d.tenant_id, p.ad_set_id, {
        fields: "daily_budget",
      })) as { daily_budget?: string };
      const live_minor = Number(live.daily_budget ?? 0);
      assertNoBudgetDrift(expected_minor, live_minor);

      const capRefusal = await metaBudgetCapRefusal(d, p);
      if (capRefusal) return { ok: false, error: capRefusal };

      if (p.campaign_id) {
        const liveAdSets = await enumerateCampaignAdSets(d.tenant_id, p.campaign_id);
        const liveCls = classifyCampaignBudgeting(liveAdSets);
        if (liveCls.kind !== "single" || liveCls.adSet.id !== p.ad_set_id) {
          return { ok: false, error: "target_no_longer_single_adset" };
        }
      }

      const raise_usd = p.daily_budget_usd - p.expected_current_daily_budget_usd;
      const hold =
        raise_usd > 0
          ? await reserveAdSpend(d, {
              platform: "meta",
              op: "raise",
              object_id: p.ad_set_id,
              daily_delta_usd: raise_usd,
              currency,
            })
          : NO_AD_BUDGET_HOLD;
      if (hold.status === "refused") return { ok: false, error: hold.error };
      const unheld = raise_usd > 0 ? budgetMustHold(d, hold) : null;
      if (unheld) return { ok: false, error: unheld };
      const budgetRefusal = await runAdBudgetChecks(hold, () =>
        metaRaiseBudgetRefusal(d.tenant_id, p.ad_set_id),
      );
      if (budgetRefusal) return { ok: false, error: budgetRefusal };

      try {
        await metaUpdateAdSetBudget(d.tenant_id, {
          ad_set_id: p.ad_set_id,
          daily_budget_usd: p.daily_budget_usd,
        });
      } catch (e) {
        await settleAdSpendAfterError(hold, e);
        throw e;
      }
      await commitAdSpend(hold);
      if (raise_usd < 0) {
        await rebaseAdSpendForObject(d.tenant_id, "meta", p.ad_set_id, p.daily_budget_usd, adBudgetRebaseKey(d.id), -raise_usd);
      }
      await recordZaviAdChange(d.tenant_id, adChangeFrom(d), {
        platform: "meta",
        object_id: p.ad_set_id,
        level: "ad_set",
        campaign_id: p.campaign_id ?? null,
        object_name: p.name ?? null,
        change_kind: "budget",
        before_status: null,
        after_status: null,
        before_daily_usd: p.expected_current_daily_budget_usd,
        after_daily_usd: p.daily_budget_usd,
      });
      await readBackBudget({
        tenant_id: d.tenant_id,
        platform: "meta",
        object_id: p.ad_set_id,
        label: `Ad set ${p.name ? `"${p.name}"` : p.ad_set_id}`,
        expected_minor: toBudgetMinorUnits(p.daily_budget_usd, currency),
        minor_per_major: minorUnitsPerMajor(currency),
        currency,
        read: async () => {
          const back = (await fbGet(d.tenant_id, p.ad_set_id, { fields: "daily_budget" })) as { daily_budget?: string };
          return back.daily_budget == null ? null : Number(back.daily_budget);
        },
      });

      if (p.origin === "user_initiated_chat" && d.agent_run_id) {
        try {
          await serviceClient().from("agent_run_events").insert({
            agent_run_id: d.agent_run_id,
            tenant_id: d.tenant_id,
            stage: "user_chat_spend_auto_applied",
            meta: {},
          });
        } catch (e) {
          console.warn(
            `[dispatch-decision meta_ads] user_chat_spend_auto_applied audit insert failed: ${(e as Error).message}`,
          );
        }
      }

      return {
        ok: true,
        notice: `✅ Set ad set \`${p.ad_set_id}\` daily budget to ${formatMoney(p.daily_budget_usd, currency)}/day.`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  "meta_ads.update_ad_set_budget_review": async (d) => HANDLERS["meta_ads.update_ad_set_budget"](d),

  "meta_ads.update_campaign_budget": async (d) => {
    const parsed = metaUpdateCampaignBudgetBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `meta_ads.update_campaign_budget body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      const currency = await getAdAccountCurrency(d.tenant_id);
      const currencyMismatch = bodyCurrencyMismatch(p.currency, currency);
      if (currencyMismatch) return { ok: false, error: currencyMismatch };

      const live = await readOwnCampaign(d.tenant_id, p.campaign_id);
      if (Number(live.lifetime_budget ?? 0) > 0) {
        return {
          ok: false,
          code: "meta_ads_lifetime_budget",
          error: `meta_ads_lifetime_budget: campaign ${p.campaign_id} has a lifetime budget. Zavi changes daily budgets only; nothing was changed.`,
        };
      }
      const live_minor = Number(live.daily_budget ?? 0);
      if (!(live_minor > 0)) {
        return {
          ok: false,
          code: "meta_ads_budget_on_ad_sets",
          error: `meta_ads_budget_on_ad_sets: campaign ${p.campaign_id} does not hold a daily budget (its ad sets do). Change the ad set budgets instead; nothing was changed.`,
        };
      }
      assertNoBudgetDrift(toBudgetMinorUnits(p.expected_current_daily_budget_usd, currency), live_minor);

      const capRefusal = await metaBudgetCapRefusal(d, p);
      if (capRefusal) return { ok: false, error: capRefusal };

      const raise_usd = p.daily_budget_usd - p.expected_current_daily_budget_usd;
      const hold =
        raise_usd > 0
          ? await reserveAdSpend(d, {
              platform: "meta",
              op: "raise",
              object_id: p.campaign_id,
              daily_delta_usd: raise_usd,
              currency,
            })
          : NO_AD_BUDGET_HOLD;
      if (hold.status === "refused") return { ok: false, error: hold.error };
      const unheld = raise_usd > 0 ? budgetMustHold(d, hold) : null;
      if (unheld) return { ok: false, error: unheld };

      try {
        await metaUpdateCampaignBudget(d.tenant_id, {
          campaign_id: p.campaign_id,
          daily_budget_usd: p.daily_budget_usd,
        });
      } catch (e) {
        await settleAdSpendAfterError(hold, e);
        throw e;
      }
      await commitAdSpend(hold);
      if (raise_usd < 0) {
        await rebaseAdSpendForObject(d.tenant_id, "meta", p.campaign_id, p.daily_budget_usd, adBudgetRebaseKey(d.id), -raise_usd);
      }
      await recordZaviAdChange(d.tenant_id, adChangeFrom(d), {
        platform: "meta",
        object_id: p.campaign_id,
        level: "campaign",
        campaign_id: p.campaign_id,
        object_name: p.name ?? null,
        change_kind: "budget",
        before_status: null,
        after_status: null,
        before_daily_usd: p.expected_current_daily_budget_usd,
        after_daily_usd: p.daily_budget_usd,
      });
      await readBackBudget({
        tenant_id: d.tenant_id,
        platform: "meta",
        object_id: p.campaign_id,
        label: `Campaign ${p.name ? `"${p.name}"` : p.campaign_id}`,
        expected_minor: toBudgetMinorUnits(p.daily_budget_usd, currency),
        minor_per_major: minorUnitsPerMajor(currency),
        currency,
        read: async () => {
          const back = await readOwnCampaign(d.tenant_id, p.campaign_id);
          return back.daily_budget == null ? null : Number(back.daily_budget);
        },
      });
      if (p.origin === "user_initiated_chat" && d.agent_run_id) {
        try {
          await serviceClient().from("agent_run_events").insert({
            agent_run_id: d.agent_run_id,
            tenant_id: d.tenant_id,
            stage: "user_chat_spend_auto_applied",
            meta: {},
          });
        } catch (e) {
          console.warn(
            `[dispatch-decision meta_ads] user_chat_spend_auto_applied audit insert failed: ${(e as Error).message}`,
          );
        }
      }
      return {
        ok: true,
        notice: `✅ Set campaign \`${p.campaign_id}\` daily budget to ${formatMoney(p.daily_budget_usd, currency)}/day.`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  "meta_ads.update_campaign_budget_review": async (d) => HANDLERS["meta_ads.update_campaign_budget"](d),

  "meta_ads.create_campaign": async (d) => {
    const parsed = metaCreateCampaignBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `meta_ads.create_campaign body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      const currency = await getAdAccountCurrency(d.tenant_id);
      const budgeted = p.daily_budget_usd !== undefined;
      if (budgeted) {
        const currencyMismatch = bodyCurrencyMismatch(p.currency, currency);
        if (currencyMismatch) return { ok: false, error: currencyMismatch };
        const capRefusal = await metaBudgetCapRefusal(d, {
          daily_budget_usd: p.daily_budget_usd as number,
          expected_current_daily_budget_usd: 0,
        });
        if (capRefusal) return { ok: false, error: capRefusal };
      }
      const hold = budgeted
        ? await reserveAdSpend(d, {
            platform: "meta",
            op: "create",
            object_id: null,
            daily_delta_usd: p.daily_budget_usd as number,
            currency,
          })
        : NO_AD_BUDGET_HOLD;
      if (hold.status === "refused") return { ok: false, error: hold.error };
      const unheld = budgeted ? budgetMustHold(d, hold) : null;
      if (unheld) return { ok: false, error: unheld };
      const budgetRefusal = await runAdBudgetChecks(hold, async () =>
        currency.toUpperCase() !== "USD" ? "non_usd_account" : null,
      );
      if (budgetRefusal) return { ok: false, error: budgetRefusal };

      const { launchTag } = await import("@/services/tools/meta-ads/write/_launch-shapers");
      const tag = launchTag(d.id);
      const name = hold.status === "held" ? prefixAdName(p.name, 255) : p.name;
      const unlabelled = await noteAdSpendRef(hold, { kind: "meta_tag", level: "campaign", campaign_id: "account", tag });
      if (unlabelled) return { ok: false, error: unlabelled };

      let r: Awaited<ReturnType<typeof metaCreateCampaign>>;
      try {
        r = await metaCreateCampaign(d.tenant_id, {
          name,
          tag,
          objective: p.objective,
          special_ad_categories: p.special_ad_categories,
          special_ad_category_country: p.special_ad_category_country,
          daily_budget_usd: p.daily_budget_usd,
          bid_strategy: p.bid_strategy,
        });
      } catch (e) {
        await settleAdSpendAfterError(hold, e);
        throw e;
      }
      await commitAdSpend(hold, r.id);
      const budgetNote = budgeted ? ` with a campaign budget of ${formatMoney(p.daily_budget_usd as number, currency)}/day` : "";
      return {
        ok: true,
        notice: `✅ ${r.reused ? "Found" : "Created"} campaign "${r.name}" (\`${r.id}\`)${budgetNote}, PAUSED. Add ad sets and ads, then switch it on.`,
        created: { platform: "meta", object_type: "campaign", id: r.id, status: "PAUSED" },
      };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "meta_ads.update_campaign": async (d) => {
    const parsed = metaUpdateCampaignBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `meta_ads.update_campaign body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      if (p.spend_cap_usd != null) {
        const currencyMismatch = bodyCurrencyMismatch(p.currency, await getAdAccountCurrency(d.tenant_id));
        if (currencyMismatch) return { ok: false, error: currencyMismatch };
      }
      const r = await metaUpdateCampaign(d.tenant_id, p);
      return {
        ok: true,
        notice: `✅ Updated Meta campaign \`${p.campaign_id}\` (${r.updated_fields.join(", ")}).`,
      };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "meta_ads.delete_campaign": async (d) => {
    const parsed = metaDeleteCampaignBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `meta_ads.delete_campaign body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      const r = await metaDeleteCampaign(d.tenant_id, p.campaign_id);
      await releaseAdSpendForObject(d.tenant_id, "meta", p.campaign_id);
      await recordZaviAdChange(d.tenant_id, adChangeFrom(d), {
        platform: "meta",
        object_id: p.campaign_id,
        level: "campaign",
        campaign_id: p.campaign_id,
        object_name: r.name ?? p.name ?? null,
        change_kind: "status",
        before_status: r.before_status,
        after_status: "DELETED",
        before_daily_usd: null,
        after_daily_usd: null,
      });
      return { ok: true, notice: `✅ Deleted Meta campaign "${r.name ?? p.name ?? p.campaign_id}" (\`${p.campaign_id}\`).` };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "meta_ads.set_status": async (d) => {
    const parsed = setStatusBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `meta_ads.set_status body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      let hold: AdSpendHold = NO_AD_BUDGET_HOLD;
      let capWaivedForBudget = false;
      let resumeCounted: { daily: number | null; currency: string } | null = null;
      let prior: { status: string | null; daily_usd: number | null } | null = null;
      if (p.status === "PAUSED" || p.expected_current_status) {
        try {
          const r = (await fbGet(d.tenant_id, p.object_id, { fields: "status,daily_budget" })) as { status?: string; daily_budget?: string } | undefined;
          const daily = Number(r?.daily_budget ?? 0) / 100;
          prior = { status: typeof r?.status === "string" ? r.status : null, daily_usd: daily > 0 ? daily : null };
        } catch (e) {
          console.warn(`[dispatch-decision meta_ads] prior state of ${p.object_id} unreadable; not undoable: ${(e as Error).message}`);
        }
      }
      if (p.expected_current_status && prior?.status !== p.expected_current_status) {
        return {
          ok: false,
          error: `meta_ads_status_drift: ${p.level} ${p.object_id} is ${prior?.status ?? "unreadable"} now, not ${p.expected_current_status} as when this undo was set up. Nothing changed.`,
        };
      }
      if (p.status === "ACTIVE") {
        const currency = await getAdAccountCurrency(d.tenant_id);
        if (!isWritableCurrency(currency)) {
          return {
            ok: false,
            error: `cap_refuse: Meta budget writes support USD and INR ad accounts only; got ${currency}`,
          };
        }
        const live = (await fbGet(d.tenant_id, p.object_id, {
          fields: "daily_budget,status",
        })) as { daily_budget?: string; status?: string };
        const resumed_daily_budget_usd = Number(live.daily_budget ?? 0) / minorUnitsPerMajor(currency);
        prior = { status: typeof live?.status === "string" ? live.status : prior?.status ?? null, daily_usd: resumed_daily_budget_usd > 0 ? resumed_daily_budget_usd : null };
        let countedDaily: number | null = resumed_daily_budget_usd > 0 ? resumed_daily_budget_usd : null;
        if (countedDaily === null && p.level === "adset") {
          try {
            const a = (await fbGet(d.tenant_id, p.object_id, { fields: "campaign{daily_budget}" })) as { campaign?: { daily_budget?: string } };
            const cd = Number(a?.campaign?.daily_budget ?? NaN) / minorUnitsPerMajor(currency);
            if (Number.isFinite(cd) && cd > 0) countedDaily = cd;
          } catch (e) {
            console.warn(`[dispatch-decision meta_ads] campaign budget of ${p.object_id} unreadable: ${(e as Error).message}`);
          }
        }

        if (capGovernsDispatch(d)) {
          const capRead = await readTenantCapAndToday(d.tenant_id, d.id);
          const { cap, today_total_change_usd } = capRead;
          capWaivedForBudget = await adBudgetStandsInForCap(d, capRead);
          if (countedDaily === null && !capWaivedForBudget) {
            return { ok: false, error: "cap_refuse: resume_amount_unknown: the daily amount this switch-on re-opens could not be read. Nothing changed." };
          }
          const evalRes = evaluateBudgetCap({
            proposed_daily_budget_usd: countedDaily ?? 0,
            current_daily_budget_usd: 0,
            today_total_change_usd,
            cap,
          });
          if (!capWaivedForBudget && !evalRes.within) {
            return { ok: false, error: `cap_refuse: ${evalRes.reason}` };
          }
        }
        resumeCounted = { daily: countedDaily, currency };

        hold = await reserveAdSpend(d, {
          platform: "meta",
          op: "resume",
          object_id: p.object_id,
          daily_delta_usd: resumed_daily_budget_usd,
          currency,
        });
        if (hold.status === "refused") return { ok: false, error: hold.error };
        const unheld = budgetMustHold(d, hold);
        if (unheld) return { ok: false, error: unheld };
        const budgetRefusal = await runAdBudgetChecks(hold, async () =>
          resumed_daily_budget_usd > 0
            ? null
            : p.level === "campaign"
              ? "campaign_level_resume: turn on its ad sets instead, so each one is held and its spend is read"
              : "zero_daily_budget",
        );
        if (budgetRefusal) return { ok: false, error: budgetRefusal };
      }

      if (resumeCounted && !(await stampResumeCapCounted(d, resumeCounted.daily, resumeCounted.currency))) {
        await dropAdSpendHold(hold);
        return { ok: false, error: "resume_not_recorded: Zavi could not record what this switch-on adds to today's total, so it did not send it. Nothing changed; approve again in a minute." };
      }
      try {
        await metaSetStatus(d.tenant_id, {
          object_id: p.object_id,
          level: p.level,
          status: p.status,
        });
      } catch (e) {
        await settleAdSpendAfterError(hold, e);
        throw e;
      }
      await commitAdSpend(hold);
      if (p.status === "PAUSED") {
        await releaseAdSpendForObject(d.tenant_id, "meta", p.object_id);
      }
      if (prior?.status) {
        await recordZaviAdChange(d.tenant_id, adChangeFrom(d), {
          platform: "meta",
          object_id: p.object_id,
          level: p.level === "campaign" ? "campaign" : "ad_set",
          campaign_id: p.level === "campaign" ? p.object_id : null,
          object_name: p.name ?? null,
          change_kind: "status",
          before_status: prior.status,
          after_status: p.status,
          before_daily_usd: prior.daily_usd,
          after_daily_usd: prior.daily_usd,
        });
      }
      return {
        ok: true,
        notice: `✅ Set ${p.level} \`${p.object_id}\` to ${p.status}.`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  "meta_ads.set_status_review": async (d) => HANDLERS["meta_ads.set_status"](d),
  [PAUSE_PAST_GUARD_CLASS]: async (d) => {
    const parsed = pausePastGuardBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `${PAUSE_PAST_GUARD_CLASS} body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    const r = await HANDLERS["meta_ads.set_status"](d);
    return r.ok ? { ...r, cut_guard_override: true } : r;
  },
  "meta_ads.replace_ad_set_geo_review": async (d) => {
    const parsed = replaceAdSetGeoBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `meta_ads.replace_ad_set_geo_review body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const p = parsed.data;
    const names = p.places.map((x) => x.name ?? x.key).join(", ");
    try {
      const zavi = p.origin === "zavi_location_proposal" || p.origin === "zavi_location_undo";
      if (zavi) {
        const { isMetaAdsWriteEnabled } = await import("@/services/tools/meta-ads/write/_flag-check");
        if (!(await isMetaAdsWriteEnabled().catch(() => false))) {
          return { ok: false, code: "meta_ads_write_disabled", error: "meta_ads_write_disabled: Meta changes are switched off at the platform level right now, so Zavi did not change where this ad set shows. Nothing in Meta changed." };
        }
        const { recheckLocationChange } = await import("@/services/tools/meta-ads/write/propose_locations");
        const refused = await recheckLocationChange(d.tenant_id, p);
        if (refused) return { ok: false, code: "meta_ads_locations_refused", error: `meta_ads_locations_refused: ${refused}` };
      }
      const r = await metaReplaceAdSetGeo(d.tenant_id, p);
      await logAdGeoChange(d, "meta", r.verified ? "applied" : "applied_unverified");
      const places_change = { before: r.before.map((x) => x.name ?? x.key), after: p.places.map((x) => x.name ?? x.key) };
      if (zavi && !r.verified) {
        const said = r.read_back === null
          ? `Meta accepted the write for ad set ${p.ad_set_id}, but Zavi could not read its places back to confirm them.`
          : `Meta accepted the write for ad set ${p.ad_set_id}, but it now shows different places than asked (${r.read_back.join(", ") || "none"}).`;
        return { ok: false, code: "meta_ads_geo_unverified", error: `meta_ads_geo_unverified: ${said} Check it in Ads Manager.`, places_change };
      }
      const { locationUndoBody } = await import("@/services/tools/meta-ads/write/location-undo");
      const location_undo = p.origin === "zavi_location_proposal" ? locationUndoBody(p, r.before, r.after_fingerprint) : null;
      const { UNDO_FOLLOWS, undoReceiptLine } = await import("@/services/tools/meta-ads/write/location-undo");
      const undoLine = location_undo ? ` ${UNDO_FOLLOWS}` : "";
      const said = r.verified
        ? `Ad set ${p.ad_set_id} now shows in: ${names}.`
        : `Meta accepted the new places for ad set ${p.ad_set_id} (${names}); Zavi could not read them back. Check it in Ads Manager.`;
      return {
        ok: true,
        notice:
          (r.verified
            ? `✅ Meta ad set \`${p.ad_set_id}\` now shows in: ${names}.`
            : `⚠️ Meta accepted the new places for ad set \`${p.ad_set_id}\` (${names}), but Zavi could not read them back to confirm. Check it in Ads Manager.`) + undoLine,
        receipt: { line: location_undo ? undoReceiptLine(said, "filed") : said },
        places_change,
        ...(location_undo ? { location_undo } : {}),
      };
    } catch (e) {
      await logAdGeoChange(d, "meta", "refused", e);
      if (e instanceof ExpectedToolError) return { ok: false, code: e.code, error: `${e.code}: ${e.message}` };
      return { ok: false, error: (e as Error).message };
    }
  },

  "meta_ads.create_ad_set": async (d) => {
    const parsed = createAdSetBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `meta_ads.create_ad_set body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      const currency = await getAdAccountCurrency(d.tenant_id);
      const currencyMismatch = bodyCurrencyMismatch(p.currency, currency);
      if (currencyMismatch) return { ok: false, error: currencyMismatch };

      let capWaivedForBudget = false;
      if (capGovernsDispatch(d)) {
        const capRead = await readTenantCapAndToday(d.tenant_id, d.id);
        const { cap, today_total_change_usd } = capRead;
        capWaivedForBudget = await adBudgetStandsInForCap(d, capRead);
        const evalRes = evaluateBudgetCap({
          proposed_daily_budget_usd: p.daily_budget_usd,
          current_daily_budget_usd: 0,
          today_total_change_usd,
          cap,
        });
        if (!capWaivedForBudget && !evalRes.within) {
          return { ok: false, error: `cap_refuse: ${evalRes.reason}` };
        }
      }

      const hold = await reserveAdSpend(d, {
        platform: "meta",
        op: "create",
        object_id: null,
        daily_delta_usd: p.daily_budget_usd,
        currency,
      });
      if (hold.status === "refused") return { ok: false, error: hold.error };
      const unheld = budgetMustHold(d, hold);
      if (unheld) return { ok: false, error: unheld };
      const budgetRefusal = await runAdBudgetChecks(hold, async () => {
        if (currency.toUpperCase() !== "USD") return "non_usd_account";
        return (await metaCampaignIsCbo(d.tenant_id, p.campaign_id)) ? "cbo_campaign_in_budget" : null;
      });
      if (budgetRefusal === adBudgetRefusal("cbo_campaign_in_budget") && d.approved_by_source === "cgo") {
        return metaCboCampaignRaiseInstead(d, p.campaign_id, p.daily_budget_usd, currency);
      }
      if (budgetRefusal) return { ok: false, error: budgetRefusal };
      const name = hold.status === "held" ? prefixAdName(p.name, 255) : p.name;
      const unlabelled = await noteAdSpendRef(hold, { kind: "meta_adset_name", campaign_id: p.campaign_id, name });
      if (unlabelled) return { ok: false, error: unlabelled };

      let r: Awaited<ReturnType<typeof metaCreateAdSet>>;
      try {
        r = await metaCreateAdSet(d.tenant_id, {
          campaign_id: p.campaign_id,
          name,
          daily_budget_usd: p.daily_budget_usd,
          optimization_goal: p.optimization_goal,
          billing_event: p.billing_event,
          targeting: p.targeting,
          promoted_object: p.promoted_object,
          bid_strategy: p.bid_strategy,
          bid_amount_usd: p.bid_amount_usd,
          campaign_bid_strategy: p.campaign_bid_strategy,
          roas_floor: p.roas_floor,
          status: "PAUSED",
        });
      } catch (e) {
        await settleAdSpendAfterError(hold, e);
        throw e;
      }
      await commitAdSpend(hold, r.id);
      console.log(
        `[dispatch-decision meta_ads.create_ad_set] created ad set ${r.id} for tenant ${d.tenant_id} (decision ${d.id})`,
      );
      return {
        ok: true,
        notice: `✅ Created ad set "${name}" — PAUSED, ${formatMoney(p.daily_budget_usd, currency)}/day. ${
          d.approved_by_source === "cgo"
            ? "Switching it on is a separate change, which Autopilot may approve within the ad budget."
            : "Approve a separate ACTIVE toggle to start spend."
        }`,
        created: { platform: "meta", object_type: "ad_set", id: String(r.id), status: "PAUSED" },
      };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "perfmkt.create_ad_set_pending_strategist": async (d) => {
    if (!isPendingStrategistBody(d.body)) {
      return {
        ok: false,
        error: `perfmkt.create_ad_set_pending_strategist body invalid: not a parked strategist body`,
      };
    }
    const createBody = reconstructCreateBody(d.body);
    if (!createBody) {
      return {
        ok: false,
        error: `perfmkt.create_ad_set_pending_strategist: the parked ad set is not a valid create; nothing was sent to approvals`,
      };
    }
    let withBid: typeof createBody;
    try {
      const { resolveCreateAdSetBid } = await import("@/services/tools/meta-ads/write/_ad-set-bid");
      withBid = await resolveCreateAdSetBid(d.tenant_id, createBody);
    } catch (e) {
      const { isRetryableMetaReadError } = await import("@/services/tools/meta-ads/_retryable");
      if (isRetryableMetaReadError(e)) {
        return {
          ok: false,
          retry_later: true,
          error: `Meta did not answer the campaign read (${(e as Error).message.slice(0, 300)}); the new ad set stays pending and Zavi tries again shortly`,
        };
      }
      return {
        ok: false,
        error: `perfmkt.create_ad_set_pending_strategist: ${(e as Error).message}; nothing was sent to approvals`,
      };
    }
    const finalBody = { ...withBid, strategist_gate: { origin_pending_decision_id: d.id } };
    try {
      const finalId = await emitFinalCreateIdempotent({
        rawEmit: async (body) => {
          const { data, error } = await serviceClient().rpc("emit_decision", {
            p_tenant_id: d.tenant_id,
            p_agent_run_id: d.agent_run_id,
            p_decision_class: "meta_ads.create_ad_set",
            p_body: body as object,
          });
          if (error) throw new Error(`emit_decision failed (meta_ads.create_ad_set): ${error.message}`);
          return data as string;
        },
        findExisting: findFinalCreateFor,
        body: finalBody,
        tenant_id: d.tenant_id,
        pending_decision_id: d.id,
      });
      const { cgoApproveAdDecision } = await import("@/services/growth/cgo-ads");
      if (await cgoApproveAdDecision(d.tenant_id, finalId, "meta_ads.create_ad_set", finalBody)) {
        return { ok: true, notice: `Autopilot approved the new ad set (decision ${finalId}).` };
      }
      return { ok: true, notice: `Sent the new ad set to approvals (decision ${finalId}).` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "google_ads.update_campaign_budget": async (d) => {
    const parsed = updateCampaignBudgetBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `google_ads.update_campaign_budget body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      const currencyRefusal = await googleCurrencyRefusal(d.tenant_id, "the budget was not changed");
      if (currencyRefusal) return currencyRefusal;
      const live = await gadsGetCampaignBudget(d.tenant_id, p.campaign_id);
      const videoRefusal = videoMutateRefusal(live.channel_type);
      if (videoRefusal) return videoRefusal;

      const expected_micros = Math.round(
        p.expected_current_daily_budget_usd * 1_000_000,
      );
      if (expected_micros !== live.amount_micros) {
        return {
          ok: false,
          error: `google_ads_budget_drift: campaign ${p.campaign_id} budget drifted since the agent proposed this change: expected ${expected_micros} micros, live is ${live.amount_micros}. Refusing.`,
        };
      }

      let capWaivedForBudget = false;
      if (capGovernsDispatch(d)) {
        const capRead = await readTenantGoogleCapAndToday(d.tenant_id, d.id);
        const { cap, today_total_change_usd } = capRead;
        capWaivedForBudget = await adBudgetStandsInForCap(d, capRead);
        const evalRes = evaluateBudgetCap({
          proposed_daily_budget_usd: p.daily_budget_usd,
          current_daily_budget_usd: p.expected_current_daily_budget_usd,
          today_total_change_usd,
          cap,
        });
        if (!capWaivedForBudget && !evalRes.within) {
          return { ok: false, error: `cap_refuse: ${evalRes.reason}` };
        }
      }

      const raise_usd = p.daily_budget_usd - p.expected_current_daily_budget_usd;
      const hold =
        raise_usd > 0
          ? await reserveAdSpend(d, {
              platform: "google",
              op: "raise",
              object_id: p.campaign_id,
              daily_delta_usd: raise_usd,
            })
          : NO_AD_BUDGET_HOLD;
      if (hold.status === "refused") return { ok: false, error: hold.error };
      const unheld = raise_usd > 0 ? budgetMustHold(d, hold) : null;
      if (unheld) return { ok: false, error: unheld };
      const budgetRefusal = await runAdBudgetChecks(hold, () =>
        googleBudgetRefusal(d.tenant_id, p.campaign_id),
      );
      if (budgetRefusal) return { ok: false, error: budgetRefusal };

      try {
        await googleUpdateCampaignBudget(d.tenant_id, {
          budget_resource: live.budget_resource,
          daily_budget_usd: p.daily_budget_usd,
        });
      } catch (e) {
        await settleAdSpendAfterError(hold, e);
        throw e;
      }
      await commitAdSpend(hold);
      if (raise_usd < 0) {
        await rebaseAdSpendForObject(d.tenant_id, "google", p.campaign_id, p.daily_budget_usd, adBudgetRebaseKey(d.id), -raise_usd);
      }
      await recordZaviAdChange(d.tenant_id, adChangeFrom(d), {
        platform: "google",
        object_id: p.campaign_id,
        level: "campaign",
        campaign_id: p.campaign_id,
        object_name: p.name ?? null,
        change_kind: "budget",
        before_status: null,
        after_status: null,
        before_daily_usd: live.amount_micros / 1_000_000,
        after_daily_usd: p.daily_budget_usd,
      });
      await readBackBudget({
        tenant_id: d.tenant_id,
        platform: "google",
        object_id: p.campaign_id,
        label: `Google campaign ${p.name ? `"${p.name}"` : p.campaign_id}`,
        expected_minor: Math.round(p.daily_budget_usd * 100),
        minor_per_major: 100,
        currency: "USD",
        read: async () => Math.round((await gadsGetCampaignBudget(d.tenant_id, p.campaign_id)).amount_micros / 10_000),
      });
      return {
        ok: true,
        notice: `✅ Set Google Ads campaign \`${p.campaign_id}\` daily budget to $${p.daily_budget_usd}/day.`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  "google_ads.update_campaign_budget_review": async (d) =>
    HANDLERS["google_ads.update_campaign_budget"](d),

  "google_ads.set_status": async (d) => {
    const parsed = googleSetStatusBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `google_ads.set_status body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      if (p.status === "ENABLED") {
        const currencyRefusal = await googleCurrencyRefusal(d.tenant_id, "nothing was enabled");
        if (currencyRefusal) return currencyRefusal;
      }
      const live = await gadsGetCampaignBudget(d.tenant_id, p.campaign_id);
      const videoRefusal = videoMutateRefusal(live.channel_type);
      if (videoRefusal) return videoRefusal;
      if (p.expected_current_status && (p.level !== "campaign" || live.campaign_status !== p.expected_current_status)) {
        return {
          ok: false,
          error: `google_ads_status_drift: campaign ${p.campaign_id} is ${live.campaign_status || "unreadable"} now, not ${p.expected_current_status} as when this undo was set up. Nothing changed.`,
        };
      }
      let capWaivedForBudget = false;
      if (p.status === "ENABLED" && capGovernsDispatch(d)) {
        const resumed_daily_budget_usd = live.amount_micros / 1_000_000;
        const capRead = await readTenantGoogleCapAndToday(d.tenant_id, d.id);
        const { cap, today_total_change_usd } = capRead;
        capWaivedForBudget = await adBudgetStandsInForCap(d, capRead);
        const evalRes = evaluateBudgetCap({
          proposed_daily_budget_usd: resumed_daily_budget_usd,
          current_daily_budget_usd: 0,
          today_total_change_usd,
          cap,
        });
        if (!capWaivedForBudget && !evalRes.within) {
          return { ok: false, error: `cap_refuse: ${evalRes.reason}` };
        }
      }
      let hold: AdSpendHold = NO_AD_BUDGET_HOLD;
      if (p.status === "ENABLED") {
        const resumed_daily_budget_usd = live.amount_micros / 1_000_000;
        hold = await reserveAdSpend(d, {
          platform: "google",
          op: "resume",
          object_id: p.campaign_id,
          daily_delta_usd: resumed_daily_budget_usd,
        });
        if (hold.status === "refused") return { ok: false, error: hold.error };
        const unheld = budgetMustHold(d, hold);
        if (unheld) return { ok: false, error: unheld };
        const budgetRefusal = await runAdBudgetChecks(hold, async () =>
          resumed_daily_budget_usd > 0
            ? googleBudgetRefusal(d.tenant_id, p.campaign_id)
            : "zero_daily_budget",
        );
        if (budgetRefusal) return { ok: false, error: budgetRefusal };
      }
      const recordEnable = async (): Promise<boolean> => {
        if (p.status !== "ENABLED") return true;
        const daily = live.amount_micros / 1_000_000;
        return stampResumeCapCounted(d, Number.isFinite(daily) && daily > 0 ? daily : null, "USD");
      };
      const notRecorded = async (): Promise<HandlerResult> => {
        await dropAdSpendHold(hold);
        return { ok: false, error: "resume_not_recorded: Zavi could not record what this enable adds to today's total, so it did not send it. Nothing changed; approve again in a minute." };
      };
      if (p.level === "ad_group") {
        const adGroup = await gadsGetAdGroup(d.tenant_id, p.ad_group_id!).catch(async (e) => {
          await dropAdSpendHold(hold);
          throw e;
        });
        if (adGroup.campaign_id !== p.campaign_id) {
          await dropAdSpendHold(hold);
          return {
            ok: false,
            error: `google_ads_target_mismatch: ad group ${p.ad_group_id} belongs to campaign ${adGroup.campaign_id}, not ${p.campaign_id}.`,
          };
        }
        if (!(await recordEnable())) return notRecorded();
        try {
          await googleSetAdGroupStatus(d.tenant_id, {
            ad_group_resource: adGroup.ad_group_resource,
            status: p.status,
          });
        } catch (e) {
          await settleAdSpendAfterError(hold, e);
          throw e;
        }
        await commitAdSpend(hold);
        return {
          ok: true,
          notice: `✅ Set Google Ads ad group \`${p.ad_group_id}\` to ${p.status}.`,
        };
      }
      if (p.level === "ad") {
        const ad = await gadsGetAd(d.tenant_id, p.ad_group_id!, p.ad_id!).catch(async (e) => {
          await dropAdSpendHold(hold);
          throw e;
        });
        if (ad.campaign_id && ad.campaign_id !== p.campaign_id) {
          await dropAdSpendHold(hold);
          return {
            ok: false,
            error: `google_ads_target_mismatch: ad ${p.ad_id} belongs to campaign ${ad.campaign_id}, not ${p.campaign_id}.`,
          };
        }
        if (!(await recordEnable())) return notRecorded();
        try {
          await googleSetAdStatus(d.tenant_id, {
            ad_group_ad_resource: ad.ad_group_ad_resource,
            status: p.status,
          });
        } catch (e) {
          await settleAdSpendAfterError(hold, e);
          throw e;
        }
        await commitAdSpend(hold);
        return {
          ok: true,
          notice: `✅ Set Google Ads ad \`${p.ad_id}\` to ${p.status}.`,
        };
      }
      if (!(await recordEnable())) return notRecorded();
      try {
        await googleSetCampaignStatus(d.tenant_id, {
          campaign_resource: live.campaign_resource,
          status: p.status,
        });
      } catch (e) {
        await settleAdSpendAfterError(hold, e);
        throw e;
      }
      await commitAdSpend(hold);
      if (p.status === "PAUSED") {
        await releaseAdSpendForObject(d.tenant_id, "google", p.campaign_id);
      }
      if (live.campaign_status) {
        const daily = live.amount_micros / 1_000_000;
        await recordZaviAdChange(d.tenant_id, adChangeFrom(d), {
          platform: "google",
          object_id: p.campaign_id,
          level: "campaign",
          campaign_id: p.campaign_id,
          object_name: p.name ?? null,
          change_kind: "status",
          before_status: live.campaign_status,
          after_status: p.status,
          before_daily_usd: daily > 0 ? daily : null,
          after_daily_usd: daily > 0 ? daily : null,
        });
      }
      return {
        ok: true,
        notice: `✅ Set Google Ads campaign \`${p.campaign_id}\` to ${p.status}.`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  "google_ads.set_status_review": async (d) =>
    HANDLERS["google_ads.set_status"](d),

  "google_ads.create_campaign": async (d) => {
    const parsed = createCampaignBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `google_ads.create_campaign body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    let testEnd: Awaited<ReturnType<typeof cgoTestEndForRun>>;
    try {
      testEnd = await cgoTestEndForRun(d.tenant_id, d.agent_run_id, new Date());
    } catch (e) {
      console.warn(`[dispatch-decision google_ads.create_campaign] ${d.id}: test end unreadable: ${(e as Error).message}`);
      return { ok: false, error: "Zavi could not read this test's end date, so nothing new was created on this attempt. Approve it again in a minute." };
    }
    const testEndWritten = !!testEnd && parsed.data.channel_type !== "DEMAND_GEN";
    const p = testEndWritten ? { ...parsed.data, end_date: earlierEndDay(parsed.data.end_date, testEnd!.ends_on) } : parsed.data;
    const logo = p.demand_gen_ad_group?.ad.logo ?? p.pmax_asset_group?.logo;
    if (logo && !logoPathBelongsTo(d.tenant_id, logo.storage_path)) {
      return {
        ok: false,
        code: "google_ads_demand_gen_logo_mismatch",
        error: "google_ads_demand_gen_logo_mismatch: the card's logo belongs to another workspace.",
      };
    }
    const pm = p.pmax_asset_group;
    if (pm && [...pm.landscape_images, ...pm.square_images, ...pm.portrait_images].some((i) => !adImagePathBelongsTo(d.tenant_id, i.storage_path))) {
      return {
        ok: false,
        code: "google_ads_ad_image_mismatch",
        error: "google_ads_ad_image_mismatch: an image on the card belongs to another workspace.",
      };
    }
    try {
      const founderVerdict = d.approved_by_source === "cgo"
        ? "none"
        : await (await import("@/services/approvals/envelope-door")).founderEnvelopeVerdict(d as never, "google_ads");
      if (founderVerdict === "invalid") {
        return { ok: false, code: "envelope_invalid", error: "envelope_invalid: your ask no longer approves this campaign (your role, its budget or its dates changed, or direct asks are switched off). Nothing was created." };
      }
      const currencyRefusal = await googleCurrencyRefusal(d.tenant_id, "nothing was created");
      if (currencyRefusal) return currencyRefusal;
      let capWaivedForBudget = false;
      if (capGovernsDispatch(d)) {
        const capRead = await readTenantGoogleCapAndToday(d.tenant_id, d.id);
        const { cap, today_total_change_usd } = capRead;
        capWaivedForBudget = await adBudgetStandsInForCap(d, capRead);
        const evalRes = evaluateBudgetCap({
          proposed_daily_budget_usd: p.daily_budget_usd,
          current_daily_budget_usd: 0,
          today_total_change_usd,
          cap,
        });
        if (!capWaivedForBudget && !evalRes.within) {
          return { ok: false, error: `cap_refuse: ${evalRes.reason}` };
        }
      }
      if (p.end_date && Date.parse(`${p.end_date}T00:00:00Z`) <= Date.now()) {
        return { ok: false, error: "The campaign's end date has already passed; nothing was created." };
      }
      const googleEndsOn = p.end_date ? new Date(Date.parse(`${p.end_date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null;
      const hold = await reserveAdSpend(d, {
        platform: "google",
        op: "create",
        object_id: null,
        daily_delta_usd: p.daily_budget_usd,
        ...(googleEndsOn ? { ends_on: googleEndsOn } : {}),
      });
      if (hold.status === "held" && hold.over_cap) await (await import("@/services/growth/ad-plan-yes")).askBudgetRaiseOnce(d.tenant_id, null);
      if (hold.status === "refused") return { ok: false, error: hold.error };
      const unheld = budgetMustHold(d, hold);
      if (unheld) return { ok: false, error: unheld };
      const budgetRefusal = await runAdBudgetChecks(hold, () =>
        googleBudgetRefusal(d.tenant_id, null),
      );
      if (budgetRefusal) return { ok: false, error: budgetRefusal };
      let body = hold.status === "held" ? { ...p, name: prefixAdName(p.name, 255) } : p;
      const unlabelled = await noteAdSpendRef(hold, { kind: "google_campaign_name", name: body.name });
      if (unlabelled) return { ok: false, error: unlabelled };

      let r: Awaited<ReturnType<typeof googleCreateCampaign>>;
      try {
        if (d.approved_by_source === "cgo") {
          const { withClickBiddingWhenBlind, readAccountConversions30d } = await import("@/services/tools/google-ads/write/_launch-defaults");
          const conversions = await beforeSend(() => readAccountConversions30d(d.tenant_id));
          body = withClickBiddingWhenBlind(body, conversions);
        }
        r = await googleCreateCampaign(d.tenant_id, body);
      } catch (e) {
        await settleAdSpendAfterError(hold, e);
        if (e instanceof ExpectedToolError && (e.code === "google_ads_demand_gen_logo_mismatch" || e.code === "google_ads_ad_image_mismatch")) {
          return { ok: false, code: e.code, error: `${e.code}: ${e.message}` };
        }
        throw e;
      }
      await commitAdSpend(hold, r.campaign_id);
      const paused = await checkCreatedPaused({ tenant_id: d.tenant_id, action_id: d.id, campaign_id: r.campaign_id });
      const adGroupNote = r.ad_group_id ? ` with ad group \`${r.ad_group_id}\`` : "";
      let bidNote = `Bidding: ${body.bidding.strategy}.`;
      try {
        const { cpcCeilingReadBack } = await import("@/services/tools/google-ads/write/_launch-defaults");
        const { biddingLabel } = await import("@/services/tools/google-ads/write/_change-rows");
        const capNote = cpcCeilingReadBack(body.bidding, paused.cpc_bid_ceiling_micros);
        bidNote = `Bidding: ${biddingLabel(body.bidding)}${
          body.bidding_replaced ? ` (replaced ${biddingLabel(body.bidding_replaced)}: no conversions in the last 30 days)` : ""
        }.${capNote ? ` ${capNote}` : ""}`;
      } catch (e) {
        console.warn(`[dispatch-decision google_ads.create_campaign] bidding note for ${r.campaign_id} not built: ${(e as Error).message}`);
      }
      const kind = p.channel_type === "DEMAND_GEN" ? "Demand Gen video" : p.channel_type === "PERFORMANCE_MAX" ? "Performance Max" : p.channel_type;
      const founderAsk = founderVerdict === "valid";
      const endCheck = !testEnd ? "not_needed" : !testEndWritten ? "unsupported" : await verifyGoogleTestEnd(d, r.campaign_id, p.end_date!);
      const stop = testEnd
        ? await armCreatedTestStop(d.tenant_id, d.id, testEnd, { platform: "google", level: "campaign", account_id: () => gadsCustomerId(d.tenant_id), object_id: String(r.campaign_id), billing_scope: "object", daily_usd: p.daily_budget_usd, name: body.name })
        : ({ ok: true, line: null } as const);
      if (!stop.ok && endCheck === "verified" && paused.paused === true && (d.approved_by_source === "cgo" || founderAsk) && body.location_ids.length > 0) {
        return {
          ok: false,
          code: "exec_partial",
          error: `Created Google Ads ${kind} campaign "${body.name}" (\`${r.campaign_id}\`) at $${p.daily_budget_usd}/day, but it is still PAUSED and not spending: Zavi could not set up the pause that guards this test's spend, so it did not switch it on. Switch it on in Google Ads when you want it to run.`,
          created: { platform: "google", object_type: "campaign", id: String(r.campaign_id), status: "PAUSED" },
        };
      }
      const stopLine = stop.ok && stop.line ? ` ${stop.line}` : "";
      if (paused.paused === true && (d.approved_by_source === "cgo" || founderAsk) && body.location_ids.length > 0 && endCheck !== "not_needed" && endCheck !== "verified") {
        const why = endCheck === "unsupported"
          ? "Zavi cannot give a video campaign an end date, so it did not switch this test on by itself"
          : `Zavi could not confirm Google stored its end date (it should stop after ${dayWords(dayBefore(p.end_date!)) ?? dayBefore(p.end_date!)}), so it did not switch it on`;
        return {
          ok: false,
          code: "exec_partial",
          error: `Created Google Ads ${kind} campaign "${body.name}" (\`${r.campaign_id}\`) at $${p.daily_budget_usd}/day, but it is still PAUSED and not spending: ${why}. Switch it on in Google Ads when you want it to run${endCheck === "unsupported" ? ", and pause it when the test ends" : ""}.`,
          created: { platform: "google", object_type: "campaign", id: String(r.campaign_id), status: "PAUSED" },
        };
      }
      if (paused.paused === true && (d.approved_by_source === "cgo" || founderAsk) && body.location_ids.length > 0) {
        const on = await googleEnableCreatedCampaign(d, r, p.daily_budget_usd, founderAsk ? "founder" : "cgo");
        if (founderAsk && !on.enabled) {
          return {
            ok: false,
            code: "exec_partial",
            error: `Created Google Ads ${kind} campaign "${body.name}" (\`${r.campaign_id}\`) at $${p.daily_budget_usd}/day, but it is still PAUSED and not spending. ${on.note} Switch it on in Google Ads, or ask me to.`,
            created: { platform: "google", object_type: "campaign", id: String(r.campaign_id), status: "PAUSED" },
          };
        }
        return {
          ok: true,
          notice: `✅ Created Google Ads ${kind} campaign "${body.name}" (\`${r.campaign_id}\`)${adGroupNote}, $${p.daily_budget_usd}/day. ${bidNote} ${on.note}${endCheck === "verified" ? ` It stops on its own after ${dayWords(dayBefore(p.end_date!)) ?? dayBefore(p.end_date!)}, when the test ends.${stopLine}` : ""}`,
          agent_outcome: JSON.stringify({ campaign_id: r.campaign_id, ad_group_id: r.ad_group_id, enabled: on.enabled, bidding: body.bidding.strategy }),
          created: on.enabled && on.verified
            ? { platform: "google", object_type: "campaign", id: String(r.campaign_id), status: "ENABLED", activated_at: new Date().toISOString() }
            : { platform: "google", object_type: "campaign", id: String(r.campaign_id), status: on.enabled ? "UNVERIFIED" : "PAUSED" },
        };
      }
      if (paused.paused === true) {
        return {
          ok: true,
          notice: `✅ Created Google Ads ${kind} campaign "${body.name}" (\`${r.campaign_id}\`)${adGroupNote} — PAUSED, $${p.daily_budget_usd}/day. ${bidNote} ${
            p.demand_gen_ad_group
              ? "Its ad group and video ad are ready under the paused campaign: one approved enable of the campaign makes it eligible to serve."
              : p.pmax_asset_group
                ? `Its asset group${r.asset_group_id ? ` \`${r.asset_group_id}\`` : ""} (images, copy and logo) is ready under the paused campaign: one approved enable of the campaign makes it eligible to serve.`
                : "Approve a separate ENABLED change to start spend."
          }${
            endCheck === "verified"
              ? ` It stops on its own after ${dayWords(dayBefore(p.end_date!)) ?? dayBefore(p.end_date!)}, when the test ends.${stop.ok ? stopLine : " Zavi could not set up the pause that guards this test's spend, so check it before switching it on."}`
              : testEndWritten
                ? " Zavi could not confirm Google stored its end date, so check it before switching it on."
                : ""
          }`,
          created: { platform: "google", object_type: "campaign", id: String(r.campaign_id), status: "PAUSED" },
        };
      }
      if (testEnd && ((endCheck !== "verified" && endCheck !== "not_needed") || !stop.ok)) {
        let off = false;
        try {
          await googleSetCampaignStatus(d.tenant_id, { campaign_resource: r.campaign_resource, status: "PAUSED" });
          off = (await gadsGetCampaign(d.tenant_id, r.campaign_id)).status === "PAUSED";
        } catch (e) {
          console.warn(`[dispatch-decision google_ads.create_campaign] ${d.id}: safety pause of ${r.campaign_id} failed: ${(e as Error).message.slice(0, 200)}`);
        }
        void logEvent({ level: "error", source: "google_ads.create_campaign", code: off ? "test_create_live_paused" : "test_create_live_unpaused", tenant_id: d.tenant_id, message: `action=${d.id} campaign=${r.campaign_id}: status ${paused.status ?? "unread"}, end ${endCheck}, stop ${stop.ok ? "armed" : "not armed"}; ${off ? "paused by Zavi" : "pause NOT confirmed"}` });
        return {
          ok: false,
          code: "exec_partial",
          error: off
            ? `Created Google Ads ${kind} campaign "${body.name}" (\`${r.campaign_id}\`), but Google did not show it paused with its end date${stop.ok ? "" : " and Zavi could not set up the pause that guards this test's spend"}, so Zavi paused it. It is not spending. Check it in Google Ads before switching it on.`
            : `Created Google Ads ${kind} campaign "${body.name}" (\`${r.campaign_id}\`), but Google did not show it paused with its end date${stop.ok ? "" : " and Zavi could not set up the pause that guards this test's spend"}, and Zavi could not confirm pausing it. It may be spending: check it in Google Ads now.`,
          created: { platform: "google", object_type: "campaign", id: String(r.campaign_id), status: off ? "PAUSED" : "UNVERIFIED" },
        };
      }
      return {
        ok: true,
        notice:
          paused.paused === false
            ? `⚠️ Created Google Ads ${kind} campaign "${body.name}" (\`${r.campaign_id}\`)${adGroupNote}, $${p.daily_budget_usd}/day. It was sent PAUSED, but Google reports it as ${paused.status ?? "unknown"}. Zavi changed nothing and has alerted the team; check it in Google Ads.`
            : `✅ Created Google Ads ${kind} campaign "${body.name}" (\`${r.campaign_id}\`)${adGroupNote}, sent PAUSED at $${p.daily_budget_usd}/day. Zavi could not read it back to confirm it is paused and has alerted the team.`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "google_ads.update_campaign": async (d) => {
    const parsed = updateCampaignBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `google_ads.update_campaign body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      if (p.target_cpa_usd !== undefined) {
        const currencyRefusal = await googleCurrencyRefusal(d.tenant_id, "the campaign was not changed");
        if (currencyRefusal) return currencyRefusal;
      }
      const live = await gadsGetCampaign(d.tenant_id, p.campaign_id);
      const videoRefusal = videoMutateRefusal(live.channel_type);
      if (videoRefusal) return videoRefusal;
      const r = await googleUpdateCampaign(d.tenant_id, live, p);
      return {
        ok: true,
        notice: `✅ Updated Google Ads campaign \`${p.campaign_id}\` (${r.updated_fields.join(", ")}).`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "google_ads.replace_geo_targets_review": async (d) => {
    const parsed = replaceGeoTargetsBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `google_ads.replace_geo_targets_review body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      const live = await gadsGetCampaign(d.tenant_id, p.campaign_id);
      const r = await googleReplaceGeoTargets(d.tenant_id, live, p);
      await logAdGeoChange(d, "google", r.verified ? "applied" : "applied_unverified");
      return {
        ok: true,
        notice: r.verified
          ? `✅ Google Ads campaign \`${p.campaign_id}\` now shows in: ${p.place_names.join(", ")}.`
          : `⚠️ Google Ads accepted the new places for campaign \`${p.campaign_id}\` (${p.place_names.join(", ")}), but Zavi could not read them back to confirm. Check it in Google Ads.`,
      };
    } catch (e) {
      await logAdGeoChange(d, "google", "refused", e);
      if (e instanceof ExpectedToolError) return { ok: false, code: e.code, error: `${e.code}: ${e.message}` };
      return { ok: false, error: (e as Error).message };
    }
  },

  "google_ads.create_ad_group": async (d) => {
    const parsed = createAdGroupBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `google_ads.create_ad_group body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      if (p.cpc_bid_usd !== undefined || p.cpv_bid_usd !== undefined || p.cpm_bid_usd !== undefined) {
        const currencyRefusal = await googleCurrencyRefusal(d.tenant_id, "nothing was created");
        if (currencyRefusal) return currencyRefusal;
      }
      const campaign = await gadsGetCampaign(d.tenant_id, p.campaign_id);
      const videoRefusal = videoMutateRefusal(campaign.channel_type);
      if (videoRefusal) return videoRefusal;
      const r = await googleCreateAdGroup(d.tenant_id, campaign, p);
      return {
        ok: true,
        notice: `✅ Created ad group "${p.name}" (\`${r.ad_group_id}\`) in Google Ads campaign \`${p.campaign_id}\` — PAUSED, ${p.keywords.length} keyword(s), ${p.ads.length} ad(s).`,
        created: { platform: "google", object_type: "ad_group", id: String(r.ad_group_id), status: "PAUSED" },
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "google_ads.update_ad_group": async (d) => {
    const parsed = updateAdGroupBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `google_ads.update_ad_group body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      if (p.cpc_bid_usd !== undefined || p.cpv_bid_usd !== undefined || p.cpm_bid_usd !== undefined) {
        const currencyRefusal = await googleCurrencyRefusal(d.tenant_id, "the ad group was not changed");
        if (currencyRefusal) return currencyRefusal;
      }
      const live = await gadsGetAdGroup(d.tenant_id, p.ad_group_id);
      const videoRefusal = videoAdGroupRefusal(live.type);
      if (videoRefusal) return videoRefusal;
      const r = await googleUpdateAdGroup(d.tenant_id, live, p);
      return {
        ok: true,
        notice: `✅ Updated Google Ads ad group \`${p.ad_group_id}\` (${r.updated_fields.join(", ")}).`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "google_ads.create_ad": async (d) => {
    const parsed = createAdBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `google_ads.create_ad body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      const adGroup = await gadsGetAdGroup(d.tenant_id, p.ad_group_id);
      const videoRefusal = videoAdGroupRefusal(adGroup.type);
      if (videoRefusal) return videoRefusal;
      const r = await googleCreateAd(d.tenant_id, adGroup, p);
      return {
        ok: true,
        notice: `✅ Created ${p.ad.kind.replace(/_/g, " ")} ad \`${r.ad_id}\` in Google Ads ad group \`${p.ad_group_id}\` — PAUSED.`,
        created: { platform: "google", object_type: "ad", id: String(r.ad_id), status: "PAUSED" },
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "google_ads.add_keywords": async (d) => {
    const parsed = addKeywordsBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `google_ads.add_keywords body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const p = parsed.data;
    try {
      const videoRefusal =
        p.level === "ad_group" && p.ad_group_id
          ? videoAdGroupRefusal((await gadsGetAdGroup(d.tenant_id, p.ad_group_id)).type)
          : p.campaign_id
            ? videoMutateRefusal((await gadsGetCampaignBudget(d.tenant_id, p.campaign_id)).channel_type)
            : null;
      if (videoRefusal) return videoRefusal;
      const r = await googleAddKeywords(d.tenant_id, p);
      return {
        ok: true,
        notice: `✅ Added ${r.created} ${p.negative ? "negative " : ""}keyword(s) to Google Ads ${p.level.replace("_", " ")} \`${p.level === "ad_group" ? p.ad_group_id : p.campaign_id}\`.`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "google_ads.remove_resource": async (d) => {
    const parsed = removeResourceBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `google_ads.remove_resource body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    try {
      const b = parsed.data;
      const videoRefusal =
        b.level === "campaign" || (b.level === "keyword" && b.scope === "campaign")
          ? videoMutateRefusal((await gadsGetCampaignBudget(d.tenant_id, b.level === "campaign" ? b.campaign_id : b.parent_id)).channel_type)
          : videoAdGroupRefusal((await gadsGetAdGroup(d.tenant_id, b.level === "keyword" ? b.parent_id : b.ad_group_id)).type);
      if (videoRefusal) return videoRefusal;
      const r = await googleRemoveResource(d.tenant_id, parsed.data);
      return { ok: true, notice: `✅ Removed Google Ads ${r.label}.` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "praxis.dispatch_specialist": async (d) => {
    const parsed = dispatchSpecialistBody.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `dispatch_specialist body invalid: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    const {
      target_agent_slug,
      intent,
      origin_decision_id,
      dispatched_by,
      repo_hint,
      site_id,
      file_hints,
      context_summary,
      source_agent,
      goal_id,
    } = parsed.data;
    if (
      target_agent_slug === "chief-of-staff" ||
      target_agent_slug === "operator" ||
      target_agent_slug === "cgo"
    ) {
      return { ok: false, error: `target '${target_agent_slug}' is not dispatchable` };
    }
    try {
      const { getVisibleAgentSlugs } = await import("@/services/agents/visibility");
      const { enqueueAgentRun } = await import("@/services/agents/runner");
      const { CGO_AD_CHANNELS, cgoAdBudget } = await import("@/services/growth/cgo-ads");
      const cgoAdMove =
        d.decision_class === "cgo.dispatch-specialist" && CGO_AD_CHANNELS.has(target_agent_slug);
      const { CGO_ORGANIC_TARGETS } = await import("@/services/growth/goal-owner");
      const cgoOrganicMove =
        d.decision_class === "cgo.dispatch-specialist" && CGO_ORGANIC_TARGETS.has(target_agent_slug);
      const cgoChannelMove = cgoAdMove || cgoOrganicMove;
      let adBudgetNow: Awaited<ReturnType<typeof cgoAdBudget>> = null;
      let cgoBrief: import("@/services/growth/cgo-brief").CgoBrief | null = null;
      const visible = cgoChannelMove ? null : await getVisibleAgentSlugs(d.tenant_id);
      if (visible && !visible.has(target_agent_slug)) {
        return {
          ok: false,
          error: `target '${target_agent_slug}' is not a visible agent for this tenant`,
        };
      }
      if (d.decision_class === "cgo.dispatch-specialist") {
        if (!goal_id) return { ok: false, error: "cgo card has no goal" };
        const { CGO_TARGETS, endedReason, goalRev, utcDay } = await import("@/services/growth/goal-owner");
        if (!CGO_TARGETS.has(target_agent_slug) && !cgoChannelMove) {
          return { ok: false, error: `target '${target_agent_slug}' is not a cgo target` };
        }
        if (cgoAdMove) {
          adBudgetNow = await cgoAdBudget(d.tenant_id);
          if (!adBudgetNow && !(await (await import("@/services/approvals/envelope-door")).founderEnvelopeCovers(d, target_agent_slug))) {
            return { ok: false, error: `the ad budget is off, so cgo does not run ${target_agent_slug}` };
          }
          const { asTenantId, tenantClient } = await import("@/services/tenant-client");
          const { data: adCh, error: adChErr } = await tenantClient(asTenantId(d.tenant_id))
            .from("tenant_channels")
            .select("plan_selected_set_by")
            .eq("tenant_id", d.tenant_id)
            .eq("channel_slug", target_agent_slug)
            .maybeSingle<{ plan_selected_set_by: string | null }>();
          if (adChErr) return { ok: false, error: `channel check failed: ${adChErr.message}` };
          if (adCh?.plan_selected_set_by === "founder_stopped") {
            return { ok: false, error: `you stopped ${target_agent_slug}, so cgo does not run it` };
          }
        }
        if (cgoOrganicMove) {
          const { getBoolSettingStrictResolved } = await import("@/services/settings");
          if (!(await getBoolSettingStrictResolved("cgo_autopilot_enabled", d.tenant_id))) {
            return { ok: false, error: `Autopilot is off, so cgo does not run ${target_agent_slug}` };
          }
          const { asTenantId, tenantClient } = await import("@/services/tenant-client");
          const { data: ch, error: chErr } = await tenantClient(asTenantId(d.tenant_id))
            .from("tenant_channels")
            .select("plan_selected, plan_selected_set_by")
            .eq("tenant_id", d.tenant_id)
            .eq("channel_slug", target_agent_slug)
            .maybeSingle<{ plan_selected: boolean | null; plan_selected_set_by: string | null }>();
          if (chErr) return { ok: false, error: `channel check failed: ${chErr.message}` };
          if (ch?.plan_selected_set_by === "founder_stopped") {
            return { ok: false, error: `you stopped ${target_agent_slug}, so cgo does not run it` };
          }
          if (ch && ch.plan_selected === false && ch.plan_selected_set_by === "founder") {
            return { ok: false, error: `you took ${target_agent_slug} out of the plan, so cgo does not run it` };
          }
        }
        if (target_agent_slug === "engineer" && !repo_hint) {
          return { ok: false, error: "engineer card has no repo" };
        }
        const { serviceClient: svc } = await import("@/services/supabase");
        const { data: goalRow, error: goalErr } = await svc()
          .from("autopilot_goals")
          .select("id, objective, target_metric, target_value, baseline_value, current_value, current_value_at, current_value_source, due_date, status, priority, measurement_mode, count_rule")
          .eq("id", goal_id)
          .eq("tenant_id", d.tenant_id)
          .maybeSingle<import("@/services/growth/goal-owner").GoalRow>();
        if (goalErr) return { ok: false, error: `goal check failed: ${goalErr.message}` };
        if (!goalRow || goalRow.status !== "active" || endedReason(goalRow, utcDay()) !== null) {
          return { ok: false, error: "this goal is no longer active" };
        }
        if (parsed.data.goal_rev !== goalRev(goalRow)) {
          return { ok: false, error: "this goal changed since the move was proposed" };
        }
        const { checkAgentTier, planUpgradeMessage } = await import("@/services/agents/entitlement");
        const tier = await checkAgentTier(d.tenant_id, target_agent_slug);
        if (!tier.allowed) {
          return { ok: false, error: planUpgradeMessage(target_agent_slug, tier.required_tier) };
        }
        if (cgoChannelMove) {
          const { numberTrusted } = await import("@/services/growth/goal-owner");
          const { buildCgoBrief } = await import("@/services/growth/cgo-brief");
          cgoBrief = buildCgoBrief({
            goal: goalRow,
            number_trusted: numberTrusted(goalRow, utcDay()),
            body: { ...parsed.data },
            kind: cgoAdMove ? "ad" : "organic",
            adLeftUsd: adBudgetNow?.left_usd ?? null,
          });
        }
      }
      let channel_slug = "";
      if (cgoChannelMove) {
        const { admitDirectChannelRun } = await import("@/services/channels/direct-run");
        const admission = await admitDirectChannelRun(d.tenant_id, target_agent_slug);
        if (!admission.allowed) return { ok: false, error: admission.message };
        channel_slug = admission.channel_slug;
      }
      const hypId = (d.body as { hypothesis_id?: unknown } | null)?.hypothesis_id;
      if (d.decision_class === "cgo.dispatch-specialist" && d.approved_by_source === "cgo" && typeof hypId === "string" && hypId) {
        const { serviceClient: hsvc } = await import("@/services/supabase");
        const { data: hypRow, error: hypErr } = await hsvc()
          .from("cgo_hypotheses")
          .select("status, evidence")
          .eq("id", hypId)
          .eq("tenant_id", d.tenant_id)
          .maybeSingle<{ status: "listed" | "testing" | "confirmed" | "ruled_out"; evidence: unknown }>();
        if (hypErr) return { ok: false, error: `hypothesis check failed: ${hypErr.message}` };
        const { foundersNo } = await import("@/services/growth/cgo-hypotheses");
        if (hypRow && foundersNo({ status: hypRow.status, evidence: Array.isArray(hypRow.evidence) ? hypRow.evidence : [] })) {
          return { ok: false, error: "you said the idea behind this is not true for your business, so cgo does not start it" };
        }
      }
      const { run_id } = await enqueueAgentRun({
        agent_slug: target_agent_slug,
        tenant_id: d.tenant_id,
        trigger: "a2a",
        payload: {
          intent,
          dispatched_by: dispatched_by ?? "chief-of-staff",
          source_decision_id: d.id,
          ...(origin_decision_id ? { origin_decision_id } : {}),
          ...(repo_hint ? { task_description: intent, repo_hint } : {}),
          ...(target_agent_slug === "engineer" && site_id ? { site_id } : {}),
          ...(file_hints && file_hints.length ? { file_hints } : {}),
          ...(context_summary ? { context_summary } : {}),
          ...(source_agent ? { source_agent } : {}),
          ...(goal_id ? { goal_id } : {}),
          ...(cgoBrief && parsed.data.goal_rev ? { goal_rev: parsed.data.goal_rev } : {}),
          ...(dispatched_by === "cgo" && !cgoBrief && parsed.data.problem ? { problem: parsed.data.problem } : {}),
          ...(dispatched_by === "cgo" && !cgoBrief && parsed.data.goal_rev ? { goal_rev: parsed.data.goal_rev } : {}),
          ...(cgoBrief ? { cgo_brief: cgoBrief } : {}),
          ...(cgoChannelMove ? { message: intent } : {}),
        },
      });
      if (channel_slug) {
        const { stampDirectChannelRun } = await import("@/services/channels/direct-run");
        await stampDirectChannelRun(d.tenant_id, run_id, channel_slug);
      }
      console.log(
        `[dispatch-decision praxis.dispatch_specialist] enqueued ${target_agent_slug} run ${run_id} for tenant ${d.tenant_id} (decision ${d.id})`,
      );
      return {
        ok: true,
        notice: `✅ Dispatched @${target_agent_slug} — run \`${run_id}\`. Its result will surface in your next digest's continuity.`,
      };
    } catch (e) {
      if ((e as { code?: string }).code === "fleet_halted") {
        return { ok: false, error: "fleet_halted" };
      }
      return { ok: false, error: (e as Error).message };
    }
  },

  "pm.needs_action": async (d) => {
    const { performNeedsAction } = await import("@/agents/pm/needs-action");
    const { enqueueAgentRun } = await import("@/services/agents/runner");
    return performNeedsAction(d, {
      enqueue: (input) => enqueueAgentRun(input),
      closePr: async ({ tenant_id, run_id, owner, repo, pull_number }) => {
        const r = await callMcpTool(
          { tenant_id, run_id },
          "github",
          "close_pr",
          { owner, repo, pull_number },
        );
        return r.is_error ? { ok: false, error: r.content } : { ok: true };
      },
      log: (evt) => logEvent(evt),
    });
  },

  "praxis.create_standing_order": async (d) => {
    try {
      const { createStandingOrderFromDecision } = await import(
        "@/services/agents/standing-orders"
      );
      const { validateCronExpression } = await import("./cron-match");
      const r = await createStandingOrderFromDecision(d.tenant_id, d.body, {
        validateCron: validateCronExpression,
        upsertScheduleRow: async (row) => {
          const { error } = await serviceClient()
            .from("tenant_agent_schedules")
            .upsert(row, { onConflict: "tenant_id,agent_slug" });
          return { error: error ? { message: error.message } : null };
        },
      });
      return r.ok
        ? { ok: true, notice: r.notice }
        : { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "praxis.create_channel_standing_order": async (d) => {
    try {
      if (!d.agent_run_id) {
        return { ok: false, error: "channel standing order has no originating run" };
      }
      const { data: run } = await serviceClient()
        .from("agent_runs")
        .select("agent_slug")
        .eq("id", d.agent_run_id)
        .maybeSingle();
      const run_agent_slug = (run as { agent_slug?: string } | null)?.agent_slug;
      if (!run_agent_slug) {
        return { ok: false, error: "originating run not found" };
      }
      const { createChannelStandingOrderFromDecision } = await import(
        "@/services/agents/standing-orders"
      );
      const { validateCronExpression, isValidTimeZone } = await import("./cron-match");
      const r = await createChannelStandingOrderFromDecision(
        d.tenant_id,
        d.body,
        {
          validateCron: validateCronExpression,
          validateTimeZone: isValidTimeZone,
          upsertScheduleRow: async (row) => {
            const { error } = await serviceClient()
              .from("tenant_agent_schedules")
              .upsert(row, { onConflict: "tenant_id,agent_slug" });
            return { error: error ? { message: error.message } : null };
          },
        },
        run_agent_slug,
      );
      return r.ok
        ? { ok: true, notice: r.notice }
        : { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "praxis.create_research_watch": async (d) => {
    try {
      const { createResearchWatchFromDecision } = await import(
        "@/services/agents/standing-orders"
      );
      const { validateCronExpression } = await import("./cron-match");
      const r = await createResearchWatchFromDecision(d.tenant_id, d.body, {
        validateCron: validateCronExpression,
        upsertScheduleRow: async (row) => {
          const { error } = await serviceClient()
            .from("tenant_agent_schedules")
            .upsert(row, { onConflict: "tenant_id,agent_slug" });
          return { error: error ? { message: error.message } : null };
        },
      });
      return r.ok
        ? { ok: true, notice: r.notice }
        : { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "digest.post": digestPostHandler,

  "autopilot.daily_plan_approve": async (d) => {
    const body = (d.body ?? {}) as { conductor_run_id?: unknown };
    const conductor_run_id =
      typeof body.conductor_run_id === "string" && body.conductor_run_id.length > 0
        ? body.conductor_run_id
        : null;
    if (!conductor_run_id) {
      return {
        ok: false,
        error: "autopilot.daily-plan body missing conductor_run_id",
      };
    }
    const svc = serviceClient();
    const { data, error } = await svc
      .from("conductor_runs")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", conductor_run_id)
      .eq("tenant_id", d.tenant_id)
      .eq("status", "proposed")
      .select("id")
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: `autopilot.daily-plan flip failed: ${error.message}`,
      };
    }
    if (!data) {
      return {
        ok: false,
        error:
          `autopilot.daily-plan flip no-op — conductor_run ${conductor_run_id} not in status='proposed' ` +
          `for tenant ${d.tenant_id} (already approved, rejected, or cross-tenant body)`,
      };
    }
    return {
      ok: true,
      notice: `Activated daily plan. The Conductor will start ticking the goal-graph on its next sweep (≤2 min).`,
    };
  },

  "heartbeat.automation_proposal_approve": async (d) => {
    const { data: claimRow, error: claimErr } = await serviceClient()
      .from("decisions")
      .select("id, approved_by")
      .eq("id", d.id)
      .eq("tenant_id", d.tenant_id)
      .maybeSingle();
    if (claimErr) {
      return {
        ok: false,
        error: `heartbeat.automation-proposal approved-status read failed: ${claimErr.message}`,
      };
    }
    if (!claimRow || (claimRow as { approved_by: string | null }).approved_by == null) {
      return {
        ok: false,
        error:
          `heartbeat.automation-proposal refused — decision ${d.id} has no human approval ` +
          `(approved_by is null; a merely-proposed decision can never create a schedule)`,
      };
    }

    const parsed = heartbeatProposalApproveBody.safeParse(d.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: `heartbeat.automation-proposal body invalid: ${parsed.error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ")}`,
      };
    }
    const { agent_slug, cron_expression, objective } = parsed.data;

    const { validateCronExpression } = await import("./cron-match");
    const cronErr = validateCronExpression(cron_expression);
    if (cronErr) {
      return {
        ok: false,
        error: `heartbeat.automation-proposal cron_expression invalid ("${cron_expression}"): ${cronErr}`,
      };
    }

    let schedulable: boolean;
    try {
      const { isAgentSchedulable } = await import("@/services/agents/visibility");
      schedulable = await isAgentSchedulable(d.tenant_id, agent_slug);
    } catch (e) {
      return {
        ok: false,
        error: `heartbeat.automation-proposal schedulability check failed (fail-closed): ${(e as Error).message}`,
      };
    }
    if (!schedulable) {
      return {
        ok: false,
        error: `heartbeat.automation-proposal refused — agent "${agent_slug}" is not visible/enabled for this tenant`,
      };
    }

    const { error } = await serviceClient()
      .from("tenant_agent_schedules")
      .upsert(
        {
          tenant_id: d.tenant_id,
          agent_slug,
          cron_expression,
          enabled: true,
          payload_template: { objective, source: "heartbeat.automation-proposal" },
        },
        { onConflict: "tenant_id,agent_slug" },
      );
    if (error) {
      return {
        ok: false,
        error: `heartbeat.automation-proposal schedule upsert failed: ${error.message}`,
      };
    }
    return {
      ok: true,
      notice: `Scheduled \`${agent_slug}\` to run automatically (\`${cron_expression}\`). It'll fire on the next matching sweep; pause or re-time it any time from Schedules.`,
    };
  },

  "meta_ads.duplicate_ad_set": async (d) => {
    const parsed = duplicateAdSetBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.duplicate_ad_set body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    const p = parsed.data;
    return metaDuplicateHandler(d, { level: "adset", source_id: p.source_ad_set_id, daily_budget_usd: p.daily_budget_usd, currency: p.currency, name: p.name, places: p.places });
  },
  "meta_ads.duplicate_campaign": async (d) => {
    const parsed = duplicateCampaignBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.duplicate_campaign body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    const p = parsed.data;
    return metaDuplicateHandler(d, { level: "campaign", source_id: p.source_campaign_id, daily_budget_usd: p.daily_budget_usd, currency: p.currency, name: p.name, places: p.places });
  },
  "meta_ads.launch_campaign": async (d) => {
    const parsed = metaLaunchCampaignBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.launch_campaign body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    let testEnd: Awaited<ReturnType<typeof cgoTestEndForRun>>;
    try {
      testEnd = await cgoTestEndForRun(d.tenant_id, d.agent_run_id, new Date());
    } catch (e) {
      console.warn(`[dispatch-decision meta_ads.launch_campaign] ${d.id}: test end unreadable: ${(e as Error).message}`);
      return { ok: false, error: "Zavi could not read this test's end date, so nothing new was created on this attempt. Approve it again in a minute." };
    }
    const p = testEnd ? { ...parsed.data, ad_set: { ...parsed.data.ad_set, end_time: metaTestEndTime(parsed.data.ad_set.end_time, testEnd.ends_on) } } : parsed.data;
    const daily = p.campaign.daily_budget_usd;
    let stopLine = null as string | null;
    const armMetaStop = async (campaign_id: string) => {
      const a = await armCreatedTestStop(d.tenant_id, d.id, testEnd, { platform: "meta", level: "campaign", account_id: async () => (await metaAdsCreds(d.tenant_id)).ad_account_id, object_id: campaign_id, billing_scope: "campaign_budget", daily_usd: daily, name: p.campaign.name });
      if (!a.ok) throw new ExpectedToolError("meta_ads_test_stop_unarmed", `Zavi could not set up the pause that guards this test's spend, so it was not switched on: ${a.why}`, { object_id: campaign_id, stage: "live" });
      stopLine = a.line;
    };
    try {
      const currency = await getAdAccountCurrency(d.tenant_id);
      if (!isWritableCurrency(currency)) {
        return { ok: false, error: `cap_refuse: Meta budget writes support USD and INR ad accounts only; got ${currency}` };
      }
      const currencyMismatch = bodyCurrencyMismatch(p.currency, currency);
      if (currencyMismatch) return { ok: false, error: currencyMismatch };
      const { resolveMetaAdCapability } = await import("@/services/tools/meta-ads/write/_library-ad-capability");
      const capability = await resolveMetaAdCapability(d.tenant_id);
      if (!capability.ok) return { ok: false, code: `meta_ads_${capability.reason_code}`, error: capability.reason };

      if (capGovernsDispatch(d)) {
        const capRead = await readTenantCapAndToday(d.tenant_id, d.id);
        const capWaivedForBudget = await adBudgetStandsInForCap(d, capRead);
        const evalRes = evaluateBudgetCap({
          proposed_daily_budget_usd: daily,
          current_daily_budget_usd: 0,
          today_total_change_usd: capRead.today_total_change_usd,
          cap: capRead.cap,
        });
        if (!capWaivedForBudget && !evalRes.within) return { ok: false, error: `cap_refuse: ${evalRes.reason}` };
      }

      const metaEnd = p.ad_set.end_time ? Date.parse(p.ad_set.end_time) : NaN;
      if (Number.isFinite(metaEnd) && metaEnd <= Date.now()) return { ok: false, error: "The ad set's end time has already passed; nothing was created." };
      const metaEndsOn = Number.isFinite(metaEnd) ? (await import("@/services/growth/ad-plan-shape")).dailyHoldEndsOn(Math.floor(metaEnd / 1000)) : null;
      const hold = await reserveAdSpend(d, { platform: "meta", op: "create", object_id: null, daily_delta_usd: daily, currency, ...(metaEndsOn ? { ends_on: metaEndsOn } : {}) });
      if (hold.status === "refused") return { ok: false, error: hold.error };
      if (hold.status === "held" && hold.over_cap) await (await import("@/services/growth/ad-plan-yes")).askBudgetRaiseOnce(d.tenant_id, null);
      const unheld = budgetMustHold(d, hold);
      if (unheld) return { ok: false, error: unheld };
      const budgetRefusal = await runAdBudgetChecks(hold, async () => (currency.toUpperCase() !== "USD" ? "non_usd_account" : null));
      if (budgetRefusal) return { ok: false, error: budgetRefusal };

      const { metaLaunchCampaign } = await import("@/services/tools/meta-ads/write/launch");
      const { launchTag } = await import("@/services/tools/meta-ads/write/_launch-shapers");
      const tag = launchTag(d.id);
      const campaign_name = hold.status === "held" ? prefixAdName(p.campaign.name, 255) : p.campaign.name;
      const unlabelled = await noteAdSpendRef(hold, { kind: "meta_tag", level: "campaign", campaign_id: "account", tag });
      if (unlabelled) return { ok: false, error: unlabelled };

      let r: Awaited<ReturnType<typeof metaLaunchCampaign>>;
      try {
        r = await metaLaunchCampaign(d.tenant_id, {
          body: p,
          campaign_name,
          tag,
          onCampaign: async (id) => {
            await noteAdSpendObject(hold, id);
            if (testEnd) await armMetaStop(id).catch(() => {});
          },
          ...(testEnd ? { testEndsOn: testEnd.ends_on, beforeLive: async (id: string) => void (await armMetaStop(id)) } : {}),
        });
      } catch (e) {
        await settleAdSpendAfterError(hold, e);
        if (e instanceof ExpectedToolError && e.code === "meta_ads_launch_outcome_unknown") {
          return { ok: false, outcome_unknown: true, code: "exec_outcome_unknown", error: e.message };
        }
        throw e;
      }
      await commitAdSpend(hold, r.campaign_id);
      const builtPaused = p.switch_on === false;
      if (!builtPaused) {
        const notHeld = await holdLaunchLive(d, "meta", r.campaign_id, daily, currency, async () => {
          return withMetaSafety(async () => {
            await metaSetStatus(d.tenant_id, { object_id: r.campaign_id, level: "campaign", status: "PAUSED" });
            const back = (await fbGet(d.tenant_id, r.campaign_id, { fields: "id,status" })) as { status?: string };
            return back?.status === "PAUSED";
          });
        });
        if (notHeld) return notHeld;
      }
      await recordZaviAdChange(d.tenant_id, adChangeFrom(d), {
        platform: "meta",
        object_id: r.campaign_id,
        level: "campaign",
        campaign_id: r.campaign_id,
        object_name: r.name,
        change_kind: "status",
        before_status: null,
        after_status: r.status,
        before_daily_usd: null,
        after_daily_usd: daily,
      });
      const steps = r.receipts.map((x) => `${x.stage.replace("_", " ")} \`${x.id}\` ${x.outcome}`).join(", ");
      const delivery = r.effective_status && r.effective_status !== r.status ? ` (Meta: ${r.effective_status})` : "";
      return {
        ok: true,
        notice: `✅ ${r.reused ? "Found" : builtPaused ? "Built" : "Launched"} campaign "${r.name}" (\`${r.campaign_id}\`), ${r.status} at ${formatMoney(daily, currency)}/day${delivery}.${builtPaused ? " It stays paused until you switch it on." : ""} ${steps}.${stopLine ? ` ${stopLine}` : ""}`,
        agent_outcome: JSON.stringify({
          campaign_id: r.campaign_id,
          ad_set_id: r.ad_set_id,
          ad_id: r.ad_id,
          status: r.status,
          effective_status: r.effective_status,
          daily_budget_usd: daily,
          receipts: r.receipts,
        }),
        created: { platform: "meta", object_type: "campaign", id: r.campaign_id, status: r.status === "ACTIVE" ? "ACTIVE" : "PAUSED" },
      };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },
  "meta_ads.create_custom_audience": async (d) => {
    const parsed = createCustomAudienceBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.create_custom_audience body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    try {
      const { metaCreateWebsiteAudience } = await import("@/services/tools/meta-ads/write/launch");
      const { launchTag } = await import("@/services/tools/meta-ads/write/_launch-shapers");
      const r = await metaCreateWebsiteAudience(d.tenant_id, {
        retention_days: parsed.data.retention_days,
        pixel_id: parsed.data.pixel_id,
        tag: launchTag(d.id),
      });
      const size = r.approximate_count === null ? "" : ` About ${r.approximate_count.toLocaleString("en-US")} people so far.`;
      return {
        ok: true,
        notice: `✅ ${r.reused ? "Reused" : "Created"} the audience "${r.name}" (\`${r.audience_id}\`), website visitors in the last ${parsed.data.retention_days} days on pixel \`${r.pixel_id}\`.${size}`,
        agent_outcome: JSON.stringify({ audience_id: r.audience_id, pixel_id: r.pixel_id, approximate_count: r.approximate_count, reused: r.reused }),
      };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },
  "meta_ads.update_ad_set": async (d) => {
    const parsed = metaUpdateAdSetBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.update_ad_set body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    const p = parsed.data;
    try {
      const r = await metaUpdateAdSet(d.tenant_id, p);
      return { ok: true, notice: `✅ Updated Meta ad set \`${p.ad_set_id}\` (${r.updated_fields.join(", ")}).` };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "meta_ads.update_ad": async (d) => {
    const parsed = metaUpdateAdBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.update_ad body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    const p = parsed.data;
    try {
      const r = await metaUpdateAd(d.tenant_id, p);
      return { ok: true, notice: `✅ Updated Meta ad \`${p.ad_id}\` (${r.updated_fields.join(", ")}).` };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "meta_ads.duplicate_ad": async (d) => {
    const parsed = metaDuplicateAdBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.duplicate_ad body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    const p = parsed.data;
    try {
      const { launchTag } = await import("@/services/tools/meta-ads/write/_launch-shapers");
      const r = await metaDuplicateAd(d.tenant_id, { ...p, tag: launchTag(d.id) });
      return {
        ok: true,
        notice: `✅ ${r.reused ? "Found" : "Copied"} ad \`${p.source_ad_id}\` into ad set \`${p.ad_set_id}\` as "${r.name}" (\`${r.id}\`), switched on.`,
        created: { platform: "meta", object_type: "ad", id: r.id, status: "ACTIVE" },
      };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "meta_ads.create_creative": async (d) => {
    const parsed = metaCreateCreativeBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.create_creative body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    try {
      const { launchTag } = await import("@/services/tools/meta-ads/write/_launch-shapers");
      const r = await metaCreateCreative(d.tenant_id, { ...parsed.data, tag: launchTag(d.id) });
      return {
        ok: true,
        notice: `✅ ${r.reused ? "Found" : "Created"} creative "${r.name}" (\`${r.id}\`). It runs nowhere until an ad uses it.`,
        agent_outcome: JSON.stringify({ creative_id: r.id, name: r.name }),
      };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "meta_ads.update_creative": async (d) => {
    const parsed = metaUpdateCreativeBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.update_creative body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    try {
      await metaUpdateCreative(d.tenant_id, parsed.data);
      return { ok: true, notice: `✅ Renamed creative \`${parsed.data.creative_id}\` to "${parsed.data.new_name}".` };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "meta_ads.upload_asset": async (d) => {
    const parsed = metaUploadAssetBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.upload_asset body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    try {
      const r = await metaUploadAsset(d.tenant_id, parsed.data);
      return r.kind === "image"
        ? { ok: true, notice: `✅ Added image "${parsed.data.name}" to the ad account (hash \`${r.hash}\`).`, agent_outcome: JSON.stringify({ image_hash: r.hash, url: r.url }) }
        : { ok: true, notice: `✅ Sent video "${parsed.data.name}" to the ad account (\`${r.video_id}\`); Meta processes it before it can run.`, agent_outcome: JSON.stringify({ video_id: r.video_id }) };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "meta_ads.create_lookalike_audience": async (d) => {
    const parsed = metaCreateLookalikeBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.create_lookalike_audience body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    try {
      const { launchTag } = await import("@/services/tools/meta-ads/write/_launch-shapers");
      const r = await metaCreateLookalikeAudience(d.tenant_id, { ...parsed.data, tag: launchTag(d.id) });
      return {
        ok: true,
        notice: `✅ ${r.reused ? "Found" : "Created"} lookalike audience "${r.name}" (\`${r.id}\`). Meta fills it over the next hours.`,
        agent_outcome: JSON.stringify({ audience_id: r.id, name: r.name }),
      };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "meta_ads.create_custom_conversion": async (d) => {
    const parsed = metaCreateCustomConversionBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.create_custom_conversion body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    try {
      const { launchTag } = await import("@/services/tools/meta-ads/write/_launch-shapers");
      const r = await metaCreateCustomConversion(d.tenant_id, { ...parsed.data, tag: launchTag(d.id) });
      return {
        ok: true,
        notice: `✅ ${r.reused ? "Found" : "Created"} custom conversion "${r.name}" (\`${r.id}\`).`,
        agent_outcome: JSON.stringify({ custom_conversion_id: r.id, name: r.name }),
      };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "meta_ads.create_lead_form": async (d) => {
    const parsed = metaCreateLeadFormBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.create_lead_form body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    try {
      const { launchTag } = await import("@/services/tools/meta-ads/write/_launch-shapers");
      const r = await metaCreateLeadForm(d.tenant_id, { ...parsed.data, tag: launchTag(d.id) });
      return {
        ok: true,
        notice: `✅ ${r.reused ? "Found" : "Created"} lead form "${r.name}" (\`${r.id}\`) on Page \`${parsed.data.page_id}\`.`,
        agent_outcome: JSON.stringify({ lead_form_id: r.id, name: r.name }),
      };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "meta_ads.create_ad": async (d) => {
    const parsed = metaCreateAdBodySchema.safeParse(d.body);
    if (!parsed.success) {
      return { ok: false, error: `meta_ads.create_ad body invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    const p = parsed.data;
    try {
      const currency = await getAdAccountCurrency(d.tenant_id);
      if (!isWritableCurrency(currency)) {
        return { ok: false, error: `cap_refuse: Meta budget writes support USD and INR ad accounts only; got ${currency}` };
      }
      const { metaCreateLaunchAd } = await import("@/services/tools/meta-ads/write/launch");
      const { launchTag } = await import("@/services/tools/meta-ads/write/_launch-shapers");
      const r = await metaCreateLaunchAd(d.tenant_id, {
        ad_set_id: p.ad_set_id,
        image_url: p.image_url,
        video_asset_id: p.video_asset_id,
        source_ad_id: p.source === "copy" ? p.source_ad_id : undefined,
        primary_text: p.primary_text,
        headline: p.headline,
        link_url: p.link_url,
        cta: p.cta,
        name: p.name ?? p.headline,
        tag: launchTag(d.id),
      });
      return {
        ok: true,
        notice: `✅ ${r.reused ? "Found" : "Created"} ad \`${r.ad_id}\` in ad set \`${r.ad_set_id}\`, ${r.status}${r.effective_status && r.effective_status !== r.status ? ` (Meta: ${r.effective_status})` : ""}.`,
        agent_outcome: JSON.stringify({ ad_id: r.ad_id, creative_id: r.creative_id, ad_set_id: r.ad_set_id, status: r.status, effective_status: r.effective_status }),
        created: {
          platform: "meta",
          object_type: "ad",
          id: String(r.ad_id),
          status: r.effective_status == null ? "UNVERIFIED" : ["PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED"].includes(r.effective_status) ? "PAUSED" : "ACTIVE",
        },
      };
    } catch (e) {
      return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
    }
  },

  "browser.action": async () => ({
    ok: false,
    error:
      "browser_actions_retired: approved browser clicks/fills are retired; browsing is read-only now (browser__task). Nothing was run on the site.",
  }),
};

async function metaDuplicateHandler(
  d: DecisionRow,
  a: {
    level: "adset" | "campaign";
    source_id: string;
    daily_budget_usd: number;
    currency?: string;
    name?: string;
    places?: Array<{ type: "country" | "region" | "city"; key: string; name?: string }>;
  },
): Promise<HandlerResult> {
  let testEnd: Awaited<ReturnType<typeof cgoTestEndForRun>>;
  try {
    testEnd = await cgoTestEndForRun(d.tenant_id, d.agent_run_id, new Date());
  } catch (e) {
    console.warn(`[dispatch-decision meta_ads.duplicate_${a.level === "adset" ? "ad_set" : "campaign"}] ${d.id}: test end unreadable: ${(e as Error).message}`);
    return { ok: false, error: "Zavi could not read this test's end date, so nothing new was copied on this attempt. Approve it again in a minute." };
  }
  let stopLine = null as string | null;
  const armCopyStop = async (copied_id: string) => {
    const r = await armCreatedTestStop(d.tenant_id, d.id, testEnd, {
      platform: "meta",
      level: a.level === "adset" ? "ad_set" : "campaign",
      account_id: async () => (await metaAdsCreds(d.tenant_id)).ad_account_id,
      object_id: copied_id,
      billing_scope: a.level === "adset" ? "object" : "campaign_budget",
      daily_usd: a.daily_budget_usd,
      name: a.name,
    });
    if (!r.ok) throw new ExpectedToolError("meta_ads_test_stop_unarmed", `Zavi could not set up the pause that guards this test's spend, so the copy was not switched on: ${r.why}`, { object_id: copied_id });
    stopLine = r.line;
  };
  try {
    const { readDuplicateSource, metaDuplicate } = await import("@/services/tools/meta-ads/write/launch");
    const { launchTag } = await import("@/services/tools/meta-ads/write/_launch-shapers");
    const src = await readDuplicateSource(d.tenant_id, a.level, a.source_id);
    if (!src.ok) return { ok: false, code: src.code, error: src.error };
    if (a.places?.length && (src.source_daily_usd === null || a.daily_budget_usd > src.source_daily_usd + 0.005)) {
      return { ok: false, error: `cap_refuse: a region copy may not exceed its source's daily budget (${src.source_daily_usd ?? "none"})` };
    }
    if (a.places?.length) {
      const { recheckRegionCopy } = await import("@/services/growth/copy-regions");
      const check = await recheckRegionCopy(d.tenant_id, { level: a.level, source_id: a.source_id, places: a.places, tag: launchTag(d.id) });
      if (!check.ok) return { ok: false, error: `region copy refused: ${check.why}` };
    }
    const currencyMismatch = bodyCurrencyMismatch(a.currency, src.currency);
    if (currencyMismatch) return { ok: false, error: currencyMismatch };

    if (capGovernsDispatch(d)) {
      const capRead = await readTenantCapAndToday(d.tenant_id, d.id);
      const capWaivedForBudget = await adBudgetStandsInForCap(d, capRead);
      const evalRes = evaluateBudgetCap({
        proposed_daily_budget_usd: a.daily_budget_usd,
        current_daily_budget_usd: 0,
        today_total_change_usd: capRead.today_total_change_usd,
        cap: capRead.cap,
      });
      if (!capWaivedForBudget && !evalRes.within) return { ok: false, error: `cap_refuse: ${evalRes.reason}` };
    }

    const copyEndsOn = testEnd ? (await import("@/services/growth/ad-plan-shape")).dailyHoldEndsOn(testEndUnix(testEnd.ends_on)) : null;
    const hold = await reserveAdSpend(d, { platform: "meta", op: "create", object_id: null, daily_delta_usd: a.daily_budget_usd, currency: src.currency, ...(copyEndsOn ? { ends_on: copyEndsOn } : {}) });
    if (hold.status === "refused") return { ok: false, error: hold.error };
    const unheld = budgetMustHold(d, hold);
    if (unheld) return { ok: false, error: unheld };

    const base = a.name?.trim() || `${src.source_name} copy`;
    const name = hold.status === "held" ? prefixAdName(base, 255) : base;
    const tag = launchTag(d.id);
    const unlabelled = await noteAdSpendRef(hold, { kind: "meta_tag", level: a.level, campaign_id: src.campaign_id, tag });
    if (unlabelled) return { ok: false, error: unlabelled };
    let r: Awaited<ReturnType<typeof metaDuplicate>>;
    try {
      r = await metaDuplicate(d.tenant_id, {
        level: a.level,
        source_id: a.source_id,
        campaign_id: src.campaign_id,
        daily_budget_usd: a.daily_budget_usd,
        name,
        tag,
        onCopied: async (id) => {
          await noteAdSpendObject(hold, id);
          if (testEnd) await armCopyStop(id).catch(() => {});
        },
        ...(a.places?.length ? { places: a.places } : {}),
        ...(testEnd ? { testEndsOn: testEnd.ends_on, beforeLive: async (id: string) => void (await armCopyStop(id)) } : {}),
      });
    } catch (e) {
      await settleAdSpendAfterError(hold, e);
      if (e instanceof ExpectedToolError && e.code === "meta_ads_launch_outcome_unknown") {
        return { ok: false, outcome_unknown: true, code: "exec_outcome_unknown", error: e.message };
      }
      throw e;
    }
    await commitAdSpend(hold, r.object_id);
    const notHeld = await holdLaunchLive(d, "meta", r.object_id, a.daily_budget_usd, src.currency, async () => {
      return withMetaSafety(async () => {
        await metaSetStatus(d.tenant_id, { object_id: r.object_id, level: a.level, status: "PAUSED" });
        const back = (await fbGet(d.tenant_id, r.object_id, { fields: "id,status" })) as { status?: string };
        return back?.status === "PAUSED";
      });
    });
    if (notHeld) return notHeld;
    await recordZaviAdChange(d.tenant_id, adChangeFrom(d), {
      platform: "meta",
      object_id: r.object_id,
      level: a.level === "adset" ? "ad_set" : "campaign",
      campaign_id: r.campaign_id,
      object_name: r.name,
      change_kind: "status",
      before_status: null,
      after_status: r.status,
      before_daily_usd: null,
      after_daily_usd: a.daily_budget_usd,
    });
    const what = a.level === "adset" ? "ad set" : "campaign";
    const stopNote = stopLine ? ` ${stopLine}` : "";
    const off = r.switched_off.length ? ` ${r.switched_off.length} copied ad(s) stay off because their source was off.` : "";
    const skipped = r.skipped_ads?.length ? ` Meta refused to copy ${r.skipped_ads.length} live ad(s) (${r.skipped_ads.join(", ")}); the copy runs without them.` : "";
    const where = a.places?.length ? ` Shown in ${a.places.map((p) => p.name ?? p.key).join(", ")}.` : "";
    return {
      ok: true,
      notice: `✅ ${r.reused ? "Finished" : "Launched"} a copy of ${what} \`${a.source_id}\`: "${r.name}" (\`${r.object_id}\`), ${r.status} at ${formatMoney(a.daily_budget_usd, src.currency)}/day${r.effective_status && r.effective_status !== r.status ? ` (Meta: ${r.effective_status})` : ""}.${where}${off}${skipped}${stopNote}`,
      agent_outcome: JSON.stringify({
        level: a.level,
        object_id: r.object_id,
        campaign_id: r.campaign_id,
        status: r.status,
        effective_status: r.effective_status,
        daily_budget_usd: a.daily_budget_usd,
        skipped_ads: r.skipped_ads ?? [],
      }),
    };
  } catch (e) {
    return { ok: false, ...(e instanceof ExpectedToolError ? { code: e.code } : {}), error: (e as Error).message };
  }
}

async function holdLaunchLive(
  d: DecisionRow,
  platform: "meta" | "google",
  object_id: string,
  daily_usd: number,
  currency: string,
  switchOff: () => Promise<boolean>,
): Promise<HandlerResult | null> {
  const hold = await reserveAdSpend(d, { platform, op: "resume", object_id, daily_delta_usd: daily_usd, currency });
  if (hold.status === "held") {
    await commitAdSpend(hold);
    return null;
  }
  const why = hold.status === "refused" ? hold.error : budgetMustHold(d, hold);
  if (!why) return null;
  let off = false;
  try {
    off = await switchOff();
  } catch (e) {
    console.error(`[dispatch-decision launch] ${platform} ${object_id} could not be switched off: ${(e as Error).message}`);
  }
  if (!off) {
    console.error(`[dispatch-decision launch] ${platform} ${object_id} may be live without its full hold; its hold is kept`);
    return {
      ok: false,
      outcome_unknown: true,
      code: "exec_outcome_unknown",
      error: `${why}. The new object \`${object_id}\` could not be confirmed switched off and may be live, so its hold is kept. Check it in Ads Manager.`,
    };
  }
  await releaseAdSpendForObject(d.tenant_id, platform, object_id);
  return { ok: false, error: `${why} (the new object \`${object_id}\` was switched off)` };
}

async function metaBudgetCapRefusal(
  d: DecisionRow,
  p: Pick<UpdateAdSetBudgetBody, "daily_budget_usd" | "expected_current_daily_budget_usd" | "origin" | "authorized_effective_cap">,
): Promise<string | null> {
  if (!capGovernsDispatch(d)) return null;
  const capRead = await readTenantCapAndToday(d.tenant_id, d.id);
  const { cap, today_total_change_usd } = capRead;
  const capWaivedForBudget = await adBudgetStandsInForCap(d, capRead);
  const userInitiated = p.origin === "user_initiated_chat" || p.origin === "user_initiated_ledger";
  const effectiveCap =
    userInitiated && p.authorized_effective_cap
      ? minMergeCap(capInAccountUnits(p.authorized_effective_cap, capRead.units_per_usd), cap)
      : cap;
  const evalRes = evaluateBudgetCap({
    proposed_daily_budget_usd: p.daily_budget_usd,
    current_daily_budget_usd: p.expected_current_daily_budget_usd,
    today_total_change_usd,
    cap: effectiveCap,
  });
  return !capWaivedForBudget && !evalRes.within ? `cap_refuse: ${evalRes.reason}` : null;
}

async function metaCboCampaignRaiseInstead(d: DecisionRow, campaign_id: string, add_usd: number, currency: string): Promise<HandlerResult> {
  try {
    const c = (await fbGet(d.tenant_id, campaign_id, { fields: "name,status,daily_budget,lifetime_budget" })) as {
      name?: string;
      status?: string;
      daily_budget?: string | null;
      lifetime_budget?: string | null;
    };
    if (Number(c.lifetime_budget ?? 0) > 0) return { ok: false, error: adBudgetRefusal("lifetime_budget") };
    if (c.status !== "ACTIVE") {
      return { ok: false, error: adBudgetRefusal("cbo_campaign_off: the campaign is switched off, so Zavi did not add budget to it") };
    }
    const current = Number(c.daily_budget ?? 0) / minorUnitsPerMajor(currency);
    if (!(current > 0)) return { ok: false, error: adBudgetRefusal("zero_daily_budget") };
    const next = Math.round((current + add_usd) * 100) / 100;
    if (capGovernsDispatch(d)) {
      const capRead = await readTenantCapAndToday(d.tenant_id, d.id);
      const capWaivedForBudget = await adBudgetStandsInForCap(d, capRead);
      const evalRes = evaluateBudgetCap({
        proposed_daily_budget_usd: next,
        current_daily_budget_usd: current,
        today_total_change_usd: capRead.today_total_change_usd,
        cap: capRead.cap,
      });
      if (!capWaivedForBudget && !evalRes.within) return { ok: false, error: `cap_refuse: ${evalRes.reason}` };
    }
    const hold = await reserveAdSpend(d, { platform: "meta", op: "raise", object_id: campaign_id, daily_delta_usd: Math.round((next - current) * 100) / 100, currency });
    if (hold.status === "refused") return { ok: false, error: hold.error };
    const unheld = budgetMustHold(d, hold);
    if (unheld) return { ok: false, error: unheld };
    if (hold.status === "held" && !hold.fresh) {
      return { ok: false, error: `meta_ads_cbo_raise_in_flight: an earlier attempt may already have raised campaign ${campaign_id}; Zavi did not raise it again. Check its budget in Ads Manager.` };
    }
    try {
      await metaUpdateAdSetBudget(d.tenant_id, { ad_set_id: campaign_id, daily_budget_usd: next });
    } catch (e) {
      await settleAdSpendAfterError(hold, e);
      throw e;
    }
    await commitAdSpend(hold);
    await recordZaviAdChange(d.tenant_id, adChangeFrom(d), {
      platform: "meta",
      object_id: campaign_id,
      level: "campaign",
      campaign_id,
      object_name: c.name ?? null,
      change_kind: "budget",
      before_status: null,
      after_status: null,
      before_daily_usd: current,
      after_daily_usd: next,
    });
    await readBackBudget({
      tenant_id: d.tenant_id,
      platform: "meta",
      object_id: campaign_id,
      label: `Campaign ${c.name ? `"${c.name}"` : campaign_id}`,
      expected_minor: toBudgetMinorUnits(next, currency),
      minor_per_major: minorUnitsPerMajor(currency),
      currency,
      read: async () => {
        const back = (await fbGet(d.tenant_id, campaign_id, { fields: "daily_budget" })) as { daily_budget?: string };
        return back.daily_budget == null ? null : Number(back.daily_budget);
      },
    });
    return {
      ok: true,
      notice: `✅ Campaign \`${campaign_id}\` sets its own budget, so instead of a new ad set Zavi raised its daily budget from ${formatMoney(current, currency)} to ${formatMoney(next, currency)}.`,
      agent_outcome: JSON.stringify({ campaign_id, before_daily_usd: current, after_daily_usd: next, replaced: "create_ad_set" }),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function verifyGoogleTestEnd(d: DecisionRow, campaign_id: string, endDate: string): Promise<"verified" | "missing" | "unreadable"> {
  try {
    const { end_date_time } = await gadsGetCampaignEnd(d.tenant_id, campaign_id);
    if (typeof end_date_time === "string" && end_date_time.slice(0, 10) === dayBefore(endDate)) return "verified";
    void logEvent({ level: "error", source: "google_ads.create_campaign", code: "test_end_not_stored", tenant_id: d.tenant_id, message: `action=${d.id} campaign=${campaign_id}: end ${end_date_time ?? "none"} read back, want ${dayBefore(endDate)}; not switched on by Zavi` });
    return "missing";
  } catch (e) {
    void logEvent({ level: "error", source: "google_ads.create_campaign", code: "test_end_unreadable", tenant_id: d.tenant_id, message: `action=${d.id} campaign=${campaign_id}: ${(e as Error).message.slice(0, 200)}; not switched on by Zavi` });
    return "unreadable";
  }
}

async function googleEnableCreatedCampaign(
  d: DecisionRow,
  created: { campaign_id: string; campaign_resource: string },
  daily_usd: number,
  by: "cgo" | "founder" = "cgo",
): Promise<{ enabled: boolean; note: string; verified?: boolean }> {
  const hold = await reserveAdSpend(d, { platform: "google", op: "resume", object_id: created.campaign_id, daily_delta_usd: daily_usd });
  const why = hold.status === "refused" ? hold.error : budgetMustHold(d, hold);
  if (why) return { enabled: false, note: `It stays paused: ${why}.` };
  try {
    await googleSetCampaignStatus(d.tenant_id, { campaign_resource: created.campaign_resource, status: "ENABLED" });
  } catch (e) {
    await settleAdSpendAfterError(hold, e);
    return { enabled: false, note: `It stays paused: switching it on failed (${(e as Error).message.slice(0, 200)}).` };
  }
  await commitAdSpend(hold);
  let status: string | null = null;
  try {
    status = (await gadsGetCampaign(d.tenant_id, created.campaign_id)).status || null;
  } catch (e) {
    console.warn(`[dispatch-decision google_ads.create_campaign] enable read-back failed for ${created.campaign_id}: ${(e as Error).message}`);
  }
  await recordZaviAdChange(d.tenant_id, adChangeFrom(d), {
    platform: "google",
    object_id: created.campaign_id,
    level: "campaign",
    campaign_id: created.campaign_id,
    object_name: null,
    change_kind: "status",
    before_status: "PAUSED",
    after_status: status === "ENABLED" ? "ENABLED" : "UNVERIFIED",
    before_daily_usd: daily_usd,
    after_daily_usd: daily_usd,
  });
  return {
    enabled: true,
    verified: status === "ENABLED",
    note: (() => {
      const who = by === "founder" ? "Switched on, as you asked." : "Autopilot switched it on.";
      return status === "ENABLED" ? who : `${who.slice(0, -1)}; Google reports ${status ?? "an unreadable status"} so far.`;
    })(),
  };
}

const cgoGateChecked = new WeakSet<object>();
const metaRoleChecked = new WeakSet<object>();
const chatgptRoleChecked = new WeakSet<object>();
const googleRoleChecked = new WeakSet<object>();
const pairChecked = new WeakSet<object>();
const stopChecked = new WeakSet<object>();
const capHeldChecked = new WeakSet<object>();

export async function overProjectionToFounder(d: MaybeExecRow, r: HandlerResult): Promise<HandlerResult> {
  if (r.ok || r.held_for_founder || !String(r.error ?? "").includes("ad_budget_over_projection_with_change")) return r;
  const warning = String(r.error).replace(/^.*?ad_budget_over_projection_with_change:\s*/, "");
  try {
    const { askFounderAboutHeld } = await import("@/services/growth/unattended-policy");
    const action = {
      kind: "ad" as const,
      exec_class: d.decision_class,
      payload: d.body,
      source: { table: d.exec_source === "channel_actions" ? ("channel_actions" as const) : ("decisions" as const), id: d.id, run_id: d.agent_run_id },
      title: d.exec_title ?? null,
    };
    await askFounderAboutHeld(d.tenant_id, action, { verdict: "ask_founder", reasons: ["over_projection_with_change"], evidence: warning });
  } catch (e) {
    console.warn(`[dispatch-decision] over-cap question for ${d.id} not asked: ${(e as Error).message}`);
  }
  return { ok: false, held_for_founder: true, code: "over_projection_with_change", error: warning.charAt(0).toUpperCase() + warning.slice(1) };
}

type MaybeExecRow = DecisionRow & { exec_source?: "channel_actions"; exec_title?: string | null };

async function recheckCgoApproval(d: MaybeExecRow): Promise<HandlerResult | null> {
  const { authorizeUnattended, askFounderAboutHeld, heldChangeAsk } = await import("@/services/growth/unattended-policy");
  const action = {
    kind: "ad" as const,
    exec_class: d.decision_class,
    payload: d.body,
    source: { table: d.exec_source === "channel_actions" ? ("channel_actions" as const) : ("decisions" as const), id: d.id, run_id: d.agent_run_id },
    title: d.exec_title ?? null,
  };
  const v = await authorizeUnattended(d.tenant_id, action, { where: "executor" });
  if (v.verdict === "allow") return null;
  if (v.verdict === "deny") {
    return { ok: false, error: `cgo_not_authorized: Autopilot may not make this kind of change on its own (${v.reasons.join(", ")}). Nothing in the account changed.` };
  }
  await askFounderAboutHeld(d.tenant_id, action, v);
  return { ok: false, held_for_founder: true, error: heldChangeAsk("make this change", v.reasons) };
}

for (const cls of Object.keys(HANDLERS)) {
  if (!/^(meta_ads|google_ads|chatgpt_ads|linkedin_ads|reddit_ads|tiktok_ads)\./.test(cls)) continue;
  const inner = HANDLERS[cls];
  const checked: typeof inner = async (d) => {
    if ((d as { test_stop_pause?: true }).test_stop_pause && !cgoGateChecked.has(d)) {
      cgoGateChecked.add(d);
      const { testStopPauseAuthority } = await import("@/services/growth/test-stops");
      const auth = await testStopPauseAuthority(d.tenant_id, d.id, cls, d.body).catch(() => null);
      if (auth !== "stop") {
        return { ok: false, error: auth === "resumed" ? "You switched this ad back on after Zavi stopped its test, so Zavi did not pause it again. Nothing in the account changed." : "Zavi could not confirm this test's stop is still open, so it did not apply this pause. Nothing in the account changed." };
      }
    }
    if (!(d as { test_stop_pause?: true }).test_stop_pause && cls !== "linkedin_ads.set_status" && !stopChecked.has(d)) {
      stopChecked.add(d);
      const { readChannelStopped } = await import("@/services/growth/channel-stopped");
      const stopped = await readChannelStopped(d.tenant_id, cls.split(".")[0]);
      if (stopped !== false) {
        return {
          ok: false,
          code: "founder_stopped",
          error: stopped
            ? "You stopped this channel, so Zavi did not apply this change. Nothing in the account changed."
            : "Zavi could not check whether you stopped this channel, so it did not apply this change. Nothing in the account changed. Approve it again to retry.",
        };
      }
    }
    if (d.approved_by_source === "cgo" && !cgoGateChecked.has(d) && !(d as { test_stop_pause?: true }).test_stop_pause) {
      cgoGateChecked.add(d);
      const { cgoAdBudget } = await import("@/services/growth/cgo-ads");
      if (!(await cgoAdBudget(d.tenant_id))) {
        return { ok: false, error: "cgo_not_authorized: Autopilot or the ad budget is off, so this CGO-approved change was not made" };
      }
      const held = await recheckCgoApproval(d as MaybeExecRow);
      if (held) return held;
    }
    if (/^(meta_ads|google_ads)\./.test(cls) && !pairChecked.has(d)) {
      pairChecked.add(d);
      const mc = await import("@/services/growth/move-card");
      const stampedByMoveCard =
        mc.moveAfterOf(d.body) !== null &&
        typeof d.approved_by === "string" && d.approved_by.length > 0 && d.approved_by_source == null &&
        (await (await import("@/services/decisions/ad-budget-choice-flag")).adBudgetChoiceEnabled());
      if (stampedByMoveCard) {
        const v = await mc.checkMoveAfter(d.tenant_id, d.body);
        if (v !== "go") {
          return {
            ok: false,
            held_for_founder: true,
            code: "paired_move_waits",
            error: v === "wait"
              ? "The cuts in this move are still being applied, so this raise has not run. It runs after them."
              : "A cut this raise needs is not in place in the ad account (it did not go through, was changed back, or Zavi could not read it), so this raise has not run. Check the cut, then approve again.",
          };
        }
      } else {
        const { pairedDispatchHold } = await import("@/services/growth/move-group");
        const wait = await pairedDispatchHold(d.tenant_id, { id: d.id, exec_class: d.decision_class, body: d.body });
        if (wait) return { ok: false, held_for_founder: true, code: "paired_move_waits", error: wait };
      }
    }
    if (cls.startsWith("meta_ads.") && !metaRoleChecked.has(d)) {
      metaRoleChecked.add(d);
      const { metaApproverRefusal } = await import("@/services/tools/meta-ads/write/_approver-role");
      const refused = await metaApproverRefusal(d);
      if (refused) return refused;
    }
    if (cls.startsWith("google_ads.") && !googleRoleChecked.has(d)) {
      googleRoleChecked.add(d);
      const { googleApproverRefusal } = await import("@/services/tools/google-ads/write/_approver-role");
      const refused = await googleApproverRefusal(d);
      if (refused) return refused;
    }
    if (cls.startsWith("chatgpt_ads.") && !chatgptRoleChecked.has(d)) {
      chatgptRoleChecked.add(d);
      const { chatgptApproverRefusal } = await import("@/services/connectors/chatgpt-ads/approver-role");
      const refused = await chatgptApproverRefusal(d);
      if (refused) return refused;
    }
    if (capHeldChecked.has(d)) return inner(d);
    capHeldChecked.add(d);
    const writeStartedAt = new Date().toISOString();
    const out = await overProjectionToFounder(d as MaybeExecRow, await inner(d));
    if (out.ok && (d as { test_stop_pause?: true }).test_stop_pause) {
      const { afterTestStopPause } = await import("@/services/growth/test-stops");
      await afterTestStopPause(d.tenant_id, d.id, cls, d.body, writeStartedAt);
    }
    return out;
  };
  HANDLERS[cls] = cls.startsWith("meta_ads.") ? (d) => withMetaDecisionExec(cls, d.body, () => checked(d)) : checked;
}

{
  const inner = HANDLERS["praxis.dispatch_specialist"];
  if (inner) {
    HANDLERS["praxis.dispatch_specialist"] = async (d) => {
      if (d.decision_class === "cgo.dispatch-specialist" && d.approved_by_source === "cgo") {
        const { authorizeUnattended, dispatchActionFromBody } = await import("@/services/growth/unattended-policy");
        const v = await authorizeUnattended(d.tenant_id, dispatchActionFromBody(d.body), { where: "executor" });
        if (v.verdict === "deny") return { ok: false, error: `cgo_not_authorized: ${v.reasons.join(", ")}` };
        if (v.verdict === "ask_founder" && v.reasons.includes("channel_asks_first")) {
          const { CHANNELS } = await import("@zavi/shared");
          const target = String((d.body as { target_agent_slug?: unknown } | null)?.target_agent_slug ?? "");
          const name = CHANNELS.find((c) => c.slug === target)?.name ?? target;
          return { ok: false, held_for_founder: true, error: `You set ${name} to ask first, so cgo does not run it. Approve it if you want it to run.` };
        }
        if (v.verdict === "ask_founder") {
          return { ok: false, held_for_founder: true, error: `Autopilot left this for you: ${v.reasons.join(", ")}. Approve it if you agree.` };
        }
      }
      return inner(d);
    };
  }
}

export function extractPostImageFromUnifiedDiff(diff: string): string {
  const out: string[] = [];
  const lines = diff.split("\n");
  for (const line of lines) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      out.push(line.slice(1));
    } else if (line.startsWith("-")) {
      continue;
    } else if (line.startsWith(" ")) {
      out.push(line.slice(1));
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

export type ExecuteDispatchOpts = {
  slackNotice?: "direct" | "outbox";
};

async function settleDecisionStatus(
  svc: ReturnType<typeof serviceClient>,
  decision_id: string,
  patch: { status: string; dispatched_at: string; dispatch_error: string | null },
  context: {
    tenant_id: string;
    handler: string | null;
    handler_ok: boolean;
    side_effect_ran: boolean;
  },
): Promise<void> {
  let { error } = await svc.from("decisions").update(patch).eq("id", decision_id);
  if (error) {
    console.warn(
      `[dispatch-decision] settle write failed for ${decision_id}, retrying once: ${error.message}`,
    );
    ({ error } = await svc.from("decisions").update(patch).eq("id", decision_id));
  }
  if (error) {
    console.error(
      `[dispatch-decision] SETTLE STUCK decision=${decision_id} tenant=${context.tenant_id} ` +
        `handler=${context.handler} handler_ok=${context.handler_ok} — row is still 'dispatching' and ` +
        `${context.side_effect_ran ? "the side effect already ran" : "nothing was executed"}: ${error.message}`,
    );
  }
}

export const DISPATCH_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DISPATCH_RETRY_MAX_ATTEMPTS = 200;
export const DISPATCH_RETRY_BASE_MS = 10 * 60 * 1000;
export const DISPATCH_RETRY_MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;

export const RETRY_LATER_HANDLERS: ReadonlySet<string> = new Set(["perfmkt.create_ad_set_pending_strategist"]);

export type DispatchRetryState = { attempts: number; since: string | null };

export function dispatchRetryBackoffMs(attempts: number): number {
  return Math.min(DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), DISPATCH_RETRY_MAX_BACKOFF_MS);
}

export function retriesExhaustedMessage(attempts: number, ageMs: number): string {
  const hours = Math.max(1, Math.round(ageMs / 3_600_000));
  return (
    `Zavi tried ${attempts} time${attempts === 1 ? "" : "s"} over ${hours} hour${hours === 1 ? "" : "s"} and Meta did not answer, ` +
    `so this ad set was not created. Nothing was spent. Ask Zavi to propose it again.`
  );
}

function retryBoundHit(state: DispatchRetryState, now: Date): { attempts: number; ageMs: number } | null {
  if (!state.since) return null;
  const ageMs = now.getTime() - new Date(state.since).getTime();
  return ageMs >= DISPATCH_RETRY_MAX_AGE_MS || state.attempts >= DISPATCH_RETRY_MAX_ATTEMPTS ? { attempts: state.attempts, ageMs } : null;
}

async function readDispatchRetryState(
  svc: ReturnType<typeof serviceClient>,
  decision_id: string,
): Promise<DispatchRetryState | null> {
  const { data, error } = await svc
    .from("decisions")
    .select("dispatch_attempts, dispatch_retry_since")
    .eq("id", decision_id)
    .maybeSingle();
  if (error) return null;
  const row = (data ?? {}) as { dispatch_attempts?: number | null; dispatch_retry_since?: string | null };
  return { attempts: row.dispatch_attempts ?? 0, since: row.dispatch_retry_since ?? null };
}

async function deferDispatchForRetry(
  svc: ReturnType<typeof serviceClient>,
  decision_id: string,
  error: string,
  state: DispatchRetryState,
  now: Date = new Date(),
): Promise<{ kind: "deferred" } | { kind: "exhausted"; reason: string; message: string | null }> {
  const attempts = state.attempts + 1;
  const since = state.since ?? now.toISOString();
  const hit = retryBoundHit({ attempts, since }, now);
  if (hit) {
    const message = retriesExhaustedMessage(hit.attempts, hit.ageMs);
    return { kind: "exhausted", message, reason: `${message} Last error: ${error.slice(0, 300)}` };
  }
  const { data: moved, error: writeErr } = await svc
    .from("decisions")
    .update({
      status: "proposed",
      dispatch_error: error.slice(0, 1000),
      dispatch_attempts: attempts,
      dispatch_retry_since: since,
      dispatch_retry_after: new Date(now.getTime() + dispatchRetryBackoffMs(attempts)).toISOString(),
    })
    .eq("id", decision_id)
    .eq("status", "dispatching")
    .select("id");
  if (writeErr || ((moved ?? []) as unknown[]).length === 0) {
    return {
      kind: "exhausted",
      message: null,
      reason: `${error}. Zavi could not put it back in the queue${writeErr ? ` (${writeErr.message})` : ""}, so it stopped here; nothing was spent.`,
    };
  }
  return { kind: "deferred" };
}

async function tellPairedPartialFor(decision: Pick<DecisionRow, "tenant_id" | "decision_class" | "body">, decision_id: string, error: string | null | undefined): Promise<void> {
  await (await import("@/services/growth/move-group")).tellPairedPartial(decision.tenant_id, { id: decision_id, exec_class: decision.decision_class, body: decision.body }, error);
}

type LegEnd = "acted" | "not_sent" | "uncertain";
async function settleMoveLeg(decision: Pick<DecisionRow, "tenant_id" | "decision_class" | "body">, decision_id: string, end: LegEnd): Promise<void> {
  try {
    if (!/^(meta_ads|google_ads)\./.test(decision.decision_class)) return;
    const mc = await import("@/services/growth/move-card");
    const { legSide } = await import("@/services/growth/move-group");
    if (legSide(decision.decision_class, decision.body) !== "adds") await mc.advanceMove(decision.tenant_id, decision_id);
    else if (end !== "acted" && mc.moveAfterOf(decision.body)) await mc.tellRaiseFailed(decision.tenant_id, { id: decision_id, decision_class: decision.decision_class, body: decision.body }, end === "not_sent" ? "never" : "unknown");
  } catch (e) {
    console.warn(`[dispatch-decision] move settle after ${decision_id} skipped: ${(e as Error).message}`);
  }
}

async function alertRetriesExhausted(tenant_id: string, decision_id: string, message: string, now: Date = new Date()): Promise<void> {
  try {
    const { alertFounderSafely, retriesExhaustedBlocker } = await import("@/services/growth/cgo-blockers");
    await alertFounderSafely(tenant_id, "retries exhausted", [retriesExhaustedBlocker({ id: decision_id, what: message, since: now.toISOString() })]);
  } catch (e) {
    console.warn(`[dispatch-decision] retries-exhausted alert for ${decision_id} not sent: ${(e as Error).message}`);
  }
}

async function alertFounderOnDecision(decision: Pick<DecisionRow, "id" | "tenant_id" | "decision_class">, outcome: "failed" | "unknown"): Promise<void> {
  try {
    const decisionClass = String(decision.decision_class ?? "");
    const { isExecutableAdClass } = await import("@/services/growth/unattended-policy");
    if (!isExecutableAdClass(decisionClass)) return;
    const { alertFounderSafely, uncertainDecisionBlocker } = await import("@/services/growth/cgo-blockers");
    const extra = outcome === "unknown" ? [uncertainDecisionBlocker({ id: decision.id, decision_class: decisionClass, since: new Date().toISOString() })] : [];
    await alertFounderSafely(decision.tenant_id, `decision ${outcome}`, extra);
  } catch (e) {
    console.warn(`[dispatch-decision] founder alert for ${outcome} ${decision.id} not sent: ${(e as Error).message}`);
  }
}

export type SitePrRunInfo =
  | { kind: "none" }
  | { kind: "error" }
  | { kind: "site_pr"; exec_class: string; repo_hint: string | null; page_copy: import("@/services/channels/seo-open-pr").CopyBlock[] | null; approved_by: string | null; page_url: string | null };

export async function readSitePrRun(
  svc: Pick<ReturnType<typeof serviceClient>, "from">,
  decision: Pick<DecisionRow, "handler" | "agent_run_id" | "tenant_id">,
): Promise<SitePrRunInfo> {
  if (decision.handler !== "github.open_pr" || !decision.agent_run_id) return { kind: "none" };
  let data: unknown;
  try {
    const res = await svc
      .from("agent_runs")
      .select("payload, enqueued_by")
      .eq("id", decision.agent_run_id)
      .eq("tenant_id", decision.tenant_id)
      .maybeSingle();
    if (res.error) return { kind: "error" };
    data = res.data;
  } catch {
    return { kind: "error" };
  }
  if (!data) return { kind: "none" };
  const row = data as { payload?: { site_pr_card?: { exec_class?: unknown; approved_by?: unknown }; repo_hint?: unknown; site_pr_content?: { page_copy?: { blocks?: unknown; page_url?: unknown } } } | null; enqueued_by?: string | null };
  if (row.enqueued_by != null) return { kind: "none" };
  const cls = row.payload?.site_pr_card?.exec_class;
  const { SITE_PR_CLASSES } = await import("@/services/channels/site-pr");
  if (typeof cls !== "string" || !SITE_PR_CLASSES.has(cls)) return { kind: "none" };
  const hint = row.payload?.repo_hint;
  let page_copy: import("@/services/channels/seo-open-pr").CopyBlock[] | null = null;
  const raw = row.payload?.site_pr_content?.page_copy;
  if (raw !== undefined) {
    const { copyBlockSchema, MAX_COPY_BLOCKS } = await import("@/services/channels/seo-open-pr");
    const { z } = await import("zod");
    const parsed = z.array(copyBlockSchema).min(1).max(MAX_COPY_BLOCKS).safeParse(raw?.blocks);
    if (!parsed.success) return { kind: "error" };
    page_copy = parsed.data;
  }
  const by = row.payload?.site_pr_card?.approved_by;
  const pageUrl = raw?.page_url;
  return { kind: "site_pr", exec_class: cls, repo_hint: typeof hint === "string" && hint.trim() ? hint.trim() : null, page_copy, approved_by: typeof by === "string" && by ? by : null, page_url: typeof pageUrl === "string" ? pageUrl : null };
}

export function pinSitePrBody(body: Record<string, unknown>, repo: string): Record<string, unknown> {
  const { push_to_main: _p, defer_pr: _d, live_edit_draft: _l, expected_base_sha: _e, ...rest } = body;
  return { ...rest, repo };
}

async function resolveSitePrRepo(tenantId: string, repoHint: string | null): Promise<string | null> {
  if (!repoHint) return null;
  try {
    const { resolveRepoFullName } = await import("@/services/agents/repo-resolver");
    return await resolveRepoFullName({ tenant_id: tenantId, repo_hint: repoHint });
  } catch {
    return null;
  }
}

export async function executeDispatch(
  decision_id: string,
  opts?: ExecuteDispatchOpts,
): Promise<{ ok: boolean; error?: string; resume_pending?: PendingResume }> {
  const result = await executeDispatchInner(decision_id, opts);
  void stampOutcomeForDecisionId(decision_id).catch((e) =>
    console.warn(`[terminal-stamp] best-effort failed for ${decision_id}: ${(e as Error).message}`),
  );
  return result;
}

async function executeDispatchInner(
  decision_id: string,
  opts?: ExecuteDispatchOpts,
): Promise<{ ok: boolean; error?: string; resume_pending?: PendingResume }> {
  const svc = serviceClient();

  const claimed = await claimDecision(decision_id);
  if (!claimed) {
    return { ok: true };
  }
  const decision = claimed as DecisionRow;

  if (await isFleetHalted()) {
    await releaseClaim(decision_id, "fleet_halted");
    await logEvent({
      level: "warn",
      source: "dispatch-decision.fleet_halt",
      code: "fleet_halted_dispatch_deferred",
      message:
        "fleet halt active — dispatch deferred, decision released back to proposed; re-approve after clearing the halt if it was approval-gated",
      tenant_id: decision.tenant_id,
      meta: { decision_id, decision_class: decision.decision_class },
    });
    return { ok: false, error: "fleet_halted" };
  }

  const tenantDisabled = await readTenantDisabled(decision.tenant_id);
  if (tenantDisabled === null) {
    await releaseClaim(decision_id, "tenant_disabled_check_failed");
    return { ok: false, error: "tenant_disabled_check_failed" };
  }
  if (tenantDisabled) {
    await svc.from("decisions")
      .update({
        status: DECISION_STATUS_DISPATCH_FAILED,
        dispatch_error: "tenant_disabled",
        dispatched_at: new Date().toISOString(),
      })
      .eq("id", decision_id);
    await tellPairedPartialFor(decision, decision_id, "tenant_disabled");
    await settleMoveLeg(decision, decision_id, "not_sent");
    return { ok: false, error: "tenant_disabled" };
  }

  let agent_slug: string | null = null;
  let chatThreadId: string | null = null;
  let slackRouting: SlackRouting | null = null;
  if (decision.agent_run_id) {
    const { data: runRow, error: runErr } = await svc
      .from("agent_runs")
      .select("agent_slug, trigger, payload")
      .eq("id", decision.agent_run_id)
      .maybeSingle();
    if (runErr) {
      await releaseClaim(decision_id, `agent_runs read failed: ${runErr.message}`);
      return { ok: false, error: `agent_runs read failed: ${runErr.message}` };
    }
    agent_slug = (runRow as { agent_slug: string } | null)?.agent_slug ?? null;
    chatThreadId = extractChatThreadId(
      runRow as { trigger?: string | null; payload?: unknown } | null,
    );
    slackRouting = extractSlackRouting(
      runRow as { trigger?: string | null; payload?: unknown } | null,
    );
  }

  if (agent_slug) {
    const { data: killRow, error: killErr } = await svc
      .from("tenant_agent_kill_switch")
      .select("agent_slug")
      .eq("tenant_id", decision.tenant_id)
      .eq("agent_slug", agent_slug)
      .eq("override_state", "hidden")
      .maybeSingle();
    if (killErr) {
      await releaseClaim(decision_id, `kill_switch_check_failed: ${killErr.message}`);
      return { ok: false, error: `kill_switch_check_failed: ${killErr.message}` };
    }
    if (killRow) {
      await svc.from("decisions")
        .update({
          status: DECISION_STATUS_DISPATCH_FAILED,
          dispatch_error: "kill_switch",
          dispatched_at: new Date().toISOString(),
        })
        .eq("id", decision_id);
      await notifyDispatchFailure({
        deliver: opts?.slackNotice ?? "direct",
        svc,
        decision,
        decision_id,
        slackRouting,
        error: "kill_switch",
      });
      await tellPairedPartialFor(decision, decision_id, "kill_switch");
      await settleMoveLeg(decision, decision_id, "not_sent");
      return { ok: false, error: "kill_switch" };
    }
  }

  if (!decision.handler) {
    await svc.from("decisions")
      .update({ status: "acted", dispatched_at: new Date().toISOString() })
      .eq("id", decision_id);
    return { ok: true };
  }

  const handler = HANDLERS[decision.handler];
  if (!handler) {
    const errMsg = `no registered handler for "${decision.handler}"`;
    await svc.from("decisions")
      .update({
        status: DECISION_STATUS_DISPATCH_FAILED,
        dispatch_error: errMsg,
        dispatched_at: new Date().toISOString(),
      })
      .eq("id", decision_id);
    await notifyDispatchFailure({
      svc,
      decision,
      decision_id,
      slackRouting,
      error: errMsg,
      deliver: opts?.slackNotice ?? "direct",
    });
    await tellPairedPartialFor(decision, decision_id, errMsg);
    await settleMoveLeg(decision, decision_id, "not_sent");
    return { ok: false, error: errMsg };
  }

  const sitePr = await readSitePrRun(svc, decision);
  if (sitePr.kind === "error") {
    await releaseClaim(decision_id, "site-pr run read failed");
    return { ok: false, error: "agent_runs read failed (site-pr provenance)" };
  }
  const switchKey = sitePr.kind === "site_pr" ? sitePr.exec_class : decision.handler;
  if (switchKey && !(await platformWriteEnabled(switchKey))) {
    const label = execPlatformLabel(switchKey);
    const refusal =
      `${label} changes are switched off at the platform level right now, so Zavi did not apply this one. ` +
      `Nothing in the account changed. Approve it again once they are back on.`;
    await settleDecisionStatus(
      svc,
      decision_id,
      {
        status: DECISION_STATUS_DISPATCH_FAILED,
        dispatch_error: refusal,
        dispatched_at: new Date().toISOString(),
      },
      {
        tenant_id: decision.tenant_id,
        handler: decision.handler,
        handler_ok: false,
        side_effect_ran: false,
      },
    );
    await notifyDispatchFailure({
      svc,
      decision,
      decision_id,
      slackRouting,
      error: refusal,
      deliver: opts?.slackNotice ?? "direct",
    });
    await tellPairedPartialFor(decision, decision_id, refusal);
    await settleMoveLeg(decision, decision_id, "not_sent");
    return {
      ok: false,
      error: `platform_write_disabled: ${execPlatform(decision.handler)}`,
    };
  }

  if (sitePr.kind === "site_pr") {
    const repo = await resolveSitePrRepo(decision.tenant_id, sitePr.repo_hint);
    if (!repo) {
      const refusal = (await import("@/services/channels/site-pr")).GITHUB_UNREACHABLE;
      await settleDecisionStatus(
        svc,
        decision_id,
        { status: DECISION_STATUS_DISPATCH_FAILED, dispatch_error: refusal, dispatched_at: new Date().toISOString() },
        { tenant_id: decision.tenant_id, handler: decision.handler, handler_ok: false, side_effect_ran: false },
      );
      await notifyDispatchFailure({ svc, decision, decision_id, slackRouting, error: refusal, deliver: opts?.slackNotice ?? "direct" });
      return { ok: false, error: "site_pr_repo_unresolved" };
    }
    decision.body = pinSitePrBody(decision.body ?? {}, repo);
    if (sitePr.page_copy) {
      const { checkPageCopyPr } = await import("@/services/channels/page-copy-check");
      const checked = await checkPageCopyPr(decision.tenant_id, repo, decision.body as never, sitePr.page_copy, sitePr.approved_by, sitePr.page_url);
      if (!("refusal" in checked) && "base_sha" in checked && typeof checked.base_sha === "string" && /^[0-9a-f]{40}$/.test(checked.base_sha)) {
        decision.body = { ...decision.body, expected_base_sha: checked.base_sha };
      } else {
        const refused = "refusal" in checked ? checked : { refusal: (await import("@/services/channels/page-copy-check")).PAGE_COPY_READ_FAILED, why: "no pinned base commit" };
        console.warn(`[dispatch-decision] page-copy PR refused for ${decision_id}: ${refused.why}`);
        await settleDecisionStatus(
          svc,
          decision_id,
          { status: DECISION_STATUS_DISPATCH_FAILED, dispatch_error: refused.refusal, dispatched_at: new Date().toISOString() },
          { tenant_id: decision.tenant_id, handler: decision.handler, handler_ok: false, side_effect_ran: false },
        );
        await notifyDispatchFailure({ svc, decision, decision_id, slackRouting, error: refused.refusal, deliver: opts?.slackNotice ?? "direct" });
        return { ok: false, error: "site_pr_page_copy_refused" };
      }
    }
  }

  let retryState: DispatchRetryState | null = null;
  let retriesExhausted: string | null = null;
  if (RETRY_LATER_HANDLERS.has(decision.handler)) {
    retryState = await readDispatchRetryState(svc, decision_id);
    if (!retryState) {
      await releaseClaim(decision_id, "retry state unreadable");
      return { ok: false, error: "retry_state_unreadable" };
    }
  }
  const hitBefore = retryState ? retryBoundHit(retryState, new Date()) : null;

  let res: HandlerResult;
  if (hitBefore) {
    retriesExhausted = retriesExhaustedMessage(hitBefore.attempts, hitBefore.ageMs);
    res = { ok: false, error: retriesExhausted };
  } else try {
    res = await handler(decision);
  } catch (e) {
    res =
      (e as { code?: string }).code === "fleet_halted"
        ? { ok: false, error: "fleet_halted" }
        : { ok: false, error: (e as Error).message };
  }

  if (!res.ok && res.held_for_founder) {
    const { error: holdErr, data: held } = await svc
      .from("decisions")
      .update({
        status: "proposed",
        approved_by: null,
        approved_at: null,
        approved_by_source: null,
        dispatch_error: (res.error ?? "held for the founder").slice(0, 1000),
      })
      .eq("id", decision_id)
      .eq("status", "dispatching")
      .select("id");
    if (holdErr || ((held ?? []) as unknown[]).length === 0) {
      await settleDecisionStatus(
        svc,
        decision_id,
        { status: DECISION_STATUS_DISPATCH_FAILED, dispatched_at: new Date().toISOString(), dispatch_error: res.error ?? "held_for_founder" },
        { tenant_id: decision.tenant_id, handler: decision.handler, handler_ok: false, side_effect_ran: false },
      );
    }
    return { ok: false, error: "held_for_founder" };
  }

  if (!res.ok && res.error === "fleet_halted") {
    await releaseClaim(decision_id, "fleet_halted");
    return { ok: false, error: "fleet_halted" };
  }

  if (!res.ok && res.code === "email_paused" && isEmailCardClass(decision.decision_class)) {
    await releaseClaim(decision_id, "email_paused");
    return { ok: false, error: "email_paused" };
  }

  if (!res.ok && res.code === BULK_SEND_NOT_STARTED && decision.decision_class === "bulk_outbound.send") {
    await releaseClaim(decision_id, BULK_SEND_NOT_STARTED);
    return { ok: false, error: BULK_SEND_NOT_STARTED };
  }

  if (!res.ok && res.code === BULK_SENDER_STOPPED_HOLD && decision.decision_class === "bulk_outbound.send") {
    await releaseClaim(decision_id, "bulk_sending_paused");
    return { ok: false, error: "bulk_sending_paused" };
  }

  if (!res.ok && res.retry_later) {
    if (!retryState) {
      res = { ok: false, error: res.error ?? "retry_later" };
    } else {
      const deferred = await deferDispatchForRetry(svc, decision_id, res.error ?? "retry_later", retryState);
      if (deferred.kind === "deferred") return { ok: false, error: "retry_later" };
      retriesExhausted = deferred.message;
      res = { ok: false, error: deferred.reason };
    }
  }

  if (!res.ok && res.outcome_unknown && decision.decision_class !== "outbound.send") {
    const checking = decision.decision_class === "email_campaign.create_and_send" && res.reconcile_queued === true;
    if (decision.decision_class === "email_campaign.create_and_send") {
      const { OUTCOME_UNKNOWN_SUFFIX } = await import("@/services/connectors/email-campaign/execute-send");
      const marked = { dispatched_at: new Date().toISOString(), dispatch_error: `${(res.error ?? "").slice(0, 400)}${OUTCOME_UNKNOWN_SUFFIX}` };
      const { error: markErr } = checking ? await svc.from("decisions").update(marked).eq("id", decision_id).eq("status", "dispatching") : { error: null };
      if (!checking || markErr) {
        await settleDecisionStatus(
          svc,
          decision_id,
          { status: DECISION_STATUS_DISPATCH_FAILED, ...marked },
          { tenant_id: decision.tenant_id, handler: decision.handler, handler_ok: false, side_effect_ran: true },
        );
      }
      if (checking && markErr) {
        const { tellEmailSendOutcomeOrQueue } = await import("@/services/email-cards/outcome-tell");
        await tellEmailSendOutcomeOrQueue({ tenant_id: decision.tenant_id, rail: "decisions", card_id: decision_id, outcome: "unknown", sent: null, reason: res.error ?? null }).catch(() => undefined);
      }
    }
    await logEvent({
      level: "error",
      source: "dispatch-decision",
      code: "decision_outcome_unknown",
      message: `decision ${decision_id}: outcome unknown, ${checking ? "left dispatching, check queued" : decision.decision_class === "email_campaign.create_and_send" ? "closed dispatch_failed" : "left dispatching"}`,
      tenant_id: decision.tenant_id,
      meta: { decision_class: decision.decision_class },
    });
    await alertFounderOnDecision({ ...decision, id: decision_id }, "unknown");
    return { ok: false, error: res.error ?? "outcome_unknown" };
  }

  await settleDecisionStatus(
    svc,
    decision_id,
    {
      status: res.ok ? "acted" : DECISION_STATUS_DISPATCH_FAILED,
      dispatched_at: new Date().toISOString(),
      dispatch_error: res.ok ? null : res.error ?? "unknown",
    },
    {
      tenant_id: decision.tenant_id,
      handler: decision.handler,
      handler_ok: res.ok,
      side_effect_ran: true,
    },
  );
  if (!res.ok) await alertFounderOnDecision({ ...decision, id: decision_id }, "failed");
  if (!res.ok) await tellPairedPartialFor(decision, decision_id, res.error);
  if (!res.ok) await settleMoveLeg(decision, decision_id, "uncertain");
  if (retriesExhausted) await alertRetriesExhausted(decision.tenant_id, decision_id, retriesExhausted);
  if (res.ok) await retireStaleBudgetProposals(decision.tenant_id, { kind: "decision", id: decision_id, execClass: decision.decision_class });
  if (res.ok) await settleMoveLeg(decision, decision_id, "acted");

  console.log(
    `[dispatch-decision] notify-check decision=${decision_id} agent_run_id=${
      decision.agent_run_id ?? "null"
    } chatThreadId=${chatThreadId ?? "null"} slackChannel=${
      slackRouting?.channel_id ?? "null"
    } handler=${decision.handler} ok=${res.ok}`,
  );
  if (chatThreadId) {
    const { data: ownThread } = await svc
      .from("agent_threads")
      .select("id")
      .eq("id", chatThreadId)
      .eq("tenant_id", decision.tenant_id)
      .maybeSingle();
    if (ownThread) {
      await postDispatchNotice(svc, {
        thread_id: chatThreadId,
        tenant_id: decision.tenant_id,
        decision_id,
        handler: decision.handler,
        decision_class: decision.decision_class,
        res,
      });
    } else {
      console.warn(
        `[dispatch-decision] thread ${chatThreadId} not owned by tenant ${decision.tenant_id} — skipping in-thread notice (cross-tenant guard)`,
      );
    }
  }
  if (slackRouting) {
    await postSlackDispatchNotice({
      deliver: opts?.slackNotice ?? "direct",
      svc,
      routing: slackRouting,
      tenant_id: decision.tenant_id,
      agent_run_id: decision.agent_run_id,
      decision_id,
      handler: decision.handler,
      res,
    });
  }

  await writeOutcomeToApprovalCard({
    tenant_id: decision.tenant_id,
    decision_id,
    agent_run_id: decision.agent_run_id,
    handler: decision.handler,
    res,
  });

  if (res.ok && res.pr?.url && res.verify?.status !== "passed") {
    try {
      await inngest.send({
        name: "engineer.pr.ci.readback.requested",
        data: {
          tenant_id: decision.tenant_id,
          decision_id,
          pr_url: res.pr.url,
          agent_run_id: decision.agent_run_id,
        },
      });
    } catch (e) {
      console.warn(
        `[dispatch-decision] ci-readback event send failed for decision ${decision_id}: ${(e as Error).message}`,
      );
    }
  }

  const founderCard = (decision.body as { founder_chat_order?: unknown } | null)?.founder_chat_order === true && /^(meta_ads|google_ads)\./.test(decision.decision_class);
  if (res.ok && decision.agent_run_id && !founderCard) {
    const { resumeAfterDecision } = await import(
      "@/services/agents/approve-resume-dispatch"
    );
    const { enqueueAgentRun } = await import("@/services/agents/runner");
    const resume: PendingResume = {
      tenant_id: decision.tenant_id,
      agent_run_id: decision.agent_run_id,
      approved: true,
      toolName: decision.handler ?? decision.decision_class,
      outcome: res.agent_outcome ?? res.notice ?? null,
      allowFinished: !!decision.approved_by,
    };
    const r = await resumeAfterDecision(resume, { enqueue: (input) => enqueueAgentRun(input), svc });
    if (r.reason === "still_running") return { ...res, resume_pending: resume };
  }

  return res;
}

export type PendingResume = {
  tenant_id: string;
  agent_run_id: string;
  approved: boolean;
  toolName: string;
  outcome: string | null;
  allowFinished?: boolean;
};

export async function resumeWhenRunEnds(p: PendingResume): Promise<boolean> {
  const { resumeAfterDecision } = await import("@/services/agents/approve-resume-dispatch");
  const { enqueueAgentRun } = await import("@/services/agents/runner");
  const r = await resumeAfterDecision(
    { ...p, allowFinished: p.allowFinished ?? true },
    { enqueue: (input) => enqueueAgentRun(input), svc: serviceClient() },
  );
  return r.reason !== "still_running";
}

async function notifyDispatchFailure(args: {
  svc: ReturnType<typeof serviceClient>;
  decision: DecisionRow;
  decision_id: string;
  slackRouting: SlackRouting | null;
  error: string;
  deliver?: "direct" | "outbox";
}): Promise<void> {
  const common = {
    svc: args.svc,
    tenant_id: args.decision.tenant_id,
    agent_run_id: args.decision.agent_run_id,
    decision_id: args.decision_id,
    handler: args.decision.handler,
  };
  if (args.slackRouting) {
    await postSlackDispatchNotice({
      deliver: args.deliver ?? "direct",
      ...common,
      routing: args.slackRouting,
      res: { ok: false, error: args.error },
    });
  }
  await writeOutcomeToApprovalCard({ ...common, res: { ok: false, error: args.error } });
}

async function writeOutcomeToApprovalCard(args: {
  tenant_id: string;
  decision_id: string;
  agent_run_id: string | null;
  handler: string | null;
  res: HandlerResult;
}): Promise<void> {
  try {
    const ref = await getApprovalCardRef(args.decision_id, args.tenant_id);
    if (!ref) return;

    const body = buildDispatchNotice({
      handler: args.handler,
      ok: args.res.ok,
      error: args.res.error,
      notice: args.res.notice,
      outcome_unknown: args.res.outcome_unknown,
    });
    const ok = await updateApprovalCard({
      tenant_id: args.tenant_id,
      ref,
      text: mdToMrkdwn(body),
    });
    if (!ok) {
      console.warn(
        `[dispatch-decision] approval-card edit failed for decision ${args.decision_id} (tenant ${args.tenant_id}) — card left stale`,
      );
      await logEvent({
        level: "warn",
        source: "slack.dispatch_notice",
        code: "approval_card_edit_failed",
        tenant_id: args.tenant_id,
        run_id: args.agent_run_id,
      });
    }
  } catch (e) {
    console.warn(
      `[dispatch-decision] writeOutcomeToApprovalCard failed for decision ${args.decision_id}: ${
        (e as Error).message
      }`,
    );
  }
}

async function postSlackDispatchNotice(args: {
  svc: ReturnType<typeof serviceClient>;
  routing: { channel_id: string; thread_ts?: string; team_id?: string };
  tenant_id: string;
  agent_run_id: string | null;
  decision_id: string;
  handler: string | null;
  res: HandlerResult;
  deliver?: "direct" | "outbox";
}): Promise<void> {
  try {
    const { error: claimErr } = await args.svc.from("slack_triage_claims").insert({
      tenant_id: args.tenant_id,
      event_id: `dispatch-notice:${args.decision_id}`,
      status: "done",
      replied_at: new Date().toISOString(),
    });
    if (claimErr) {
      if ((claimErr as { code?: string }).code === "23505") return;
      console.warn(
        `[dispatch-decision] slack notice claim insert failed for decision ${args.decision_id}: ${claimErr.message}`,
      );
    }
    const bodyMd = buildDispatchNotice({
      handler: args.handler,
      ok: args.res.ok,
      error: args.res.error,
      notice: args.res.notice,
      outcome_unknown: args.res.outcome_unknown,
    });
    if (args.deliver === "outbox") {
      const seq = await enqueueSlackOutbox({
        tenant_id: args.tenant_id,
        channel_id: args.routing.channel_id,
        thread_ts: args.routing.thread_ts,
        team_id: args.routing.team_id,
        run_id: args.agent_run_id,
        kind: "pr_link",
        body: mdToMrkdwn(bodyMd),
        idempotency_key: `dispatch-notice:${args.decision_id}`,
        depends_on_answer: true,
      });
      if (seq === null) {
        await releaseSlackNoticeClaim(args.svc, args.tenant_id, args.decision_id);
        await logEvent({
          level: "warn",
          source: "slack.dispatch_notice",
          code: "notice_enqueue_failed",
          tenant_id: args.tenant_id,
          run_id: args.agent_run_id,
          meta: { tool_name: "slack.outbox" },
        });
      }
      return;
    }
    const r = await callMcpTool(
      {
        tenant_id: args.tenant_id,
        run_id: args.agent_run_id ?? "",
        slack_target_team_id: args.routing.team_id,
      },
      "slack",
      "post_message",
      {
        channel_id: args.routing.channel_id,
        thread_ts: args.routing.thread_ts,
        text: mdToMrkdwn(bodyMd),
      },
    );
    if (r.is_error) {
      console.warn(
        `[dispatch-decision] postSlackDispatchNotice post failed for decision ${args.decision_id}: ${r.content}`,
      );
      await logEvent({
        level: "warn",
        source: "slack.dispatch_notice",
        code: "notice_post_failed",
        tenant_id: args.tenant_id,
        run_id: args.agent_run_id,
        meta: { tool_name: "slack.post_message" },
      });
      await releaseSlackNoticeClaim(args.svc, args.tenant_id, args.decision_id);
    } else if (args.res.pr?.url) {
      try {
        const postedTs =
          (() => {
            try {
              return (JSON.parse(r.content) as { ts?: unknown }).ts;
            } catch {
              return undefined;
            }
          })();
        if (typeof postedTs === "string" && postedTs.length > 0) {
          await args.svc.rpc("upsert_dispatch_notice_ref", {
            p_decision_id: args.decision_id,
            p_surface: "slack",
            p_tenant_id: args.tenant_id,
            p_slack_channel_id: args.routing.channel_id,
            p_slack_ts: postedTs,
            p_slack_team_id: args.routing.team_id ?? null,
            p_notice_body: bodyMd,
            p_pr_url: args.res.pr.url,
            p_pr_number: args.res.pr.number,
          });
        }
      } catch (e) {
        console.warn(
          `[dispatch-decision] slack notice-ref upsert failed for decision ${args.decision_id}: ${(e as Error).message}`,
        );
      }
    }
  } catch (e) {
    console.warn(
      `[dispatch-decision] postSlackDispatchNotice failed for decision ${args.decision_id}: ${
        (e as Error).message
      }`,
    );
    await releaseSlackNoticeClaim(args.svc, args.tenant_id, args.decision_id);
  }
}

async function releaseSlackNoticeClaim(
  svc: ReturnType<typeof serviceClient>,
  tenant_id: string,
  decision_id: string,
): Promise<void> {
  try {
    const { error } = await svc
      .from("slack_triage_claims")
      .delete()
      .eq("tenant_id", tenant_id)
      .eq("event_id", `dispatch-notice:${decision_id}`);
    if (error) {
      console.warn(
        `[dispatch-decision] slack notice claim release failed for decision ${decision_id}: ${error.message}`,
      );
    }
  } catch {
  }
}

async function postDispatchNotice(
  svc: ReturnType<typeof serviceClient>,
  args: {
    thread_id: string;
    tenant_id: string;
    decision_id: string;
    handler: string | null;
    decision_class: string;
    res: HandlerResult;
  },
): Promise<void> {
  try {
    const body = buildDispatchNotice({
      handler: args.handler,
      ok: args.res.ok,
      error: args.res.error,
      notice: args.res.notice,
      outcome_unknown: args.res.outcome_unknown,
    });
    const { data: insRow, error: insErr } = await svc
      .from("agent_thread_messages")
      .insert({
        thread_id: args.thread_id,
        tenant_id: args.tenant_id,
        sender_role: "assistant",
        body,
        meta: {
          dispatch_notice: true,
          decision_id: args.decision_id,
          decision_class: args.decision_class,
          ok: args.res.ok,
        },
        agent_run_id: null,
      })
      .select("id")
      .maybeSingle();
    if (insErr) {
      console.warn(
        `[dispatch-decision] postDispatchNotice insert failed for decision ${args.decision_id} thread ${args.thread_id}: ${insErr.message}`,
      );
      return;
    }
    if (args.res.pr?.url && insRow) {
      try {
        await svc.rpc("upsert_dispatch_notice_ref", {
          p_decision_id: args.decision_id,
          p_surface: "chat",
          p_tenant_id: args.tenant_id,
          p_chat_message_id: (insRow as { id: string }).id,
          p_chat_thread_id: args.thread_id,
          p_notice_body: body,
          p_pr_url: args.res.pr.url,
          p_pr_number: args.res.pr.number,
        });
      } catch (e) {
        console.warn(
          `[dispatch-decision] chat notice-ref upsert failed for decision ${args.decision_id}: ${(e as Error).message}`,
        );
      }
    }
    const { error: updErr } = await svc
      .from("agent_threads")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", args.thread_id);
    if (updErr) {
      console.warn(
        `[dispatch-decision] postDispatchNotice last_message_at bump failed for thread ${args.thread_id}: ${updErr.message}`,
      );
    }
  } catch (e) {
    console.warn(
      `[dispatch-decision] postDispatchNotice failed for decision ${args.decision_id}: ${
        (e as Error).message
      }`,
    );
  }
}

export const dispatchDecisionFn = inngest.createFunction(
  { id: "dispatch-decision", retries: 1 },
  { event: "decision.approved" },
  async ({ event, step, logger }) => {
    const decision_id = event.data.decision_id;
    const refuse = await step.run("approval-guard", async () => {
      const { data, error } = await serviceClient()
        .from("decisions")
        .select("decision_class, status, approved_by, handler")
        .eq("id", decision_id)
        .maybeSingle();
      if (error) {
        console.warn(
          `[dispatch-decision] approval-guard read failed for ${decision_id} (failing CLOSED): ${error.message}`,
        );
        return true;
      }
      const row = data as {
        decision_class?: string | null;
        status?: string | null;
        approved_by?: string | null;
        handler?: string | null;
      } | null;
      return (
        shouldRefuseUnapprovedShipPr(row) ||
        shouldRefuseUnapprovedComposioWrite(row) ||
        shouldRefuseUnapprovedExactActionCard(row) ||
        shouldRefuseUnapprovedBulkEmail(row)
      );
    });
    if (refuse) {
      logger.warn(
        `dispatch-decision: refusing decision.approved for ${decision_id} — not human-approved (engineer.ship-pr with no approved_by, or a Composio write / exact-action card whose row is not 'approved')`,
      );
      return { ok: false, error: "approval_gate:not_human_approved" };
    }
    const res = await step.run("execute", () => executeDispatch(decision_id));
    if (!res.ok) {
      logger.warn(`dispatch-decision: ${decision_id} failed — ${res.error}`);
    }
    const pending = res.resume_pending;
    if (pending) {
      for (let i = 0; i < 18; i++) {
        await step.sleep(`resume-wait-${i}`, "10s");
        if (await step.run(`resume-retry-${i}`, () => resumeWhenRunEnds(pending))) break;
      }
    }
    return res;
  },
);

type AutoCronRow = {
  id: string;
  tenant_id: string;
  decision_class: string;
  body?: Record<string, unknown> | null;
  agent_run_id?: string | null;
};

export function estimateUsdFromDecisionBody(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  if (isPendingStrategistBody(body)) return 0;
  const b = body as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const proposed = num(b.daily_budget_usd);
  const prior = num(b.expected_current_daily_budget_usd);
  if (proposed !== null && prior !== null) return Math.abs(proposed - prior);
  if (proposed !== null) return Math.abs(proposed);
  for (const key of ["estimate_usd", "amount_usd", "cost_usd", "spend_usd"]) {
    const v = num(b[key]);
    if (v !== null) return Math.abs(v);
  }
  return 0;
}

export const DRAIN_ROTATE_MS = 10 * 60 * 1000;

async function rotateScannedRow(decision_id: string, now: Date): Promise<void> {
  const until = new Date(now.getTime() + DRAIN_ROTATE_MS).toISOString();
  try {
    const { error } = await serviceClient()
      .from("decisions")
      .update({ dispatch_retry_after: until })
      .eq("id", decision_id)
      .eq("status", "proposed")
      .or(`dispatch_retry_after.is.null,dispatch_retry_after.lt."${until}"`);
    if (error) console.warn(`[dispatch-auto-cron] rotate ${decision_id} failed: ${error.message}`);
  } catch (e) {
    console.warn(`[dispatch-auto-cron] rotate ${decision_id} failed: ${(e as Error).message}`);
  }
}

export async function autoCronDispatchBatch(
  rows: AutoCronRow[],
): Promise<{ acted: number; rate_capped: number }> {
  let acted = 0;
  let rateCapped = 0;
  const now = new Date();
  for (const row of rows) {
    try {
      if (NEVER_AUTO_DECISION_CLASSES.has(row.decision_class)) {
        rateCapped++;
        await logEvent({
          level: "warn",
          source: "dispatch-auto-cron",
          code: "never_auto_class_blocked",
          message:
            `decision class is approval-only (browser writes can never auto-fire) ` +
            `but a row reached the auto-cron with autonomy_at_emit='auto' — refusing ` +
            `to auto-dispatch; left proposed for manual approval`,
          tenant_id: row.tenant_id,
          meta: { decision_class: row.decision_class },
        });
        await logDecisionNotTaken({
          tenant_id: row.tenant_id,
          rejection_type: "condition_unmet",
          decision_class: row.decision_class,
          reason_code: "never_auto_class_blocked",
        });
        continue;
      }
      if (row.decision_class === "perfmkt.create_ad_set_pending_strategist") {
        const r = await executeDispatch(row.id);
        if (r.ok) acted++;
        continue;
      }
      if (row.decision_class === "engineer.ship-pr") {
        let trigger: string | null | undefined;
        let readOk = false;
        if (row.agent_run_id) {
          const { data: runRow, error: runErr } = await serviceClient()
            .from("agent_runs")
            .select("trigger")
            .eq("id", row.agent_run_id)
            .maybeSingle();
          if (!runErr && runRow) {
            readOk = true;
            trigger = (runRow as { trigger?: string | null }).trigger;
          }
        }
        const pushToMain =
          !!row.body &&
          typeof row.body === "object" &&
          (row.body as { push_to_main?: unknown }).push_to_main === true;
        if (
          shouldHoldInteractiveShipPr({
            hasRunId: !!row.agent_run_id,
            readOk,
            trigger,
            pushToMain,
          })
        ) {
          rateCapped++;
          await logEvent({
            level: "warn",
            source: "dispatch-auto-cron",
            code: "engineer_pr_interactive_hold",
            message:
              "engineer.ship-pr held from auto-open — unverifiable trigger, or a " +
              "push_to_main row on an interactive trigger (defense-in-depth)",
            tenant_id: row.tenant_id,
            meta: { decision_class: row.decision_class },
          });
          await logDecisionNotTaken({
            tenant_id: row.tenant_id,
            rejection_type: "condition_unmet",
            decision_class: row.decision_class,
            reason_code: "engineer_pr_interactive_hold",
          });
          continue;
        }
        if (trigger === "chat" || trigger === "slack") {
          await logEvent({
            level: "info",
            source: "dispatch-auto-cron",
            code: "engineer_pr_interactive_autoopen",
            message: `engineer.ship-pr from ${trigger} trigger — auto-opening PR (no pre-open approval)`,
            tenant_id: row.tenant_id,
            meta: { decision_class: row.decision_class },
          });
        }
      }
      const waiver = await resolveWaiverState(row.tenant_id, row.decision_class);
      if (waiver.state === "expired") {
        rateCapped++;
        await logEvent({
          level: "warn",
          source: "dispatch-auto-cron",
          code: "autopilot_waiver_expired_blocked",
          message:
            "autopilot waiver has expired but the override row still says autonomy='auto' — " +
            "refusing to auto-dispatch; left proposed for manual approval (the 15min " +
            "autopilot-waiver-expire cron will revoke the row on its next tick)",
          tenant_id: row.tenant_id,
          meta: {
            decision_class: row.decision_class,
          },
        });
        await logDecisionNotTaken({
          tenant_id: row.tenant_id,
          rejection_type: "condition_unmet",
          decision_class: row.decision_class,
          reason_code: "autopilot_waiver_expired_blocked",
        });
        continue;
      }
      const capRes = await checkAutoFireRateCap(row.tenant_id, row.decision_class);
      if (!capRes.allowed) {
        rateCapped++;
        await logEvent({
          level: "warn",
          source: "dispatch-auto-cron",
          code:
            capRes.reason === "count_error"
              ? "auto_fire_rate_cap_count_error"
              : "auto_fire_rate_capped",
          message:
            capRes.reason === "count_error"
              ? `auto-fire rate-cap count errored for class — failing closed, decision left proposed for manual approval`
              : `auto-fire rate cap reached for class — decision left proposed for manual approval`,
          tenant_id: row.tenant_id,
          meta: {
            decision_class: row.decision_class,
            count: capRes.count,
            cap: capRes.cap,
          },
        });
        await logDecisionNotTaken({
          tenant_id: row.tenant_id,
          rejection_type: "cap_exceeded",
          decision_class: row.decision_class,
          reason_code:
            capRes.reason === "count_error"
              ? "auto_fire_rate_cap_count_error"
              : "auto_fire_rate_capped",
        });
        continue;
      }
      const estimate_usd = estimateUsdFromDecisionBody(row.body ?? null);
      const classVerdict = await consumeClassBudget(
        row.tenant_id,
        row.decision_class,
        estimate_usd,
      );
      if (classVerdict === "over_cap") {
        rateCapped++;
        await logEvent({
          level: "warn",
          source: "dispatch-auto-cron",
          code: "class_spend_cap_over",
          message:
            "per-class spend cap (rolling-24h or per-action ceiling) would be breached — " +
            "refusing to auto-dispatch; decision left proposed for manual approval",
          tenant_id: row.tenant_id,
          meta: {
            decision_class: row.decision_class,
          },
        });
        await logDecisionNotTaken({
          tenant_id: row.tenant_id,
          rejection_type: "cap_exceeded",
          decision_class: row.decision_class,
          reason_code: "class_spend_cap_over",
        });
        continue;
      }
      const r = await executeDispatch(row.id);
      if (r.ok) acted++;
    } finally {
      await rotateScannedRow(row.id, now);
    }
  }
  return { acted, rate_capped: rateCapped };
}

export const dispatchAutoCronFn = inngest.createFunction(
  { id: "dispatch-decision-auto-cron", concurrency: 1 },
  { cron: "*/10 * * * *" },
  async ({ logger }) => {
    const stopped = isWorkerCronStopped("dispatch-decision-auto-cron");
    const rows = await scanAutoCronRows(stopped);
    const { acted, rate_capped } = await autoCronDispatchBatch(rows);
    const { runEmailSendRecovery } = await import("@/services/email-cards/recovery");
    const email_recovery = await runEmailSendRecovery().catch((e) => {
      logger.warn(`dispatch-decision auto-cron: email send recovery failed: ${(e as Error).message}`);
      return null;
    });
    logger.info(
      `dispatch-decision auto-cron: acted on ${acted} of ${rows.length} (rate-capped ${rate_capped})` +
        (stopped ? " — stopped; only the classes that still run while stopped" : ""),
    );
    return { acted, scanned: rows.length, rate_capped, cron_stopped: stopped, email_recovery };
  },
);

export const AUTO_CRON_CLASSES_WHILE_STOPPED: readonly string[] = [
  "perfmkt.create_ad_set_pending_strategist",
];

export async function scanAutoCronRows(stopped: boolean, now: Date = new Date()): Promise<AutoCronRow[]> {
  let q = serviceClient()
    .from("decisions")
    .select("id, tenant_id, decision_class, body, agent_run_id")
    .eq("status", "proposed")
    .eq("autonomy_at_emit", "auto")
    .or(`dispatch_eligible_at.is.null,dispatch_eligible_at.lte."${now.toISOString()}"`);
  if (stopped) q = q.in("decision_class", [...AUTO_CRON_CLASSES_WHILE_STOPPED]);
  const { data, error } = await q
    .order("dispatch_eligible_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(50);
  if (error) {
    throw new Error(`auto-cron scan failed: ${error.message}`);
  }
  return (data ?? []) as AutoCronRow[];
}

export const __testOnly_handlers = HANDLERS;

export const DECISION_HANDLERS: Readonly<Record<string, Handler>> = HANDLERS;

export const __testOnly_executeDispatch = executeDispatch;
export const __testOnly_settleMoveLeg = settleMoveLeg;
