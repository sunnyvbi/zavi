
import type { ComposioExecResult } from "@/services/connectors/composio/api";
import { classifyAdReadError } from "@/services/connectors/core/read-error-kind";
import { EmailToolError, toolErrorText, vendorRefusal } from "./provider-errors";
import { sendgrid } from "./providers-sendgrid";

export { EmailToolError, toolErrorText };

export const EMAIL_TOOLS = ["mailchimp", "klaviyo", "sendgrid"] as const;
export type EmailTool = (typeof EMAIL_TOOLS)[number];

export const COMPOSIO_EMAIL_TOOLS = ["mailchimp", "klaviyo"] as const;
export type ComposioEmailTool = (typeof COMPOSIO_EMAIL_TOOLS)[number];

export const EMAIL_TOOL_LABEL: Readonly<Record<EmailTool, string>> = { mailchimp: "Mailchimp", klaviyo: "Klaviyo", sendgrid: "SendGrid" };

export function isEmailTool(v: unknown): v is EmailTool {
  return typeof v === "string" && (EMAIL_TOOLS as readonly string[]).includes(v);
}

export function isComposioEmailTool(v: unknown): v is ComposioEmailTool {
  return typeof v === "string" && (COMPOSIO_EMAIL_TOOLS as readonly string[]).includes(v);
}

const EMAIL_TOOLKIT_PREFIX = /^(MAILCHIMP|KLAVIYO)_/;

const RAW_SEND_PATTERNS: readonly RegExp[] = [
  /(^|_)(SEND|RESEND|SCHEDULE)_(CAMPAIGN|TEST_EMAIL)(_|$)/,
  /(^|_)CREATE_CAMPAIGN_SEND_JOB(_|$)/,
  /(^|_)(START|RESUME)_(AUTOMATED_EMAIL|AUTOMATION_EMAILS|AUTOMATION|RSS_CAMPAIGN|BATCH_OPERATION|FLOW)(_|$)/,
  /(^|_)ADD_SUBSCRIBER_TO_WORKFLOW_EMAIL(_|$)/,
  /(^|_)JOURNEYS_API_TRIGGER(_|$)/,
  /(^|_)UPDATE_FLOW_STATUS(_|$)/,
  /(^|_)ADD_MEMBER_TO_(LIST|SEGMENT)(_|$)/,
  /(^|_)(ADD_OR_UPDATE|UPDATE)_LIST_MEMBER(_|$)/,
  /(^|_)ADD_OR_REMOVE_MEMBER_TAGS(_|$)/,
  /(^|_)(CREATE|UPDATE|CREATE_OR_UPDATE|CREATE_OR_UPDATE_CLIENT)_PROFILE(_|$)/,
  /(^|_)UNSUPPRESS_PROFILES(_|$)/,
  /(^|_)UPDATE_CAMPAIGN_SETTINGS(_|$)/,
  /(^|_)UPDATE_CAMPAIGN$/,
  /(^|_)UPDATE_WORKFLOW_EMAIL(_|$)/,
  /(^|_)BATCH_(ADD_OR_REMOVE_MEMBERS|SUBSCRIBE_OR_UNSUBSCRIBE)(_|$)/,
  /(^|_)ADD_PROFILE_TO_LIST(_|$)/,
  /(^|_)(SUBSCRIBE_PROFILES|SPAWN_BULK_PROFILE_IMPORT_JOB)(_|$)/,
  /(^|_)(ADD_EVENT|CREATE_EVENT|CREATE_CLIENT_EVENT|BULK_CREATE_EVENTS|BULK_CREATE_CLIENT_EVENTS)(_|$)/,
];

export const RAW_EMAIL_SEND_MESSAGE =
  "Zavi does not run this action in Mailchimp or Klaviyo: it sends mail, or can start an automation that does. To send a campaign, read the lists with email_campaign__list_audiences and propose it with email__propose_campaign; the founder approves it on that card. Adding people to a list, subscribing them and recording events are done in the email tool itself for now.";

export function isRawEmailSendAction(slug: string, toolkit?: string | null): boolean {
  const s = slug.trim().toUpperCase();
  const ours = toolkit ? isComposioEmailTool(toolkit.toLowerCase()) : EMAIL_TOOLKIT_PREFIX.test(s);
  return ours && RAW_SEND_PATTERNS.some((re) => re.test(s));
}

export type ProviderCall = (tool_slug: string, args: Record<string, unknown>) => Promise<ComposioExecResult>;

export type Audience = {
  id: string;
  name: string;
  member_count: number | null;
  default_from_name?: string | null;
  default_from_email?: string | null;
};

export type CampaignPhase = "draft" | "sending" | "sent" | "unknown";

export type CampaignState = {
  id: string;
  title: string | null;
  phase: CampaignPhase;
  raw_status: string | null;
  audience_ids: string[];
  recipients: number | null;
  emails_sent?: number | null;
  url: string | null;
  narrowed: boolean;
  envelope: {
    subject: string | null;
    preview_text: string | null;
    from_name: string | null;
    from_email: string | null;
    reply_to: string | null;
    sender_id?: string | null;
    suppression_group_id?: string | null;
  } | null;
};

export type CampaignResults = {
  recipients: number | null;
  delivered: number | null;
  bounces: number | null;
  opens: number | null;
  clicks: number | null;
  unsubscribes: number | null;
  open_rate: number | null;
  click_rate: number | null;
  received?: number | null;
  skipped?: number | null;
};

