
import { createHash } from "node:crypto";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { EMAIL_PROVIDERS, EMAIL_TOOL_LABEL } from "@/services/connectors/email-campaign/providers";
import { isKeyRejected, KEY_REJECTED_WHY, keyRejectedText, RECONNECT_ANY_EMAIL_TOOL, REDRAFT_AFTER_RECONNECT } from "@/services/connectors/email-campaign/provider-errors";
import { KLAVIYO_KEY_INSTRUCTION } from "@/services/connectors/email-campaign/klaviyo-scopes";
import type { SuppressionCheck } from "@/services/connectors/email-campaign/providers";
import { deliveryOf, deliveryReason, type DeliveryState } from "@/services/email-results/delivery";
import {
  EMAIL_BODY_INVALID_SENTENCE,
  EMAIL_ALL_SUPPRESSED_ERROR,
  EMAIL_PAUSED_ERROR,
  EMAIL_PAUSED_MID_SEND_ERROR,
  EMAIL_PAUSED_ONE_TO_ONE_ERROR,
  EMAIL_TOOL_SEND_BOUND_MS,
  OUTCOME_UNKNOWN_SUFFIX,
  parseEmailSendBody,
  REDRAFT_REQUIRED_ERROR,
  connectedCall,
  type EmailSendDeps,
} from "@/services/connectors/email-campaign/execute-send";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { composioExecuteTool } from "@/services/connectors/composio/api";
import { bulkOutboundSendBody } from "@/services/comms/bulk-outbound/dispatch";
import { holdSentence, SENDING_ADDRESS_NOT_VERIFIED } from "@/services/comms/bulk-outbound/notices";
import { readLeftOut } from "@/services/comms/bulk-outbound/left-out";
import { readSentSoFar } from "@/services/comms/bulk-outbound/progress";
import { BULK_REFUSAL_SENTENCES } from "@/services/comms/bulk-outbound/readiness";
import type { GlobalBulkStop } from "@/services/comms/bulk-outbound/config";
import { DRAFT_BLOCKED_FALLBACK, DRAFT_BLOCKED_PREFIX, draftBlockedReason, PLAN_REFUSALS, SKIP_REASONS } from "@/services/email-plan/messages";
import { WORDS as LIST_DOOR_WORDS } from "@/services/email-plan/list-door";
import { RESUMABLE_HOLDS } from "@/services/admin-scripts/bulk-email";
import { webBaseUrl } from "@/services/web-base";
import { carriedNote, providerCell, ZAVI_UNSUB_NOTE, type Route as ResultsRoute } from "@/services/email-results/view";
import { chosenVersion, emailContentSchema, MAX_LIST_GROWTH, readTestListKeys, resealVariant, shaOf, templateSnapshotSchema, TEST_LIST_REFUSAL, testListKey } from "./variants";
import { FANOUT_STALLED_REASON, RELEASED_EXPIRED_REASON, RELEASED_PAUSED_REASON, RELEASED_SENDER_STOPPED_REASON, stalledSendNote } from "./recovery";
import { BULK_OUTBOUND_INTERRUPTED_LINE, BULK_OUTBOUND_INVALID_LINE, BULK_OUTBOUND_NOT_SENT_LINE } from "@/../workers/functions/dispatch-notice";
import { EmailRenderError, type EmailContent, type EmailRoute } from "@/services/email-templates/render";
import { confirmedEmailOf, sendBulkTestEmail, sendToolCardTest, TestSendError } from "./test-send";
import { bulkApproveStop, emailSendPaused, type BulkApproveStop } from "./pause";
import { RESUMABLE_HOLDS as HOLDS_TOLD_AT_THE_END } from "./outcome";

export const TOOL_KEY_REJECTED = `Your email tool rejected the key Zavi has saved for it ${KEY_REJECTED_WHY}, so nothing was sent. Waiting will not fix this: go to Connectors, disconnect the tool, then ${RECONNECT_ANY_EMAIL_TOOL}. ${REDRAFT_AFTER_RECONNECT} ${KLAVIYO_KEY_INSTRUCTION}`;

export const EMAIL_CARD_RAILS = ["channel_actions", "decisions"] as const;
export type EmailCardRail = (typeof EMAIL_CARD_RAILS)[number];

export function emailCardLink(rail: EmailCardRail, id: string, tenantId?: string): string {
  const base = `${webBaseUrl()}/workspace/email-cards/${rail}/${id}`;
  return tenantId ? `${base}?company=${encodeURIComponent(tenantId)}` : base;
}

export const EMAIL_CARD_MESSAGES: Record<string, string> = {
  not_found: "That email was not found.",
  redraft_required: "Ask Zavi to draft this email again: it was written before emails had versions.",
  not_open: "This email has already been decided.",
  bad_variant: "That version does not exist on this email.",
  rate_limited: "You sent 5 tests of this email in the last hour. Try again later.",
  card_changed: "The email changed while this was happening. Reload it and try again.",
  version_changed: "Someone changed this version after you opened it, so nothing was done. Reload to see the current text, then try again.",
  bad_content: "That version is not complete. Fill in the subject, title, at least one paragraph and the button.",
  not_authorized: "Only an owner or admin can approve an email. Send yourself a test and ask one of them.",
  test_required: "Send yourself a test of this version first. Approve unlocks once an owner or admin has the test.",
  all_suppressed: EMAIL_ALL_SUPPRESSED_ERROR,
  count_required: "Zavi could not count the people on the list right now, so nothing was sent. Try again in a minute.",
  list_grew_since_shown: "The list grew after Zavi showed you the number, by more than 10%, so nothing was sent. Check the new number and approve again.",
  tool_key_rejected: TOOL_KEY_REJECTED,
  exec_partial_no_retry: "This send cannot be tried again: part of it may already have gone out, or the email tool refused it for good. Ask Zavi to draft it again.",
  email_unverified: "Confirm your login email address first, then send the test again.",
  test_list_unknown: "Zavi could not check your test lists right now, so this can't be approved yet. Reload in a minute.",
  test_list: "This list is marked as a test list, so Zavi does not send a real email to it. Unmark it in Email campaigns settings, or ask Zavi for a new draft to another list.",
  plan_changed: "This draft belongs to a planned email that changed since it was written. Open Coming up for its current draft.",
  email_paused: "Email is paused for this workspace. Resume email in Email campaigns settings, then approve again.",
  not_stoppable: "Only a Zavi-list send that is still going out can be stopped.",
  list_send_in_flight: "Another email to this list is still going out, or Zavi is still checking whether it went. Wait for it to finish before sending another one to the same list.",
  scheduled_send_pending: "This email is scheduled to go out. Use Move or Don't send in Coming up first, then edit it.",
};

const CARD_STAYS_OPEN = "Nothing was sent, and this email stays open to approve once bulk email is back on.";

export const BULK_APPROVE_REFUSALS: Record<BulkApproveStop | "bulk_check_failed", string> = {
  bulk_abuse_hold: `${BULK_REFUSAL_SENTENCES.bulk_abuse_hold} ${CARD_STAYS_OPEN}`,
  bulk_outbound_disabled: `Bulk email is paused for this workspace because it was switched off. Contact support to switch it back on. ${CARD_STAYS_OPEN}`,
  bulk_check_failed: "Zavi could not check whether bulk email is on for this workspace, so nothing was sent and this email stays open. Try again in a minute.",
};

export const PLANNED_REASON_FALLBACK = "This email did not go out at its planned time.";

const PLANNED_REASON_MAPS: ReadonlyArray<Readonly<Record<string, string>>> = [SKIP_REASONS, EMAIL_CARD_MESSAGES, BULK_REFUSAL_SENTENCES, PLAN_REFUSALS];

export function plannedReason(code: string | null | undefined, route?: string | null): string | null {
  if (!code) return null;
  if (code.startsWith(DRAFT_BLOCKED_PREFIX)) {
    const refusal = code.slice(DRAFT_BLOCKED_PREFIX.length);
    const bulk: Readonly<Record<string, string>> = BULK_REFUSAL_SENTENCES;
    return draftBlockedReason(refusal, route) ?? (Object.prototype.hasOwnProperty.call(bulk, refusal) ? bulk[refusal] : DRAFT_BLOCKED_FALLBACK);
  }
  const map = PLANNED_REASON_MAPS.find((m) => Object.prototype.hasOwnProperty.call(m, code));
  return map ? map[code] : PLANNED_REASON_FALLBACK;
}

export function cardListKey(cls: string, body: Record<string, unknown>): string | null {
  if (cls === "bulk_outbound.send") return typeof body.list_id === "string" && body.list_id ? testListKey("zavi_list", body.list_id) : null;
  return typeof body.tool === "string" && typeof body.audience_id === "string" && body.audience_id ? testListKey(body.tool as EmailRoute, body.audience_id) : null;
}

export async function cardOnTestList(tenantId: string, cls: string, body: Record<string, unknown>, marks: typeof readTestListKeys = readTestListKeys): Promise<boolean> {
  const key = cardListKey(cls, body);
  return key !== null && (await marks(tenantId)).has(key);
}

export type ViewState = {
  ok: true;
  class: string;
  body: Record<string, unknown>;
  open: boolean;
  status: string;
  role: string;
  versions: number;
  tests: Array<{ variant: number; tested_by_me: boolean; tested_by_approver: boolean }>;
  retryable?: boolean;
  failure_reason?: string | null;
};
type Refusal = { ok: false; code: string; status?: string; message?: string };

