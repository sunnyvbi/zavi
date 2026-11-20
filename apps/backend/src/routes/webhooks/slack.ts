
import type { Request, Response } from "express";
import { serviceClient } from "@/services/supabase";
import { inngest } from "@/../workers/client";
import { sanitizeSlackEventPayload } from "@/services/redactor/slack-payload-sanitizer";
import { verifySlackSignature } from "@/services/slack/verify-signature";
import { resolveSlackApprover } from "@/services/slack/resolve-member";
import { enqueueWorkItem } from "@/services/agents/work-queue";
import { reserveSlackAnswerBarrier } from "@/services/slack/outbox";
import { getEffectiveVisibility } from "@/services/agents/visibility";
import { enqueueAgentRun, InsufficientCreditsError } from "@/services/agents/runner";
import { callMcpTool } from "@/services/mcp/execute";
import { handleSlackEngineerFollowup } from "@/services/agents/slack-pr-followup";
import { looksLikeApprovalIntent } from "@/services/approvals/slack-approval-nl";
import { FleetHaltedError } from "@/services/agents/fleet-halt";
import { detectSummon, handleSlackSummon } from "@/services/meetings/slack-summon";
import { detectRemember, handleRemember } from "@/services/memory-cards/slack-remember";
import { addReaction, ACK_EMOJI } from "@/services/tools/slack/_reactions";

const USER_MESSAGE_SUBTYPES = new Set<string>(["file_share"]);
function isNonUserSubtype(subtype: unknown): boolean {
  return typeof subtype === "string" && subtype.length > 0 && !USER_MESSAGE_SUBTYPES.has(subtype);
}