export const NO_RESULTS: CampaignResults = { recipients: null, delivered: null, bounces: null, opens: null, clicks: null, unsubscribes: null, open_rate: null, click_rate: null };

export type CreateInput = {
  title: string;
  audience_id: string;
  subject: string;
  preview_text: string | null;
  from_name: string;
  from_email: string;
  reply_to: string | null;
  sender_id?: string | null;
  suppression_group_id?: string | null;
};

export type StoredContent =
  | { proof: "ok"; html: string; text: string }
  | { proof: "unprovable"; why: string };

export type Sender = { name: string | null; email: string | null };

export type AudiencePage = { lists: Audience[]; next: string | null };

export type SizeBudget = { maxCalls: number; deadline: number; now: () => number };

export type SentCampaign = { id: string; sent_at: string; subject: string | null; list_id: string | null; narrowed: boolean };
export type SentCampaignPage = { campaigns: SentCampaign[]; next: string | null };
export type SentCampaignQuery = { since: string; cursor: string | null; limit: number };

export type SuppressionCheck = { suppressed: number; complete: boolean };

export type EmailProvider = {
  suppressedOnList?(call: ProviderCall, audienceId: string, groupId: string): Promise<SuppressionCheck>;
  listAudiences(call: ProviderCall): Promise<Audience[]>;
  listAudiencesPage(call: ProviderCall, cursor: string | null): Promise<AudiencePage>;
  getAudience(call: ProviderCall, id: string): Promise<Audience | null>;
  sizeAudiences?(call: ProviderCall, lists: Audience[], budget: SizeBudget): Promise<Audience[]>;
  listSentCampaignsPage(call: ProviderCall, q: SentCampaignQuery): Promise<SentCampaignPage>;
  defaultSender(call: ProviderCall, audience: Audience): Promise<Sender>;
  findCampaignsByTitle(call: ProviderCall, title: string): Promise<CampaignState[]>;
  getCampaign(call: ProviderCall, id: string): Promise<CampaignState | null>;
  createCampaign(call: ProviderCall, input: CreateInput): Promise<string>;
  setContent(call: ProviderCall, campaignId: string, c: { title: string; html: string; text: string }): Promise<void>;
  setEnvelope(call: ProviderCall, campaignId: string, e: Omit<CreateInput, "title" | "audience_id">): Promise<void>;
  readiness(call: ProviderCall, campaignId: string): Promise<{ ready: boolean; reason: string | null }>;
  senderDomainAuthenticated?(call: ProviderCall, domain: string): Promise<boolean | null>;
  liveRecipientCount(call: ProviderCall, campaignId: string, audienceId: string, sleep: (ms: number) => Promise<void>): Promise<number | null>;
  send(call: ProviderCall, campaignId: string): Promise<ComposioExecResult>;
  results(call: ProviderCall, campaignId: string): Promise<CampaignResults>;
  readContent(call: ProviderCall, campaignId: string): Promise<StoredContent>;
  resultsMany?(call: ProviderCall, campaignIds: readonly string[], cacheKey: string): Promise<Map<string, CampaignResults>>;
  resolveSendIds?(call: ProviderCall, fromEmail: string, pinnedGroup?: string | null): Promise<{ sender_id: string; suppression_group_id: string; sender_name?: string | null }>;
  verifiedSender?(call: ProviderCall, senderId: string): Promise<{ email: string; name: string | null } | null>;
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const count = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};
const rate = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
};

function dig<T>(data: unknown, match: (v: unknown) => T | null): T | null {
  let d = data;
  for (let i = 0; i < 4; i++) {
    const hit = match(d);
    if (hit !== null) return hit;
    if (!isRec(d) || !("data" in d)) return null;
    d = d.data;
  }
  return null;
}
const recWith = (key: string) => (v: unknown): Rec | null => (isRec(v) && key in v ? v : null);
const sub = (o: Rec | null | undefined, key: string): Rec => {
  const v = o?.[key];
  return isRec(v) ? v : {};
};
const resourceStatus = (data: unknown): string | null =>
  str(sub(dig(data, (v) => (isRec(v) && isRec(v.attributes) ? v : null)), "attributes").status)?.toLowerCase() ?? null;
const arrayOfRecs = (v: unknown): Rec[] | null => (Array.isArray(v) ? v.filter(isRec) : null);

export function urlParam(url: string | null, name: string): string | null {
  if (!url) return null;
  let v: string | null = null;
  try {
    v = new URL(url).searchParams.get(name);
  } catch {
    v = null;
  }
  if (!v || v.length > 512) throw new EmailToolError("The tool returned a next page Zavi could not follow.", false);
  return v;
}

function errorText(r: ComposioExecResult): string {
  return toolErrorText(r.error, r.status);
}

function toolError(r: ComposioExecResult, outcomeUnknown = false, status: number | null = toolStatus(r)): EmailToolError {
  return new EmailToolError(errorText(r), outcomeUnknown, status, null, vendorRefusal(r.data)?.said || null);
}

export function toolStatus(r: Pick<ComposioExecResult, "status" | "data">): number | null {
  if (r.status >= 200 && r.status < 300) {
    for (const d of [r.data, isRec(r.data) ? r.data.data : null]) {
      if (!isRec(d)) continue;
      const s = Number(d.status_code);
      if (Number.isInteger(s) && s >= 400 && s < 600) return s;
    }
  }
  return r.status || null;
}

async function read(call: ProviderCall, slug: string, args: Rec): Promise<unknown> {
  const r = await call(slug, args);
  if (!r.ok) throw toolError(r);
  return r.data;
}

