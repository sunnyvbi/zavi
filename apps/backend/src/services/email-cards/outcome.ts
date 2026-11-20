
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { cardSubject, parseEmailSendBody } from "@/services/connectors/email-campaign/execute-send";
import { EMAIL_TOOL_LABEL, type EmailTool } from "@/services/connectors/email-campaign/providers";
import { emailCardLink, type EmailCardRail } from "./cards";
import { emailSendOutcomeLine, renderEmailSendOutcomeEmail } from "@/email/templates/email-send-outcome";

export type SendOutcome = {
  tenant_id: string;
  rail: EmailCardRail;
  card_id: string;
  outcome: EmailSendOutcomeKind;
  sent: number | null;
  total?: number | null;
  reason?: string | null;
  kind?: "audience_mismatch";
};

export type EmailSendOutcomeKind = "sent" | "failed" | "unknown";

export const AUTOPILOT_APPROVAL_SOURCES: ReadonlySet<string> = new Set(["cgo", "plan_autopilot"]);

type CardRow = { body: Record<string, unknown>; approved_by: string | null; approved_by_source: string | null };

export type OutcomeDeps = {
  readCard: (tenantId: string, rail: EmailCardRail, id: string) => Promise<CardRow | null>;
  claim: (tenantId: string, rail: EmailCardRail, id: string, outcome: EmailSendOutcomeKind, line: string, kind?: SendOutcome["kind"]) => Promise<boolean | "reclaimed">;
  keep: (tenantId: string, rail: EmailCardRail, id: string, outcome: EmailSendOutcomeKind, line: string, kind?: SendOutcome["kind"]) => Promise<boolean>;
  release: (tenantId: string, rail: EmailCardRail, id: string, outcome: EmailSendOutcomeKind, kind?: SendOutcome["kind"]) => Promise<void>;
  emailOf: (userId: string) => Promise<string | null>;
  ownerEmail: (tenantId: string) => Promise<string | null>;
  send: (to: string, subject: string, html: string, text: string) => Promise<void>;
  startResults?: (o: SendOutcome) => Promise<unknown>;
};

async function liveReadCard(tenantId: string, rail: EmailCardRail, id: string): Promise<CardRow | null> {
  const db = tenantClient(asTenantId(tenantId));
  if (rail === "channel_actions") {
    const { data } = await db.from("channel_actions").select("exec_payload, approved_by, approved_by_source").eq("id", id).maybeSingle();
    const r = data as { exec_payload?: Record<string, unknown>; approved_by?: string | null; approved_by_source?: string | null } | null;
    return r ? { body: r.exec_payload ?? {}, approved_by: r.approved_by ?? null, approved_by_source: r.approved_by_source ?? null } : null;
  }
  const { data } = await db.from("decisions").select("body, approved_by, approved_by_source").eq("id", id).maybeSingle();
  const r = data as { body?: Record<string, unknown>; approved_by?: string | null; approved_by_source?: string | null } | null;
  return r ? { body: r.body ?? {}, approved_by: r.approved_by ?? null, approved_by_source: r.approved_by_source ?? null } : null;
}

const LIVE: OutcomeDeps = {
  readCard: liveReadCard,
  claim: async (tenantId, rail, id, outcome, line, kind) => {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "claim_email_send_outcome_tell", {
      p_rail: rail,
      p_card_id: id,
      p_outcome: outcome,
      p_line: line,
      p_kind: kind ?? "",
    });
    if (error) throw new Error("claim_email_send_outcome_tell failed");
    return data === "claimed" ? true : data === "reclaimed" ? "reclaimed" : false;
  },
  keep: async (tenantId, rail, id, outcome, line, kind) => {
    const { data, error } = await tenantRpc(asTenantId(tenantId), "keep_email_send_outcome_line", {
      p_rail: rail,
      p_card_id: id,
      p_outcome: outcome,
      p_line: line,
      p_kind: kind ?? "",
    });
    if (error) throw new Error("keep_email_send_outcome_line failed");
    return data === true;
  },
  release: async (tenantId, rail, id, outcome, kind) => {
    const { error } = await tenantRpc(asTenantId(tenantId), "release_email_send_outcome", {
      p_rail: rail,
      p_card_id: id,
      p_outcome: outcome,
      p_kind: kind ?? "",
    });
    if (error) throw new Error("release_email_send_outcome failed");
  },
  emailOf: async (userId) => (await import("@/email/sendAuthEmail")).resolveMemberEmail(userId),
  ownerEmail: async (tenantId) => (await import("@/email/sendAuthEmail")).resolveTenantOwnerEmail(tenantId),
  send: async (to, subject, html, text) => (await import("@/email/sendAuthEmail")).sgSend(to, subject, html, text),
  startResults: async (o) =>
    (await import("@/services/email-results/start")).startEmailSendResult({ tenant_id: o.tenant_id, rail: o.rail, card_id: o.card_id, sent: o.sent, total: o.total ?? null }),
};