async function rpc<T>(tenantId: string, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), name, args);
  if (error) throw new Error(`${name} failed`);
  return data as T;
}

export type ApprovedEvent =
  | { id: string; name: "channel-action.approved"; data: { action_id: string } }
  | { id: string; name: "decision.approved"; data: { decision_id: string; tenant_id: string; decision_class: string } };

export type CardDeps = {
  rpc: <T>(tenantId: string, name: string, args: Record<string, unknown>) => Promise<T>;
  leftOut: (tenantId: string, decisionId: string) => Promise<number | null>;
  sentSoFar: (tenantId: string, decisionId: string) => Promise<number | null>;
  liveCount: (tenantId: string, cls: string, body: unknown) => Promise<number | null>;
  senderWarning: (tenantId: string, cls: string, body: unknown) => Promise<string | null>;
  confirmedEmail: (userId: string) => Promise<string>;
  sendToolTest: typeof sendToolCardTest;
  sendListTest: typeof sendBulkTestEmail;
  enqueue: (event: ApprovedEvent) => Promise<void>;
  groupName: (tenantId: string, body: Record<string, unknown>) => Promise<string | null>;
  suppression: (tenantId: string, body: unknown) => Promise<SuppressionCheck | null>;
  paused: (tenantId: string) => Promise<boolean>;
  bulkStop: (tenantId: string) => Promise<BulkApproveStop | null>;
  senderStop: () => Promise<GlobalBulkStop>;
  wakeFanout: (sendId: string) => Promise<void>;
  tellStopped: (tenantId: string, sendId: string, decisionId: string) => Promise<void>;
  resultNote: (tenantId: string, rail: EmailCardRail, id: string) => Promise<string | null>;
};