async function write(call: ProviderCall, slug: string, args: Rec): Promise<unknown> {
  const r = await call(slug, args);
  if (!r.ok) throw toolError(r, r.outcome_unknown, null);
  return r.data;
}

function isMissing(r: ComposioExecResult): boolean {
  return !r.ok && !r.outcome_unknown && (toolStatus(r) === 404 || /not.?found|does not exist|\b404\b/i.test(errorText(r)));
}

const LIST_PAGE = 200;

const MAILCHIMP_PHASE: Readonly<Record<string, CampaignPhase>> = {
  save: "draft",
  schedule: "sending",
  sending: "sending",
  sent: "sent",
};

function mailchimpAudience(l: Rec): Audience | null {
  const id = str(l.id);
  if (!id) return null;
  const stats = sub(l, "stats");
  const defaults = sub(l, "campaign_defaults");
  return {
    id,
    name: str(l.name) ?? id,
    member_count: count(stats.member_count),
    default_from_name: str(defaults.from_name),
    default_from_email: str(defaults.from_email),
  };
}

function mailchimpCampaign(c: Rec): CampaignState | null {
  const id = str(c.id);
  if (!id) return null;
  const settings = sub(c, "settings");
  const recipients = sub(c, "recipients");
  const status = str(c.status)?.toLowerCase() ?? null;
  const listId = str(recipients.list_id);
  const webId = str(c.web_id);
  const sent = count(c.emails_sent);
  const seg = sub(recipients, "segment_opts");
  const narrowed =
    seg.saved_segment_id != null || seg.prebuilt_segment_id != null || (Array.isArray(seg.conditions) && seg.conditions.length > 0) || !!str(recipients.segment_text);
  const hasEnvelope = "subject_line" in settings || "from_name" in settings || "reply_to" in settings;
  return {
    id,
    narrowed,
    envelope: hasEnvelope
      ? { subject: str(settings.subject_line), preview_text: str(settings.preview_text), from_name: str(settings.from_name), from_email: str(settings.reply_to), reply_to: str(settings.reply_to) }
      : null,
    title: str(settings.title),
    phase: (status && MAILCHIMP_PHASE[status]) || "unknown",
    raw_status: status,
    audience_ids: listId ? [listId] : [],
    recipients: sent && sent > 0 ? sent : count(recipients.recipient_count),
    emails_sent: sent,
    url: webId && /^\d+$/.test(webId) ? `https://admin.mailchimp.com/campaigns/show/?id=${webId}` : null,
  };
}

