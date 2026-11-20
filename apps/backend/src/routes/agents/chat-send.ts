
import type { Request, Response } from "express";
import { z } from "zod";
import { CHANNELS, isChannelSlug } from "@zavi/shared";
import { createHash, randomUUID } from "node:crypto";
import { requireAuth } from "@/services/auth/middleware";
import { connectGateSlugFor } from "@/services/agents/connect-gate";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import { approveFromChatQuickPath } from "@/services/approvals/chat-quick-approve";
import { track } from "@/services/analytics/mixpanel";
import { trackApprovalCardDecided } from "@/services/analytics/action-events";
import { canUserAccessAgent } from "@/services/auth/members";
import { loadAgentDefinition } from "@/services/agents/registry";
import { isMainAgentSlug } from "@/services/agents/main-agents";
import { pinMentionOnRun, resolveMention, type MentionPinDb } from "@/services/agents/mention";
import { channelForAgent } from "@/services/agents/channel-agents";
import { ensureAgentRunnable } from "@/services/agents/ensure-runnable";
import {
  admitDirectChannelRun,
  stampDirectChannelRun,
} from "@/services/channels/direct-run";
import { isInsufficientCreditsError } from "@/services/agents/credits";
import { isPlanUpgradeError, type Tier } from "@/services/billing/tiers";
import { planUpgradeErrorBody, refreshPlanWallFacts, requiredTierFromDbError } from "@/services/agents/entitlement";
import { refusalText } from "@/services/agents/refusal";
import {
  isScreenshotPageContext,
  normalizePageContext,
  normalizeScreenshotPageContext,
  pageContextRequestSchema,
  PAGE_CONTEXT_SURFACE,
} from "@/services/agents/page-context";
import { recordAdapterHealth } from "@/services/agents/page-context-health";
import { checkExtensionDailyCap } from "@/services/agents/extension-spend-guard";
import { hasCurrentExtensionConsent } from "@/services/extension/consent";
import { validateScreenshotTurn } from "@/services/extension/screenshots";
import { bindRunToPanelSession } from "@/services/extension/run-binding";
import { buildRunRequestedEvent } from "@/services/agents/run-lane";
import { isAgentKilled } from "@/services/agents/kill-switch";
import { validateDecisionEvidenceInBody } from "@/services/agents/decision-evidence";
import { buildShipPrEvidence } from "@/agents/engineer/ship-pr-evidence";
import { parseRepoPickReply } from "@/services/sandbox/repo-picker";
import { dispatchDeterministicConfirm } from "@/services/agents/qa-confirm-service";
import { qaInflightCutoffISO } from "@/services/agents/qa-inflight";
import {
  isPureAcknowledgment,
  shouldSuppressAsAck,
} from "@/services/agents/acknowledgment-classify";
import { inngest } from "@/../workers/client";
import {
  evaluateCtoShipGate,
  shipBlockExplanation,
  isNoDiffReason,
} from "@/agents/engineer/ship-gate";
import {
  decomposeMessage,
  type EnrichedTaskSpec,
} from "@/agents/engineer/decompose";
import {
  classifyEngineerPrApproval,
  readApprovalClass,
  requiresExplicitShipRed,
} from "@/agents/engineer/approval-class";
import { pickRepoForTask } from "@/services/sandbox/repo-picker";
import {
  BUILD_PROGRESS_PAYLOAD_KEY,
  BUILD_SESSION_PAYLOAD_KEY,
  buildProgressOfSession,
  buildSessionOfThread,
  isOwnedBuildSession,
  mustForkThread,
  type BindingDb,
} from "@/services/agents/build-session-binding";
import { getScopedRepoFullNames } from "@/services/connectors/github/scoped-repos";
import { siteIdForRepo } from "@/services/sites/site-repo-hint";
import { getBoolSetting } from "@/services/settings";
import {
  checkSandboxRepoAccess,
  repoAccessBlockedMessage,
} from "@/services/sandbox/repo-access-gate";
import { dispatchBatchFanout } from "@/services/agents/batch-fanout-dispatcher";
import { supersedeEditedMessage } from "@/services/agents/supersede-edited-message";
import { requestStopForRun } from "@/services/agents/request-stop";
import { enqueueWorkItem } from "@/services/agents/work-queue";
import {
  classifyFollowupCandidates,
  buildFollowupPayload,
  followupDedupeKey,
  isSafeCheckoutRef,
  type OpenEngineerPr,
} from "@/services/agents/chat-pr-followup";
import { answerNonPushFollowup } from "@/services/agents/pr-nonpush-answer";
import {
  captureEngineerPreview,
  previewCaptureLogMeta,
  storePreviewScreenshot,
} from "@/services/sandbox/engineer-preview-capture";
import { logEvent } from "@/services/logging/logEvent";
import { UiToolsSchema } from "@/services/copilotkit/ui-tools";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";
import { flagPreviousReply } from "@/services/team-notes/flag-previous-reply";
import { CGO, tryGreeting, tryResolveConflict, trySetupFaq } from "@/services/setup/chat-fastpaths";
import { holdResponseForPageOrigin, type PageOriginContext } from "@/services/agents/page-origin-response";
import { findSecretLikeTokens, SECRET_IN_CHAT_MESSAGE } from "@/services/site-functions/contract";
import {
  maybeHandleBuildConfirmReply,
  BUILD_CONFIRM_RETRY,
} from "@/services/agents/heavy-build-confirm";
import { decideStaffModel } from "@/services/agents/staff-model-gate";
import {
  isTenantOwnerOrAdmin,
  checkStaffModelCap,
} from "@/services/auth/staff-model-access";

const IMAGE_PATH_REGEX = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/;

const Body = z
  .object({
    message: z.string().max(32000).optional().default(""),
    thread_id: z.string().uuid().nullable().optional(),
    command_slug: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/)
      .optional(),
    image_paths: z.array(z.string().regex(IMAGE_PATH_REGEX)).max(4).optional(),
    doc_paths: z
      .array(
        z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|txt|docx|csv)$/),
      )
      .max(4)
      .optional(),
    video_paths: z
      .array(z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4$/))
      .max(1)
      .optional(),
    channels: z
      .array(z.string().refine(isChannelSlug, "unknown channel"))
      .max(CHANNELS.length)
      .optional(),
    repo_hint: z.string().max(120).optional(),
    edit_of_message_id: z.string().uuid().optional(),
    depth: z.enum(["deep"]).optional(),
    message_origin: z.enum(["app_action"]).optional(),
    model: z.string().max(40).regex(/^[A-Za-z0-9.\- ]*$/).optional(),
    page_context: pageContextRequestSchema.optional(),
    preview_session_id: z.string().uuid().optional(),
    build_session_id: z.string().uuid().optional(),
    channel_action_id: z.string().max(64).optional(),
    view_context: z
      .array(z.object({ description: z.string().max(80), value: z.string().max(500) }))
      .max(8)
      .optional(),
    page_channel: z.string().refine(isChannelSlug, "unknown channel").optional(),
    page_channel_action_id: z.string().max(64).optional(),
    panel_session_id: z.string().uuid().optional(),
    ui_tools: UiToolsSchema.optional(),
  })
  .refine(
    (b) =>
      (b.message?.trim().length ?? 0) > 0 ||
      (b.image_paths?.length ?? 0) > 0 ||
      (b.video_paths?.length ?? 0) > 0 ||
      (b.doc_paths?.length ?? 0) > 0,
    { message: "either message, image_paths, video_paths, or doc_paths must be non-empty" },
  );

const COMMAND_WRAPPER_PREFIX = "[Command: ";
const COMMAND_WRAPPER_MID = "]\n";
const COMMAND_WRAPPER_BODY_HEADER = "\n\n[User input]\n";
const SEND_AGENT_CHAT_TURN_MAX = 32000;

const VIDEO_ONLY_MESSAGE_BODY = "(video)";

const SANDBOX_TASK_DESCRIPTION_MAX = 2000;

const CHANNEL_STAMP_DEADLINE_MS = 1_500;

type AwaitingRepoPickMeta = {
  awaiting_repo_pick?: boolean;
  repos?: string[];
  pending_task_description?: string;
};

type PendingPrProposalEnvelope = {
  pending_pr_proposal?: boolean;
  files?: Array<{
    path: string;
    action: string;
    diff?: string;
    content?: string;
  }>;
  repo?: string;
  base_branch?: string;
  head_branch?: string;
  title?: string;
  body?: string;
  rendered_markdown?: string;
  risk_class?: string;
  test_results?: unknown;
};

type PendingBatchFanoutEnvelope = {
  kind?: "batch_fanout";
  pending_batch_proposal?: boolean;
  batch_id?: string;
  approval_token?: string;
  tasks?: Array<{ title: string; task_description: string; repo?: string }>;
  superseded_at?: string;
};

type PrevAssistantEnvelope = PendingPrProposalEnvelope &
  PendingBatchFanoutEnvelope;

const AFFIRMATIVE_PATTERNS = [
  /^yes\b/i,
  /^y\b/i,
  /^ok\b/i,
  /^okay\b/i,
  /^sure\b/i,
  /^approve\b/i,
  /^approved\b/i,
  /^ship\b/i,
  /^ship it\b/i,
  /^lgtm\b/i,
  /^go\b/i,
  /^go ahead\b/i,
  /^do it\b/i,
  /^send it\b/i,
  /^proceed\b/i,
  /^👍/,
  /^✅/,
];

const APPROVAL_REPLY_MAX_CHARS = 30;

function isAffirmativeApproval(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > APPROVAL_REPLY_MAX_CHARS) return false;
  return AFFIRMATIVE_PATTERNS.some((pat) => pat.test(trimmed));
}

export function isShipRedOverride(message: string): boolean {
  return /^ship\s+red[.!]?$/i.test(message.trim());
}

const NEGATIVE_PATTERNS = [
  /^no\b/i,
  /^n\b/i,
  /^cancel\b/i,
  /^reject\b/i,
  /^stop\b/i,
  /^nope\b/i,
  /^nvm\b/i,
  /^never mind\b/i,
  /^don['']?t\b/i,
  /^discard\b/i,
  /^❌/,
  /^👎/,
];

function isExplicitRejection(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > APPROVAL_REPLY_MAX_CHARS) return false;
  return NEGATIVE_PATTERNS.some((pat) => pat.test(trimmed));
}

export async function agentChatSend(
  req: Request,
  res: Response,
): Promise<void> {
  const hold = holdResponseForPageOrigin(res);
  try {
    await agentChatSendTurn(req, hold.res, hold.setOrigin);
  } finally {
    await hold.release();
  }
}

