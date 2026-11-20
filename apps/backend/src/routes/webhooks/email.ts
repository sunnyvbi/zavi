
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { serviceClient } from "@/services/supabase";
import { inngest } from "@/../workers/client";
import { sanitizeFetchedContent } from "@/services/onboarding/enrichment/sanitize";
import { verifyFromAuthenticity } from "@/email/sender-auth";
import { parseAddrSpec } from "@/email/addr-spec";
import { matchesAllowlist, type AllowlistEntry } from "@/email/allowlist";
import { storeInboundAttachments } from "@/email/attachment-intake";
import { asTenantId } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";

const TIMESTAMP_TOLERANCE_SECONDS = 60 * 5;

type InboundEnvelope = {
  envelope_to: string;
  from: string;
  envelope_from?: string;
  auth_results?: string | null;
  to?: string[];
  cc?: string[];
  subject?: string;
  message_id?: string;
  in_reply_to?: string;
  references?: string[];
  text?: string;
  html?: string;
  headers?: Record<string, string | string[]>;
  raw_mime_ref?: string;
  body_hash?: string;
  spam_verdict?: "pass" | "spam" | "virus" | "unknown";
  attachments?: unknown;
  skipped_attachments?: number;
};

export function verifyEmailSignature(
  secret: string,
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean {
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() / 1000 - tsNum) > TIMESTAMP_TOLERANCE_SECONDS) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function normalizeMessageId(mid: string | undefined): string {
  return (mid ?? "").trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

export async function resolveKnownThreadRoot(
  svc: Pick<ReturnType<typeof serviceClient>, "from">,
  tenantId: string,
  ids: Array<string | undefined>,
): Promise<string | null> {
  const all = [...new Set(ids.map(normalizeMessageId).filter(Boolean))];
  const wanted = all.length > 50 ? [...all.slice(0, 25), ...all.slice(-25)] : all;
  if (wanted.length === 0) return null;
  let data: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await svc
      .from("email_messages")
      .select("rfc_message_id, email_threads(root_message_id)")
      .eq("tenant_id", tenantId)
      .in("rfc_message_id", wanted)
      .limit(100);
    if (!res.error) {
      data = res.data;
      break;
    }
  }
  if (!Array.isArray(data)) return null;
  const rootById = new Map<string, string>();
  for (const row of data as Array<{
    rfc_message_id: string | null;
    email_threads: { root_message_id: string | null } | Array<{ root_message_id: string | null }> | null;
  }>) {
    const t = Array.isArray(row.email_threads) ? row.email_threads[0] : row.email_threads;
    if (row.rfc_message_id && t?.root_message_id && !rootById.has(row.rfc_message_id)) {
      rootById.set(row.rfc_message_id, t.root_message_id);
    }
  }
  for (const id of wanted) {
    const root = rootById.get(id);
    if (root) return root;
  }
  return null;
}

const MAX_PARTICIPANTS = 50;
export function normalizeAddresses(list: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const addr = String(raw ?? "").trim().toLowerCase();
    if (!addr || /[\s,;<>"]/.test(addr)) continue;
    if ((addr.match(/@/g) ?? []).length !== 1) continue;
    seen.add(addr);
    if (seen.size >= MAX_PARTICIPANTS) break;
  }
  return [...seen];
}

export function computeDedupKey(
  tenantId: string,
  envelopeTo: string,
  messageId: string | undefined,
  bodyHash: string | undefined,
): string {
  const material = [
    tenantId,
    envelopeTo.trim().toLowerCase(),
    normalizeMessageId(messageId),
    (bodyHash ?? "").trim().toLowerCase(),
  ].join("|");
  return crypto.createHash("sha256").update(material).digest("hex");
}

function headerValues(
  headers: Record<string, string | string[]> | undefined,
  name: string,
): string[] {
  if (!headers) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    if (Array.isArray(v)) out.push(...v.map((x) => String(x ?? "")));
    else out.push(String(v ?? ""));
  }
  return out;
}