const mailchimp: EmailProvider = {
  async listAudiences(call) {
    const data = await read(call, "MAILCHIMP_GET_LISTS_INFO", { count: LIST_PAGE });
    const lists = arrayOfRecs(dig(data, recWith("lists"))?.lists) ?? [];
    return lists.map(mailchimpAudience).filter((a): a is Audience => a !== null);
  },
  async listAudiencesPage(call, cursor) {
    const offset = cursor && /^\d{1,9}$/.test(cursor) ? Number(cursor) : 0;
    const data = await read(call, "MAILCHIMP_GET_LISTS_INFO", { count: LIST_PAGE, offset });
    const body = dig(data, recWith("lists"));
    const rows = arrayOfRecs(body?.lists);
    if (rows === null) throw new EmailToolError("Mailchimp returned no lists.", false);
    const total = count(body?.total_items);
    const seen = offset + rows.length;
    const next = rows.length > 0 && (total === null ? rows.length === LIST_PAGE : seen < total) ? String(seen) : null;
    if (total === null && next === null) console.warn(`[email-lists] Mailchimp gave no total_items; ended at ${seen} lists on a short page`);
    return { lists: rows.map(mailchimpAudience).filter((a): a is Audience => a !== null), next };
  },
  async listSentCampaignsPage(call, q) {
    const offset = q.cursor && /^\d{1,9}$/.test(q.cursor) ? Number(q.cursor) : 0;
    const limit = Math.max(1, Math.min(q.limit, LIST_PAGE));
    const data = await read(call, "MAILCHIMP_LIST_CAMPAIGNS", {
      status: "sent",
      since_send_time: q.since,
      sort_field: "send_time",
      sort_dir: "DESC",
      count: limit,
      offset,
    });
    const body = dig(data, recWith("campaigns"));
    const rows = arrayOfRecs(body?.campaigns);
    if (rows === null) throw new EmailToolError("Mailchimp returned no campaign list.", false);
    const total = count(body?.total_items);
    const seen = offset + rows.length;
    const campaigns: SentCampaign[] = [];
    for (const c of rows) {
      const state = mailchimpCampaign(c);
      const sentAt = str(c.send_time);
      if (!state || !sentAt || state.phase !== "sent" || Date.parse(sentAt) < Date.parse(q.since)) continue;
      campaigns.push({
        id: state.id,
        sent_at: new Date(sentAt).toISOString(),
        subject: state.envelope?.subject ?? null,
        list_id: state.audience_ids[0] ?? null,
        narrowed: state.narrowed,
      });
    }
    const next = rows.length > 0 && (total === null ? rows.length === limit : seen < total) ? String(seen) : null;
    return { campaigns, next };
  },
  async getAudience(call, id) {
    const r = await call("MAILCHIMP_GET_LIST_INFO", { list_id: id });
    if (isMissing(r)) return null;
    if (!r.ok) throw toolError(r);
    const l = dig(r.data, (v) => (isRec(v) && str(v.id) === id ? v : null));
    return l ? mailchimpAudience(l) : null;
  },
  async defaultSender(_call, audience) {
    return { name: audience.default_from_name ?? null, email: audience.default_from_email ?? null };
  },
  async findCampaignsByTitle(call, title) {
    const data = await read(call, "MAILCHIMP_LIST_CAMPAIGNS", { count: LIST_PAGE, sort_field: "create_time", sort_dir: "DESC" });
    const rows = arrayOfRecs(dig(data, recWith("campaigns"))?.campaigns);
    if (rows === null) throw new EmailToolError("Mailchimp returned no campaign list.", false);
    return rows.map(mailchimpCampaign).filter((c): c is CampaignState => c !== null && c.title === title);
  },
  async getCampaign(call, id) {
    const r = await call("MAILCHIMP_GET_CAMPAIGN_INFO", { campaign_id: id });
    if (isMissing(r)) return null;
    if (!r.ok) throw toolError(r);
    const c = dig(r.data, (v) => (isRec(v) && str(v.id) === id ? v : null));
    return c ? mailchimpCampaign(c) : null;
  },
  async createCampaign(call, i) {
    const data = await write(call, "MAILCHIMP_ADD_CAMPAIGN", {
      type: "regular",
      recipients__list__id: i.audience_id,
      settings__title: i.title,
      settings__subject__line: i.subject,
      settings__auto__footer: false,
      ...(i.preview_text ? { settings__preview__text: i.preview_text } : {}),
      settings__from__name: i.from_name,
      settings__reply__to: i.reply_to ?? i.from_email,
    });
    const id = str(dig(data, recWith("id"))?.id);
    if (!id) throw new EmailToolError("Mailchimp did not return the new campaign's id.", true);
    return id;
  },
  async setContent(call, campaignId, c) {
    await write(call, "MAILCHIMP_SET_CAMPAIGN_CONTENT", { campaign_id: campaignId, html: c.html, plain_text: c.text });
  },
  async setEnvelope(call, campaignId, e) {
    await write(call, "MAILCHIMP_UPDATE_CAMPAIGN_SETTINGS", {
      campaign_id: campaignId,
      settings__subject__line: e.subject,
      settings__preview__text: e.preview_text ?? "",
      settings__from__name: e.from_name,
      settings__reply__to: e.reply_to ?? e.from_email,
    });
  },
  async readiness(call, campaignId) {
    const data = await read(call, "MAILCHIMP_GET_CAMPAIGN_SEND_CHECKLIST", { campaign_id: campaignId });
    const list = dig(data, recWith("is_ready"));
    if (!list) throw new EmailToolError("Mailchimp returned no send checklist.", false);
    if (list.is_ready === true) return { ready: true, reason: null };
    const failing = (arrayOfRecs(list.items) ?? []).find((it) => str(it.type)?.toLowerCase() === "error");
    const reason = failing ? [str(failing.heading), str(failing.details)].filter(Boolean).join(": ") : null;
    return { ready: false, reason: reason ? reason.slice(0, 240) : null };
  },
  async senderDomainAuthenticated(call, domain) {
    const r = await call("MAILCHIMP_GET_DOMAIN_INFO", { domain_name: domain });
    if (isMissing(r)) return false;
    if (!r.ok) return null;
    const authenticated = dig(r.data, recWith("authenticated"))?.authenticated;
    return typeof authenticated === "boolean" ? authenticated : null;
  },
  async liveRecipientCount(call, _campaignId, audienceId) {
    const a = await mailchimp.getAudience(call, audienceId);
    return a?.member_count ?? null;
  },
  async send(call, campaignId) {
    const r = await call("MAILCHIMP_SEND_CAMPAIGN", { campaign_id: campaignId });
    if (!r.ok) return r;
    const refusal = vendorRefusal(r.data);
    if (refusal) return { ...r, ok: false, status: refusal.status ?? r.status, error: refusal.said || r.error || "Mailchimp did not accept the send", outcome_unknown: false };
    if (typeof r.error === "string" && r.error.trim() !== "") return { ...r, ok: false, outcome_unknown: true };
    return r;
  },
  async readContent(call, campaignId) {
    const data = await read(call, "MAILCHIMP_GET_CAMPAIGN_CONTENT", { campaign_id: campaignId });
    const body = dig(data, (v) => (isRec(v) && ("html" in v || "plain_text" in v || "variate_contents" in v) ? v : null));
    if (!body) return { proof: "unprovable", why: "Mailchimp returned no content" };
    const variants = body.variate_contents;
    if ("variate_contents" in body && !(Array.isArray(variants) && variants.length === 0)) return { proof: "unprovable", why: "the campaign has A/B variants" };
    if (typeof body.html !== "string") return { proof: "unprovable", why: "Mailchimp returned no html" };
    if (typeof body.plain_text !== "string") return { proof: "unprovable", why: "Mailchimp returned no plain-text part" };
    return { proof: "ok", html: body.html, text: body.plain_text };
  },
  async results(call, campaignId) {
    const data = await read(call, "MAILCHIMP_GET_CAMPAIGN_REPORT", { campaign_id: campaignId });
    const r: Rec = dig(data, recWith("emails_sent")) ?? {};
    const opens = sub(r, "opens");
    const clicks = sub(r, "clicks");
    const sent = count(r.emails_sent);
    const hard = count(sub(r, "bounces").hard_bounces);
    const bounces = hard !== null ? hard + (count(sub(r, "bounces").soft_bounces) ?? 0) : null;
    return {
      recipients: sent,
      delivered: sent !== null && bounces !== null ? Math.max(0, sent - bounces) : null,
      bounces,
      opens: count(opens.unique_opens),
      clicks: count(clicks.unique_subscriber_clicks),
      unsubscribes: count(r.unsubscribed),
      open_rate: rate(opens.open_rate),
      click_rate: rate(clicks.click_rate),
    };
  },
};

