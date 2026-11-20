
import { deliveryOf, deliveryReason, type DeliveryState } from "./delivery";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { EMAIL_TOOL_LABEL } from "@/services/connectors/email-campaign/providers";
import { cardOutcome, cardSendState, emailCardLink, type CardOutcome, type EmailCardRail, type SendFacts, type ViewState } from "@/services/email-cards/cards";
import { judgedOnCarried, winLineText, type WinLine } from "./win-line";
import { notEmailedLine, stalledSendNote } from "@/services/email-cards/recovery";
import { holdSentence } from "@/services/comms/bulk-outbound/notices";

export type Route = "sendgrid" | "mailchimp" | "klaviyo" | "zavi_list";
export const ROUTE_LABEL: Record<Route, string> = { ...EMAIL_TOOL_LABEL, zavi_list: "Zavi" };

export type Cell = { value: number | null; why: string | null; action?: "connect_ga" };

export type SentEmailRow = {
  card: { rail: EmailCardRail; id: string; link: string };
  route: Route;
  sent_with: string;
  subject: string;
  list_id: string | null;
  list_name: string | null;
  timezone: string;
  started_at: string | null;
  finished_at: string | null;
  spanned: boolean;
  stage: "sending" | "paused" | "h1_due" | "h1" | "d7";
  people: { sent: number | null; total: number | null; stopped: boolean };
  as_of: "h1" | "d7" | null;
  delivery: DeliveryState | null;
  delivery_reason: string | null;
  delivery_skipped: number;
  delivered: Cell;
  opens: Cell;
  opens_label: string;
  opens_unique: boolean;
  clicks: Cell;
  unsubscribes: Cell;
  visitors: Cell;
  win_line: { text: string; metric: string | null; threshold: number | null; basis: string };
  verdict: "beat" | "below" | "baseline" | "no_signal" | "unknown" | null;
  verdict_text: string;
  d7_due_at: string | null;
  note: string | null;
  numbers_note: string | null;
  stopped_at_1_hour: boolean;
  stop_note: string | null;
  outcome: CardOutcome;
};

type ResultRecord = {
  rail: EmailCardRail;
  card_id: string;
  route: Route;
  subject: string;
  list_id: string | null;
  list_name: string | null;
  campaign_slug: string | null;
  shared_tag: boolean;
  sent_count: number;
  total_count: number | null;
  started_at: string;
  finished_at: string;
  win_line: WinLine | Record<string, never>;
  h1: Record<string, unknown>;
  d7: Record<string, unknown>;
  d7_published_at: string | null;
  verdict: SentEmailRow["verdict"];
  note: string | null;
};

const RESULT_COLUMNS =
  "rail, card_id, route, subject, list_id, list_name, campaign_slug, shared_tag, sent_count, total_count, started_at, finished_at, win_line, h1, d7, d7_published_at, verdict, note";

const D7_MS = 7 * 86_400_000;
const H1_MS = 3_600_000;

function fmtDay(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
}

function dueText(dueMs: number, now: number, tz: string): string {
  return now < dueMs ? `Due ${fmtDay(new Date(dueMs).toISOString(), tz)}` : "Reading now";
}

