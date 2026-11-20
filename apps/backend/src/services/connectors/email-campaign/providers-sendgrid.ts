
import type { ComposioExecResult } from "@/services/connectors/composio/api";
import { EmailToolError, isAccountHeld, toolErrorText } from "./provider-errors";
import type { Audience, CampaignPhase, CampaignState, EmailProvider, ProviderCall, SentCampaign, SuppressionCheck } from "./providers";

function nextPageToken(data: unknown): string | null {
  const next = (data as { _metadata?: { next?: unknown } } | null)?._metadata?.next;
  if (next === undefined || next === null || next === "") return null;
  let t: string | null = null;
  try {
    t = typeof next === "string" ? new URL(next).searchParams.get("page_token") : null;
  } catch {
    t = null;
  }
  if (!t || t.length > 512) throw new EmailToolError("SendGrid returned a next page Zavi could not follow.", false);
  return t;
}
import { SENDGRID_API_BASE } from "./sendgrid-scopes";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type SendgridEndpoint = { method: Method; path: string };

export const SENDGRID_ENDPOINTS = {
  SENDGRID_LISTS: { method: "GET", path: "/v3/marketing/lists" },
  SENDGRID_LIST: { method: "GET", path: "/v3/marketing/lists/{id}" },
  SENDGRID_LIST_CONTACT_COUNT: { method: "GET", path: "/v3/marketing/lists/{id}/contacts/count" },
  SENDGRID_VERIFIED_SENDERS: { method: "GET", path: "/v3/verified_senders" },
  SENDGRID_SUPPRESSION_GROUPS: { method: "GET", path: "/v3/asm/groups" },
  SENDGRID_GROUP_SUPPRESSIONS: { method: "GET", path: "/v3/asm/groups/{id}/suppressions" },
  SENDGRID_GLOBAL_UNSUBSCRIBES: { method: "GET", path: "/v3/suppression/unsubscribes" },
  SENDGRID_CONTACTS_BY_EMAIL: { method: "POST", path: "/v3/marketing/contacts/search/emails" },
  SENDGRID_SINGLE_SEND_SEARCH: { method: "POST", path: "/v3/marketing/singlesends/search" },
  SENDGRID_SINGLE_SEND: { method: "GET", path: "/v3/marketing/singlesends/{id}" },
  SENDGRID_SINGLE_SENDS: { method: "GET", path: "/v3/marketing/singlesends" },
  SENDGRID_CREATE_SINGLE_SEND: { method: "POST", path: "/v3/marketing/singlesends" },
  SENDGRID_UPDATE_SINGLE_SEND: { method: "PATCH", path: "/v3/marketing/singlesends/{id}" },
  SENDGRID_SCHEDULE_SINGLE_SEND: { method: "PUT", path: "/v3/marketing/singlesends/{id}/schedule" },
  SENDGRID_SINGLE_SEND_STATS: { method: "GET", path: "/v3/marketing/stats/singlesends/{id}" },
  SENDGRID_DELETE_SINGLE_SEND: { method: "DELETE", path: "/v3/marketing/singlesends/{id}" },
} as const satisfies Record<string, SendgridEndpoint>;
export type SendgridOp = keyof typeof SENDGRID_ENDPOINTS;

export type SendgridArgs = { id?: string; query?: Record<string, string | number>; body?: unknown };