export async function sendgridGroupName(tenantId: string, body: Record<string, unknown>): Promise<string | null> {
  try {
    const b = parseEmailSendBody(body);
    const id = b?.sendgrid_suppression_group_id;
    if (!b || b.tool !== "sendgrid" || !id) return null;
    const { resolveSendgridAccount } = await import("@/services/connectors/email-campaign/sendgrid-account");
    const { sendgridHttpCall } = await import("@/services/connectors/email-campaign/providers-sendgrid");
    const sg = await resolveSendgridAccount(tenantId);
    if (!sg) return null;
    const r = await sendgridHttpCall(sg.api_key)("SENDGRID_SUPPRESSION_GROUPS", {});
    const rows = r.ok && Array.isArray(r.data) ? (r.data as Array<{ id?: unknown; name?: unknown }>) : [];
    const g = rows.find((x) => String(x.id) === id);
    return typeof g?.name === "string" && g.name.trim() ? g.name.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}

export async function cardSuppression(tenantId: string, body: unknown): Promise<SuppressionCheck | null> {
  const b = parseEmailSendBody(body);
  if (!b || b.tool !== "sendgrid" || !b.sendgrid_suppression_group_id) return null;
  try {
    const call = connectedCall(tenantId, b, { resolveAccount: resolveOwnedComposioAccount, exec: composioExecuteTool });
    return (await EMAIL_PROVIDERS.sendgrid.suppressedOnList?.(call, b.audience_id, b.sendgrid_suppression_group_id)) ?? null;
  } catch {
    return { suppressed: 0, complete: false };
  }
}

export async function liveCardCount(tenantId: string, cls: string, body: unknown): Promise<number | null> {
  try {
    if (cls === "bulk_outbound.send") {
      const b = bulkOutboundSendBody.safeParse(body);
      if (!b.success) return null;
      const { data, error } = await tenantRpc(asTenantId(tenantId), "email_list_version_freeze_count", { p_version_id: b.data.list_version_id });
      return error || typeof data !== "number" ? null : data;
    }
    const b = parseEmailSendBody(body);
    if (!b) return null;
    const call = connectedCall(tenantId, b, { resolveAccount: resolveOwnedComposioAccount, exec: composioExecuteTool });
    const audience = await EMAIL_PROVIDERS[b.tool].getAudience(call, b.audience_id);
    return audience?.member_count ?? null;
  } catch (e) {
    if (isKeyRejected(e)) throw new EmailToolKeyRejected();
    return null;
  }
}

export const LIVE_COUNT_WAIT_MS = 2_500;
export const CARD_READ_GIVE_UP_MS = 30_000;
const CARD_READS_REMEMBERED = 2_000;

export type CardRead<T> = { value: T | null; late: boolean };
export type CardReads = <T>(tenantId: string, key: string, read: () => Promise<T | null>) => Promise<CardRead<T>>;

export function cardVendorReads(): CardReads {
  const known = new Map<string, unknown>();
  const running = new Map<string, Promise<unknown>>();
  const remember = (key: string, value: unknown) => {
    known.delete(key);
    if (value === null) return;
    known.set(key, value);
    if (known.size > CARD_READS_REMEMBERED) known.delete(known.keys().next().value as string);
  };
  const started = (key: string, read: () => Promise<unknown>): Promise<unknown> => {
    const going = running.get(key);
    if (going) return going;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const reading = Promise.resolve().then(read).then(
      (value) => {
        remember(key, value);
        return value;
      },
      () => {
        remember(key, null);
        return null;
      },
    );
    const waited = new Promise<null>((resolve) => {
      giveUp = setTimeout(() => resolve(null), CARD_READ_GIVE_UP_MS);
      giveUp.unref?.();
    });
    const shared = Promise.race([reading, waited]).finally(() => {
      clearTimeout(giveUp);
      running.delete(key);
    });
    running.set(key, shared);
    return shared;
  };
  return async <T>(tenantId: string, key: string, read: () => Promise<T | null>): Promise<CardRead<T>> => {
    const scoped = `${tenantId}:${key}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ late: true }>((resolve) => {
      timer = setTimeout(() => resolve({ late: true }), LIVE_COUNT_WAIT_MS);
    });
    try {
      const answer = await Promise.race([started(scoped, read).then((value) => ({ late: false as const, value: value as T | null })), late]);
      return answer.late ? { value: (known.get(scoped) as T | undefined) ?? null, late: true } : answer;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function cardCountKey(cls: string, body: Record<string, unknown>): string {
  return `count:${JSON.stringify([cls, body.tool, body.audience_id, body.list_version_id, body.credential, body.connected_account_id])}`;
}

const senderDomainUnauthenticated = (domain: string): string =>
  `Mailchimp shows ${domain} is not authenticated, so this email can land in spam or never arrive, even if it shows as sent. Authenticate the domain in Mailchimp first.`;

export async function cardSenderWarning(
  tenantId: string,
  cls: string,
  body: unknown,
  deps: Pick<EmailSendDeps, "resolveAccount" | "exec"> = { resolveAccount: resolveOwnedComposioAccount, exec: composioExecuteTool },
): Promise<string | null> {
  try {
    if (cls === "bulk_outbound.send") return null;
    const b = parseEmailSendBody(body);
    const check = b ? EMAIL_PROVIDERS[b.tool].senderDomainAuthenticated : undefined;
    if (!b || !check) return null;
    const domain = (b.reply_to ?? b.from_email).split("@")[1]?.trim().toLowerCase();
    if (!domain) return null;
    return (await check(connectedCall(tenantId, b, deps), domain)) === false ? senderDomainUnauthenticated(domain) : null;
  } catch {
    return null;
  }
}

export class EmailToolKeyRejected extends Error {
  readonly code = "tool_key_rejected";
  constructor() {
    super("tool_key_rejected");
    this.name = "EmailToolKeyRejected";
  }
}

const LIVE: CardDeps = {
  rpc,
  leftOut: (tenantId, decisionId) => readLeftOut(tenantId, { decision_id: decisionId }),
  sentSoFar: readSentSoFar,
  liveCount: liveCardCount,
  senderWarning: (tenantId, cls, body) => cardSenderWarning(tenantId, cls, body),
  confirmedEmail: (userId) => confirmedEmailOf(userId),
  sendToolTest: sendToolCardTest,
  sendListTest: sendBulkTestEmail,
  enqueue: async (e) => {
    const { inngest } = await import("@/../workers/client");
    if (e.name === "channel-action.approved") await inngest.send({ id: e.id, name: e.name, data: e.data });
    else await inngest.send({ id: e.id, name: e.name, data: e.data });
  },
  groupName: sendgridGroupName,
  suppression: cardSuppression,
  paused: emailSendPaused,
  bulkStop: (tenantId) => bulkApproveStop(tenantId),
  senderStop: async () => (await import("@/services/comms/bulk-outbound/config")).readGlobalBulkStop(),
  wakeFanout: async (sendId) => {
    const { inngest } = await import("@/../workers/client");
    await inngest.send({ id: `bulk-email-fanout:${sendId}:stopped`, name: "bulk-email/fanout.stopped", data: { send_id: sendId } });
  },
  tellStopped: async (tenantId, sendId, decisionId) => {
    const [{ supabaseBulkSendStore: store }, { STALE_SENDING_SECONDS }, { bulkSendLine }, { postBulkSendNotice }, { bulkSendOutcome }, { tellEmailSendOutcomeOrQueue }] = await Promise.all([
      import("@/services/comms/bulk-outbound/store"),
      import("@/services/comms/bulk-outbound/fanout"),
      import("@/services/comms/bulk-outbound/notices"),
      import("@/services/comms/bulk-outbound/thread-notice"),
      import("./outcome"),
      import("./outcome-tell"),
    ]);
    await store.markStaleUnknown(tenantId, sendId, STALE_SENDING_SECONDS);
    const counts = await store.settleSend(tenantId, sendId, null);
    const line = bulkSendLine("held", counts);
    await postBulkSendNotice(tenantId, sendId, line).catch(() => false);
    const o = bulkSendOutcome(tenantId, decisionId, "held", counts, line);
    if (o) await tellEmailSendOutcomeOrQueue(o);
  },
  resultNote: async (tenantId, rail, id) => {
    const { data, error } = await tenantClient(asTenantId(tenantId)).from("email_send_results").select("note").eq("rail", rail).eq("card_id", id).maybeSingle();
    if (error) throw new Error("email_send_results read failed");
    return (data as { note?: string | null } | null)?.note ?? null;
  },
};

export async function emailCardViewState(
  tenantId: string,
  rail: EmailCardRail,
  id: string,
  userId: string,
  deps: Partial<CardDeps> = {},
): Promise<ViewState | Refusal> {
  const d = { ...LIVE, ...deps };
  return d.rpc<ViewState | Refusal>(tenantId, "email_card_view_state", { p_rail: rail, p_id: id, p_user_id: userId });
}

export async function plannedForCard(tenantId: string, rail: EmailCardRail, id: string, deps: Partial<CardDeps> = {}) {
  const d = { ...LIVE, ...deps };
  try {
    const p = await d.rpc<{
      id: string;
      planned_at: string;
      timezone: string;
      status: string;
      status_reason: string | null;
      schedule_gen: number;
      content_version: number;
      vetoed: boolean;
      scheduled: { variant: number; count: number; by: string } | null;
    } | null>(tenantId, "email_planned_for_card", { p_rail: rail, p_card_id: id });
    if (!p) return null;
    const { wallLabel } = await import("@/services/email-plan/time");
    return {
      ...p,
      planned_label: wallLabel(p.planned_at, p.timezone),
      reason: plannedReason(p.status_reason),
    };
  } catch {
    return null;
  }
}

const FIELD_NAMES: Record<string, string> = {
  subject: "subject",
  preview_text: "preview line",
  title: "title",
  "hero.big": "headline",
  "hero.small": "line under the headline",
  "button.label": "button label",
  "button.url": "button link",
};

const CARD_FIELD_NAMES: Record<string, string> = { title: "title", meta: "detail", price: "price", url: "link", image_url: "image link" };

function tooLongSentence(issues: ReadonlyArray<{ code: string; path: PropertyKey[]; maximum?: number | bigint }>): string | undefined {
  const issue = issues.find((i) => i.code === "too_big");
  if (!issue || issue.maximum === undefined) return undefined;
  const max = issue.maximum.toLocaleString("en-US");
  const [field, index, inner] = issue.path;
  if (field === "paragraphs") {
    return typeof index === "number" ? `Paragraph ${index + 1} is too long. Keep it to ${max} characters or fewer.` : `There are too many paragraphs. Keep it to ${max} or fewer.`;
  }
  if (field === "cards") {
    if (typeof index !== "number") return `There are too many cards. Keep it to ${max} or fewer.`;
    const name = CARD_FIELD_NAMES[String(inner)];
    return name ? `The ${name} on card ${index + 1} is too long. Keep it to ${max} characters or fewer.` : undefined;
  }
  const name = FIELD_NAMES[issue.path.map(String).join(".")];
  return name ? `The ${name} is too long. Keep it to ${max} characters or fewer.` : undefined;
}

export function versionSha(variant: unknown): string {
  return createHash("sha256").update(JSON.stringify(variant ?? null)).digest("hex");
}

function variantOf(body: Record<string, unknown>, variant: number): unknown {
  const all = body.variants;
  return Array.isArray(all) ? all[variant - 1] : undefined;
}

function isPointer(v: unknown): v is { rail: EmailCardRail; id: string } {
  const p = v as { rail?: unknown; id?: unknown } | null;
  return !!p && (p.rail === "channel_actions" || p.rail === "decisions") && typeof p.id === "string";
}

export async function editEmailCardVersion(
  tenantId: string,
  rail: EmailCardRail,
  id: string,
  variant: number,
  userId: string,
  content: unknown,
  deps: Partial<CardDeps> = {},
  seen: string | null = null,
): Promise<{ ok: true } | Refusal> {
  const d = { ...LIVE, ...deps };
  const parsed = emailContentSchema.safeParse(content);
  if (!parsed.success) return { ok: false, code: "bad_content", message: parsed.error.issues.find((i) => i.code === "custom")?.message ?? tooLongSentence(parsed.error.issues) };
  const view = await d.rpc<ViewState | Refusal>(tenantId, "email_card_view_state", { p_rail: rail, p_id: id, p_user_id: userId });
  if (!view.ok) return view;
  if (view.versions === 0) return { ok: false, code: "redraft_required" };
  if (!view.open) return { ok: false, code: "not_open" };
  if (variant < 1 || variant > view.versions) return { ok: false, code: "bad_variant" };
  if (seen !== null && versionSha(variantOf(view.body, variant)) !== seen) return { ok: false, code: "version_changed", message: EMAIL_CARD_MESSAGES.version_changed };
  const snap = templateSnapshotSchema.safeParse(view.body.template_snapshot);
  if (!snap.success) return { ok: false, code: "redraft_required" };
  const route = (view.class === "bulk_outbound.send" ? "zavi_list" : view.body.tool) as EmailRoute;
  let sealed;
  try {
    sealed = resealVariant(snap.data, route, parsed.data as EmailContent, String(view.body.renderer_version ?? ""));
  } catch (e) {
    if (e instanceof EmailRenderError) return { ok: false, code: "bad_content", message: e.message };
    throw e;
  }
  if (shaOf(String(view.body.renderer_version ?? ""), sealed.html, sealed.text) !== sealed.render_sha) return { ok: false, code: "bad_content" };
  const out = await d.rpc<{ ok: true } | Refusal>(tenantId, "edit_email_card_variant", {
    p_rail: rail,
    p_id: id,
    p_variant: variant,
    p_user_id: userId,
    p_expected_body: view.body,
    p_sealed: sealed,
  });
  return out.ok ? { ok: true } : out;
}

export function cardView(rail: EmailCardRail, id: string, s: ViewState, groupName: string | null = null, testList: boolean | null = false, suppression: SuppressionCheck | null = null) {
  const blocked = testList !== false;
  const b = s.body as Record<string, unknown> & { variants?: Array<{ content: { subject: string; preview_text: string }; html: string }> };
  const canApproveRole = s.role === "owner" || s.role === "admin";
  const versions = (b.variants ?? []).map((v, i) => {
    const t = s.tests[i] ?? { tested_by_me: false, tested_by_approver: false };
    return { variant: i + 1, subject: v.content.subject, preview_text: v.content.preview_text, html: v.html, content: v.content, seen: versionSha(v), tested_by_me: t.tested_by_me, tested_by_approver: t.tested_by_approver };
  });
  const reasons: string[] = [];
  if (s.versions === 0) reasons.push(EMAIL_CARD_MESSAGES.redraft_required);
  else if (blocked && (s.open || s.retryable)) reasons.push(testList === null ? EMAIL_CARD_MESSAGES.test_list_unknown : EMAIL_CARD_MESSAGES.test_list);
  else if (!s.open) reasons.push(EMAIL_CARD_MESSAGES.not_open);
  else if (!canApproveRole) reasons.push(EMAIL_CARD_MESSAGES.not_authorized);
  return {
    rail,
    id,
    class: s.class,
    status: s.status,
    open: s.open,
    link: emailCardLink(rail, id),
    route: s.class === "bulk_outbound.send" ? "zavi_list" : (b.tool as string),
    list: s.class === "bulk_outbound.send"
      ? { name: b.list_name, people: b.est_recipient_count ?? null, ...(typeof b.will_be_skipped === "number" && b.will_be_skipped > 0 ? { left_out: b.will_be_skipped } : {}) }
      : { name: b.audience_name, people: b.approved_count ?? null },
    sender: s.class === "bulk_outbound.send" ? { email: b.from_address, name: null } : { email: b.from_email, name: b.from_name },
    reply_to: b.reply_to ?? null,
    unsubscribe_group_id: typeof b.sendgrid_suppression_group_id === "string" ? b.sendgrid_suppression_group_id : null,
    unsubscribe_group_name: groupName,
    suppression,
    viewer_can_approve: canApproveRole,
    retryable: s.retryable === true && !blocked,
    test_list: testList === true,
    test_list_unknown: testList === null,
    failure_reason: stateSendError(s.status, s.failure_reason, s.class),
    chosen_variant: b.chosen_variant ?? null,
    replaced_by: isPointer(b.replaced_by) ? b.replaced_by : null,
    learnings_read: learningsReadOf(b.learnings_read),
    editable: s.open && s.versions > 0 && s.status !== "failed" && s.role !== "viewer",
    versions,
    can_approve: versions.map((v) => s.open && canApproveRole && v.tested_by_approver && !blocked),
    reasons,
  };
}

export function learningsReadOf(raw: unknown): { status: "ok" | "empty" | "read_failed" | "snapshot_failed" | null; items: Array<{ id: string; text: string }> } {
  const items = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is { id: string; text: string } => !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string" && typeof (x as { text?: unknown }).text === "string")
      .map((x) => ({ id: x.id, text: x.text }))
      .slice(0, 12);
  if (Array.isArray(raw)) return { status: "ok", items: items(raw) };
  if (raw && typeof raw === "object") {
    const s = (raw as { status?: unknown }).status;
    if (s === "ok" || s === "empty" || s === "read_failed" || s === "snapshot_failed") return { status: s, items: items((raw as { items?: unknown }).items) };
  }
  return { status: null, items: [] };
}

export async function sendEmailCardTest(
  tenantId: string,
  rail: EmailCardRail,
  id: string,
  variant: number,
  userId: string,
  deps: Partial<CardDeps> = {},
): Promise<{ ok: true; via: string; warning?: string } | Refusal> {
  const d = { ...LIVE, ...deps };
  const pre = await d.rpc<({ ok: true; class: string; body: Record<string, unknown>; test_sha: string }) | Refusal>(tenantId, "email_card_for_test", {
    p_rail: rail,
    p_id: id,
    p_variant: variant,
    p_user_id: userId,
  });
  if (!pre.ok) return pre;
  let to: string;
  try {
    to = await d.confirmedEmail(userId);
  } catch (e) {
    if (e instanceof TestSendError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
  let via: string;
  let warning: string | undefined;
  try {
    if (pre.class === "bulk_outbound.send") {
      const b = bulkOutboundSendBody.safeParse(pre.body);
      const c = b.success && b.data.variants ? chosenVersion({ variants: b.data.variants, renderer_version: b.data.renderer_version ?? "", chosen_variant: variant }) : null;
      if (!b.success || !c?.ok) return { ok: false, code: "redraft_required" };
      ({ via } = await d.sendListTest(tenantId, b.data, c.version, to));
    } else {
      const b = parseEmailSendBody(pre.body);
      const c = b?.variants ? chosenVersion({ variants: b.variants, renderer_version: b.renderer_version ?? "", chosen_variant: variant }) : null;
      if (!b || !c?.ok) return { ok: false, code: "redraft_required" };
      ({ via, warning } = await d.sendToolTest(tenantId, b, c.version, to));
    }
  } catch (e) {
    if (e instanceof TestSendError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
  const rec = await d.rpc<{ ok: true } | Refusal>(tenantId, "record_email_test_send", {
    p_rail: rail,
    p_id: id,
    p_variant: variant,
    p_user_id: userId,
    p_test_sha: pre.test_sha,
  });
  if (!rec.ok) return warning ? { ...rec, message: rec.message ? `${rec.message} ${warning}` : warning } : rec;
  const sender = await d.senderWarning(tenantId, pre.class, pre.body).catch(() => null);
  const note = [warning, sender].filter(Boolean).join(" ");
  return note ? { ok: true, via, warning: note } : { ok: true, via };
}

export type ApproveOutcome =
  | { ok: true; queued: boolean; changed: boolean; paused?: boolean }
  | Refusal;

export async function approveEmailCard(
  tenantId: string,
  rail: EmailCardRail,
  id: string,
  variant: number,
  userId: string,
  requestId: string,
  deps: Partial<CardDeps> = {},
  seen: string | null = null,
  seenPeople: number | null = null,
): Promise<ApproveOutcome> {
  const d = { ...LIVE, ...deps };
  const view = await d.rpc<ViewState | Refusal>(tenantId, "email_card_view_state", { p_rail: rail, p_id: id, p_user_id: userId });
  if (!view.ok) return view;
  const expected = seen === null ? undefined : variantOf(view.body, variant);
  if (seen !== null && (expected === undefined || versionSha(expected) !== seen)) return { ok: false, code: "version_changed" };
  if (view.class === "bulk_outbound.send" && (view.open || view.retryable)) {
    const stop = await d.bulkStop(tenantId).catch(() => "bulk_check_failed" as const);
    if (stop) return { ok: false, code: stop, message: BULK_APPROVE_REFUSALS[stop] };
  }
  let count: number | null = null;
  try {
    count = view.open || view.retryable ? await d.liveCount(tenantId, view.class, view.body) : null;
  } catch (e) {
    if (e instanceof EmailToolKeyRejected) return { ok: false, code: "tool_key_rejected" };
    throw e;
  }
  if (view.retryable && count === null) return { ok: false, code: "count_required" };
  if (seenPeople !== null && count !== null && count > Math.floor(seenPeople * (1 + MAX_LIST_GROWTH))) return { ok: false, code: "list_grew_since_shown" };
  if (count !== null && count > 0) {
    const sup = await d.suppression(tenantId, view.body);
    if (sup && sup.suppressed >= count) return { ok: false, code: "all_suppressed" };
  }
  const args = {
    p_rail: rail,
    p_id: id,
    p_variant: variant,
    p_actor_user_id: userId,
    p_event_key: requestId,
    p_approved_count: seenPeople !== null && count !== null && view.class !== "bulk_outbound.send" ? Math.min(count, seenPeople) : count,
  };
  const out = expected === undefined
    ? await d.rpc<Record<string, unknown>>(tenantId, "approve_email_card", args)
    : await d.rpc<Record<string, unknown>>(tenantId, "approve_email_card_seen", { ...args, p_expected_variant: expected });
  if (out.ok !== true) return { ok: false, code: typeof out.code === "string" ? out.code : "refused" };
  const paused = await d.paused(tenantId).then((p) => p === true, () => false);
  if (rail === "channel_actions") {
    const fresh = out.replayed !== true;
    const stillQueued = out.exec_status === "queued";
    if (fresh || stillQueued) {
      await d.enqueue({ id: `approve:${id}:${Number(out.attempt ?? 1)}`, name: "channel-action.approved", data: { action_id: id } });
    }
    return paused ? { ok: true, queued: true, changed: fresh, paused } : { ok: true, queued: true, changed: fresh };
  }
  if (out.status === "approved") {
    const key = typeof out.redispatch_key === "string" ? out.redispatch_key : null;
    await d.enqueue({ id: key ? `approve:${id}:${key}` : `approve:${id}`, name: "decision.approved", data: { decision_id: id, tenant_id: tenantId, decision_class: view.class } });
  }
  return paused ? { ok: true, queued: true, changed: out.changed === true, paused } : { ok: true, queued: true, changed: out.changed === true };
}

export type SendFacts = {
  card: {
    status: string;
    exec_status?: string | null;
    approved: boolean;
    executed_at?: string | null;
    claimed_at?: string | null;
    approved_at?: string | null;
    dispatched_at?: string | null;
    code?: string | null;
    bucket?: string | null;
    not_sent?: boolean;
    error?: string | null;
    receipt?: { line?: string } | null;
  };
  bulk: {
    status: string;
    hold_reason: string | null;
    total: number;
    sent: number;
    skipped: number;
    failed: number;
    unknown: number;
    hard_bounces: number;
    created_at: string;
    finished_at: string | null;
    next_run_at: string | null;
    left_out?: number | null;
  } | null;
  results: { sent_count: number; finished_at: string; h1: Record<string, unknown>; d7: Record<string, unknown>; d7_published: boolean; note?: string | null } | null;
} | null;

export type CardSendStatus =
  | "approved" | "queued" | "dispatching" | "sending" | "waiting_for_tomorrow" | "held"
  | "sent" | "partially_sent" | "outcome_unknown" | "stopped" | "failed" | "not_sent";

export type ResultsWhy = { delivered: string | null; opens: string | null; clicks: string | null };
export type ResultCounts = { delivered: number | null; delivered_label?: string; opens: number | null; clicks: number | null; unsubscribes?: number | null; unsubscribes_note?: string; bounces: number | null; why?: ResultsWhy; note?: string };

export type CardSendState = {
  delivery?: DeliveryState;
  skipped_count?: number;
  left_out_count?: number;
  status: string;
  retryable: boolean;
  sent_at: string | null;
  sent_count: number | null;
  failure_reason: string | null;
  may_have_sent: boolean;
  reconciliation_pending: boolean;
  results: ResultCounts | null;
  hour_1?: ResultCounts;
  day_7?: ResultCounts;
  dispatching_since?: string | null;
};

export type PauseHold = "paused" | "resumed" | null;

const NOT_STARTED = new Set(["approved", "queued"]);

export function pauseHoldOf(rail: EmailCardRail, status: string, facts: SendFacts, paused: boolean | null): PauseHold {
  const heldByPause = rail === "decisions" && facts?.card.error === "email_paused";
  if (!NOT_STARTED.has(status) && !(status === "dispatching" && heldByPause)) return null;
  if (paused === true) return "paused";
  if (!heldByPause) return null;
  return paused === false ? "resumed" : "paused";
}

export const STUCK_AFTER_MS = 15 * 60 * 1000;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
function whyOf(o: Record<string, unknown>, route: ResultsRoute | null): { why: ResultsWhy } | Record<string, never> {
  if (!route) return {};
  return { why: { delivered: providerCell(o, "delivered", route).why, opens: providerCell(o, "opens", route).why, clicks: providerCell(o, "clicks", route).why } };
}
function noteOf(o: Record<string, unknown>, route: ResultsRoute | null, stored: string | null): { note: string } | Record<string, never> {
  const note = route ? carriedNote(o, route, stored) : null;
  return note ? { note } : {};
}
function unsubOf(o: Record<string, unknown>, route: ResultsRoute | null): Pick<ResultCounts, "unsubscribes" | "unsubscribes_note"> {
  const n = num(o.unsubscribes);
  return { unsubscribes: n, ...(route === "zavi_list" && n !== null && n > 0 ? { unsubscribes_note: ZAVI_UNSUB_NOTE } : {}) };
}
export const stageCounts = (o: Record<string, unknown> | null | undefined, bounces: number | null = null, route: ResultsRoute | null = null, stored: string | null = null): ResultCounts | undefined =>
  o && Object.keys(o).length > 0
    ? { delivered: num(o.delivered), ...(route === "mailchimp" ? { delivered_label: "Not bounced" } : {}), opens: num(o.opens), clicks: num(o.clicks), ...unsubOf(o, route), bounces: route !== null && route !== "zavi_list" ? null : num(o.bounces) ?? bounces, ...whyOf(o, route), ...noteOf(o, route, stored) }
    : undefined;

function stuck(since: string | null | undefined, now: number): boolean {
  const t = since ? Date.parse(since) : NaN;
  return Number.isFinite(t) && now - t > STUCK_AFTER_MS;
}

function sinceOver(since: string | null | undefined, ms: number, now: number): boolean {
  const t = since ? Date.parse(since) : NaN;
  return Number.isFinite(t) && now - t > ms;
}

export const BULK_MAY_HAVE_GONE_OUT =
  "These emails may have gone out: the email provider did not confirm them. Zavi will not send this email again, so nobody gets it twice.";

export const TOOL_SEND_NO_ANSWER =
  "Zavi did not hear back from the email tool about this send, so it may have gone out. Zavi will not send it again, so nobody gets it twice. Check the email tool to see whether it went out.";

export const ZAVI_SEND_NO_ANSWER =
  "Zavi did not hear back from its sending service about this send, so it may have gone out. Zavi will not send it again, so nobody gets it twice.";

export const SENDER_STOPPED_NOT_SENT =
  "Zavi sender stopped: Zavi's own sender is stopped for every workspace right now, so nothing was sent. Zavi tries again on its own once the sender is running, or you can Send now then.";

export const SENDER_WAS_STOPPED_NOT_SENT =
  "Zavi sender stopped: Zavi's own sender was stopped for every workspace when Zavi went to send this approved email, so nothing was sent. Zavi tries again on its own once the sender is running, or you can Send now then.";

export const SENDER_RUNNING_AGAIN_NOT_SENT =
  "Zavi's own sender was stopped for every workspace when Zavi went to send this approved email, so nothing was sent. The sender is running again: Zavi tries again on its own, or you can Send now.";

export function heldSenderReason(stop: GlobalBulkStop | null): string {
  if (stop === "stopped") return SENDER_STOPPED_NOT_SENT;
  if (stop === "running") return SENDER_RUNNING_AGAIN_NOT_SENT;
  return SENDER_WAS_STOPPED_NOT_SENT;
}

export const SEND_FAILED_FALLBACK = "Zavi could not finish this send. Ask Zavi for a new draft.";

const SEND_ERROR_TEXT_CODES: Readonly<Record<string, string>> = {
  "email_campaign.create_and_send body invalid": "email_campaign_body_invalid",
};

type SendTemplate = { t: string; drop?: string };

const DID_NOT_ACCEPT = "{tool} did not accept this email. Nothing was sent.";

const SEND_SENTENCE_TEMPLATES = (): readonly SendTemplate[] => [
  { t: "{text} Nothing was sent. Open the email in Zavi and approve a version there.", drop: "Nothing was sent. Open the email in Zavi and approve a version there." },
  { t: "{tool} is not connected, or a different {tool} account is connected now. Nothing was sent. Reconnect {tool}, then approve again." },
  { t: "This email was approved for the {tool} connection that was in place when it was drafted, and a different one is connected now. Nothing was sent. Ask Zavi to draft it again so it uses the current connection." },
  { t: '{tool} did not accept this: more than one campaign named "{name}" exists there, so Zavi cannot tell which is this one. Nothing was sent.', drop: DID_NOT_ACCEPT },
  { t: '{tool} did not accept this: the campaign named "{name}" goes to a different list. Nothing was sent.', drop: DID_NOT_ACCEPT },
  { t: '{tool} did not accept this: the campaign named "{name}" is {text} there. Nothing was sent.', drop: DID_NOT_ACCEPT },
  { t: "{tool} did not accept this: {email} is not a verified sender in SendGrid. Nothing was sent.", drop: DID_NOT_ACCEPT },
  { t: "{tool} did not accept this: more than one verified sender in SendGrid uses {email}, so Zavi cannot tell which one to send as. Nothing was sent.", drop: DID_NOT_ACCEPT },
  { t: "{tool} did not accept this: {text} Nothing was sent.", drop: DID_NOT_ACCEPT },
  { t: "{tool} did not accept this retry: {text} Nothing was sent.", drop: "{tool} did not accept this retry. Nothing was sent." },
  { t: "{tool} did not accept this retry. Nothing was sent." },
  { t: DID_NOT_ACCEPT },
  { t: '{tool} did not accept this email. {tool} said: "{text}" Nothing was sent.', drop: DID_NOT_ACCEPT },
  { t: "{tool} no longer has the list this email was drafted for. Nothing was sent. Ask Zavi to draft it again." },
  {
    t: "Zavi stopped this send: the {text} in {tool} changed since the card was made. Nothing was sent. Ask Zavi for a new draft if the change is right.",
    drop: "Zavi stopped this send: the email in {tool} changed since the card was made. Nothing was sent. Ask Zavi for a new draft if the change is right.",
  },
  { t: "{tool} did not confirm whether this email was sent. Zavi will not send it again, so nobody gets it twice. Zavi checks {tool} in a few minutes and updates this card." },
  { t: "{tool} did not confirm whether this email was sent. Zavi will not send it again, so nobody gets it twice. Open {tool} to see whether it went out." },
  {
    t: '{tool} did not say how many people are on "{name}" right now, so Zavi did not send. Nothing was sent. Approve it again.',
    drop: "{tool} did not say how many people are on the list right now, so Zavi did not send. Nothing was sent. Approve it again.",
  },
  { t: "{tool} did not say how many people are on the list right now, so Zavi did not send. Nothing was sent. Approve it again." },
  { t: 'The list "{name}" is no longer in {tool}. Nothing was sent.', drop: "The list is no longer in {tool}. Nothing was sent." },
  { t: "The list is no longer in {tool}. Nothing was sent." },
  { t: "{tool} did not confirm the new campaign. Nothing was sent. Approve it again: Zavi looks for the campaign first, so no second copy is made." },
  { t: "Autopilot did not send this on its own: it is not from the sender picked in Email campaigns settings, or your default sender in {tool}. Nothing was sent. Send it yourself if the sender on the card is right." },
  { t: "Zavi could not confirm the campaign's state in {tool}. Nothing was sent by Zavi. Approve it again: Zavi checks the campaign first and never sends it twice." },
  { t: "Zavi stopped this retry because the campaign in {tool} no longer goes to the approved list. Nothing was sent by Zavi. Ask Zavi for a new draft if the change is right." },
  { t: "Zavi could not recheck the campaign after {tool} asked it to wait, so it did not retry. Nothing was sent. The draft is still in {tool}." },
  {
    t: "{tool} refused to send this: {text}. Nothing was sent. The draft is in {tool}; send it from there, or ask Zavi for a new one.",
    drop: "{tool} refused to send this. Nothing was sent. The draft is in {tool}; send it from there, or ask Zavi for a new one.",
  },
  { t: "{tool} refused to send this. Nothing was sent. The draft is in {tool}; send it from there, or ask Zavi for a new one." },
  {
    t: "{tool} refused to send this: {text}. Zavi could not read the campaign back to confirm nothing went out. Check it in {tool}; Zavi will not send it again.",
    drop: "{tool} refused to send this. Zavi could not read the campaign back to confirm nothing went out. Check it in {tool}; Zavi will not send it again.",
  },
  { t: "{tool} refused to send this. Zavi could not read the campaign back to confirm nothing went out. Check it in {tool}; Zavi will not send it again." },
  { t: "{tool} did not answer clearly. Nothing was sent. Approve it again: Zavi picks up where it stopped." },
  { t: "Zavi could not finish this in {tool}. Nothing was sent. Approve it again." },
  { t: "{tool} is sending this campaign to a different list than the card. Zavi did not start that send and will not send this card again. Check it in {tool}." },
  { t: "The email in {tool} was changed after Zavi wrote it, so Zavi did not send it. Nothing was sent. Try again to write it from the card." },
  { t: "The email in {tool} was changed after Zavi wrote it, so Zavi did not send it. Nothing was sent. This card cannot be sent again. Ask Zavi for a new draft." },
  { t: "Zavi could not read the email back from {tool} to check it, so it did not send. Nothing was sent. Try again." },
  { t: "Zavi could not read the email back from {tool} to check it, so it did not send. Nothing was sent. This card cannot be sent again. Ask Zavi for a new draft." },
  { t: "Zavi could not check {tool} to see whether this email went out: {tool} is no longer connected the way it was when this email was approved, or it did not answer. Zavi will not send this email again, so nobody gets it twice. Check it in {tool}." },
  {
    t: "This email was not sent. It is {text} in {tool}. Zavi will not send this card again. Send it from {tool}, or ask Zavi for a new one.",
    drop: "This email was not sent. Zavi will not send this card again. Send it from {tool}, or ask Zavi for a new one.",
  },
  { t: "This email was not sent. Zavi will not send this card again. Send it from {tool}, or ask Zavi for a new one." },
  {
    t: "Zavi could not confirm whether this email went out. It is {text} in {tool}. Zavi will not send this card again. Check it in {tool}, or ask Zavi for a new one.",
    drop: "Zavi could not confirm whether this email went out. Zavi will not send this card again. Check it in {tool}, or ask Zavi for a new one.",
  },
  { t: "Zavi could not confirm whether this email went out. Zavi will not send this card again. Check it in {tool}, or ask Zavi for a new one." },
  { t: "Autopilot did not send this on its own: {text}. Nothing was sent. Send it yourself if you agree.", drop: "Autopilot did not send this on its own. Nothing was sent. Send it yourself if you agree." },
  { t: "Not sent: {text} Nobody was emailed.", drop: "Not sent. Nobody was emailed." },
  { t: "Not sent: {text}, so nobody was emailed.", drop: "Not sent. Nobody was emailed." },
  { t: "Not confirmed: {text} could not be confirmed." },
  { t: "The list now has {count} people, more than the {count} Autopilot may send to. Nothing was sent. Send it yourself if it is still right." },
  {
    t: "Autopilot did not send this planned email because the list grew from {count} to {count} people since it was approved for this slot, more than 10%. Nothing was sent, and this planned send will not go out on its own. Send it yourself from the card if it should go to everyone on the list now.",
  },
  { t: "The list grew from {count} to {count} people since this was approved, more than 10%. Nothing was sent. Approve it again if it should go to everyone on the list now." },
  { t: "The list grew from {count} to {count} people since this was approved, more than 10%. Nothing was sent. This card cannot be sent again. Ask Zavi for a new draft." },
  { t: "{name} changes are switched off at the platform level right now, so Zavi did not apply this one. Nothing in the account changed. Approve it again once they are back on." },
  { t: "{name} needs the {name} plan ({price}). Nothing in the account changed." },
  { t: "{name} needs the {name} plan. Nothing in the account changed." },
];

const SLOT_SOURCE: Readonly<Record<string, string>> = {
  "{text}": "([A-Za-z0-9 ,.;:'\"‘’“”!?()&%$#+\\-–—]{1,400}?)",
  "{name}": "([\\p{L}\\p{M}\\p{N}\\p{Extended_Pictographic}‍️ ,.;:'!?()&%$#+*=~\\-–—‘’/_|@]{1,200}?)",
  "{count}": "([0-9][0-9,]{0,14})",
  "{email}": "([A-Za-z0-9._%+\\-]{1,64}@[A-Za-z0-9.\\-]{1,190}\\.[A-Za-z]{2,24})",
  "{price}": "(\\$[0-9][0-9,]{0,9}(?:\\.[0-9]{2})?/mo)",
};

const SLOT_SPLIT = /(\{tool\}|\{text\}|\{name\}|\{count\}|\{email\}|\{price\})/;

const STORED_ERROR_CHARS = 500;

type CompiledTemplate = { strict: RegExp; loose: RegExp | null; head: RegExp | null; kinds: readonly string[]; drop: string | null };

function compileTemplate(s: SendTemplate, tool: string): CompiledTemplate {
  const parts = s.t.split(SLOT_SPLIT);
  const isSlot = (p: string) => p === "{tool}" || Object.prototype.hasOwnProperty.call(SLOT_SOURCE, p);
  const build = (slot: (p: string) => string, upTo = parts.length) =>
    parts
      .slice(0, upTo)
      .map((p) => (p === "{tool}" ? `(${tool})` : isSlot(p) ? slot(p) : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("");
  const firstSlot = parts.findIndex((p) => isSlot(p) && p !== "{tool}");
  const headWords = parts.slice(0, Math.max(firstSlot, 0)).filter((p) => !isSlot(p)).join("").trim();
  return {
    strict: new RegExp(`^${build((p) => SLOT_SOURCE[p])}$`, "u"),
    loose: s.drop && firstSlot >= 0 ? new RegExp(`^${build(() => "([\\s\\S]{1,6000}?)")}$`, "u") : null,
    head: s.drop && headWords.length >= 12 ? new RegExp(`^${build(() => "", firstSlot)}`, "u") : null,
    kinds: parts.filter(isSlot),
    drop: s.drop ?? null,
  };
}

type SendWhitelist = {
  codeSentences: Readonly<Record<string, string>>;
  maps: ReadonlyArray<Readonly<Record<string, string>>>;
  sentences: ReadonlySet<string>;
  long: readonly string[];
  templates: readonly CompiledTemplate[];
  brands: ReadonlySet<string>;
};

let whitelist: SendWhitelist | null = null;

function sendWhitelist(): SendWhitelist {
  if (whitelist) return whitelist;
  const codeSentences: Readonly<Record<string, string>> = {
    not_sent_confirmed: SKIP_REASONS.not_sent_confirmed,
    tenant_disabled: "This workspace is switched off, so Zavi did not send this email. Nobody was emailed.",
    kill_switch: "The agent that wrote this email is switched off, so Zavi did not send it. Nobody was emailed.",
    email_campaign_body_invalid: EMAIL_BODY_INVALID_SENTENCE,
  };
  const maps = [codeSentences, EMAIL_CARD_MESSAGES, BULK_REFUSAL_SENTENCES];
  const sentences: ReadonlySet<string> = new Set([
    ...maps.flatMap((m) => Object.values(m)),
    ...Object.values(SKIP_REASONS),
    ...Object.values(PLAN_REFUSALS),
    ...Object.values(LIST_DOOR_WORDS),
    ...Object.values(EMAIL_TOOL_LABEL).map(keyRejectedText),
    SEND_FAILED_FALLBACK,
    TOOL_SEND_NO_ANSWER,
    ZAVI_SEND_NO_ANSWER,
    BULK_MAY_HAVE_GONE_OUT,
    EMAIL_PAUSED_ERROR,
    `${EMAIL_PAUSED_ERROR} The draft is still in the connected email tool.`,
    EMAIL_PAUSED_MID_SEND_ERROR,
    EMAIL_ALL_SUPPRESSED_ERROR,
    EMAIL_PAUSED_ONE_TO_ONE_ERROR,
    REDRAFT_REQUIRED_ERROR,
    TEST_LIST_REFUSAL,
    FANOUT_STALLED_REASON,
    `${RELEASED_EXPIRED_REASON} Ask Zavi for a new draft.`,
    `${RELEASED_PAUSED_REASON} Ask Zavi for a new draft.`,
    `${RELEASED_SENDER_STOPPED_REASON} Ask Zavi for a new draft.`,
    BULK_OUTBOUND_NOT_SENT_LINE,
    BULK_OUTBOUND_INVALID_LINE,
    BULK_OUTBOUND_INTERRUPTED_LINE,
    SENDING_ADDRESS_NOT_VERIFIED,
    "This send was interrupted before anything went out. Nothing was sent. Approve it again.",
    "Autopilot may only send from the Email campaigns channel. Nothing was sent.",
    "Zavi could not check how far this send got, so it did not start. Nothing was sent. Approve it again.",
    "Zavi could not check whether this is one of your test lists, so it did not send. Nothing was sent. Approve it again.",
    "Zavi could not schedule its follow-up check, so it did not send. Nothing was sent. Approve it again.",
    "Zavi could not verify whether email sending is paused, so it did not send. Nothing was sent. Try again.",
    "Zavi could not verify whether email sending is paused, so it did not retry. Nothing was sent. The draft is still in the connected email tool.",
    "Zavi could not record which campaign this is, so it did not send. Nothing was sent. Approve it again.",
    "Autopilot did not retry this on its own because the sender no longer matches Email campaigns settings. Nothing was sent.",
    "You stopped this channel, so Zavi did not apply this change. Nothing in the account changed.",
    "Zavi could not check whether you stopped this channel, so it did not apply this change. Nothing in the account changed. Approve it again to retry.",
    "This workspace is disabled, so Zavi did not apply this change. Nothing in the account changed.",
    "Zavi could not confirm this workspace is active, so it did not apply this change. Nothing in the account changed. Approve it again to retry.",
  ]);
  const tool = Object.values(EMAIL_TOOL_LABEL).join("|");
  whitelist = {
    codeSentences,
    maps,
    sentences,
    long: [...sentences].filter((s) => s.length > STORED_ERROR_CHARS),
    templates: SEND_SENTENCE_TEMPLATES().map((s) => compileTemplate(s, tool)),
    brands: new Set(Object.values(EMAIL_TOOL_LABEL)),
  };
  return whitelist;
}

const RAW_TOOL_TEXT = /\bHTTP\b|status code \d{3}|\b[A-Za-z]*Error:|\d{4,}|\d+\.\d+\.\d+|\bv\d+\.\d+|[^\s,;:()"'.!?]{16,}|(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{5,}/i;

function rawToolText(slot: string): boolean {
  return RAW_TOOL_TEXT.test(slot) || /\b[A-Z]{4,}\b/.test(slot);
}

function slotPasses(kind: string, slot: string | undefined): boolean {
  if (slot === undefined) return true;
  if (kind === "{text}") return !rawToolText(slot) && (slot.match(/[A-Za-z]*[a-z][A-Z][A-Za-z]*/g) ?? []).every((w) => sendWhitelist().brands.has(w));
  if (kind === "{name}") return !/:\/\/|[A-Za-z]Error\b|\/[a-z_]+\//.test(slot);
  return true;
}

function dropped(c: CompiledTemplate, m: RegExpExecArray): string {
  const at = c.kinds.indexOf("{tool}");
  const tool = at >= 0 ? m[at + 1] : undefined;
  return tool ? (c.drop ?? "").split("{tool}").join(tool) : (c.drop ?? "");
}

function founderSentence(text: string): { said: string; whole: boolean } | null {
  const w = sendWhitelist();
  if (w.sentences.has(text)) return { said: text, whole: true };
  for (const c of w.templates) {
    const m = c.strict.exec(text);
    if (m && c.kinds.every((kind, i) => slotPasses(kind, m[i + 1]))) return { said: text, whole: true };
  }
  for (const c of w.templates) {
    const m = c.loose?.exec(text);
    if (m) return { said: dropped(c, m), whole: false };
  }
  if (text.length < STORED_ERROR_CHARS - 20) return null;
  const full = w.long.find((s) => s.startsWith(text));
  if (full) return { said: full, whole: true };
  const heads = new Set(
    w.templates.flatMap((c) => {
      const m = c.head?.exec(text);
      return m ? [dropped(c, m)] : [];
    }),
  );
  return heads.size === 1 ? { said: [...heads][0], whole: false } : null;
}

function sendCodeSentence(code: string): string | null {
  const map = sendWhitelist().maps.find((m) => Object.prototype.hasOwnProperty.call(m, code));
  return map ? map[code] : null;
}

function founderSendWords(error: string | null | undefined, code?: string | null): { said: string | null; whole: boolean } {
  const { codeSentences } = sendWhitelist();
  if (code && Object.prototype.hasOwnProperty.call(codeSentences, code)) return { said: codeSentences[code], whole: true };
  const e = (error ?? "").trim();
  if (!e) return { said: null, whole: true };
  if (/^[a-z][a-z0-9_]*$/.test(e)) {
    const said = sendCodeSentence(e);
    return { said: said ?? SEND_FAILED_FALLBACK, whole: said !== null };
  }
  const plain = e.replace(/\s*\([a-z][a-z0-9_]*\)$/, "").trim();
  if (Object.prototype.hasOwnProperty.call(SEND_ERROR_TEXT_CODES, plain)) return { said: codeSentences[SEND_ERROR_TEXT_CODES[plain]], whole: true };
  const found = plain ? founderSentence(plain) : null;
  if (found?.whole) return found;
  console.warn(`[email-cards] unknown send error shown as ${found ? "its plain form" : "the plain fallback"}: ${e.slice(0, 500)}`);
  return found ?? { said: SEND_FAILED_FALLBACK, whole: false };
}

export function founderSendError(error: string | null | undefined, code?: string | null): string | null {
  return founderSendWords(error, code).said;
}

const MAY_HAVE_GONE_OUT_STATUSES: ReadonlySet<string> = new Set(["outcome_unknown", "partially_sent"]);

export function stateSendError(status: string | null | undefined, error: unknown, cls?: string | null): string | null {
  if (typeof error !== "string") return null;
  const { said, whole } = founderSendWords(error);
  if (!((!whole || said === SEND_FAILED_FALLBACK) && MAY_HAVE_GONE_OUT_STATUSES.has(status ?? ""))) return said;
  return cls === "bulk_outbound.send" ? ZAVI_SEND_NO_ANSWER : TOOL_SEND_NO_ANSWER;
}

export function holdCanResume(reason: string | null | undefined): boolean {
  return reason === "email_paused" || RESUMABLE_HOLDS.has(reason ?? "");
}

type BulkFacts = NonNullable<NonNullable<SendFacts>["bulk"]>;

function finalHold(b: BulkFacts): { status: CardSendStatus; reason: string | null; told: string } {
  if (b.sent === 0 && b.unknown > 0) return { status: "outcome_unknown", reason: BULK_MAY_HAVE_GONE_OUT, told: BULK_MAY_HAVE_GONE_OUT };
  const why = `Zavi stopped this send: ${holdSentence(b.hold_reason)}.`;
  if (b.sent === 0) return { status: "not_sent", reason: b.hold_reason, told: `${why} Nobody was emailed.` };
  const got = `${b.sent.toLocaleString("en-US")} ${b.sent === 1 ? "person" : "people"} got it`;
  if (b.hold_reason === "fanout_stalled" && b.unknown === 0) return { status: "partially_sent", reason: b.hold_reason, told: stalledSendNote(b.sent, b.total) };
  if (b.unknown > 0) {
    const told = `${why} ${got}, and ${b.unknown.toLocaleString("en-US")} more may have: the email provider did not confirm them. Zavi will not send this email again, so nobody gets it twice.`;
    return { status: "outcome_unknown", reason: told, told };
  }
  return { status: "partially_sent", reason: b.hold_reason, told: `${why} ${got}; the rest will not.` };
}

function stoppedByFounder(b: BulkFacts): { status: CardSendStatus; reason: string | null; told?: string } {
  if (b.unknown > 0) {
    const maybe = `${b.unknown.toLocaleString("en-US")} ${b.unknown === 1 ? "person" : "people"}`;
    const got = b.sent > 0 ? `${b.sent.toLocaleString("en-US")} ${b.sent === 1 ? "person" : "people"} got it, and ${b.unknown.toLocaleString("en-US")} more may have` : `${maybe} may have got it`;
    const told = `You stopped this send. ${got}: the email provider did not confirm them. Zavi will not send this email again, so nobody gets it twice.`;
    return { status: "outcome_unknown", reason: told, told };
  }
  if (b.sent === 0) return { status: "not_sent", reason: null, told: "You stopped this send before it reached anyone. Nobody was emailed." };
  return { status: "stopped", reason: null };
}

function bulkStatus(b: BulkFacts): { status: CardSendStatus; reason: string | null; told?: string } {
  if (b.status === "sending") return { status: "sending", reason: null };
  if (b.status === "waiting_for_tomorrow") return { status: "waiting_for_tomorrow", reason: null };
  if (b.status === "held" && b.hold_reason === "stopped") return stoppedByFounder(b);
  if (b.status === "held" && b.hold_reason === "email_paused") return { status: "held", reason: b.hold_reason };
  if (b.status === "held") {
    if (!holdCanResume(b.hold_reason) || b.total - b.sent - b.skipped - b.failed - b.unknown <= 0) return finalHold(b);
    return { status: "held", reason: b.hold_reason, told: `Zavi stopped this send: ${holdSentence(b.hold_reason)}. The rest will not go out unless Zavi staff resumes it.` };
  }
  if (b.status === "failed") return { status: "failed", reason: b.hold_reason };
  if (b.sent === 0 && b.unknown > 0) return { status: "outcome_unknown", reason: BULK_MAY_HAVE_GONE_OUT };
  if (b.sent === 0) return { status: "not_sent", reason: null };
  return { status: b.failed + b.unknown > 0 ? "partially_sent" : "sent", reason: null };
}

export function cardSendState(rail: EmailCardRail, s: ViewState, facts: SendFacts, now: number = Date.now()): CardSendState {
  const raw = rawCardSendState(rail, s, facts, now);
  const leftOut = facts?.bulk?.left_out ?? 0;
  const state = leftOut > 0 ? { ...raw, left_out_count: leftOut } : raw;
  if (state.status !== "sent" || facts?.bulk || s.class === "bulk_outbound.send") return state;
  const tool = (s.body as Record<string, unknown> | undefined)?.tool;
  const r = facts?.results;
  const route = typeof tool === "string" ? tool : null;
  const delivery = deliveryOf(route, r?.h1, r?.d7_published ? r?.d7 : null);
  if (!delivery) return state;
  return {
    ...state,
    delivery: delivery.state,
    sent_count: delivery.people,
    ...(delivery.skipped ? { skipped_count: delivery.skipped } : {}),
    failure_reason: deliveryReason(route, delivery) ?? state.failure_reason,
  };
}

function rawCardSendState(rail: EmailCardRail, s: ViewState, facts: SendFacts, now: number = Date.now()): CardSendState {
  const base: CardSendState = {
    status: s.status,
    retryable: s.retryable === true,
    sent_at: null,
    sent_count: null,
    failure_reason: stateSendError(s.status, s.failure_reason, s.class),
    may_have_sent: false,
    reconciliation_pending: false,
    results: null,
  };
  if (!facts) return base;
  const c = facts.card;
  const r = facts.results;
  const b = facts.bulk;
  const bounces = b ? b.hard_bounces : null;
  const tool = (s.body as Record<string, unknown> | undefined)?.tool;
  const route: ResultsRoute | null = b || s.class === "bulk_outbound.send" ? "zavi_list" : tool === "sendgrid" || tool === "mailchimp" || tool === "klaviyo" ? tool : null;
  const h1 = stageCounts(r?.h1, bounces, route);
  const d7 = r?.d7_published ? stageCounts(r?.d7, bounces, route, r.note ?? null) : undefined;
  const out: CardSendState = {
    ...base,
    sent_count: r?.sent_count ?? null,
    sent_at: r?.finished_at ?? null,
    results: d7 ?? h1 ?? (b ? { delivered: null, opens: null, clicks: null, bounces: b.hard_bounces, ...whyOf({}, route) } : null),
    ...(h1 ? { hour_1: h1 } : {}),
    ...(d7 ? { day_7: d7 } : {}),
  };
  if (rail === "channel_actions") {
    if (c.exec_status === "queued") return { ...out, status: "queued", retryable: stuck(c.approved_at, now) };
    if (c.exec_status === "dispatching") return { ...out, status: "dispatching", dispatching_since: c.claimed_at ?? null };
    if (c.exec_status === "executed") {
      const m = c.receipt?.line?.match(/Sent to ([\d,]+) /);
      return { ...out, status: "sent", sent_at: c.executed_at ?? out.sent_at, sent_count: out.sent_count ?? (m ? Number(m[1].replace(/,/g, "")) : null) };
    }
    if (c.exec_status === "failed") {
      const notSent = c.code === "not_sent_confirmed" || (c.code === "exec_partial" && c.not_sent === true);
      const mayHave = !notSent && (c.code === "exec_outcome_unknown" || c.code === "exec_partial" || c.bucket === "partial_risk");
      const got = out.sent_count ?? 0;
      const soFar = mayHave && got > 0 ? ` The email tool reports ${got.toLocaleString("en-US")} ${got === 1 ? "person" : "people"} got it so far.` : "";
      const { said, whole } = founderSendWords(c.error, c.code);
      const told = said ?? out.failure_reason;
      const why = mayHave && (told === SEND_FAILED_FALLBACK || (said !== null && !whole) || (told === null && !soFar)) ? TOOL_SEND_NO_ANSWER : told;
      return {
        ...out,
        status: notSent ? "not_sent" : "failed",
        failure_reason: why || soFar ? `${why ?? ""}${soFar}`.trim() : null,
        may_have_sent: mayHave,
        reconciliation_pending: c.code === "exec_outcome_unknown",
      };
    }
    return out;
  }
  if (c.status === "proposed" && c.approved && c.error === "bulk_sending_paused") return { ...out, status: "held", failure_reason: SENDER_STOPPED_NOT_SENT, retryable: true };
  if (c.status === "proposed" && c.approved) return { ...out, status: "queued", retryable: stuck(c.dispatched_at ?? c.approved_at, now) };
  if (c.status === "approved") return { ...out, status: "approved", retryable: stuck(c.approved_at, now) };
  if (c.status === "dispatch_failed" && c.error !== "not_sent_confirmed" && c.error?.endsWith(OUTCOME_UNKNOWN_SUFFIX)) {
    const { said, whole } = founderSendWords(c.error.slice(0, -OUTCOME_UNKNOWN_SUFFIX.length));
    const why = said === SEND_FAILED_FALLBACK || !whole ? null : said;
    return { ...out, status: "outcome_unknown", failure_reason: why || TOOL_SEND_NO_ANSWER, may_have_sent: true, reconciliation_pending: false, retryable: false };
  }
  if (c.status === "dispatch_failed" && c.error !== "not_sent_confirmed" && b && b.sent === 0 && b.unknown > 0) {
    return { ...out, status: "outcome_unknown", failure_reason: BULK_MAY_HAVE_GONE_OUT, may_have_sent: true, reconciliation_pending: false, retryable: false, sent_count: 0, sent_at: b.finished_at ?? out.sent_at };
  }
  if (c.status === "dispatch_failed") {
    return { ...out, status: c.error === "not_sent_confirmed" ? "not_sent" : "failed", failure_reason: founderSendError(c.error), retryable: false };
  }
  if (!b && c.status === "dispatching" && c.error?.endsWith(OUTCOME_UNKNOWN_SUFFIX)) {
    const { said, whole } = founderSendWords(c.error.slice(0, -OUTCOME_UNKNOWN_SUFFIX.length));
    const why = said === SEND_FAILED_FALLBACK || !whole ? null : said;
    return { ...out, status: "outcome_unknown", failure_reason: why || TOOL_SEND_NO_ANSWER, may_have_sent: true, reconciliation_pending: !sinceOver(c.dispatched_at, 2 * EMAIL_TOOL_SEND_BOUND_MS, now), retryable: false };
  }
  if (b && (c.status === "dispatching" || c.status === "acted")) {
    const m = bulkStatus(b);
    return {
      ...out,
      status: m.status,
      failure_reason: m.told ?? (m.status === "outcome_unknown" ? m.reason : m.reason ? holdReasonSentence(m.reason) : out.failure_reason),
      ...(m.status === "outcome_unknown" ? { may_have_sent: true } : {}),
      sent_count: b.sent,
      sent_at: b.finished_at ?? out.sent_at,
    };
  }
  if (c.status === "dispatching" && sinceOver(c.dispatched_at, EMAIL_TOOL_SEND_BOUND_MS, now)) {
    return { ...out, status: "outcome_unknown", failure_reason: s.class === "bulk_outbound.send" ? ZAVI_SEND_NO_ANSWER : TOOL_SEND_NO_ANSWER, may_have_sent: true, reconciliation_pending: false, retryable: false, dispatching_since: c.dispatched_at ?? null };
  }
  if (c.status === "dispatching") return { ...out, status: "dispatching", dispatching_since: c.dispatched_at ?? null };
  if (c.status === "acted") return { ...out, status: "sent", sent_at: out.sent_at ?? c.dispatched_at ?? null };
  return out;
}

function holdReasonSentence(reason: string): string {
  const s = holdSentence(reason);
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

const SETTLED_BULK: ReadonlySet<string> = new Set(["done", "held", "failed"]);

export const SENT_SO_FAR_WAIT_MS = 1_000;

async function boundedSentSoFar(read: () => Promise<number | null>): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SENT_SO_FAR_WAIT_MS);
  });
  try {
    return await Promise.race([read().catch((): null => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function cardSendFacts(tenantId: string, rail: EmailCardRail, id: string, deps: Partial<CardDeps> = {}): Promise<SendFacts> {
  const d = { ...LIVE, ...deps };
  const read = await d.rpc<SendFacts>(tenantId, "email_card_send_facts", { p_rail: rail, p_id: id });
  const leftOut = read?.bulk && rail === "decisions" && SETTLED_BULK.has(read.bulk.status) ? await d.leftOut(tenantId, id).catch((): null => null) : null;
  const sentSoFar = read?.bulk?.status === "sending" ? await boundedSentSoFar(() => d.sentSoFar(tenantId, id)) : null;
  const facts = read?.bulk ? { ...read, bulk: { ...read.bulk, sent: Math.max(read.bulk.sent, sentSoFar ?? 0), left_out: leftOut } } : read;
  const r = facts?.results;
  if (!r?.d7_published || !Array.isArray(r.d7?.from_h1)) return facts;
  const note = await d.resultNote(tenantId, rail, id).catch((): null => null);
  return { ...facts, results: { ...r, note } } as SendFacts;
}

export type CardOutcome = {
  status: string;
  sent: number | null;
  total: number | null;
  unknown: number | null;
  may_have_sent: boolean;
  reason: string | null;
  pause_hold: PauseHold;
};

export function cardOutcome(state: CardSendState, facts: SendFacts, pauseHold: PauseHold = null): CardOutcome {
  const b = facts?.bulk ?? null;
  return {
    status: state.status,
    sent: state.sent_count,
    total: b ? b.total : null,
    unknown: b ? b.unknown : null,
    may_have_sent: state.may_have_sent,
    reason: state.failure_reason,
    pause_hold: pauseHold,
  };
}

export async function liveCardSend(
  tenantId: string,
  rail: EmailCardRail,
  id: string,
  s: ViewState,
  deps: Partial<CardDeps> = {},
): Promise<{ facts: SendFacts; send: CardSendState; pause_hold: PauseHold; outcome: CardOutcome }> {
  const d = { ...LIVE, ...deps };
  const facts = await cardSendFacts(tenantId, rail, id, deps).catch((): null => null);
  const state = cardSendState(rail, s, facts);
  const send = state.status === "held" && facts?.card.error === "bulk_sending_paused"
    ? { ...state, failure_reason: heldSenderReason(await d.senderStop().catch((): null => null)) }
    : state;
  const paused = await d.paused(tenantId).catch((): null => null);
  const pause_hold = pauseHoldOf(rail, send.status, facts, paused);
  return { facts, send, pause_hold, outcome: cardOutcome(send, facts, pause_hold) };
}

export const LIVE_CARD_DEPS: Readonly<Pick<CardDeps, "paused" | "senderStop">> = { paused: LIVE.paused, senderStop: LIVE.senderStop };

export async function readCardOutcome(tenantId: string, rail: EmailCardRail, id: string, userId: string, deps: Partial<CardDeps> = {}): Promise<CardOutcome | null> {
  const s = await emailCardViewState(tenantId, rail, id, userId, deps);
  if (!s.ok) return null;
  return (await liveCardSend(tenantId, rail, id, s, deps)).outcome;
}

export async function stopEmailCardSend(
  tenantId: string,
  rail: EmailCardRail,
  id: string,
  userId: string,
  deps: Partial<CardDeps> = {},
): Promise<{ ok: true; stopped: number; already_sent: number } | Refusal> {
  const d = { ...LIVE, ...deps };
  const view = await d.rpc<ViewState | Refusal>(tenantId, "email_card_view_state", { p_rail: rail, p_id: id, p_user_id: userId });
  if (!view.ok) return view;
  if (rail !== "decisions" || view.class !== "bulk_outbound.send") return { ok: false, code: "not_stoppable" };
  const out = await d.rpc<{ ok: boolean; code?: string; stopped?: number; already_sent?: number; send_id?: string; was?: string; was_reason?: string | null }>(tenantId, "email_bulk_stop_send", {
    p_actor_user_id: userId,
    p_decision_id: id,
  });
  if (!out.ok) return { ok: false, code: out.code ?? "not_stoppable" };
  if (out.send_id && out.was === "waiting_for_tomorrow") {
    await d.wakeFanout(out.send_id).catch(() => console.warn(`[email-cards] stopped send ${out.send_id} not woken; it is told at its next run`));
  } else if (out.send_id && out.was === "held" && HOLDS_TOLD_AT_THE_END.has(out.was_reason ?? "")) {
    await d.tellStopped(tenantId, out.send_id, id).catch(() => console.warn(`[email-cards] stopped send ${out.send_id} not told`));
  }
  return { ok: true, stopped: Number(out.stopped ?? 0), already_sent: Number(out.already_sent ?? 0) };
}
