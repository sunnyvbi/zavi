import { createHash } from "node:crypto";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { BLOCKER_NOTE_KEY, cleanTitle, parseNoteItems, type NoteItem } from "./cgo-note-items";
import { META_OBJECT_UNREACHABLE, decisionFailureFix, execVerdictOf, fixWords, type ExecFix } from "@/services/channels/exec-failure";
import { execPlatformLabel } from "@/services/channels/exec-kill-switch";
import { moneyAtStakeUsd } from "@/services/channels/money-at-stake";
import { MONEY_AT_STAKE_KEY } from "@/services/channels/money-at-stake-card";
import { GOOGLE_ACCOUNT_BLOCKED_MARKER, META_ACCOUNT_BLOCKED_MARKER, META_NOT_READY_MARKER, readAccountMarker } from "./ad-account-watch";
import { STUCK_AFTER_MS } from "./stuck-ad-changes";
import { adDirection } from "./unattended-policy";

export type BlockerKind = "question" | "card" | "check" | "connector" | "account" | "plan" | "spend_data" | "budget_stop" | "budget_brake" | "stuck" | "ad_delivery";
export type BlockerWho = "you" | "zavi";
export type BlockerSeverity = "urgent" | "normal";
export type BlockerState = "new" | "changed" | "reopened" | "unchanged";

export type Blocker = {
  id: string;
  kind: BlockerKind;
  what: string;
  who: BlockerWho;
  since: string;
  usd_at_stake: number | null;
  at_risk_now: boolean;
  notify_now?: boolean;
  meanwhile: string;
  action_id?: string;
  channel_slug?: string;
  question_ordinal?: number;
};

export const URGENT_KEY = "urgent";
export const MONEY_CHANGE_SHARE = 0.25;
export const MONEY_CHANGE_MIN_USD = 50;
export const TOLD_MEMORY_DAYS = 30;
export const LEFT_CARD_DAYS = 14;
export const STOPPED_BUDGET_DAYS = 30;
export const SPEND_STALE_MS = 3 * 3_600_000;
export const CLOSED_CUT_MS = 24 * 3_600_000;
export const FAILED_DECISION_FIX_MS = 7 * 86_400_000;
const FAILED_DECISION_FIX_PAGE = 50;
const FAILED_DECISION_FIX_PAGES = 10;
export const CUT_CLASSES = [
  "meta_ads.set_status",
  "meta_ads.set_status_review",
  "meta_ads.update_ad_set_budget",
  "meta_ads.update_ad_set_budget_review",
  "google_ads.set_status",
  "google_ads.set_status_review",
  "google_ads.update_campaign_budget",
  "google_ads.update_campaign_budget_review",
  "google_ads.remove_resource",
];
const DAY = 86_400_000;

type Platform = "meta_ads" | "google_ads";
const PLATFORM_LABEL: Record<Platform, string> = { meta_ads: "Meta Ads", google_ads: "Google Ads" };
const AT_RISK_FIXES = new Set<string>(["billing", "reconnect", "permission"]);
const ACCOUNT_FIXES = new Set<string>(["page_grant", "page", "permission", "billing"]);

export function cardPlatform(execClass: string | null | undefined): Platform | null {
  const m = /^(meta_ads|google_ads)\./.exec(execClass ?? "");
  return m ? (m[1] as Platform) : null;
}

export function cardBlockerId(a: { bucket: string | null; fix: string | null; exec_class: string | null; chain_root_id: string; platform_code?: string | null }): string {
  const platform = cardPlatform(a.exec_class);
  if (a.bucket === "partial_risk") return `check:${a.chain_root_id}`;
  if (a.bucket === "needs_founder" && a.platform_code === META_OBJECT_UNREACHABLE) return `card:${a.chain_root_id}`;
  if (a.bucket === "needs_founder") {
    if (a.fix === "credits" || a.fix === "plan") return `plan:${a.fix}`;
    if (platform && a.fix === "reconnect") return `connector:${platform}`;
    if (platform && a.fix && ACCOUNT_FIXES.has(a.fix)) return `account:${platform}`;
  }
  return `card:${a.chain_root_id}`;
}

type FailedDecisionRow = { id: string; status?: string | null; decision_class: string; body?: unknown; dispatched_at: string | null; dispatch_error: string | null };

export function failedDecisionFixesOf(
  rows: readonly FailedDecisionRow[],
  connectedAt: ReadonlyMap<string, string | null>,
): NonNullable<BlockerSources["failedDecisionFixes"]> {
  const out: NonNullable<BlockerSources["failedDecisionFixes"]> = [];
  for (const r of rows) {
    const platform = cardPlatform(r.decision_class);
    if (!platform || !r.dispatched_at) continue;
    const f = decisionFailureFix({ status: r.status ?? "dispatch_failed", decision_class: r.decision_class, dispatch_error: r.dispatch_error });
    if (!f) continue;
    const reconnected = connectedAt.get(platform);
    if (reconnected && Date.parse(reconnected) > Date.parse(r.dispatched_at)) continue;
    out.push({ id: r.id, decision_class: r.decision_class, since: r.dispatched_at, fix: f.fix, platform_code: f.platform_code, cut: reducesAdSpend(r.decision_class, r.body) });
  }
  return out;
}

export function cardAtRiskNow(bucket: string | null, fix: string | null, platformCode?: string | null): boolean {
  if (platformCode === META_OBJECT_UNREACHABLE) return false;
  return bucket === "partial_risk" || (bucket === "needs_founder" && AT_RISK_FIXES.has(fix ?? ""));
}

export function blockerSeverity(b: { at_risk_now: boolean; notify_now?: boolean }): BlockerSeverity {
  return b.at_risk_now || b.notify_now ? "urgent" : "normal";
}

export function reducesAdSpend(execClass: string, payload: unknown): boolean {
  const base = execClass.replace(/_review$/, "");
  return base === "google_ads.remove_resource" || adDirection(base, payload) === "down";
}

function cutWord(execClass: string): string {
  if (/set_status/.test(execClass)) return "pause";
  if (/budget/.test(execClass)) return "budget cut";
  return "removal";
}

export type Told = { severity: BlockerSeverity; usd: number | null; at: string };

export function toldMemory(notes: ReadonlyArray<{ items: unknown; created_at: string }>): Map<string, Told> {
  const out = new Map<string, Told>();
  for (const n of [...notes].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    for (const i of parseNoteItems(n.items) ?? []) {
      if (!i.blocker_id) continue;
      const told: Told = { severity: i.blocker_severity ?? "normal", usd: i.usd_at_stake ?? null, at: n.created_at };
      out.set(i.blocker_id, told);
      const group = LINKEDIN_STUCK_GROUP.exec(i.blocker_id);
      for (const member of group ? group[2].split(",") : []) out.set(`${group![1]}:${member}`, told);
    }
  }
  return out;
}

const LINKEDIN_STUCK_GROUP = /^(stuck:linkedin_(?:stop|launch)):(.+)$/;

