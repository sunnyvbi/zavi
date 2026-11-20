
import { CUSTOM_AGENT_BLOCKED_TOOL_MESSAGE, isToolServerBlockedForAgent } from "@/services/billing/tiers";
import { isOutsidePaidChannelTool, paidChannelForAgent } from "@/services/agents/paid-channel-scope";
import type { McpCallResult } from "./types";
import { labSharedRead } from "@/services/agents/variants-lab/lab-read-cache";
import { labSimulatedCall, noteLabToolCall } from "@/services/agents/variants-lab/lab-simulate";
import { callSlackTool } from "./internal/slack";
import { callGithubTool } from "./internal/github";
import { callStripeTool } from "./internal/stripe";
import { callEmailTool } from "./internal/email";
import { callSupportInboxTool } from "./internal/support-inbox";
import { callGoogleAdsTool } from "./internal/google-ads";
import { callSocialTool } from "./internal/social";
import { callOutboundTool } from "./internal/outbound";
import { callGeneratedVideoTool } from "./internal/generated-video";
import { callCreatorTool, CREATOR_SERVER_ID } from "@/services/tools/creators/facade";
import { callSeoTool } from "./internal/seo";
import { callGeoTool } from "./internal/geo";
import { callPosthogTool } from "./internal/posthog";
import { callRedditAdsTool } from "./internal/reddit-ads";
import { callEmailCampaignTool } from "./internal/email-campaign";
import { callTikTokAdsTool } from "./internal/tiktok-ads";
import { callLinkedinAdsTool } from "./internal/linkedin-ads";
import { callSnapchatAdsTool } from "./internal/snapchat-ads";
import { callSpotifyAdsTool } from "./internal/spotify-ads";
import { callPinterestAdsTool } from "./internal/pinterest-ads";
import { callMicrosoftAdsTool } from "./internal/microsoft-ads";
import { callXAdsTool } from "./internal/x-ads";
import { callAppleAdsTool } from "./internal/apple-ads";
import { callSentryTool } from "./internal/sentry";
import { callFigmaTool } from "./internal/figma";
import { callGoogleSheetsTool } from "./internal/google-sheets";
import { callGoogleCalendarTool } from "./internal/google-calendar";
import { callSupabaseTool } from "./internal/supabase-connector";
import { callGoogleAnalyticsTool } from "./internal/google-analytics";
import { callGoogleSearchConsoleTool } from "./internal/google-search-console";
import { callMetaAdsTool } from "./internal/meta-ads";
import { callTikTokTool } from "./internal/tiktok";
import { callBufferTool } from "./internal/buffer";
import { callGrowthTool } from "./internal/growth";
import { callRedditTool } from "./internal/reddit";
import { callPinterestTool } from "./internal/pinterest";
import { callYoutubeTool } from "./internal/youtube";
import { callXSocialTool } from "./internal/x-social";
import { callInstagramTool } from "./internal/instagram";
import { callYoutubeInsightsTool } from "./internal/youtube-insights";
import { callPinterestInsightsTool } from "./internal/pinterest-insights";
import { callReportTool } from "./internal/report";
import { callArtifactsTool } from "./internal/artifacts";
import { callBrainTool } from "./internal/brain";
import { callOnboardingDiscoveryTool } from "./internal/onboarding-discovery";
import { callMemoryTool } from "./internal/memory";
import { callOperatorDbTool } from "./internal/operator-db";
import { callInvestorDbTool } from "./internal/investor-db";
import { callInvestorDiscoveryTool } from "./internal/investor-discovery";
import { callPaidAcquisitionTool } from "./internal/paid-acquisition";
import { callChatgptAdsTool } from "./internal/chatgpt-ads";
import { callWebSearchTool } from "./internal/web-search";
import { callConnectorSearchTool } from "./internal/connectors-search";
import { callApifyTool } from "./internal/apify";
import { sameSite } from "./own-site";
import { callWebFetchTool } from "./internal/web_fetch";
import { callProductProbeTool } from "./internal/product";
import { callBrowserTaskTool } from "./internal/browser-task";
import { callExtensionBrowserTaskTool, EXTENSION_TASK_LEDGER_OPTS, isExtensionTaskTool } from "./internal/extension-browser-task";
import { callPraxisCorpusTool } from "./internal/praxis-corpus";
import { callJiraTool } from "./internal/jira";
import { callLinearTool } from "./internal/linear";
import { callQaEngineerTool } from "./internal/qa-engineer";
import { callPraxisTool } from "./internal/praxis";
import { callCodeIndexTool } from "./internal/code-index";
import { getEnabledStreamableServer } from "./discovery";
import { callStreamableTool, advertisedReadToolNames } from "./streamable-client";
import { composioInputSchema, validateComposioInputs } from "./composio-inputs";
import { applyTiktokAdvertiser } from "@/services/connectors/tiktok-ads/write-args";
import { decodeRemoteToolName } from "./streamable-guards";
import { isRemoteCallExecAllowed, isDynamicVendorServerId } from "./write-allowlist";
import { isEgressToolName } from "./tool-capability";
import {
  assistantBlockedToolReason,
  isAssistantRun,
  withoutAssistantAiImages,
  withoutPurchasePrompts,
  assistantRefusalForError,
} from "./assistant-policy";
import { scrubSecretsFromArgs } from "./egress-secret-scrub";
import { logEvent } from "@/services/logging/logEvent";
import {
  isMeteredWriteTool,
  consumeHiggsfieldGenerateOrReject,
  resolveMediaDailyCap,
  buildIdempotencyKey,
} from "./higgsfield-meter";
import { isSideEffectingTool } from "./tool-effect-classifier";
import { isToolEffectLedgerEnabled, runWithToolEffectGuard } from "./tool-effect-ledger";
import { governActionOrBlock } from "./governance-enforce";
import { emailSendTierRefusal, isEmailSendTool } from "@/services/agents/email-send-tier";
import { runCustomWrite, type CustomWriteIntent } from "@/services/agents/custom-agent-writes";
import { runTenantRoutine, defaultDeps as skillRunnerDefaultDeps } from "@/services/routines/runner";
import { ROUTINE_SERVER_ID } from "@/services/routines/tool-name";
import { handleSkillLoad } from "@/services/agents/skill-runtime";
import { isUntrustedInboundRun } from "@/services/agents/untrusted-trigger";
import {
  assertColdContactWithinCaps,
  dmRecipientsFromCall,
  isConsentedSlackReply,
} from "./slack-dm-guard";
import { ExpectedToolError } from "@/services/tools/types";
import {
  recordWebFetchCapture,
  recordCaptureFromResult,
  recordCapture,
} from "@/services/agents/engine/capture-ledger";
import {
  recordDocRetrieval,
  recordRetrievalFailure,
  recordThreadAttachments,
} from "@/services/agents/engine/doc-ledger";
import {
  assertReferentResolved,
  isEligibleDoc,
} from "@/services/agents/engine/referent-gate";
import { classifyToolRisk, isWriteClass } from "./tool-risk-registry";
import { withAdCardReceipt } from "./ad-card-receipt";
import { withZaviSideNotice } from "@/services/config/zavi-side-error";
import { recordInvestorDbResults } from "@/services/agents/engine/investor-db-ledger";
import { isChatAnswerTurnEmit } from "@/services/agents/redo-mode";

