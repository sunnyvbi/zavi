
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { callMcpTool } from "@/services/mcp/execute";
import { ACK_EMOJI, swapReaction } from "@/services/tools/slack/_reactions";
import { markLowConfDispatchReplied } from "@/services/slack/dispatch-operator-on-low-conf";
import { uploadFileToThread } from "@/services/tools/slack/upload_file";
import { mdToMrkdwn } from "@/services/tools/slack/mrkdwn";
import {
  chunkText,
  precedingTurnChunks,
  shouldDropPrecedingTurn,
} from "./_reply-format";
export { chunkText, precedingTurnChunks, shouldDropPrecedingTurn };
import { selectReplyTextFromRow } from "@/services/agents/terminal-reply-text";
import { composeHandoffBody } from "@/services/agents/handoff-result";
import { shouldHonestLabel } from "@/services/agents/honest-liveness-label";
import { getBoolSetting } from "@/services/settings";
import {
  completeSlackAnswerBarrier,
  enqueueSlackOutbox,
  type EnqueueSlackOutboxArgs,
} from "@/services/slack/outbox";
import {
  projectShipPrStatus,
  type ShipPrDecisionRow,
} from "@/services/slack/project-ship-pr-status";
import { postPendingApprovalBubblesForRun } from "./approval-slack-notify";
import { stripProcessNarration } from "./reply-brevity";
import type { RunOutcome } from "@/services/agents/outcome-model";
import { logEvent } from "@/services/logging/logEvent";
import { slackPostErrorFrom } from "@/services/tools/slack/_post_error";
import { isSlackReplySuppressed } from "@/services/slack/source-message-lifecycle";
import { suggestRuleFromSlackRun } from "@/services/rules/slack";

const ARTIFACT_BUCKET = "agent-artifacts";

const FALLBACK_URL_TTL_SECONDS = 604800;

export function isFileUploadBlockedError(msg: string): boolean {
  return /not_in_channel|channel_not_found|missing_scope|is_archived|restricted_action/i.test(
    msg,
  );
}

const CHUNK_SIZE = 2900;
const OK_EMOJI = "white_check_mark";
const FAIL_EMOJI = "x";
const HONEST_NEUTRAL_EMOJI = "memo";
const SUBSTANTIVE_DROP_MIN_CHARS = 40;

type RunRow = {
  tenant_id: string;
  trigger: string | null;
  status: string | null;
  infra_retry_count?: number | null;
  output_text: string | null;
  agent_slug: string | null;
  payload: Record<string, unknown> | null;
  error: string | null;
  parse_error: string | null;
  outcome: RunOutcome | null;
  assistant_turns: string[] | null;
};

export function isStaleAttempt(
  loaded: { infra_retry_count?: number | null },
  now: { status: string | null; infra_retry_count?: number | null },
): boolean {
  if (!isTerminalRunStatus(now.status)) return true;
  return (now.infra_retry_count ?? 0) !== (loaded.infra_retry_count ?? 0);
}

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return status !== "queued" && status !== "running";
}

export function slackReplyClaimEventId(
  event_id: string,
  run_id: string,
  payload: Record<string, unknown> | null,
): string {
  return payload?.slack_handoff_child === true ? `${event_id}:handoff:${run_id}` : event_id;
}

export function decideNoClaimUpdate(opts: {
  isHandoffChild: boolean;
  claimRowExists: boolean;
}): "insert_and_post" | "skip_already_handled" {
  if (opts.isHandoffChild) return "insert_and_post";
  return opts.claimRowExists ? "skip_already_handled" : "insert_and_post";
}

export function decideReplyClaimAction(opts: {
  isHandoffChild: boolean;
  runHasRealDeliverable: boolean;
  provisionalUpgradeSucceeded: boolean;
  claimRowExists: boolean;
}): "upgrade_provisional" | "insert_and_post" | "skip_already_handled" {
  if (opts.provisionalUpgradeSucceeded) return "upgrade_provisional";
  return decideNoClaimUpdate({
    isHandoffChild: opts.isHandoffChild,
    claimRowExists: opts.claimRowExists,
  });
}