export function toldAbout(id: string, told: ReadonlyMap<string, Told>): Told | undefined {
  const group = LINKEDIN_STUCK_GROUP.exec(id);
  if (!group) return told.get(id);
  const members = group[2].split(",").map((member) => told.get(`${group[1]}:${member}`));
  if (members.some((t) => !t)) return undefined;
  return (members as Told[]).reduce((a, b) => (b.at > a.at ? b : a));
}

export function blockerChange(id: string, now: { severity: BlockerSeverity; usd: number | null; since?: string | null }, told: Told | undefined): BlockerState {
  if (!told) return "new";
  const toldAt = Date.parse(told.at);
  const nowSince = now.since ? Date.parse(now.since) : NaN;
  if (!/^(budget_brake|meta-no-live-ad|ad_read_slow|ad_disconnected):/.test(id) && Number.isFinite(toldAt) && Number.isFinite(nowSince) && nowSince > toldAt) return "reopened";
  if (now.severity === "urgent" && told.severity !== "urgent") return "changed";
  if (!/^(card|check|budget_brake):/.test(id)) return "unchanged";
  const was = told.usd ?? 0;
  const is = now.usd ?? 0;
  if (Math.abs(is - was) >= Math.max(MONEY_CHANGE_SHARE * was, MONEY_CHANGE_MIN_USD)) return "changed";
  return "unchanged";
}

export function markReviewBlockers(
  items: readonly NoteItem[],
  cards: ReadonlyMap<string, { exec_class: string | null; exec_status: string | null; exec_result: unknown; exec_payload?: unknown }>,
  told: ReadonlyMap<string, Told>,
  alreadyShown: ReadonlySet<string> = new Set(),
): NoteItem[] {
  const out: NoteItem[] = [];
  for (const i of items) {
    if (i.section !== "needs_you" || i.question_ordinal != null || i.locations || !i.action_id) {
      out.push(i);
      continue;
    }
    const c = cards.get(i.action_id);
    const v = c ? execVerdictOf(c.exec_status, c.exec_result) : null;
    const id = cardBlockerId({ bucket: v?.bucket ?? null, fix: v?.fix ?? null, exec_class: c?.exec_class ?? null, chain_root_id: i.chain_root_id ?? i.action_id, platform_code: v?.platform_code });
    const cut = !!v && !!c?.exec_class && reducesAdSpend(c.exec_class, c.exec_payload);
    const severity = blockerSeverity({ at_risk_now: cardAtRiskNow(v?.bucket ?? null, v?.fix ?? null, v?.platform_code) || cut });
    const state = blockerChange(id, { severity, usd: i.usd_at_stake ?? null, since: i.waiting_since ?? null }, told.get(id));
    if (state === "unchanged" || (state === "new" && alreadyShown.has(i.action_id))) continue;
    out.push({ ...i, blocker_id: id, blocker_severity: severity });
  }
  return out;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function usdWords(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function waitingWords(since: string, now: Date): string | null {
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now.getTime() - t) / DAY);
  return days <= 0 ? null : `Waiting ${days} day${days === 1 ? "" : "s"}`;
}

export function blockerItem(b: Blocker, severity: BlockerSeverity, state: BlockerState, now: Date): NoteItem {
  const parts = [
    state === "changed" ? "This has changed since I last told you" : state === "reopened" ? "This came back" : null,
    capitalize(b.meanwhile.replace(/[.\s]+$/, "")),
    b.usd_at_stake != null ? `${usdWords(b.usd_at_stake)} a month at stake` : b.at_risk_now ? "Money is at risk until this is fixed" : null,
    waitingWords(b.since, now),
  ].filter((p): p is string => !!p);
  return {
    section: b.who === "zavi" ? "blocked" : "needs_you",
    text: b.what,
    reason: parts.join(". "),
    blocker_id: b.id,
    blocker_severity: severity,
    waiting_since: b.since,
    ...(b.usd_at_stake != null ? { usd_at_stake: b.usd_at_stake } : {}),
    ...(b.action_id ? { action_id: b.action_id } : {}),
    ...(b.channel_slug ? { channel_slug: b.channel_slug } : {}),
    ...(b.question_ordinal != null ? { question_ordinal: b.question_ordinal } : {}),
  };
}

export type FailedCard = {
  id: string;
  channel_slug: string;
  title: string | null;
  exec_class: string | null;
  exec_payload: unknown;
  exec_result: unknown;
  stake: unknown;
  proposed_at: string;
  failed_at: string | null;
  closed?: boolean;
};

export type LeftCard = {
  id: string;
  channel_slug: string;
  title: string | null;
  exec_class: string | null;
  exec_payload: unknown;
  stake: unknown;
  proposed_at: string;
  usd_hint: number | null;
};

export type BlockerSources = {
  questions: Array<{ topic_key: string; ask: string; asked_at: string; default_line: string | null; ordinal: number | null }>;
  failedCards: FailedCard[];
  leftCards: LeftCard[];
  chainRoots: ReadonlyMap<string, string>;
  connectors: Array<{ slug: string; token_expires_at: string | null; connected_at?: string | null }>;
  metaNotReady: { since: string; reason: string | null } | null;
  metaAccountBlocked: { since: string; reason: string | null } | null;
  googleAccountBlocked?: { since: string; reason: string | null } | null;
  runningAds: boolean;
  spendStaleSince: string | null;
  stoppedBudgets: Array<{ budget_id: string; still_running: number; platforms: string[]; since: string }>;
  adReadFailed?: Array<{ budget_id: string; platform: string; since: string; kind?: string | null }>;
  stuck: Array<{ id: string; title: string | null; exec_class: string | null; exec_payload?: unknown; since: string }>;
  uncertainDecisions?: Array<{ id: string; decision_class: string; since: string }>;
  failedDecisionCuts?: Array<{ id: string; decision_class: string; since: string }>;
  failedDecisionFixes?: Array<{ id: string; decision_class: string; since: string; fix: ExecFix | null; platform_code: string | null;  cut?: boolean }>;
};

function moneyOf(execClass: string | null, payload: unknown, stake: unknown): number | null {
  const m = moneyAtStakeUsd(execClass, payload, { [MONEY_AT_STAKE_KEY]: stake });
  return m ? Math.round(m.monthly_usd) : null;
}

function accountWords(platform: Platform, reason: string | null): { what: string; at_risk_now: boolean; meanwhile: string } {
  const label = PLATFORM_LABEL[platform];
  switch (reason) {
    case "page_grant":
    case "page_permission_missing":
      return { what: `Reconnect ${label} and allow access to your Facebook Page`, at_risk_now: false, meanwhile: "your running ads keep going; new Meta ads wait" };
    case "page":
    case "no_page":
      return { what: "Add a Facebook Page to your Meta ad account in Meta Business Settings", at_risk_now: false, meanwhile: "your running ads keep going; new Meta ads wait" };
    case "permission":
    case "account_not_writable":
      return { what: `Give Zavi's connection access to your ${label} account again`, at_risk_now: true, meanwhile: `I can't change anything on ${label}` };
    default:
      return { what: `Check your ${label} account status and billing${reason && reason !== "billing" ? ` (${label} says: ${reason.replace(/_/g, " ")})` : ""}`, at_risk_now: true, meanwhile: `ads on ${label} may have stopped, and I can't change them` };
  }
}