function describe(body: Record<string, unknown>): { subject: string; listName: string } | null {
  if (!Array.isArray(body.variants)) return null;
  const parsed = parseEmailSendBody(body);
  if (parsed) return { subject: cardSubject(parsed), listName: parsed.audience_name };
  const variants = body.variants as Array<{ content?: { subject?: unknown } }>;
  const n = typeof body.chosen_variant === "number" ? body.chosen_variant : 1;
  const subject = variants[n - 1]?.content?.subject;
  return typeof subject === "string" && typeof body.list_name === "string" ? { subject, listName: body.list_name } : null;
}

export type EmailSendOutcomeTell = "told" | "skipped" | "retry";

export class EmailSendOutcomeRetry extends Error {
  constructor(o: SendOutcome) {
    super(`email send outcome not told yet for ${o.rail}/${o.card_id} (${o.outcome}), retry`);
    this.name = "EmailSendOutcomeRetry";
  }
}

type Prepared = { card: CardRow; args: Parameters<typeof renderEmailSendOutcomeEmail>[0] };

async function prepare(o: SendOutcome, deps: OutcomeDeps): Promise<Prepared | null> {
  const card = await deps.readCard(o.tenant_id, o.rail, o.card_id);
  const d = card ? describe(card.body) : null;
  if (!card || !d) return null;
  return {
    card,
    args: {
      outcome: o.outcome,
      subject: d.subject,
      listName: d.listName,
      sent: o.sent,
      total: o.total ?? null,
      reason: o.reason ?? null,
      cardUrl: emailCardLink(o.rail, o.card_id, o.tenant_id),
      byAutopilot: AUTOPILOT_APPROVAL_SOURCES.has(card.approved_by_source ?? ""),
      ...(EMAIL_TOOL_LABEL[card.body.tool as EmailTool] ? { acceptedBy: EMAIL_TOOL_LABEL[card.body.tool as EmailTool] } : {}),
      ...(o.kind ? { kind: o.kind } : {}),
    },
  };
}

async function startResultsFor(o: SendOutcome, deps: OutcomeDeps): Promise<void> {
  if (!deps.startResults || !(o.outcome === "sent" || (o.sent ?? 0) > 0)) return;
  await deps.startResults(o).catch((e) => console.warn(`[email-send-outcome] results not started for ${o.rail}/${o.card_id}: ${(e as Error).message}`));
}

export async function tellEmailSendOutcome(o: SendOutcome, depsIn: Partial<OutcomeDeps> = {}): Promise<EmailSendOutcomeTell> {
  const deps = { ...LIVE, ...depsIn };
  let claimed = false;
  try {
    const p = await prepare(o, deps);
    if (!p) return "skipped";
    const won = await deps.claim(o.tenant_id, o.rail, o.card_id, o.outcome, emailSendOutcomeLine(p.args), o.kind);
    if (!won) return "skipped";
    claimed = true;
    if (won === true) await startResultsFor(o, deps);
    const to = p.args.byAutopilot || !p.card.approved_by ? await deps.ownerEmail(o.tenant_id) : await deps.emailOf(p.card.approved_by);
    if (!to) {
      await deps.release(o.tenant_id, o.rail, o.card_id, o.outcome, o.kind).catch((re) => console.warn(`[email-send-outcome] claim not released for ${o.rail}/${o.card_id}: ${(re as Error).message}`));
      return "skipped";
    }
    const m = renderEmailSendOutcomeEmail(p.args);
    await deps.send(to, m.subject, m.html, m.text);
    return "told";
  } catch (e) {
    console.warn(`[email-send-outcome] not told for ${o.rail}/${o.card_id}: ${(e as Error).message}`);
    if (!claimed) return "retry";
    try {
      await deps.release(o.tenant_id, o.rail, o.card_id, o.outcome, o.kind);
      return "retry";
    } catch (re) {
      console.warn(`[email-send-outcome] claim not released for ${o.rail}/${o.card_id}: ${(re as Error).message}`);
      return "skipped";
    }
  }
}

