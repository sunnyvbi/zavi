
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { sendAgentMailReply, type AgentMailSendResult } from "@/email/sendAgentMailReply";
import { matchesAllowlist, type AllowlistEntry } from "@/email/allowlist";
import { scanOutboundEmail } from "@/services/tools/email/outbound-scan";
import { scanInternalMarkers } from "@/services/tools/email/internal-marker-scan";
import { logEvent } from "@/services/logging/logEvent";
import { mirrorEmailReplyToChat } from "@/email/mirrorEmailReplyToChat";
import { canonicalMessageId } from "@/email/sendAgentOwnedEmail";
import { handoffChildReplyText, isHandoffChildPayload } from "@/services/agents/handoff-result";
import type { RunOutcome } from "@/services/agents/outcome-model";

const MAX_BODY = 50_000;

const TERMINAL_FAILED_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "parse_failed",
  "dispatch_error",
  "error",
]);

export const COMMS_REPLY_HANDLERS = new Set(["email.send", "gmail.send", "outbound.send"]);

export function isCommsReplyHandler(handler: string | null | undefined): boolean {
  return typeof handler === "string" && COMMS_REPLY_HANDLERS.has(handler);
}

const OUTWARD_COMMS_HANDLERS = new Set([
  ...COMMS_REPLY_HANDLERS,
  "slack.post_message",
  "social.publish",
]);

export function isOutwardCommsHandler(handler: string | null | undefined): boolean {
  return typeof handler === "string" && OUTWARD_COMMS_HANDLERS.has(handler);
}

type RunRow = {
  tenant_id: string;
  trigger: string | null;
  status: string | null;
  output_text: string | null;
  agent_slug: string | null;
  payload: Record<string, unknown> | null;
  outcome: Partial<RunOutcome> | null;
  parsed: Record<string, unknown> | null;
};

type EmailRouting = {
  thread_id?: string;
  email_message_id?: string;
  rfc_message_id?: string | null;
  from?: string;
  envelope_to?: string;
  identity_id?: string | null;
};