export function buildTailEnqueuePayloads(
  chunks: readonly string[],
  failedIndex: number,
  ctx: {
    tenant_id: string;
    channel_id: string;
    thread_ts: string;
    team_id: string | null | undefined;
    run_id: string;
    event_id: string;
  },
): EnqueueSlackOutboxArgs[] {
  const start = Math.max(0, failedIndex);
  const out: EnqueueSlackOutboxArgs[] = [];
  for (let j = start; j < chunks.length; j++) {
    out.push({
      tenant_id: ctx.tenant_id,
      channel_id: ctx.channel_id,
      thread_ts: ctx.thread_ts,
      team_id: ctx.team_id,
      kind: "reply_tail",
      body: chunks[j],
      run_id: ctx.run_id,
      idempotency_key: `${ctx.event_id}:tail:${j}`,
    });
  }
  return out;
}

export function rewriteArtifactsTabSentence(text: string): string {
  if (!text || !/artifacts?\s+tab/i.test(text)) return text;
  return text
    .replace(
      /[^.!?\n]*\bartifacts?\s+tab\b[^.!?\n]*[.!?]?/gi,
      "I've attached it here.",
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildSlackReplyText(
  run: Pick<RunRow, "status" | "output_text" | "error" | "parse_error" | "agent_slug" | "outcome">,
  willAttachFile: boolean,
  userMessage?: string | null,
): string {
  const { markdown, isError } = selectReplyTextFromRow(run);
  if (!isError) {
    const shaped = stripProcessNarration({ body: markdown, userMessage });
    const base = mdToMrkdwn(shaped);
    return willAttachFile ? rewriteArtifactsTabSentence(base) : base;
  }
  return mdToMrkdwn(markdown);
}

export function buildSlackHandoffChildText(
  run: Pick<RunRow, "status" | "output_text" | "error" | "parse_error" | "agent_slug" | "outcome" | "payload"> & {
    parsed?: unknown;
  },
  run_id: string,
): string {
  const status = run.status ?? "";
  const body = composeHandoffBody({
    tenant_id: "",
    run_id,
    operator_thread_id: "",
    from_agent_slug: run.agent_slug ?? "specialist",
    status: status === "success" ? "success" : status === "parse_failed" ? "failed" : "error",
    parse_failed: status === "parse_failed",
    output_text: run.output_text,
    error: run.error ?? run.parse_error,
    outcome: run.outcome,
    parsed:
      run.parsed && typeof run.parsed === "object" ? (run.parsed as Record<string, unknown>) : null,
    payload: run.payload,
  });
  return mdToMrkdwn(body);
}

type SlackRouting = {
  channel_id?: string;
  thread_ts?: string;
  original_ts?: string;
  event_id?: string;
  team_id?: string;
  slack_trace_id?: string;
};

type UndeliveredArtifact = {
  id: string;
  storage_path: string;
  filename: string;
  mime: string | null;
};

async function attachRunArtifacts(args: {
  svc: ReturnType<typeof serviceClient>;
  tenant_id: string;
  run_id: string;
  channel_id: string;
  thread_ts: string;
  team_id?: string;
}): Promise<{ attached: number; failed: number }> {
  const { svc, tenant_id, run_id, channel_id, thread_ts, team_id } = args;
  let attached = 0;
  let failed = 0;
  let linked = 0;
  try {
    const { data: rows } = await svc
      .from("run_artifacts")
      .select("id, storage_path, filename, mime")
      .eq("tenant_id", tenant_id)
      .eq("run_id", run_id)
      .eq("slack_delivered", false);
    const artifacts = (rows ?? []) as UndeliveredArtifact[];
    if (artifacts.length === 0) return { attached: 0, failed: 0 };

    await logEvent({
      level: "info",
      source: "slack.artifact_delivery",
      code: "delivery_attempted",
      tenant_id,
      run_id,
      meta: { count: artifacts.length, tool_name: "slack.upload_file" },
    });

    for (const a of artifacts) {
      try {
        const { data: blob, error: dlErr } = await svc.storage
          .from(ARTIFACT_BUCKET)
          .download(a.storage_path);
        if (dlErr || !blob) {
          failed++;
          await logEvent({
            level: "warn",
            source: "slack.artifact_delivery",
            code: "delivery_download_failed",
            tenant_id,
            run_id,
            meta: { tool_name: "slack.upload_file" },
          });
          continue;
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await uploadFileToThread({
          tenant_id,
          channel_id,
          thread_ts: thread_ts || undefined,
          bytes,
          filename: a.filename,
          team_id,
        });
        await svc
          .from("run_artifacts")
          .update({ slack_delivered: true })
          .eq("id", a.id);
        attached++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isFileUploadBlockedError(msg)) {
          const delivered = await postArtifactLinkFallback({
            svc,
            tenant_id,
            run_id,
            channel_id,
            thread_ts,
            team_id,
            artifact_id: a.id,
            storage_path: a.storage_path,
            filename: a.filename,
          });
          if (delivered) {
            linked++;
            await logEvent({
              level: "warn",
              source: "slack.artifact_delivery",
              code: "delivery_link_fallback",
              tenant_id,
              run_id,
              meta: { error_class: slackErrorClass(msg), tool_name: "slack.upload_file" },
            });
            continue;
          }
        }
        failed++;
        await logEvent({
          level: "warn",
          source: "slack.artifact_delivery",
          code: "delivery_upload_failed",
          tenant_id,
          run_id,
          meta: { error_class: slackErrorClass(msg), tool_name: "slack.upload_file" },
        });
      }
    }
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "slack.artifact_delivery",
      code: "delivery_attach_pass_errored",
      tenant_id,
      run_id,
      error: e,
    });
  }
  return { attached: attached + linked, failed };
}