export function stuckBlocker(c: { id: string; title: string | null; exec_class: string | null; exec_payload?: unknown; since: string }): Blocker {
  const cut = !!c.exec_class && reducesAdSpend(c.exec_class, c.exec_payload);
  const title = cleanTitle(c.title ?? "an ad change");
  return {
    id: `stuck:${c.id}`,
    kind: "stuck",
    who: "zavi",
    what: cut ? `A ${cutWord(c.exec_class!)} did not finish, so the ads keep spending: ${title}. Pause them in ${execPlatformLabel(c.exec_class!)} if they must stop now` : `A change did not finish: ${title}`,
    since: c.since,
    usd_at_stake: null,
    at_risk_now: cut,
    meanwhile: "we've been alerted and are on it",
    action_id: c.id,
  };
}

export function goneRecheckGaveUpBlocker(c: { bindingId: string; since: string }): Blocker {
  return {
    id: `stuck:linkedin_gone_recheck:${c.bindingId}`,
    kind: "stuck",
    who: "you",
    what: "LinkedIn stopped showing one of your campaigns, and Zavi could not reach LinkedIn for 7 days to confirm it is gone, so it may still be spending. Check the campaign in LinkedIn Campaign Manager and pause it if it must stop",
    since: c.since,
    usd_at_stake: null,
    at_risk_now: true,
    meanwhile: "Zavi has stopped re-reading this campaign, so this needs a look from you",
  };
}

export function stuckLinkedinOperationBlocker(c: { op: "stop" | "launch"; ids: readonly string[]; since: string; wallet?: boolean }): Blocker {
  const n = c.ids.length;
  const what = c.wallet
    ? n > 1
      ? c.op === "stop"
        ? `${n} LinkedIn Ads campaign pauses did not finish, so those campaigns may keep spending your Zavi ads balance. They run in Zavi's own LinkedIn account, so there is nothing to change in LinkedIn; Zavi keeps pausing them`
        : `${n} LinkedIn Ads campaign launches did not finish and Zavi could not confirm they are stopped, so they may be spending your Zavi ads balance. They run in Zavi's own LinkedIn account, so there is nothing to change in LinkedIn; Zavi keeps checking and pausing them`
      : c.op === "stop"
        ? "A pause of your LinkedIn Ads campaign did not finish, so it may keep spending your Zavi ads balance. It runs in Zavi's own LinkedIn account, so there is nothing to change in LinkedIn; Zavi keeps pausing it"
        : "A LinkedIn Ads campaign launch did not finish and Zavi could not confirm it is stopped, so it may be spending your Zavi ads balance. It runs in Zavi's own LinkedIn account, so there is nothing to change in LinkedIn; Zavi keeps checking and pausing it"
    : n > 1
      ? c.op === "stop"
        ? `${n} LinkedIn Ads campaign pauses did not finish, so those campaigns may keep spending. Pause them in LinkedIn Campaign Manager if they must stop now`
        : `${n} LinkedIn Ads campaign launches did not finish and Zavi could not confirm they are stopped, so they may be spending. Pause them in LinkedIn Campaign Manager if they must stop now`
      : c.op === "stop"
        ? "A pause of your LinkedIn Ads campaign did not finish, so it may keep spending. Pause the campaign in LinkedIn Campaign Manager if it must stop now"
        : "A LinkedIn Ads campaign launch did not finish and Zavi could not confirm it is stopped, so it may be spending. Pause the campaign in LinkedIn Campaign Manager if it must stop now";
  return {
    id: `stuck:linkedin_${c.op}${c.wallet ? "_wallet" : ""}:${[...c.ids].sort().join(",")}`,
    kind: "stuck",
    who: "zavi",
    what,
    since: c.since,
    usd_at_stake: null,
    at_risk_now: true,
    meanwhile: "Zavi keeps retrying every few minutes",
  };
}

export function retriesExhaustedBlocker(d: { id: string; what: string; since: string }): Blocker {
  return {
    id: `retries_exhausted:${d.id}`,
    kind: "card",
    who: "you",
    what: d.what,
    since: d.since,
    usd_at_stake: null,
    at_risk_now: false,
    notify_now: true,
    meanwhile: "nothing was created or spent",
  };
}

export function uncertainDecisionBlocker(d: { id: string; decision_class: string; since: string }): Blocker {
  const label = execPlatformLabel(d.decision_class);
  return {
    id: `check:decision:${d.id}`,
    kind: "check",
    who: "you",
    what: `Check ${label}: a change Zavi sent may or may not have gone through`,
    since: d.since,
    usd_at_stake: null,
    at_risk_now: true,
    meanwhile: "I won't send it again until you check",
  };
}

const AD_PLATFORM_NAME: Record<string, string> = {
  meta: "Meta Ads", google: "Google Ads", chatgpt: "ChatGPT Ads", reddit: "Reddit Ads", x: "X Ads",
  tiktok: "TikTok Ads", pinterest: "Pinterest Ads", snapchat: "Snapchat Ads",
  microsoft: "Microsoft Ads", apple: "Apple Ads", spotify: "Spotify Ads", linkedin: "LinkedIn Ads",
};
function adPlatformName(p: string): string {
  return AD_PLATFORM_NAME[p] ?? p;
}

const AD_READ_SLOW_MS = 3 * 3_600_000;

export function adReadFailedBlocker(b: { budget_id: string; platform: string; name: string; day: string; since: string; kind?: "auth" | "account_gone"; reason?: string | null }): Blocker {
  return {
    id: `ad_read_failed:${b.budget_id}:${b.platform}:${b.day.slice(0, 7)}`,
    kind: "connector",
    who: "you",
    what: b.kind === "account_gone"
      ? `Reconnect ${b.name} with a login that can see all your ad accounts: an ad account that spent this month or runs a campaign is no longer in Zavi's connection`
      : `Reconnect ${b.name}: ${b.reason?.trim() || `${b.name} connection stopped working`}`,
    since: b.since,
    usd_at_stake: null,
    at_risk_now: true,
    meanwhile: `budget raises on ${b.name} wait; your other ad accounts keep working`,
  };
}

export function adReadSlowBlocker(b: { budget_id: string; platform: string; name: string; day: string; since: string }): Blocker {
  return {
    id: `ad_read_slow:${b.budget_id}:${b.platform}:${b.day.slice(0, 7)}`,
    kind: "spend_data",
    who: "you",
    what: `${b.name} hasn't answered for 3 hours. I'll keep trying`,
    since: b.since,
    usd_at_stake: null,
    at_risk_now: false,
    notify_now: true,
    meanwhile: `budget raises on ${b.name} wait`,
  };
}