export type CallMcpContext = {
  tenant_id: string;
  run_id: string;
  repo_full_name?: string;
  agent_slug?: string;
  trigger?: string;
  untrusted_context?: boolean;
  captured_page_context?: boolean;
  verified_member_email_reply?: boolean;
  top_action_run?: boolean;
  founder_chat_order?: boolean;
  founder_order_unverified?: boolean;
  founder_order_tell?: boolean;
  founder_order_group?: string;
  rules_steered?: { budget: boolean; status: boolean };
  chat_thread_id?: string;
  actor?: import("@/services/agents/actor-envelope").ActorAuthorityEnvelopeV1;
  user_id?: string;
  slack_routing?: {
    channel_id: string;
    thread_ts: string;
    original_ts: string;
    event_id: string;
    team_id?: string;
  };
  slack_target_team_id?: string;
  slack_post_blocked?: boolean;
  slack_inbound_delivery?: boolean;
  governed_dispatch?: { decision_id: string; server_id: string; tool_name: string };
  email_routing?: {
    thread_id: string;
    email_message_id: string;
    rfc_message_id: string | null;
    from: string;
    envelope_to: string;
    identity_id: string | null;
  };
  emit_decision?: (decision_class: string, body: unknown) => Promise<string>;
  writes_suppressed?: boolean;
  redo?: boolean;
  tool_use_id?: string;
  iter?: number;
};

