import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";

export const FOUNDER_MESSAGE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const EMAIL_HEADERISH: RegExp[] = [
  /^\s*[\p{L}\p{M}][\p{L}\p{M} .'-]{0,30}\s*[:：]\s*\S/mu,
  /[:：]\s*$/mu,
  /^\s*-{2,}.*-{2,}\s*$/mu,
  /^\s*>/mu,
];

export type FounderMessageKind = "chat" | "slack" | "email";

export type FounderMessageRef = {
  kind: FounderMessageKind;
  id: string;
  author_user_id: string | null;
  run_id: string;
};

export type FounderRunRow = {
  id?: string;
  tenant_id?: string;
  trigger: string | null;
  enqueued_by: string | null;
  payload: unknown;
  agent_slug?: string;
  enqueued_at?: string | null;
};

export type FounderMessage = {
  ref: FounderMessageRef;
  text: string;
  author_user_id: string | null;
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function parseFounderMessageRef(v: unknown): FounderMessageRef | null {
  const r = obj(v);
  const kind = r.kind;
  if (kind !== "chat" && kind !== "slack" && kind !== "email") return null;
  const id = str(r.id);
  const run_id = str(r.run_id);
  if (!id || !run_id || id.length > 150) return null;
  if (r.author_user_id !== null && typeof r.author_user_id !== "string") return null;
  return { kind, id, author_user_id: typeof r.author_user_id === "string" ? r.author_user_id : null, run_id };
}

function isChildPayload(p: Record<string, unknown>): boolean {
  return p._delegation_lineage_id !== undefined || p.handoff_child === true || p.slack_handoff_child === true || p.founder_message_ref !== undefined;
}

export function rootMessageRef(run: FounderRunRow): FounderMessageRef | null {
  const id = str(run.id);
  const p = obj(run.payload);
  if (!id || isChildPayload(p)) return null;
  if (run.trigger === "chat") {
    const msg = str(p.user_message_id);
    const by = str(run.enqueued_by);
    return msg && by ? { kind: "chat", id: msg, author_user_id: by, run_id: id } : null;
  }
  if (run.trigger === "slack") {
    if (str(run.enqueued_by)) return null;
    const s = obj(p.slack);
    const ev = str(s.event_id);
    const user = str(s.user);
    return ev && user ? { kind: "slack", id: ev, author_user_id: user, run_id: id } : null;
  }
  if (run.trigger === "email") {
    const msg = str(obj(p.email).email_message_id);
    return msg ? { kind: "email", id: msg, author_user_id: null, run_id: id } : null;
  }
  return null;
}

const sameRef = (a: FounderMessageRef, b: FounderMessageRef) => a.kind === b.kind && a.id === b.id && a.author_user_id === b.author_user_id && a.run_id === b.run_id;

function readFailed(strict: boolean | undefined, what: string, message: string): null {
  if (strict) throw new Error(`founder message: ${what} read failed: ${message}`);
  return null;
}

async function readRun(tenant_id: string, run_id: string, strict?: boolean): Promise<FounderRunRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("id, trigger, enqueued_by, payload, agent_slug, enqueued_at")
    .eq("id", run_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) return readFailed(strict, "run", error.message);
  if (!data) return null;
  return { ...(data as FounderRunRow), tenant_id };
}

export async function founderMessageRefForChild(
  tenant_id: string,
  parent_run_id: string | null | undefined,
  opts: { strict?: boolean } = {},
): Promise<FounderMessageRef | null> {
  if (!parent_run_id) return null;
  try {
    const parent = await readRun(tenant_id, parent_run_id, opts.strict);
    if (!parent) return null;
    const p = obj(parent.payload);
    if (opts.strict && p[FOUNDER_REF_UNREADABLE] === true) throw new Error("founder message ref: parent's ref was unreadable");
    return parseFounderMessageRef(p.founder_message_ref) ?? rootMessageRef(parent);
  } catch (e) {
    if (opts.strict) throw e;
    return null;
  }
}

export const FOUNDER_REF_UNREADABLE = "founder_message_ref_unreadable";

const fresh = (at: unknown, now: number) => {
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  if (!Number.isFinite(now)) return Number.isFinite(t);
  return Number.isFinite(t) && now - t <= FOUNDER_MESSAGE_MAX_AGE_MS && t <= now + 60_000;
};

export async function founderMessageOf(run: FounderRunRow, opts: { now?: number; strict?: boolean; anyAge?: boolean } = {}): Promise<FounderMessage | null> {
  const tenant_id = run.tenant_id;
  if (!tenant_id) return null;
  const ref = rootMessageRef(run) ?? parseFounderMessageRef(obj(run.payload).founder_message_ref);
  if (!ref) return null;
  const now = opts.anyAge === true ? Number.POSITIVE_INFINITY : (opts.now ?? Date.now());
  const strict = opts.strict === true;
  try {
    const root = await readRun(tenant_id, ref.run_id, strict);
    if (!root && strict) throw new Error("founder message: the root run was not found");
    const own = root ? rootMessageRef(root) : null;
    if ((!root || !own || !sameRef(own, ref)) && strict) throw new Error("founder message: the root does not match its ref");
    if (!root || !own || !sameRef(own, ref)) return null;
    if (ref.kind === "chat") return await chatMessage(tenant_id, root, ref, now, strict);
    if (ref.kind === "slack") return await slackMessage(tenant_id, root, ref, now, strict);
    return await emailMessage(tenant_id, root, ref, now, strict);
  } catch (e) {
    if (strict) throw e;
    return null;
  }
}

async function chatMessage(tenant_id: string, root: FounderRunRow, ref: FounderMessageRef, now: number, strict?: boolean): Promise<FounderMessage | null> {
  const { isUntrustedContextPayload, carriesCapturedPageContext } = await import("@/services/agents/untrusted-context");
  if (isUntrustedContextPayload(root.payload) || carriesCapturedPageContext(root.payload)) return null;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_thread_messages")
    .select("id, body, sender_role, agent_run_id, created_at")
    .eq("id", ref.id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) return readFailed(strict, "chat message", error.message);
  if (!data && strict) throw new Error("founder message: the chat message was not found");
  const m = data as { id?: string; body?: unknown; sender_role?: string; agent_run_id?: string; created_at?: string } | null;
  if (!m || m.id !== ref.id || m.sender_role !== "user" || m.agent_run_id !== ref.run_id) return null;
  if (!fresh(m.created_at, now)) return null;
  const text = str(m.body)?.trim();
  if (!text || root.enqueued_by !== ref.author_user_id) return null;
  return { ref, text, author_user_id: root.enqueued_by };
}

async function slackMessage(tenant_id: string, root: FounderRunRow, ref: FounderMessageRef, now: number, strict?: boolean): Promise<FounderMessage | null> {
  if (!fresh(root.enqueued_at, now)) return null;
  const s = obj(obj(root.payload).slack);
  const raw = typeof s.text === "string" ? s.text : null;
  if (raw == null) return null;
  const text = raw.split("\n").filter((l) => !/^\s*(>|&gt;)/.test(l)).join("\n").trim();
  if (!text) return null;
  return { ref, text, author_user_id: await slackApproverOf(tenant_id, s, strict).catch((e) => (strict ? Promise.reject(e) : null)) };
}

async function emailMessage(tenant_id: string, root: FounderRunRow, ref: FounderMessageRef, now: number, strict?: boolean): Promise<FounderMessage | null> {
  const msg = await readEmailMessage(tenant_id, ref.id, strict);
  if (!msg && strict) throw new Error("founder message: the email message was not found");
  if (!msg || !fresh(msg.received_at ?? msg.created_at, now)) return null;
  const { splitReplyText } = await import("@/email/quoted-reply");
  const split = splitReplyText(msg.body_text ?? "");
  const text = split.forwarded ? "" : split.own.trim();
  if (!text || EMAIL_HEADERISH.some((re) => re.test(text))) return null;
  return { ref, text, author_user_id: await emailSenderOf(tenant_id, root, msg, strict).catch((e) => (strict ? Promise.reject(e) : null)) };
}

export async function slackApproverOf(tenant_id: string, slack: Record<string, unknown>, strict?: boolean): Promise<string | null> {
  const team = typeof slack.team_id === "string" ? slack.team_id.trim() : "";
  const user = typeof slack.user === "string" ? slack.user.trim() : "";
  if (!team || !user) return null;
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "resolve_slack_approver", { p_team_id: team, p_slack_user_id: user });
  if (error) return readFailed(strict, "slack approver", error.message);
  return typeof data === "string" && data ? data : null;
}

type EmailRow = { from_address: string | null; body_text: string | null; received_at: string | null; created_at: string | null };

async function readEmailMessage(tenant_id: string, id: string, strict?: boolean): Promise<EmailRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("email_messages").select("from_address, body_text, received_at, created_at").eq("id", id).eq("tenant_id", tenant_id).maybeSingle();
  if (error) return readFailed(strict, "email message", error.message);
  return (data as EmailRow | null) ?? null;
}

async function emailSenderOf(tenant_id: string, root: FounderRunRow, msg: { from_address: string | null }, strict?: boolean): Promise<string | null> {
  if (!root.agent_slug) return null;
  const { isVerifiedMemberReplyRun } = await import("@/services/agents/email-reply-trust");
  if (!(await isVerifiedMemberReplyRun({ tenant_id, agent_slug: root.agent_slug, trigger: "email", payload: root.payload }))) return null;
  const { parseAddrSpec } = await import("@/email/addr-spec");
  const from = parseAddrSpec(msg.from_address ?? "")?.address;
  if (!from) return null;
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "member_user_id_by_email", { p_email: from });
  if (error) return readFailed(strict, "email sender", error.message);
  return typeof data === "string" && data ? data : null;
}