export function adDisconnectedBlocker(b: { budget_id: string; platform: string; name: string; day: string; since: string; usd: number }): Blocker {
  return {
    id: `ad_disconnected:${b.budget_id}:${b.platform}:${b.day.slice(0, 7)}`,
    kind: "spend_data",
    who: "you",
    what: `${b.name} was disconnected. Zavi last saw ${usdWords(b.usd)} spent on it this month, and that still counts toward your cap`,
    since: b.since,
    usd_at_stake: null,
    at_risk_now: false,
    notify_now: true,
    meanwhile: `campaigns still live on your own ${b.name} account keep spending, and Zavi can no longer see or count that spend. Connect ${b.name} again from Connectors, or pause those campaigns in ${b.name}`,
  };
}

export function overspendBlocker(b: { budget_id: string; day: string; projected_usd: number; cap_usd: number }): Blocker {
  const over = Math.max(0, b.projected_usd - b.cap_usd);
  return {
    id: `budget_brake:${b.budget_id}:${b.day.slice(0, 7)}`,
    kind: "budget_brake",
    who: "you",
    what: `Your ads are on track to spend ${usdWords(b.projected_usd)} this month, ${usdWords(over)} over your ${usdWords(b.cap_usd)} cap`,
    since: `${b.day}T00:00:00.000Z`,
    usd_at_stake: Math.round(over),
    at_risk_now: true,
    meanwhile: OVERSPEND_INSTRUCTION,
  };
}

export const OVERSPEND_INSTRUCTION =
  "Zavi doesn't lower budgets on its own when the month runs over. To stop it, lower daily budgets in your ad accounts or raise the cap on your Ad budget page";