export async function replyOne(run_id: string): Promise<unknown> {
  const svc = serviceClient();

  const { data: run } = await svc
    .from("agent_runs")
    .select("tenant_id, trigger, status, output_text, agent_slug, payload, outcome, parsed")
    .eq("id", run_id)
    .maybeSingle<RunRow>();
  if (!run) return { skip: "run_not_found" };
  if (run.trigger !== "email") return { skip: "not_email_triage" };

  if ((run.payload as { email_reply_delegated?: unknown })?.email_reply_delegated === true) {
    return { skip: "email_reply_delegated" };
  }

  const er = ((run.payload?.email as EmailRouting) ?? {}) as EmailRouting;
  const tenant_id = run.tenant_id;
  const inbound_message_id = String(er.email_message_id ?? "");
  const reply_to_sender = String(er.from ?? "");
  if (!inbound_message_id || !reply_to_sender) return { skip: "no_email_routing" };

  const { data: runDecisions } = await svc
    .from("decisions")
    .select("handler")
    .eq("agent_run_id", run_id);
  if ((runDecisions ?? []).some((d) => isOutwardCommsHandler((d as { handler: string | null }).handler))) {
    return { skip: "decision_emitted_defer_to_approval", run_id };
  }

  const { data: memberRows } = await svc.rpc("tenant_member_emails", { p_tenant_id: tenant_id });
  const members = new Set(
    (Array.isArray(memberRows) ? memberRows : [])
      .map((m: unknown) => String(m ?? "").trim().toLowerCase())
      .filter(Boolean),
  );

  const { data: entryRows, error: entryErr } = await svc.rpc("email_allowlist_entries", {
    p_tenant_id: tenant_id,
  });
  if (entryErr) {
    await logEvent({
      level: "error",
      source: "email-triage-reply",
      code: "email.reply.allowlist_read_failed",
      message: `could not read allowlist for run ${run_id}; replying to members only: ${entryErr.message}`,
      tenant_id,
    });
  }
  const allowEntries = (Array.isArray(entryRows) ? entryRows : []) as AllowlistEntry[];

  const { data: disabledRows, error: disabledErr } = await svc.rpc("disabled_member_emails", {
    p_tenant_id: tenant_id,
  });
  if (disabledErr) {
    await logEvent({
      level: "error",
      source: "email-triage-reply",
      code: "email.reply.disabled_read_failed",
      message: `could not read disabled members for run ${run_id}; withholding reply: ${disabledErr.message}`,
      tenant_id,
    });
    return { skip: "member_state_unavailable", run_id };
  }
  const disabledMembers = new Set(
    (Array.isArray(disabledRows) ? disabledRows : [])
      .map((m: unknown) => String(m ?? "").trim().toLowerCase())
      .filter(Boolean),
  );

  const mayReceive = (a: string): boolean =>
    !disabledMembers.has(a) && (members.has(a) || matchesAllowlist(a, allowEntries));

  if (!mayReceive(reply_to_sender.trim().toLowerCase())) {
    await logEvent({
      level: "warn",
      source: "email-triage-reply",
      code: "email.reply.sender_no_longer_permitted",
      message: `sender ${reply_to_sender} is no longer a member or allowlisted; reply withheld (run ${run_id})`,
      tenant_id,
    });
    return { skip: "sender_no_longer_permitted", run_id };
  }

  const { data: inbound, error: inboundErr } = await svc
    .from("email_messages")
    .select(
      "dedup_key, thread_id, subject, rfc_message_id, references_chain, to_addresses, cc_addresses, headers, email_threads(root_message_id)",
    )
    .eq("id", inbound_message_id)
    .maybeSingle<{
      dedup_key: string;
      thread_id: string;
      subject: string | null;
      rfc_message_id: string | null;
      references_chain: string[] | null;
      to_addresses: string[] | null;
      cc_addresses: string[] | null;
      headers: Record<string, string | string[]> | null;
      email_threads: { root_message_id: string | null } | Array<{ root_message_id: string | null }> | null;
    }>();
  if (inboundErr) throw new Error(`inbound read failed for run ${run_id}: ${inboundErr.message}`);
  if (!inbound) return { skip: "inbound_not_found" };

  const { data: claimed } = await svc
    .from("email_triage_claims")
    .update({ replied_at: new Date().toISOString() })
    .eq("tenant_id", tenant_id)
    .eq("dedup_key", inbound.dedup_key)
    .is("replied_at", null)
    .select("dedup_key");
  if (!claimed || claimed.length === 0) {
    return { skip: "reply_already_handled" };
  }

  const handoffChildTerminalFailure =
    isHandoffChildPayload(run.payload) && TERMINAL_FAILED_STATUSES.has(run.status ?? "");
  const refusedWithExplanation = run.status === "failed" && run.outcome?.failure?.class === "policy_refusal";
  if (run.status !== "success" && !handoffChildTerminalFailure && !refusedWithExplanation) {
    await logEvent({
      level: "warn",
      source: "email-triage-reply",
      code: "email.reply.run_failed",
      message: `email run ${run_id} status=${run.status}; no reply sent`,
      tenant_id,
    });
    return { skip: "run_not_success", status: run.status };
  }

  let body = isHandoffChildPayload(run.payload)
    ? handoffChildReplyText(run, run_id)
    : (run.output_text ?? "").trim();
  if (!body) return { skip: "empty_output" };
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);

  const scan = scanOutboundEmail(body);
  if (scan.blocked) {
    await logEvent({
      level: "error",
      source: "email-triage-reply",
      code: "email.reply.outbound_blocked",
      message: `outbound email blocked by secret scan (run ${run_id}): ${scan.reasons.join(",")}`,
      tenant_id,
    });
    return { skip: "blocked_outbound_scan", reasons: scan.reasons };
  }

  const markers = scanInternalMarkers(body);
  if (markers.stripped.length > 0) {
    await logEvent({
      level: "warn",
      source: "email-triage-reply",
      code: "email.reply.internal_markers_stripped",
      message: `stripped internal markers from outbound reply (run ${run_id}): ${markers.stripped.join(",")}`,
      tenant_id,
    });
  }
  if (markers.empty) {
    await logEvent({
      level: "error",
      source: "email-triage-reply",
      code: "email.reply.internal_only_output",
      message: `run ${run_id} produced no customer-facing answer (only internal markers) — nothing sent`,
      tenant_id,
    });
    return { skip: "internal_only_output", run_id };
  }
  body = markers.clean;

  let from_override: string | undefined;
  let from_name_override: string | undefined;
  let reply_to: string | undefined;
  if (er.identity_id) {
    const { data: ident } = await svc
      .from("tenant_agent_email_identity")
      .select("from_address, from_name, reply_to_address")
      .eq("id", er.identity_id)
      .maybeSingle<{ from_address: string | null; from_name: string | null; reply_to_address: string }>();
    if (ident) {
      from_override = ident.from_address ?? undefined;
      from_name_override = ident.from_name ?? undefined;
      reply_to = ident.reply_to_address;
    }
  }

  const subject = inbound.subject
    ? /^re:/i.test(inbound.subject)
      ? inbound.subject
      : `Re: ${inbound.subject}`
    : "Re:";
  const { inReplyTo, references } = replyThreadingIds(inbound);

  const selfAddresses = new Set(
    [reply_to, from_override, er.envelope_to]
      .map((a) => String(a ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const threadOthers = [...(inbound.to_addresses ?? []), ...(inbound.cc_addresses ?? [])]
    .map((a) => String(a ?? "").trim().toLowerCase())
    .filter((a) => a && !selfAddresses.has(a) && a !== reply_to_sender.trim().toLowerCase());

  const ccAudience = threadOthers.filter(mayReceive);

  const withheld = threadOthers.filter((a) => !mayReceive(a));
  if (withheld.length > 0) {
    await logEvent({
      level: "warn",
      source: "email-triage-reply",
      code: "email.reply.non_member_recipients_withheld",
      message: `withheld ${withheld.length} recipient(s) from the reply audience — neither members nor allowlisted (run ${run_id})`,
      tenant_id,
    });
  }

  {
    const pc = await import("@/services/channels/pending-card-links");
    const recipients = [reply_to_sender, ...ccAudience].map((a) => a.trim().toLowerCase());
    const linked = pc.replyWithCardLinks({
      body,
      allMembers: pc.allRecipientsAreMembers(recipients, members, disabledMembers),
      cards: await pc.loadRunPendingCards(tenant_id, run_id),
      tenant_id,
      max: MAX_BODY,
      scan: (t) => scanOutboundEmail(t).blocked,
    });
    if (linked.dropped) {
      await logEvent({
        level: "warn",
        source: "email-triage-reply",
        code: "email.reply.card_links_dropped",
        message: `card links left out of reply (run ${run_id}): ${linked.dropped}`,
        tenant_id,
      });
    }
    body = linked.body;
  }

  const outMessageId = runReplyMessageId(run_id, reply_to ?? er.envelope_to ?? "");
  const outDedupKey = `out:${run_id}`;
  const threadEmbed = Array.isArray(inbound.email_threads) ? inbound.email_threads[0] : inbound.email_threads;
  const { error: outIngestErr } = await svc.rpc("ingest_email_message", {
    p_tenant_id: tenant_id,
    p_owner_agent_slug: run.agent_slug ?? "operator",
    p_owner_identity_id: er.identity_id ?? null,
    p_root_message_id:
      threadEmbed?.root_message_id ??
      inbound.references_chain?.[0] ??
      inbound.rfc_message_id ??
      inbound.dedup_key,
    p_subject_normalized: subject.replace(/^\s*re:\s*/i, "").trim().toLowerCase(),
    p_direction: "out",
    p_dedup_key: outDedupKey,
    p_envelope_to: reply_to_sender,
    p_from_address: from_override ?? reply_to ?? null,
    p_to_addresses: [reply_to_sender],
    p_cc_addresses: ccAudience,
    p_rfc_message_id: canonicalMessageId(outMessageId),
    p_in_reply_to: inbound.rfc_message_id ?? null,
    p_references_chain: references.map(canonicalMessageId),
    p_subject: subject,
    p_body_text: body,
    p_body_html_sanitized: null,
    p_raw_mime_ref: null,
    p_spam_verdict: "pass",
    p_auto_submitted: false,
    p_headers: {},
  });
  if (outIngestErr) {
    await logEvent({
      level: "error",
      source: "email-triage-reply",
      code: "email.reply.outbound_ingest_failed",
      message: `reply for run ${run_id} not recorded (${outIngestErr.message}); a reply to it may split the thread`,
      tenant_id,
    });
  }
  const forgetOutbound = async () => {
    if (outIngestErr) return;
    const { error } = await svc.from("email_messages").delete().eq("tenant_id", tenant_id).eq("dedup_key", outDedupKey);
    if (error) {
      await logEvent({
        level: "warn",
        source: "email-triage-reply",
        code: "email.reply.outbound_forget_failed",
        message: `unsent reply row for run ${run_id} not removed (${error.message})`,
        tenant_id,
      });
    }
  };

  let sendResult: AgentMailSendResult;
  try {
    sendResult = await sendAgentMailReply({
      tenant_id,
      to: reply_to_sender,
      cc: ccAudience,
      subject,
      body_text: body,
      reply_to: reply_to ?? er.envelope_to ?? "",
      from_name: from_name_override,
      in_reply_to: inReplyTo,
      references,
      message_id: outMessageId,
    });
  } catch (e) {
    await forgetOutbound();
    await svc
      .from("email_triage_claims")
      .update({ replied_at: null })
      .eq("tenant_id", tenant_id)
      .eq("dedup_key", inbound.dedup_key);
    await logEvent({
      level: "error",
      source: "email-triage-reply",
      code: "email.reply.send_failed",
      message: `AgentMail reply send FAILED for run ${run_id}: ${(e as Error).message}`,
      tenant_id,
    });
    return { skip: "send_failed", error: (e as Error).message, run_id };
  }

  if (!sendResult.sent) {
    await forgetOutbound();
    await logEvent({
      level: "warn",
      source: "email-triage-reply",
      code: "email.reply.not_sent",
      message: `AgentMail reply NOT sent for run ${run_id}: ${sendResult.reason}`,
      tenant_id,
    });
    return { skip: sendResult.reason, run_id };
  }

  if (run.agent_slug && run.agent_slug !== "operator") {
    await mirrorEmailReplyToChat({
      tenant_id,
      agent_slug: run.agent_slug,
      run_id,
      run_payload: run.payload,
      sender_email: reply_to_sender,
      answer: body,
    });
  }

  return { sent: true, run_id, thread_id: inbound.thread_id };
}

function headerIds(headers: Record<string, string | string[]> | null | undefined, name: string): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() !== name) continue;
    for (const raw of Array.isArray(v) ? v : [v]) out.push(...(String(raw ?? "").match(/<[^<>\s]+>/g) ?? []));
  }
  return out;
}