export async function slackWebhook(req: Request, res: Response): Promise<void> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    res.status(500).json({ error: { code: "no_signing_secret", message: "SLACK_SIGNING_SECRET unset" } });
    return;
  }

  const timestamp = String(req.header("x-slack-request-timestamp") ?? "");
  const signature = String(req.header("x-slack-signature") ?? "");
  const rawBuf = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
  const rawBody = rawBuf.toString("utf8");

  if (!verifySlackSignature(signingSecret, rawBody, timestamp, signature)) {
    res.status(401).json({ error: { code: "bad_signature", message: "slack signature invalid" } });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: { code: "bad_json", message: "invalid json" } });
    return;
  }

  if (body.type === "url_verification") {
    res.status(200).json({ challenge: body.challenge });
    return;
  }

  if (body.type !== "event_callback") {
    res.status(200).json({ ok: true, ignored: body.type });
    return;
  }

  const teamId = String(body.team_id ?? "");
  const eventId = String(body.event_id ?? "");
  const event = (body.event ?? {}) as Record<string, unknown>;
  const eventType = String(event.type ?? "unknown");

  if (!teamId || !eventId) {
    res.status(200).json({ ok: true, ignored: "missing team_id or event_id" });
    return;
  }

  const svc = serviceClient();

  const { data: meta, error: metaErr } = await svc
    .from("slack_workspaces")
    .select("tenant_id, bot_user_id")
    .eq("team_id", teamId)
    .maybeSingle();
  if (metaErr) {
    res.status(200).json({ ok: true, error: metaErr.message });
    return;
  }
  if (!meta?.tenant_id) {
    res.status(200).json({ ok: true, ignored: `no tenant for team ${teamId}` });
    return;
  }

  const sanitizedBody = sanitizeSlackEventPayload(body) as Record<string, unknown>;

  const { data: ingestId, error: ingestErr } = await svc.rpc("ingest_event", {
    p_tenant_id: meta.tenant_id,
    p_provider: "slack",
    p_external_event_id: eventId,
    p_event_type: eventType,
    p_payload: sanitizedBody,
  });
  if (ingestErr) {
    res.status(200).json({ ok: true, error: ingestErr.message });
    return;
  }

  if (ingestId) {
    const slackTraceId = `slk_${eventId}`;

    {
      const isIm = typeof event.channel_type === "string" && event.channel_type === "im";
      const selfOrBot =
        Boolean(event.bot_id) ||
        isNonUserSubtype(event.subtype) ||
        (typeof event.user === "string" && typeof meta.bot_user_id === "string" && event.user === meta.bot_user_id);
      const edited = Boolean(event.edited) && typeof event.edited === "object";
      const threadTs = String(event.thread_ts ?? "");
      if (eventType === "message" && isIm && !selfOrBot && !edited && threadTs && threadTs !== String(event.ts ?? "")) {
        const sanitizedEvent = (sanitizedBody.event ?? {}) as Record<string, unknown>;
        const { routeSlackCgoNoteReply } = await import("@/services/slack/cgo-note-reply");
        const outcome = await routeSlackCgoNoteReply(
          {
            findNote: async (a) => {
              const { data, error } = await svc
                .from("slack_outbox")
                .select("body, team_id, recipient_slack_user, run_id, idempotency_key")
                .eq("tenant_id", a.tenant_id)
                .eq("channel_id", a.channel_id)
                .eq("kind", "cgo_note")
                .eq("status", "sent")
                .eq("slack_ts", a.thread_ts)
                .limit(1)
                .maybeSingle();
              if (error) throw new Error(error.message);
              const row = (data as { body: string; team_id: string | null; recipient_slack_user: string | null; run_id: string | null; idempotency_key: string | null } | null) ?? null;
              if (!row) return null;
              const { decodeOutboxBody } = await import("@/services/slack/outbox-body");
              const { noteKeyOfOutboxRow } = await import("@/services/slack/cgo-note-reply");
              return { body: decodeOutboxBody(row.body).text, team_id: row.team_id, recipient_slack_user: row.recipient_slack_user, note_key: noteKeyOfOutboxRow(row) };
            },
            enqueueAgentRun: (input) => enqueueAgentRun(input),
            claimReply: async (tenantId, evId) => {
              const { error } = await svc.from("slack_triage_claims").upsert(
                { tenant_id: tenantId, event_id: evId, status: "done", replied_at: null },
                { onConflict: "tenant_id,event_id", ignoreDuplicates: true },
              );
              return !error;
            },
            afterRouted: async (a) => {
              void addReaction(a.tenant_id, a.channel_id, a.original_ts, ACK_EMOJI, a.team_id).catch(() => {});
              await reserveSlackAnswerBarrier({
                tenant_id: a.tenant_id,
                channel_id: a.channel_id,
                thread_ts: a.thread_ts,
                event_id: a.event_id,
              });
            },
            warn: (msg) => console.warn(msg),
          },
          {
            tenant_id: meta.tenant_id as string,
            team_id: teamId,
            channel_id: String(event.channel ?? ""),
            thread_ts: threadTs,
            original_ts: String(event.ts ?? ""),
            event_id: eventId,
            text: typeof sanitizedEvent.text === "string" ? sanitizedEvent.text : "",
            user: String(event.user ?? ""),
            ingested_event_id: ingestId as string,
            event_type: eventType,
            slack_trace_id: slackTraceId,
          },
        );
        if (outcome === "routed") {
          res.status(200).json({ ok: true, cgo_note_reply: true });
          return;
        }
      }
    }

    {
      const mentionIsDM = typeof event.channel_type === "string" && event.channel_type === "im";
      const mentionSelfOrBot =
        Boolean(event.bot_id) ||
        isNonUserSubtype(event.subtype) ||
        (typeof event.user === "string" &&
          typeof meta.bot_user_id === "string" &&
          event.user === meta.bot_user_id);
      const mentionEdited = Boolean(event.edited) && typeof event.edited === "object";
      if (
        !mentionSelfOrBot &&
        !mentionEdited &&
        (eventType === "app_mention" || (eventType === "message" && mentionIsDM))
      ) {
        const sanitizedEvent = (sanitizedBody.event ?? {}) as Record<string, unknown>;
        const { resolveCustomAgentMention } = await import("@/services/agents/custom-agent-chat");
        const { routeSlackCustomAgentMention } = await import("@/services/slack/custom-agent-mention");
        const outcome = await routeSlackCustomAgentMention(
          {
            resolve: (t, text) => resolveCustomAgentMention(t, text),
            enqueueAgentRun: (input) => enqueueAgentRun(input),
            postMessage: async (a) => {
              await callMcpTool(
                { tenant_id: a.tenant_id, run_id: "", slack_target_team_id: a.team_id },
                "slack",
                "post_message",
                { channel_id: a.channel_id, text: a.text, thread_ts: a.thread_ts },
              );
            },
            claimReply: async (tenantId, evId) => {
              const { error } = await svc.from("slack_triage_claims").upsert(
                { tenant_id: tenantId, event_id: evId, status: "done", replied_at: null },
                { onConflict: "tenant_id,event_id", ignoreDuplicates: true },
              );
              return !error;
            },
            afterRouted: async (a) => {
              void addReaction(a.tenant_id, a.channel_id, a.original_ts, ACK_EMOJI, a.team_id).catch(() => {});
              await reserveSlackAnswerBarrier({
                tenant_id: a.tenant_id,
                channel_id: a.channel_id,
                thread_ts: a.thread_ts,
                event_id: a.event_id,
              });
            },
            isCreditsError: (e) => e instanceof InsufficientCreditsError,
            warn: (msg) => console.warn(msg),
          },
          {
            tenant_id: meta.tenant_id as string,
            team_id: teamId,
            channel_id: String(event.channel ?? ""),
            thread_ts: String(event.thread_ts ?? event.ts ?? ""),
            original_ts: String(event.ts ?? ""),
            event_id: eventId,
            raw_text: String(event.text ?? ""),
            sanitized_text: typeof sanitizedEvent.text === "string" ? sanitizedEvent.text : "",
            user: String(event.user ?? ""),
            ingested_event_id: ingestId as string,
            event_type: eventType,
            slack_trace_id: slackTraceId,
          },
        );
        if (outcome !== "none") {
          res.status(200).json({ ok: true, custom_agent: outcome });
          return;
        }
      }
    }

    {
      const followupIsDM =
        typeof event.channel_type === "string" && event.channel_type === "im";
      const followupSelfOrBot =
        Boolean(event.bot_id) ||
        isNonUserSubtype(event.subtype) ||
        (typeof event.user === "string" &&
          typeof meta.bot_user_id === "string" &&
          event.user === meta.bot_user_id);
      const followupThreadTs = String(event.thread_ts ?? "");
      const followupEventTs = String(event.ts ?? "");
      const followupSanitizedEvent = (sanitizedBody.event ?? {}) as Record<
        string,
        unknown
      >;
      const followupText = String(followupSanitizedEvent.text ?? "");
      const isEditedRedelivery =
        Boolean(event.edited) && typeof event.edited === "object";
      if (
        !followupSelfOrBot &&
        !isEditedRedelivery &&
        (eventType === "app_mention" ||
          (eventType === "message" && followupIsDM)) &&
        followupThreadTs &&
        followupThreadTs !== followupEventTs &&
        followupText.trim().length > 0 &&
        !detectRemember(String(event.text ?? ""))
      ) {
        try {
          const tenantId = meta.tenant_id as string;
          if (looksLikeApprovalIntent(followupText)) {
            const { data: runRows } = await svc
              .from("agent_runs")
              .select("id")
              .eq("tenant_id", tenantId)
              .eq("payload->slack->>thread_ts", followupThreadTs)
              .limit(25);
            const runIds = ((runRows ?? []) as Array<{ id: string }>).map((r) => r.id);
            if (runIds.length > 0) {
              const { count: pendingCount } = await svc
                .from("decisions")
                .select("id", { count: "exact", head: true })
                .eq("tenant_id", tenantId)
                .in("agent_run_id", runIds)
                .eq("status", "proposed")
                .eq("autonomy_at_emit", "approval");
              if ((pendingCount ?? 0) > 0) {
                const slackUser = typeof event.user === "string" ? event.user : "";
                const approverId = await resolveSlackApprover(svc, {
                  tenant_id: tenantId,
                  team_id: teamId,
                  slack_user_id: slackUser,
                });
                if (approverId) {
                  await inngest.send({
                    name: "slack.approval.nl_route",
                    data: {
                      tenant_id: tenantId,
                      run_ids: runIds,
                      thread_ts: followupThreadTs,
                      channel_id: String(event.channel ?? ""),
                      team_id: teamId || null,
                      text: followupText,
                    },
                  });
                  await svc.from("slack_triage_claims").upsert(
                    { tenant_id: tenantId, event_id: eventId, status: "done", replied_at: null },
                    { onConflict: "tenant_id,event_id", ignoreDuplicates: true },
                  );
                  res.status(200).json({ ok: true, approval_nl: "route" });
                  return;
                }
              }
            }
          }
        } catch (e) {
          console.warn(
            `[webhooks/slack] approval-NL route check failed (${(e as Error).message}) — falling through`,
          );
        }

        try {
          const fr = await handleSlackEngineerFollowup(
            {
              svc,
              enqueueAgentRun: (input) => enqueueAgentRun(input),
              postMessage: async (a) => {
                void callMcpTool(
                  { tenant_id: a.tenant_id, run_id: "", slack_target_team_id: a.team_id },
                  "slack",
                  "post_message",
                  { channel_id: a.channel_id, text: a.text, thread_ts: a.thread_ts },
                ).catch(() => {});
              },
            },
            {
              tenant_id: meta.tenant_id as string,
              team_id: teamId,
              channel_id: String(event.channel ?? ""),
              thread_ts: followupThreadTs,
              original_ts: followupEventTs,
              event_id: eventId,
              text: followupText,
              slack_trace_id: slackTraceId,
              user: typeof event.user === "string" ? event.user : undefined,
            },
          );
          if (fr.action === "route") {
            const { error: claimErr } = await svc
              .from("slack_triage_claims")
              .upsert(
                {
                  tenant_id: meta.tenant_id as string,
                  event_id: eventId,
                  status: "done",
                  replied_at: null,
                },
                { onConflict: "tenant_id,event_id", ignoreDuplicates: true },
              );
            if (claimErr) {
              console.warn(
                `[webhooks/slack] pr-followup claim upsert failed (${claimErr.message}) — falling through so triage creates the claim`,
              );
            } else {
              res.status(200).json({ ok: true, pr_followup: "route" });
              return;
            }
          } else if (fr.action === "answer") {
            res.status(200).json({ ok: true, pr_followup: "answer" });
            return;
          } else if (fr.action === "clarify") {
            res.status(200).json({ ok: true, pr_followup: "clarify" });
            return;
          } else if (fr.action === "courtesy_noop") {
            res.status(200).json({ ok: true, pr_followup: "courtesy_noop" });
            return;
          }
        } catch (e) {
          console.warn(
            `[webhooks/slack] pr-followup intercept failed (continuing to normal routing): ${(e as Error).message}`,
          );
        }
      }
    }

    await inngest.send({
      id: `slack-event:${eventId}`,
      name: "webhook.slack.ingested",
      data: {
        ingested_event_id: ingestId as string,
        tenant_id: meta.tenant_id as string,
        event_type: eventType,
        slack_trace_id: slackTraceId,
      },
    });

    const isDirectMessage =
      typeof event.channel_type === "string" && event.channel_type === "im";
    const isSelfOrBotMessage =
      Boolean(event.bot_id) ||
      isNonUserSubtype(event.subtype) ||
      (typeof event.user === "string" &&
        typeof meta.bot_user_id === "string" &&
        event.user === meta.bot_user_id);
    if (
      !isSelfOrBotMessage &&
      (eventType === "app_mention" || (eventType === "message" && isDirectMessage))
    ) {
      const summonUrl = detectSummon(String(event.text ?? ""));
      if (summonUrl) {
        void handleSlackSummon({
          tenant_id: meta.tenant_id as string,
          team_id: teamId,
          channel_id: String(event.channel ?? ""),
          thread_ts: String(event.thread_ts ?? event.ts ?? ""),
          meeting_url: summonUrl,
        });
        res.status(200).json({ ok: true, summon: true });
        return;
      }
      if (detectRemember(String(event.text ?? ""))) {
        void handleRemember({
          tenant_id: meta.tenant_id as string,
          team_id: teamId,
          channel_id: String(event.channel ?? ""),
          thread_ts: String(event.thread_ts ?? event.ts ?? ""),
          event_ts: String(event.ts ?? ""),
          requested_by: String(event.user ?? "") || null,
        });
        res.status(200).json({ ok: true, remember: true });
        return;
      }
      void addReaction(
        meta.tenant_id as string,
        String(event.channel ?? ""),
        String(event.ts ?? ""),
        ACK_EMOJI,
        teamId,
      ).catch(() => {});
      try {
        const sanitizedEvent = (sanitizedBody.event ?? {}) as Record<
          string,
          unknown
        >;
        const rawFiles = Array.isArray((event as { files?: unknown }).files)
          ? ((event as { files: unknown[] }).files as Array<Record<string, unknown>>)
          : [];
        const slackImageRefs = rawFiles
          .filter((f) => typeof f?.mimetype === "string" && f.mimetype.startsWith("image/"))
          .slice(0, 4)
          .map((f) => ({
            url: String(f.url_private_download ?? f.url_private ?? ""),
            mimetype: String(f.mimetype ?? ""),
            name: String(f.name ?? "image"),
            size: typeof f.size === "number" ? f.size : undefined,
          }))
          .filter((r) => r.url.length > 0);
        const slackDocRefs = rawFiles
          .filter((f) => {
            const mt = typeof f?.mimetype === "string" ? f.mimetype : "";
            const ft = typeof f?.filetype === "string" ? f.filetype : "";
            return (
              mt === "application/pdf" ||
              mt.startsWith("text/") ||
              mt.includes("wordprocessingml") ||
              ["pdf", "doc", "docx", "text", "txt", "markdown", "md", "csv"].includes(ft)
            );
          })
          .slice(0, 4)
          .map((f) => ({
            file_id: String(f.id ?? ""),
            name: String(f.name ?? "document"),
            filetype: String(f.filetype ?? ""),
            size: typeof f.size === "number" ? f.size : undefined,
          }))
          .filter((r) => r.file_id.length > 0);
        await enqueueWorkItem({
          tenant_id: meta.tenant_id as string,
          agent_slug: "operator",
          source: "webhook_slack",
          dedupe_key: `slack:${eventId}`,
          payload: {
            ingested_event_id: ingestId as string,
            event_type: eventType,
            slack_trace_id: slackTraceId,
            slack: {
              channel_id: String(event.channel ?? ""),
              thread_ts: String(event.thread_ts ?? event.ts ?? ""),
              original_ts: String(event.ts ?? ""),
              event_id: eventId,
              text:
                typeof sanitizedEvent.text === "string"
                  ? sanitizedEvent.text
                  : "",
              user: String(event.user ?? ""),
              team_id: teamId,
              ...(slackImageRefs.length > 0 ? { images: slackImageRefs } : {}),
              ...(slackDocRefs.length > 0 ? { docs: slackDocRefs } : {}),
            },
          },
        });
        await reserveSlackAnswerBarrier({
          tenant_id: meta.tenant_id as string,
          channel_id: String(event.channel ?? ""),
          thread_ts: String(event.thread_ts ?? event.ts ?? ""),
          event_id: eventId,
        });

        try {
          const opVis = await getEffectiveVisibility(meta.tenant_id as string, "operator");
          if (opVis.visible) {
            await svc.from("slack_triage_claims").upsert(
              {
                tenant_id: meta.tenant_id as string,
                event_id: eventId,
                status: "done",
                replied_at: null,
              },
              { onConflict: "tenant_id,event_id", ignoreDuplicates: true },
            );
          }
        } catch (visErr) {
          console.warn(
            `[webhooks/slack] operator pre-claim skipped for event ${eventId}: ${(visErr as Error).message}`,
          );
        }
      } catch (e) {
        if (!(e instanceof FleetHaltedError)) {
          console.error(
            `[webhooks/slack] enqueueWorkItem failed for tenant ${meta.tenant_id} event ${eventId}: ${(e as Error).message}`,
          );
        }
      }
    }
  }

  res.status(200).json({ ok: true });
}