export function deriveBlockers(s: BlockerSources, now: Date): Blocker[] {
  const out = new Map<string, Blocker>();
  const put = (b: Blocker) => {
    const had = out.get(b.id);
    if (!had) {
      out.set(b.id, b);
      return;
    }
    const usd = had.usd_at_stake == null && b.usd_at_stake == null ? null : (had.usd_at_stake ?? 0) + (b.usd_at_stake ?? 0);
    const lead = b.at_risk_now && !had.at_risk_now ? b : had;
    out.set(b.id, {
      ...lead,
      since: had.since < b.since ? had.since : b.since,
      usd_at_stake: usd,
      at_risk_now: had.at_risk_now || b.at_risk_now,
      ...(had.action_id && b.action_id && had.action_id !== b.action_id ? { action_id: undefined } : {}),
    });
  };

  if (s.metaAccountBlocked) {
    put({ id: "account:meta_ads", kind: "account", who: "you", since: s.metaAccountBlocked.since, usd_at_stake: null, ...accountWords("meta_ads", s.metaAccountBlocked.reason) });
  }
  if (s.googleAccountBlocked) {
    put({ id: "account:google_ads", kind: "account", who: "you", since: s.googleAccountBlocked.since, usd_at_stake: null, ...accountWords("google_ads", s.googleAccountBlocked.reason) });
  }
  if (s.metaNotReady) {
    if (s.metaNotReady.reason === "connector_missing") {
      put({ id: "connector:meta_ads", kind: "connector", who: "you", what: "Connect Meta Ads", since: s.metaNotReady.since, usd_at_stake: null, at_risk_now: false, meanwhile: "new Meta ads wait" });
    } else {
      put({ id: "account:meta_ads", kind: "account", who: "you", since: s.metaNotReady.since, usd_at_stake: null, ...accountWords("meta_ads", s.metaNotReady.reason) });
    }
  }
  const brokenConnectors = new Set<string>();
  for (const c of s.connectors) {
    const at = c.token_expires_at ? Date.parse(c.token_expires_at) : NaN;
    if (!(c.slug in PLATFORM_LABEL) || !Number.isFinite(at) || at > now.getTime()) continue;
    const label = PLATFORM_LABEL[c.slug as Platform];
    brokenConnectors.add(c.slug);
    put({
      id: `connector:${c.slug}`,
      kind: "connector",
      who: "you",
      what: `Reconnect ${label}`,
      since: c.token_expires_at!,
      usd_at_stake: null,
      at_risk_now: s.runningAds,
      meanwhile: `I can't read or change ${label}; your other channels keep running`,
    });
  }

  for (const c of s.failedCards) {
    const v = execVerdictOf("failed", c.exec_result);
    const cut = !!c.exec_class && reducesAdSpend(c.exec_class, c.exec_payload);
    if (!v || (v.bucket !== "needs_founder" && v.bucket !== "partial_risk" && !cut)) continue;
    if (c.closed && !(cut && v.bucket === "blocked_on_us")) continue;
    const root = s.chainRoots.get(c.id) ?? c.id;
    const id = cardBlockerId({ bucket: v.bucket, fix: v.fix, exec_class: c.exec_class, chain_root_id: root, platform_code: v.platform_code });
    const platform = c.exec_class ? execPlatformLabel(c.exec_class) : c.channel_slug;
    const since = c.failed_at ?? c.proposed_at;
    const usd = moneyOf(c.exec_class, c.exec_payload, c.stake);
    const at_risk_now = cardAtRiskNow(v.bucket, v.fix, v.platform_code) || cut;
    const link = { action_id: c.id, channel_slug: c.channel_slug };
    if (id.startsWith("check:")) {
      put({ id, kind: "check", who: "you", what: `Check ${platform}: "${cleanTitle(c.title ?? "a change")}" may already be partly live`, since, usd_at_stake: usd, at_risk_now, meanwhile: "I won't run it again until you check", ...link });
    } else if (id.startsWith("plan:")) {
      put({ id, kind: "plan", who: "you", what: capitalize(fixWords(v.fix as ExecFix, platform) ?? "Top up your Zavi credits"), since, usd_at_stake: usd, at_risk_now, meanwhile: "these changes wait", ...link });
    } else if (id.startsWith("connector:")) {
      put({ id, kind: "connector", who: "you", what: capitalize(fixWords("reconnect", platform)!), since, usd_at_stake: usd, at_risk_now: at_risk_now || s.runningAds, meanwhile: `changes on ${platform} wait; your other channels keep running`, ...link });
    } else if (id.startsWith("account:")) {
      const p = cardPlatform(c.exec_class) ?? "meta_ads";
      put({ id, kind: "account", who: "you", since, usd_at_stake: usd, ...accountWords(p, v.fix), at_risk_now: at_risk_now || accountWords(p, v.fix).at_risk_now, ...link });
    } else if (v.bucket === "needs_founder" && v.platform_code === META_OBJECT_UNREACHABLE) {
      put({ id, kind: "card", who: "you", what: `"${cleanTitle(c.title ?? "A change")}" did not go through: ${fixWords(v.fix, platform, v.platform_code)}`, since, usd_at_stake: usd, at_risk_now, meanwhile: cut ? "the ads keep spending until it goes through" : "it waits for you; nothing on it changes", ...link });
    } else if (cut && c.closed) {
      const title = cleanTitle(c.title ?? `A ${cutWord(c.exec_class!)}`);
      put({ id, kind: "card", who: "zavi", what: `"${title}" did not go through and the ads keep spending: pause them in ${platform} if they must stop now`, since, usd_at_stake: usd, at_risk_now, meanwhile: "Zavi's team has been alerted and is on it", ...link });
    } else if (cut) {
      const title = cleanTitle(c.title ?? `A ${cutWord(c.exec_class!)}`);
      put({ id, kind: "card", who: "you", what: `"${title}" did not go through: press Try again, or do it in ${platform} yourself`, since, usd_at_stake: usd, at_risk_now, meanwhile: "the ads keep spending until it goes through", ...link });
    } else {
      put({ id, kind: "card", who: "you", what: cleanTitle(c.title ?? "A change"), since, usd_at_stake: usd, at_risk_now, meanwhile: "it waits for you; nothing on it changes", ...link });
    }
  }

  for (const c of s.leftCards) {
    const root = s.chainRoots.get(c.id) ?? c.id;
    put({
      id: `card:${root}`,
      kind: "card",
      who: "you",
      what: cleanTitle(c.title ?? "A change"),
      since: c.proposed_at,
      usd_at_stake: c.usd_hint ?? moneyOf(c.exec_class, c.exec_payload, c.stake),
      at_risk_now: false,
      meanwhile: "it waits for you; nothing on it changes",
      action_id: c.id,
      channel_slug: c.channel_slug,
    });
  }

  for (const q of s.questions) {
    put({
      id: `question:${q.topic_key}`,
      kind: "question",
      who: "you",
      what: q.ask,
      since: q.asked_at,
      usd_at_stake: null,
      at_risk_now: false,
      meanwhile: q.default_line?.trim() || "nothing changes until you answer",
      ...(q.ordinal != null ? { question_ordinal: q.ordinal } : {}),
    });
  }

  if (s.runningAds && s.spendStaleSince && brokenConnectors.size === 0) {
    put({
      id: "spend_data",
      kind: "spend_data",
      who: "zavi",
      what: "Zavi can't read your ad spend right now",
      since: s.spendStaleSince,
      usd_at_stake: null,
      at_risk_now: false,
      meanwhile: "I make no cuts or pauses until the numbers are back; we're on it",
    });
  }

  for (const b of s.stoppedBudgets) {
    if (b.still_running <= 0) continue;
    const where = b.platforms.map((p) => (p === "meta" ? "Meta Ads" : p === "google" ? "Google Ads" : p)).join(" and ") || "your ad accounts";
    put({
      id: `budget_stop:${b.budget_id}`,
      kind: "budget_stop",
      who: "you",
      what: `Pause ${b.still_running} ad${b.still_running === 1 ? "" : "s"} in ${where} yourself: Zavi's pause did not go through`,
      since: b.since,
      usd_at_stake: null,
      at_risk_now: true,
      meanwhile: "they keep spending until they are paused",
    });
  }

  for (const d of s.uncertainDecisions ?? []) put(uncertainDecisionBlocker(d));
  for (const r of s.adReadFailed ?? []) {
    const base = { budget_id: r.budget_id, platform: r.platform, name: adPlatformName(r.platform), day: now.toISOString().slice(0, 10), since: r.since };
    if (r.kind === "auth" || r.kind === "account_gone") put(adReadFailedBlocker({ ...base, kind: r.kind }));
    else if (r.kind === "disconnected") continue;
    else if (now.getTime() - Date.parse(r.since) >= AD_READ_SLOW_MS) put(adReadSlowBlocker(base));
  }

  const unreachableIds = new Set<string>();
  for (const d of s.failedDecisionFixes ?? []) {
    const label = execPlatformLabel(d.decision_class);
    const id = cardBlockerId({ bucket: "needs_founder", fix: d.fix, exec_class: d.decision_class, chain_root_id: `decision:${d.id}`, platform_code: d.platform_code });
    const cut = d.cut === true;
    const at_risk_now = cardAtRiskNow("needs_founder", d.fix, d.platform_code) || cut;
    const base = { id, who: "you" as const, since: d.since, usd_at_stake: null };
    if (id.startsWith("plan:")) continue;
    if (id.startsWith("connector:")) {
      put({ ...base, kind: "connector", what: capitalize(fixWords("reconnect", label)!), at_risk_now: at_risk_now || s.runningAds, meanwhile: `changes on ${label} wait; your other channels keep running` });
    } else if (id.startsWith("account:")) {
      const p = cardPlatform(d.decision_class) ?? "meta_ads";
      const words = accountWords(p, d.fix);
      put({ ...base, kind: "account", ...words, at_risk_now: at_risk_now || words.at_risk_now });
    } else {
      const words = fixWords(d.fix, label, d.platform_code);
      if (!words) continue;
      const unreachable = d.platform_code === META_OBJECT_UNREACHABLE;
      if (unreachable) unreachableIds.add(d.id);
      const what = unreachable
        ? `A ${cut ? cutWord(d.decision_class) : "change"} Zavi sent to ${label} did not go through: ${words}. If it still exists, ${cut ? `do it in ${label} yourself` : "make the change again"}`
        : `A change Zavi sent to ${label} did not go through: ${words}, then make the change again`;
      const meanwhile = cut ? "if it still exists, its ads keep spending until it is done" : "nothing changed on it; it does not run again by itself";
      put({ ...base, kind: "card", what, at_risk_now, meanwhile });
    }
  }

  for (const d of s.failedDecisionCuts ?? []) {
    if (unreachableIds.has(d.id)) continue;
    const label = execPlatformLabel(d.decision_class);
    put({
      id: `card:decision:${d.id}`,
      kind: "card",
      who: "you",
      what: `A ${cutWord(d.decision_class)} Zavi sent to ${label} did not go through: do it in ${label} yourself`,
      since: d.since,
      usd_at_stake: null,
      at_risk_now: true,
      meanwhile: "the ads keep spending until it is done",
    });
  }

  for (const c of s.stuck) put(stuckBlocker(c));

  return [...out.values()];
}

export type RankedBlocker = { b: Blocker; severity: BlockerSeverity; state: BlockerState };

export function rankBlockers(blockers: readonly Blocker[], told: ReadonlyMap<string, Told>): RankedBlocker[] {
  const rank = (x: RankedBlocker) => (x.severity === "urgent" ? 0 : 1) * 2 + (x.b.who === "zavi" ? 1 : 0);
  return blockers
    .map((b) => {
      const severity = blockerSeverity(b);
      return { b, severity, state: blockerChange(b.id, { severity, usd: b.usd_at_stake, since: b.since }, toldAbout(b.id, told)) };
    })
    .sort((x, y) => rank(x) - rank(y) || (y.b.usd_at_stake ?? 0) - (x.b.usd_at_stake ?? 0) || x.b.since.localeCompare(y.b.since));
}

export function urgentToAlert(ranked: readonly RankedBlocker[]): RankedBlocker[] {
  return ranked.filter((x) => x.severity === "urgent" && x.state !== "unchanged");
}

export const RECONNECT_ALERT_EVERY_MS = 24 * 3_600_000;
const RECONNECT = /^(ad_read_failed|connector):/;