function klaviyoPhase(status: string | null): CampaignPhase {
  const s = (status ?? "").toLowerCase();
  if (s === "draft") return "draft";
  if (s === "sent") return "sent";
  if (s === "sending" || s === "scheduled" || s === "queued without recipients" || s === "adding recipients" || s === "preparing to send") return "sending";
  return "unknown";
}

function klaviyoAudience(l: Rec): Audience | null {
  const id = str(l.id);
  if (!id) return null;
  const attrs = sub(l, "attributes");
  return { id, name: str(attrs.name) ?? id, member_count: count(attrs.profile_count) };
}

function klaviyoCampaign(c: Rec): CampaignState | null {
  const id = str(c.id);
  if (!id) return null;
  const attrs = sub(c, "attributes");
  const audiences = sub(attrs, "audiences");
  const included = Array.isArray(audiences.included) ? audiences.included.map(str).filter((x): x is string => x !== null) : [];
  const status = str(attrs.status);
  const excluded = Array.isArray(audiences.excluded) ? audiences.excluded.filter((x) => str(x) !== null) : [];
  return {
    id,
    narrowed: excluded.length > 0,
    envelope: null,
    title: str(attrs.name),
    phase: klaviyoPhase(status),
    raw_status: status,
    audience_ids: included,
    recipients: null,
    url: /^[A-Za-z0-9]{1,64}$/.test(id) ? `https://www.klaviyo.com/campaign/${id}/reports/overview` : null,
  };
}

function klaviyoMessageId(data: unknown): string | null {
  const c = dig(data, (v) => (isRec(v) && isRec(v.relationships) ? v : null));
  const first: Rec | undefined = (arrayOfRecs(sub(sub(c, "relationships"), "campaign-messages").data) ?? [])[0];
  return first ? str(first.id) : null;
}

const ESTIMATE_POLLS = 5;

const KLAVIYO_TEMPLATE_SYNTAX = /unable to render given template|django syntax/i;
export const KLAVIYO_TEMPLATE_REFUSED = "it cannot read this email's template and would skip everyone on the list. Ask Zavi for a new draft of this email";

const KLAVIYO_METRIC_TTL_MS = 6 * 60 * 60_000;
type KlaviyoMetricIds = { id: string | null; received: string | null; skipped: string | null };
const klaviyoMetricCache = new Map<string, KlaviyoMetricIds & { at: number }>();
const KLAVIYO_REPORT_MAX = 100;
const KLAVIYO_STATS = ["recipients", "delivered", "opens_unique", "clicks_unique", "unsubscribe_uniques", "open_rate", "click_rate"] as const;

async function klaviyoMetricIds(call: ProviderCall, cacheKey: string | null): Promise<KlaviyoMetricIds> {
  const hit = cacheKey ? klaviyoMetricCache.get(cacheKey) : undefined;
  if (hit && Date.now() - hit.at < KLAVIYO_METRIC_TTL_MS) return hit;
  const metrics = dig(await read(call, "KLAVIYO_GET_METRICS", {}), arrayOfRecs) ?? [];
  const named = (name: string) => str(metrics.find((m) => sub(m, "attributes").name === name)?.id);
  const ids = { id: str(metrics[0]?.id), received: named("Received Email"), skipped: named("Skipped Send") };
  if (cacheKey) klaviyoMetricCache.set(cacheKey, { ...ids, at: Date.now() });
  return ids;
}

const KLAVIYO_EVENT_WINDOW_DAYS = 45;

async function klaviyoEventCounts(call: ProviderCall, metricId: string | null): Promise<Map<string, number> | null> {
  if (!metricId) return null;
  const end = new Date();
  const start = new Date(end.getTime() - KLAVIYO_EVENT_WINDOW_DAYS * 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 19);
  try {
    const data = await read(call, "KLAVIYO_QUERY_METRIC_AGGREGATES", {
      data__type: "metric-aggregate",
      data__attributes__metric__id: metricId,
      data__attributes__measurements: ["count"],
      data__attributes__interval: "month",
      data__attributes__by: ["$message"],
      data__attributes__filter: [`greater-or-equal(datetime,${day(start)})`, `less-than(datetime,${day(end)})`],
      data__attributes__timezone: "UTC",
    });
    const attrs = dig(data, (v): Rec | null => (isRec(v) && Array.isArray(sub(v, "attributes").data) ? sub(v, "attributes") : null));
    const rows = arrayOfRecs(attrs?.data);
    if (!rows) return null;
    const out = new Map<string, number>();
    for (const row of rows) {
      const id = Array.isArray(row.dimensions) ? str(row.dimensions[0]) : null;
      const counts = sub(row, "measurements").count;
      if (!id || !Array.isArray(counts)) continue;
      out.set(id, (out.get(id) ?? 0) + counts.reduce((a: number, c: unknown) => a + (count(c) ?? 0), 0));
    }
    return out;
  } catch {
    return null;
  }
}

export function resetKlaviyoMetricCache(): void {
  klaviyoMetricCache.clear();
}