async function agentChatSendTurn(
  req: Request,
  res: Response,
  setPageOrigin: (ctx: PageOriginContext) => void,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const slug = req.params.slug;
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body ?? {});
  } catch (e) {
    res
      .status(400)
      .json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const pageOrigin =
    !!body.page_channel && channelForAgent(slug)?.channel_slug === body.page_channel;
  if (pageOrigin && body.page_channel) {
    setPageOrigin({
      tenantId: auth.tenant_id,
      userId: auth.user_id,
      agentSlug: slug,
      pageChannel: body.page_channel,
      pageChannelActionId: body.page_channel_action_id ?? null,
    });
  }

  if (body.page_context) {
    const consented = await hasCurrentExtensionConsent(
      auth.tenant_id,
      auth.user_id,
    );
    if (!consented) {
      res.status(403).json({
        error: {
          code: "consent_required",
          message:
            "Zavi needs your OK before it can read the page you're on. Open the Zavi extension to turn page reading on.",
        },
      });
      return;
    }
  }

  if (body.build_session_id) {
    let owned: boolean;
    try {
      owned = await isOwnedBuildSession(serviceClient() as unknown as BindingDb, auth.tenant_id, body.build_session_id);
    } catch (e) {
      console.warn(`[chat-send] build session check failed: ${(e as Error).message}`);
      res.status(503).json({
        error: {
          code: "build_session_check_failed",
          message: "Couldn't check which app this message is for. Nothing was sent; try again in a moment.",
        },
      });
      return;
    }
    if (!owned) {
      res.status(404).json({
        error: {
          code: "build_session_not_found",
          message: "This app isn't in your workspace any more. Open it again from your builds, then resend.",
        },
      });
      return;
    }
    if (findSecretLikeTokens(body.message).length > 0) {
      res.status(422).json({ error: { code: "secret_in_chat", message: SECRET_IN_CHAT_MESSAGE } });
      return;
    }
  }
  let buildSessionId: string | null = null;
  let threadBoundTo: string | null = null;
  if (slug === "operator" && body.build_session_id) {
    const sbBind = serviceClient() as unknown as BindingDb;
    buildSessionId = body.build_session_id.toLowerCase();
    if (body.thread_id && !body.edit_of_message_id) {
      try {
        const boundTo = await buildSessionOfThread(sbBind, auth.tenant_id, body.thread_id);
        if (mustForkThread(buildSessionId, boundTo)) body.thread_id = undefined;
        else threadBoundTo = boundTo;
      } catch (e) {
        console.warn(`[chat-send] thread binding read failed: ${(e as Error).message}`);
        body.thread_id = undefined;
      }
    }
  }
  if (slug !== "operator" && body.build_session_id) {
    let siteBound = false;
    try {
      const { realRefineProductDeps } = await import("@/services/agents/refine-product");
      siteBound = !!(await realRefineProductDeps.loadSiteForRun?.(auth.tenant_id, body.build_session_id));
    } catch (e) {
      console.warn(`[chat-send] build session check failed (${slug}): ${(e as Error).message}`);
      siteBound = true;
    }
    if (siteBound) {
      res.status(409).json({
        error: {
          code: "site_edit_via_build_chat",
          message:
            "To change this site, ask in the Build chat without @-mentioning an agent, and Zavi will edit this site.",
        },
      });
      return;
    }
  }

  const screenshotTurn = isScreenshotPageContext(body);
  if (screenshotTurn) {
    const verdict = await validateScreenshotTurn({
      tenant_id: auth.tenant_id,
      user_id: auth.user_id,
      image_paths: body.image_paths,
    });
    if (!verdict.ok) {
      res.status(400).json({
        error: { code: verdict.code, message: verdict.message },
      });
      return;
    }
  }

  if (body.page_context && !screenshotTurn) {
    const cap = await checkExtensionDailyCap(auth.tenant_id);
    if (!cap.allowed) {
      res.status(429).json({
        error: {
          code: "extension_daily_cap",
          message: `You've used today's ${cap.cap} page reads. This resets at midnight UTC.`,
        },
      });
      return;
    }
  }

  const def = await loadAgentDefinition(slug, auth.tenant_id);
  if (!def) {
    res
      .status(404)
      .json({ error: { code: "not_found", message: `agent ${slug}` } });
    return;
  }

  const allowed = await canUserAccessAgent(
    serviceClient(),
    auth.user_id,
    auth.tenant_id,
    slug,
  );
  if (!allowed) {
    res.status(403).json({
      error: {
        code: "agent_not_allowed",
        message: "Your role is read-only. Ask a workspace admin to make you a member.",
      },
    });
    return;
  }

  let gates: Awaited<ReturnType<typeof ensureAgentRunnable>>;
  try {
    gates = await ensureAgentRunnable(auth.tenant_id, slug);
  } catch (e) {
    res.status(500).json({
      error: { code: "internal", message: (e as Error).message },
    });
    return;
  }
  const prFollowupCandidate =
    def.metadata_praxis.requires_sandbox &&
    !!body.thread_id &&
    !body.edit_of_message_id &&
    !body.command_slug &&
    (body.image_paths ?? []).length === 0 &&
    (body.doc_paths ?? []).length === 0 &&
    (body.video_paths ?? []).length === 0 &&
    body.message.trim().length > 0 &&
    !isAffirmativeApproval(body.message) &&
    !isExplicitRejection(body.message);
  let heldPlanRefusal: { required_tier: Tier } | null = null;
  if (!gates.runnable) {
    if (gates.reason === "plan_upgrade_required") {
      if (slug === "engineer" && prFollowupCandidate) {
        heldPlanRefusal = { required_tier: gates.required_tier ?? "pro" };
      } else {
        res.status(403).json(planUpgradeErrorBody(slug, gates.required_tier ?? "pro"));
        void notifyFounderActivity({
          event: "plan_upgrade_required",
          tenant_id: auth.tenant_id,
          user_id: auth.user_id,
          details: { refused: "plan_upgrade_required", agent: slug, where: "chat" },
        });
        return;
      }
    }
  }
  if (!gates.runnable && !heldPlanRefusal) {
    if (gates.reason === "not_found") {
      res.status(404).json({
        error: { code: "not_found", message: gates.detail },
      });
      return;
    }
    const DISABLED_REASONS = new Set([
      "default_disabled",
      "global_override_hide",
      "tenant_hidden_override",
      "staff_locked_hide",
    ]);
    const message = DISABLED_REASONS.has(gates.reason)
      ? "This agent isn't available for chat."
      : gates.detail;
    res.status(403).json({
      error: { code: gates.reason, message },
    });
    return;
  }

  if (def.metadata_praxis?.chat_eligible === false) {
    res.status(403).json({
      error: {
        code: "not_chat_eligible",
        message: "This agent isn't available for chat.",
      },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);

  if (body.edit_of_message_id) {
    if (!body.thread_id) {
      res.status(400).json({
        error: {
          code: "invalid_edit_message",
          message: "An edited message must belong to an existing thread.",
        },
      });
      return;
    }
    const sbEdit = serviceClient();
    const [
      { data: editThread, error: editThreadError },
      { data: editMessage, error: editMessageError },
    ] = await Promise.all([
      sbEdit
        .from("agent_threads")
        .select("id")
        .eq("id", body.thread_id)
        .eq("tenant_id", auth.tenant_id)
        .eq("user_id", auth.user_id)
        .eq("agent_slug", slug)
        .maybeSingle(),
      sbEdit
        .from("agent_thread_messages")
        .select("id, sender_role, meta")
        .eq("id", body.edit_of_message_id)
        .eq("thread_id", body.thread_id)
        .eq("tenant_id", auth.tenant_id)
        .maybeSingle(),
    ]);
    if (editThreadError || editMessageError) {
      res.status(500).json({
        error: {
          code: "edit_validation_failed",
          message: editThreadError?.message ?? editMessageError?.message,
        },
      });
      return;
    }
    const editMeta = (editMessage?.meta ?? {}) as Record<string, unknown>;
    if (
      !editThread ||
      editMessage?.sender_role !== "user" ||
      (typeof editMeta.superseded_by === "string" && editMeta.superseded_by)
    ) {
      res.status(409).json({
        error: {
          code: "invalid_edit_message",
          message: "This message can no longer be edited.",
        },
      });
      return;
    }
  }

  if (slug === "qa" && body.thread_id) {
    const sbGate = serviceClient();
    const { count, error: inFlightErr } = await sbGate
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id)
      .filter("payload->>thread_id", "eq", body.thread_id)
      .in("status", ["queued", "running"])
      .gt("enqueued_at", qaInflightCutoffISO());
    if (inFlightErr) {
      res.status(500).json({
        error: { code: "in_flight_check_failed", message: inFlightErr.message },
      });
      return;
    }
    if ((count ?? 0) > 0) {
      res.status(409).json({
        error: {
          code: "confirm_in_flight",
          message:
            "qa is still processing your previous message on this thread. Wait for it to finish, then resend.",
        },
      });
      return;
    }
  }

  const bareTextTurn = ![
    body.image_paths?.length,
    body.doc_paths?.length,
    body.video_paths?.length,
    body.channels?.length,
    body.repo_hint,
    body.edit_of_message_id,
    body.page_context,
    body.depth,
  ].some(Boolean);
  if (slug === "operator" && body.thread_id && !body.command_slug && bareTextTurn) {
    try {
      const handled = await maybeHandleBuildConfirmReply({
        tenant_id: auth.tenant_id,
        user_id: auth.user_id,
        thread_id: body.thread_id,
        message: body.message,
      });
      if (handled === BUILD_CONFIRM_RETRY) {
        res.status(503).json({
          error: {
            code: BUILD_CONFIRM_RETRY,
            message: "That didn't go through. Please send your message again.",
          },
        });
        return;
      }
      if (handled) {
        res.status(200).json({ thread_id: body.thread_id, ok: true, action: handled });
        return;
      }
    } catch (e) {
      console.warn(
        `[chat-send] build confirm fast path failed for thread ${body.thread_id}: ${(e as Error).message}`,
      );
    }
  }

  if (slug === "qa" && body.thread_id && !body.command_slug && !body.edit_of_message_id) {
    try {
      const outcome = await dispatchDeterministicConfirm({
        sb: serviceClient(),
        tenantId: auth.tenant_id,
        threadId: body.thread_id,
        message: body.message,
      });
      if (outcome.handled) {
        res.status(200).json({
          thread_id: body.thread_id,
          ok: true,
          action: `qa_confirm_${outcome.action}`,
          added: outcome.added,
          duplicates: outcome.duplicates,
        });
        return;
      }
    } catch (e) {
      console.warn(
        `[chat-send] deterministic confirm failed for thread ${body.thread_id}: ${(e as Error).message}`,
      );
    }
  }

  if (
    def.metadata_praxis.requires_sandbox &&
    body.thread_id &&
    !body.command_slug &&
    !body.edit_of_message_id
  ) {
    const sb = serviceClient();

    const { data: thread } = await sb
      .from("agent_threads")
      .select("user_id, agent_slug")
      .eq("id", body.thread_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    if (
      !thread ||
      (thread.user_id as string) !== auth.user_id ||
      (thread.agent_slug as string) !== slug
    ) {
    } else {
      const { data: prev } = await sb
        .from("agent_thread_messages")
        .select("meta, agent_run_id, id")
        .eq("thread_id", body.thread_id)
        .eq("tenant_id", auth.tenant_id)
        .eq("sender_role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const prevMeta = (prev?.meta ?? {}) as {
        envelope?: PrevAssistantEnvelope;
      };
      const envelope = prevMeta.envelope;

      if (
        envelope?.kind === "batch_fanout" &&
        envelope.pending_batch_proposal === true &&
        typeof envelope.batch_id === "string" &&
        Array.isArray(envelope.tasks) &&
        envelope.tasks.length > 0 &&
        envelope.superseded_at == null
      ) {
        const isApprove = isAffirmativeApproval(body.message);
        const isReject = isExplicitRejection(body.message);
        if (isApprove || isReject) {
          const batchId = envelope.batch_id;

          const { data: insertedUserMsg, error: userInsertErr } = await sb
            .from("agent_thread_messages")
            .insert({
              thread_id: body.thread_id,
              tenant_id: auth.tenant_id,
              sender_role: "user",
              body: body.message,
              agent_run_id: null,
            })
            .select("id")
            .single();
          if (userInsertErr) {
            res.status(500).json({
              error: {
                code: "user_msg_insert_failed",
                message: userInsertErr.message,
              },
            });
            return;
          }
          const approvalMessageId =
            (insertedUserMsg?.id as string | undefined) ?? null;

          if (isReject) {
            const { error: batchUpdErr } = await sb
              .from("agent_run_batches")
              .update({
                status: "cancelled",
                updated_at: new Date().toISOString(),
              })
              .eq("id", batchId)
              .eq("tenant_id", auth.tenant_id);
            if (batchUpdErr) {
              res.status(500).json({
                error: {
                  code: "batch_update_failed",
                  message: batchUpdErr.message,
                },
              });
              return;
            }
            await sb.from("agent_thread_messages").insert({
              thread_id: body.thread_id,
              tenant_id: auth.tenant_id,
              sender_role: "assistant",
              body: "_Discarded — no PRs opened. Send me a new task whenever you're ready._",
              meta: { discarded_batch_id: batchId },
              agent_run_id: null,
            });
            await sb
              .from("agent_threads")
              .update({ last_message_at: new Date().toISOString() })
              .eq("id", body.thread_id);
            res.status(200).json({
              thread_id: body.thread_id,
              ok: true,
              action: "batch_rejected",
              batch_id: batchId,
            });
            return;
          }

          const { error: approveStatusErr } = await sb
            .from("agent_run_batches")
            .update({
              status: "approved",
              updated_at: new Date().toISOString(),
            })
            .eq("id", batchId)
            .eq("tenant_id", auth.tenant_id);
          if (approveStatusErr) {
            res.status(500).json({
              error: {
                code: "batch_update_failed",
                message: approveStatusErr.message,
              },
            });
            return;
          }

          const dispatchResult = await dispatchBatchFanout({
            batch_id: batchId,
            tenant_id: auth.tenant_id,
            thread_id: body.thread_id,
            agent_slug: slug,
            agent_definition_hash: def.content_hash,
            cost_class: def.metadata_praxis.cost_class,
            tasks: envelope.tasks,
            parent_message_id: (prev?.id as string | null) ?? null,
            approval_message_id: approvalMessageId,
            approval_user_id: auth.user_id,
            source_run_id: (prev?.agent_run_id as string | null) ?? null,
          });

          if (!dispatchResult.ok) {
            const reasonText =
              dispatchResult.reason === "daily_child_cap_exceeded"
                ? "I've hit today's limit on tasks run in parallel, so I haven't started these. Try again tomorrow, or send them one at a time."
                : dispatchResult.reason === "daily_usd_cap_exceeded"
                  ? "These would go over today's spending limit, so I haven't started them. Try again after the limit resets tomorrow."
                  : dispatchResult.reason === "staff_model_cap"
                    ? "Today's ?model= test limit is reached, so I haven't started these. Try again tomorrow."
                    : "Something went wrong starting these tasks, so nothing ran and you weren't charged. Send them again to retry.";
            await sb.from("agent_thread_messages").insert({
              thread_id: body.thread_id,
              tenant_id: auth.tenant_id,
              sender_role: "assistant",
              body: `_${reasonText}_`,
              meta: {
                batch_id: batchId,
                dispatch_failed: true,
                dispatch_reason: dispatchResult.reason,
              },
              agent_run_id: null,
            });
            await sb
              .from("agent_threads")
              .update({ last_message_at: new Date().toISOString() })
              .eq("id", body.thread_id);
            res.status(409).json({
              thread_id: body.thread_id,
              ok: false,
              action: "batch_dispatch_rejected",
              batch_id: batchId,
              reason: dispatchResult.reason,
            });
            return;
          }

          const childList = envelope.tasks
            .map((t, i) => `${i + 1}. **${t.title}** — queued`)
            .join("\n");
          const approveBubble = `_Approved — working on ${envelope.tasks.length} task${envelope.tasks.length === 1 ? "" : "s"} now. I'll post the PR links here when they're done._\n\n${childList}`;
          await sb.from("agent_thread_messages").insert({
            thread_id: body.thread_id,
            tenant_id: auth.tenant_id,
            sender_role: "assistant",
            body: approveBubble,
            meta: {
              approved_batch_id: batchId,
              child_run_ids: dispatchResult.child_run_ids,
              reserved_usd: dispatchResult.reserved_usd,
              idempotent_retry: dispatchResult.idempotent_retry,
            },
            agent_run_id: null,
          });
          await sb
            .from("agent_threads")
            .update({ last_message_at: new Date().toISOString() })
            .eq("id", body.thread_id);
          res.status(200).json({
            thread_id: body.thread_id,
            ok: true,
            action: "batch_dispatched",
            batch_id: batchId,
            child_run_ids: dispatchResult.child_run_ids,
          });
          return;
        }
      }

      if (
        envelope?.pending_pr_proposal === true &&
        envelope.files &&
        envelope.files.length > 0
      ) {
        const isApprove = isAffirmativeApproval(body.message);
        const isReject = isExplicitRejection(body.message);
        if (isApprove || isReject) {
          const { error: userInsertErr } = await sb
            .from("agent_thread_messages")
            .insert({
              thread_id: body.thread_id,
              tenant_id: auth.tenant_id,
              sender_role: "user",
              body: body.message,
              agent_run_id: null,
            });
          if (userInsertErr) {
            res.status(500).json({
              error: {
                code: "user_msg_insert_failed",
                message: userInsertErr.message,
              },
            });
            return;
          }

          if (isReject) {
            await sb.from("agent_thread_messages").insert({
              thread_id: body.thread_id,
              tenant_id: auth.tenant_id,
              sender_role: "assistant",
              body: "_Discarded — no PR opened. Send me a new task whenever you're ready._",
              meta: { discarded_pr_proposal: true },
              agent_run_id: null,
            });
            await sb
              .from("agent_threads")
              .update({ last_message_at: new Date().toISOString() })
              .eq("id", body.thread_id);
            res.status(200).json({
              thread_id: body.thread_id,
              ok: true,
              action: "rejected",
            });
            return;
          }

          const approveGate = evaluateCtoShipGate(envelope);
          const approvalClass =
            readApprovalClass(envelope) ?? classifyEngineerPrApproval(envelope);
          if (
            requiresExplicitShipRed(approvalClass) &&
            !isShipRedOverride(body.message)
          ) {
            await sb.from("agent_thread_messages").insert({
              thread_id: body.thread_id,
              tenant_id: auth.tenant_id,
              sender_role: "assistant",
              body:
                "I'm not opening this one on a `yes` — my change broke a test that was passing on the base branch, so this is my bug, not your repo's. " +
                "Reply **`fix it`** and I'll have another go, or **`ship red`** if you want the PR anyway.",
              meta: {
                ship_gate_blocked: true,
                ship_gate_reason: "tests_failed_new",
              },
              agent_run_id: null,
            });
            await sb
              .from("agent_threads")
              .update({ last_message_at: new Date().toISOString() })
              .eq("id", body.thread_id);
            res.status(400).json({
              error: { code: "ship_gate_blocked", message: "tests_failed_new" },
            });
            return;
          }

          if (!approveGate.shippable && isNoDiffReason(approveGate.reason)) {
            await sb.from("agent_thread_messages").insert({
              thread_id: body.thread_id,
              tenant_id: auth.tenant_id,
              sender_role: "assistant",
              body: `_${shipBlockExplanation(approveGate.reason)}_`,
              meta: {
                ship_gate_blocked: true,
                ship_gate_reason: approveGate.reason,
              },
              agent_run_id: null,
            });
            await sb
              .from("agent_threads")
              .update({ last_message_at: new Date().toISOString() })
              .eq("id", body.thread_id);
            res.status(400).json({
              error: {
                code: "ship_gate_blocked",
                message: approveGate.reason,
              },
            });
            return;
          }

          const decisionBody = { ...envelope } as Record<string, unknown>;
          delete decisionBody.pending_pr_proposal;
          delete decisionBody.critic;
          delete decisionBody.critic_unverified;

          const sourceRunId = prev?.agent_run_id as string | null;
          if (!sourceRunId) {
            res.status(500).json({
              error: {
                code: "missing_source_run",
                message:
                  "approval: prior proposal has no agent_run_id; cannot emit decision.",
              },
            });
            return;
          }

          const { data: existingDec } = await sb
            .from("decisions")
            .select("id, status")
            .eq("agent_run_id", sourceRunId)
            .eq("decision_class", "engineer.ship-pr")
            .in("status", ["proposed", "approved", "dispatched", "acted"])
            .limit(1)
            .maybeSingle();
          if (existingDec) {
            const existingId = existingDec.id as string;
            const existingStatus = existingDec.status as string;
            let existingPrUrl: string | null = null;
            {
              const { data: srcRun } = await sb
                .from("agent_runs")
                .select("parsed")
                .eq("id", sourceRunId)
                .maybeSingle();
              const parsed = srcRun?.parsed as { pr_url?: string } | null;
              if (parsed && typeof parsed.pr_url === "string")
                existingPrUrl = parsed.pr_url;
            }
            let bubbleBody: string;
            let action: string;
            if (existingStatus === "acted") {
              bubbleBody = existingPrUrl
                ? `_The PR is already open: ${existingPrUrl} — to add changes, just tell me what to change here and I'll push to that branch._`
                : `_The PR is already open for this — it should be at the top of your GitHub PR list. To add changes, tell me what to change here._`;
              action = "approved_already_acted";
            } else if (existingStatus === "dispatched") {
              bubbleBody = existingPrUrl
                ? `_The PR is open: ${existingPrUrl} — I'm just finishing up._`
                : `_Opening the PR now — it'll land in your GitHub PR list in a moment._`;
              action = "approved_in_flight";
            } else if (existingStatus === "proposed") {
              const approved = await approveFromChatQuickPath({
                svc: sb,
                userClient: supabase,
                decision_id: existingId,
                tenant_id: auth.tenant_id,
              });
              if (!approved.ok) {
                res.status(approved.code === "composio_needs_card" || approved.code === "spend_needs_card" ? 409 : 500).json({
                  error: {
                    code: approved.code === "approve_failed" ? "approve_failed" : approved.code,
                    message: approved.message,
                  },
                });
                return;
              }
              trackApprovalCardDecided({
                tenant_id: auth.tenant_id,
                user_id: auth.user_id,
                decision_class: "engineer.ship-pr",
                outcome: "approved",
              });
              try {
                await inngest.send({
                  id: `approve:${existingId}`,
                  name: "decision.approved",
                  data: {
                    decision_id: existingId,
                    tenant_id: auth.tenant_id,
                    decision_class: "engineer.ship-pr",
                  },
                });
                bubbleBody = `_Approved — opening the PR now. I'll post the link here once it's up._`;
                action = "approved";
              } catch (e) {
                bubbleBody = `_Approved, but I couldn't start opening the PR just now. Reply **yes** again in a moment to retry._`;
                action = "approved_dispatch_pending";
              }
            } else {
              try {
                await inngest.send({
                  id: `approve-retry:${existingId}:${Date.now()}`,
                  name: "decision.approved",
                  data: {
                    decision_id: existingId,
                    tenant_id: auth.tenant_id,
                    decision_class: "engineer.ship-pr",
                  },
                });
                bubbleBody = `_Trying again — opening the PR now. I'll post the link here once it's up._`;
                action = "approved_retry_dispatched";
              } catch (e) {
                bubbleBody = `_Still couldn't start opening the PR. Your approval is saved — reply **yes** again in a minute to retry._`;
                action = "approved_retry_failed";
              }
            }
            await sb.from("agent_thread_messages").insert({
              thread_id: body.thread_id,
              tenant_id: auth.tenant_id,
              sender_role: "assistant",
              body: bubbleBody,
              meta: {
                approved_decision_id: existingId,
                existing_status: existingStatus,
              },
              agent_run_id: null,
            });
            await sb
              .from("agent_threads")
              .update({ last_message_at: new Date().toISOString() })
              .eq("id", body.thread_id);
            res.status(200).json({
              thread_id: body.thread_id,
              ok: true,
              action,
              decision_id: existingId,
            });
            return;
          }

          decisionBody.decision_evidence = buildShipPrEvidence(decisionBody);
          validateDecisionEvidenceInBody(decisionBody, {
            decision_class: "engineer.ship-pr",
          });
          const { data: emitData, error: emitErr } = await sb.rpc(
            "emit_decision",
            {
              p_tenant_id: auth.tenant_id,
              p_agent_run_id: sourceRunId,
              p_decision_class: "engineer.ship-pr",
              p_body: decisionBody as object,
              p_autonomy_override: "approval",
            },
          );
          if (emitErr) {
            res.status(500).json({
              error: { code: "emit_decision_failed", message: emitErr.message },
            });
            return;
          }
          const decisionId = emitData as string;

          const approved = await approveFromChatQuickPath({
            svc: sb,
            userClient: supabase,
            decision_id: decisionId,
            tenant_id: auth.tenant_id,
          });
          if (!approved.ok) {
            res.status(approved.code === "composio_needs_card" || approved.code === "spend_needs_card" ? 409 : 500).json({
              error: { code: approved.code, message: approved.message },
            });
            return;
          }
          trackApprovalCardDecided({
            tenant_id: auth.tenant_id,
            user_id: auth.user_id,
            decision_class: "engineer.ship-pr",
            outcome: "approved",
          });

          try {
            await inngest.send({
              id: `approve:${decisionId}`,
              name: "decision.approved",
              data: {
                decision_id: decisionId,
                tenant_id: auth.tenant_id,
                decision_class: "engineer.ship-pr",
              },
            });
          } catch (e) {
            await sb.from("agent_thread_messages").insert({
              thread_id: body.thread_id,
              tenant_id: auth.tenant_id,
              sender_role: "assistant",
              body: `_Approved, but I couldn't start opening the PR just now. Your approval is saved — reply **yes** again in a moment to retry._`,
              meta: {
                approved_decision_id: decisionId,
                dispatch_send_failed: true,
              },
              agent_run_id: null,
            });
            await sb
              .from("agent_threads")
              .update({ last_message_at: new Date().toISOString() })
              .eq("id", body.thread_id);
            res.status(202).json({
              thread_id: body.thread_id,
              ok: true,
              action: "approved_dispatch_pending",
              decision_id: decisionId,
              warning: (e as Error).message,
            });
            return;
          }

          await sb.from("agent_thread_messages").insert({
            thread_id: body.thread_id,
            tenant_id: auth.tenant_id,
            sender_role: "assistant",
            body: `_Approved — opening the PR now. I'll post the link here once it's up._`,
            meta: { approved_decision_id: decisionId },
            agent_run_id: null,
          });
          await sb
            .from("agent_threads")
            .update({ last_message_at: new Date().toISOString() })
            .eq("id", body.thread_id);

          res.status(200).json({
            thread_id: body.thread_id,
            ok: true,
            action: "approved",
            decision_id: decisionId,
          });
          return;
        }
      }
    }
  }

  if (
    def.metadata_praxis.requires_sandbox &&
    body.thread_id &&
    !body.command_slug &&
    !body.edit_of_message_id &&
    (body.image_paths ?? []).length === 0 &&
    (body.doc_paths ?? []).length === 0 &&
    (body.video_paths ?? []).length === 0 &&
    body.message.trim().length > 0 &&
    !isAffirmativeApproval(body.message) &&
    !isExplicitRejection(body.message)
  ) {
    const sb = serviceClient();

    const { data: fThread } = await sb
      .from("agent_threads")
      .select("user_id, agent_slug")
      .eq("id", body.thread_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();

    if (
      fThread &&
      (fThread.user_id as string) === auth.user_id &&
      (fThread.agent_slug as string) === slug
    ) {
      try {
        const { data: threadRuns } = await sb
          .from("agent_runs")
          .select("id, parsed")
          .eq("tenant_id", auth.tenant_id)
          .eq("agent_slug", slug)
          .filter("payload->>thread_id", "eq", body.thread_id)
          .order("enqueued_at", { ascending: false })
          .limit(50);

        const runIds = (threadRuns ?? [])
          .map((r) => r.id as string)
          .filter((id): id is string => typeof id === "string");

        const openPrs: OpenEngineerPr[] = [];
        if (runIds.length > 0) {
          const { data: decRows } = await sb
            .from("decisions")
            .select("id, agent_run_id, status")
            .eq("tenant_id", auth.tenant_id)
            .eq("decision_class", "engineer.ship-pr")
            .in("agent_run_id", runIds)
            .in("status", ["acted", "dispatched"]);

          const runById = new Map<string, { parsed?: unknown }>();
          for (const r of threadRuns ?? []) {
            runById.set(r.id as string, r as { parsed?: unknown });
          }
          const seenPr = new Set<string>();
          for (const dec of decRows ?? []) {
            const runId = dec.agent_run_id as string | null;
            if (!runId) continue;
            const parsed = (runById.get(runId)?.parsed ?? {}) as {
              pr_number?: unknown;
              pr_repo?: unknown;
              pr_url?: unknown;
              pr_head_branch?: unknown;
            };
            const prNumber =
              typeof parsed.pr_number === "number" ? parsed.pr_number : null;
            const prRepo =
              typeof parsed.pr_repo === "string" ? parsed.pr_repo : null;
            const prUrl =
              typeof parsed.pr_url === "string" ? parsed.pr_url : null;
            const headBranch = parsed.pr_head_branch;
            if (
              prNumber == null ||
              !prRepo ||
              !prUrl ||
              !isSafeCheckoutRef(headBranch)
            ) {
              continue;
            }
            const prKey = `${prRepo}#${prNumber}`;
            if (seenPr.has(prKey)) continue;
            seenPr.add(prKey);
            openPrs.push({
              decision_id: dec.id as string,
              run_id: runId,
              pr_number: prNumber,
              pr_repo: prRepo,
              pr_url: prUrl,
              head_branch: headBranch,
            });
          }
        }

        const classification = classifyFollowupCandidates({
          message: body.message,
          openPrs,
        });

        if (classification.action === "route") {
          const pr = classification.pr;
          const dedupe_key = followupDedupeKey({
            thread_id: body.thread_id,
            decision_id: pr.decision_id,
            instruction: body.message,
          });
          const { data: fUserMsg, error: fUserMsgErr } = await sb
            .from("agent_thread_messages")
            .insert({
              thread_id: body.thread_id,
              tenant_id: auth.tenant_id,
              sender_role: "user",
              body: body.message,
              agent_run_id: null,
            })
            .select("id")
            .single();
          if (fUserMsgErr || !fUserMsg?.id) {
            throw new Error(
              `pr-followup: operator reply bubble insert failed${
                fUserMsgErr ? `: ${fUserMsgErr.message}` : ""
              }`,
            );
          }

          const payload = buildFollowupPayload({
            pr,
            instruction: body.message,
            source: "chat",
            thread_id: body.thread_id,
            user_message_id: fUserMsg.id as string,
            slack_routing: null,
          });

          await enqueueWorkItem({
            tenant_id: auth.tenant_id,
            agent_slug: slug,
            source: "chat_pr_followup",
            payload,
            dedupe_key,
          });

          await sb.from("agent_thread_messages").insert({
            thread_id: body.thread_id,
            tenant_id: auth.tenant_id,
            sender_role: "assistant",
            body: `On it — applying that to PR #${pr.pr_number}.`,
            meta: {
              chat_pr_followup: true,
              target_pr_number: pr.pr_number,
              target_pr_repo: pr.pr_repo,
            },
            agent_run_id: null,
          });
          await sb
            .from("agent_threads")
            .update({ last_message_at: new Date().toISOString() })
            .eq("id", body.thread_id);

          res.status(200).json({
            thread_id: body.thread_id,
            user_message_id: fUserMsg.id as string,
            ok: true,
            action: "pr_followup_enqueued",
            target_pr_number: pr.pr_number,
          });
          return;
        }

        if (classification.action === "clarify") {
          let answer: string | null = null;
          try {
            answer = await answerNonPushFollowup({
              tenant_id: auth.tenant_id,
              text: body.message,
              prs: classification.prs,
            });
          } catch (e) {
            console.warn(
              `[chat-send] non-push answer failed for thread ${body.thread_id}: ${(e as Error).message}`,
            );
            answer = null;
          }
          if (answer) {
            await sb.from("agent_thread_messages").insert({
              thread_id: body.thread_id,
              tenant_id: auth.tenant_id,
              sender_role: "assistant",
              body: answer,
              meta: {
                chat_pr_followup_answer: true,
                candidate_pr_numbers: classification.prs.map(
                  (p) => p.pr_number,
                ),
              },
              agent_run_id: null,
            });
            await sb
              .from("agent_threads")
              .update({ last_message_at: new Date().toISOString() })
              .eq("id", body.thread_id);
            res.status(200).json({
              ok: true,
              action: "pr_followup_answer",
              candidate_pr_numbers: classification.prs.map((p) => p.pr_number),
            });
            return;
          }
        }
      } catch (e) {
        console.warn(
          `[chat-send] pr-followup routing failed for thread ${body.thread_id}: ${(e as Error).message}`,
        );
      }
    }
  }

  if (heldPlanRefusal) {
    res.status(403).json(planUpgradeErrorBody(slug, heldPlanRefusal.required_tier));
    void notifyFounderActivity({
      event: "plan_upgrade_required",
      tenant_id: auth.tenant_id,
      user_id: auth.user_id,
      details: { refused: "plan_upgrade_required", agent: slug, where: "chat" },
    });
    return;
  }

  if (body.command_slug) {
    const { data: cmd, error: cmdErr } = await supabase
      .from("tenant_commands")
      .select("slug, instructions_md")
      .eq("tenant_id", auth.tenant_id)
      .eq("slug", body.command_slug)
      .maybeSingle();
    if (cmdErr || !cmd) {
      res.status(400).json({
        error: {
          code: "invalid_command",
          message: "No tenant command with that slug.",
        },
      });
      return;
    }
    const instructionsMd = (cmd.instructions_md as string) ?? "";
    const wrapperLen =
      COMMAND_WRAPPER_PREFIX.length +
      body.command_slug.length +
      COMMAND_WRAPPER_MID.length +
      instructionsMd.length +
      COMMAND_WRAPPER_BODY_HEADER.length;
    if (wrapperLen + body.message.length > SEND_AGENT_CHAT_TURN_MAX) {
      res.status(400).json({
        error: {
          code: "payload_too_long",
          message:
            "Command instructions + your message exceed the 32000-char turn limit. Shorten your message or the command.",
        },
      });
      return;
    }
  }

  const imagePaths = body.image_paths ?? [];
  const docPaths = body.doc_paths ?? [];
  const videoPaths = body.video_paths ?? [];
  const expectedPrefix = `${auth.tenant_id}/`;

  if (imagePaths.length > 0) {
    const bad = imagePaths.find((p) => !p.startsWith(expectedPrefix));
    if (bad) {
      res.status(403).json({
        error: {
          code: "path_not_owned",
          message: `image path ${bad} not owned by tenant`,
        },
      });
      return;
    }
  }

  if (docPaths.length > 0) {
    const bad = docPaths.find((p) => !p.startsWith(expectedPrefix));
    if (bad) {
      res.status(403).json({
        error: {
          code: "path_not_owned",
          message: `doc path ${bad} not owned by tenant`,
        },
      });
      return;
    }
  }

  if (videoPaths.length > 0) {
    const bad = videoPaths.find((p) => !p.startsWith(expectedPrefix));
    if (bad) {
      res.status(403).json({
        error: {
          code: "path_not_owned",
          message: `video path ${bad} not owned by tenant`,
        },
      });
      return;
    }
  }

  const hasAttachments =
    imagePaths.length > 0 || docPaths.length > 0 || videoPaths.length > 0;

  if (
    body.thread_id &&
    !body.command_slug &&
    !body.edit_of_message_id &&
    !hasAttachments &&
    isPureAcknowledgment(body.message)
  ) {
    const sb = serviceClient();
    const { data: ackThread } = await sb
      .from("agent_threads")
      .select("user_id, agent_slug")
      .eq("id", body.thread_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    const { data: ackPrev } = await sb
      .from("agent_thread_messages")
      .select("meta, body")
      .eq("thread_id", body.thread_id)
      .eq("tenant_id", auth.tenant_id)
      .eq("sender_role", "assistant")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const priorWasClarify =
      ((ackPrev?.meta ?? {}) as { envelope_schema?: unknown })
        .envelope_schema === "clarifying_questions";
    const suppressAsAck = shouldSuppressAsAck({
      message: body.message,
      priorAssistantBody: (ackPrev?.body as string | null | undefined) ?? null,
      priorWasClarify,
    });
    if (
      suppressAsAck &&
      ackThread &&
      (ackThread.user_id as string) === auth.user_id &&
      (ackThread.agent_slug as string) === slug
    ) {
      const { data: ackUserMsg } = await sb
        .from("agent_thread_messages")
        .insert({
          thread_id: body.thread_id,
          tenant_id: auth.tenant_id,
          sender_role: "user",
          body: body.message,
          agent_run_id: null,
        })
        .select("id")
        .single();
      await sb.from("agent_thread_messages").insert({
        thread_id: body.thread_id,
        tenant_id: auth.tenant_id,
        sender_role: "assistant",
        body: "👍",
        meta: { no_run: true, reason: "acknowledgment" },
        agent_run_id: null,
      });
      await sb
        .from("agent_threads")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", body.thread_id);
      res.status(200).json({
        thread_id: body.thread_id,
        user_message_id: (ackUserMsg?.id as string | undefined) ?? null,
        ok: true,
        action: "acknowledged_no_run",
      });
      return;
    }
  }

  if (!body.command_slug && !hasAttachments) {
    const fastAuth = { tenant_id: auth.tenant_id, user_id: auth.user_id };
    const fastBody = { message: body.message, thread_id: body.thread_id ?? null };
    try {
      const reply =
        (slug === CGO
          ? ((body.edit_of_message_id ? null : await tryResolveConflict(fastAuth, fastBody)) ??
            (await trySetupFaq(fastAuth, fastBody)))
          : null) ?? (await tryGreeting(fastAuth, slug, fastBody));
      if (reply) {
        if (body.edit_of_message_id && reply.user_message_id) {
          await supersedeEditedMessage(serviceClient(), {
            tenant_id: auth.tenant_id,
            thread_id: reply.thread_id,
            original_message_id: body.edit_of_message_id,
            new_message_id: reply.user_message_id,
          }).catch((e) =>
            console.warn(`[chat-send] edit supersede after no-run reply failed: ${(e as Error).message}`),
          );
        }
        res.status(200).json(reply);
        return;
      }
    } catch (e) {
      console.warn(`[chat-send] no-run fast path failed: ${(e as Error).message}`);
      res.status(503).json({ error: { code: "fast_path_unavailable", message: "Zavi couldn't answer now. Try again in a moment." } });
      return;
    }
  }

  if (
    def.metadata_praxis.requires_sandbox &&
    !body.command_slug &&
    !body.edit_of_message_id &&
    !hasAttachments &&
    body.message.length > 0 &&
    !isAffirmativeApproval(body.message) &&
    !isExplicitRejection(body.message)
  ) {
    {
      const sb = serviceClient();

      let effectiveThreadId: string | null = body.thread_id ?? null;
      let proceed = false;

      if (body.thread_id) {
        const { data: thread } = await sb
          .from("agent_threads")
          .select("user_id, agent_slug")
          .eq("id", body.thread_id)
          .eq("tenant_id", auth.tenant_id)
          .maybeSingle();
        proceed = !!(
          thread &&
          (thread.user_id as string) === auth.user_id &&
          (thread.agent_slug as string) === slug
        );
      } else {
        const { data: ghMeta } = await sb
          .from("connector_metadata")
          .select("default_repo_full_name")
          .eq("tenant_id", auth.tenant_id)
          .eq("slug", "github")
          .maybeSingle();
        const connectedRepos = await getScopedRepoFullNames(auth.tenant_id, sb);
        const tenantDefault =
          typeof ghMeta?.default_repo_full_name === "string"
            ? ghMeta.default_repo_full_name
            : null;
        proceed = !!tenantDefault && connectedRepos.includes(tenantDefault);
      }

      if (proceed) {
        const decomposition = await decomposeMessage(body.message);
        if (decomposition.kind === "multi") {
          let routedTasks: EnrichedTaskSpec[] = decomposition.tasks;
          {
            const connectedReposForRouting = await getScopedRepoFullNames(
              auth.tenant_id,
              sb,
            );
            if (connectedReposForRouting.length > 1) {
              routedTasks = await Promise.all(
                decomposition.tasks.map(async (t) => {
                  try {
                    const decision = await pickRepoForTask({
                      task_description: t.task_description,
                      repos: connectedReposForRouting,
                      tenant_id: auth.tenant_id,
                    });
                    return decision.decision === "pick"
                      ? { ...t, repo: decision.repo }
                      : t;
                  } catch {
                    return t;
                  }
                }),
              );
            }
          }
          const batchId = randomUUID();
          const approvalToken = randomUUID();

          if (!effectiveThreadId) {
            const { data: newThread, error: threadErr } = await sb
              .from("agent_threads")
              .insert({
                tenant_id: auth.tenant_id,
                agent_slug: slug,
                user_id: auth.user_id,
                title: body.message.slice(0, 80),
              })
              .select("id")
              .single();
            if (threadErr || !newThread) {
              res.status(500).json({
                error: {
                  code: "thread_create_failed",
                  message: threadErr?.message ?? "no row",
                },
              });
              return;
            }
            effectiveThreadId = newThread.id as string;
          }

          const { data: priorAssistant } = await sb
            .from("agent_thread_messages")
            .select("id, meta")
            .eq("thread_id", effectiveThreadId)
            .eq("tenant_id", auth.tenant_id)
            .eq("sender_role", "assistant")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (priorAssistant) {
            const priorMetaRaw = (priorAssistant.meta ?? {}) as Record<
              string,
              unknown
            >;
            const priorEnv = (priorMetaRaw.envelope ?? {}) as Record<
              string,
              unknown
            >;
            const isPending =
              priorEnv.pending_pr_proposal === true ||
              priorEnv.pending_batch_proposal === true;
            if (isPending && priorEnv.superseded_at == null) {
              await sb
                .from("agent_thread_messages")
                .update({
                  meta: {
                    ...priorMetaRaw,
                    envelope: {
                      ...priorEnv,
                      superseded_at: new Date().toISOString(),
                    },
                  },
                })
                .eq("id", priorAssistant.id as string)
                .eq("tenant_id", auth.tenant_id);
            }
          }

          const { error: batchErr } = await sb
            .from("agent_run_batches")
            .insert({
              id: batchId,
              tenant_id: auth.tenant_id,
              thread_id: effectiveThreadId,
              status: "proposed",
              task_specs: routedTasks,
            });
          if (batchErr) {
            res.status(500).json({
              error: { code: "batch_insert_failed", message: batchErr.message },
            });
            return;
          }

          const { error: userInsertErr } = await sb
            .from("agent_thread_messages")
            .insert({
              thread_id: effectiveThreadId,
              tenant_id: auth.tenant_id,
              sender_role: "user",
              body: body.message,
              agent_run_id: null,
            });
          if (userInsertErr) {
            res.status(500).json({
              error: {
                code: "user_msg_insert_failed",
                message: userInsertErr.message,
              },
            });
            return;
          }

          const proposalBody =
            `I split your request into ${decomposition.tasks.length} independent PR-sized tasks:\n\n` +
            decomposition.tasks
              .map((t, i) => `${i + 1}. **${t.title}** — ${t.task_description}`)
              .join("\n\n") +
            `\n\nReply **yes** to approve all, or **no** to discard.`;

          const { error: assistantErr } = await sb
            .from("agent_thread_messages")
            .insert({
              thread_id: effectiveThreadId,
              tenant_id: auth.tenant_id,
              sender_role: "assistant",
              body: proposalBody,
              meta: {
                envelope: {
                  kind: "batch_fanout",
                  pending_batch_proposal: true,
                  batch_id: batchId,
                  approval_token: approvalToken,
                  tasks: routedTasks,
                },
              },
              agent_run_id: null,
            });
          if (assistantErr) {
            res.status(500).json({
              error: {
                code: "proposal_insert_failed",
                message: assistantErr.message,
              },
            });
            return;
          }

          await sb
            .from("agent_threads")
            .update({ last_message_at: new Date().toISOString() })
            .eq("id", effectiveThreadId);

          res.status(200).json({
            thread_id: effectiveThreadId,
            ok: true,
            action: "batch_proposed",
            batch_id: batchId,
            task_count: decomposition.tasks.length,
          });
          return;
        }
      }
    }
  }

  if (body.thread_id) {
    const sbTh = serviceClient();
    const { data: thread } = await sbTh
      .from("agent_threads")
      .select("id")
      .eq("id", body.thread_id)
      .eq("tenant_id", auth.tenant_id)
      .eq("user_id", auth.user_id)
      .eq("agent_slug", slug)
      .is("deleted_at", null)
      .maybeSingle();
    if (!thread) {
      res.status(404).json({
        error: { code: "thread_not_found", message: "thread not found" },
      });
      return;
    }
  }

  const staffModel = await decideStaffModel(
    { raw: body.model, userId: auth.user_id, tenantId: auth.tenant_id },
    {
      isOwnerOrAdmin: (userId, tenantId) => isTenantOwnerOrAdmin(serviceClient(), userId, tenantId),
      checkCap: () => checkStaffModelCap(serviceClient()),
      hasOpenRouterKey: () => !!process.env.OPENROUTER_API_KEY,
    },
  );
  if (staffModel.kind === "reject") {
    res.status(staffModel.status).json({
      error: { code: staffModel.code, message: staffModel.message },
    });
    return;
  }

  if (
    body.thread_id &&
    !hasAttachments &&
    !body.command_slug &&
    !body.edit_of_message_id &&
    !body.repo_hint &&
    !(body.channels && body.channels.length > 0) &&
    !body.channel_action_id &&
    !body.depth &&
    !body.message_origin &&
    staffModel.kind !== "stamp" &&
    (!buildSessionId || threadBoundTo === buildSessionId) &&
    !body.page_context
  ) {
    try {
      const steerIdemKey = createHash("sha256")
        .update(`${auth.user_id}|${body.thread_id}|${slug}|${body.message}`)
        .digest("hex")
        .slice(0, 40);
      const { data: steerVerdict, error: steerErr } = await supabase.rpc(
        "enqueue_or_steer_chat_turn",
        {
          p_tenant_id: auth.tenant_id,
          p_thread_id: body.thread_id,
          p_agent_slug: slug,
          p_body: body.message,
          p_idempotency_key: steerIdemKey,
        },
      );
      const verdict = steerVerdict as {
        action?: string;
        run_id?: string;
        thread_id?: string;
        user_message_id?: string;
      } | null;
      if (steerErr) {
        console.warn(
          `[chat-send] barge-in probe failed (thread=${body.thread_id}); normal enqueue: ${steerErr.message}`,
        );
      } else if (verdict?.action === "steered" && verdict.run_id) {
        const steerThreadId = verdict.thread_id ?? body.thread_id;
        if (verdict.user_message_id && steerThreadId) {
          void flagPreviousReply({
            tenantId: auth.tenant_id,
            threadId: steerThreadId,
            newUserMessageId: verdict.user_message_id,
            text: body.message,
            inFlightRunId: verdict.run_id,
          });
        }
        res.status(200).json({
          thread_id: verdict.thread_id ?? body.thread_id,
          user_message_id: verdict.user_message_id ?? "",
          run_id: verdict.run_id,
          steered: true,
        });
        return;
      }
    } catch (e) {
      console.warn(
        `[chat-send] barge-in probe threw (thread=${body.thread_id}); normal enqueue: ${(e as Error).message}`,
      );
    }
  }

  const agentKilled = await isAgentKilled(auth.tenant_id, slug);

  if (def.metadata_praxis.requires_sandbox && !agentKilled) {
    const sb = serviceClient();
    const repoAccess = await checkSandboxRepoAccess(
      auth.tenant_id,
      undefined,
      sb,
    );
    const deferToConnectGate =
      repoAccess === "not_connected" &&
      (await connectGateSlugFor({
        tenant_id: auth.tenant_id,
        agent: def,
        trigger: "chat",
        text: body.message,
      })) !== null;
    if (repoAccess !== "ok" && !deferToConnectGate) {
      let blockedThreadId = body.thread_id ?? null;
      if (!blockedThreadId) {
        const { data: newThread, error: threadErr } = await sb
          .from("agent_threads")
          .insert({
            tenant_id: auth.tenant_id,
            agent_slug: slug,
            user_id: auth.user_id,
            title: body.message.slice(0, 80),
          })
          .select("id")
          .single();
        if (threadErr || !newThread) {
          res.status(500).json({
            error: {
              code: "thread_create_failed",
              message: threadErr?.message ?? "no row",
            },
          });
          return;
        }
        blockedThreadId = newThread.id as string;
      }
      const { error: userInsertErr } = await sb
        .from("agent_thread_messages")
        .insert({
          thread_id: blockedThreadId,
          tenant_id: auth.tenant_id,
          sender_role: "user",
          body: body.message,
          agent_run_id: null,
        });
      if (userInsertErr) {
        res.status(500).json({
          error: {
            code: "user_msg_insert_failed",
            message: userInsertErr.message,
          },
        });
        return;
      }
      const { error: assistantErr } = await sb
        .from("agent_thread_messages")
        .insert({
          thread_id: blockedThreadId,
          tenant_id: auth.tenant_id,
          sender_role: "assistant",
          body: repoAccessBlockedMessage(repoAccess),
          meta: {
            envelope: { kind: "repo_access_blocked", status: repoAccess },
          },
          agent_run_id: null,
        });
      if (assistantErr) {
        res.status(500).json({
          error: {
            code: "assistant_msg_insert_failed",
            message: assistantErr.message,
          },
        });
        return;
      }
      await sb
        .from("agent_threads")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", blockedThreadId);
      res.status(200).json({
        thread_id: blockedThreadId,
        ok: true,
        action: "repo_access_blocked",
        status: repoAccess,
      });
      return;
    }
  }

  let livePreviewUrl: string | null = null;
  let livePreviewDom: string | null = null;
  let livePreviewPicked: unknown = null;
  if (def.metadata_praxis.requires_sandbox && body.preview_session_id) {
    try {
      const cap = await captureEngineerPreview({
        session_id: body.preview_session_id,
        tenant_id: auth.tenant_id,
      });
      void logEvent({
        level: "info",
        source: "engineer.preview_capture",
        tenant_id: auth.tenant_id,
        meta: previewCaptureLogMeta(cap),
      });
      if (cap.ok) {
        livePreviewUrl = cap.url;
        livePreviewDom = cap.scrubbedDomHtml;
        livePreviewPicked = cap.pickedElement;
        if (cap.screenshotPng && imagePaths.length < 4) {
          const shotPath = await storePreviewScreenshot(
            auth.tenant_id,
            cap.screenshotPng,
          ).catch(() => null);
          if (shotPath) imagePaths.push(shotPath);
        }
      }
    } catch (e) {
      console.warn(
        `[chat-send] engineer preview capture failed (non-fatal): ${(e as Error).message}`,
      );
    }
  }

  const chatChannelAdmission = await admitDirectChannelRun(
    auth.tenant_id,
    slug,
    undefined,
    { chat: true },
  );
  if (!chatChannelAdmission.allowed) {
    const code =
      chatChannelAdmission.reason === "coming_soon"
        ? "coming_soon"
        : chatChannelAdmission.reason === "retired"
          ? "channel_retired"
          : "channel_budget_exhausted";
    res.status(code === "channel_budget_exhausted" ? 429 : 409).json({
      error: {
        code,
        message: chatChannelAdmission.message,
      },
    });
    return;
  }

  const channelMention =
    slug === "operator" ? await resolveMention(body.message ?? "", auth.tenant_id) : null;

  const evalTenantArg = auth.tenant_overridden
    ? { p_tenant_id: auth.tenant_id }
    : {};
  const rpcMessage =
    body.message.trim().length === 0 &&
    videoPaths.length > 0 &&
    imagePaths.length === 0 &&
    docPaths.length === 0
      ? VIDEO_ONLY_MESSAGE_BODY
      : body.message;
  const { data, error } =
    imagePaths.length > 0 || docPaths.length > 0
      ? await supabase.rpc("send_agent_chat_turn_v3", {
          p_agent_slug: slug,
          p_agent_hash: def.content_hash,
          p_message: body.message,
          p_thread_id: body.thread_id ?? null,
          p_image_paths: imagePaths,
          p_doc_paths: docPaths,
          ...evalTenantArg,
        })
      : await supabase.rpc("send_agent_chat_turn", {
          p_agent_slug: slug,
          p_agent_hash: def.content_hash,
          p_message: rpcMessage,
          p_thread_id: body.thread_id ?? null,
          ...evalTenantArg,
        });
  if (error || !data?.[0]) {
    if (isPlanUpgradeError(error)) {
      await refreshPlanWallFacts();
      res.status(403).json(planUpgradeErrorBody(slug, requiredTierFromDbError(error)));
      void notifyFounderActivity({
        event: "plan_upgrade_required",
        tenant_id: auth.tenant_id,
        user_id: auth.user_id,
        details: { refused: "plan_upgrade_required", agent: slug, where: "chat" },
      });
      return;
    }
    if (isInsufficientCreditsError(error)) {
      void notifyFounderActivity({
        event: "out_of_credits",
        tenant_id: auth.tenant_id,
        user_id: auth.user_id,
        details: { refused: "insufficient_credits", agent: slug, where: "chat" },
      });
      res.status(402).json({
        error: { code: "insufficient_credits", message: refusalText({ kind: "credits" }) },
      });
      return;
    }
    res.status(500).json({
      error: { code: "rpc_failed", message: error?.message ?? "no row" },
    });
    return;
  }
  const { thread_id, user_message_id, run_id } = data[0] as {
    thread_id: string;
    user_message_id: string;
    run_id: string;
  };
  if (body.edit_of_message_id) {
    const discardFailedEdit = async () => {
      const sbDiscard = serviceClient();
      const { data: newMessage, error: newMessageError } = await sbDiscard
        .from("agent_thread_messages")
        .select("meta")
        .eq("id", user_message_id)
        .eq("tenant_id", auth.tenant_id)
        .maybeSingle();
      if (newMessageError) throw newMessageError;
      const newMeta = (newMessage?.meta ?? {}) as Record<string, unknown>;
      const { error: discardError } = await sbDiscard
        .from("agent_thread_messages")
        .update({
          meta: {
            ...newMeta,
            superseded_by: body.edit_of_message_id,
            superseded_at: new Date().toISOString(),
          },
        })
        .eq("id", user_message_id)
        .eq("tenant_id", auth.tenant_id);
      if (discardError) throw discardError;
      const stopResult = await requestStopForRun(
        sbDiscard,
        auth.tenant_id,
        run_id,
      );
      if (!stopResult.ok) throw new Error(stopResult.error);
    };
    try {
      const supersedeResult = await supersedeEditedMessage(serviceClient(), {
        tenant_id: auth.tenant_id,
        thread_id,
        original_message_id: body.edit_of_message_id,
        new_message_id: user_message_id,
      });
      if (!supersedeResult.superseded) {
        await discardFailedEdit();
        res.status(409).json({
          error: {
            code: "invalid_edit_message",
            message: "This message can no longer be edited.",
          },
        });
        return;
      }
    } catch (e) {
      try {
        await discardFailedEdit();
      } catch (discardError) {
        console.error(
          `[chat-send] failed to discard edit turn ${user_message_id}: ${(discardError as Error).message}`,
        );
      }
      res.status(500).json({
        error: {
          code: "edit_supersede_failed",
          message: (e as Error).message,
        },
      });
      return;
    }
  }

  if (body.message.trim().length > 0) {
    void flagPreviousReply({
      tenantId: auth.tenant_id,
      threadId: thread_id,
      newUserMessageId: user_message_id,
      text: body.message,
      ...(body.edit_of_message_id ? { editOfMessageId: body.edit_of_message_id } : {}),
    });
  }

  void notifyFounderActivity({
    event: "first_chat_message",
    tenant_id: auth.tenant_id,
    user_id: auth.user_id,
    details: { agent: slug, message: body.message.slice(0, 500) },
  });

  track("chat_message_sent", {
    tenant_id: auth.tenant_id,
    user_id: auth.user_id,
    agent_slug: slug,
    action_key: "chat.message",
  });

  if (!isMainAgentSlug(slug) && !pageOrigin) {
    void (async () => {
      try {
        const { error: pinErr } = await supabase.rpc("add_agent_pin", {
          p_slug: slug,
          p_tenant_id: auth.tenant_id,
        });
        if (pinErr) {
          console.warn(
            `[chat-send] agent stickiness pin failed (non-fatal) slug=${slug}: ${pinErr.message}`,
          );
        }
      } catch (e) {
        console.warn(
          `[chat-send] agent stickiness pin threw (non-fatal) slug=${slug}: ${(e as Error).message}`,
        );
      }
    })();
  }

  {
    const sbKill = serviceClient();
    if (agentKilled) {
      await sbKill
        .from("agent_runs")
        .update({ status: "cancelled", finished_at: new Date().toISOString() })
        .eq("id", run_id)
        .eq("status", "queued");
      await sbKill.from("agent_thread_messages").insert({
        thread_id,
        tenant_id: auth.tenant_id,
        sender_role: "assistant",
        body: "_This agent is paused. Turn it back on in its settings to chat._",
        meta: { agent_paused: true },
        agent_run_id: null,
      });
      await sbKill
        .from("agent_threads")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", thread_id);
      res
        .status(200)
        .json({ thread_id, user_message_id, run_id, paused: true });
      return;
    }
  }

  if (def.metadata_praxis.requires_sandbox) {
    const sb = serviceClient();

    let taskDescription = body.message
      .trim()
      .slice(0, SANDBOX_TASK_DESCRIPTION_MAX);
    let repoHint: string | undefined;
    let siteRepos: Promise<boolean> | null = null;
    const siteIds = new Map<string, Promise<string | null>>();
    const siteIdOf = (repo: string): Promise<string | null> => {
      let found = siteIds.get(repo);
      if (!found) {
        siteRepos ??= getBoolSetting("build_site_keeps_own_repo", auth.tenant_id).catch(() => true);
        found = siteRepos.then((on) => (on ? siteIdForRepo(auth.tenant_id, repo) : null));
        siteIds.set(repo, found);
      }
      return found;
    };

    if (body.thread_id) {
      const { data: prev, error: prevErr } = await sb
        .from("agent_thread_messages")
        .select("meta")
        .eq("thread_id", body.thread_id)
        .eq("tenant_id", auth.tenant_id)
        .eq("sender_role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!prevErr && prev) {
        const prevMeta = (prev.meta ?? {}) as AwaitingRepoPickMeta;
        const repos = Array.isArray(prevMeta.repos)
          ? prevMeta.repos.filter(
              (r): r is string => typeof r === "string" && r.length > 0,
            )
          : [];
        const pendingTask =
          typeof prevMeta.pending_task_description === "string"
            ? prevMeta.pending_task_description.slice(
                0,
                SANDBOX_TASK_DESCRIPTION_MAX,
              )
            : "";
        if (prevMeta.awaiting_repo_pick === true && repos.length > 0) {
          const picked = parseRepoPickReply(body.message, repos);
          if (picked) {
            repoHint = picked;
            if (pendingTask.length > 0) {
              taskDescription = pendingTask;
            }
          } else if (pendingTask.length > 0) {
            taskDescription =
              `${pendingTask}\n\n(Operator reply to repo question: ${body.message
                .trim()
                .slice(0, 400)})`.slice(0, SANDBOX_TASK_DESCRIPTION_MAX);
          }
        }
      }
    }

    if (!repoHint) {
      const connectedRepos = await getScopedRepoFullNames(auth.tenant_id, sb);

      if (body.repo_hint) {
        if (connectedRepos.includes(body.repo_hint) || (await siteIdOf(body.repo_hint))) {
          repoHint = body.repo_hint;
        } else {
          await sb
            .from("agent_runs")
            .update({ status: "cancelled" })
            .eq("id", run_id)
            .eq("tenant_id", auth.tenant_id);
          res.status(400).json({
            error: {
              code: "repo_hint_not_connected",
              message: `repo_hint "${body.repo_hint}" is not one of this tenant's connected repos`,
            },
          });
          return;
        }
      } else if (connectedRepos.length > 1) {
        try {
          const decision = await pickRepoForTask({
            task_description: taskDescription,
            repos: connectedRepos,
            tenant_id: auth.tenant_id,
          });
          if (decision.decision === "pick") {
            repoHint = decision.repo;
          }
        } catch {
        }

        if (!repoHint && body.thread_id) {
          const { data: thread } = await sb
            .from("agent_threads")
            .select("repo_full_name")
            .eq("id", body.thread_id)
            .eq("tenant_id", auth.tenant_id)
            .maybeSingle();
          const sticky = (thread as { repo_full_name?: unknown } | null)
            ?.repo_full_name;
          if (typeof sticky === "string" && connectedRepos.includes(sticky)) {
            repoHint = sticky;
          }
        }
      }
    }

    if (repoHint && body.build_session_id && (await siteIdOf(repoHint))) {
      if (repoHint !== body.repo_hint) {
        repoHint = undefined;
      } else {
        await sb
          .from("agent_runs")
          .update({ status: "cancelled" })
          .eq("id", run_id)
          .eq("tenant_id", auth.tenant_id);
        res.status(409).json({
          error: {
            code: "repo_hint_other_site",
            message: "That repo belongs to a different site than the app this chat is about. Open that site's Build chat to change it.",
          },
        });
        return;
      }
    }

    if (repoHint && thread_id) {
      const { error: stickErr } = await sb
        .from("agent_threads")
        .update({ repo_full_name: repoHint })
        .eq("id", thread_id)
        .eq("tenant_id", auth.tenant_id);
      if (stickErr) {
        console.warn(
          `[chat-send] persist sticky repo failed for thread ${thread_id}: ${stickErr.message}`,
        );
      }
    }

    const mergedPayload: Record<string, unknown> = {
      thread_id,
      user_message_id,
      task_description: taskDescription,
      source_agent: "manual_chat",
      image_paths: imagePaths,
      doc_paths: docPaths,
      video_paths: videoPaths,
    };
    if (repoHint) {
      mergedPayload.repo_hint = repoHint;
      const siteId = await siteIdOf(repoHint);
      if (siteId) mergedPayload.site_id = siteId;
    }
    if (livePreviewUrl || livePreviewDom || livePreviewPicked) {
      mergedPayload.live_preview_context = {
        url: livePreviewUrl,
        dom_scrubbed: livePreviewDom,
        ...(livePreviewPicked ? { picked_element: livePreviewPicked } : {}),
      };
    }
    if (body.command_slug) {
      mergedPayload.command_slug = body.command_slug;
    }
    if (body.depth) {
      mergedPayload.depth = body.depth;
    }
    if (body.ui_tools && body.ui_tools.length > 0) {
      mergedPayload.ui_tools = body.ui_tools;
    }
    const { error: upErr } = await sb
      .from("agent_runs")
      .update({ payload: mergedPayload })
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id);
    if (upErr) {
      res.status(500).json({
        error: {
          code: "payload_merge_failed",
          message: upErr.message,
        },
      });
      return;
    }
  } else if (channelMention && slug === "operator") {
    const sb = serviceClient();
    const pin = await pinMentionOnRun(sb as unknown as MentionPinDb, auth.tenant_id, run_id, channelMention);
    if (!pin.ok) {
      console.warn(`[chat-send] mention pin failed (run=${run_id}): ${pin.error}`);
      await sb
        .from("agent_runs")
        .update({ status: "cancelled", finished_at: new Date().toISOString() })
        .eq("id", run_id)
        .eq("tenant_id", auth.tenant_id)
        .eq("status", "queued");
      res.status(500).json({
        error: {
          code: "mention_pin_failed",
          message: "Your message could not be sent to the agent you picked. Please send it again.",
        },
      });
      return;
    }
  } else if (body.command_slug || body.depth) {
    const sb = serviceClient();
    const { data: existing } = await sb
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    const prevPayload =
      (existing?.payload as Record<string, unknown> | null) ?? {};
    const nextPayload: Record<string, unknown> = { ...prevPayload };
    if (body.command_slug) nextPayload.command_slug = body.command_slug;
    if (body.depth) nextPayload.depth = body.depth;
    const { error: upErr } = await sb
      .from("agent_runs")
      .update({ payload: nextPayload })
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id);
    if (upErr) {
      res.status(500).json({
        error: {
          code: "payload_merge_failed",
          message: upErr.message,
        },
      });
      return;
    }
  }

  const pickedChannels = body.channels ?? [];
  if (pickedChannels.length > 0) {
    const sbCh = serviceClient();
    const { data: chRun } = await sbCh
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    const chBase = (chRun?.payload as Record<string, unknown> | null) ?? {};
    const { error: chErr } = await sbCh
      .from("agent_runs")
      .update({ payload: { ...chBase, channels: pickedChannels } })
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id);
    if (chErr) {
      console.warn(`[chat-send] channel tag merge failed (run=${run_id}): ${chErr.message}`);
    }
  }

  if (body.message_origin) {
    const sbMo = serviceClient();
    const { data: moRun, error: moReadErr } = await sbMo
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    if (moReadErr || !moRun) {
      console.warn(`[chat-send] message origin merge skipped, payload unread (run=${run_id}): ${moReadErr?.message ?? "no row"}`);
    } else {
      const moBase = (moRun.payload as Record<string, unknown> | null) ?? {};
      const { error: moErr } = await sbMo
        .from("agent_runs")
        .update({ payload: { ...moBase, message_origin: body.message_origin } })
        .eq("id", run_id)
        .eq("tenant_id", auth.tenant_id);
      if (moErr) {
        console.warn(`[chat-send] message origin merge failed (run=${run_id}): ${moErr.message}`);
      }
    }
  }

  if (body.channel_action_id) {
    const sbCa = serviceClient();
    const { data: caRun, error: caReadErr } = await sbCa
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    if (caReadErr || !caRun) {
      console.warn(`[chat-send] card id merge skipped, payload unread (run=${run_id}): ${caReadErr?.message ?? "no row"}`);
    } else {
      const { error: caErr } = await sbCa
        .from("agent_runs")
        .update({ payload: { ...((caRun.payload as Record<string, unknown> | null) ?? {}), channel_action_id: body.channel_action_id } })
        .eq("id", run_id)
        .eq("tenant_id", auth.tenant_id);
      if (caErr) console.warn(`[chat-send] card id merge failed (run=${run_id}): ${caErr.message}`);
    }
  }

  if (body.view_context && body.view_context.length > 0) {
    const sbVc = serviceClient();
    const { data: vcRun, error: vcReadErr } = await sbVc
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    if (vcReadErr || !vcRun) {
      console.warn(`[chat-send] view context merge skipped, payload unread (run=${run_id}): ${vcReadErr?.message ?? "no row"}`);
    } else {
      const { error: vcErr } = await sbVc
        .from("agent_runs")
        .update({ payload: { ...((vcRun.payload as Record<string, unknown> | null) ?? {}), view_context: body.view_context } })
        .eq("id", run_id)
        .eq("tenant_id", auth.tenant_id);
      if (vcErr) console.warn(`[chat-send] view context merge failed (run=${run_id}): ${vcErr.message}`);
    }
  }

  if (buildSessionId) {
    const sbBs = serviceClient();
    const { data: bsRun, error: bsReadErr } = await sbBs
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    if (bsReadErr || !bsRun) {
      console.warn(`[chat-send] build session stamp skipped, payload unread (run=${run_id}): ${bsReadErr?.message ?? "no row"}`);
    } else {
      const progress = await buildProgressOfSession(sbBs as unknown as BindingDb, auth.tenant_id, buildSessionId).catch(() => null);
      const bsBase = { ...((bsRun.payload as Record<string, unknown> | null) ?? {}), ...(progress ? { [BUILD_PROGRESS_PAYLOAD_KEY]: progress } : {}) };
      const { error: bsErr } = await sbBs
        .from("agent_runs")
        .update({ payload: { ...bsBase, [BUILD_SESSION_PAYLOAD_KEY]: buildSessionId } })
        .eq("id", run_id)
        .eq("tenant_id", auth.tenant_id);
      if (bsErr) {
        console.warn(`[chat-send] build session stamp failed (run=${run_id}): ${bsErr.message}`);
      }
    }
  }

  if (videoPaths.length > 0 && !def.metadata_praxis.requires_sandbox) {
    const sbVideo = serviceClient();
    const { data: videoRun } = await sbVideo
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    const videoBasePayload =
      (videoRun?.payload as Record<string, unknown> | null) ?? {};
    const { error: videoErr } = await sbVideo
      .from("agent_runs")
      .update({ payload: { ...videoBasePayload, video_paths: videoPaths } })
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id);
    if (videoErr) {
      res.status(500).json({
        error: { code: "payload_merge_failed", message: videoErr.message },
      });
      return;
    }
  }

  if (body.page_context) {
    const screenshotCtx =
      "mode" in body.page_context
        ? normalizeScreenshotPageContext(body.page_context)
        : null;
    const normalized =
      "mode" in body.page_context ? null : normalizePageContext(body.page_context);
    const sbPage = serviceClient();
    const { data: existingRun } = await sbPage
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    const basePayload =
      (existingRun?.payload as Record<string, unknown> | null) ?? {};
    const { error: pageErr } = await sbPage
      .from("agent_runs")
      .update({
        payload: {
          ...basePayload,
          surface: PAGE_CONTEXT_SURFACE,
          page_context: normalized
            ? {
                url: normalized.url,
                title: normalized.title,
                adapter_id: normalized.adapter_id,
                schema_version: normalized.schema_version,
                extraction: normalized.extraction,
                observation_only: normalized.observation_only,
                browser_observed: normalized.browser_observed,
              }
            : screenshotCtx,
        },
      })
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id);
    if (pageErr) {
      res.status(500).json({
        error: { code: "payload_merge_failed", message: pageErr.message },
      });
      return;
    }

    if (normalized) {
      recordAdapterHealth({
        ctx: normalized,
        run_id,
        tenant_id: auth.tenant_id,
      });
    }
  }

  if (staffModel.kind === "stamp") {
    const sbStaff = serviceClient();
    const { data: staffRun, error: staffReadErr } = await sbStaff
      .from("agent_runs")
      .select("payload")
      .eq("id", run_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    const { error: staffUpErr } = staffReadErr
      ? { error: staffReadErr }
      : await sbStaff
          .from("agent_runs")
          .update({
            payload: {
              ...((staffRun?.payload as Record<string, unknown> | null) ?? {}),
              staff_model: { ...staffModel.staff_model, by: auth.user_id },
            },
          })
          .eq("id", run_id)
          .eq("tenant_id", auth.tenant_id);
    if (staffUpErr) {
      res.status(500).json({
        error: {
          code: "payload_merge_failed",
          message: "Could not apply ?model= to this run.",
        },
      });
      return;
    }
  }

  if (body.panel_session_id) {
    try {
      await bindRunToPanelSession({
        tenant_id: auth.tenant_id,
        user_id: auth.user_id,
        run_id,
        panel_session_id: body.panel_session_id,
      });
    } catch {
    }
  }

  if (chatChannelAdmission.channel_slug) {
    let deadline: NodeJS.Timeout | undefined;
    try {
      const stamping = stampDirectChannelRun(
        auth.tenant_id,
        run_id,
        chatChannelAdmission.channel_slug,
      );
      stamping.catch(() => {});
      const stamped = await Promise.race([
        stamping,
        new Promise<"timeout">((resolve) => {
          deadline = setTimeout(() => resolve("timeout"), CHANNEL_STAMP_DEADLINE_MS);
        }),
      ]);
      if (stamped !== true) {
        console.warn(
          `[chat-send] channel stamp ${stamped === "timeout" ? "timed out" : "did not land"} ` +
            `(run=${run_id}, channel=${chatChannelAdmission.channel_slug}); dispatching unstamped`,
        );
      }
    } catch (e) {
      console.warn(
        `[chat-send] channel stamp threw (run=${run_id}); dispatching unstamped: ${(e as Error).message}`,
      );
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  let shouldDispatch = true;
  {
    const sbSerial = serviceClient();
    const { data: inflight, error: inflightErr } = await sbSerial
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", auth.tenant_id)
      .filter("payload->>thread_id", "eq", thread_id)
      .eq("trigger", "chat")
      .in("status", ["queued", "running"])
      .neq("id", run_id)
      .order("enqueued_at", { ascending: true })
      .limit(1);
    if (inflightErr) {
      console.warn(
        `[chat-send] serialization in-flight check failed (thread=${thread_id}): ${inflightErr.message}`,
      );
    } else if (inflight && inflight.length > 0) {
      const blockedBy = (inflight[0] as { id: string }).id;
      const { error: blockErr } = await sbSerial
        .from("agent_runs")
        .update({ status: "blocked", blocked_by_run_id: blockedBy })
        .eq("id", run_id)
        .eq("tenant_id", auth.tenant_id)
        .eq("status", "queued");
      if (blockErr) {
        console.warn(
          `[chat-send] mark-blocked failed (run=${run_id}); dispatching normally: ${blockErr.message}`,
        );
      } else {
        shouldDispatch = false;
      }
    }
  }

  if (shouldDispatch) {
    inngest
      .send(
        buildRunRequestedEvent({
          run_id,
          tenant_id: auth.tenant_id,
          agent_slug: slug,
          trigger: "chat",
          batch_id: null,
        }),
      )
      .catch((e: unknown) => {
        console.warn(
          "inngest.send failed for chat run",
          run_id,
          (e as Error).message,
        );
      });
  }

  res.status(202).json({ thread_id, user_message_id, run_id });
}