export function holdRepeatReconnects(alerts: readonly RankedBlocker[], told: ReadonlyMap<string, Told>, now: Date): RankedBlocker[] {
  const since = now.getTime() - RECONNECT_ALERT_EVERY_MS;
  const recent = [...told].some(([id, t]) => RECONNECT.test(id) && Date.parse(t.at) > since);
  return recent ? alerts.filter((x) => !RECONNECT.test(x.b.id)) : [...alerts];
}

export function alertHeadline(alerts: readonly RankedBlocker[]): string {
  const first = alerts[0].b.what.replace(/^(.*?[.!?])\s+[A-Z].*$/s, "$1").replace(/[.\s]+$/, "");
  const lead = `Needs you now: ${first}`;
  const more = alerts.length - 1;
  const text = more ? `${lead} (and ${more} more)` : lead;
  return text.length > 140 ? `${text.slice(0, 138).replace(/\s+\S*$/, "")}…` : text;
}

type Row = Record<string, unknown>;

async function readLeftHints(tenant_id: string): Promise<Map<string, number | null>> {
  const hints = new Map<string, number | null>();
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("cgo_notes")
      .select("items")
      .eq("tenant_id", tenant_id)
      .not("items", "is", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + 99);
    if (error) throw new Error(`cgo-blockers: notes read failed: ${error.message}`);
    for (const n of (data ?? []) as Array<{ items: unknown }>) {
      for (const i of parseNoteItems(n.items) ?? []) {
        if (i.section === "needs_you" && i.action_id && !hints.has(i.action_id)) hints.set(i.action_id, i.usd_at_stake ?? null);
      }
    }
    if ((data ?? []).length < 100) return hints;
  }
}