export function firstNumbersText(finishedAt: string, now: number, tz: string): string {
  const dueMs = Date.parse(finishedAt) + H1_MS;
  if (now >= dueMs) return "Reading now";
  return `First numbers around ${new Date(dueMs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })}`;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const CARRIED_WHY = "From the 1-hour check";

export function providerCell(stage: Record<string, unknown>, key: "delivered" | "opens" | "clicks" | "unsubscribes", route: Route, waiting: string | null = null): Cell {
  const v = num(stage[key]);
  if (v !== null) return { value: v, why: Array.isArray(stage.from_h1) && stage.from_h1.includes(key) ? `${CARRIED_WHY}: day 7 could not be read` : null };
  if (waiting && !(route === "zavi_list" && key === "clicks")) return { value: null, why: waiting };
  if (stage.provider_status === "disconnected") return { value: null, why: "Disconnected before this was read" };
  if (stage.reported_empty === true) return { value: null, why: `${ROUTE_LABEL[route]} reported no numbers for this email` };
  if (stage.provider_status === "could_not_read") return { value: null, why: `${ROUTE_LABEL[route]} could not be read` };
  if (route === "zavi_list") {
    if (key === "clicks") return { value: null, why: "Click tracking is off for Zavi's sender: see Visitors" };
    if (key === "delivered" || key === "opens") return { value: null, why: "No delivery report from the sender yet" };
  }
  if (stage.provider_status === "ok") return { value: null, why: `${ROUTE_LABEL[route]} does not report this` };
  return { value: null, why: "Not read yet" };
}

const SHOWN_COUNTS = ["delivered", "opens", "clicks", "unsubscribes"];

export function carriedNote(stage: Record<string, unknown>, route: Route, stored: string | null = null): string | null {
  if (stage.provider_status !== "disconnected" && stage.provider_status !== "could_not_read") return null;
  const carried = Array.isArray(stage.from_h1) ? stage.from_h1 : [];
  if (!SHOWN_COUNTS.some((k) => carried.includes(k) && num(stage[k]) !== null)) return null;
  if (stored && /numbers stopped at 1 hour\.$/.test(stored)) return stored;
  return `${ROUTE_LABEL[route]} ${stage.provider_status === "disconnected" ? "was disconnected" : "could not be read"}; numbers stopped at 1 hour.`;
}

export { judgedOnCarried };

function currentNote(stage: Record<string, unknown>, stored: string | null): string | null {
  const stopped = !!stored && /numbers stopped (at 1 hour|before the 1-hour check)\.$/.test(stored);
  return stopped && SHOWN_COUNTS.some((k) => num(stage[k]) !== null) ? null : stored;
}

export const VISITORS_RULE = "People who reached your site from this email's link, counted from the hour the send started, so your own test emails are left out";

const GA_WAITING = "Waiting for Google Analytics";

export function visitorsCell(r: Pick<ResultRecord, "campaign_slug" | "shared_tag" | "d7" | "d7_published_at" | "finished_at">, now: number = Date.now(), tz: string = "UTC"): Cell {
  if (!r.campaign_slug) return { value: null, why: "Not tagged" };
  if (r.shared_tag || r.d7.ga_status === "shared_tag") return { value: null, why: "Shared tag: another email used the same tag" };
  const v = num(r.d7.visitors);
  if (v !== null) return { value: v, why: VISITORS_RULE };
  if (r.d7.ga_status === "not_connected") return { value: null, why: "Connect Google Analytics", action: "connect_ga" };
  if (r.d7.ga_status === "property_changed") return { value: null, why: "Google Analytics property changed" };
  if (r.d7.ga_status === "could_not_read") return { value: null, why: "Google Analytics could not be read" };
  return { value: null, why: dueText(Date.parse(r.finished_at) + D7_MS + 12 * 3_600_000, now, tz) };
}

export const ZAVI_UNSUB_NOTE = "Someone on two of your sends that week counts on both";

const VERDICT_TEXT: Record<NonNullable<SentEmailRow["verdict"]>, string> = {
  beat: "Beat the win line",
  below: "Below the win line",
  baseline: "First send: sets your baseline",
  no_signal: "No click or visitor signal",
  unknown: "Could not tell",
};

export const STOPPED_VERDICT_TEXT = "Numbers stopped at 1 hour: not judged";

export type EndedHold = {
  decision_id: string;
  status: string;
  hold_reason: string | null;
  total?: number | null;
  sent?: number | null;
  skipped?: number | null;
  failed?: number | null;
  unknown?: number | null;
  hard_bounces?: number | null;
  created_at?: string | null;
  finished_at?: string | null;
  next_run_at?: string | null;
};

const BULK_FACT_COLUMNS = "decision_id, status, hold_reason, total, sent, skipped, failed, unknown, hard_bounces, created_at, finished_at, next_run_at";

function bulkFacts(h: EndedHold, sent: number, total: number | null): NonNullable<SendFacts>["bulk"] {
  return {
    status: h.status,
    hold_reason: h.hold_reason,
    total: Number(h.total ?? total ?? 0),
    sent: Number(h.sent ?? sent),
    skipped: Number(h.skipped ?? 0),
    failed: Number(h.failed ?? 0),
    unknown: Number(h.unknown ?? 0),
    hard_bounces: Number(h.hard_bounces ?? 0),
    created_at: h.created_at ?? "",
    finished_at: h.finished_at ?? null,
    next_run_at: h.next_run_at ?? null,
  };
}

function resultOutcome(r: ResultRecord, hold: EndedHold | undefined): CardOutcome {
  const zavi = r.route === "zavi_list";
  const facts: SendFacts = {
    card: { status: "acted", exec_status: "executed", approved: true, executed_at: r.finished_at, dispatched_at: r.started_at },
    bulk: r.rail === "decisions" && zavi && hold ? bulkFacts(hold, r.sent_count, r.total_count) : null,
    results: { sent_count: r.sent_count, finished_at: r.finished_at, h1: r.h1 ?? {}, d7: r.d7 ?? {}, d7_published: r.d7_published_at !== null, note: r.note },
  };
  const view = { status: "acted", class: zavi ? "bulk_outbound.send" : undefined, body: zavi ? {} : { tool: r.route } } as unknown as ViewState;
  return cardOutcome(cardSendState(r.rail, view, facts), facts);
}

export function stopNoteOf(hold: EndedHold | undefined, sent: number, total: number | null): string | null {
  if (!hold || hold.status !== "held" || RESUMABLE.has(hold.hold_reason ?? "")) return null;
  if (hold.hold_reason === "fanout_stalled") return stalledSendNote(sent, total);
  const why = hold.hold_reason === "stopped" ? "You stopped this send." : `Zavi stopped this send: ${holdSentence(hold.hold_reason)}.`;
  return `${why} ${notEmailedLine(sent, total)}`;
}

export function rowFromResult(r: ResultRecord, now: number = Date.now(), tz: string = "UTC", hold?: EndedHold): SentEmailRow {
  const published = r.d7_published_at !== null;
  const stage = published ? r.d7 : r.h1;
  const hasH1 = Object.keys(r.h1 ?? {}).length > 0;
  const zavi = r.route === "zavi_list";
  const win = (r.win_line ?? {}) as Partial<WinLine>;
  const stoppedAtOneHour = published && judgedOnCarried(r.d7, win.metric);
  const d7Due = new Date(Date.parse(r.finished_at) + D7_MS).toISOString();
  const waiting = !published && !hasH1 ? firstNumbersText(r.finished_at, now, tz) : null;
  const cell = (key: "delivered" | "opens" | "clicks" | "unsubscribes") => providerCell(stage, key, r.route, waiting);
  const unsub = cell("unsubscribes");
  const outcome = resultOutcome(r, hold);
  const delivery = deliveryOf(r.route, r.h1, published ? r.d7 : null);
  return {
    card: { rail: r.rail, id: r.card_id, link: emailCardLink(r.rail, r.card_id) },
    route: r.route,
    sent_with: ROUTE_LABEL[r.route],
    subject: r.subject,
    list_id: r.list_id ?? null,
    list_name: r.list_name,
    timezone: tz,
    started_at: r.started_at,
    finished_at: r.finished_at,
    spanned: Date.parse(r.finished_at) - Date.parse(r.started_at) > 3_600_000,
    stage: published ? "d7" : hasH1 ? "h1" : "h1_due",
    people: { sent: delivery ? delivery.people : r.sent_count, total: r.total_count, stopped: r.total_count !== null && r.total_count > r.sent_count },
    delivery: delivery?.state ?? null,
    delivery_reason: deliveryReason(r.route, delivery),
    delivery_skipped: delivery?.skipped ?? 0,
    as_of: published ? "d7" : hasH1 ? "h1" : null,
    delivered: cell("delivered"),
    opens: cell("opens"),
    opens_label: zavi ? "Opens (all)" : "Opens",
    opens_unique: !zavi,
    clicks: cell("clicks"),
    unsubscribes: zavi && unsub.value !== null ? { ...unsub, why: [unsub.why, ZAVI_UNSUB_NOTE].filter(Boolean).join(". ") } : unsub,
    visitors: published ? visitorsCell(r, now, tz) : r.campaign_slug ? { value: null, why: dueText(Date.parse(r.finished_at) + D7_MS + 12 * 3_600_000, now, tz) } : visitorsCell(r, now, tz),
    win_line: { text: winLineText(win as WinLine), metric: win.metric ?? null, threshold: win.threshold ?? null, basis: win.basis ?? "no_signal" },
    verdict: stoppedAtOneHour ? "unknown" : published ? r.verdict : null,
    verdict_text: stoppedAtOneHour ? STOPPED_VERDICT_TEXT : published ? (r.verdict ? VERDICT_TEXT[r.verdict] : GA_WAITING) : dueText(Date.parse(d7Due), now, tz),
    d7_due_at: published ? null : d7Due,
    note: published ? currentNote(r.d7, r.note) : r.note,
    numbers_note: published ? carriedNote(r.d7, r.route, r.note) : null,
    stopped_at_1_hour: stoppedAtOneHour,
    stop_note: r.rail === "decisions" && zavi ? (outcome.may_have_sent ? outcome.reason : stopNoteOf(hold, r.sent_count, r.total_count)) : null,
    outcome,
  };
}

type InFlight = EndedHold & { sent: number; total: number; created_at: string; subject: string; list_id: string | null; list_name: string | null };
const RESUMABLE = new Set(["abuse_complaints", "abuse_bounces", "provider_refused", "bulk_check_failed", "email_paused"]);

export function rowFromInFlight(s: InFlight, tz: string = "UTC"): SentEmailRow {
  const empty: Cell = { value: null, why: "After the send finishes" };
  const paused = s.status === "held";
  const facts: SendFacts = { card: { status: "acted", approved: true, dispatched_at: s.created_at }, bulk: bulkFacts(s, s.sent, s.total), results: null };
  const outcome = cardOutcome(cardSendState("decisions", { status: "acted", class: "bulk_outbound.send", body: {} } as unknown as ViewState, facts), facts);
  return {
    card: { rail: "decisions", id: s.decision_id, link: emailCardLink("decisions", s.decision_id) },
    route: "zavi_list",
    sent_with: ROUTE_LABEL.zavi_list,
    subject: s.subject,
    list_id: s.list_id ?? null,
    list_name: s.list_name,
    timezone: tz,
    started_at: s.created_at,
    finished_at: null,
    spanned: false,
    stage: paused ? "paused" : "sending",
    people: { sent: s.sent, total: s.total, stopped: false },
    delivery: null,
    delivery_reason: null,
    delivery_skipped: 0,
    as_of: null,
    delivered: empty,
    opens: empty,
    opens_label: "Opens (all)",
    opens_unique: false,
    clicks: empty,
    unsubscribes: empty,
    visitors: empty,
    win_line: { text: "Set when the send finishes", metric: null, threshold: null, basis: "pending" },
    verdict: null,
    verdict_text: paused ? `Paused after ${s.sent} of ${s.total}` : `Sending, ${s.sent} of ${s.total} so far`,
    d7_due_at: null,
    note: null,
    numbers_note: null,
    stopped_at_1_hour: false,
    stop_note: null,
    outcome,
  };
}

export type ViewDeps = {
  results: (tenantId: string, limit: number) => Promise<ResultRecord[]>;
  inFlight: (tenantId: string) => Promise<InFlight[]>;
  holds: (tenantId: string, decisionIds: string[]) => Promise<EndedHold[]>;
  zone: (tenantId: string) => Promise<string>;
};

const LIVE: ViewDeps = {
  zone: async (tenantId) => {
    try {
      const { resolveReportingTimezone } = await import("@/services/analytics/tenant-timezone");
      return (await resolveReportingTimezone(tenantId, { persist: false })).tz;
    } catch {
      return "UTC";
    }
  },
  results: async (tenantId, limit) => {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("email_send_results")
      .select(RESULT_COLUMNS)
      .order("finished_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error("email_send_results read failed");
    return (data ?? []) as unknown as ResultRecord[];
  },
  inFlight: async (tenantId) => {
    const db = tenantClient(asTenantId(tenantId));
    const { data, error } = await db
      .from("email_bulk_sends")
      .select(`${BULK_FACT_COLUMNS}, subject, list_id`)
      .in("status", ["sending", "waiting_for_tomorrow", "held"])
      .gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error("email_bulk_sends read failed");
    const rows = ((data ?? []) as Array<Omit<InFlight, "list_name">>).filter((s) => s.status !== "held" || RESUMABLE.has(s.hold_reason ?? ""));
    if (rows.length === 0) return [];
    const { data: decisions, error: dErr } = await db.from("decisions").select("id, body").in("id", rows.map((r) => r.decision_id));
    if (dErr) throw new Error("decisions read failed");
    const names = new Map(((decisions ?? []) as Array<{ id: string; body?: { list_name?: unknown } }>).map((d) => [d.id, typeof d.body?.list_name === "string" ? d.body.list_name : null]));
    return rows.map((r) => ({ ...r, list_name: names.get(r.decision_id) ?? null }));
  },
  holds: async (tenantId, decisionIds) => {
    if (decisionIds.length === 0) return [];
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("email_bulk_sends")
      .select(BULK_FACT_COLUMNS)
      .in("decision_id", decisionIds);
    if (error) throw new Error("email_bulk_sends read failed");
    return (data ?? []) as EndedHold[];
  },
};

export const SENT_EMAILS_LIMIT = 50;

export async function listSentEmailsPage(
  tenantId: string,
  limit = SENT_EMAILS_LIMIT,
  depsIn: Partial<ViewDeps> = {},
): Promise<{ emails: SentEmailRow[]; more: boolean }> {
  const deps = { ...LIVE, ...depsIn };
  const cap = Math.min(Math.max(limit, 1), 200);
  const [read, going, tz] = await Promise.all([deps.results(tenantId, cap + 1), deps.inFlight(tenantId), deps.zone(tenantId)]);
  const results = read.slice(0, cap);
  const done = new Set(results.map((r) => `${r.rail}:${r.card_id}`));
  const zaviIds = results.filter((r) => r.rail === "decisions" && r.route === "zavi_list" && r.total_count !== null).map((r) => r.card_id);
  const holds = new Map((await deps.holds(tenantId, zaviIds)).map((h) => [h.decision_id, h]));
  return {
    emails: [...going.filter((g) => !done.has(`decisions:${g.decision_id}`)).map((g) => rowFromInFlight(g, tz)), ...results.map((r) => rowFromResult(r, Date.now(), tz, holds.get(r.card_id)))],
    more: read.length > cap,
  };
}

export async function listSentEmails(tenantId: string, limit = SENT_EMAILS_LIMIT, depsIn: Partial<ViewDeps> = {}): Promise<SentEmailRow[]> {
  return (await listSentEmailsPage(tenantId, limit, depsIn)).emails;
}
