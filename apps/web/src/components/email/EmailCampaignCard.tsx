"use client";

import { cardButton } from "@/components/workspace/actions/card/styles";
import { ActionTooltip } from "../workspace/actions/ActionTooltip";
import { actionHint } from "../workspace/actions/actionHints";

import { useCallback, useEffect, useId, useRef, useState, type HTMLAttributes } from "react";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";
import { CalendarClock, Eye, Lock, Mail, Monitor, Pencil, Send, Smartphone, TriangleAlert } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase";
import { rejectDecision } from "@/lib/approvals/approveDecision";
import type { DecisionSurface } from "@/lib/approvals/decisionApi";
import { getVerifiedUser } from "@/lib/verifiedUser";
import { announceEmailCardChanged, onEmailCardChanged } from "@/lib/workspace/emailCardEvents";
import { hideEmailCard, unhideEmailCard, useEmailCardHidden } from "@/lib/workspace/emailCardHidden";
import { useTabHidden } from "@/components/workspace/layout/tabHidden";
import { isAmbiguousPlanError, newRequestId, schedulePlanned, timedFetch, withdrawPlanned, type CardOutcome, type PlanError } from "@/lib/workspace/emailPlanApi";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { EMAIL_SEND_HOLDS, type EmailSendHold } from "@/lib/workspace/emailCampaignSettingsApi";
import { DONT_SEND_LINE, PLANNED_STOP_LINE, planOpNotice, planOpResolved, sameIntent, withPlanOpAnswer, type PlanOp, type PlanRead } from "./plannedOp";

export { DONT_SEND_LINE, PLANNED_STOP_LINE };
import { cn } from "@/lib/cn";
import { SLIP_PRIMARY, SLIP_QUIET, SLIP_SECONDARY, SlipSlab, SlipTracker } from "@/components/agents/slip/SlipParts";
import { emailSlipHero, emailSlipStage, emailSlipSteps, STALLED_WORD } from "./emailSlip";
import { DELIVERY_UNKNOWN, STOPPED_REST_LINE, stoppedAfter } from "./sendOutcomeCopy";

export type EmailCardRail = "channel_actions" | "decisions";

export type EmailCardView = {
  rail: EmailCardRail;
  id: string;
  class: string;
  status: string;
  open: boolean;
  route: string;
  list: { name: string; people: number | null; unchecked?: boolean; left_out?: number };
  sender: { email: string; name: string | null };
  reply_to: string | null;
  unsubscribe_group_id: string | null;
  unsubscribe_group_name?: string | null;
  viewer_can_approve: boolean;
  chosen_variant: number | null;
  versions: Array<{
    variant: number;
    subject: string;
    preview_text: string;
    html: string;
    content?: EmailContent;
    seen?: string;
    tested_by_me: boolean;
    tested_by_approver: boolean;
  }>;
  replaced_by?: { rail: EmailCardRail; id: string } | null;
  editable?: boolean;
  retryable?: boolean;
  test_list?: boolean;
  test_list_unknown?: boolean;
  failure_reason?: string | null;
  may_have_sent?: boolean;
  delivery?: "unconfirmed" | "reached" | "nobody";
  skipped_count?: number;
  left_out_count?: number;
  suppression?: { suppressed: number; complete: boolean } | null;
  reconciliation_pending?: boolean;
  pause_hold?: "paused" | "resumed" | null;
  outcome?: CardOutcome | null;
  dispatching_since?: string | null;
  sent_at?: string | null;
  sent_count?: number | null;
  results?: EmailResults | null;
  hour_1?: EmailResultCounts | null;
  day_7?: EmailResultCounts | null;
  viewer_email?: string | null;
  can_approve: boolean[];
  reasons: string[];
  win_line?: { text: string; metric: string | null; threshold: number | null; frozen: boolean } | null;
  learnings_read?: { status: "ok" | "empty" | "read_failed" | "snapshot_failed" | null; items: Array<{ id: string; text: string }> };
  planned?: PlannedOnCard | null;
  planned_expected?: boolean;
};

export type EmailResultCounts = {
  delivered?: number | null;
  delivered_label?: string | null;
  opens?: number | null;
  clicks?: number | null;
  unsubscribes?: number | null;
  unsubscribes_note?: string | null;
  bounces?: number | null;
  why?: { delivered?: string | null; opens?: string | null; clicks?: string | null } | null;
  note?: string | null;
};
export type EmailResults = EmailResultCounts;

export type PlannedOnCard = {
  id: string;
  planned_at: string;
  planned_label: string;
  timezone: string;
  status: string;
  status_reason: string | null;
  reason: string | null;
  schedule_gen: number;
  content_version: number;
  vetoed: boolean;
  scheduled: { variant: number; count: number; by: string } | null;
};

export type EmailContent = {
  subject: string;
  preview_text: string;
  title: string;
  hero?: { big: string; small: string };
  paragraphs: string[];
  button: { label: string; url: string };
  cards?: Array<{ title: string; meta: string; price?: string; url?: string; image_url?: string }>;
};

export const TEST_LIST_LINE =
  "This list is marked as a test list, so Zavi does not send a real email to it. Unmark it in Email campaigns settings, or ask Zavi for a new draft to another list.";
export const TEST_LIST_UNKNOWN_LINE = "Zavi could not check your test lists right now, so this can't be approved yet. Reload in a minute.";
export const LOCKED_FIELDS_LINE = "To change the list, the sender or the unsubscribe group, ask Zavi in chat for a new draft.";
export const EDIT_VOIDS_TEST_LINE = "Saved. This version changed, so send yourself a new test before approving.";
export const EDIT_VOIDS_TEST_MEMBER_LINE = "Saved. This version changed, so send yourself a new test, then ask an owner or admin to approve.";
export const SCHEDULED_EDIT_LINE = "This email is scheduled to go out. Use Move or Don't send in Coming up first, then edit it.";

export const REDRAFT_LINE = "Ask Zavi to draft this email again. It was written before emails had versions, so it cannot be sent from here.";
export const CANNOT_UNDO = "This can't be stopped or undone once sent.";
export const PLAN_UNREAD_LINE = "This email belongs to a planned email, and Zavi could not load its plan just now. Nothing can be sent from here until it loads.";
export const PLANNED_IMPORT_LINE =
  "It goes to the list as it was imported when this was drafted. If the list is imported again before then, Autopilot does not send it.";

const ROUTE_LABEL: Record<string, string> = {
  sendgrid: "SendGrid · Single Send",
  mailchimp: "Mailchimp campaign",
  klaviyo: "Klaviyo campaign",
  zavi_list: "Sent by Zavi",
};
const TOOL_NAME: Record<string, string> = { sendgrid: "SendGrid", mailchimp: "Mailchimp", klaviyo: "Klaviyo" };
const TOOL_LOGO: Record<string, { src: string; tile: string }> = {
  sendgrid: { src: "/logos/sendgrid-icon.svg", tile: "bg-ca-bg" },
  mailchimp: { src: "/logos/mailchimp-icon.svg", tile: "bg-[#ffe01b]" },
  klaviyo: { src: "/logos/klaviyo-icon.svg", tile: "bg-[#232426]" },
};

export const cardPoll = { ms: 5_000, pausedMs: 60_000, dispatchingMs: 30 * 60_000, scheduledFarMs: 15 * 60_000, scheduledLeadMs: 2 * 60_000 };
const HEADER_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export const ZAVI_LIST_CAP = 1000;
export const PAUSED_LINE = "Email is paused for this workspace, so this send has not started. It starts when an owner or admin resumes email in Email campaigns settings.";
export const PAUSED_TOOL_LINE = "Email is paused for this workspace, so Zavi does not start this send. Resume email in Email campaigns settings, then try again from this card.";
export const RESUMED_LINE = "Email is on again. Zavi starts this send within a few minutes.";
export const DISPATCH_UNKNOWN_TITLE = "May have gone out. Zavi is checking.";
export const OUTCOME_UNKNOWN_LINE = "May have gone out.";
export const DISPATCH_UNKNOWN_LINE = "Zavi has not heard back about this send for a while, so it may have gone out. Do not send it again from your email tool yet. This card stopped checking by itself: refresh to see where it stands.";
const POLL_STATUSES = new Set(["approved", "queued", "dispatching", "sending", "waiting_for_tomorrow", "held"]);
const IN_FLIGHT_STATUSES = new Set(["approved", "queued", "dispatching", "sending", "waiting_for_tomorrow", "held"]);
const STOPPABLE_STATUSES = new Set(["sending", "waiting_for_tomorrow", "held"]);
const RESUMABLE_STATUSES = new Set(["approved", "queued"]);
const FAILED_STATUSES = new Set(["failed", "dispatch_failed"]);
const OUTCOME_STATUSES = new Set(["sent", "partially_sent", "outcome_unknown", "stopped", "not_sent"]);
const DEFINITE_CODES = new Set(["count_required", "plan_unreadable", "provider_refused", "not_stoppable"]);
export const LIST_UNCHECKED_LINE = "Zavi could not check how many people are on this list right now.";
const COUNT_MISSING = "Zavi could not count the people on the list right now, so nothing was sent. Try again in a minute.";
export const KLAVIYO_TEST_LINE = "Klaviyo has no test send, so Zavi sent this copy outside Klaviyo. The real email goes out from your Klaviyo sender.";
const ZAVI_LIST_PACE = "in batches that grow each day while your sending address warms up, so it can take a few days";
export const ZAVI_LIST_STOP_LINE = "People who have not been sent yet can still be stopped from this card.";

function sentBy(c: Pick<EmailCardView, "route" | "sender">, withAddress: boolean): string {
  if (c.route === "zavi_list") return withAddress ? `Sent by Zavi from ${c.sender.email}` : "Sent by Zavi from your sending address";
  return `via ${TOOL_NAME[c.route] ?? c.route}`;
}

function fromLine(c: Pick<EmailCardView, "sender">): string {
  return c.sender.name ? `${c.sender.name} <${c.sender.email}>` : c.sender.email;
}

function sendConfirmLine(c: EmailCardView, versionLetter: string, subject: string): string {
  const head = `${versionLetter} "${subject}" goes to ${c.list.name} from ${fromLine(c)}`;
  if (c.route === "zavi_list") {
    return `${head}. Sent by Zavi ${ZAVI_LIST_PACE}. ${ZAVI_LIST_STOP_LINE}`;
  }
  return `${head} ${sentBy(c, true)}. ${CANNOT_UNDO}`;
}

function sendingLine(c: Pick<EmailCardView, "route" | "sender">): string {
  if (c.route === "zavi_list") return `${sentBy(c, false)}, ${ZAVI_LIST_PACE}. This card checks every few seconds and updates as each batch goes out.`;
  return "Zavi sends it now. This card checks every few seconds and updates when it is done.";
}

function reach(c: Pick<EmailCardView, "route">, n: number): number {
  return c.route === "zavi_list" ? Math.min(n, ZAVI_LIST_CAP) : n;
}

function sendTitle(c: Pick<EmailCardView, "route">, n: number): string {
  return reach(c, n) < n ? `Send to ${people(reach(c, n))} of the ${n.toLocaleString("en-US")} on this list?` : `Send to ${people(n)}?`;
}

function capLine(c: Pick<EmailCardView, "route">, n: number): string {
  const left = n - reach(c, n);
  if (left <= 0) return "";
  return ` Zavi sends one email to at most ${ZAVI_LIST_CAP.toLocaleString("en-US")} people, so ${people(left)} on this list do not get this one. Each email picks its ${ZAVI_LIST_CAP.toLocaleString("en-US")} at random, so it is not the same people left out every time.`;
}

function zoneAbbr(at: string, timeZone: string): string | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(at)).find((x) => x.type === "timeZoneName");
    return part?.value ?? null;
  } catch {
    return null;
  }
}

const BRAND_WORDS: ReadonlySet<string> = new Set(["Mailchimp", "Klaviyo", "SendGrid"]);