async function klaviyoResultsMany(call: ProviderCall, campaignIds: readonly string[], cacheKey: string | null): Promise<Map<string, CampaignResults>> {
  const out = new Map<string, CampaignResults>();
  const ids = [...new Set(campaignIds)].filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)).slice(0, KLAVIYO_REPORT_MAX);
  if (ids.length === 0) return out;
  const metricIds = await klaviyoMetricIds(call, cacheKey);
  const metricId = metricIds.id;
  if (!metricId) {
    for (const id of ids) out.set(id, NO_RESULTS);
    return out;
  }
  const filter = ids.length === 1 ? `equals(campaign_id,"${ids[0]}")` : `contains-any(campaign_id,[${ids.map((id) => `"${id}"`).join(",")}])`;
  const data = await read(call, "KLAVIYO_QUERY_CAMPAIGN_VALUES", {
    data__type: "campaign-values-report",
    data__attributes__statistics: [...KLAVIYO_STATS],
    data__attributes__timeframe: { key: "last_365_days" },
    data__attributes__filter: filter,
    data__attributes__conversion__metric__id: metricId,
  });
  const attrs = dig(data, (v): Rec | null => (isRec(v) && Array.isArray(sub(v, "attributes").results) ? sub(v, "attributes") : null));
  for (const row of arrayOfRecs(attrs?.results) ?? []) {
    const id = str(sub(row, "groupings").campaign_id) ?? (ids.length === 1 ? ids[0] : null);
    if (!id || !ids.includes(id)) continue;
    const s = sub(row, "statistics");
    const prev = out.get(id);
    const add = (a: number | null | undefined, b: number | null) => (a === null || a === undefined ? b : b === null ? a : a + b);
    out.set(id, {
      recipients: add(prev?.recipients, count(s.recipients)),
      delivered: add(prev?.delivered, count(s.delivered)),
      bounces: null,
      opens: add(prev?.opens, count(s.opens_unique)),
      clicks: add(prev?.clicks, count(s.clicks_unique)),
      unsubscribes: add(prev?.unsubscribes, count(s.unsubscribe_uniques)),
      open_rate: prev ? null : rate(s.open_rate),
      click_rate: prev ? null : rate(s.click_rate),
    });
  }
  const received = await klaviyoEventCounts(call, metricIds.received);
  const skipped = await klaviyoEventCounts(call, metricIds.skipped);
  if (received === null && skipped === null) return out;
  for (const id of ids) {
    const r = received?.get(id) ?? null;
    const s = skipped?.get(id) ?? null;
    if (r === null && s === null) continue;
    out.set(id, { ...(out.get(id) ?? NO_RESULTS), received: r ?? (received ? 0 : null), skipped: s ?? (skipped ? 0 : null) });
  }
  return out;
}
const ESTIMATE_WAIT_MS = 2_000;

function rateLimited(e: unknown): boolean {
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e ?? "");
  return /throttl/i.test(text) || classifyAdReadError(new Error(text)) === "rate_limited";
}

async function withinMs<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function klaviyoSizes(call: ProviderCall, lists: Audience[], budget: SizeBudget): Promise<Audience[]> {
  const out = [...lists];
  let tried = 0;
  for (let i = 0; i < out.length && tried < budget.maxCalls; i++) {
    const a = out[i];
    if (a.member_count !== null) continue;
    const left = budget.deadline - budget.now();
    if (left <= 0) break;
    tried++;
    let r: ComposioExecResult | null;
    try {
      r = await withinMs(call("KLAVIYO_GET_LIST", { id: a.id, additional__fields__list: ["profile_count"] }), left);
    } catch (e) {
      if (rateLimited(e)) break;
      continue;
    }
    if (r === null) break;
    if (!r.ok) {
      if (r.status === 429 || rateLimited(r.error)) break;
      continue;
    }
    const l = dig(r.data, (v) => (isRec(v) && str(v.id) === a.id ? v : null));
    const n = l ? count(sub(l, "attributes").profile_count) : null;
    if (n !== null) out[i] = { ...a, member_count: n };
  }
  return out;
}