export async function loadBlockerSources(tenant_id: string, now: Date, opts?: { lite?: boolean }): Promise<BlockerSources> {
  const db = tenantClient(asTenantId(tenant_id));
  const [questions, failed, closedFailed, leftHints, connectors, budgets] = await Promise.all([
    db.from("cgo_questions").select("topic_key, ask, asked_at, default_line, ordinal").eq("tenant_id", tenant_id).eq("status", "open").limit(20),
    db
      .from("channel_actions")
      .select("id, channel_slug, title, exec_class, exec_payload, exec_result, stake:body->money_at_stake, proposed_at, status_at")
      .eq("tenant_id", tenant_id)
      .eq("status", "pending")
      .eq("exec_status", "failed")
      .limit(100),
    db
      .from("channel_actions")
      .select("id, channel_slug, title, exec_class, exec_payload, exec_result, stake:body->money_at_stake, proposed_at, status_at")
      .eq("tenant_id", tenant_id)
      .eq("status", "stale")
      .eq("exec_status", "failed")
      .in("exec_class", CUT_CLASSES)
      .gte("status_at", new Date(now.getTime() - CLOSED_CUT_MS).toISOString())
      .limit(50),
    opts?.lite ? Promise.resolve(new Map<string, number | null>()) : readLeftHints(tenant_id),
    db.from("connector_metadata").select("slug, token_expires_at, connected_at").eq("tenant_id", tenant_id).in("slug", ["meta_ads", "google_ads"]),
    db.from("ad_budgets").select("id, status, actual_read_at, stopped_at, read_failed, read_failure_kinds").eq("tenant_id", tenant_id).in("status", ["active", "stopped"]).limit(20),
  ]);
  for (const [name, r] of Object.entries({ questions, failed, closedFailed, connectors, budgets })) {
    const err = (r as { error: { message: string } | null }).error;
    if (err) throw new Error(`cgo-blockers: ${name} read failed: ${err.message}`);
  }

  const failedRows = (failed.data ?? []) as Row[];
  const failedIds = new Set(failedRows.map((r) => String(r.id)));
  const leftIds = [...leftHints.keys()].filter((id) => !failedIds.has(id));
  const leftRows: Row[] = [];
  for (let offset = 0; offset < leftIds.length; offset += 50) {
    const left = await db
      .from("channel_actions")
      .select("id, channel_slug, title, exec_class, exec_payload, exec_status, stake:body->money_at_stake, proposed_at")
      .eq("tenant_id", tenant_id)
      .eq("status", "pending")
      .in("id", leftIds.slice(offset, offset + 50));
    if (left.error) throw new Error(`cgo-blockers: left cards read failed: ${left.error.message}`);
    leftRows.push(...((left.data ?? []) as Row[]).filter((r) => r.exec_status !== "failed"));
  }

  const { readChainRoots } = await import("./goal-owner");
  const closedRows = (closedFailed.data ?? []) as Row[];
  const chainRoots = await readChainRoots(tenant_id, [...failedIds, ...closedRows.map((r) => String(r.id)), ...leftRows.map((r) => String(r.id))]);

  const marker = (bucket: string) => readAccountMarker(tenant_id, bucket).catch(() => null);
  const [notReady, blocked, googleBlocked] = await Promise.all([marker(META_NOT_READY_MARKER), marker(META_ACCOUNT_BLOCKED_MARKER), marker(GOOGLE_ACCOUNT_BLOCKED_MARKER)]);

  const budgetRows = (budgets.data ?? []) as Array<{ id: string; status: string; actual_read_at: string | null; stopped_at: string | null; read_failed?: Record<string, string> | null; read_failure_kinds?: Record<string, string> | null }>;
  const failedReads = budgetRows
    .filter((b) => b.status === "active")
    .flatMap((b) =>
      Object.entries(b.read_failed ?? {})
        .filter(([, since]) => typeof since === "string" && !!since)
        .map(([platform, since]) => ({ budget_id: b.id, platform, since, kind: b.read_failure_kinds?.[platform] ?? null })),
    );
  const isLogin = (k: string | null) => k === "auth" || k === "account_gone";
  const logins = failedReads.some((r) => isLogin(r.kind));
  const { loginFailureFixed, readConnectedAt } = await import("@/services/connectors/ad-read-failures");
  const { platformConnectorSlugs } = await import("@/services/connectors/platform-slugs");
  const connectedAt = logins ? await readConnectedAt(tenant_id).catch(() => new Map<string, string>()) : new Map<string, string>();
  const adReadFailed = failedReads
    .filter((r) => !(isLogin(r.kind) && loginFailureFixed(r.since, platformConnectorSlugs(r.platform).map((sl) => connectedAt.get(sl)), now.getTime())));
  const { cgoAdBudget } = await import("./cgo-ads");
  const runningAds = (await cgoAdBudget(tenant_id, now)) !== null;
  const active = budgetRows.find((b) => b.status === "active");
  const readAt = active?.actual_read_at ? Date.parse(active.actual_read_at) : NaN;
  const spendStaleSince = runningAds && Number.isFinite(readAt) && now.getTime() - readAt > SPEND_STALE_MS ? active!.actual_read_at : null;

  const stoppedSince = new Date(now.getTime() - STOPPED_BUDGET_DAYS * DAY).toISOString();
  const stopped = budgetRows.filter((b) => b.status === "stopped" && (b.stopped_at ?? "") >= stoppedSince);
  const stoppedBudgets: BlockerSources["stoppedBudgets"] = [];
  if (stopped.length) {
    const holds = await db
      .from("ad_budget_reservations")
      .select("budget_id, platform, object_id")
      .eq("tenant_id", tenant_id)
      .in("budget_id", stopped.map((b) => b.id))
      .in("status", ["reserved", "committed"])
      .limit(200);
    if (holds.error) throw new Error(`cgo-blockers: holds read failed: ${holds.error.message}`);
    for (const b of stopped) {
      const mine = ((holds.data ?? []) as Array<{ budget_id: string; platform: string; object_id: string | null }>).filter((h) => h.budget_id === b.id);
      const objects = new Set(mine.map((h) => `${h.platform}:${h.object_id ?? ""}`));
      if (objects.size && b.stopped_at) stoppedBudgets.push({ budget_id: b.id, still_running: objects.size, platforms: [...new Set(mine.map((h) => h.platform))].sort(), since: b.stopped_at });
    }
  }

  const uncertain = await db
    .from("decisions")
    .select("id, decision_class, dispatched_at, dispatch_error")
    .eq("tenant_id", tenant_id)
    .eq("status", "dispatching")
    .gte("dispatched_at", new Date(now.getTime() - LEFT_CARD_DAYS * DAY).toISOString())
    .limit(20);
  if (uncertain.error) throw new Error(`cgo-blockers: dispatching decisions read failed: ${uncertain.error.message}`);
  const uncertainDecisions = ((uncertain.data ?? []) as Array<{ id: string; decision_class: string; dispatched_at: string; dispatch_error?: string | null }>)
    .filter((r) => !String(r.dispatch_error ?? "").startsWith("founder_checked"))
    .filter((r) => !!cardPlatform(r.decision_class) && now.getTime() - Date.parse(r.dispatched_at) > STUCK_AFTER_MS)
    .map((r) => ({ id: r.id, decision_class: r.decision_class, since: r.dispatched_at }));

  const cutWindow = new Date(now.getTime() - CLOSED_CUT_MS).toISOString();
  const [machineCutRead, founderCutRead] = await Promise.all([
    db
      .from("decisions")
      .select("id, decision_class, body, dispatched_at")
      .eq("tenant_id", tenant_id)
      .eq("status", "dispatch_failed")
      .in("decision_class", CUT_CLASSES)
      .gte("dispatched_at", cutWindow)
      .limit(20),
    db
      .from("decisions")
      .select("id, decision_class, body, dispatched_at")
      .eq("tenant_id", tenant_id)
      .eq("status", "dispatching")
      .eq("dispatch_error", "founder_checked_not_applied")
      .in("decision_class", CUT_CLASSES)
      .gte("dispatched_at", cutWindow)
      .limit(20),
  ]);
  if (machineCutRead.error) throw new Error(`cgo-blockers: failed decisions read failed: ${machineCutRead.error.message}`);
  if (founderCutRead.error) throw new Error(`cgo-blockers: founder-checked decisions read failed: ${founderCutRead.error.message}`);
  const failedDecisionCuts = [
    ...((machineCutRead.data ?? []) as Array<{ id: string; decision_class: string; body: unknown; dispatched_at: string }>),
    ...((founderCutRead.data ?? []) as Array<{ id: string; decision_class: string; body: unknown; dispatched_at: string }>),
  ]
    .filter((r) => reducesAdSpend(r.decision_class, r.body))
    .map((r) => ({ id: r.id, decision_class: r.decision_class, since: r.dispatched_at }));

  const fixRows: FailedDecisionRow[] = [];
  const since = new Date(now.getTime() - FAILED_DECISION_FIX_MS).toISOString();
  await Promise.all(
    (["meta_ads", "google_ads"] as const).map(async (p) => {
      let after: { at: string; id: string } | null = null;
      for (let page = 0; page < FAILED_DECISION_FIX_PAGES; page++) {
        let q = db
          .from("decisions")
          .select("id, status, decision_class, body, dispatched_at, dispatch_error")
          .eq("tenant_id", tenant_id)
          .eq("status", "dispatch_failed")
          .like("decision_class", `${p}.%`)
          .gte("dispatched_at", since);
        if (after) q = q.or(`dispatched_at.lt."${after.at}",and(dispatched_at.eq."${after.at}",id.lt.${after.id})`);
        const r = await q.order("dispatched_at", { ascending: false }).order("id", { ascending: false }).limit(FAILED_DECISION_FIX_PAGE);
        if (r.error) throw new Error(`cgo-blockers: failed decisions (founder fix) read failed: ${r.error.message}`);
        const rows = (r.data ?? []) as FailedDecisionRow[];
        fixRows.push(...rows);
        const last = rows[rows.length - 1];
        if (rows.length < FAILED_DECISION_FIX_PAGE || !last?.dispatched_at) return;
        after = { at: last.dispatched_at, id: last.id };
      }
      console.warn(`[cgo-blockers] ${tenant_id}: ${FAILED_DECISION_FIX_PAGES * FAILED_DECISION_FIX_PAGE} or more failed ${p} decisions in ${FAILED_DECISION_FIX_MS / 86_400_000} days; older ones not read`);
    }),
  );
  const reconnectedAt = new Map(((connectors.data ?? []) as BlockerSources["connectors"]).map((c) => [c.slug, c.connected_at ?? null]));
  const failedDecisionFixes = failedDecisionFixesOf(fixRows, reconnectedAt);

  const inflight = await db
    .from("channel_actions")
    .select("id, title, exec_class, exec_payload, exec_status, exec_claimed_at")
    .eq("tenant_id", tenant_id)
    .in("exec_status", ["queued", "dispatching"])
    .limit(50);
  if (inflight.error) throw new Error(`cgo-blockers: in-flight read failed: ${inflight.error.message}`);
  const stuck = ((inflight.data ?? []) as Array<{ id: string; title: string | null; exec_class: string | null; exec_payload: unknown; exec_status: string; exec_claimed_at: string | null }>)
    .filter((c) => !!cardPlatform(c.exec_class) && c.exec_status === "dispatching" && !!c.exec_claimed_at && now.getTime() - Date.parse(c.exec_claimed_at) > STUCK_AFTER_MS)
    .map((c) => ({ id: c.id, title: c.title, exec_class: c.exec_class, exec_payload: c.exec_payload, since: c.exec_claimed_at! }));

  return {
    questions: ((questions.data ?? []) as BlockerSources["questions"]).map((q) => ({ ...q, ordinal: typeof q.ordinal === "number" ? q.ordinal : null })),
    failedCards: [...failedRows.map((r) => ({ r, closed: false })), ...closedRows.map((r) => ({ r, closed: true }))].map(({ r, closed }) => ({
      id: String(r.id),
      channel_slug: String(r.channel_slug),
      title: (r.title as string | null) ?? null,
      exec_class: (r.exec_class as string | null) ?? null,
      exec_payload: r.exec_payload,
      exec_result: r.exec_result,
      stake: r.stake,
      proposed_at: String(r.proposed_at),
      failed_at: (r.status_at as string | null) ?? null,
      ...(closed ? { closed: true } : {}),
    })),
    leftCards: leftRows.map((r) => ({
      id: String(r.id),
      channel_slug: String(r.channel_slug),
      title: (r.title as string | null) ?? null,
      exec_class: (r.exec_class as string | null) ?? null,
      exec_payload: r.exec_payload,
      stake: r.stake,
      proposed_at: String(r.proposed_at),
      usd_hint: leftHints.get(String(r.id)) ?? null,
    })),
    chainRoots,
    connectors: (connectors.data ?? []) as BlockerSources["connectors"],
    metaNotReady: notReady,
    metaAccountBlocked: blocked,
    googleAccountBlocked: googleBlocked,
    runningAds,
    spendStaleSince,
    stoppedBudgets,
    stuck,
    uncertainDecisions,
    failedDecisionFixes,
    adReadFailed,
    failedDecisionCuts,
  };
}