const FOUNDER_SENTENCE_SHAPE = /^["\u201c]?[A-Z][A-Za-z0-9 ,.;:'"\u2018\u2019\u201c\u201d!?()&%$#+>\-\u2013\u2014]*[.!?"\u201d]$/;

const QUOTED_NAME = /(?<=\b(?:named|on|list) )"([\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200d\ufe0f ,.;:'!?()&%$#+*=~\-\u2013\u2014\u2018\u2019/_|@]{1,200}?)"/gu;

function maskNames(t: string): string {
  return t
    .replace(QUOTED_NAME, (all, name: string) => (/:\/\/|[A-Za-z]Error\b|\/[a-z_]+\//.test(name) ? all : '"Name"'))
    .replace(/(?<=(?:this: |uses ))[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}/g, "address")
    .replace(/\$[0-9][0-9,]{0,9}(?:\.[0-9]{2})?\/mo\b/g, "$$1");
}

const RAW_TOOL_TEXT = /\bHTTP\b|status code \d{3}|\b[A-Za-z]*Error:|\d{4,}|\d+\.\d+\.\d+|\bv\d+\.\d+|[^\s,;:()"'.!?]{16,}|(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{5,}/i;

export function founderReason(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  const shape = maskNames(t);
  if (!t || t.length > 1200 || !FOUNDER_SENTENCE_SHAPE.test(shape)) return null;
  if (RAW_TOOL_TEXT.test(shape) || /\b[A-Z]{4,}\b/.test(shape)) return null;
  return (shape.match(/[A-Za-z]*[a-z][A-Z][A-Za-z]*/g) ?? []).every((w) => BRAND_WORDS.has(w)) ? t : null;
}

function withFounderReason(c: EmailCardView): EmailCardView {
  const o = c.outcome ? { ...c.outcome, reason: founderReason(c.outcome.reason) } : c.outcome;
  return c.failure_reason === undefined ? { ...c, outcome: o } : { ...c, failure_reason: founderReason(c.failure_reason), outcome: o };
}

export const cardMayHaveSent = (c: EmailCardView): boolean => (c.outcome ? c.outcome.may_have_sent : c.may_have_sent === true);

export const cardSendReason = (c: EmailCardView): string | null => (cardMayHaveSent(c) && c.outcome?.reason) || c.failure_reason || null;

function withZone(c: EmailCardView): EmailCardView {
  const p = c.planned;
  if (!p) return c;
  const z = zoneAbbr(p.planned_at, p.timezone);
  if (!z || p.planned_label.endsWith(` ${z}`)) return c;
  return { ...c, planned: { ...p, planned_label: `${p.planned_label} ${z}` } };
}

function formatWhen(at: string): string | null {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
}

function statusPill(c: EmailCardView): { text: string; tone: "open" | "wait" | "ok" | "bad" } {
  if (c.open) return { text: "Needs your approval", tone: "open" };
  const L = c.chosen_variant ? letter(c.chosen_variant) : null;
  const tag = (word: string) => (L ? `${word}: ${L}` : word);
  if (c.pause_hold === "paused") return { text: L ? `Approved: ${L}, email paused` : "Email paused", tone: "wait" };
  if (cardMayHaveSent(c) && !IN_FLIGHT_STATUSES.has(c.status)) return { text: tag(DELIVERY_UNKNOWN), tone: "bad" };
  switch (c.status) {
    case "approved":
    case "queued":
    case "dispatching":
      return { text: L ? `Approved: ${L}, starting` : "Starting", tone: "wait" };
    case "sending":
      return { text: L ? `Sending ${L}` : "Sending", tone: "wait" };
    case "waiting_for_tomorrow":
      return { text: L ? `Sending ${L}, more tomorrow` : "Sending, more tomorrow", tone: "wait" };
    case "held":
      return { text: tag("On hold"), tone: "wait" };
    case "sent":
      if (c.delivery === "nobody") return { text: tag("Nobody reached"), tone: "bad" };
      if (c.delivery === "unconfirmed") return { text: tag("Sent"), tone: "wait" };
      if ((c.skipped_count ?? 0) > 0) return { text: tag("Some skipped"), tone: "bad" };
      return { text: tag("Sent"), tone: "ok" };
    case "partially_sent":
      return { text: tag("Partly sent"), tone: "bad" };
    case "outcome_unknown":
      return { text: tag(DELIVERY_UNKNOWN), tone: "bad" };
    case "stopped":
      return { text: tag("Stopped"), tone: "bad" };
    case "failed":
    case "dispatch_failed":
      return { text: tag("Failed"), tone: "bad" };
    case "not_sent":
      return { text: "Not sent", tone: "bad" };
    case "rejected":
      return { text: "Rejected", tone: "bad" };
    default:
      return { text: L ? `Approved: ${L}` : "Decided", tone: "ok" };
  }
}

const letter = (n: number) => String.fromCharCode(64 + n);
const people = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`;
const FRAME = "slip-container relative w-full min-w-0 overflow-hidden rounded-2xl border border-ca-strong bg-ca-bg text-ca-xdark";
const SLIP_SMALL = `${cardButton.base} ${cardButton.secondary}`;
const BTN = "inline-flex h-10 items-center gap-2 rounded-cta px-3 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ca-focus disabled:cursor-not-allowed disabled:opacity-40";
const SECONDARY = `${BTN} border border-ca-border bg-ca-bg text-ca-xdark hover:bg-ca-subtle`;
const WIDTH_TOGGLE = "relative inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px] font-medium text-ca-secondary transition-colors duration-300 hover:text-ca-xdark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ca-focus";

function SlidingRow({
  activeKey,
  className,
  indicatorClassName,
  children,
  ...rest
}: { activeKey: unknown; indicatorClassName: string } & HTMLAttributes<HTMLDivElement>) {
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(activeKey);
  return (
    <div ref={listRef} className={cn("relative", className)} {...rest}>
      <SlidingIndicator box={box} className={indicatorClassName} />
      {children}
    </div>
  );
}
const SIDE_GROUP = "space-y-0.5 py-3 first:pt-0 last:pb-0";
const SIDE_LABEL = "text-[12px] font-medium text-ca-secondary";
const PRIMARY = `${BTN} bg-ca-action text-ca-on-action hover:opacity-90`;
const DANGER = `${BTN} bg-danger text-white hover:opacity-90`;

async function readFailure(res: Response): Promise<{ code?: string; message: string }> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return { code: body?.error?.code, message: body?.error?.message ?? ACTION_NO_ANSWER_LINE };
}

async function readError(res: Response): Promise<string> {
  return (await readFailure(res)).message;
}

const WAIT_FOR_APPROVAL = {
  tone: "error" as const,
  title: "Waiting to confirm the earlier approval",
  body: "Zavi has not confirmed the approval you already sent. Refresh to see where it stands, then approve again if you still want to.",
  refresh: true,
};
const WAIT_FOR_RETRY = {
  tone: "error" as const,
  title: "Waiting to confirm the earlier send",
  body: "Zavi has not confirmed the Try again you already sent. Refresh to see where it stands.",
  refresh: true,
};

const RETRY_TAKEN_STATUSES = new Set(["approved", "queued", "dispatching", "executed", "acted", "sending", "sent"]);
function retryTaken(c: EmailCardView): boolean {
  return c.retryable !== true && RETRY_TAKEN_STATUSES.has(c.status);
}
const RETRY_TAKEN = { tone: "ok" as const, title: "Trying again", body: "Zavi sends the approved version now and updates this card when it is done." };
const RETRY_DONE_STATUSES = new Set(["sent", "partially_sent", "outcome_unknown", "stopped", "not_sent", "failed", "dispatch_failed"]);
const RETRY_UNKNOWN = {
  tone: "error" as const,
  title: "Retry status unknown",
  body: "Zavi could not confirm whether it is sending. Refresh to see where it stands. Trying again is the same request, so it cannot send twice.",
  refresh: true,
};

function loadErrorText(e: unknown): string {
  const err = e as Error;
  if (err?.message === "timeout" || err?.name === "AbortError" || err?.name === "TimeoutError" || err?.name === "TypeError") {
    return "Zavi did not answer. Try again.";
  }
  return err?.message || "Zavi did not answer. Try again.";
}

const LOAD_TRIES = 3;
const LOAD_BACKOFF_MS = 1000;
const loadRetryDelay = (failedTries: number) => LOAD_BACKOFF_MS * 2 ** (failedTries - 1) * (0.5 + Math.random());
const NOT_LOADING_LINE = "This email isn't loading right now.";

class Refused extends Error {}

class Missing extends Error {}

const SESSION_EXPIRED_TITLE = "Your session expired";
const SESSION_EXPIRED_LINE = "Your session expired. Reload the page and try again. Nothing was changed on this email.";
class SessionExpired extends Error {
  constructor() {
    super(SESSION_EXPIRED_LINE);
  }
}

async function failure(res: Response): Promise<Error> {
  if (res.status === 401) return new SessionExpired();
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  const message = body?.error?.message;
  const code = body?.error?.code;
  const definite = !!message && ((res.status >= 400 && res.status < 500) || (!!code && DEFINITE_CODES.has(code)));
  return definite ? new Refused(message) : new Error(message ?? ACTION_NO_ANSWER_LINE);
}

const ACTION_NO_ANSWER_LINE = "Zavi could not reach the server. Check the card again in a minute before retrying.";
const RAW_FAILURE = /failed to fetch|networkerror|load failed|network request failed|timed? ?out|timeout|aborted|\(\s*[1-5]\d\d\s*\)|bad gateway|service unavailable|gateway timeout|internal server error/i;

export function actionErrorText(e: unknown): string {
  if (e instanceof Refused || e instanceof SessionExpired) return e.message;
  const err = e as Error | null | undefined;
  const message = typeof err?.message === "string" ? err.message.trim() : "";
  if (!message) return ACTION_NO_ANSWER_LINE;
  if (err?.name === "TypeError" || err?.name === "AbortError" || err?.name === "TimeoutError" || RAW_FAILURE.test(message)) return ACTION_NO_ANSWER_LINE;
  return message;
}

const NOT_RESUMED_LINES: Readonly<Record<string, string>> = {
  email_paused: "Email is paused for this workspace. Resume email in Email campaigns settings, then resume this send.",
  list_send_in_flight: "Another email to this list is still going out, or Zavi is still checking whether it went. Wait for it to finish, then resume this send.",
};
const NOT_RESUMED_FALLBACK = "Zavi did not resume this send, so nothing went out. Refresh to see where it stands.";

async function resumeFailure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  const message = body?.error?.message;
  const code = body?.error?.code;
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && (message || code)) {
    return new Refused(message || (code && NOT_RESUMED_LINES[code]) || NOT_RESUMED_FALLBACK);
  }
  return new Error(message ?? ACTION_NO_ANSWER_LINE);
}

async function readCount(path: string): Promise<{ n: number; senderWarning: string }> {
  const res = await timedFetch(path);
  if (res.status === 401) throw new SessionExpired();
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json().catch(() => null)) as { people?: unknown; sender_warning?: unknown } | null;
  const n = body?.people;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(COUNT_MISSING);
  return { n, senderWarning: typeof body?.sender_warning === "string" ? ` ${body.sender_warning}` : "" };
}

type SendGate = { paused: boolean; held: EmailSendHold | null };

async function readSendGate(): Promise<SendGate> {
  try {
    const res = await timedFetch("/api/workspace/email-pause");
    if (!res.ok) return { paused: false, held: null };
    const body = (await res.json().catch(() => null)) as { paused?: unknown; held?: unknown } | null;
    const held = body?.held;
    return {
      paused: body?.paused === true,
      held: held === null || held === undefined ? null : (EMAIL_SEND_HOLDS as readonly unknown[]).includes(held) ? (held as EmailSendHold) : "unknown",
    };
  } catch {
    return { paused: false, held: null };
  }
}

export const HELD_SEND_COPY: Readonly<Record<EmailSendHold, { title: string; body: string }>> = {
  global: {
    title: "Zavi sender stopped",
    body: "Zavi's own sender is stopped for every workspace right now, so this email cannot go out. Try again once Zavi's sender is running.",
  },
  abuse: {
    title: "Bulk email is held for this workspace",
    body: "Bulk email is paused for this workspace because too many people marked a recent email as spam or it bounced, so this email cannot go out. Contact support to switch it back on.",
  },
  disabled: {
    title: "Zavi sender switched off",
    body: "Zavi's own sender is switched off for this workspace, so this email cannot go out. Contact support to turn it back on.",
  },
  unknown: {
    title: "Zavi sender may be stopped",
    body: "Zavi could not confirm that its own sender is running, so this email is not sent for now. Try again in a few minutes.",
  },
};

export const HELD_SEND_KEPT_LINE = "Nothing was approved or sent. The email stays here as it is.";
export const HELD_SEND_APPROVED_LINE = "This email is approved but not sent yet. Nothing went out, and the approved version stays as it is.";

function heldFor(c: Pick<EmailCardView, "route">, gate: SendGate): EmailSendHold | null {
  return c.route === "zavi_list" ? gate.held : null;
}

function showHeld(held: EmailSendHold, approved = false): Promise<boolean> {
  return confirmAction({ title: HELD_SEND_COPY[held].title, description: `${HELD_SEND_COPY[held].body} ${approved ? HELD_SEND_APPROVED_LINE : HELD_SEND_KEPT_LINE}`, cancelLabel: "Close", acknowledgeOnly: true });
}

const PAUSED_CONFIRM_LINE = " Email is paused for this workspace, so nothing goes out now. The send starts when an owner or admin resumes email.";

function Banner({ tone, title, children }: { tone: "ok" | "info" | "error"; title: string; children?: React.ReactNode }) {
  const tint = tone === "ok" ? "bg-mint/20" : tone === "error" ? "border border-danger/30 bg-danger/10" : "bg-ca-subtle";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-2.5 rounded-[12px] px-3.5 py-3 text-[14px] text-ca-xdark", tint)}>
      {tone === "error" && <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        {children && <p className="mt-0.5 text-[13px] leading-[18px] text-ca-secondary">{children}</p>}
      </div>
    </div>
  );
}

export function EmailPreviewFrame({ html, title, narrow = false, bare = false }: { html: string; title: string; narrow?: boolean; bare?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const measure = useCallback(() => {
    let doc: Document | null = null;
    try {
      doc = ref.current?.contentDocument ?? null;
    } catch {
      doc = null;
    }
    if (!doc) return;
    const h = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
    if (h > 0) setHeight(Math.ceil(h));
  }, []);
  useEffect(() => {
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(measure) : null;
    window.addEventListener("resize", measure);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, [narrow, html, measure]);
  return (
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-same-origin"
      srcDoc={html}
      referrerPolicy="no-referrer"
      onLoad={measure}
      style={{ height: height ? `${height}px` : undefined, maxWidth: narrow ? "375px" : undefined }}
      className={cn("mx-auto block w-full bg-ca-bg", bare ? "" : "rounded-[12px] border border-ca-border", height ? "" : "h-[520px]")}
    />
  );
}

export const LEARNINGS_UNREAD_LINE = "Zavi could not read what it learned for this draft.";

export function EmailCampaignCard({
  rail,
  id,
  onApproved,
  onAskZavi,
  onChanged,
  onNotSent,
  onApprovingChange,
  onReject,
  canCancel = false,
  onRejected,
  surface,
  framed = true,
  removable = false,
}: {
  removable?: boolean;
  framed?: boolean;
  rail: EmailCardRail;
  id: string;
  onApproved?: () => void;
  onReject?: (note?: string) => void | Promise<unknown>;
  canCancel?: boolean;
  onRejected?: () => void;
  surface?: DecisionSurface;
  onChanged?: () => void;
  onNotSent?: () => void;
  onApprovingChange?: (approving: boolean) => void;
  onAskZavi?: () => void;
}) {
  const [card, setCard] = useState<EmailCardView | null>(null);
  const cardRef = useRef<EmailCardView | null>(null);
  cardRef.current = card;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadMissing, setLoadMissing] = useState(false);
  const [loadFinal, setLoadFinal] = useState(false);
  const [loadGaveUp, setLoadGaveUp] = useState(false);
  const [loadRound, setLoadRound] = useState(0);
  const loadOutcome = useRef<"ok" | "retry" | "final" | "stale">("stale");
  const hidden = useEmailCardHidden(id);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = removable && hidden;
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState<"test" | "approve" | "schedule" | "stop" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const approvingNow = busy === "approve" || busy === "schedule";
  const onApprovingRef = useRef(onApprovingChange);
  onApprovingRef.current = onApprovingChange;
  useEffect(() => onApprovingRef.current?.(approvingNow), [approvingNow]);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; title: string; body?: string; note?: string; refresh?: boolean; reload?: boolean; inFlight?: boolean } | null>(null);
  const action = useRef(false);
  const retryRef = useRef<{ requestId: string; startSeq: number; variant: number; superseded?: boolean } | null>(null);
  const onApprovedRef = useRef(onApproved);
  onApprovedRef.current = onApproved;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const onNotSentRef = useRef(onNotSent);
  onNotSentRef.current = onNotSent;
  const source = useId();
  const keyRef = useRef({ rail, id });
  keyRef.current = { rail, id };
  const announce = useCallback(() => announceEmailCardChanged({ ...keyRef.current, source }), [source]);
  const changed = useCallback(() => {
    announce();
    onChangedRef.current?.();
  }, [announce]);
  const reading = useRef(0);
  const tabsId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [viewerEmail, setViewerEmail] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const readSeq = useRef(0);
  const [planOp, setPlanOp] = useState<(PlanOp & { startSeq: number }) | null>(null);
  const [planRead, setPlanRead] = useState<{ seq: number; value: Exclude<PlanRead, undefined> } | null>(null);
  const [approvalResume, setApprovalResume] = useState<{ rail: EmailCardRail; id: string; variant: number; requestId: string; seenPeople?: number } | null>(null);
  const [editing, setEditing] = useState<{ variant: number; content: EmailContent; seen?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testWarning, setTestWarning] = useState<string | null>(null);
  const dispatchSeen = useRef<number | null>(null);

  const commitPlanRead = useCallback((seq: number, value: Exclude<PlanRead, undefined>) => {
    setPlanRead({ seq, value });
    setPlanOp((op) => {
      if (op && !op.resolved && seq > op.startSeq && planOpResolved(op, value)) {
        setNotice((n) => (n?.title === WAIT_FOR_APPROVAL.title ? null : n));
        return { ...op, resolved: true };
      }
      return op;
    });
  }, []);

  const settleRetry = useCallback((seq: number, fresh: EmailCardView | null) => {
    const r = retryRef.current;
    if (!r || seq <= r.startSeq) return;
    const unblock = () => setNotice((n) => (n?.title === WAIT_FOR_RETRY.title ? null : n));
    if (fresh && fresh.open) {
      retryRef.current = { ...r, startSeq: seq, superseded: true };
      setNotice(null);
      return;
    }
    if (fresh && retryTaken(fresh)) {
      retryRef.current = null;
      setNotice(RETRY_DONE_STATUSES.has(fresh.status) ? null : RETRY_TAKEN);
      onApprovedRef.current?.();
      announce();
      onChangedRef.current?.();
    } else if (fresh && (fresh.status === "failed" || fresh.status === "dispatch_failed") && fresh.retryable !== true) {
      retryRef.current = null;
      setNotice(null);
      unblock();
    } else {
      setNotice(RETRY_UNKNOWN);
    }
  }, [announce]);

  const load = useCallback(async () => {
    const seq = ++readSeq.current;
    reading.current += 1;
    try {
      const res = await timedFetch(`/api/email-cards/${rail}/${id}`);
      if (!res.ok) {
        if (res.status === 401) throw new SessionExpired();
        const failure = await readFailure(res);
        if (res.status === 404 && failure.code === "not_found") throw new Missing(failure.message);
        throw new Error(failure.message);
      }
      const j = (await res.json()) as { card?: EmailCardView };
      if (!j.card) throw new Error("This email could not be loaded.");
      if (seq !== readSeq.current) return null;
      const loaded = withZone(withFounderReason(j.card));
      setCard(loaded);
      setLoadError(null);
      setLoadMissing(false);
      setLoadFinal(false);
      loadOutcome.current = "ok";
      unhideEmailCard(id);
      commitPlanRead(seq, loaded.planned ?? null);
      if (!loaded.open && loaded.chosen_variant !== null && RESUMABLE_STATUSES.has(loaded.status) && loaded.retryable === true) {
        setApprovalResume((previous) => previous?.rail === rail && previous.id === id && previous.variant === loaded.chosen_variant
          ? previous : { rail, id, variant: loaded.chosen_variant!, requestId: newRequestId() });
        setNotice((previous) => previous ?? { tone: "ok", title: "Approved send pending", body: "The send has not started. You can resume the approved version." });
      }
      if (!loaded.open && loaded.chosen_variant !== null && !RESUMABLE_STATUSES.has(loaded.status)) {
        setApprovalResume(null);
        setNotice((previous) => previous && ["Approval status unknown", "Approval saved; delivery unconfirmed", "Delivery still unconfirmed", "Approved send pending"].includes(previous.title) ? null : previous);
      }
      if (!loaded.open && !IN_FLIGHT_STATUSES.has(loaded.status)) setNotice((previous) => (previous?.inFlight ? null : previous));
      if (RETRY_DONE_STATUSES.has(loaded.status)) setNotice((previous) => (previous === RETRY_TAKEN ? null : previous));
      settleRetry(seq, loaded);
      return loaded;
    } catch (e) {
      if (seq !== readSeq.current) return null;
      if (e instanceof SessionExpired && cardRef.current) {
        settleRetry(seq, null);
        return null;
      }
      setLoadError(loadErrorText(e));
      setLoadMissing(e instanceof Missing);
      const final = e instanceof Missing || e instanceof SessionExpired;
      setLoadFinal(final);
      loadOutcome.current = final ? "final" : "retry";
      commitPlanRead(seq, "failed");
      settleRetry(seq, null);
      return null;
    } finally {
      reading.current -= 1;
    }
  }, [rail, id, commitPlanRead, settleRetry]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoadGaveUp(false);
    const attempt = async (tries: number) => {
      loadOutcome.current = "stale";
      await load();
      if (!live || cardRef.current || hiddenRef.current || (loadOutcome.current as "ok" | "retry" | "final" | "stale") !== "retry") return;
      if (tries >= LOAD_TRIES) {
        setLoadGaveUp(true);
        return;
      }
      timer = setTimeout(() => {
        if (live && !cardRef.current && !hiddenRef.current) void attempt(tries + 1);
      }, loadRetryDelay(tries));
    };
    void attempt(1);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [load, loadRound]);

  useEffect(() => onEmailCardChanged((change) => {
    if (change.source === source || change.rail !== rail || change.id !== id) return;
    if (action.current) return;
    void load();
  }), [source, rail, id, load]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const user = await getVerifiedUser(createBrowserSupabase());
        if (live) setViewerEmail(user?.email ?? null);
      } catch {
        if (live) setViewerEmail(null);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (card && card.status === "dispatching" && !card.open) {
    if (dispatchSeen.current === null) dispatchSeen.current = Date.now();
  } else if (card) {
    dispatchSeen.current = null;
  }
  const dispatchSince = card?.status === "dispatching" && !card.open
    ? Math.min(dispatchSeen.current ?? Date.now(), card.dispatching_since ? Date.parse(card.dispatching_since) || Date.now() : Date.now())
    : null;
  const dispatchStalled = dispatchSince !== null && Date.now() - dispatchSince > cardPoll.dispatchingMs;
  const polling = !!card && !card.open && !dispatchStalled && (POLL_STATUSES.has(card.status) || card.reconciliation_pending === true);
  const slowPoll = card?.pause_hold === "paused" || card?.status === "waiting_for_tomorrow";
  const pollMs = slowPoll ? cardPoll.pausedMs : cardPoll.ms;
  const tabHidden = useTabHidden();
  useEffect(() => {
    if (!polling || tabHidden) return;
    const timer = setInterval(() => {
      if (action.current || reading.current > 0) return;
      void load();
    }, pollMs);
    return () => clearInterval(timer);
  }, [polling, pollMs, load, tabHidden]);
  const scheduledAt = card?.open && card.planned?.status === "scheduled" ? Date.parse(card.planned.planned_at) : NaN;
  useEffect(() => {
    if (!Number.isFinite(scheduledAt) || tabHidden) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const until = scheduledAt - Date.now();
      const wait = until > cardPoll.scheduledLeadMs
        ? Math.min(until - cardPoll.scheduledLeadMs, cardPoll.scheduledFarMs)
        : until > -cardPoll.dispatchingMs ? cardPoll.ms : cardPoll.pausedMs;
      timer = setTimeout(() => {
        void (async () => {
          if (!action.current && reading.current === 0) await load();
          if (live) arm();
        })();
      }, wait);
    };
    arm();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [scheduledAt, load, tabHidden]);

  if (removable && hidden) return null;
  if (loadError && !card && !loadFinal && loadGaveUp) {
    return (
      <div role="status" data-testid="email-card-not-loading" className={cn("grid gap-2 text-[14px] text-ca-dark", framed && cn(FRAME, "p-4"))}>
        <p>{NOT_LOADING_LINE}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={SECONDARY} onClick={() => setLoadRound((r) => r + 1)}>
            Try again
          </button>
          {removable && (
            <button type="button" className={SECONDARY} onClick={() => hideEmailCard(id)}>
              Remove
            </button>
          )}
        </div>
      </div>
    );
  }
  if (loadError && !card && loadFinal) {
    return (
      <div className={cn("grid gap-2", framed && cn(FRAME, "p-4"))}>
        <Banner tone="error" title="This email could not be loaded">
          {loadError}
        </Banner>
        {!loadMissing && (
          <button type="button" className={cn(SECONDARY, "justify-self-start")} disabled={busy !== null || saving} onClick={() => void load()}>
            Try again
          </button>
        )}
      </div>
    );
  }
  if (!card) {
    return (
      <div role="status" aria-label="Loading email" className="h-40 animate-pulse rounded-2xl bg-ca-subtle">
        <span className="sr-only">Loading email</span>
      </div>
    );
  }

  if (card.replaced_by) {
    return (
      <section aria-label="Email to send" className={cn(framed ? FRAME : "", "p-4")}>
        <p className="text-[15px] font-semibold text-ca-xdark">Replaced by a newer draft</p>
        <p className="mt-1 text-[14px] text-ca-secondary">
          Zavi wrote a new version of this email in chat, so this card is closed.{" "}
          <a className="font-medium text-ca-xdark underline" href={`/workspace/email-cards/${card.replaced_by.rail}/${card.replaced_by.id}`}>
            Open the newer draft
          </a>
        </p>
      </section>
    );
  }

  if (card.versions.length === 0) {
    return (
      <section aria-label="Email to send" className={cn(framed ? FRAME : "", "p-4")}>
        <p className="text-[15px] font-semibold text-ca-xdark">Email to send</p>
        <p className="mt-2 text-[14px] leading-5 text-ca-xdark">{REDRAFT_LINE}</p>
      </section>
    );
  }

  const locked = busy !== null || saving;
  const i = Math.min(sel, card.versions.length - 1);
  const v = card.versions[i];
  const L = letter(v.variant);
  const testTo = card.viewer_email ?? viewerEmail;
  const pill = dispatchStalled ? { text: STALLED_WORD, tone: "bad" as const } : statusPill(card);
  const hintContext = { channel_slug: "email_marketing", title: v.subject };
  const hint = (detail: string) => actionHint(hintContext, "open", detail);
  const canApprove = !loadError && card.can_approve[i] === true;
  const plan = card.planned ?? null;
  const planMissing = !plan && card.planned_expected === true;
  const scheduled = !!plan && card.open && plan.status === "scheduled";
  const forTime = !!plan && plan.status === "ready" && Date.parse(plan.planned_at) > Date.now();
  const stage = emailSlipStage(card, { stalled: dispatchStalled, scheduled });
  const hero = emailSlipHero(card, stage, (n) => reach(card, n));
  const sentHero = hero && hero.eyebrow !== "Audience" ? hero : null;
  const wentOut = sentHero !== null || card.status === "sent" || card.status === "partially_sent" || card.status === "stopped";
  const tool = TOOL_NAME[card.route] ?? (card.route === "zavi_list" ? "Zavi" : "your email tool");
  const planAware = forTime || scheduled;
  const gated = card.viewer_can_approve && !loadError && !card.test_list && !card.test_list_unknown;
  const needsTest = gated && !canApprove && !v.tested_by_approver;
  const testedByOther = v.tested_by_approver && !v.tested_by_me;
  const title = v.subject.trim() || "Email to send";

  const opRead: PlanRead = planOp && planRead && planRead.seq > planOp.startSeq ? planRead.value : undefined;
  const planNotice = planOpNotice(planOp, opRead);

  const runPlanOp = async (
    kind: "schedule" | "withdraw",
    intent: PlanOp["intent"],
    call: (requestId: string | null) => Promise<{ replayed?: boolean; status?: string } | unknown>,
  ) => {
    if (!plan || action.current) return;
    const pending = planOp && !planOpResolved(planOp, opRead) ? planOp : null;
    if (kind === "schedule" && pending?.kind === "schedule" && !sameIntent(pending, kind, intent)) {
      setNotice(WAIT_FOR_APPROVAL);
      return;
    }
    action.current = true;
    setBusy("schedule");
    setNotice(null);
    try {
      if (kind === "schedule") {
        const ok = await confirmAction({
          title: `Approve ${L} for ${plan.planned_label}?`,
          description: `It goes to ${card.list.name} then, not now. ${PLANNED_STOP_LINE}`,
          confirmLabel: "Approve for that time",
        });
        if (!ok) return;
      }
      const keep = pending && sameIntent(pending, kind, intent) ? pending.requestId : null;
      const requestId = kind === "schedule" ? keep ?? newRequestId() : null;
      const startSeq = readSeq.current;
      setPlanOp({ kind, requestId, startSeq, intent });
      try {
        const out = (await call(requestId)) as { replayed?: boolean; status?: string } | undefined;
        const answer = { ok: true as const, replayed: out?.replayed, status: out?.status };
        setPlanOp((op) => withPlanOpAnswer(op, kind, startSeq, answer));
      } catch (e) {
        if (!isAmbiguousPlanError(e)) {
          const answer = { refused: (e as PlanError).message };
          setPlanOp((op) => withPlanOpAnswer(op, kind, startSeq, answer));
        }
      }
      await load();
      changed();
    } finally {
      action.current = false;
      setBusy(null);
    }
  };

  const scheduleIt = () => {
    if (!plan) return;
    const intent = { variant: v.variant, schedule_gen: plan.schedule_gen, content_version: plan.content_version };
    return runPlanOp("schedule", intent, (requestId) => schedulePlanned(plan.id, { ...intent, request_id: requestId! }));
  };
  const dontSend = () => runPlanOp("withdraw", undefined, () => withdrawPlanned(plan!.id));

  const guarded = <Args extends unknown[],>(fn: (...args: Args) => Promise<void>) => async (...args: Args) => {
    if (action.current) return;
    action.current = true;
    try {
      await fn(...args);
    } finally {
      action.current = false;
    }
  };

  const UNKNOWN_LINE = "Refresh to see where it stands.";

  const sendTest = guarded(async (variant: number = v.variant) => {
    setBusy("test");
    setNotice(null);
    const variantLabel = letter(variant);
    const sent = { tone: "ok" as const, title: `Test of ${variantLabel} sent to ${testTo ?? "your login email"}`, body: `Only you got it. Check how it looks in your inbox${canRetry ? ", then try again." : card.viewer_can_approve ? ", then approve." : ". An owner or admin approves it."}` };
    try {
      const res = await timedFetch(`/api/email-cards/${rail}/${id}/test`, { method: "POST", body: JSON.stringify({ variant }) });
      if (!res.ok) throw await failure(res);
      const answer = (await res.json().catch(() => null)) as { warning?: unknown; sent_with?: unknown } | null;
      const warning = answer?.warning;
      if (typeof warning === "string" && warning.trim()) setTestWarning(warning.trim());
      const viaZavi = typeof answer?.sent_with === "string" ? answer.sent_with.includes("Klaviyo has no test API") : card.route === "klaviyo";
      setNotice(viaZavi ? { ...sent, note: KLAVIYO_TEST_LINE } : sent);
      await load();
      changed();
    } catch (e) {
      if (e instanceof Refused) return setNotice({ tone: "error", title: "The test was not sent", body: e.message });
      const fresh = await load();
      if (fresh?.versions.find((x) => x.variant === variant)?.tested_by_me) announce();
      if (fresh?.versions.find((x) => x.variant === variant)?.tested_by_me) return setNotice(card.route === "klaviyo" ? { ...sent, note: KLAVIYO_TEST_LINE } : sent);
      setNotice({ tone: "error", title: "Test status unknown", body: `Zavi could not confirm whether the test went out. Check your inbox, or ${UNKNOWN_LINE.toLowerCase()}`, refresh: true });
    } finally {
      setBusy(null);
    }
  });

  const canRetry = !loadError && !card.open && !cardMayHaveSent(card) && card.retryable === true && card.viewer_can_approve && card.chosen_variant !== null;
  const cancellable = canCancel && !!onReject && !card.open && card.reconciliation_pending !== true && (FAILED_STATUSES.has(card.status) || card.status === "not_sent" || card.status === "outcome_unknown");
  const neverSent = !card.open && !cardMayHaveSent(card) && card.retryable !== true && card.win_line?.frozen !== true && (FAILED_STATUSES.has(card.status) || card.status === "not_sent");
  const retry = guarded(async () => {
    if (card.chosen_variant === null) return;
    setBusy("approve");
    let requested = false;
    try {
      const { n, senderWarning } = await readCount(`/api/email-cards/${rail}/${id}/count`);
      const gate = await readSendGate();
      const held = heldFor(card, gate);
      if (held) {
        await showHeld(held, true);
        return;
      }
      const paused = gate.paused;
      const chosen = card.versions.find((x) => x.variant === card.chosen_variant);
      const ok = await confirmAction({
        title: sendTitle(card, n),
        description: `${sendConfirmLine(card, letter(card.chosen_variant), chosen?.subject ?? "")}${capLine(card, n)}${paused ? PAUSED_CONFIRM_LINE : ""}${senderWarning}`,
        confirmLabel: paused ? "Send when resumed" : "Send now",
      });
      if (!ok) return;
      setNotice(null);
      if (retryRef.current && retryRef.current.variant !== card.chosen_variant) retryRef.current = null;
      const requestId = retryRef.current?.requestId ?? newRequestId();
      retryRef.current = { requestId, startSeq: readSeq.current, variant: card.chosen_variant };
      requested = true;
      const res = await timedFetch(`/api/email-cards/${rail}/${id}/approve`, { method: "POST", body: JSON.stringify({ variant: card.chosen_variant, request_id: requestId, seen_people: n }) });
      if (!res.ok) throw await failure(res);
      await load();
    } catch (e) {
      if (!requested || e instanceof Refused) {
        if (requested) retryRef.current = null;
        return setNotice({ tone: "error", title: "Not sent", body: actionErrorText(e) });
      }
      await load();
    } finally {
      setBusy(null);
    }
  });

  const startEdit = () => {
    if (action.current) return;
    const c = v.content;
    setNotice(null);
    setEditing({
      variant: v.variant,
      seen: v.seen,
      content: c
        ? { ...c, paragraphs: [...c.paragraphs], button: { ...c.button } }
        : { subject: v.subject, preview_text: v.preview_text, title: v.subject, paragraphs: [""], button: { label: "", url: "https://" } },
    });
  };

  const saveEdit = guarded(async () => {
    if (!editing) return;
    setSaving(true);
    setNotice(null);
    try {
      const content: EmailContent = { ...editing.content, paragraphs: editing.content.paragraphs.map((p) => p.trim()).filter(Boolean) };
      const res = await timedFetch(`/api/email-cards/${rail}/${id}/variants/${editing.variant}`, { method: "PATCH", body: JSON.stringify(editing.seen ? { content, seen: editing.seen } : { content }) });
      if (!res.ok) throw await failure(res);
      setEditing(null);
      setNotice({ tone: "ok", title: card.viewer_can_approve ? EDIT_VOIDS_TEST_LINE : EDIT_VOIDS_TEST_MEMBER_LINE });
      await load();
      changed();
    } catch (e) {
      if (e instanceof Refused) return setNotice({ tone: "error", title: "Not saved", body: e.message });
      setNotice({ tone: "error", title: "This version may not have saved", body: `Zavi did not hear back. ${UNKNOWN_LINE} Your text is still here.`, refresh: true });
    } finally {
      setSaving(false);
    }
  });

  const planPassed = !!plan && !scheduled && Number.isFinite(Date.parse(plan.planned_at)) && Date.parse(plan.planned_at) <= Date.now();
  const cancelFailed = guarded(async () => {
    if (!onReject) return;
    setBusy("reject");
    setNotice(null);
    try {
      const done = await onReject();
      if (done === false) await load();
    } catch (e) {
      setNotice({ tone: "error", title: "Not cancelled", body: e instanceof Refused ? e.message : `Zavi did not hear back. ${UNKNOWN_LINE}`, refresh: !(e instanceof Refused) });
    } finally {
      setBusy(null);
    }
  });
  const canReject = card.open && !planMissing && ((!plan && !card.planned_expected) || planPassed);
  const reject = guarded(async () => {
    const note = rejectNote.trim();
    if (rail === "channel_actions" && note.length < 3) return;
    setBusy("reject");
    setNotice(null);
    try {
      if (rail === "channel_actions" && onReject) {
        const done = await onReject(note);
        setRejecting(false);
        if (done === false) await load();
        return;
      }
      const res = rail === "decisions"
        ? await rejectDecision(id, surface ? { surface } : {})
        : await timedFetch(`/api/channel-actions/${id}`, { method: "POST", body: JSON.stringify({ action: "rejected", request_id: newRequestId(), ...(note ? { note } : {}) }) });
      if (!res.ok) throw await failure(res);
      setRejecting(false);
      onRejected?.();
      await load();
      changed();
    } catch (e) {
      setNotice({ tone: "error", title: "Not rejected", body: e instanceof Refused ? e.message : `Zavi did not hear back. ${UNKNOWN_LINE}`, refresh: !(e instanceof Refused) });
      if (e instanceof Refused) {
        setRejecting(false);
        await load();
      }
    } finally {
      setBusy(null);
    }
  });

  const approve = guarded(async () => {
    if (planMissing) return;
    const pendingRetry = retryRef.current;
    if (pendingRetry && !pendingRetry.superseded) return setNotice(WAIT_FOR_RETRY);
    if (pendingRetry && pendingRetry.variant !== v.variant) {
      return setNotice({
        ...WAIT_FOR_RETRY,
        body: `The Try again you sent was for version ${letter(pendingRetry.variant)}. Send that version, or refresh to see where it stands.`,
      });
    }
    setBusy("approve");
    let requestId: string | null = null;
    let seenPeople: number | undefined;
    let approvalRequested = false;
    let approvalRejected = false;
    try {
      const { n, senderWarning } = await readCount(`/api/email-cards/${rail}/${id}/count`);
      const gate = await readSendGate();
      const held = heldFor(card, gate);
      if (held) {
        await showHeld(held);
        return;
      }
      const paused = gate.paused;
      const ok = await confirmAction({
        title: sendTitle(card, n),
        description: `${sendConfirmLine(card, L, v.subject)}${capLine(card, n)}${paused ? PAUSED_CONFIRM_LINE : ""}${senderWarning}`,
        confirmLabel: paused ? "Approve, send when resumed" : "Send now",
      });
      if (!ok) return;
      setNotice(null);
      requestId = pendingRetry?.requestId ?? (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
      approvalRequested = true;
      seenPeople = n;
      setApprovalResume({ rail, id, variant: v.variant, requestId, seenPeople });
      const res = await timedFetch(`/api/email-cards/${rail}/${id}/approve`, { method: "POST", body: JSON.stringify(v.seen ? { variant: v.variant, request_id: requestId, seen: v.seen, seen_people: n } : { variant: v.variant, request_id: requestId, seen_people: n }) });
      if (!res.ok) {
        const err = await failure(res);
        approvalRejected = err instanceof Refused;
        throw err;
      }
      setApprovalResume(null);
      setPlanOp(null);
      retryRef.current = null;
      const answer = (await res.json().catch(() => null)) as { paused?: unknown } | null;
      setNotice(answer?.paused === true
        ? { tone: "ok", title: `Approved ${L}. Email is paused`, body: rail === "channel_actions" ? PAUSED_TOOL_LINE : "Nothing goes out while email is paused. The send starts when email is resumed.", inFlight: true }
        : { tone: "ok", title: `Sending ${L} to ${people(reach(card, n))}`, body: sendingLine(card), inFlight: true });
      onApproved?.();
      changed();
      await load();
    } catch (e) {
      const latest = await load();
      if (latest && !latest.open && latest.chosen_variant !== null) {
        setPlanOp(null);
        if (latest.status === "approved" || latest.status === "queued") {
          const replayId = requestId ?? (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
          setApprovalResume({ rail, id, variant: latest.chosen_variant, requestId: replayId, seenPeople });
          setNotice({ tone: "error", title: "Approval saved; delivery unconfirmed", body: "Check the status or resume the already-approved send. Nothing is retried automatically." });
        } else if (FAILED_STATUSES.has(latest.status) || latest.status === "not_sent") {
          setNotice({ tone: "error", title: "Not sent", body: e instanceof Refused ? e.message : latest.failure_reason ?? actionErrorText(e) });
          onNotSentRef.current?.();
        } else {
          setNotice(null);
          onApproved?.();
          changed();
        }
      } else {
        if (e instanceof SessionExpired) setNotice({ tone: "error", title: SESSION_EXPIRED_TITLE, body: e.message, reload: true });
        else setNotice({ tone: "error", title: !approvalRequested || approvalRejected ? "Not approved" : "Approval status unknown", body: actionErrorText(e) });
      }
    } finally {
      setBusy(null);
    }
  });

  const resumeApprovedSend = guarded(async () => {
    if (!approvalResume || approvalResume.rail !== rail || approvalResume.id !== id || loadError || busy || !card.viewer_can_approve || card.test_list || card.test_list_unknown) return;
    const approved = card.versions.find((version) => version.variant === approvalResume.variant);
    if (!approved || card.chosen_variant !== approvalResume.variant || !["approved", "queued"].includes(card.status)) return;
    setBusy("approve");
    try {
      if (!(await confirmAction({ title: `Resume approved version ${letter(approved.variant)}?`, description: sendConfirmLine(card, letter(approved.variant), approved.subject), confirmLabel: "Resume send" }))) return;
      const res = await timedFetch(`/api/email-cards/${rail}/${id}/approve`, { method: "POST", body: JSON.stringify({ variant: approvalResume.variant, request_id: approvalResume.requestId, seen_people: approvalResume.seenPeople }) });
      if (!res.ok) throw await resumeFailure(res);
      setApprovalResume(null);
      setNotice({ tone: "ok", title: "Approved send queued", body: "This card checks every few seconds and updates when the send completes.", inFlight: true });
      onApproved?.();
      changed();
      await load();
    } catch (e) {
      setNotice({ tone: "error", title: e instanceof Refused ? "Not resumed" : "Delivery still unconfirmed", body: actionErrorText(e) });
      await load();
    } finally {
      setBusy(null);
    }
  });

  const resumable = !!approvalResume && approvalResume.rail === rail && approvalResume.id === id && card.chosen_variant === approvalResume.variant && RESUMABLE_STATUSES.has(card.status) && card.viewer_can_approve && !card.test_list && !card.test_list_unknown;
  const canStop = !card.open && card.route === "zavi_list" && card.viewer_can_approve && STOPPABLE_STATUSES.has(card.status) && card.retryable !== true;
  const stopRest = guarded(async () => {
    setBusy("stop");
    setNotice(null);
    let requested = false;
    try {
      const ok = await confirmAction({
        title: "Stop the rest of this send?",
        description: `Everyone on ${card.list.name} who has not been sent yet is skipped and never gets it. Emails that already went out can't be recalled.`,
        confirmLabel: "Stop the rest",
        tone: "danger",
      });
      if (!ok) return;
      requested = true;
      const res = await timedFetch(`/api/email-cards/${rail}/${id}/stop`, { method: "POST" });
      if (!res.ok) throw await failure(res);
      const out = (await res.json().catch(() => null)) as { stopped?: number; already_sent?: number } | null;
      setNotice({
        tone: "ok",
        title: typeof out?.stopped === "number" && typeof out?.already_sent === "number"
          ? `Stopped. ${people(out.already_sent)} already got it; ${out.stopped.toLocaleString("en-US")} will not.`
          : "Stopped. The rest will not be sent.",
      });
      changed();
      await load();
    } catch (e) {
      if (!requested || e instanceof Refused) return setNotice({ tone: "error", title: "Not stopped", body: actionErrorText(e) });
      await load();
      setNotice({ tone: "error", title: "Stop status unknown", body: `Zavi did not confirm the stop. ${UNKNOWN_LINE} Stopping again is safe.`, refresh: true });
    } finally {
      setBusy(null);
    }
  });

  const selectTab = (k: number, focus = false) => {
    if (editing || k < 0 || k >= card.versions.length) return;
    setSel(k);
    if (!approvalResume) setNotice(null);
    if (focus) tabRefs.current[k]?.focus();
  };
  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>, k: number) => {
    const n = card.versions.length;
    const next = e.key === "ArrowRight" ? (k + 1) % n : e.key === "ArrowLeft" ? (k - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (next === null) return;
    e.preventDefault();
    selectTab(next, true);
  };

  const askZavi = () => {
    if (action.current || !onAskZavi) return;
    onAskZavi();
  };

  return (
    <section aria-label="Email to send" className={framed ? FRAME : "slip-container w-full min-w-0"}>
      {loadError && (
        <div className="border-b border-ca-border px-4 py-3">
          <Banner tone="error" title="This email could not be refreshed">{loadError}</Banner>
          <button type="button" className={SECONDARY} disabled={locked} onClick={() => void load()}>Refresh status</button>
        </div>
      )}
      <SlipSlab
        stage={stage}
        literal
        roomy
        status={plan?.scheduled && scheduled ? `Approved ${letter(plan.scheduled.variant)} for ${plan.planned_label}` : pill.text}
        statusTestId="email-card-status"
        titleTestId="email-card-title"
        platform={TOOL_NAME[card.route] ?? (card.route === "zavi_list" ? "Zavi" : "Email")}
        mark="@"
        logo={TOOL_LOGO[card.route]}
        target={card.list.name}
        title={title}
        hero={hero}
      >
        {plan && card.open && !scheduled && (
          <span data-testid="email-card-planned" className="mt-2 inline-flex items-center gap-1 rounded-full bg-ca-bg px-2 py-0.5 text-[12px] font-medium text-ca-xdark ring-1 ring-ca-border">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden /> Planned for {plan.planned_label}
          </span>
        )}
      </SlipSlab>
      {testWarning && (
        <div data-testid="email-card-test-warning" role="alert" className="flex flex-wrap items-start gap-2 border-b border-ca-border bg-coral/10 px-4 py-3 text-[14px] text-ca-xdark">
          <p className="min-w-0 flex-1"><span className="font-semibold">The test went out, but there is something to fix. </span>{testWarning}</p>
          <button type="button" className={cn(SECONDARY, "h-8 px-2 text-[13px]")} onClick={() => setTestWarning(null)}>
            Dismiss
          </button>
        </div>
      )}

      {card.versions.length > 1 && (
        <div className="px-5 pt-4">
        <SlidingRow activeKey={i} role="tablist" aria-label="Versions" className="flex w-fit max-w-full flex-wrap gap-1 rounded-xl bg-ca-subtle p-1" indicatorClassName="rounded-[10px] bg-ca-action">
          {card.versions.map((x, k) => (
            <button
              key={x.variant}
              ref={(el) => {
                tabRefs.current[k] = el;
              }}
              id={`${tabsId}-tab-${x.variant}`}
              type="button"
              role="tab"
              aria-selected={k === i}
              aria-controls={`${tabsId}-panel`}
              tabIndex={k === i ? 0 : -1}
              disabled={!!editing && k !== i}
              title={editing && k !== i ? `Save or cancel the edit of ${L} first` : `${letter(x.variant)} · ${x.subject}`}
              onClick={() => selectTab(k)}
              onKeyDown={(e) => onTabKey(e, k)}
              className={cn(
                "relative h-9 min-w-0 max-w-full truncate rounded-[10px] px-3 text-[14px] font-medium leading-9 transition-colors duration-300 disabled:cursor-not-allowed disabled:opacity-50",
                k === i ? "text-ca-on-action" : "text-ca-xdark hover:bg-ca-subtle",
              )}
            >
              {letter(x.variant)} · {x.subject}
            </button>
          ))}
        </SlidingRow>
        </div>
      )}

      <div
        id={`${tabsId}-panel`}
        role={card.versions.length > 1 ? "tabpanel" : undefined}
        aria-labelledby={card.versions.length > 1 ? `${tabsId}-tab-${v.variant}` : undefined}
        className={cn("grid gap-4 px-5 py-4", "slip-wide:grid-cols-[minmax(0,1fr)_280px]")}
      >
        <div>
          <div data-testid="email-card-headers" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-[12px] border border-ca-border px-3.5 py-3 text-[14px]">
            <span className="text-ca-secondary">Subject</span>
            <span className="break-words font-semibold text-ca-xdark">{v.subject}</span>
            {v.preview_text && (
              <>
                <span className="text-ca-secondary">Preview</span>
                <span className="break-words text-ca-xdark">{v.preview_text}</span>
              </>
            )}
          </div>
          <div className={cn(editing && "xl:grid xl:grid-cols-2 xl:gap-3")}>
            {editing && scheduled && (
              <p data-testid="email-card-scheduled-edit" className="mt-3 text-[13px] text-ca-secondary">{SCHEDULED_EDIT_LINE}</p>
            )}
            {editing && !scheduled && (
              <EditVersionForm
                letter={letter(editing.variant)}
                value={editing.content}
                onChange={(content) => setEditing((e) => (e ? { ...e, content } : e))}
                busy={saving || busy !== null || !!loadError}
                onSave={() => void saveEdit()}
                onCancel={() => setEditing(null)}
              />
            )}
            <div className="mt-3">
              <div className="mb-2 flex justify-end">
                <SlidingRow activeKey={narrow} className="inline-flex items-center gap-0.5 rounded-[10px] border border-ca-border bg-ca-bg p-0.5" indicatorClassName="rounded-[8px] bg-ca-subtle" role="group" aria-label="Preview width">
                  <button type="button" aria-pressed={!narrow} className={cn(WIDTH_TOGGLE, !narrow && "text-ca-xdark")} onClick={() => setNarrow(false)}>
                    <Monitor className="h-4 w-4" aria-hidden /> Full width
                  </button>
                  <button type="button" aria-pressed={narrow} className={cn(WIDTH_TOGGLE, narrow && "text-ca-xdark")} onClick={() => setNarrow(true)}>
                    <Smartphone className="h-4 w-4" aria-hidden /> Phone width
                  </button>
                </SlidingRow>
              </div>
              <EmailPreviewFrame html={v.html} title={`Email preview, version ${L}`} narrow={narrow} />
              <p className="mt-2 text-center text-[13px] text-ca-secondary">
                {editing
                  ? "This preview is the saved version. Save to see your changes here."
                  : card.status === "rejected"
                    ? "Rendered in your saved template when this email was drafted. It was rejected, so it was not sent."
                    : "Rendered in your saved template when this email was drafted. This is exactly what is sent."}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div data-testid="email-card-side" className="divide-y divide-ca-border rounded-[12px] border border-ca-border p-3.5 text-[14px]">
            <div className={SIDE_GROUP}>
              <p className={SIDE_LABEL}>To</p>
              <p data-testid="email-card-to" className="font-semibold text-ca-xdark">
                {card.list.name}
                {sentHero ? ` · ${sentHero.amount} ${sentHero.unit}` : card.list.people !== null && ` · ${people(card.list.people)}`}
              </p>
              {!sentHero && card.list.unchecked && <p data-testid="email-card-count-unchecked" className="text-[12px] text-ca-secondary">{LIST_UNCHECKED_LINE}</p>}
              {card.open && (card.list.left_out ?? 0) > 0 && <p data-testid="email-card-will-leave-out" className="text-[12px] text-ca-secondary">{leftOutLine(card.list.left_out ?? 0, false)}</p>}
              {card.open && <p className="text-[12px] text-ca-secondary">Counted again right before you confirm</p>}
            </div>
            <div data-testid="email-card-from" className={SIDE_GROUP}>
              <p className={SIDE_LABEL}>From</p>
              <p className="break-words text-ca-xdark">{fromLine(card)}</p>
              <p className="text-[12px] text-ca-secondary">{sentBy(card, false)}</p>
            </div>
            {card.reply_to && (
              <div className={SIDE_GROUP}>
                <p className={SIDE_LABEL}>Replies go to</p>
                <p className="break-words text-ca-xdark">{card.reply_to}</p>
              </div>
            )}
            {card.unsubscribe_group_id && (
              <div className={SIDE_GROUP}>
                <p className={SIDE_LABEL}>Unsubscribe group</p>
                <p className="text-ca-xdark">{card.unsubscribe_group_name ?? `Group ${card.unsubscribe_group_id}`}</p>
                <p className="text-[12px] text-ca-secondary">Set once in Settings</p>
                {card.suppression && (
                  <p data-testid="email-card-suppression" className="text-[12px] text-ca-secondary">
                    {suppressionLine(card.suppression, card.list.people)}
                  </p>
                )}
              </div>
            )}
            {card.learnings_read?.status === "ok" && card.learnings_read.items.length > 0 && (
              <details data-testid="email-card-learnings" className={SIDE_GROUP}>
                <summary className="cursor-pointer text-[13px] font-medium text-ca-xdark">
                  Zavi read {card.learnings_read.items.length} {card.learnings_read.items.length === 1 ? "learning" : "learnings"} for this {wentOut ? "email" : "draft"}
                </summary>
                <ul className="mt-2 space-y-1 border-l-2 border-ca-border pl-3">
                  {card.learnings_read.items.map((l) => (
                    <li key={l.id} className="text-[12px] leading-[18px] text-ca-secondary">
                      {l.text}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[12px] text-ca-secondary">As the list was when Zavi wrote this draft.</p>
              </details>
            )}
            {(card.learnings_read?.status === "read_failed" || card.learnings_read?.status === "snapshot_failed") && (
              <p data-testid="email-card-learnings-failed" className={cn(SIDE_GROUP, "text-[12px] text-ca-secondary")}>
                {LEARNINGS_UNREAD_LINE}
              </p>
            )}
            {card.win_line && card.status !== "rejected" && !neverSent && (
              <div data-testid="email-card-win-line" className={SIDE_GROUP}>
                <p className={SIDE_LABEL}>Goal for day 7</p>
                <p className="text-ca-xdark">{card.win_line.text}</p>
                <p className="text-[12px] text-ca-secondary">
                  {card.win_line.frozen ? "Set when this email was sent" : "Set when sent, from your past emails to this list"}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {card.open && scheduled && plan && (
        <div data-testid="email-card-scheduled-tracker">
          <SlipTracker steps={emailSlipSteps(card, stage, tool, `Goes out ${plan.planned_label}`)} />
        </div>
      )}
      {card.open && (
        <div className="space-y-3 border-t border-ca-border px-4 py-3">
          {planNotice && (
            <div data-testid="email-card-plan-notice">
              <Banner tone={planNotice.tone} title={planNotice.title}>
                {planNotice.body}
                {planNotice.refresh && (
                  <button type="button" className={cn(SECONDARY, "mt-2")} disabled={locked} onClick={() => void load()}>
                    Refresh
                  </button>
                )}
              </Banner>
            </div>
          )}
          {notice && (
            <Banner tone={notice.tone} title={notice.title}>
              {notice.body}
              {notice.note && <span data-testid="email-card-test-via" className="mt-1 block">{notice.note}</span>}
              {notice.refresh && (
                <button type="button" className={cn(SECONDARY, "mt-2")} disabled={locked} onClick={() => void load()}>
                  Refresh
                </button>
              )}
              {notice.reload && (
                <button type="button" className={cn(SECONDARY, "mt-2")} onClick={() => window.location.reload()}>
                  Reload the page
                </button>
              )}
            </Banner>
          )}
          {planMissing && (
            <div data-testid="email-card-plan-missing">
              <Banner tone="error" title="Could not load the plan">
                {PLAN_UNREAD_LINE}
                <button type="button" className={cn(SECONDARY, "mt-2")} disabled={locked} onClick={() => void load()}>
                  Retry
                </button>
              </Banner>
            </div>
          )}
          {!card.viewer_can_approve && (
            <Banner tone="info" title="Ask an admin to approve">
              Only owners and admins can send to a list. You can send yourself a test of any version.
            </Banner>
          )}
          {gated && !scheduled && (
            <ol data-testid="email-card-steps" aria-label="Before this email goes out" className="flex flex-col gap-2 text-[13px] sm:flex-row sm:items-center sm:gap-4">
              <li data-testid="email-card-step-test" data-done={v.tested_by_approver ? "true" : "false"} className="flex min-w-0 items-center gap-2">
                <span aria-hidden className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] font-bold", v.tested_by_approver ? "bg-success/10 text-success" : "bg-ca-subtle text-ca-xdark")}>1</span>
                <span className="min-w-0 text-ca-xdark">Send a test to you</span>
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[12px] font-semibold", v.tested_by_approver ? "bg-success/10 text-success" : "bg-ca-subtle text-ca-secondary")}>
                  {v.tested_by_approver ? (testedByOther ? "Done by an owner or admin" : "Done") : "Not done"}
                </span>
              </li>
              <li data-testid="email-card-step-approve" data-ready={canApprove ? "true" : "false"} className="flex min-w-0 items-center gap-2">
                <span aria-hidden className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] font-bold", canApprove ? "bg-ca-action text-ca-on-action" : "bg-ca-subtle text-ca-secondary")}>2</span>
                <span className={cn("min-w-0", canApprove ? "text-ca-xdark" : "text-ca-secondary")}>Approve and send</span>
                {!canApprove && <Lock className="h-3.5 w-3.5 shrink-0 text-ca-secondary" aria-label="Locked" />}
              </li>
            </ol>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <ActionTooltip placement="below" description={hint(`Send version ${L} to ${testTo ?? "your login email"} now so you can check it. This does not email the ${card.list.name} audience.`)} label={`Send test of ${L} to ${testTo ?? "me"}`}>
              <button type="button" className={cn(SLIP_SMALL, "max-w-full py-1.5 text-left")} disabled={locked || !!loadError} onClick={() => void sendTest()}>
                <Eye className="h-4 w-4 shrink-0" aria-hidden /> <span className="min-w-0">{busy === "test" ? "Sending test…" : <>Send test of {L} to <span className="break-all">{testTo ?? "me"}</span></>}</span>
              </button>
            </ActionTooltip>
            {card.editable && !editing && (
              <ActionTooltip placement="below" description={hint(`Open the editor for version ${L}. Saving edits invalidates its previous test; ${card.viewer_can_approve ? "send a new test before approving" : "send yourself a new test and ask an owner or admin to approve"}. Editing does not send the campaign.`)} label="Edit this version">
                <button type="button" className={SLIP_SMALL} disabled={locked || !!loadError || scheduled} title={scheduled ? SCHEDULED_EDIT_LINE : undefined} onClick={startEdit}>
                  <Pencil className="h-4 w-4" aria-hidden /> Edit this version
                </button>
              </ActionTooltip>
            )}
            {card.editable && !editing && scheduled && (
              <p data-testid="email-card-scheduled-edit" className="basis-full text-[13px] text-ca-secondary">{SCHEDULED_EDIT_LINE}</p>
            )}
            {card.editable && onAskZavi && (
              <ActionTooltip placement="below" description={hint(`Open chat to ask for changes to this email. Send your instructions there; this does not approve or send the email campaign.`)} label="Ask Zavi to change it">
                <button type="button" className={SLIP_SMALL} disabled={locked || scheduled} title={scheduled ? SCHEDULED_EDIT_LINE : undefined} onClick={askZavi}>
                  Ask Zavi to change it
                </button>
              </ActionTooltip>
            )}
          </div>
          {}
          <div className="grid gap-1.5">
            {card.viewer_can_approve && forTime && plan && (
              <ActionTooltip placement="below" className="w-full" description={hint(`Open confirmation to approve version ${L} for ${plan.planned_label}, addressed to ${card.list.name}. Confirming schedules the email for that time.`)} label={`Approve ${L} for ${plan.planned_label}`}>
                <button type="button" className={SLIP_PRIMARY} disabled={!canApprove || locked} onClick={() => void scheduleIt()}>
                  {canApprove ? <CalendarClock className="h-4 w-4" aria-hidden /> : <Lock className="h-4 w-4" aria-hidden />}
                  {busy === "schedule" ? "Approving…" : needsTest ? "Send a test first" : `Approve ${L} for ${plan.planned_label}`}
                </button>
              </ActionTooltip>
            )}
            {card.viewer_can_approve && !planMissing && (
              <ActionTooltip placement="below" className="w-full" description={hint(`Review the current recipient count, then confirm sending version ${L} to ${card.list.name} now. The send cannot be undone. Approval requires a valid test and permission to send.`)} label={`Send ${L}`}>
                <button type="button" className={planAware ? SLIP_SECONDARY : SLIP_PRIMARY} disabled={!canApprove || locked} onClick={() => void approve()}>
                  {canApprove ? <Send className="h-4 w-4" aria-hidden /> : <Lock className="h-4 w-4" aria-hidden />}
                  {busy === "approve" ? "Approving…" : planAware ? `Send ${L} now` : needsTest ? "Send a test first" : `Approve and send ${L}`}
                </button>
              </ActionTooltip>
            )}
            {card.viewer_can_approve && scheduled && (
              <ActionTooltip placement="below" className="w-full" description={hint(`Withdraw the scheduled approval for this email to ${card.list.name}. This cannot recall an email that has already been sent.`)} label="Don’t send">
                <button type="button" className={SLIP_SECONDARY} disabled={locked} onClick={() => void dontSend()}>
                  Don&apos;t send
                </button>
              </ActionTooltip>
            )}
            {canReject && !rejecting && (
              <div className="flex justify-end">
                <ActionTooltip placement="below" description={hint(`Drop this email draft. Nothing is sent to ${card.list.name}.`)} label="Reject">
                  <button type="button" className={DANGER} disabled={locked} onClick={() => setRejecting(true)}>
                    Reject
                  </button>
                </ActionTooltip>
              </div>
            )}
          </div>
          {canReject && rejecting && (
            <form
              data-testid="email-card-reject"
              aria-label="Reject this email"
              className="grid gap-2 rounded-[12px] border border-ca-border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void reject();
              }}
            >
              {rail === "channel_actions" ? (
                <label className="grid gap-1 text-[14px] font-medium text-ca-xdark">
                  Why are you rejecting it?
                  <textarea
                    className="min-h-[72px] w-full rounded-[10px] border border-ca-border bg-ca-bg px-3 py-2 text-[16px] text-ca-xdark outline-none focus:border-ca-strong"
                    value={rejectNote}
                    maxLength={1000}
                    minLength={3}
                    required
                    placeholder="e.g. Wrong list for this offer"
                    onChange={(e) => setRejectNote(e.target.value)}
                  />
                </label>
              ) : (
                <p className="text-[14px] text-ca-xdark">Reject this email? Zavi does not send it.</p>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="submit" className={DANGER} disabled={locked || (rail === "channel_actions" && rejectNote.trim().length < 3)}>
                  {busy === "reject" ? "Rejecting…" : "Reject"}
                </button>
                <button type="button" className={SECONDARY} disabled={locked} onClick={() => setRejecting(false)}>
                  Cancel
                </button>
              </div>
              {rail === "channel_actions" && <p className="text-[12px] text-ca-secondary">Zavi reads this the next time this channel runs, and a similar idea ranks lower.</p>}
            </form>
          )}
          {plan && scheduled && plan.scheduled && (
            <p data-testid="email-card-scheduled" className="text-[13px] text-ca-secondary">
              {PLANNED_STOP_LINE}
            </p>
          )}
          {plan && !planAware && plan.reason && (
            <p data-testid="email-card-planned-reason" className="text-[13px] text-ca-secondary">
              {plan.reason}
            </p>
          )}
          {plan && card.route === "zavi_list" && (
            <p className="text-[13px] text-ca-secondary">{PLANNED_IMPORT_LINE}</p>
          )}
          {card.test_list || card.test_list_unknown ? (
            <p data-testid="email-card-test-list" className="text-[13px] text-ca-secondary">{card.test_list ? TEST_LIST_LINE : TEST_LIST_UNKNOWN_LINE}</p>
          ) : null}
        </div>
      )}
      {!card.open && FAILED_STATUSES.has(card.status) && (
        <div className="space-y-3 px-4 py-3">
          <div className="-mx-4 -mt-3">
            <SlipTracker steps={emailSlipSteps(card, stage, tool, "")} />
          </div>
          <Banner tone="error" title={cardMayHaveSent(card) ? (card.reconciliation_pending ? DISPATCH_UNKNOWN_TITLE : OUTCOME_UNKNOWN_LINE) : card.chosen_variant !== null ? `Version ${letter(card.chosen_variant)} was approved but not sent` : "This email was not sent"}>
            {cardMayHaveSent(card) ? (card.reconciliation_pending ? "Zavi will not send it again, so nobody gets it twice. This card updates once Zavi knows." : cardSendReason(card) ?? "Zavi will not send it again, so nobody gets it twice.") : card.failure_reason ?? "The send did not go through."}{" "}
            {cardMayHaveSent(card)
              ? null
              : (card.test_list || card.test_list_unknown) && (card.retryable === true || card.reasons.includes(card.test_list ? TEST_LIST_LINE : TEST_LIST_UNKNOWN_LINE))
              ? card.test_list
                ? TEST_LIST_LINE
                : TEST_LIST_UNKNOWN_LINE
              : canRetry
              ? /interrupted before anything went out/i.test(card.failure_reason ?? "")
                ? "The same approved version is sent; nothing in it can change."
                : "Fix that, then try again. The same approved version is sent; nothing in it can change."
              : card.retryable
                ? "An owner or admin can try it again."
                : /cannot be tried again/i.test(card.failure_reason ?? "")
                  ? null
                  : /Ask Zavi (for a new draft|to draft it again)/i.test(card.failure_reason ?? "")
                    ? "This one cannot be tried again."
                    : "This one cannot be tried again. Ask Zavi to draft it again."}
          </Banner>
          {canRetry && card.chosen_variant !== null && (
            <div className="flex flex-wrap gap-2">
              <ActionTooltip description={hint(`Send the approved version ${letter(card.chosen_variant)} to ${testTo ?? "your login email"} before retrying. This does not email the audience.`)} label={`Send test of ${letter(card.chosen_variant)} to ${testTo ?? "me"}`}>
                <button type="button" className={cn(SECONDARY.replace("h-10 ", "min-h-10 "), "max-w-full py-1.5 text-left")} disabled={locked || !!loadError} onClick={() => void sendTest(card.chosen_variant!)}>
                  <Eye className="h-4 w-4 shrink-0" aria-hidden /> <span className="min-w-0">{busy === "test" ? "Sending test…" : <>Send test of {letter(card.chosen_variant)} to <span className="break-all">{testTo ?? "me"}</span></>}</span>
                </button>
              </ActionTooltip>
              <ActionTooltip description={hint(`Review the recipient count, then confirm retrying the previously approved version ${letter(card.chosen_variant)} to ${card.list.name}. The email content stays the same.`)} label="Try again">
                <button type="button" className={PRIMARY} disabled={locked} onClick={() => void retry()}>
                  {busy === "approve" ? "Trying again…" : "Try again"}
                </button>
              </ActionTooltip>
            </div>
          )}
        </div>
      )}
      {!card.open && OUTCOME_STATUSES.has(card.status) && (
        <>
          <SlipTracker steps={emailSlipSteps(card, stage, tool, "")} />
          <SendOutcome card={card} tool={tool} />
        </>
      )}
      {!card.open && IN_FLIGHT_STATUSES.has(card.status) && (
        <div data-testid="email-card-in-flight" className="space-y-2 px-4 py-3 text-[14px] text-ca-xdark">
          <div className="-mx-4 -mt-3">
            <SlipTracker steps={emailSlipSteps(card, stage, tool, inFlightLine(card))} />
          </div>
          {dispatchStalled && (
            <div data-testid="email-card-dispatch-unknown">
              <Banner tone="error" title={DISPATCH_UNKNOWN_TITLE}>
                {DISPATCH_UNKNOWN_LINE}
                <button type="button" className={cn(SECONDARY, "mt-2")} disabled={locked} onClick={() => void load()}>
                  Refresh
                </button>
              </Banner>
            </div>
          )}
          {canRetry && card.status === "held" && card.chosen_variant !== null && (
            <ActionTooltip description={hint(`Review the recipient count, then confirm sending the approved version ${letter(card.chosen_variant)} to ${card.list.name}. The email content stays the same.`)} label="Send now">
              <button type="button" className={PRIMARY} disabled={locked} onClick={() => void retry()}>
                {busy === "approve" ? "Sending…" : "Send now"}
              </button>
            </ActionTooltip>
          )}
          {canStop && (
            <ActionTooltip description={hint(`Open confirmation to stop everyone on ${card.list.name} who has not been sent yet. Emails that already went out stay sent.`)} label="Stop the rest">
              <button type="button" className={SECONDARY} disabled={locked || !!loadError} onClick={() => void stopRest()}>
                {busy === "stop" ? "Stopping…" : "Stop the rest"}
              </button>
            </ActionTooltip>
          )}
        </div>
      )}
      {cancellable && (
        <div className="flex justify-end px-4 pb-3 pt-1">
          <ActionTooltip placement="below" description={hint(cardMayHaveSent(card) ? "Remove this from your list. Its record stays in Sent emails." : "Remove this failed email from your list. Nothing is sent.")} label="Cancel">
            <button type="button" data-testid="email-card-cancel" className={SLIP_QUIET} disabled={locked} onClick={() => void cancelFailed()}>
              {busy === "reject" ? "Cancelling…" : "Cancel"}
            </button>
          </ActionTooltip>
        </div>
      )}
      {!card.open && (notice || resumable) && (
        <div className="space-y-2 border-t border-ca-border px-4 py-3">
          {notice && (
            <Banner tone={notice.tone} title={notice.title}>
              {notice.body}
              {notice.note && <span data-testid="email-card-test-via" className="mt-1 block">{notice.note}</span>}
              {notice.refresh && (
                <button type="button" className={cn(SECONDARY, "mt-2")} disabled={locked} onClick={() => void load()}>
                  Refresh
                </button>
              )}
              {notice.reload && (
                <button type="button" className={cn(SECONDARY, "mt-2")} onClick={() => window.location.reload()}>
                  Reload the page
                </button>
              )}
            </Banner>
          )}
          {resumable && approvalResume && (
            <ActionTooltip description={hint(`Open confirmation to resume the previously approved version ${letter(approvalResume.variant)} to ${card.list.name}. Confirming continues the send.`)} label="Resume approved send">
              <button type="button" className={PRIMARY} disabled={locked || !!loadError} onClick={() => void resumeApprovedSend()}>
                {busy === "approve" ? "Resuming…" : `Resume approved send ${letter(approvalResume.variant)}`}
              </button>
            </ActionTooltip>
          )}
        </div>
      )}
    </section>
  );
}

const FIELD = "h-10 w-full rounded-[10px] border border-ca-border bg-ca-bg px-3 text-[16px] text-ca-xdark outline-none focus:border-ca-strong";

function inFlightLine(c: EmailCardView): string {
  const L = c.chosen_variant ? `${letter(c.chosen_variant)} ` : "";
  const so = typeof c.sent_count === "number" ? ` ${people(c.sent_count)} sent so far.` : "";
  if (c.pause_hold === "paused") return c.rail === "channel_actions" ? PAUSED_TOOL_LINE : PAUSED_LINE;
  if (c.pause_hold === "resumed") return `${RESUMED_LINE} It goes ${L}to ${c.list.name}.`;
  switch (c.status) {
    case "sending":
      return `Sending ${L}to ${c.list.name}.${so}`;
    case "waiting_for_tomorrow":
      return `${so.trim() || "Part of it went out."} The rest go out over the coming days: Zavi sends a limited number of emails each day, fewer while a new sending address warms up.`;
    case "held":
      return `${c.failure_reason ?? "This send is on hold."}${so}`;
    default:
      return `Starting the send of ${L}to ${c.list.name}.`;
  }
}

export function ResultsRow({ label, r }: { label: string; r: EmailResultCounts }) {
  const unsubscribes = typeof r.unsubscribes === "number" && r.unsubscribes > 0 ? r.unsubscribes : null;
  const parts = ([[r.delivered_label ?? "Delivered", r.delivered], ["Opens", r.opens], ["Clicks", r.clicks], ["Unsubscribes", unsubscribes], ["Bounces", r.bounces]] as const)
    .filter(([, n]) => typeof n === "number")
    .map(([k, n]) => `${k} ${(n as number).toLocaleString("en-US")}`);
  const missing = new Map<string, string[]>();
  for (const [k, n] of [["Delivered", r.delivered], ["Opens", r.opens], ["Clicks", r.clicks]] as const) {
    const why = r.why?.[k.toLowerCase() as "delivered" | "opens" | "clicks"];
    if (typeof n !== "number" && why) missing.set(why, [...(missing.get(why) ?? []), k]);
  }
  if (parts.length === 0 && missing.size === 0) return null;
  return (
    <div data-testid="email-card-results">
      {parts.length > 0 && (
        <p className="text-[13px] text-ca-xdark">
          <span className="text-ca-secondary">{label} </span>
          {parts.join(" · ")}
        </p>
      )}
      {[...missing].map(([why, keys]) => (
        <p key={why} data-testid="email-card-results-why" className="text-[13px] text-ca-secondary">
          {keys.join(", ")}: {why}
        </p>
      ))}
      {unsubscribes !== null && r.unsubscribes_note && (
        <p data-testid="email-card-results-unsub-note" className="text-[13px] text-ca-secondary">
          Unsubscribes: {r.unsubscribes_note}
        </p>
      )}
      {r.note && (
        <p data-testid="email-card-results-note" className="text-[13px] text-ca-secondary">
          {r.note}
        </p>
      )}
    </div>
  );
}

export function leftOutLine(n: number, sent: boolean): string {
  const verb = sent ? (n === 1 ? "was" : "were") : n === 1 ? "is" : "are";
  return `${people(n)} on this list ${verb} left out because they unsubscribed or bounced.`;
}

export function suppressionLine(s: { suppressed: number; complete: boolean }, people: number | null): string {
  if (people !== null && people > 0 && s.suppressed >= people) return "Everyone on this list is unsubscribed in SendGrid, so it would reach nobody.";
  if (!s.complete) return "Zavi could not fully check who is unsubscribed in SendGrid, so some people may be skipped.";
  if (s.suppressed === 0) return "Nobody on this list is unsubscribed.";
  const left = people !== null ? ` ${(people - s.suppressed).toLocaleString("en-US")} of ${people.toLocaleString("en-US")} can get it.` : "";
  return `${s.suppressed.toLocaleString("en-US")} on this list ${s.suppressed === 1 ? "is" : "are"} unsubscribed, so SendGrid skips them.${left}`;
}

function SendOutcome({ card: c, tool }: { card: EmailCardView; tool: string }) {
  const when = c.sent_at ? formatWhen(c.sent_at) : null;
  const n = c.delivery ? c.sent_count ?? null : typeof c.outcome?.sent === "number" ? c.outcome.sent : typeof c.sent_count === "number" ? c.sent_count : null;
  const at = when ? ` on ${when}` : "";
  const mayHave = cardMayHaveSent(c);
  const reason = cardSendReason(c);
  const line =
    mayHave
      ? c.reconciliation_pending ? DISPATCH_UNKNOWN_TITLE : OUTCOME_UNKNOWN_LINE
      : c.status === "sent" && c.delivery === "nobody"
      ? `${tool} reached nobody${at}.`
      : c.status === "sent" && c.delivery === "unconfirmed"
      ? `${tool} accepted this send${at}. Delivery is not confirmed yet.`
      : c.status === "sent"
      ? `Sent${n !== null ? ` to ${people(n)}` : ""}${at}.`
      : c.status === "partially_sent"
        ? `Sent${n !== null ? ` to ${people(n)}` : " to part of the list"}${at}; the rest did not go.`
        : c.status === "outcome_unknown"
          ? c.reconciliation_pending ? DISPATCH_UNKNOWN_TITLE : OUTCOME_UNKNOWN_LINE
        : c.status === "stopped"
          ? `${stoppedAfter(n)}${at}. ${STOPPED_REST_LINE}`
          : "This email was not sent.";
  const r = c.results ?? null;
  return (
    <div data-testid="email-card-outcome" className="mx-4 my-3 space-y-1 rounded-xl border border-dashed border-ca-border px-3 py-2.5 text-[14px]">
      <p className="font-semibold text-ca-xdark">{line}</p>
      {(c.left_out_count ?? 0) > 0 && <p data-testid="email-card-left-out" className="text-[13px] text-ca-secondary">{leftOutLine(c.left_out_count ?? 0, true)}</p>}
      {reason && (mayHave || c.status !== "sent" || c.delivery === "nobody" || (c.skipped_count ?? 0) > 0) && <p data-testid="email-card-outcome-reason" className="text-[13px] text-ca-secondary">{reason}</p>}
      {r && !c.hour_1 && !c.day_7 && <ResultsRow label="Results so far:" r={r} />}
      {c.hour_1 && <ResultsRow label="After 1 hour:" r={c.hour_1} />}
      {c.day_7 && <ResultsRow label="At day 7:" r={c.day_7} />}
      {c.status === "sent" && !r && !c.hour_1 && !c.day_7 && (
        <p data-testid="email-card-results-pending" className="text-[13px] text-ca-secondary">
          Results not read from {tool} yet. Zavi reads them at 1 hour and day 7.
        </p>
      )}
    </div>
  );
}

function EditVersionForm({
  letter: L,
  value,
  onChange,
  busy,
  onSave,
  onCancel,
}: {
  letter: string;
  value: EmailContent;
  onChange: (next: EmailContent) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<EmailContent>) => onChange({ ...value, ...patch });
  const subjectBad = HEADER_CONTROL_CHARS.test(value.subject);
  const previewBad = HEADER_CONTROL_CHARS.test(value.preview_text);
  return (
    <form
      aria-label={`Edit version ${L}`}
      className="mt-3 grid gap-3 rounded-[12px] border border-ca-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (subjectBad || previewBad) return;
        onSave();
      }}
    >
      <div className="grid gap-1">
        <label className="grid gap-1 text-[14px] font-medium text-ca-xdark">
          Subject
          <input className={FIELD} value={value.subject} maxLength={200} aria-invalid={subjectBad} onChange={(e) => set({ subject: e.target.value })} />
        </label>
        {subjectBad && <p className="text-[13px] text-danger">Keep the subject on one line.</p>}
      </div>
      <div className="grid gap-1">
        <label className="grid gap-1 text-[14px] font-medium text-ca-xdark">
          Preview text
          <input className={FIELD} value={value.preview_text} maxLength={200} aria-invalid={previewBad} onChange={(e) => set({ preview_text: e.target.value })} />
        </label>
        {previewBad && <p className="text-[13px] text-danger">Keep the preview text on one line.</p>}
      </div>
      <label className="grid gap-1 text-[14px] font-medium text-ca-xdark">
        Title
        <input className={FIELD} value={value.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <label className="grid gap-1 text-[14px] font-medium text-ca-xdark">
        Paragraphs (a blank line starts a new one)
        <textarea
          className={`${FIELD} h-auto min-h-[140px] py-2`}
          value={value.paragraphs.join("\n\n")}
          onChange={(e) => set({ paragraphs: e.target.value.split(/\n\s*\n/) })}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-[14px] font-medium text-ca-xdark">
          Button label
          <input className={FIELD} value={value.button.label} maxLength={60} onChange={(e) => set({ button: { ...value.button, label: e.target.value } })} />
        </label>
        <label className="grid gap-1 text-[14px] font-medium text-ca-xdark">
          Button link (https)
          <input className={FIELD} value={value.button.url} onChange={(e) => set({ button: { ...value.button, url: e.target.value } })} />
        </label>
      </div>
      {(value.cards ?? []).map((c, k) => (
        <fieldset key={k} className="grid gap-2 rounded-[10px] border border-ca-border p-2">
          <legend className="px-1 text-[13px] font-medium text-ca-xdark">Card {k + 1}</legend>
          <input
            aria-label={`Card ${k + 1} title`}
            className={FIELD}
            value={c.title}
            onChange={(e) => set({ cards: (value.cards ?? []).map((x, j) => (j === k ? { ...x, title: e.target.value } : x)) })}
          />
          <input
            aria-label={`Card ${k + 1} detail`}
            className={FIELD}
            value={c.meta}
            onChange={(e) => set({ cards: (value.cards ?? []).map((x, j) => (j === k ? { ...x, meta: e.target.value } : x)) })}
          />
        </fieldset>
      ))}
      <p className="text-[13px] text-ca-secondary">{LOCKED_FIELDS_LINE}</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={PRIMARY} disabled={busy || subjectBad || previewBad}>
          {busy ? "Saving…" : `Save version ${L}`}
        </button>
        <button type="button" className={SECONDARY} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