export function isAutoSubmitted(headers: Record<string, string | string[]> | undefined): boolean {
  if (!headers) return false;

  const anyValue = (name: string, pred: (v: string) => boolean): boolean =>
    headerValues(headers, name).some((v) => pred(v.trim().toLowerCase()));

  if (anyValue("auto-submitted", (v) => v !== "" && v !== "no")) return true;
  if (anyValue("precedence", (v) => ["bulk", "list", "junk", "auto_reply"].includes(v))) return true;
  if (headerValues(headers, "x-auto-response-suppress").some((v) => v.trim() !== "")) return true;
  if (headerValues(headers, "list-id").some((v) => v.trim() !== "")) return true;
  if (headerValues(headers, "list-unsubscribe").some((v) => v.trim() !== "")) return true;
  if (anyValue("return-path", (v) => v.replace(/\s/g, "") === "<>")) return true;
  return false;
}

export async function emailWebhook(req: Request, res: Response): Promise<void> {
  const secret = process.env.EMAIL_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: { code: "no_webhook_secret", message: "EMAIL_WEBHOOK_SECRET unset" } });
    return;
  }

  const timestamp = String(req.header("x-praxis-email-timestamp") ?? "");
  const signature = String(req.header("x-praxis-email-signature") ?? "");
  const rawBuf = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
  const rawBody = rawBuf.toString("utf8");

  if (!verifyEmailSignature(secret, rawBody, timestamp, signature)) {
    res.status(401).json({ error: { code: "bad_signature", message: "email webhook signature invalid" } });
    return;
  }

  let env: InboundEnvelope;
  try {
    env = JSON.parse(rawBody) as InboundEnvelope;
  } catch {
    res.status(400).json({ error: { code: "bad_json", message: "invalid json" } });
    return;
  }

  const envelopeTo = String(env.envelope_to ?? "").trim();
  if (!envelopeTo || !String(env.from ?? "").trim()) {
    res.status(200).json({ ok: true, ignored: "missing envelope_to or from" });
    return;
  }

  const fromAddr = parseAddrSpec(env.from);
  if (!fromAddr) {
    res.status(200).json({ ok: true, ignored: "unparseable_from" });
    return;
  }
  const from = fromAddr.address;

  const svc = serviceClient();

  const { data: resolved, error: resolveErr } = await svc.rpc("resolve_email_recipient", {
    p_envelope_to: envelopeTo,
  });
  if (resolveErr) {
    res.status(200).json({ ok: true, error: resolveErr.message });
    return;
  }
  const recipient = Array.isArray(resolved) ? resolved[0] : resolved;
  if (!recipient?.tenant_id) {
    res.status(200).json({ ok: true, ignored: `no active identity for ${envelopeTo}` });
    return;
  }
  const tenant_id = recipient.tenant_id as string;
  const owner_agent_slug = recipient.agent_slug as string;
  const owner_identity_id = (recipient.identity_id as string) ?? null;

  const { data: isOwn } = await svc.rpc("is_own_inbox_address", { p_address: from });
  if (isOwn === true) {
    res.status(200).json({ ok: true, ignored: "own-identity sender (loop guard)" });
    return;
  }

  const auth = verifyFromAuthenticity(from, env.auth_results);
  if (!auth.authentic) {
    await logEvent({
      level: "warn",
      source: "email-webhook",
      code: "email.sender.unauthenticated",
      message: `inbound email REJECTED — From could not be authenticated (${auth.reason})`,
      tenant_id,
    });
    res.status(200).json({ ok: true, ignored: "sender_unauthenticated" });
    return;
  }

  const envelopeFrom = String(env.envelope_from ?? "").trim().toLowerCase();
  if (envelopeFrom && envelopeFrom !== from.toLowerCase()) {
    await logEvent({
      level: "info",
      source: "email-webhook",
      code: "email.sender.envelope_header_mismatch",
      message: `envelope MAIL FROM (${envelopeFrom}) != authenticated From (${from}); authorized the From`,
      tenant_id,
    });
  }

  const { data: disabledRows, error: disabledErr } = await svc.rpc("disabled_member_emails", {
    p_tenant_id: tenant_id,
  });
  if (disabledErr) {
    await logEvent({
      level: "error",
      source: "email-webhook",
      code: "email.member_disabled.read_failed",
      message: `could not read disabled members, refusing sender: ${disabledErr.message}`,
      tenant_id,
    });
    res.status(200).json({ ok: true, ignored: "member_state_unavailable" });
    return;
  }
  const disabled = new Set(
    (Array.isArray(disabledRows) ? disabledRows : [])
      .map((m: unknown) => String(m ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (disabled.has(from)) {
    await logEvent({
      level: "warn",
      source: "email-webhook",
      code: "email.sender.member_disabled",
      message: `inbound email REJECTED — this member's email access is turned off (auth: ${auth.reason})`,
      tenant_id,
    });
    res.status(200).json({ ok: true, ignored: "sender_disabled" });
    return;
  }

  const { data: isMember } = await svc.rpc("is_tenant_member_email", {
    p_tenant_id: tenant_id,
    p_email: from,
  });

  let allowedBy: "member" | "allowlist" | null = isMember === true ? "member" : null;
  if (!allowedBy) {
    const { data: entryRows, error: entryErr } = await svc.rpc("email_allowlist_entries", {
      p_tenant_id: tenant_id,
    });
    if (entryErr) {
      await logEvent({
        level: "error",
        source: "email-webhook",
        code: "email.allowlist.read_failed",
        message: `could not read allowlist, refusing non-member sender: ${entryErr.message}`,
        tenant_id,
      });
      res.status(200).json({ ok: true, ignored: "allowlist_unavailable" });
      return;
    }
    const entries = (Array.isArray(entryRows) ? entryRows : []) as AllowlistEntry[];
    if (matchesAllowlist(from, entries)) allowedBy = "allowlist";

    if (!allowedBy) {
      await logEvent({
        level: "warn",
        source: "email-webhook",
        code: entries.length === 0 ? "email.sender.not_a_member" : "email.sender.not_allowlisted",
        message:
          entries.length === 0
            ? `inbound email REJECTED — authenticated sender is not a member of this tenant (auth: ${auth.reason})`
            : `inbound email REJECTED — authenticated sender is neither a member nor allowlisted (${entries.length} entr${entries.length === 1 ? "y" : "ies"}; auth: ${auth.reason})`,
        tenant_id,
      });
      res.status(200).json({
        ok: true,
        ignored: entries.length === 0 ? "sender_not_a_member" : "sender_not_allowlisted",
      });
      return;
    }
  }

  const dedupKey = computeDedupKey(tenant_id, envelopeTo, env.message_id, env.body_hash);
  const autoSubmitted = isAutoSubmitted(env.headers);
  let refRoot: string | null = null;
  if (!normalizeMessageId(env.references?.[0]) && !normalizeMessageId(env.in_reply_to)) {
    const { refFromSubject, rootPrefixForRef } = await import("@/email/one-tap");
    const ref = refFromSubject(env.subject);
    if (ref) {
      const { data: threads } = await svc
        .from("email_threads")
        .select("root_message_id")
        .eq("tenant_id", tenant_id)
        .like("root_message_id", `${rootPrefixForRef(ref)}%`)
        .limit(2);
      const rows = (threads ?? []) as Array<{ root_message_id: string }>;
      if (rows.length === 1) refRoot = rows[0].root_message_id;
    }
  }
  const knownRoot = await resolveKnownThreadRoot(svc, tenant_id, [
    ...(env.references ?? []),
    env.in_reply_to,
  ]);
  const rootMessageId =
    knownRoot ||
    normalizeMessageId(env.references?.[0]) ||
    normalizeMessageId(env.in_reply_to) ||
    refRoot ||
    normalizeMessageId(env.message_id) ||
    dedupKey;

  const bodyHtmlSanitized = env.html ? sanitizeFetchedContent(env.html) : null;
  const subjectNormalized = String(env.subject ?? "")
    .replace(/^\s*(re|fwd?):\s*/i, "")
    .trim()
    .toLowerCase();

  const { data: ingestRows, error: ingestErr } = await svc.rpc("ingest_email_message", {
    p_tenant_id: tenant_id,
    p_owner_agent_slug: owner_agent_slug,
    p_owner_identity_id: owner_identity_id,
    p_root_message_id: rootMessageId,
    p_subject_normalized: subjectNormalized,
    p_direction: "in",
    p_dedup_key: dedupKey,
    p_envelope_to: envelopeTo,
    p_from_address: from,
    p_to_addresses: normalizeAddresses(env.to),
    p_cc_addresses: normalizeAddresses(env.cc),
    p_rfc_message_id: normalizeMessageId(env.message_id) || null,
    p_in_reply_to: normalizeMessageId(env.in_reply_to) || null,
    p_references_chain: (env.references ?? []).map(normalizeMessageId),
    p_subject: env.subject ?? null,
    p_body_text: env.text ?? null,
    p_body_html_sanitized: bodyHtmlSanitized,
    p_raw_mime_ref: env.raw_mime_ref ?? null,
    p_spam_verdict: env.spam_verdict ?? "unknown",
    p_auto_submitted: autoSubmitted,
    p_headers: env.headers ?? {},
  });
  if (ingestErr) {
    res.status(200).json({ ok: true, error: ingestErr.message });
    return;
  }
  const ingest = Array.isArray(ingestRows) ? ingestRows[0] : ingestRows;
  const emailMessageId = ingest?.message_id as string | undefined;
  const deduped = ingest?.deduped as boolean | undefined;

  if (deduped || !emailMessageId) {
    res.status(200).json({ ok: true, deduped: true });
    return;
  }

  const rfcMessageId = normalizeMessageId(env.message_id);
  let replayCheckOk = true;
  if (rfcMessageId) {
    const { data: earliest, error: earlierErr } = await svc
      .from("email_messages")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("direction", "in")
      .eq("rfc_message_id", rfcMessageId)
      .order("received_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1);
    const earlier = (Array.isArray(earliest) ? earliest : []).filter(
      (r: { id?: unknown }) => r?.id !== emailMessageId,
    );
    if (earlierErr) {
      replayCheckOk = false;
      await logEvent({
        level: "warn",
        source: "email-webhook",
        code: "email.replay_check.read_failed",
        message: `could not check for an earlier copy of this Message-ID; not marking the sender trusted: ${earlierErr.message}`,
        tenant_id,
      });
    } else if (Array.isArray(earlier) && earlier.length > 0) {
      await logEvent({
        level: "warn",
        source: "email-webhook",
        code: "email.replay.parked",
        message: "inbound email PARKED — a message with this Message-ID was already received for this tenant",
        tenant_id,
      });
      res.status(200).json({ ok: true, parked: "duplicate_message_id" });
      return;
    }
  }

  if (allowedBy === "member" && replayCheckOk) {
    const { error: stampErr } = await svc
      .from("email_messages")
      .update({ sender_verified_member: true })
      .eq("tenant_id", tenant_id)
      .eq("id", emailMessageId);
    if (stampErr) {
      await logEvent({
        level: "warn",
        source: "email-webhook",
        code: "email.sender_verified_member.stamp_failed",
        message: `could not mark sender as a verified member: ${stampErr.message}`,
        tenant_id,
      });
    }
  }

  if (autoSubmitted) {
    res.status(200).json({ ok: true, parked: "auto_submitted" });
    return;
  }

  try {
    const stored = await storeInboundAttachments(asTenantId(tenant_id), env.attachments, {
      tenantIdForLog: tenant_id,
    });
    if (stored.length > 0) {
      await svc
        .from("email_messages")
        .update({ attachments: stored })
        .eq("id", emailMessageId)
        .eq("tenant_id", tenant_id);
    }
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "email-webhook",
      code: "email.attachments.store_failed",
      message: `inbound attachment storage failed: ${(e as Error).message}`,
      tenant_id,
    });
  }

  const emailTraceId = `eml_${emailMessageId.slice(0, 8)}`;
  await inngest.send({
    id: `email-msg:${emailMessageId}`,
    name: "webhook.email.ingested",
    data: {
      email_message_id: emailMessageId,
      tenant_id,
      email_trace_id: emailTraceId,
    },
  });

  res.status(200).json({ ok: true });
}