export async function keepEmailSendOutcomeLine(o: SendOutcome, depsIn: Partial<OutcomeDeps> = {}): Promise<boolean> {
  const deps = { ...LIVE, ...depsIn };
  const p = await prepare(o, deps);
  if (!p) return false;
  const kept = await deps.keep(o.tenant_id, o.rail, o.card_id, o.outcome, emailSendOutcomeLine(p.args), o.kind);
  if (kept) await startResultsFor(o, deps);
  return kept;
}

export async function notifyEmailSendOutcome(o: SendOutcome, depsIn: Partial<OutcomeDeps> = {}): Promise<boolean> {
  return (await tellEmailSendOutcome(o, depsIn)) === "told";
}

export async function notifyEmailSendOutcomeOrThrow(o: SendOutcome, depsIn: Partial<OutcomeDeps> = {}): Promise<boolean> {
  const r = await tellEmailSendOutcome(o, depsIn);
  if (r === "retry") throw new EmailSendOutcomeRetry(o);
  return r === "told";
}

export async function readEmailOutcomesSince(tenantId: string, since: string, limit = 10): Promise<Array<{ outcome: EmailSendOutcomeKind; line: string; card_id: string }>> {
  type Row = { outcome: EmailSendOutcomeKind; line: string; card_id: string; created_at: string };
  const recent = () => tenantClient(asTenantId(tenantId)).from("email_send_outcomes").select("outcome, line, card_id, created_at").gt("created_at", since);
  const [needsYou, sent] = await Promise.all([
    recent().neq("outcome", "sent").order("created_at", { ascending: false }).limit(limit),
    recent().eq("outcome", "sent").order("created_at", { ascending: false }).limit(limit),
  ]);
  const error = needsYou.error ?? sent.error;
  if (error) throw new Error(`email_send_outcomes read failed: ${error.message}`);
  return ([...(needsYou.data ?? []), ...(sent.data ?? [])] as Row[])
    .slice(0, limit)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map(({ outcome, line, card_id }) => ({ outcome, line, card_id }));
}

export const RESUMABLE_HOLDS: ReadonlySet<string> = new Set(["abuse_complaints", "abuse_bounces", "provider_refused", "bulk_check_failed", "email_paused"]);

export function bulkSendOutcome(
  tenant_id: string,
  decision_id: string,
  state: string,
  counts: { sent: number; total: number; hold_reason?: string | null; unknown?: number } | null,
  reason: string | null,
  holdReason: string | null = counts?.hold_reason ?? null,
): SendOutcome | null {
  const unconfirmed = !!counts && counts.sent === 0 && (counts.unknown ?? 0) > 0;
  if (state === "done" && counts && counts.sent > 0) return { tenant_id, rail: "decisions", card_id: decision_id, outcome: "sent", sent: counts.sent, total: counts.total };
  if (state === "done" && counts && unconfirmed) return { tenant_id, rail: "decisions", card_id: decision_id, outcome: "unknown", sent: 0, total: counts.total, reason };
  if (state === "done" && counts) return { tenant_id, rail: "decisions", card_id: decision_id, outcome: "failed", sent: 0, total: counts.total, reason };
  if (state === "held" && holdReason === "email_paused") return null;
  if ((state === "failed" || state === "held" || state === "refused") && counts && unconfirmed) {
    return { tenant_id, rail: "decisions", card_id: decision_id, outcome: "unknown", sent: 0, total: counts.total, reason };
  }
  if (state === "failed" || state === "held" || state === "refused") {
    return { tenant_id, rail: "decisions", card_id: decision_id, outcome: "failed", sent: counts?.sent ?? 0, total: counts?.total ?? null, reason };
  }
  return null;
}
