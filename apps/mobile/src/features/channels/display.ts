import { cardCopy } from "./cardCopy";
import { CHANNELS, EMAIL_SEND_EXEC, PHONE_APPROVE_EXEC, getChannel, socialLimit } from "@zavi/shared";
import { CHANNEL_ORDER } from "./channelList";
import type {
  ApprovalsResponse,
  CardKind,
  ChannelAction,
  ChannelDecision,
  ChannelListItem,
  ChannelRowState,
  TenantChannelView,
} from "./types";

export const CHANNEL_WEB_URL = "https://www.zaviagent.com/workspace?tab=channels";

const RECIPE_STEP_CLASS = "channel.recipe_step";
const SOCIAL_PUBLISH_CLASS = "social.publish.v2";

export const CHANNEL_DISPLAY_ORDER = CHANNEL_ORDER;

const NAME_OVERRIDE: Record<string, string> = {};

const ACTION_LABELS: Record<string, string> = {
  x_organic: "Write a post",
  meta_ads: "Draft an ad",
  google_ads: "Review ad copy",
  seo: "Review recommendations",
  youtube_ads: "Draft a video brief",
  tiktok_ads: "Draft a video hook",
  linkedin_ads: "Draft an ad",
  reddit_ads: "Draft an ad",
  geo: "Review citation gaps",
  ugc: "Draft a video brief",
  generated_video: "Write hook-test scripts",
  linkedin_organic: "Write a post",
};

const DEFAULT_ACTION_LABEL = "Have Zavi work on this";
const X_CHAR_LIMIT = 280;
const DEFAULT_CHAR_LIMIT = 2000;

const STATE_TIER: Record<string, number> = { needs_review: 1, running: 2 };

export function channelName(slug: string): string {
  return NAME_OVERRIDE[slug] ?? getChannel(slug)?.name ?? slug;
}

export function channelAgentSlug(channel: string): string {
  return getChannel(channel)?.executor ?? channel;
}

export function agentChannel(slug: string): string | undefined {
  return CHANNELS.find((c) => c.executor === slug)?.slug;
}

export function pendingCountsFrom(
  approvals: ApprovalsResponse | undefined,
): Record<string, number> {
  if (!approvals) return {};
  if (approvals.channel_pending_counts) return approvals.channel_pending_counts;
  const counts: Record<string, number> = {};
  for (const d of approvals.decisions ?? []) {
    if (d.channel_slug) counts[d.channel_slug] = (counts[d.channel_slug] ?? 0) + 1;
  }
  return counts;
}

export type SeenCounts = Record<string, number>;

export function unseenCountsFrom(
  approvals: ApprovalsResponse | undefined,
  seen: SeenCounts,
): Record<string, number> {
  const unseen: Record<string, number> = {};
  for (const [slug, count] of Object.entries(pendingCountsFrom(approvals))) {
    unseen[slug] = Math.max(0, count - (seen[slug] ?? 0));
  }
  return unseen;
}

export function readyCountFrom(approvals: ApprovalsResponse | undefined, seen: SeenCounts = {}): number {
  const counts = unseenCountsFrom(approvals, seen);
  return CHANNEL_DISPLAY_ORDER.reduce((sum, slug) => sum + (counts[slug] ?? 0), 0);
}

function rowState(view: TenantChannelView | undefined, pendingCount: number): ChannelRowState {
  if (view?.locked) return "idle";
  if (view?.work_state === "running") return "working";
  if (pendingCount > 0) return "ready";
  if (view?.work_state === "delivered") return "completed";
  return "idle";
}

export function buildChannelList(
  channels: readonly TenantChannelView[] | undefined,
  approvals: ApprovalsResponse | undefined,
  seen: SeenCounts = {},
): ChannelListItem[] {
  const viewBySlug = new Map((channels ?? []).map((c) => [c.channel_slug, c]));
  const counts = unseenCountsFrom(approvals, seen);

  const rows = CHANNEL_DISPLAY_ORDER.flatMap((slug, index) => {
    const channel = getChannel(slug);
    if (!channel) return [];
    const view = viewBySlug.get(slug);
    const pendingCount = counts[slug] ?? 0;
    const connected = view?.connected ?? false;
    const connectors = view?.connectors ?? [...channel.connectors];
    const item: ChannelListItem = {
      slug,
      name: channelName(slug),
      description: channel.description,
      state: rowState(view, pendingCount),
      pendingCount,
      locked: view?.locked ?? false,
      runnable: view?.runnable ?? true,
      connected,
      needsConnect: channels !== undefined && connectors.length > 0 && !connected,
      actionLabel: ACTION_LABELS[slug] ?? DEFAULT_ACTION_LABEL,
    };
    const tier = pendingCount > 0 ? 0 : STATE_TIER[view?.work_state ?? ""] ?? 3;
    return [{ item, index, tier }];
  });

  return rows
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        b.item.pendingCount - a.item.pendingCount ||
        a.index - b.index,
    )
    .map((r) => r.item);
}

function nonBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const CARD_KINDS: readonly CardKind[] = [
  "executes",
  "post",
  "plan",
  "message",
  "ad_manual",
  "copy_to_site",
  "task",
];

function cardWords(decision: ChannelDecision) {
  const kind = CARD_KINDS.find((k) => k === decision.card_kind) ?? null;
  const primaryLabel = nonBlank(decision.primary_label);
  const doneLabel = nonBlank(decision.done_label);
  const known = kind !== null && primaryLabel !== null && doneLabel !== null;
  return {
    cardKind: known ? kind : null,
    primaryLabel: known ? primaryLabel : null,
    doneLabel: known ? doneLabel : null,
    howTo: Array.isArray(decision.how_to)
      ? decision.how_to.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [],
    stepsDone: Array.isArray(decision.steps_done)
      ? decision.steps_done.filter((n): n is number => Number.isInteger(n))
      : [],
  };
}

function receiptOf(v: ChannelDecision["exec_receipt"]): ChannelAction["execReceipt"] {
  const line = nonBlank(v?.line);
  return line ? { line, url: httpsLink(v?.url) } : null;
}

function moneyOf(v: ChannelDecision["approve_money"]): ChannelAction["approveMoney"] {
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (ok(o.daily_usd) && ok(o.monthly_usd)) return { daily_usd: o.daily_usd, monthly_usd: o.monthly_usd };
  return ok(o.total_usd) ? { total_usd: o.total_usd } : null;
}

function changeRowsOf(v: unknown): ChannelAction["changeRows"] {
  const rows = (asRecord(v) as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const o = asRecord(r);
    const cell = (x: unknown) => (typeof x === "string" ? x : typeof x === "number" && Number.isFinite(x) ? String(x) : null);
    const item = cell(o.item), before = cell(o.before), after = cell(o.after);
    return item !== null && before !== null && after !== null ? [{ item, before, after }] : [];
  });
}

function httpsLink(v: unknown): string | null {
  return typeof v === "string" && /^https:\/\/[^\s/]+(\/\S*)?$/i.test(v.trim()) ? v.trim() : null;
}

function weeksSince(iso: string | null | undefined, now = Date.now()): number | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return null;
  return Math.max(1, Math.floor((now - t) / (7 * 86_400_000)));
}

export function toChannelAction(decision: ChannelDecision): ChannelAction | null {
  const slug = decision.channel_slug;
  if (!slug) return null;

  const body = asRecord(decision.body);
  const step = asRecord(body.step);
  const deliverable = asRecord(step.deliverable);
  const payload = asRecord(body.payload);
  const name = channelName(slug);

  const kind: ChannelAction["kind"] =
    decision.decision_class === SOCIAL_PUBLISH_CLASS
      ? "social"
      : decision.decision_class === RECIPE_STEP_CLASS
        ? "recipe"
        : "other";

  const stepTitle = nonBlank(step.title);
  const stepBody = nonBlank(step.body);
  const content = nonBlank(deliverable.content);
  const actionLabel = nonBlank(body.action_label);
  const ownTitle = stepTitle ?? nonBlank(deliverable.label) ?? nonBlank(decision.title) ?? actionLabel;
  const title = ownTitle ?? name;
  const text = content ?? stepBody ?? nonBlank(payload.text) ?? "";
  if (!text && !ownTitle) return null;

  const fallbackLimit = slug === "x_organic" ? X_CHAR_LIMIT : DEFAULT_CHAR_LIMIT;
  const socialChannel = nonBlank(body.channel);
  const charLimit =
    kind === "social" && socialChannel
      ? socialLimit(socialChannel)?.text ?? fallbackLimit
      : fallbackLimit;

  return {
    id: decision.id,
    status: decision.status,
    action_source: decision.action_source ?? "decision",
    slug,
    channelName: name,
    kind,
    title,
    text,
    why: content && stepBody ? stepBody : null,
    charLimit,
    canPost: kind === "social",
    canRewrite: kind === "recipe",
    canEdit: kind === "social",
    deliverableLabel: nonBlank(deliverable.label),
    link: httpsLink(body.link),
    executable: typeof decision.exec_class === "string" && decision.exec_class.length > 0,
    blocking: decision.blocking === true,
    rewritten: !!decision.redo_of,
    weeksOld: weeksSince(decision.from_signup_preview_at),
    intent: nonBlank(body.intent) ?? nonBlank(step.intent),
    execStatus: nonBlank(decision.exec_status),
    execFixText: nonBlank(decision.exec_fix_text),
    execReceipt: receiptOf(decision.exec_receipt),
    approveOnPhone: decision.approve_on_phone === true || PHONE_APPROVE_EXEC.has(decision.exec_class ?? ""),
    approveNeedsAdmin: typeof decision.approve_needs_admin === "boolean" ? decision.approve_needs_admin : null,
    approveMoney: moneyOf(decision.approve_money),
    changeRows: changeRowsOf(body.exact_change),
    emailCard: decision.email_card === true || decision.exec_class === EMAIL_SEND_EXEC,
    copy: cardCopy(body),
    ...cardWords(decision),
  };
}