export function slackErrorClass(msg: string): string {
  const m = msg.match(
    /not_in_channel|channel_not_found|missing_scope|is_archived|restricted_action|invalid_auth|account_inactive|token_revoked/i,
  );
  if (m) return m[0].toLowerCase();
  const { code } = slackPostErrorFrom(msg);
  if (code !== "post_failed_unknown") return code;
  return "upload_error";
}

async function postArtifactLinkFallback(args: {
  svc: ReturnType<typeof serviceClient>;
  tenant_id: string;
  run_id: string;
  channel_id: string;
  thread_ts: string;
  team_id?: string;
  artifact_id: string;
  storage_path: string;
  filename: string;
}): Promise<boolean> {
  const { svc, tenant_id, run_id, channel_id, thread_ts, team_id } = args;
  try {
    const { data: signed, error } = await svc.storage
      .from(ARTIFACT_BUCKET)
      .createSignedUrl(args.storage_path, FALLBACK_URL_TTL_SECONDS);
    if (error || !signed?.signedUrl) return false;
    const text = `📎 ${args.filename} — I couldn't attach the file directly to this channel (I may not be a member), so here's a download link (expires in 7 days):\n${signed.signedUrl}`;
    const r = await callMcpTool(
      { tenant_id, run_id, slack_target_team_id: team_id, slack_inbound_delivery: true },
      "slack",
      "post_message",
      { channel_id, text, thread_ts },
    );
    if (r.is_error) return false;
    await svc
      .from("run_artifacts")
      .update({ slack_delivered: true })
      .eq("id", args.artifact_id);
    return true;
  } catch {
    return false;
  }
}