const klaviyo: EmailProvider = {
  async listAudiences(call) {
    const data = await read(call, "KLAVIYO_GET_LISTS", { sort: "name" });
    const lists = dig(data, arrayOfRecs) ?? [];
    return lists.map(klaviyoAudience).filter((a): a is Audience => a !== null);
  },
  async listAudiencesPage(call, cursor) {
    const data = await read(call, "KLAVIYO_GET_LISTS", { sort: "name", ...(cursor ? { page_cursor: cursor } : {}) });
    const lists = dig(data, arrayOfRecs);
    if (lists === null) throw new EmailToolError("Klaviyo returned no lists.", false);
    const links = sub(dig(data, recWith("links")), "links");
    const nextLink = links.next;
    if (nextLink !== undefined && nextLink !== null && typeof nextLink !== "string") throw new EmailToolError("Klaviyo returned a next page Zavi could not follow.", false);
    return { lists: lists.map(klaviyoAudience).filter((a): a is Audience => a !== null), next: urlParam(nextLink || null, "page[cursor]") };
  },
  async listSentCampaignsPage(call, q) {
    const data = await read(call, "KLAVIYO_GET_CAMPAIGNS", { channel: "email", sort: "-scheduled_at", ...(q.cursor ? { page_cursor: q.cursor } : {}) });
    const rows = dig(data, arrayOfRecs);
    if (rows === null) throw new EmailToolError("Klaviyo returned no campaign list.", false);
    const since = Date.parse(q.since);
    const campaigns: SentCampaign[] = [];
    let olderOnly = rows.length > 0;
    for (const c of rows) {
      const attrs = sub(c, "attributes");
      const when = str(attrs.send_time) ?? str(attrs.scheduled_at) ?? str(attrs.created_at);
      if (!when || Date.parse(when) >= since) olderOnly = false;
      const state = klaviyoCampaign(c);
      const sentAt = str(attrs.send_time);
      if (!state || !sentAt || state.phase !== "sent" || Date.parse(sentAt) < since) continue;
      campaigns.push({ id: state.id, sent_at: new Date(sentAt).toISOString(), subject: null, list_id: state.audience_ids.length === 1 ? state.audience_ids[0] : null, narrowed: state.narrowed || state.audience_ids.length > 1 });
    }
    const links = sub(dig(data, recWith("links")), "links");
    const nextLink = links.next;
    if (nextLink !== undefined && nextLink !== null && typeof nextLink !== "string") throw new EmailToolError("Klaviyo returned a next page Zavi could not follow.", false);
    return { campaigns, next: olderOnly ? null : urlParam(nextLink || null, "page[cursor]") };
  },
  sizeAudiences: klaviyoSizes,
  async getAudience(call, id) {
    const r = await call("KLAVIYO_GET_LIST", { id, additional__fields__list: ["profile_count"] });
    if (isMissing(r)) return null;
    if (!r.ok) throw toolError(r);
    const l = dig(r.data, (v) => (isRec(v) && str(v.id) === id ? v : null));
    return l ? klaviyoAudience(l) : null;
  },
  async defaultSender(call) {
    const r = await call("KLAVIYO_GET_ACCOUNTS", {});
    if (!r.ok) return { name: null, email: null };
    const account = (dig(r.data, arrayOfRecs) ?? [])[0];
    const contact = sub(sub(account, "attributes"), "contact_information");
    return { name: str(contact.default_sender_name), email: str(contact.default_sender_email) };
  },
  async findCampaignsByTitle(call, title) {
    const data = await read(call, "KLAVIYO_GET_CAMPAIGNS", { channel: "email", sort: "-created_at" });
    const rows = dig(data, arrayOfRecs);
    if (rows === null) throw new EmailToolError("Klaviyo returned no campaign list.", false);
    return rows.map(klaviyoCampaign).filter((c): c is CampaignState => c !== null && c.title === title);
  },
  async getCampaign(call, id) {
    const r = await call("KLAVIYO_GET_CAMPAIGN", { campaign_id: id, include_messages: true });
    if (isMissing(r)) return null;
    if (!r.ok) throw toolError(r);
    const c = dig(r.data, (v) => (isRec(v) && str(v.id) === id ? v : null));
    const parsed = c ? klaviyoCampaign(c) : null;
    const message = (arrayOfRecs(dig(r.data, recWith("included"))?.included) ?? []).find((x) => str(x.type) === "campaign-message");
    const content = sub(sub(message, "attributes"), "content");
    const state = parsed && message
      ? {
          ...parsed,
          envelope: {
            subject: str(content.subject),
            preview_text: str(content.preview_text),
            from_name: str(content.from_label),
            from_email: str(content.from_email),
            reply_to: str(content.reply_to_email),
          },
        }
      : parsed;
    if (!state || state.phase !== "draft") return state;
    const job = await call("KLAVIYO_GET_CAMPAIGN_SEND_JOB", { id });
    const jobStatus = job.ok ? resourceStatus(job.data) : null;
    if (jobStatus === "queued" || jobStatus === "processing") return { ...state, phase: "sending", raw_status: `send job ${jobStatus}` };
    if (jobStatus === "complete") return { ...state, phase: "sent", raw_status: "send job complete" };
    return state;
  },
  async createCampaign(call, i) {
    const data = await write(call, "KLAVIYO_CREATE_CAMPAIGN", {
      data__type: "campaign",
      data__attributes__name: i.title,
      data__attributes__audiences__included: [i.audience_id],
      data__attributes__send__strategy__method: "immediate",
      data__attributes__send__options: { use_smart_sending: false },
      data__attributes__campaign__messages__data: [
        {
          type: "campaign-message",
          attributes: {
            channel: "email",
            label: i.title,
            content: {
              subject: i.subject,
              ...(i.preview_text ? { preview_text: i.preview_text } : {}),
              from_label: i.from_name,
              from_email: i.from_email,
              ...(i.reply_to ? { reply_to_email: i.reply_to } : {}),
            },
          },
        },
      ],
    });
    const id = str(dig(data, (v) => (isRec(v) && str(v.id) && isRec(v.attributes) ? v : null))?.id);
    if (!id) throw new EmailToolError("Klaviyo did not return the new campaign's id.", true);
    return id;
  },
  async setContent(call, campaignId, c) {
    const campaign = await read(call, "KLAVIYO_GET_CAMPAIGN", { campaign_id: campaignId, include_messages: true });
    const messageId = klaviyoMessageId(campaign);
    if (!messageId) throw new EmailToolError("Klaviyo returned the campaign without its email message.", false);
    const template = await write(call, "KLAVIYO_CREATE_TEMPLATE", {
      data__type: "template",
      data__attributes__name: c.title,
      data__attributes__editor__type: "CODE",
      data__attributes__html: c.html,
      data__attributes__text: c.text,
    });
    const templateId = str(dig(template, (v) => (isRec(v) && str(v.id) && isRec(v.attributes) ? v : null))?.id);
    if (!templateId) throw new EmailToolError("Klaviyo did not return the new template's id.", false);
    await write(call, "KLAVIYO_ASSIGN_CAMPAIGN_MESSAGE_TEMPLATE", {
      data__id: messageId,
      data__type: "campaign-message",
      data__relationships__template__data__id: templateId,
      data__relationships__template__data__type: "template",
    });
  },
  async setEnvelope(call, campaignId, e) {
    const campaign = await read(call, "KLAVIYO_GET_CAMPAIGN", { campaign_id: campaignId, include_messages: true });
    const messageId = klaviyoMessageId(campaign);
    if (!messageId) throw new EmailToolError("Klaviyo returned the campaign without its email message.", false);
    await write(call, "KLAVIYO_UPDATE_CAMPAIGN_MESSAGE", {
      id: messageId,
      data__id: messageId,
      data__type: "campaign-message",
      data__attributes__content: {
        subject: e.subject,
        preview_text: e.preview_text ?? "",
        from_label: e.from_name,
        from_email: e.from_email,
        ...(e.reply_to ? { reply_to_email: e.reply_to } : {}),
      },
    });
  },
  async readiness(call, campaignId) {
    const campaign = await read(call, "KLAVIYO_GET_CAMPAIGN", { campaign_id: campaignId, include_messages: true });
    const messageId = klaviyoMessageId(campaign);
    if (!messageId) throw new EmailToolError("Klaviyo returned the campaign without its email message.", false);
    const tpl = await read(call, "KLAVIYO_GET_CAMPAIGN_MESSAGE_TEMPLATE", { id: messageId });
    const templateId = str(dig(tpl, (v) => (isRec(v) && isRec(v.attributes) ? v : null))?.id);
    if (!templateId) throw new EmailToolError("Klaviyo returned the email without its template.", false);
    const rendered = await call("KLAVIYO_CREATE_TEMPLATE_RENDER", { data__id: templateId, data__type: "template", data__attributes__context: {} });
    if (rendered.ok) return { ready: true, reason: null };
    if (KLAVIYO_TEMPLATE_SYNTAX.test(errorText(rendered))) return { ready: false, reason: KLAVIYO_TEMPLATE_REFUSED };
    throw toolError(rendered);
  },
  async liveRecipientCount(call, campaignId, _audienceId, sleep) {
    const started = await call("KLAVIYO_CREATE_CAMPAIGN_RECIPIENT_ESTIMATION_JOB", { campaign_id: campaignId });
    if (!started.ok) return null;
    for (let i = 0; i < ESTIMATE_POLLS; i++) {
      const job = await call("KLAVIYO_GET_CAMPAIGN_RECIPIENT_ESTIMATION_JOB", { id: campaignId });
      const status = job.ok ? resourceStatus(job.data) : null;
      if (status === "complete") break;
      if (status === "cancelled" || status === "failed") return null;
      if (i === ESTIMATE_POLLS - 1) return null;
      await sleep(ESTIMATE_WAIT_MS);
    }
    const est = await call("KLAVIYO_GET_CAMPAIGN_RECIPIENT_ESTIMATION", { id: campaignId });
    if (!est.ok) return null;
    const attrs = dig(est.data, (v): Rec | null => (isRec(v) && "estimated_recipient_count" in sub(v, "attributes") ? sub(v, "attributes") : null));
    return attrs ? count(attrs.estimated_recipient_count) : null;
  },
  send(call, campaignId) {
    return call("KLAVIYO_CREATE_CAMPAIGN_SEND_JOB", { data__type: "campaign-send-job", data__id: campaignId });
  },
  async readContent(call, campaignId) {
    const campaign = await read(call, "KLAVIYO_GET_CAMPAIGN", { campaign_id: campaignId, include_messages: true });
    const c = dig(campaign, (v) => (isRec(v) && isRec(v.relationships) ? v : null));
    const messages = arrayOfRecs(sub(sub(c, "relationships"), "campaign-messages").data) ?? [];
    if (messages.length !== 1) return { proof: "unprovable", why: messages.length === 0 ? "Klaviyo returned no email message" : "the campaign has more than one message" };
    const messageId = str(messages[0].id);
    if (!messageId) return { proof: "unprovable", why: "Klaviyo returned no email message" };
    const tpl = await read(call, "KLAVIYO_GET_CAMPAIGN_MESSAGE_TEMPLATE", { id: messageId });
    const attrs = sub(dig(tpl, (v) => (isRec(v) && isRec(v.attributes) ? v : null)), "attributes");
    const editor = str(attrs.editor_type);
    if (editor !== "CODE") return { proof: "unprovable", why: `the template is not a code template (${editor ?? "none"})` };
    if (typeof attrs.html !== "string") return { proof: "unprovable", why: "Klaviyo returned no html" };
    if (typeof attrs.text !== "string") return { proof: "unprovable", why: "Klaviyo returned no plain-text part" };
    return { proof: "ok", html: attrs.html, text: attrs.text };
  },
  async results(call, campaignId) {
    const many = await klaviyoResultsMany(call, [campaignId], null);
    return many.get(campaignId) ?? NO_RESULTS;
  },
  resultsMany(call, campaignIds, cacheKey) {
    return klaviyoResultsMany(call, campaignIds, cacheKey);
  },
};

export const EMAIL_PROVIDERS: Readonly<Record<EmailTool, EmailProvider>> = { mailchimp, klaviyo, sendgrid };