const TIMEOUT_MS = 30_000;
const PATH_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function sendgridHttpCall(apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): ProviderCall {
  return async (op, rawArgs): Promise<ComposioExecResult> => {
    const ep = (SENDGRID_ENDPOINTS as Record<string, SendgridEndpoint>)[op];
    if (!ep) throw new Error(`unknown SendGrid operation ${op}`);
    const args = rawArgs as SendgridArgs;
    let path = ep.path;
    if (path.includes("{id}")) {
      if (!args.id || !PATH_ID.test(args.id)) return { ok: false, status: 400, data: null, error: "bad id", outcome_unknown: false };
      path = path.replace("{id}", encodeURIComponent(args.id));
    }
    const qs = args.query ? `?${new URLSearchParams(Object.entries(args.query).map(([k, v]) => [k, String(v)])).toString()}` : "";
    const isWrite = ep.method !== "GET" && op !== "SENDGRID_SINGLE_SEND_SEARCH" && op !== "SENDGRID_CONTACTS_BY_EMAIL";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${SENDGRID_API_BASE}${path}${qs}`, {
        method: ep.method,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...(args.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
        signal: controller.signal,
        redirect: "manual",
      });
    } catch {
      return { ok: false, status: 0, data: null, error: "SendGrid did not answer", outcome_unknown: isWrite };
    } finally {
      clearTimeout(timer);
    }
    let data: unknown = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return { ok: true, status: res.status, data, error: null, outcome_unknown: false };
    return {
      ok: false,
      status: res.status,
      data: null,
      error: sendgridErrorText(res.status, data),
      outcome_unknown: isWrite && res.status >= 500,
      ...(res.status === 429 ? { retry_after_s: retryAfterSeconds(res.headers) } : {}),
    };
  };
}

export function retryAfterSeconds(headers: Pick<Headers, "get"> | undefined, nowMs = Date.now()): number | null {
  const reset = Number(headers?.get("x-ratelimit-reset") ?? NaN);
  if (!Number.isFinite(reset) || reset <= 0) return null;
  return Math.min(3600, Math.max(1, Math.ceil(reset - nowMs / 1000)));
}

export function sendgridErrorText(status: number, data: unknown): string {
  const errors = (data as { errors?: unknown } | null)?.errors;
  const first = Array.isArray(errors) ? (errors[0] as { message?: unknown } | undefined)?.message : null;
  if (status === 403 && typeof first === "string" && isAccountHeld(first)) return first.trim();
  if (status === 401 || status === 403) return "SendGrid refused the key (it was removed, or lacks a permission). Reconnect SendGrid with a key that has the campaign permissions";
  if (status === 429) return "SendGrid's rate limit was reached. Try again in a minute";
  return typeof first === "string" && first.trim() ? first.trim() : `HTTP ${status}`;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);

function err(r: ComposioExecResult): string {
  return toolErrorText(r.error, r.status);
}
async function read(call: ProviderCall, op: SendgridOp, args: SendgridArgs = {}): Promise<unknown> {
  const r = await call(op, args as Record<string, unknown>);
  if (!r.ok) throw new EmailToolError(err(r), false, r.status || null, r.retry_after_s ?? null);
  return r.data;
}
async function write(call: ProviderCall, op: SendgridOp, args: SendgridArgs): Promise<unknown> {
  const r = await call(op, args as Record<string, unknown>);
  if (!r.ok) throw new EmailToolError(err(r), r.outcome_unknown);
  return r.data;
}
const missing = (r: ComposioExecResult) => !r.ok && !r.outcome_unknown && r.status === 404;

const PHASE: Readonly<Record<string, CampaignPhase>> = { draft: "draft", scheduled: "sending", triggered: "sent" };

function audience(l: Rec): Audience | null {
  const id = str(l.id);
  return id ? { id, name: str(l.name) ?? id, member_count: count(l.contact_count) } : null;
}

export function sendgridCampaign(s: Rec): CampaignState | null {
  const id = str(s.id);
  if (!id) return null;
  const to = isRec(s.send_to) ? s.send_to : {};
  const cfg = isRec(s.email_config) ? s.email_config : {};
  const status = str(s.status)?.toLowerCase() ?? null;
  const lists = Array.isArray(to.list_ids) ? to.list_ids.map(str).filter((x): x is string => x !== null) : [];
  const segments = Array.isArray(to.segment_ids) ? to.segment_ids.filter((x) => str(x) !== null) : [];
  return {
    id,
    title: str(s.name),
    phase: (status && PHASE[status]) || "unknown",
    raw_status: status,
    audience_ids: to.all === true ? [] : lists,
    recipients: null,
    url: null,
    narrowed: segments.length > 0,
    envelope: {
      subject: str(cfg.subject),
      preview_text: null,
      from_name: null,
      from_email: null,
      reply_to: null,
      sender_id: str(cfg.sender_id),
      suppression_group_id: str(cfg.suppression_group_id),
    },
  };
}

function numId(id: string | null | undefined, what: string): number {
  const n = id && /^\d{1,15}$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(n)) throw new EmailToolError(`no ${what} is set for SendGrid`, false);
  return n;
}

const today = () => new Date().toISOString().slice(0, 10);
const SENT_HISTORY_MAX_PAGES = 20;

const UNSUB_PAGE = 500;
const UNSUB_MAX_PAGES = 10;
const LOOKUP_BATCH = 100;
const LOOKUP_MAX_ADDRESSES = 5000;

const emailKey = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);

async function suppressedAddresses(call: ProviderCall, groupId: string): Promise<{ emails: Set<string>; complete: boolean }> {
  const emails = new Set<string>();
  let complete = true;
  const group = await call("SENDGRID_GROUP_SUPPRESSIONS", { id: groupId });
  if (group.ok && Array.isArray(group.data)) for (const e of group.data) {
    const k = emailKey(e);
    if (k) emails.add(k);
  }
  else complete = false;
  for (let page = 0; ; page++) {
    if (page === UNSUB_MAX_PAGES) {
      complete = false;
      break;
    }
    const r = await call("SENDGRID_GLOBAL_UNSUBSCRIBES", { query: { limit: UNSUB_PAGE, offset: page * UNSUB_PAGE } });
    if (!r.ok || !Array.isArray(r.data)) {
      complete = false;
      break;
    }
    for (const row of recs(r.data)) {
      const k = emailKey(row.email);
      if (k) emails.add(k);
    }
    if (r.data.length < UNSUB_PAGE) break;
  }
  return { emails, complete };
}

export async function sendgridSuppressedOnList(call: ProviderCall, listId: string, groupId: string): Promise<SuppressionCheck> {
  try {
    const { emails, complete } = await suppressedAddresses(call, groupId);
    if (emails.size > LOOKUP_MAX_ADDRESSES) return { suppressed: 0, complete: false };
    const all = [...emails];
    let suppressed = 0;
    for (let i = 0; i < all.length; i += LOOKUP_BATCH) {
      const r = await call("SENDGRID_CONTACTS_BY_EMAIL", { body: { emails: all.slice(i, i + LOOKUP_BATCH) } });
      if (missing(r)) continue;
      if (!r.ok) return { suppressed, complete: false };
      const found = (r.data as Rec | null)?.result;
      if (!isRec(found)) return { suppressed, complete: false };
      for (const entry of Object.values(found)) {
        const contact = isRec(entry) ? entry.contact : null;
        const lists = isRec(contact) ? contact.list_ids : null;
        if (Array.isArray(lists) && lists.includes(listId)) suppressed++;
      }
    }
    return { suppressed, complete };
  } catch {
    return { suppressed: 0, complete: false };
  }
}

export async function sendgridTestSender(call: ProviderCall, preferEmail: string): Promise<{ email: string; name: string | null } | null> {
  const rows = recs(((await read(call, "SENDGRID_VERIFIED_SENDERS", { query: { limit: 100 } })) as Rec | null)?.results).filter((s) => s.verified === true && typeof s.from_email === "string");
  const s = rows.find((x) => String(x.from_email).toLowerCase() === preferEmail.toLowerCase()) ?? rows[0];
  return s ? { email: String(s.from_email), name: str(s.from_name) } : null;
}

export const sendgrid: EmailProvider = {
  suppressedOnList: sendgridSuppressedOnList,
  async listAudiences(call) {
    const data = await read(call, "SENDGRID_LISTS", { query: { page_size: 1000 } });
    return recs((data as Rec | null)?.result).map(audience).filter((a): a is Audience => a !== null);
  },
  async listAudiencesPage(call, cursor) {
    const data = await read(call, "SENDGRID_LISTS", { query: { page_size: 1000, ...(cursor ? { page_token: cursor } : {}) } });
    if (!Array.isArray((data as Rec | null)?.result)) throw new EmailToolError("SendGrid returned no lists.", false);
    return { lists: recs((data as Rec | null)?.result).map(audience).filter((a): a is Audience => a !== null), next: nextPageToken(data) };
  },
  async listSentCampaignsPage(call, q) {
    const since = Date.parse(q.since);
    const campaigns: SentCampaign[] = [];
    const seen = new Set<string>();
    let cursor = q.cursor;
    for (let page = 0; page < SENT_HISTORY_MAX_PAGES; page++) {
      const data = await read(call, "SENDGRID_SINGLE_SENDS", { query: { page_size: 100, ...(cursor ? { page_token: cursor } : {}) } });
      const rows = (data as Rec | null)?.result;
      if (!Array.isArray(rows)) throw new EmailToolError("SendGrid returned no Single Send list.", false);
      for (const s of recs(rows)) {
        const id = str(s.id);
        const sentAt = str(s.send_at);
        if (!id || seen.has(id) || str(s.status)?.toLowerCase() !== "triggered" || !sentAt || Date.parse(sentAt) < since) continue;
        seen.add(id);
        campaigns.push({ id, sent_at: new Date(sentAt).toISOString(), subject: null, list_id: null, narrowed: false });
      }
      const next = nextPageToken(data);
      if (!next || next === cursor) break;
      cursor = next;
    }
    campaigns.sort((a, b) => b.sent_at.localeCompare(a.sent_at));
    return { campaigns, next: null };
  },
  async getAudience(call, id) {
    const r = await call("SENDGRID_LIST", { id });
    if (missing(r)) return null;
    if (!r.ok) throw new EmailToolError(err(r), false, r.status || null, r.retry_after_s ?? null);
    const l = isRec(r.data) && str(r.data.id) === id ? r.data : null;
    return l ? audience(l) : null;
  },
  async defaultSender(call) {
    const r = await call("SENDGRID_VERIFIED_SENDERS", { query: { limit: 100 } });
    if (!r.ok) return { name: null, email: null };
    const verified = recs((r.data as Rec | null)?.results).filter((s) => s.verified === true);
    if (verified.length !== 1) return { name: null, email: null };
    return { name: str(verified[0].from_name), email: str(verified[0].from_email) };
  },
  async resolveSendIds(call, fromEmail, pinnedGroup = null) {
    const senders = recs(((await read(call, "SENDGRID_VERIFIED_SENDERS", { query: { limit: 100 } })) as Rec | null)?.results).filter(
      (s) => s.verified === true && (str(s.from_email) ?? "").toLowerCase() === fromEmail.toLowerCase(),
    );
    if (senders.length === 0) throw new EmailToolError(`${fromEmail} is not a verified sender in SendGrid`, false);
    if (senders.length > 1) throw new EmailToolError(`more than one verified sender in SendGrid uses ${fromEmail}, so Zavi cannot tell which one to send as`, false);
    let group = pinnedGroup;
    if (!group) {
      const def = recs(await read(call, "SENDGRID_SUPPRESSION_GROUPS")).filter((g) => g.is_default === true);
      if (def.length !== 1) throw new EmailToolError("no unsubscribe group is picked for SendGrid, and the account has no single default one", false);
      group = str(def[0].id);
    }
    return { sender_id: str(senders[0].id) ?? "", suppression_group_id: group ?? "", sender_name: str(senders[0].from_name) };
  },
  async verifiedSender(call, senderId) {
    const rows = recs(((await read(call, "SENDGRID_VERIFIED_SENDERS", { query: { limit: 100 } })) as Rec | null)?.results);
    const s = rows.find((x) => str(x.id) === senderId && x.verified === true && typeof x.from_email === "string");
    return s ? { email: String(s.from_email), name: str(s.from_name) } : null;
  },
  async findCampaignsByTitle(call, title) {
    const data = await read(call, "SENDGRID_SINGLE_SEND_SEARCH", { query: { page_size: 100 }, body: { name: title } });
    const rows = (data as Rec | null)?.result;
    if (!Array.isArray(rows)) throw new EmailToolError("SendGrid returned no Single Send list.", false);
    const hits = recs(rows)
      .filter((r) => str(r.name) === title)
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
    const out: CampaignState[] = [];
    for (const h of hits) {
      const full = await sendgrid.getCampaign(call, String(h.id));
      if (full && full.title === title) out.push(full);
    }
    return out;
  },
  async getCampaign(call, id) {
    const r = await call("SENDGRID_SINGLE_SEND", { id });
    if (missing(r)) return null;
    if (!r.ok) throw new EmailToolError(err(r), false, r.status || null, r.retry_after_s ?? null);
    return isRec(r.data) && str(r.data.id) === id ? sendgridCampaign(r.data) : null;
  },
  async createCampaign(call, i) {
    const data = await write(call, "SENDGRID_CREATE_SINGLE_SEND", {
      body: {
        name: i.title,
        send_to: { list_ids: [i.audience_id] },
        email_config: {
          subject: i.subject,
          editor: "code",
          sender_id: numId(i.sender_id, "sender"),
          suppression_group_id: numId(i.suppression_group_id, "unsubscribe group"),
        },
      },
    });
    const id = isRec(data) ? str(data.id) : null;
    if (!id) throw new EmailToolError("SendGrid did not return the new Single Send's id.", true);
    return id;
  },
  async setContent(call, campaignId, c) {
    await write(call, "SENDGRID_UPDATE_SINGLE_SEND", {
      id: campaignId,
      body: { name: c.title, email_config: { html_content: c.html, plain_content: c.text, generate_plain_content: false, editor: "code" } },
    });
  },
  async setEnvelope(call, campaignId, e) {
    const current = await sendgrid.getCampaign(call, campaignId);
    if (!current?.title) throw new EmailToolError("the Single Send is no longer there.", false);
    await write(call, "SENDGRID_UPDATE_SINGLE_SEND", {
      id: campaignId,
      body: {
        name: current.title,
        email_config: {
          subject: e.subject,
          sender_id: numId(e.sender_id, "sender"),
          suppression_group_id: numId(e.suppression_group_id, "unsubscribe group"),
        },
      },
    });
  },
  async readiness(call, campaignId) {
    const r = await call("SENDGRID_SINGLE_SEND", { id: campaignId });
    if (!r.ok || !isRec(r.data)) throw new EmailToolError(err(r), false, r.status || null, r.retry_after_s ?? null);
    const cfg = isRec(r.data.email_config) ? r.data.email_config : {};
    if (!str(cfg.subject)) return { ready: false, reason: "it has no subject" };
    if (!str(cfg.html_content)) return { ready: false, reason: "it has no content" };
    if (!str(cfg.sender_id)) return { ready: false, reason: "it has no sender" };
    if (!str(cfg.suppression_group_id) && !str(cfg.custom_unsubscribe_url)) return { ready: false, reason: "it has no unsubscribe group" };
    return { ready: true, reason: null };
  },
  async liveRecipientCount(call, _campaignId, audienceId) {
    const r = await call("SENDGRID_LIST_CONTACT_COUNT", { id: audienceId });
    return r.ok && isRec(r.data) ? count(r.data.contact_count) : null;
  },
  send(call, campaignId) {
    return call("SENDGRID_SCHEDULE_SINGLE_SEND", { id: campaignId, body: { send_at: "now" } });
  },
  async readContent(call, campaignId) {
    const r = await call("SENDGRID_SINGLE_SEND", { id: campaignId });
    if (!r.ok) throw new EmailToolError(err(r), false);
    const cfg = isRec(r.data) && isRec(r.data.email_config) ? r.data.email_config : null;
    if (!cfg) return { proof: "unprovable", why: "SendGrid returned no email content" };
    const present = (v: unknown) => v !== undefined && v !== null;
    if (present(cfg.editor) && cfg.editor !== "code") return { proof: "unprovable", why: "the Single Send does not use the code editor" };
    if (present(cfg.design_id) && cfg.design_id !== "") return { proof: "unprovable", why: "the Single Send uses a saved design" };
    if (present(cfg.generate_plain_content) && cfg.generate_plain_content !== false) return { proof: "unprovable", why: "SendGrid generates the plain-text part" };
    if (typeof cfg.html_content !== "string") return { proof: "unprovable", why: "SendGrid returned no html" };
    if (typeof cfg.plain_content !== "string") return { proof: "unprovable", why: "SendGrid returned no plain-text part" };
    return { proof: "ok", html: cfg.html_content, text: cfg.plain_content };
  },
  async results(call, campaignId) {
    const data = await read(call, "SENDGRID_SINGLE_SEND_STATS", {
      id: campaignId,
      query: { aggregated_by: "total", start_date: "2020-01-01", end_date: today() },
    });
    const first = recs((data as Rec | null)?.results)[0];
    const s = isRec(first?.stats) ? first.stats : {};
    const delivered = count(s.delivered);
    const opens = count(s.unique_opens);
    const clicks = count(s.unique_clicks);
    const rate = (n: number | null) => (n !== null && delivered && delivered > 0 ? Math.min(1, n / delivered) : null);
    return {
      recipients: count(s.requests) ?? delivered,
      delivered,
      bounces: count(s.bounces),
      opens,
      clicks,
      unsubscribes: count(s.unsubscribes),
      open_rate: rate(opens),
      click_rate: rate(clicks),
    };
  },
};