async function replyOne(run_id: string): Promise<unknown> {
  const svc = serviceClient();

  const { data: run } = await svc
    .from("agent_runs")
    .select(
      "tenant_id, trigger, status, infra_retry_count, output_text, agent_slug, payload, error, parse_error, outcome, assistant_turns, parsed",
    )
    .eq("id", run_id)
    .maybeSingle<RunRow>();
  if (!run) return { skip: "run_not_found" };
  if (run.trigger !== "slack") return { skip: "not_slack_triage" };
  if (!isTerminalRunStatus(run.status)) return { skip: "not_terminal" };

  if ((run.payload as { slack_reply_delegated?: unknown })?.slack_reply_delegated === true) {
    return { skip: "slack_reply_delegated" };
  }

  const slack = ((run.payload?.slack as SlackRouting) ?? {}) as SlackRouting;
  const channel_id = String(slack.channel_id ?? "");
  const thread_ts = String(slack.thread_ts ?? "");
  const original_ts = String(slack.original_ts ?? slack.thread_ts ?? "");
  const event_id = String(slack.event_id ?? "");
  const slack_trace_id = String(slack.slack_trace_id ?? "");
  const team_id = typeof slack.team_id === "string" ? slack.team_id : undefined;
  if (!channel_id || !event_id) return { skip: "not_slack_triage" };

  const tenant_id = run.tenant_id;

  {
    const suppression = await isSlackReplySuppressed({
      sc: svc,
      tenant_id,
      team_id: team_id ?? "",
      channel_id,
      source_ts: original_ts,
      run_event_id: event_id,
    });
    if (suppression.suppressed) {
      await completeSlackAnswerBarrier({
        tenant_id,
        channel_id,
        thread_ts,
        event_id,
        run_id,
        slack_ts: null,
      });
      return { skip: "suppressed_lifecycle", reason: suppression.reason, run_id };
    }
  }

  const reply_claim_event_id = slackReplyClaimEventId(event_id, run_id, run.payload);

  const now = new Date().toISOString();
  const { data: claimed } = await svc
    .from("slack_triage_claims")
    .update({ replied_at: now, answer_kind: "final" })
    .eq("tenant_id", tenant_id)
    .eq("event_id", reply_claim_event_id)
    .is("replied_at", null)
    .select("event_id");
  if (!claimed || claimed.length === 0) {
    const isHandoffChild =
      (run.payload as { slack_handoff_child?: unknown })?.slack_handoff_child === true;

    const runHasRealDeliverable = !selectReplyTextFromRow(run).isError;
    let provisionalUpgradeSucceeded = false;
    if (!isHandoffChild && runHasRealDeliverable) {
      const { data: upgraded } = await svc
        .from("slack_triage_claims")
        .update({ replied_at: now, answer_kind: "final" })
        .eq("tenant_id", tenant_id)
        .eq("event_id", reply_claim_event_id)
        .eq("answer_kind", "provisional")
        .select("event_id");
      provisionalUpgradeSucceeded = Boolean(upgraded && upgraded.length > 0);
    }

    let claimRowExists = false;
    if (!isHandoffChild && !provisionalUpgradeSucceeded) {
      const { data: existing } = await svc
        .from("slack_triage_claims")
        .select("event_id")
        .eq("tenant_id", tenant_id)
        .eq("event_id", reply_claim_event_id)
        .maybeSingle();
      claimRowExists = Boolean(existing);
    }
    const action = decideReplyClaimAction({
      isHandoffChild,
      runHasRealDeliverable,
      provisionalUpgradeSucceeded,
      claimRowExists,
    });
    if (action === "skip_already_handled") {
      const droppedChars = (run.output_text ?? "").trim().length;
      if (droppedChars > SUBSTANTIVE_DROP_MIN_CHARS) {
        await logEvent({
          level: "warn",
          source: "slack-triage-reply",
          code: "slack.reply.dropped_substantive",
          message: `substantive reply skipped as already-handled — answer not delivered (run ${run_id})`,
          tenant_id,
          meta: {
            run_id,
            event_id,
            reply_claim_event_id,
            agent_slug: run.agent_slug ?? null,
            chars: droppedChars,
            slack_trace_id:
              (run.payload as { slack?: { slack_trace_id?: string } })?.slack?.slack_trace_id ??
              null,
          },
        });
      }
      return { skip: "reply_already_handled" };
    }
    if (action === "upgrade_provisional") {
      await logEvent({
        level: "warn",
        source: "slack.reply",
        code: "provisional_upgraded",
        tenant_id,
        run_id,
        meta: { event_id: reply_claim_event_id, agent_slug: run.agent_slug },
      });
    } else {
      const { error: insertError } = await svc.from("slack_triage_claims").insert({
        tenant_id,
        event_id: reply_claim_event_id,
        status: "done",
        replied_at: now,
        answer_kind: "final",
      });
      if (insertError) {
        if ((insertError as { code?: string }).code === "23505") {
          return { skip: "reply_already_handled" };
        }
        throw new Error(`slack reply claim insert failed: ${insertError.message}`);
      }
    }
  }

  {
    const { data: nowRow, error: nowErr } = await svc
      .from("agent_runs")
      .select("status, infra_retry_count")
      .eq("id", run_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle<{ status: string; infra_retry_count: number | null }>();
    if (!nowErr && nowRow && isStaleAttempt(run, nowRow)) {
      const { data: released, error: relErr } = await svc
        .from("slack_triage_claims")
        .update({ replied_at: null })
        .eq("tenant_id", tenant_id)
        .eq("event_id", reply_claim_event_id)
        .eq("replied_at", now)
        .select("event_id");
      if (relErr || !released || released.length === 0) {
        await logEvent({
          level: "error",
          source: "slack-triage-reply",
          code: "slack.reply.stale_claim_not_released",
          message: `stale attempt's reply claim could not be released (run ${run_id}): ${relErr?.message ?? "no row"}`,
          tenant_id,
          run_id,
          meta: { agent_slug: run.agent_slug ?? null },
        });
      }
      return { skip: "stale_attempt_after_claim", run_id };
    }
  }

  let willAttachFile = false;
  try {
    const { count } = await svc
      .from("run_artifacts")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant_id)
      .eq("run_id", run_id)
      .eq("slack_delivered", false);
    willAttachFile = (count ?? 0) > 0;
  } catch {
    willAttachFile = false;
  }

  const honestLabelEnabled = await getBoolSetting(
    "honest_liveness_label_enabled",
    tenant_id,
  ).catch(() => false);

  const operatorMessage =
    (run.payload as { slack?: { text?: unknown } } | null)?.slack?.text;
  const isSpecialistHandoff =
    (run.payload as { slack_handoff_child?: unknown } | null)?.slack_handoff_child === true;
  const text = isSpecialistHandoff
    ? buildSlackHandoffChildText(run as RunRow & { parsed?: unknown }, run_id)
    : buildSlackReplyText(
        run,
        willAttachFile,
        typeof operatorMessage === "string" ? operatorMessage : null,
      );
  let offerLine: string | null = null;
  if (run.status === "success") {
    try {
      const { data: shipPr } = await svc
        .from("decisions")
        .select("status, autonomy_at_emit, approved_by, dispatch_error")
        .eq("tenant_id", tenant_id)
        .eq("agent_run_id", run_id)
        .eq("decision_class", "engineer.ship-pr")
        .order("emitted_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (shipPr) {
        offerLine = projectShipPrStatus(shipPr as ShipPrDecisionRow, {
          trigger: run.trigger,
          surface: "slack",
        });
      }
    } catch {
    }
  }

  const { isError: replyIsError } = selectReplyTextFromRow(run);
  const precedingChunks = isSpecialistHandoff
    ? []
    : precedingTurnChunks(run.assistant_turns, replyIsError, CHUNK_SIZE);
  const fullDigestChunks = (() => {
    if (replyIsError || isSpecialistHandoff) return [] as string[];
    const parsed = (run as { parsed?: unknown }).parsed;
    if (!parsed || typeof parsed !== "object") return [] as string[];
    const meta = (parsed as { metadata?: unknown }).metadata;
    if (!meta || typeof meta !== "object") return [] as string[];
    const full = (meta as { full_reply_markdown?: unknown }).full_reply_markdown;
    const collapsed = (meta as { report_lead_collapsed?: unknown }).report_lead_collapsed;
    if (collapsed !== true || typeof full !== "string" || full.trim().length === 0) {
      return [] as string[];
    }
    return chunkText(mdToMrkdwn(full), CHUNK_SIZE);
  })();
  const offerChunk = offerLine ? mdToMrkdwn(`_${offerLine}_`) : null;
  const chunks = [
    ...(offerChunk ? [offerChunk] : []),
    ...precedingChunks,
    ...chunkText(text, CHUNK_SIZE),
    ...fullDigestChunks,
  ];
  let lastPostedTs: string | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const r = await callMcpTool(
      { tenant_id, run_id, slack_target_team_id: team_id, slack_inbound_delivery: true },
      "slack",
      "post_message",
      { channel_id, text: chunks[i], thread_ts },
    );
    if (!r.is_error) {
      try {
        const parsed = JSON.parse(r.content) as { ts?: unknown };
        if (typeof parsed.ts === "string" && parsed.ts) lastPostedTs = parsed.ts;
      } catch {
      }
    }
    if (r.is_error) {
      if (i === 0) {
        await svc
          .from("slack_triage_claims")
          .update({ replied_at: null })
          .eq("tenant_id", tenant_id)
          .eq("event_id", reply_claim_event_id);
        await logEvent({
          level: "error",
          source: "slack.reply",
          code: "post_failed",
          tenant_id,
          run_id,
          meta: {
            event_id: reply_claim_event_id,
            slack_error: slackErrorClass(r.content),
            total_chunks: chunks.length,
            agent_slug: run.agent_slug ?? null,
          },
        });
        return { skip: "post_failed", run_id };
      }
      const tailPayloads = buildTailEnqueuePayloads(chunks, i, {
        tenant_id,
        channel_id,
        thread_ts,
        team_id,
        run_id,
        event_id: reply_claim_event_id,
      });
      let allTailQueued = true;
      for (const payload of tailPayloads) {
        if ((await enqueueSlackOutbox(payload)) == null) allTailQueued = false;
      }
      if (!allTailQueued) {
        await logEvent({
          level: "error",
          source: "slack.reply",
          code: "reply_tail_enqueue_failed",
          tenant_id,
          run_id,
          meta: { posted_chunks: i, total_chunks: chunks.length },
        });
      }
      await completeSlackAnswerBarrier({
        tenant_id,
        channel_id,
        thread_ts,
        event_id,
        run_id,
        slack_ts: lastPostedTs,
      });
      return {
        skip: allTailQueued ? "post_partial_enqueued_tail" : "post_partial_tail_partial",
        run_id,
        posted_chunks: i,
        total_chunks: chunks.length,
      };
    }
  }

  await completeSlackAnswerBarrier({
    tenant_id,
    channel_id,
    thread_ts,
    event_id,
    run_id,
    slack_ts: lastPostedTs,
  });

  const artifactResult = await attachRunArtifacts({
    svc,
    tenant_id,
    run_id,
    channel_id,
    thread_ts,
    team_id,
  });

  try {
    await postPendingApprovalBubblesForRun({
      tenant_id,
      run_id,
      channel_id,
      thread_ts,
      team_id,
    });
  } catch (e) {
    console.warn(
      `[slack-triage-reply] in-thread approval bubble post failed for run ${run_id}: ${(e as Error).message}`,
    );
  }

  await suggestRuleFromSlackRun({ tenantId: tenant_id, runId: run_id, channelId: channel_id, threadTs: thread_ts, teamId: team_id });

  if (original_ts) {
    const okOrNeutral = shouldHonestLabel({
      enabled: honestLabelEnabled,
      agentSlug: run.agent_slug,
      tier: run.outcome?.liveness_tier,
      isError: replyIsError,
    })
      ? HONEST_NEUTRAL_EMOJI
      : OK_EMOJI;
    const terminal = run.status === "success" ? okOrNeutral : FAIL_EMOJI;
    await swapReaction(tenant_id, channel_id, original_ts, ACK_EMOJI, terminal, team_id);
  }

  if ((run.payload as { low_conf_dispatch?: unknown })?.low_conf_dispatch === true) {
    await markLowConfDispatchReplied(run_id);
  }

  return {
    posted: true,
    run_id,
    status: run.status,
    slack_trace_id,
    artifacts_attached: artifactResult.attached,
    artifacts_failed: artifactResult.failed,
  };
}

export const slackTriageReplyFn = inngest.createFunction(
  { id: "slack-triage-reply", retries: 1, concurrency: 4 },
  { event: "agent.run.completed" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id;
    const res = await step.run("reply", () => replyOne(run_id));
    logger.info(`slack-triage-reply ${run_id}: ${JSON.stringify(res)}`);
    return res;
  },
);