export function runReplyMessageId(runId: string, address: string): string {
  const domain = address.split("@")[1] || "inbox.zaviagent.com";
  return `<zavi-reply-${runId}@${domain}>`;
}

export function replyThreadingIds(inbound: {
  rfc_message_id: string | null;
  references_chain: string[] | null;
  headers: Record<string, string | string[]> | null;
}): { inReplyTo: string | undefined; references: string[] } {
  const raw = new Map<string, string>();
  for (const id of [...headerIds(inbound.headers, "references"), ...headerIds(inbound.headers, "message-id")]) {
    const key = canonicalMessageId(id);
    if (key && !raw.has(key)) raw.set(key, id);
  }
  const original = (id: string) => raw.get(canonicalMessageId(id)) ?? id;
  const references = (inbound.references_chain ?? []).filter(Boolean).map(original);
  const inReplyTo = inbound.rfc_message_id ? original(inbound.rfc_message_id) : undefined;
  if (inReplyTo) references.push(inReplyTo);
  return { inReplyTo, references };
}

export const emailTriageReplyFn = inngest.createFunction(
  { id: "email-triage-reply", retries: 1, concurrency: 4 },
  { event: "agent.run.completed" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id;
    const res = await step.run("reply", () => replyOne(run_id));
    logger.info(`email-triage-reply ${run_id}: ${JSON.stringify(res)}`);
    return res;
  },
);