function recordSlackDocLedger(
  run_id: string,
  tool_name: string,
  res: McpCallResult,
  current_ts?: string,
): void {
  try {
    if (tool_name !== "read_thread" && tool_name !== "read_file" && tool_name !== "get_channel_history") {
      return;
    }
    const parsed = JSON.parse(res.content) as Record<string, unknown>;

    if (tool_name === "read_file") {
      if (res.is_error) {
        recordRetrievalFailure(run_id, {
          ref: String((parsed.meta as { file_id?: string })?.file_id ?? "unknown"),
          reason: String(parsed.error ?? "file_unreadable"),
        });
        return;
      }
      const chars = Number(parsed.chars ?? 0);
      if (chars > 0) {
        recordDocRetrieval(run_id, {
          source: parsed.source === "run_artifact" ? "run_artifact" : "slack_file",
          ref: typeof parsed.file_id === "string" ? parsed.file_id : null,
          artifact_id: typeof parsed.artifact_id === "string" ? parsed.artifact_id : null,
          chars,
        });
      }
      return;
    }

    if (res.is_error) return;
    if (tool_name === "get_channel_history") return;
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    if (messages.length === 0) return;

    const rootTs = (messages[0] as { ts?: string }).ts;
    const currentTs =
      current_ts ?? (messages[messages.length - 1] as { ts?: string }).ts;

    const found = [];
    for (const m of messages) {
      const ts = (m as { ts?: string }).ts;
      if (ts !== rootTs && ts !== currentTs) continue;
      const files = (m as { files?: Array<{ file_id?: string; name?: string; filetype?: string }> }).files;
      for (const f of files ?? []) {
        if (!f.file_id) continue;
        const att = {
          file_id: f.file_id,
          name: f.name ?? "file",
          filetype: f.filetype ?? "",
        };
        if (isEligibleDoc(att)) found.push(att);
      }
    }
    if (found.length > 0) recordThreadAttachments(run_id, found);
  } catch {
  }
}

export async function callMcpTool(
  ctx: CallMcpContext,
  server_id: string,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  if (!isAssistantRun(ctx.trigger)) {
    return withZaviSideNotice(ctx, server_id, tool_name, await callMcpToolUnfiltered(ctx, server_id, tool_name, args));
  }
  let result: McpCallResult;
  try {
    result = withZaviSideNotice(ctx, server_id, tool_name, await callMcpToolUnfiltered(ctx, server_id, tool_name, args));
  } catch (e) {
    return assistantRefusalResult(e);
  }
  return { ...result, content: withoutPurchasePrompts(result.content, !result.ok || result.is_error) };
}

function assistantRefusalResult(e: unknown): McpCallResult {
  const refusal = assistantRefusalForError(e);
  if (!refusal) throw e;
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({ error: refusal.code, message: refusal.message }),
    ms: 0,
  };
}

async function callMcpToolUnfiltered(
  ctx: CallMcpContext,
  server_id: string,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  if (isOutsidePaidChannelTool(ctx.agent_slug, server_id, tool_name)) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "channel_scope_mismatch",
        message: `This run is scoped to ${paidChannelForAgent(ctx.agent_slug)!.name}. Complete that channel's request; other ad platforms belong to their own specialists.`,
      }),
      ms: 0,
    };
  }
  const simulated = await labSimulatedCall(ctx, server_id, tool_name, args);
  if (simulated) return simulated;
  noteLabToolCall(ctx.run_id, server_id, tool_name);
  return labSharedRead(ctx.tenant_id, server_id, tool_name, args, () =>
    callMcpToolDirect(ctx, server_id, tool_name, args),
  );
}

async function callMcpToolDirect(
  ctx: CallMcpContext,
  server_id: string,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  if (isToolServerBlockedForAgent(ctx.agent_slug, server_id)) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_not_available", message: CUSTOM_AGENT_BLOCKED_TOOL_MESSAGE }),
      ms: 0,
    };
  }
  if (isEmailSendTool(server_id, tool_name)) {
    const refusal = await emailSendTierRefusal(ctx.tenant_id);
    if (refusal) return { ok: false, is_error: true, content: JSON.stringify(refusal), ms: 0 };
  }
  if (isAssistantRun(ctx.trigger)) {
    const reason = assistantBlockedToolReason(server_id, tool_name);
    if (reason) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({ error: "not_available_from_assistant", message: reason }),
        ms: 0,
      };
    }
    args = withoutAssistantAiImages(server_id, tool_name, args);
  }
  if (server_id === "composio") {
    const advertiser = await applyTiktokAdvertiser(
      ctx.tenant_id,
      decodeRemoteToolName(tool_name),
      args,
      composioInputSchema(ctx.tenant_id, tool_name),
    );
    if (!advertiser.ok) {
      return { ok: false, is_error: true, content: JSON.stringify({ error: advertiser.code, message: advertiser.message }), ms: 0 };
    }
    args = advertiser.args;
    const invalid = validateComposioInputs(ctx.tenant_id, tool_name, args);
    if (invalid) return invalid;
  }
  let customWrite: CustomWriteIntent | undefined;
  if (server_id !== ROUTINE_SERVER_ID && server_id !== "skill") {
    if (ctx.run_id) {
      const isHandoff = server_id === "praxis" && tool_name === "handoff";
      const isOwnThreadReply =
        server_id === "slack" && !!isConsentedSlackReply(ctx, args);
      const writeClass = isWriteClass(classifyToolRisk(server_id, tool_name));
      if (isHandoff || (writeClass && !isOwnThreadReply)) {
        try {
          await assertReferentResolved(ctx.run_id, `${server_id}__${tool_name}`, {
            tenant_id: ctx.tenant_id,
            isSlackRun: !!ctx.slack_routing,
          });
        } catch (e) {
          if (e instanceof ExpectedToolError) {
            return {
              ok: false,
              is_error: true,
              content: JSON.stringify({
                error: e.code,
                message: e.message,
                ...(e.meta ? { meta: e.meta } : {}),
              }),
              ms: 0,
            };
          }
          throw e;
        }
      }
    }
    const gate = await governActionOrBlock(ctx, server_id, tool_name, args);
    if (gate.block) return gate.result;
    customWrite = gate.customWrite;
  }
  const intent = customWrite;
  const dispatch = (): Promise<McpCallResult> =>
    intent
      ? runCustomWrite(intent, () => dispatchMcpToolRaw(ctx, server_id, tool_name, args), (code, message) => ({
          ok: false,
          is_error: true,
          content: JSON.stringify({ error: code, message }),
          ms: 0,
        }))
      : dispatchMcpToolRaw(ctx, server_id, tool_name, args);
  const raw = isAssistantRun(ctx.trigger)
    ? (): Promise<McpCallResult> => dispatch().catch((e: unknown) => assistantRefusalResult(e))
    : dispatch;
  let res: McpCallResult;
  if (
    isToolEffectLedgerEnabled() &&
    ctx.run_id &&
    ctx.tool_use_id &&
    isSideEffectingTool(server_id, tool_name)
  ) {
    res = await (isExtensionTaskTool(server_id, tool_name)
      ? runWithToolEffectGuard(ctx, tool_name, args, raw, undefined, undefined, EXTENSION_TASK_LEDGER_OPTS)
      : runWithToolEffectGuard(ctx, tool_name, args, raw));
  } else {
    res = await raw();
  }
  return withAdCardReceipt(ctx, server_id, res);
}