export async function readToldNotes(tenant_id: string, now: Date, includePending = false): Promise<Array<{ items: unknown; created_at: string; alarm_keys: string[] }>> {
  const query = tenantClient(asTenantId(tenant_id))
    .from("cgo_notes")
    .select("items, created_at, alarm_keys, notified, notification_key")
    .eq("tenant_id", tenant_id)
    .not("items", "is", null);
  const { data, error } = await (includePending ? query.or("notified.eq.true,notification_key.not.is.null") : query.eq("notified", true))
    .gte("created_at", new Date(now.getTime() - TOLD_MEMORY_DAYS * DAY).toISOString())
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`cgo-blockers: told notes read failed: ${error.message}`);
  return ((data ?? []) as Array<{ items: unknown; created_at: string; alarm_keys: string[] | null; notified: boolean | null; notification_key?: string | null }>)
    .filter((n) => n.notified === true || (includePending && n.notification_key != null))
    .map((n) => ({ items: n.items, created_at: n.created_at, alarm_keys: n.alarm_keys ?? [] }));
}

export type BlockerDeps = {
  now: () => Date;
  flush: (tenant_id: string) => Promise<unknown>;
  sources: (tenant_id: string, now: Date) => Promise<BlockerSources>;
  told: (tenant_id: string, now: Date) => Promise<Array<{ items: unknown; created_at: string; alarm_keys: string[] }>>;
  writeNote: (tenant_id: string, note: { headline: string; items: NoteItem[]; keys: string[]; notification_key: string }, now: Date) => Promise<string | null>;
  send: (tenant_id: string, note_id: string) => Promise<void>;
};

export function incidentKey(x: RankedBlocker, told: ReadonlyMap<string, Told>): string {
  if (/^(ad_read_slow|ad_disconnected):/.test(x.b.id)) {
    return `blocker:${createHash("sha256").update(JSON.stringify([x.b.id, x.severity])).digest("hex")}`;
  }
  const state = [x.b.id, x.severity, x.b.since, toldAbout(x.b.id, told)?.at ?? null];
  return `blocker:${createHash("sha256").update(JSON.stringify(state)).digest("hex")}`;
}

async function writeBlockerNote(tenant_id: string, note: { headline: string; items: NoteItem[]; keys: string[]; notification_key: string }, now: Date): Promise<string | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data: last } = await db
    .from("cgo_notes")
    .select("next_review_at")
    .eq("tenant_id", tenant_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ next_review_at: string }>();
  const { data, error } = await db
    .from("cgo_notes")
    .insert({
      tenant_id,
      run_id: null,
      kind: "alarm",
      items: note.items,
      headline: note.headline.slice(0, 200),
      alarm_keys: [BLOCKER_NOTE_KEY, ...note.keys],
      notified: false,
      notification_key: note.notification_key,
      next_review_at: last?.next_review_at ?? new Date(now.getTime() + 7 * DAY).toISOString(),
    })
    .select("id")
    .maybeSingle<{ id: string }>();
  if (error?.code === "23505") return null;
  if (error) throw new Error(`cgo-blockers: note write failed: ${error.message}`);
  return data?.id ?? null;
}

async function sendBlockerNote(tenant_id: string, note_id: string): Promise<void> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("cgo_notes").select("id, run_id, notification_key, notified, queued_at").eq("tenant_id", tenant_id).eq("id", note_id).maybeSingle<{ id: string; run_id: string | null; notification_key: string | null; notified: boolean | null; queued_at: string | null }>();
  if (error) throw new Error(`cgo-blockers: notification read failed: ${error.message}`);
  if (!data) throw new Error("cgo-blockers: notification note missing");
  await (await import("./cgo-note-notifications")).queueCgoNote(tenant_id, data);
}

export const defaultBlockerDeps: BlockerDeps = {
  now: () => new Date(),
  flush: async (tenant_id) => (await import("./cgo-note-notifications")).flushPendingCgoNotes(tenant_id),
  sources: loadBlockerSources,
  told: (tenant_id, now) => readToldNotes(tenant_id, now, true),
  writeNote: writeBlockerNote,
  send: sendBlockerNote,
};

export async function alertUrgentBlockers(tenant_id: string, deps: Partial<BlockerDeps> = {}, extra: readonly Blocker[] = []): Promise<{ sent: number; why?: string; urgent_ids: string[] }> {
  const d = { ...defaultBlockerDeps, ...deps };
  const now = d.now();
  await d.flush(tenant_id).catch((e) => console.warn(`[cgo-blockers] pending notifications for ${tenant_id}: ${(e as Error).message}`));
  const [sources, toldNotes] = await Promise.all([d.sources(tenant_id, now), d.told(tenant_id, now)]);
  const told = toldMemory(toldNotes);
  const derived = deriveBlockers(sources, now);
  const seen = new Set(derived.map((b) => b.id));
  const words = new Map(extra.map((b) => [b.id, b.what]));
  const merged = derived.map((b) => (words.has(b.id) ? { ...b, what: words.get(b.id)! } : b));
  const ranked = rankBlockers([...merged, ...extra.filter((b) => !seen.has(b.id))], told);
  const alerts = holdRepeatReconnects(urgentToAlert(ranked), told, now);
  const urgent_ids = ranked.filter((x) => x.severity === "urgent").map((x) => x.b.id);
  if (!alerts.length) return { sent: 0, why: "nothing_new", urgent_ids };
  let sent = 0;
  for (const x of alerts) {
    const note_id = await d.writeNote(tenant_id, { headline: alertHeadline([x]), items: [blockerItem(x.b, x.severity, x.state, now)], keys: [URGENT_KEY], notification_key: incidentKey(x, told) }, now);
    if (!note_id) continue;
    await d.send(tenant_id, note_id);
    sent++;
  }
  return sent ? { sent, urgent_ids } : { sent: 0, why: "already_claimed", urgent_ids };
}

export async function alertFounderSafely(tenant_id: string, why: string, extra: readonly Blocker[] = []): Promise<{ sent: number; urgent_ids: string[] } | null> {
  try {
    return await alertUrgentBlockers(tenant_id, {}, extra);
  } catch (e) {
    console.warn(`[cgo-blockers] founder alert (${why}) for ${tenant_id} not sent: ${(e as Error).message}`);
    return null;
  }
}