async function dispatchMcpToolRaw(
  ctx: CallMcpContext,
  server_id: string,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  if (server_id === ROUTINE_SERVER_ID) {
    const started = Date.now();
    const emitted_tool_name = `${ROUTINE_SERVER_ID}__${tool_name}`;
    const result = await runTenantRoutine(
      {
        run_id: ctx.run_id,
        emitted_tool_name,
        untrusted_inbound: isUntrustedInboundRun(ctx),
      },
      {
        ...skillRunnerDefaultDeps(),
        callStep: async (step_server_id, step_tool_name, step_args, step_idx) => {
          const stepCtx: CallMcpContext = {
            ...ctx,
            tool_use_id: ctx.tool_use_id
              ? `${ctx.tool_use_id}__skillstep_${step_idx}`
              : undefined,
          };
          const r = await callMcpTool(stepCtx, step_server_id, step_tool_name, step_args);
          return { is_error: r.is_error, content: r.content };
        },
      },
    );
    return { ok: result.ok, content: result.content, is_error: !result.ok, ms: Date.now() - started };
  }
  if (server_id === "skill") {
    const started = Date.now();
    const r = await handleSkillLoad({
      run_id: ctx.run_id,
      tenant_id: ctx.tenant_id,
      agent_slug: ctx.agent_slug,
      input: args,
    });
    return {
      ok: !r.is_error,
      content: r.content,
      is_error: r.is_error,
      ms: Date.now() - started,
    };
  }
  if (server_id === "slack") {
    if (ctx.slack_post_blocked) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "slack_workspace_unresolved",
          message:
            "The source Slack workspace for this message could not be resolved — refusing to post to a different workspace.",
        }),
        ms: 0,
      };
    }
    const dmRecipients = isConsentedSlackReply(ctx, args)
      ? null
      : dmRecipientsFromCall(tool_name, args);
    if (dmRecipients) {
      try {
        assertColdContactWithinCaps(ctx.tenant_id, ctx.run_id, dmRecipients);
      } catch (e) {
        if (e instanceof ExpectedToolError) {
          return {
            ok: false,
            is_error: true,
            content: JSON.stringify({
              error: e.code,
              message: e.message,
              ...(e.meta ? { meta: e.meta } : {}),
            }),
            ms: 0,
          };
        }
        throw e;
      }
    }
    const slackRes = await callSlackTool(
      ctx.tenant_id,
      tool_name,
      args,
      ctx.slack_target_team_id,
      ctx.actor,
      ctx.run_id,
    );
    if (ctx.run_id) {
      recordSlackDocLedger(
        ctx.run_id,
        tool_name,
        slackRes,
        ctx.slack_routing?.original_ts,
      );
    }
    return slackRes;
  }
  if (server_id === "github") {
    return callGithubTool(ctx, tool_name, args);
  }
  if (server_id === "stripe") {
    return callStripeTool(ctx.tenant_id, tool_name, args);
  }
  if (server_id === "email") {
    return callEmailTool(ctx.tenant_id, tool_name, args, {
      emit_decision: ctx.emit_decision,
      run_id: ctx.run_id,
      run_trigger: ctx.trigger,
      writes_suppressed: ctx.writes_suppressed,
      redo: ctx.redo,
      top_action_run: ctx.top_action_run,
    });
  }
  if (server_id === "support_inbox") {
    return callSupportInboxTool(ctx.tenant_id, tool_name, args, {
      run_id: ctx.run_id,
      agent_slug: ctx.agent_slug,
      trigger: ctx.trigger,
    });
  }
  if (server_id === "google_ads") {
    return callGoogleAdsTool(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: ctx.emit_decision,
        run_id: ctx.run_id,
        run_trigger: ctx.trigger,
        writes_suppressed: ctx.writes_suppressed,
        redo: ctx.redo,
        rules_steered: ctx.rules_steered,
        untrusted_context: ctx.untrusted_context,
        captured_page_context: ctx.captured_page_context,
        top_action_run: ctx.top_action_run,
        founder_chat_order: ctx.founder_chat_order,
        founder_order_unverified: ctx.founder_order_unverified,
        founder_order_tell: ctx.founder_order_tell,
        founder_order_group: ctx.founder_order_group,
      },
      tool_name,
      args,
    );
  }
  if (server_id === "outbound") {
    return callOutboundTool(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: ctx.emit_decision,
        run_id: ctx.run_id,
        agent_slug: ctx.agent_slug,
        run_trigger: ctx.trigger,
      },
      tool_name,
      args,
    );
  }
  if (server_id === "social") {
    return callSocialTool(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: ctx.emit_decision,
        run_id: ctx.run_id,
        agent_slug: ctx.agent_slug,
        run_trigger: ctx.trigger,
      },
      tool_name,
      args,
    );
  }
  if (server_id === "generated_video") {
    return callGeneratedVideoTool(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: ctx.emit_decision,
        run_id: ctx.run_id,
        run_trigger: ctx.trigger,
        writes_suppressed: ctx.writes_suppressed,
        redo: ctx.redo,
        founder_chat_order: ctx.founder_chat_order,
        founder_order_unverified: ctx.founder_order_unverified,
        actor_user_id: ctx.actor?.actor_user_id ?? null,
      },
      tool_name,
      args,
    );
  }
  if (server_id === CREATOR_SERVER_ID) {
    return callCreatorTool(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: ctx.emit_decision,
        run_id: ctx.run_id,
        run_trigger: ctx.trigger,
        writes_suppressed: ctx.writes_suppressed,
        redo: ctx.redo,
        top_action_run: ctx.top_action_run,
      },
      tool_name,
      args,
    );
  }
  if (server_id === "seo") {
    return callSeoTool(
      { tenant_id: ctx.tenant_id, run_id: ctx.run_id, run_trigger: ctx.trigger, writes_suppressed: ctx.writes_suppressed, redo: ctx.redo, top_action_run: ctx.top_action_run, chat_answer_turn: isChatAnswerTurnEmit(ctx.emit_decision) },
      tool_name,
      args,
    );
  }
  if (server_id === "geo") {
    return callGeoTool(
      {
        tenant_id: ctx.tenant_id, run_id: ctx.run_id, run_trigger: ctx.trigger,
        writes_suppressed: ctx.writes_suppressed, redo: ctx.redo,
        chat_answer_turn: isChatAnswerTurnEmit(ctx.emit_decision),
        founder_chat_order: ctx.founder_chat_order,
        founder_order_group: ctx.founder_order_group,
        founder_order_unverified: ctx.founder_order_unverified,
        untrusted_context: ctx.untrusted_context,
        captured_page_context: ctx.captured_page_context,
      },
      tool_name,
      args,
    );
  }
  if (server_id === "google_analytics") {
    return callGoogleAnalyticsTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }
  if (server_id === "google_search_console") {
    return callGoogleSearchConsoleTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }

  if (server_id === "posthog") {
    return callPosthogTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }

  if (server_id === "reddit_ads") {
    return callRedditAdsTool(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: ctx.emit_decision,
        run_id: ctx.run_id,
        run_trigger: ctx.trigger,
        writes_suppressed: ctx.writes_suppressed,
        redo: ctx.redo,
        top_action_run: ctx.top_action_run,
      },
      tool_name,
      args,
    );
  }

  if (server_id === "email_campaign") {
    return callEmailCampaignTool(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: ctx.emit_decision,
        run_id: ctx.run_id,
        run_trigger: ctx.trigger,
        writes_suppressed: ctx.writes_suppressed,
        redo: ctx.redo,
      },
      tool_name,
      args,
    );
  }

  if (server_id === "tiktok_ads") {
    return callTikTokAdsTool(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: ctx.emit_decision,
        run_id: ctx.run_id,
        run_trigger: ctx.trigger,
        writes_suppressed: ctx.writes_suppressed,
        redo: ctx.redo,
        top_action_run: ctx.top_action_run,
      },
      tool_name,
      args,
    );
  }

  if (server_id === "linkedin_ads") {
    return callLinkedinAdsTool(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: ctx.emit_decision,
        run_id: ctx.run_id,
        run_trigger: ctx.trigger,
        writes_suppressed: ctx.writes_suppressed,
        redo: ctx.redo,
        untrusted_context: ctx.untrusted_context,
        captured_page_context: ctx.captured_page_context,
        verified_member_email_reply: ctx.verified_member_email_reply,
        top_action_run: ctx.top_action_run,
        founder_chat_order: ctx.founder_chat_order,
        founder_order_unverified: ctx.founder_order_unverified,
        rules_steered: ctx.rules_steered,
      },
      tool_name,
      args,
    );
  }

  if (server_id === "snapchat_ads") {
    return callSnapchatAdsTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }

  if (server_id === "spotify_ads") {
    return callSpotifyAdsTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }

  if (server_id === "pinterest_ads") {
    return callPinterestAdsTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }

  if (server_id === "microsoft_ads") {
    return callMicrosoftAdsTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }

  if (server_id === "x_ads") {
    return callXAdsTool(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: ctx.emit_decision,
        run_id: ctx.run_id,
        run_trigger: ctx.trigger,
        writes_suppressed: ctx.writes_suppressed,
        redo: ctx.redo,
        top_action_run: ctx.top_action_run,
      },
      tool_name,
      args,
    );
  }

  if (server_id === "apple_ads") {
    return callAppleAdsTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }

  if (server_id === "sentry") {
    return callSentryTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }

  if (server_id === "figma") {
    return callFigmaTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }

  if (server_id === "google_sheets") {
    return callGoogleSheetsTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }

  if (server_id === "google_calendar") {
    return callGoogleCalendarTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }

  if (server_id === "supabase") {
    return callSupabaseTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }
  if (server_id === "meta_ads") {
    return callMetaAdsTool(
      {
        tenant_id: ctx.tenant_id,
        emit_decision: ctx.emit_decision,
        run_trigger: ctx.trigger,
        untrusted_context: ctx.untrusted_context,
        captured_page_context: ctx.captured_page_context,
        verified_member_email_reply: ctx.verified_member_email_reply,
        top_action_run: ctx.top_action_run,
        founder_chat_order: ctx.founder_chat_order,
        founder_order_unverified: ctx.founder_order_unverified,
        founder_order_tell: ctx.founder_order_tell,
        founder_order_group: ctx.founder_order_group,
        rules_steered: ctx.rules_steered,
        run_id: ctx.run_id,
        writes_suppressed: ctx.writes_suppressed,
        redo: ctx.redo,
      },
      tool_name,
      args,
    );
  }
  if (server_id === "tiktok") {
    return callTikTokTool(
      { tenant_id: ctx.tenant_id, run_trigger: ctx.trigger, actor: ctx.actor, writes_suppressed: ctx.writes_suppressed },
      tool_name,
      args,
    );
  }
  if (server_id === "buffer") {
    return callBufferTool(ctx.tenant_id, tool_name, args);
  }
  if (server_id === "report") {
    return callReportTool(ctx, tool_name, args);
  }
  if (server_id === "artifacts") {
    return callArtifactsTool(ctx, tool_name, args);
  }
  if (server_id === "reddit") {
    return callRedditTool(ctx.tenant_id, tool_name, args, ctx.run_id);
  }
  if (server_id === "pinterest") {
    return callPinterestTool(ctx.tenant_id, tool_name, args);
  }
  if (server_id === "pinterest_insights") {
    return callPinterestInsightsTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }
  if (server_id === "youtube") {
    return callYoutubeTool(ctx.tenant_id, tool_name, args, ctx.run_id);
  }
  if (server_id === "instagram") {
    return callInstagramTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }
  if (server_id === "youtube_insights") {
    return callYoutubeInsightsTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }
  if (server_id === "x_social") {
    return callXSocialTool({ tenant_id: ctx.tenant_id }, tool_name, args);
  }
  if (server_id === "growth") {
    return callGrowthTool(ctx.tenant_id, tool_name, args, ctx.run_id, {
      emit_decision: ctx.emit_decision,
      agent_slug: ctx.agent_slug,
      run_trigger: ctx.trigger,
      untrusted_context: ctx.untrusted_context,
      captured_page_context: ctx.captured_page_context,
      actor: ctx.actor,
      founder_chat_order: ctx.founder_chat_order,
      founder_order_unverified: ctx.founder_order_unverified,
      ...(ctx.writes_suppressed ? { writes_suppressed: true } : {}),
    });
  }
  if (server_id === "memory") {
    return callMemoryTool(ctx.tenant_id, tool_name, args, {
      run_id: ctx.run_id,
      agent_slug: ctx.agent_slug,
    });
  }
  if (server_id === "brain") {
    return callBrainTool(ctx.tenant_id, tool_name, args, {
      run_id: ctx.run_id,
      agent_slug: ctx.agent_slug,
      run_trigger: ctx.trigger,
      untrusted_context: ctx.untrusted_context,
      captured_page_context: ctx.captured_page_context,
      chat_thread_id: ctx.chat_thread_id,
    });
  }
  if (server_id === "onboarding_discovery") {
    return callOnboardingDiscoveryTool(ctx.tenant_id, tool_name, args, {
      run_id: ctx.run_id,
      agent_slug: ctx.agent_slug,
    });
  }
  if (server_id === "operator_db") {
    return callOperatorDbTool(ctx.tenant_id, tool_name, args, {
      writes_suppressed: ctx.writes_suppressed,
      run_id: ctx.run_id,
      agent_slug: ctx.agent_slug,
    });
  }
  if (server_id === "investor_db") {
    const res = await callInvestorDbTool(ctx.tenant_id, tool_name, args);
    if (ctx.run_id && tool_name === "search" && !res.is_error) {
      try {
        const parsed = JSON.parse(res.content) as { investors?: unknown };
        if (Array.isArray(parsed?.investors)) {
          recordInvestorDbResults(
            ctx.run_id,
            parsed.investors as { name?: string | null; primary_firm?: string | null }[],
          );
        }
      } catch {
      }
    }
    return res;
  }
  if (server_id === "investor_discovery") {
    return callInvestorDiscoveryTool(ctx, tool_name, args);
  }
  if (server_id === "paid_acquisition") {
    return callPaidAcquisitionTool(ctx.tenant_id, tool_name, args, { agent_slug: ctx.agent_slug });
  }
  if (server_id === "chatgpt_ads") {
    return callChatgptAdsTool({ ...ctx, run_trigger: ctx.trigger }, tool_name, args);
  }
  if (server_id === "web_search") {
    const agentArgs =
      args && typeof args === "object"
        ? { ...(args as Record<string, unknown>), include_answer: false }
        : args;
    return callWebSearchTool(ctx.tenant_id, tool_name, agentArgs, ctx.run_id);
  }
  if (server_id === "connectors") {
    return callConnectorSearchTool(ctx.tenant_id, tool_name, args, ctx.run_id);
  }
  if (server_id === "apify") {
    return callApifyTool(ctx.tenant_id, tool_name, args, ctx.run_id);
  }
  if (server_id === "web_fetch") {
    let res = await callWebFetchTool(ctx.tenant_id, tool_name, args);
    if (isBlockedCapture(res)) {
      const own = await tenantOwnDomain(ctx.tenant_id);
      const target = requestedUrl(args);
      if (own && target && sameSite(target, own)) {
        const rendered = await callMcpTool(ctx, "apify", "rag_web_browser", {
          url: target,
          output_format: "markdown",
        });
        if (rendered.ok && !rendered.is_error) {
          res = rendered;
          if (ctx.run_id && typeof rendered.content === "string") {
            recordCapture(ctx.run_id, {
              requested_url: target,
              final_url: target,
              capture: "rendered",
              status: 200,
              truncated: false,
              text_snippet: rendered.content.slice(0, 16 * 1024),
            });
          }
        }
      }
    }
    if (ctx.run_id) {
      recordWebFetchCapture(ctx.run_id, args, res.content);
    }
    return res;
  }
  if (server_id === "browser") {
    return callBrowserTaskTool(
      {
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        tool_use_id: ctx.tool_use_id,
        writes_suppressed: ctx.writes_suppressed,
      },
      tool_name,
      args,
    );
  }
  if (server_id === "extension") {
    return callExtensionBrowserTaskTool(
      {
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        agent_slug: ctx.agent_slug,
        tool_use_id: ctx.tool_use_id,
        writes_suppressed: ctx.writes_suppressed,
      },
      tool_name,
      args,
    );
  }
  if (server_id === "product") {
    const res = await callProductProbeTool(ctx.tenant_id, tool_name, args);
    if (ctx.run_id) {
      let shape: { final_url?: unknown; meta?: { final_url?: unknown } } = {};
      try {
        shape = JSON.parse(res.content) as typeof shape;
      } catch {
      }
      const finalUrl =
        typeof shape.final_url === "string"
          ? shape.final_url
          : typeof shape.meta?.final_url === "string"
            ? shape.meta.final_url
            : undefined;
      if (finalUrl) recordCaptureFromResult(ctx.run_id, finalUrl, res.content);
    }
    return res;
  }
  if (server_id === "competitor_intel") {
    if (tool_name === "http_fetch") {
      const res = await callWebFetchTool(ctx.tenant_id, "fetch", args);
      if (ctx.run_id) {
        recordWebFetchCapture(ctx.run_id, args, res.content);
      }
      return res;
    }
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `competitor_intel/${tool_name} is not wired; use competitor_intel__http_fetch (page read) or web_search__search (find sources).`,
      }),
      ms: 0,
    };
  }
  if (server_id === "praxis_corpus") {
    return callPraxisCorpusTool(ctx.tenant_id, tool_name, args);
  }
  if (server_id === "jira") {
    return callJiraTool(ctx, tool_name, args);
  }
  if (server_id === "linear") {
    return callLinearTool(ctx, tool_name, args);
  }
  if (server_id === "qa_engineer") {
    return callQaEngineerTool(ctx, tool_name, args);
  }
  if (server_id === "code_index") {
    return callCodeIndexTool(ctx, tool_name, args);
  }
  if (server_id === "praxis") {
    return callPraxisTool(
      {
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        agent_slug: ctx.agent_slug,
        trigger: ctx.trigger,
        chat_thread_id: ctx.chat_thread_id,
        user_id: ctx.user_id,
        actor: ctx.actor,
        slack_routing: ctx.slack_routing,
        email_routing: ctx.email_routing,
        emit_decision: ctx.emit_decision,
        tool_use_id: ctx.tool_use_id,
        writes_suppressed: ctx.writes_suppressed,
        founder_chat_order: ctx.founder_chat_order,
        founder_order_unverified: ctx.founder_order_unverified,
      },
      tool_name,
      args,
    );
  }
  const row = await getEnabledStreamableServer(ctx.tenant_id, server_id);
  if (row) {
    const realName = decodeRemoteToolName(tool_name);

    if (isDynamicVendorServerId(server_id)) {
      const advertised = advertisedReadToolNames(ctx.tenant_id, server_id);
      if (!advertised || !advertised.has(tool_name)) {
        return {
          ok: false,
          is_error: true,
          content: JSON.stringify({
            error: "tool_not_allowed",
            message: `Tool "${realName}" was not advertised as read-only for "${server_id}".`,
          }),
          ms: 0,
        };
      }
    }

    if (!isRemoteCallExecAllowed(server_id, realName)) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "tool_not_allowed",
          message: `Tool "${realName}" is not permitted for server "${server_id}".`,
        }),
        ms: 0,
      };
    }

    if (isMeteredWriteTool(server_id, realName)) {
      const decision = await consumeHiggsfieldGenerateOrReject({
        tenant_id: ctx.tenant_id,
        idempotency_key: buildIdempotencyKey(ctx.run_id, ctx.tool_use_id),
        dailyCap: resolveMediaDailyCap(),
      });
      if (decision === "over_cap") {
        return {
          ok: false,
          is_error: true,
          content: JSON.stringify({
            error: "higgsfield_daily_cap",
            message: "Daily generation cap reached for this workspace. Try again tomorrow or raise the cap.",
          }),
          ms: 0,
        };
      }
      if (decision === "already") {
        return {
          ok: true,
          is_error: false,
          content: JSON.stringify({
            status: "already_requested",
            message: "This generation was already requested for this step (idempotent replay); not re-submitted.",
          }),
          ms: 0,
        };
      }
    }

    let outboundArgs = args;
    if (isEgressToolName(`${server_id}__${realName}`)) {
      const { scrubbed, redactions } = scrubSecretsFromArgs(args);
      if (redactions.length > 0) {
        outboundArgs = scrubbed;
        await logEvent({
          level: "warn",
          source: "mcp-execute",
          code: "egress_secret_scrubbed",
          meta: {
            server_id,
            detectors: redactions.slice(0, 10),
            count: redactions.length,
          },
        });
      }
    }

    return callStreamableTool(ctx.tenant_id, row, tool_name, outboundArgs);
  }

  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: "server_not_wired",
      message: `MCP server "${server_id}" not yet implemented. Internal handlers for new servers go in services/mcp/internal/<server>.ts.`,
    }),
    ms: 0,
  };
}

function isBlockedCapture(res: McpCallResult): boolean {
  if (!res.is_error || typeof res.content !== "string") return false;
  try {
    return (JSON.parse(res.content) as { capture?: unknown }).capture === "blocked";
  } catch {
    return false;
  }
}

function requestedUrl(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const u = (args as { url?: unknown }).url;
  return typeof u === "string" && u.length > 0 ? u : null;
}

async function tenantOwnDomain(tenant_id: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCompanyFacts } = require("@/services/company/facts") as typeof import("@/services/company/facts");
    const cf = await getCompanyFacts(tenant_id);
    return cf.website ?? null;
  } catch {
    return null;
  }
}

