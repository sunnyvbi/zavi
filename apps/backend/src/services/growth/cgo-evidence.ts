
import { sliceWhole } from "@/services/json-safe";
import { safeExecReceipt } from "@/services/channels/exec-receipt";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { dateInZone, shiftDate } from "./account-zone";
import type { AdObjectFacts } from "./unattended-policy";
import { REASK_AFTER_DAYS } from "./cgo-questions";
import type { OutcomeSection, SearchSection, TrafficSection } from "./cgo-data-pack";
import { adCardTitle, filterInstagramSnapshots, type InstagramAccountSnapshot } from "@zavi/shared";

const DAY = 86_400_000;

export const PAID_LABELS = {
  learning: "too early to judge (learning)",
  awareness: "not set up to optimise for conversions, so judged on its own objective",
  conversion: "judged on cost per conversion",
  trackingBroken: "tracking broken, don't trust conversions",
  trackingUnknown: "tracking not verified, don't judge on conversions",
  purposeUnknown: "could not tell what it is for, don't judge it",
  brand: "brand search, protect it: don't cut it or judge it on conversions",
  brandUnknown: "could not check if it is your brand search, don't cut it",
  notGoal: "its conversions are not your goal, don't cut or scale on them",
  goalUnknown: "could not check if its conversions are your goal, don't cut on them",
} as const;
export type PaidLabel = (typeof PAID_LABELS)[keyof typeof PAID_LABELS];

export type AdSetEvidence = {
  id: string;
  name: string | null;
  goal: string | null;
  learning: boolean | null;
  days_since_edit: number | null;
  spend_7d_usd: number | null;
  conversions_7d: number | null;
  tracking: "ok" | "broken" | "unknown";
  label: PaidLabel;
};

export type CampaignEvidence = {
  id: string;
  name: string | null;
  objective: string | null;
  delivery_state?: "ended" | "paused" | "active_unverified" | "observed_delivery" | "unknown";
  label: PaidLabel | "mixed: see each ad set";
  ad_sets: AdSetEvidence[];
  more_ad_sets?: number;
  reported?: { metrics: string; currency: string | null; status: string | null; period_confirmed: boolean; spend?: number };
};

export type PaidChannelEvidence = {
  source?: string;
  as_of?: string;
  reporting_period?: string;
  channel_slug: string;
  status: "read" | "not connected" | "could not read" | "no reader for this channel";
  reason?: string;
  campaigns?: CampaignEvidence[];
  more_campaigns?: number;
  period?: { from: string; to: string; timezone: string; read_at: string };
  tracking_verdict?: import("@/services/tools/google-ads/_bidding-tracking").TrackingVerdict;
};

export type OrganicItem = {
  first_line: string;
  url: string | null;
  published_on: string | null;
  metrics: string;
  outcome?: string;
  source?: string;
  as_of?: string | null;
};

export type OrganicChannelEvidence = {
  channel_slug: string;
  clock: string;
  evidence: "per_item" | "insufficient" | "could not read";
  label: string;
  items?: OrganicItem[];
  more_items?: number;
  source?: string;
  period?: string;
  limitation?: string;
  account_summary?: { metrics: string; period: string; as_of: string };
};

export type CgoEvidence = {
  paid: PaidChannelEvidence[];
  organic: OrganicChannelEvidence[];
  own_moves: string[] | { status: "could not read"; reason: string };
  waiting_on_founder?: string[];
  waiting_on_founder_more?: number;
  founder_ad_changes?: string[] | { status: "could not read"; reason: string };
  own_launch_results?: string[] | { status: "could not read"; reason: string };
  outcome?: OutcomeSection;
  traffic?: TrafficSection;
  search?: SearchSection;
  cut?: CutManifest;
};

export type CutManifest = {
  left_out: Record<string, number>;
  over_budget?: true;
  note?: typeof OVER_BUDGET_NOTE;
  full_chars?: number;
};
export const OVER_BUDGET_NOTE = "minimum evidence exceeded the budget";

export const PAID_CHANNELS: ReadonlySet<string> = new Set([
  "meta_ads", "google_ads", "youtube_ads", "linkedin_ads", "tiktok_ads", "reddit_ads", "x_ads", "chatgpt_ads",
]);

const PAID_READERS: Record<string, (tenant_id: string, now: Date) => Promise<PaidChannelEvidence>> = {
  meta_ads: (t, n) => readMetaEvidence(t, n),
  google_ads: (t, n) => readGoogleEvidence(t, n),
  youtube_ads: (t, n) => readGoogleEvidence(t, n, "youtube_ads"),
  chatgpt_ads: (t, n) => readChatgptEvidence(t, n),
  linkedin_ads: async (t, n) => (await import("./cgo-channel-readers")).readLinkedInAdsEvidence(t, n),
  reddit_ads: async (t, n) => (await import("./cgo-channel-readers")).readRedditAdsEvidence(t, n),
  tiktok_ads: async (t, n) => (await import("./cgo-channel-readers")).readTiktokAdsEvidence(t, n),
  x_ads: async (t, n) => (await import("./x-ad-evidence")).readXAdsEvidence(t, n),
};

type OrganicStore =
  | { kind: "social_posts"; channels: readonly string[] }
  | { kind: "tiktok" }
  | { kind: "creator_posts"; lane: "ugc_video" }
  | { kind: "outbound_email" }
  | { kind: "unsupported"; why: string }
  | null;

export const ORGANIC_MATRIX: Readonly<Record<string, { store: OrganicStore; clock: string }>> = {
  x_organic: { store: { kind: "social_posts", channels: ["x"] }, clock: "days (a post's reach settles in 2-3 days)" },
  linkedin_organic: { store: { kind: "social_posts", channels: ["linkedin", "linkedin_image"] }, clock: "days (a post's reach settles within a week)" },
  instagram_organic: { store: { kind: "social_posts", channels: ["instagram_image"] }, clock: "days (a post's reach settles within a week)" },
  reddit_organic: { store: { kind: "social_posts", channels: ["reddit", "reddit_comment"] }, clock: "days (a thread lives 1-3 days)" },
  youtube_organic: { store: { kind: "social_posts", channels: ["youtube_video"] }, clock: "weeks (videos keep gathering views for weeks)" },
  tiktok_organic: { store: { kind: "tiktok" }, clock: "days (a video's reach settles within a week)" },
  pinterest_organic: { store: { kind: "social_posts", channels: ["pinterest_pin"] }, clock: "months (pins compound slowly)" },
  blog: { store: null, clock: "months (posts take 2-6 months to rank)" },
  seo: { store: null, clock: "months (ranking changes take 2-6 months)" },
  geo: { store: null, clock: "months (AI answers change slowly)" },
  email_marketing: { store: { kind: "outbound_email" }, clock: "per send (judge each send 2-3 days after it goes out)" },
  sms: { store: { kind: "unsupported", why: "this channel cannot send a text message" }, clock: "per send (judge each send within a day)" },
  ugc: { store: { kind: "creator_posts", lane: "ugc_video" }, clock: "per piece (judge each one when it has run a week)" },
};

export const NO_PER_ITEM_LABEL = "insufficient evidence: no per-item record, no autonomous stop/change";
export const NOTHING_PUBLISHED_LABEL = "insufficient evidence: nothing published yet, no autonomous stop/change";
export const NO_NUMBERS_LABEL = "insufficient evidence: published items have no numbers yet, no autonomous stop/change";
export const JUDGE_ON_ITEMS_LABEL = "judge on these items' own numbers, on this channel's clock";
export const COULD_NOT_READ = "could not read";
export const unsupportedLabel = (why: string) => `insufficient evidence: outcome unknown (${why}), no autonomous stop/change`;

export const ORGANIC_ITEMS_PER_CHANNEL = 5;
export const CAMPAIGNS_PER_CHANNEL = 8;
export const AD_SETS_PER_CAMPAIGN = 4;
export const OWN_MOVES_MAX = 10;
export const OWN_MOVES_DAYS = 30;
export const EVIDENCE_CHAR_BUDGET = 7500;
export const AD_EVIDENCE_CHAR_BUDGET = 20000;

export function trackingOf(o: AdObjectFacts, platformOk: boolean | null): AdSetEvidence["tracking"] {
  if (platformOk === false || o.conversionEventFiring === false) return "broken";
  if (o.conversionEventFiring === true) return "ok";
  return "unknown";
}

export function paidLabel(o: AdObjectFacts, tracking: AdSetEvidence["tracking"]): PaidLabel {
  if (o.learning === true || (o.daysSinceEdit != null && o.lockDays > 0 && o.daysSinceEdit < o.lockDays)) return PAID_LABELS.learning;
  if (o.brand === true) return PAID_LABELS.brand;
  if (o.brand === null) return PAID_LABELS.brandUnknown;
  if (o.conversionObjective === false) return PAID_LABELS.awareness;
  if (o.conversionObjective == null) return PAID_LABELS.purposeUnknown;
  if (o.resultsMatchGoal === false) return PAID_LABELS.notGoal;
  if (o.resultsMatchGoal === null) return PAID_LABELS.goalUnknown;
  if (tracking === "broken") return PAID_LABELS.trackingBroken;
  if (tracking === "unknown") return PAID_LABELS.trackingUnknown;
  return PAID_LABELS.conversion;
}

export function adSetEvidence(o: AdObjectFacts, name: string | null, platformOk: boolean | null): AdSetEvidence {
  const tracking = trackingOf(o, platformOk);
  return {
    id: o.id,
    name: name ? name.slice(0, 80) : null,
    goal: o.objective,
    learning: o.learning,
    days_since_edit: o.daysSinceEdit,
    spend_7d_usd: o.spend7dUsd == null ? null : Math.round(o.spend7dUsd * 100) / 100,
    conversions_7d: o.conversions7d == null ? null : Math.round(o.conversions7d * 100) / 100,
    tracking,
    label: paidLabel(o, tracking),
  };
}

export function campaignEvidence(c: { id: string; name: string | null; objective: string | null }, sets: AdSetEvidence[]): CampaignEvidence {
  const labels = new Set(sets.map((s) => s.label));
  const sorted = [...sets].sort((a, b) => (b.spend_7d_usd ?? -1) - (a.spend_7d_usd ?? -1));
  const shown = sorted.slice(0, AD_SETS_PER_CAMPAIGN);
  return {
    id: c.id,
    name: c.name ? c.name.slice(0, 80) : null,
    objective: c.objective,
    label: labels.size === 1 ? [...labels][0] : "mixed: see each ad set",
    ad_sets: shown,
    ...(sorted.length > shown.length ? { more_ad_sets: sorted.length - shown.length } : {}),
  };
}

function campaignSpend(c: CampaignEvidence): number {
  if (c.reported?.spend != null && Number.isFinite(c.reported.spend)) return c.reported.spend;
  return c.ad_sets.reduce((s, a) => s + (a.spend_7d_usd ?? 0), 0);
}

export function paidChannel(slug: string, campaigns: CampaignEvidence[], moreFromRead = 0): PaidChannelEvidence {
  const sorted = [...campaigns].sort((a, b) => campaignSpend(b) - campaignSpend(a));
  const shown = sorted.slice(0, CAMPAIGNS_PER_CHANNEL);
  const more = sorted.length - shown.length + moreFromRead;
  return { channel_slug: slug, status: "read", campaigns: shown, ...(more > 0 ? { more_campaigns: more } : {}) };
}

export function paidUnread(slug: string, e: unknown): PaidChannelEvidence {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && code.endsWith("not_connected")) return { channel_slug: slug, status: "not connected" };
  const msg = e instanceof Error ? e.message : String(e);
  return { channel_slug: slug, status: "could not read", reason: msg.replace(/\s+/g, " ").slice(0, 120) };
}

const CUT_RE = /\b(pause|pausing|stop|turn(ing)? off|switch off|disable|lower|cut|reduce|decrease|shut|kill|halve|halving|trim|shrink|scale (back|down))\b/i;
const CITES_CONVERSIONS_RE =
  /\b(no|zero|0|without|lack of|few|low|too few)\b[^.]{0,24}\b(bookings?|conversions?|sign-?ups?|leads?|sales|purchases?|installs?|registrations?)\b|\b(cpa|cost per|roas)\b/i;

export type CutHold =
  | "too_early_learning"
  | "judged_on_reach"
  | "tracking_not_trusted"
  | "purpose_unknown"
  | "insufficient_evidence"
  | "evidence_unreadable"
  | "object_not_in_evidence"
  | "partial_coverage"
  | "brand_campaign"
  | "brand_unknown"
  | "results_not_goal"
  | "results_unverified";

function holdOf(label: string, onConversions: boolean): CutHold | null {
  if (label === PAID_LABELS.learning) return "too_early_learning";
  if (label === PAID_LABELS.brand) return "brand_campaign";
  if (label === PAID_LABELS.brandUnknown) return "brand_unknown";
  if (!onConversions) return null;
  if (label === PAID_LABELS.notGoal) return "results_not_goal";
  if (label === PAID_LABELS.goalUnknown) return "results_unverified";
  if (label === PAID_LABELS.awareness) return "judged_on_reach";
  if (label === PAID_LABELS.trackingBroken || label === PAID_LABELS.trackingUnknown) return "tracking_not_trusted";
  if (label === PAID_LABELS.purposeUnknown) return "purpose_unknown";
  return null;
}

function mentions(text: string, id: string | null, name: string | null): boolean {
  if (id && text.includes(id.toLowerCase())) return true;
  const n = (name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return n.length >= 4 && text.includes(n);
}

export function organicEvidenceOf(e: CgoEvidence | null | undefined, slug: string): OrganicChannelEvidence["evidence"] | null {
  return e?.organic.find((o) => o.channel_slug === slug)?.evidence ?? null;
}

export function cutHeldByEvidence(args: {
  target: string;
  intent: string;
  why?: string;
  evidence: CgoEvidence | null | undefined;
  basisUnknown?: boolean;
}): { reasons: CutHold[]; object: string | null } | null {
  if (!CUT_RE.test(args.intent)) return null;
  const e = args.evidence;
  if (PAID_CHANNELS.has(args.target)) {
    const ch = e?.paid.find((p) => p.channel_slug === args.target);
    if (!ch || ch.status !== "read") return { reasons: ["evidence_unreadable"], object: null };
    const text = args.intent.toLowerCase().replace(/\s+/g, " ");
    const onConversions = args.basisUnknown === true || CITES_CONVERSIONS_RE.test(`${args.intent} ${args.why ?? ""}`);
    const reasons = new Set<CutHold>();
    let object: string | null = null;
    let named = false;
    for (const c of ch.campaigns ?? []) {
      const wholeCampaign = mentions(text, c.id, c.name);
      if (wholeCampaign && c.ad_sets.length === 0) {
        named = true;
        reasons.add("tracking_not_trusted");
        object ??= c.name;
      }
      if (wholeCampaign && (c.more_ad_sets ?? 0) > 0 && !c.ad_sets.some((s) => mentions(text, s.id, s.name))) {
        named = true;
        reasons.add("partial_coverage");
        object ??= c.name;
      }
      for (const s of c.ad_sets) {
        if (!wholeCampaign && !mentions(text, s.id, s.name)) continue;
        named = true;
        const h = holdOf(s.label, onConversions);
        if (!h) continue;
        reasons.add(h);
        object ??= wholeCampaign ? c.name : s.name;
      }
    }
    if (!named) return { reasons: (ch.more_campaigns ?? 0) > 0 ? ["object_not_in_evidence", "partial_coverage"] : ["object_not_in_evidence"], object: null };
    return reasons.size ? { reasons: [...reasons], object } : null;
  }
  if (!ORGANIC_MATRIX[args.target]) return null;
  return organicEvidenceOf(e, args.target) === "per_item" ? null : { reasons: ["insufficient_evidence"], object: null };
}

export function pauseEvidenceLine(objects: readonly AdObjectFacts[] | null | undefined, platformOk: boolean | null, readAt?: Date): string | null {
  if (!objects?.length || objects.some((o) => o.spend7dUsd == null || o.conversions7d == null)) return null;
  const spend = Math.round(objects.reduce((s, o) => s + (o.spend7dUsd ?? 0), 0) * 100) / 100;
  const conv = Math.round(objects.reduce((s, o) => s + (o.conversions7d ?? 0), 0) * 100) / 100;
  const labels = [...new Set(objects.map((o) => adSetEvidence(o, null, platformOk).label))];
  const read = readAt ? ` (read ${readAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })})` : "";
  return `Last 7 days${read}: $${spend} spent, ${conv} conversion${conv === 1 ? "" : "s"}; ${labels.length === 1 ? labels[0] : "mixed ad sets"}.`;
}

export const CUT_HOLD_WORDS: Readonly<Record<CutHold, string>> = {
  too_early_learning: "it is still learning, too early to judge",
  judged_on_reach: "it is built for reach, so zero conversions says nothing",
  tracking_not_trusted: "its conversion tracking is not trusted",
  purpose_unknown: "I could not tell what it optimises for",
  insufficient_evidence: "there are no per-item numbers to judge it on",
  evidence_unreadable: "I could not read its numbers",
  object_not_in_evidence: "it names no campaign whose numbers I read",
  partial_coverage: "I read only part of it, so I cannot judge the whole of it",
  brand_campaign: "it is your brand search, people already looking for you",
  results_not_goal: "the conversions it counts are not the ones your goal is about",
  brand_unknown: "I could not check whether it is your brand search",
  results_unverified: "I could not check whether its conversions are the ones your goal is about",
};

const METRIC_PRIORITY = ["impression", "view", "reach", "click", "like", "repl", "comment", "repost", "retweet", "share", "save", "bookmark", "quote"];

export function compactMetrics(m: unknown, readAt?: string | null): string {
  const leaves = new Map<string, number>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 2) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "number" && Number.isFinite(x)) {
        const key = k.replace(/_count$/, "s").replace(/_/g, " ");
        if (!leaves.has(key)) leaves.set(key, x);
      } else walk(x, depth + 1);
    }
  };
  walk(m, 0);
  if (leaves.size === 0) return "not read yet";
  const rank = (k: string) => {
    const i = METRIC_PRIORITY.findIndex((p) => k.includes(p));
    return i < 0 ? 99 : i;
  };
  const parts = [...leaves.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).slice(0, 5).map(([k, v]) => `${k} ${v}`);
  return `${parts.join(", ")}${readAt ? ` (read ${readAt.slice(0, 10)})` : ""}`;
}

export function firstLine(s: unknown, max = 100): string {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  if (!t) return "(no text)";
  return t.length > max ? `${sliceWhole(t, max - 1)}…` : t;
}

const UNMEASURED = /^not (read yet|recorded)/;

export function organicChannel(slug: string, items: OrganicItem[] | null, readError?: string): OrganicChannelEvidence {
  const m = ORGANIC_MATRIX[slug];
  const clock = m?.clock ?? "unknown";
  if (!m || !m.store) return { channel_slug: slug, clock, evidence: "insufficient", label: NO_PER_ITEM_LABEL };
  if (m.store.kind === "unsupported") return { channel_slug: slug, clock, evidence: "insufficient", label: unsupportedLabel(m.store.why) };
  if (readError != null || items == null) {
    return { channel_slug: slug, clock, evidence: "could not read", label: `${COULD_NOT_READ}: ${(readError ?? "no rows").slice(0, 100)}; no autonomous stop/change` };
  }
  if (items.length === 0) return { channel_slug: slug, clock, evidence: "insufficient", label: NOTHING_PUBLISHED_LABEL };
  const sorted = [...items].sort((a, b) => Number(UNMEASURED.test(a.metrics)) - Number(UNMEASURED.test(b.metrics)) || (b.as_of ?? b.published_on ?? "").localeCompare(a.as_of ?? a.published_on ?? ""));
  const shown = sorted.slice(0, ORGANIC_ITEMS_PER_CHANNEL);
  const measured = shown.some((i) => !UNMEASURED.test(i.metrics));
  return {
    channel_slug: slug,
    clock,
    evidence: measured ? "per_item" : "insufficient",
    label: measured ? JUDGE_ON_ITEMS_LABEL : NO_NUMBERS_LABEL,
    items: shown,
    ...(sorted.length > shown.length ? { more_items: sorted.length - shown.length } : {}),
  };
}

export type OwnCardRow = { id: string; status: string; emitted_at: string; body: Record<string, unknown> | null };
export type OwnRunRow = { id: string; status: string; source_decision_id: string | null };
export type LineageActionRow = {
  id: string;
  run_id: string;
  channel_slug: string;
  title: string;
  status: string;
  exec_status: string | null;
  approved_by_source: string | null;
  status_at: string | null;
  proposed_at?: string | null;
  exec_class?: string | null;
  exec_payload?: unknown;
  origin?: string | null;
  why?: string | null;
};
export type LineageDecisionRow = {
  id: string;
  agent_run_id: string | null;
  decision_class: string;
  status: string | null;
  approved_by_source: string | null;
  approved_at: string | null;
  body?: Record<string, unknown> | null;
};
export type OutcomeRow = {
  decision_id: string;
  reconcile_status: string;
  delta_metrics: Record<string, unknown> | null;
  measured_at: string | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "?";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "?" : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function signed(n: number, money: boolean): string {
  const r = Math.round(n * 100) / 100;
  const abs = Math.abs(r);
  return `${r < 0 ? "-" : "+"}${money ? "$" : ""}${abs}`;
}

export function outcomeText(o: OutcomeRow | undefined): string {
  if (!o) return "no measurement recorded";
  if (o.reconcile_status === "pending") return "not yet measured";
  if (o.reconcile_status === "no_data") return `measured ${shortDate(o.measured_at)}: no data`;
  if (o.reconcile_status === "error") return "could not measure";
  const d = o.delta_metrics ?? {};
  const parts: string[] = [];
  for (const [k, money] of [["spend", true], ["conversions", false], ["roas", false]] as const) {
    const v = d[k];
    if (typeof v === "number" && Number.isFinite(v)) parts.push(`${k} ${signed(v, money)}`);
  }
  return `measured ${shortDate(o.measured_at)}: ${parts.length ? parts.join(", ") : "no change recorded"}`;
}

function actionPhrase(a: LineageActionRow): string {
  const who = a.approved_by_source === "cgo" ? "you approved" : a.status === "acted" ? "founder approved" : a.status;
  const exec = a.exec_status ? `, ${a.exec_status}` : "";
  return `"${firstLine(adCardTitle(a), 90)}" (${who}${exec})`;
}

export function ownMoveLines(input: {
  cards: OwnCardRow[];
  runs: OwnRunRow[];
  actions: LineageActionRow[];
  decisions: LineageDecisionRow[];
  outcomes: OutcomeRow[];
  approvedActions: LineageActionRow[];
  approvedDecisions: LineageDecisionRow[];
}): string[] {
  const outcomeBy = new Map(input.outcomes.map((o) => [o.decision_id, o]));
  const lines: Array<{ at: string; line: string }> = [];
  const shown = new Set<string>();

  for (const c of input.cards) {
    const b = c.body ?? {};
    if (b.dispatched_by !== "cgo") continue;
    const target = String(b.target_agent_slug ?? "?");
    const intent = firstLine(b.intent, 90);
    const run = input.runs.find((r) => r.source_decision_id === c.id);
    let result: string;
    if (!run) {
      result = c.status === "proposed" ? "waiting for the founder" : c.status === "approved" || c.status === "acted" ? "no run found" : c.status;
    } else {
      const acts = input.actions.filter((a) => a.run_id === run.id);
      const decs = input.decisions.filter((d) => d.agent_run_id === run.id);
      const bits: string[] = [`run ${run.status}`];
      if (acts.length) {
        bits.push(`${acts.length} card${acts.length > 1 ? "s" : ""}: ${acts.slice(0, 2).map(actionPhrase).join("; ")}${acts.length > 2 ? "; ..." : ""}`);
        acts.forEach((a) => shown.add(a.id));
      }
      const measured = decs.filter((d) => outcomeBy.has(d.id));
      for (const d of decs) shown.add(d.id);
      if (measured.length) bits.push(measured.slice(0, 2).map((d) => `${d.decision_class}: ${outcomeText(outcomeBy.get(d.id))}`).join("; "));
      else if (decs.some((d) => d.status === "approved" || d.status === "acted")) bits.push("not yet measured");
      else if (!acts.length && !decs.length) bits.push("proposed nothing");
      result = bits.join("; ");
    }
    lines.push({ at: c.emitted_at, line: `${shortDate(c.emitted_at)}: cgo asked ${target} to ${intent} -> ${result}` });
  }

  for (const a of input.approvedActions) {
    if (a.approved_by_source !== "cgo" || shown.has(a.id)) continue;
    const exec = a.exec_status ?? "not executed";
    if (a.origin === "ad_spend_controller") {
      lines.push({
        at: a.status_at ?? a.proposed_at ?? "",
        line: `${shortDate(a.status_at ?? a.proposed_at)}: Zavi's spend controller (not you) ordered ${a.channel_slug} "${firstLine(a.title, 70)}" -> ${exec}; why: ${firstLine(a.why, 120)}`,
      });
      continue;
    }
    lines.push({
      at: a.status_at ?? a.proposed_at ?? "",
      line: `${shortDate(a.status_at ?? a.proposed_at)}: cgo approved ${a.channel_slug} card "${firstLine(a.title, 70)}" -> ${exec}; no outcome record for channel cards`,
    });
  }
  for (const d of input.approvedDecisions) {
    if (d.approved_by_source !== "cgo" || shown.has(d.id)) continue;
    lines.push({
      at: d.approved_at ?? "",
      line: `${shortDate(d.approved_at)}: cgo approved ${d.decision_class} -> ${d.status ?? "?"}; ${outcomeText(outcomeBy.get(d.id))}`,
    });
  }
  return lines
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, OWN_MOVES_MAX)
    .map((l) => l.line);
}

export const FOUNDER_OWED_MAX = 5;
const OWED_OPEN = new Set(["pending", "snoozed"]);
const OWED_CLOSED = new Set(["stale", "displaced"]);
export const OWED_LOOKBACK_DAYS = 60;

export const owedTopic = (action_id: string) => `action:${action_id}`;

export type OwedAction = {
  id: string;
  run_id: string;
  channel_slug: string;
  title: string;
  status: string;
  status_at: string | null;
  proposed_at: string | null;
  note?: string | null;
};

function superseded(a: OwedAction, successors: ReadonlySet<string>): boolean {
  return successors.has(a.id) || (a.status === "stale" && /^(Replaced by a newer version|Closed when Zavi paused this channel)/.test(a.note ?? ""));
}

export function founderOwedLines(
  input: {
    actions: OwedAction[];
    intentByRun: ReadonlyMap<string, string>;
    successors?: ReadonlySet<string>;
    askedOn?: ReadonlyMap<string, string>;
  },
  now: Date,
): { lines: string[]; more: number } {
  const owed: Array<{ open: boolean; at: string; line: string }> = [];
  for (const a of input.actions) {
    const intent = input.intentByRun.get(a.run_id);
    if (intent === undefined || superseded(a, input.successors ?? new Set())) continue;
    const at = a.proposed_at ?? a.status_at ?? "";
    let state: string;
    const open = OWED_OPEN.has(a.status);
    if (open) {
      const days = Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / DAY));
      state = `waiting on the founder ${days} day${days === 1 ? "" : "s"}`;
    } else if (OWED_CLOSED.has(a.status)) {
      state = `closed ${shortDate(a.status_at ?? at)} with no completion recorded in Zavi`;
    } else continue;
    const asked = input.askedOn?.get(a.id);
    owed.push({
      open,
      at: open ? at : (a.status_at ?? at),
      line: `[${a.id}] ${shortDate(at)} ${a.channel_slug}: "${firstLine(a.title, 80)}" (for "${firstLine(intent, 60)}") -> ${state}${asked ? `; you asked ${shortDate(asked)}` : ""}`,
    });
  }
  owed.sort((x, y) => (x.open !== y.open ? (x.open ? -1 : 1) : x.open ? x.at.localeCompare(y.at) : y.at.localeCompare(x.at)));
  return { lines: owed.slice(0, FOUNDER_OWED_MAX).map((l) => l.line), more: Math.max(0, owed.length - FOUNDER_OWED_MAX) };
}

export function evidenceSize(e: CgoEvidence): number {
  return JSON.stringify(e).length;
}

function lowestSpend<T>(rows: readonly T[], spend: (r: T) => number): number {
  let at = rows.length - 1;
  for (let i = rows.length - 2; i >= 0; i--) if (spend(rows[i]) < spend(rows[at])) at = i;
  return at;
}

export function budgetEvidence(e: CgoEvidence, max = EVIDENCE_CHAR_BUDGET): CgoEvidence {
  const out: CgoEvidence = JSON.parse(JSON.stringify(e));
  const leftOut: Record<string, number> = { ...(out.cut?.left_out ?? {}) };
  const fullChars = out.cut?.full_chars ?? evidenceSize(e);
  delete out.cut;
  const withCut = (over: boolean): CgoEvidence => {
    if (over) return { ...out, cut: { left_out: leftOut, over_budget: true, note: OVER_BUDGET_NOTE, full_chars: fullChars } };
    return Object.keys(leftOut).length ? { ...out, cut: { left_out: leftOut, full_chars: fullChars } } : out;
  };
  const fits = () => evidenceSize(withCut(false)) <= max;
  const drop = (key: string) => {
    leftOut[key] = (leftOut[key] ?? 0) + 1;
    return true;
  };
  const dropOrganicItem = (ch: OrganicChannelEvidence) => {
    const items = ch.items!;
    let index = items.length - 1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (UNMEASURED.test(items[i].metrics)) { index = i; break; }
    }
    items.splice(index, 1);
    ch.more_items = (ch.more_items ?? 0) + 1;
    return drop(`organic.${ch.channel_slug}.items`);
  };
  const dropRow = (list: unknown[] | undefined, key: string) => {
    if (!Array.isArray(list) || list.length === 0) return false;
    list.pop();
    return drop(key);
  };

  const spendBefore = new Map<CampaignEvidence, number>(out.paid.flatMap((ch) => (ch.campaigns ?? []).map((c): [CampaignEvidence, number] => [c, campaignSpend(c)])));
  const steps: Array<() => boolean> = [
    () => {
      for (const ch of out.paid) for (const c of [...(ch.campaigns ?? [])].reverse()) {
        if (c.ad_sets.length > 1) {
          c.ad_sets.splice(lowestSpend(c.ad_sets, (a) => a.spend_7d_usd ?? -1), 1);
          c.more_ad_sets = (c.more_ad_sets ?? 0) + 1;
          return drop(`paid.${ch.channel_slug}.ad_sets`);
        }
      }
      return false;
    },
    () => {
      const ch = [...out.organic].filter((o) => (o.items?.length ?? 0) > 1).sort((a, b) => (b.items?.length ?? 0) - (a.items?.length ?? 0))[0];
      return ch ? dropOrganicItem(ch) : false;
    },
    () => {
      const ch = [...out.paid].filter((p) => (p.campaigns?.length ?? 0) > 1).sort((a, b) => (b.campaigns?.length ?? 0) - (a.campaigns?.length ?? 0))[0];
      if (!ch?.campaigns) return false;
      ch.campaigns.splice(lowestSpend(ch.campaigns, (c) => spendBefore.get(c) ?? campaignSpend(c)), 1);
      ch.more_campaigns = (ch.more_campaigns ?? 0) + 1;
      return drop(`paid.${ch.channel_slug}.campaigns`);
    },
    () => (Array.isArray(out.own_moves) && out.own_moves.length > 3 ? dropRow(out.own_moves, "own_moves") : false),
    () => {
      const goals = out.outcome?.goals ?? [];
      const g = [...goals].filter((x) => (x.points?.length ?? 0) > 1).sort((a, b) => b.points!.length - a.points!.length)[0];
      if (g) {
        g.points!.shift();
        if (g.window) g.window = { ...g.window, from: g.points![0][0] };
        return drop("outcome.points");
      }
      for (const m of goals) if (dropRow(m.markers, "outcome.markers")) return true;
      return false;
    },
    () => dropRow(out.traffic?.top_pages, "traffic.top_pages"),
    () => dropRow(out.search?.top_pages, "search.top_pages"),
    () => dropRow(out.search?.top_queries, "search.top_queries"),
  ];
  for (const step of steps) {
    while (!fits() && step()) {
    }
    if (fits()) break;
  }
  return withCut(!fits());
}

type MetaListedAdSet = import("./unattended-policy").MetaAdSetRow & {
  name?: string;
  campaign?: { id?: string; name?: string; objective?: string };
};

export async function readMetaEvidence(tenant_id: string, now: Date): Promise<PaidChannelEvidence> {
  const { fbGet, metaAdsCreds } = await import("@/services/tools/meta-ads/_client");
  const { fetchMetaDailySeries } = await import("@/services/tools/meta-ads/daily_series");
  const { META_ADSET_FIELDS, metaObjectFacts, sumMetaPerf, loadTracking, withConversionFiring } = await import("./unattended-policy");
  const creds = await metaAdsCreds(tenant_id);
  const r = (await fbGet(tenant_id, `${creds.ad_account_id}/adsets`, {
    fields: `${META_ADSET_FIELDS},name,campaign{id,name,objective}`,
    effective_status: JSON.stringify(["ACTIVE"]),
    limit: 50,
  })) as { data?: MetaListedAdSet[]; paging?: { next?: string } };
  const sets = r.data ?? [];
  if (sets.length === 0) return paidChannel("meta_ads", []);
  const [series, tracking] = await Promise.all([
    fetchMetaDailySeries(tenant_id, { level: "adset", date_preset: "last_7d" }),
    loadTracking(tenant_id, "meta").catch(() => ({ ok: null, firedEvents: null })),
  ]);
  const perf = series.truncated ? null : sumMetaPerf(series.rows);
  const { loadGoalMatchContext, withGoalMatch } = await import("./ad-goal-match");
  const facts = withGoalMatch(
    withConversionFiring(
      sets.map((a) => metaObjectFacts(a, a.campaign?.objective ?? null, perf ? perf.get(String(a.id)) ?? { spend: 0, conv: 0 } : null, now)),
      "meta",
      tracking,
    ),
    "meta",
    await loadGoalMatchContext(tenant_id, "meta"),
  );
  const byCampaign = new Map<string, { head: { id: string; name: string | null; objective: string | null }; sets: AdSetEvidence[] }>();
  sets.forEach((a, i) => {
    const cid = String(a.campaign?.id ?? "?");
    const g = byCampaign.get(cid) ?? { head: { id: cid, name: a.campaign?.name ?? null, objective: a.campaign?.objective ?? null }, sets: [] };
    g.sets.push(adSetEvidence(facts[i], a.name ?? null, tracking.ok));
    byCampaign.set(cid, g);
  });
  const ch = paidChannel("meta_ads", [...byCampaign.values()].map((g) => campaignEvidence(g.head, g.sets)));
  if (r.paging?.next) ch.reason = "more than 50 live ad sets; the rest not read";
  return ch;
}

async function readTrackingVerdict(tenant_id: string): Promise<PaidChannelEvidence["tracking_verdict"] | null> {
  try {
    const { conversionTrackingHealthTool } = await import("@/services/tools/google-ads/conversion_tracking_health");
    const r = (await conversionTrackingHealthTool.execute({ tenant_id, log: () => {} }, {})) as { tracking_verdict?: PaidChannelEvidence["tracking_verdict"] | null };
    return r?.tracking_verdict ?? null;
  } catch {
    return null;
  }
}

export const GOOGLE_LIST_CAP = 50;
const GOOGLE_READ = 6;
const YOUTUBE_TYPES = "('VIDEO', 'DEMAND_GEN')";
export async function readGoogleEvidence(tenant_id: string, now: Date, slug: "google_ads" | "youtube_ads" = "google_ads"): Promise<PaidChannelEvidence> {
  const { gadsSearch } = await import("@/services/tools/google-ads/_client");
  const { loadGoogleObjects, loadTracking, withConversionFiring } = await import("./unattended-policy");
  const where = `campaign.status = 'ENABLED' AND campaign.advertising_channel_type ${slug === "youtube_ads" ? "IN" : "NOT IN"} ${YOUTUBE_TYPES}`;
  const [listed, spent] = await Promise.all([
    gadsSearch(tenant_id, `SELECT campaign.id, campaign.name FROM campaign WHERE ${where} LIMIT ${GOOGLE_LIST_CAP + 1}`) as Promise<
      Array<{ campaign?: { id?: string | number; name?: string } }>
    >,
    gadsSearch(
      tenant_id,
      `SELECT campaign.id, metrics.cost_micros FROM campaign WHERE ${where} AND segments.date DURING LAST_7_DAYS ORDER BY metrics.cost_micros DESC LIMIT ${GOOGLE_LIST_CAP}`,
    ) as Promise<Array<{ campaign?: { id?: string | number }; metrics?: { costMicros?: string | number } }>>,
  ]);
  const cost = new Map(spent.map((r) => [String(r.campaign?.id ?? ""), Number(r.metrics?.costMicros ?? 0)]));
  const overCap = listed.length > GOOGLE_LIST_CAP;
  const heads = listed
    .slice(0, GOOGLE_LIST_CAP)
    .map((r) => ({ id: String(r.campaign?.id ?? ""), name: r.campaign?.name ?? null }))
    .filter((h) => /^\d+$/.test(h.id))
    .sort((a, b) => (cost.get(b.id) ?? -1) - (cost.get(a.id) ?? -1));
  const read = heads.slice(0, GOOGLE_READ);
  const tracking = await loadTracking(tenant_id, "google").catch(() => ({ ok: null, firedEvents: null }));
  const { loadGoalMatchContext, withGoalMatch } = await import("./ad-goal-match");
  const goalCtx = await loadGoalMatchContext(tenant_id, "google");
  const campaigns: CampaignEvidence[] = [];
  let unreadable = 0;
  for (const h of read) {
    const objs = await loadGoogleObjects(tenant_id, h.id, now);
    if (!objs) {
      unreadable++;
      continue;
    }
    const [o] = withGoalMatch(withConversionFiring(objs, "google", tracking), "google", goalCtx);
    campaigns.push(campaignEvidence({ id: h.id, name: h.name, objective: o.objective }, [adSetEvidence(o, h.name, tracking.ok)]));
  }
  const ch = paidChannel(slug, campaigns, heads.length - read.length);
  const verdict = await readTrackingVerdict(tenant_id);
  if (verdict) ch.tracking_verdict = verdict;
  const reasons = [
    ...(overCap ? [`more than ${GOOGLE_LIST_CAP} enabled campaigns; the rest not counted`] : []),
    ...(unreadable ? [`${unreadable} campaign${unreadable > 1 ? "s" : ""} ${COULD_NOT_READ}`] : []),
  ];
  if (reasons.length) ch.reason = reasons.join("; ");
  return ch;
}

export async function readChatgptEvidence(tenant_id: string, now: Date): Promise<PaidChannelEvidence> {
  const { readChatgptPerformance } = await import("@/services/tools/chatgpt-ads/read_performance");
  const report = await readChatgptPerformance(tenant_id, 7, undefined, now);
  if (!("campaigns" in report) || !Array.isArray(report.campaigns)) {
    return "no_campaigns_for_tenant" in report && report.no_campaigns_for_tenant === true
      ? paidChannel("chatgpt_ads", [])
      : { channel_slug: "chatgpt_ads", status: "could not read", reason: "Campaign inventory is incomplete or ownership could not be verified." };
  }
  if (!report.period || report.truncated || report.rows_dropped || report.names_unclaimable || report.reporting_warning) {
    return { channel_slug: "chatgpt_ads", status: "could not read", reason: "Campaign reporting is incomplete; performance is unknown." };
  }
  const campaigns: CampaignEvidence[] = report.campaigns.map(c => {
    const periodVerified = c.requested_period_confirmed === true;
    const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
    const ended = c.status === "archived" || (typeof c.end_time === "number" && c.end_time * 1000 <= now.getTime());
    return {
      id: c.id, name: c.name, objective: c.bidding_type ?? null,
      delivery_state: ended ? "ended" : c.status === "paused" ? "paused" : c.status === "active"
        ? periodVerified && valid(c.impressions) && c.impressions > 0 ? "observed_delivery" : "active_unverified"
        : "unknown",
      label: PAID_LABELS.trackingUnknown,
      ad_sets: [{
        id: c.id, name: c.name, goal: c.bidding_type ?? null, learning: null,
        days_since_edit: typeof c.updated_at === "number" ? Math.max(0, (now.getTime() - c.updated_at * 1000) / DAY) : null,
        spend_7d_usd: report.currency === "USD" && periodVerified && valid(c.spend) ? c.spend : null,
        conversions_7d: periodVerified && valid(c.conversions) ? c.conversions : null,
        tracking: "unknown", label: PAID_LABELS.trackingUnknown,
      }],
    };
  });
  const result = paidChannel("chatgpt_ads", campaigns);
  result.period = { from: report.period.from, to: report.period.to, timezone: report.period.timezone, read_at: new Date().toISOString() };
  result.reason = "Observed delivery refers to the requested reporting window, not current serving. Tracking is not verified. " +
    (report.currency !== "USD" ? "USD spend unavailable. " : "") +
    (report.campaigns.some(c => c.requested_period_confirmed !== true) ? "Unconfirmed-period metrics withheld. " : "") +
    "This evidence does not authorize funding or activation.";
  return result;
}

async function readPaid(tenant_id: string, slugs: string[], now: Date): Promise<PaidChannelEvidence[]> {
  return Promise.all(
    slugs.map(async (slug) => {
      const read = PAID_READERS[slug];
      if (!read) return { channel_slug: slug, status: "no reader for this channel" as const };
      try {
        return await read(tenant_id, now);
      } catch (e) {
        return paidUnread(slug, e);
      }
    }),
  );
}

type SocialPostRow = {
  account_id?: string | null;
  transport?: string | null;
  channel: string;
  external_post_id: string | null;
  external_url: string | null;
  approved_payload_snapshot: { payload?: Record<string, unknown> } | null;
  metrics: Record<string, unknown> | null;
  metrics_read_at: string | null;
  scheduled_at: string | null;
  updated_at: string;
};
type SnapshotRow = { account_id?: string | null; external_post_id: string; captured_on: string; posted_at: string | null; text: string | null; url: string | null; metrics: Record<string, unknown> | null };
type TiktokRow = { content: Record<string, unknown> | null; scheduled_at: string; external_post_ids: string[] | null };

export function socialItems(posts: SocialPostRow[], snaps: SnapshotRow[], channels: readonly string[], snapshotChannel = "x"): OrganicItem[] {
  const latestSnap = new Map<string, SnapshotRow>();
  for (const s of snaps) {
    const prev = latestSnap.get(s.external_post_id);
    if (!prev || s.captured_on > prev.captured_on) latestSnap.set(s.external_post_id, s);
  }
  const items: OrganicItem[] = [];
  const seen = new Set<string>();
  for (const p of posts) {
    if (!channels.includes(p.channel)) continue;
    const pl = p.approved_payload_snapshot?.payload ?? {};
    const matchesSnapshot = p.channel === snapshotChannel || (snapshotChannel === "linkedin" && p.channel === "linkedin_image") || (snapshotChannel === "instagram" && p.channel === "instagram_image");
    const snap = matchesSnapshot && p.external_post_id ? latestSnap.get(p.external_post_id) : undefined;
    if (matchesSnapshot && p.external_post_id) seen.add(p.external_post_id);
    items.push({
      first_line: firstLine(pl.text ?? pl.title ?? (Array.isArray(pl.thread) ? pl.thread[0] : null)),
      url: p.external_url,
      published_on: (p.scheduled_at ?? p.updated_at)?.slice(0, 10) ?? null,
      metrics: snap ? compactMetrics(snap.metrics, snap.captured_on) : compactMetrics(p.metrics, p.metrics_read_at),
      source: snap ? `${snapshotChannel} post snapshot` : "published post ledger",
      as_of: snap?.captured_on ?? p.metrics_read_at,
    });
  }
  if (channels.some((c) => c === snapshotChannel || c.startsWith(`${snapshotChannel}_`))) {
    for (const s of latestSnap.values()) {
      if (seen.has(s.external_post_id)) continue;
      items.push({ first_line: firstLine(s.text), url: s.url, published_on: s.posted_at?.slice(0, 10) ?? null, metrics: compactMetrics(s.metrics, s.captured_on), source: `${snapshotChannel} post snapshot`, as_of: s.captured_on });
    }
  }
  return items;
}

export type PublicationRow = {
  platform: string;
  account: string | null;
  post_url: string | null;
  published_at: string | null;
  verification: string;
  verified_at: string | null;
  created_at: string;
};
export type LibraryAdRow = {
  meta_ad_id: string | null;
  meta_auto_paused_at: string | null;
  metrics: Record<string, unknown> | null;
  metrics_read_at: string | null;
  created_at: string;
};
export type OutboundSendRow = {
  status: string;
  subject: string | null;
  dispatched_at: string | null;
  dispatch_error: string | null;
};

export type CampaignSendRow = {
  title: string | null;
  exec_status: string;
  executed_at: string | null;
  exec_result: Record<string, unknown> | null;
};
export type LedgerSendRow = {
  subject: string | null;
  status: string;
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  unknown: number;
  hard_bounces: number;
  complaints: number;
  hold_reason: string | null;
  created_at: string;
  finished_at: string | null;
};

export const CREATOR_POST_NO_NUMBERS = "not recorded (creator posts keep no per-post numbers here)";
export const EMAIL_NO_NUMBERS = "not recorded (no open or click events are stored)";

const PUBLICATION_OUTCOME: Record<string, (platform: string) => string> = {
  verified: (p) => `published, found on ${p}`,
  failed: (p) => `not found on ${p}, publishing unconfirmed`,
  manual: (p) => `published per the founder, ${p} has no public check`,
  pending: (p) => `published per the founder, ${p} check not run yet`,
};

export function creatorItems(pubs: PublicationRow[], ads: LibraryAdRow[]): OrganicItem[] {
  const posts = pubs.map((p): OrganicItem => ({
    first_line: firstLine(`Creator post on ${p.platform}${p.account ? ` (${p.account})` : ""}`),
    url: p.post_url,
    published_on: (p.published_at ?? p.created_at).slice(0, 10),
    metrics: CREATOR_POST_NO_NUMBERS,
    outcome: (PUBLICATION_OUTCOME[p.verification] ?? PUBLICATION_OUTCOME.pending)(p.platform),
    source: "creator publication log",
    as_of: p.verified_at ?? p.created_at,
  }));
  const running = ads
    .filter((a) => a.meta_ad_id)
    .map((a): OrganicItem => ({
      first_line: "Creator video running as a Meta ad",
      url: null,
      published_on: a.created_at.slice(0, 10),
      metrics: compactMetrics(a.metrics, a.metrics_read_at),
      outcome: a.meta_auto_paused_at ? `Meta ad paused ${a.meta_auto_paused_at.slice(0, 10)}` : "running as a Meta ad",
      source: "Meta ads",
      as_of: a.metrics_read_at,
    }));
  return [...posts, ...running];
}

export function emailItems(sends: OutboundSendRow[]): OrganicItem[] {
  return sends
    .filter((s) => s.dispatched_at && (s.status === "acted" || s.status === DISPATCH_FAILED))
    .map((s) => ({
      first_line: firstLine(s.subject),
      url: null,
      published_on: s.dispatched_at!.slice(0, 10),
      metrics: EMAIL_NO_NUMBERS,
      outcome: s.status === "acted" ? "accepted by the email provider, delivery not confirmed" : `not sent: ${firstLine(s.dispatch_error, 80)}`,
      source: "approved single-recipient send",
      as_of: s.dispatched_at,
    }));
}

export function campaignItems(rows: CampaignSendRow[]): OrganicItem[] {
  return rows
    .filter((r) => r.executed_at && (r.exec_status === "executed" || r.exec_status === "failed"))
    .filter((r) => (r.exec_result as { held_for_founder?: unknown } | null)?.held_for_founder !== true)
    .map((r) => {
      const result = (r.exec_result ?? {}) as { receipt?: unknown; error?: unknown };
      const receipt = r.exec_status === "executed" ? safeExecReceipt(result.receipt) : null;
      return {
        first_line: firstLine(r.title),
        url: receipt?.url ?? null,
        published_on: r.executed_at!.slice(0, 10),
        metrics: EMAIL_NO_NUMBERS,
        outcome:
          r.exec_status === "executed"
            ? `${receipt?.line ?? "sent through the email tool"}, delivery not confirmed`
            : `not sent: ${firstLine(typeof result.error === "string" ? result.error : "the email tool refused it", 80)}`,
        source: "approved campaign in the founder's email tool",
        as_of: r.executed_at,
      };
    });
}

function ledgerOutcome(r: LedgerSendRow): string {
  const extra = [
    r.failed > 0 ? `${r.failed} refused` : null,
    r.unknown > 0 ? `${r.unknown} unclear` : null,
    r.hard_bounces > 0 ? `${r.hard_bounces} bounced` : null,
    r.complaints > 0 ? `${r.complaints} marked as spam` : null,
  ].filter(Boolean);
  const tail = extra.length > 0 ? `, ${extra.join(", ")}` : "";
  if (r.status === "failed") return "not sent: the email provider refused every email";
  if (r.status === "held") return `stopped after ${r.sent} of ${r.total}: ${firstLine(r.hold_reason ?? "held", 60)}${tail}`;
  if (r.status === "done") return `sent to ${r.sent} of ${r.total}, ${r.skipped} skipped${tail}, delivery not confirmed`;
  return `sent ${r.sent} of ${r.total} so far, still sending${tail}`;
}

export function ledgerItems(rows: LedgerSendRow[]): OrganicItem[] {
  return rows.map((r) => ({
    first_line: firstLine(r.subject),
    url: null,
    published_on: r.created_at.slice(0, 10),
    metrics: EMAIL_NO_NUMBERS,
    outcome: ledgerOutcome(r),
    source: "Zavi's own bulk send",
    as_of: r.finished_at ?? r.created_at,
  }));
}

const DISPATCH_FAILED = "dispatch_failed";
const CREATOR_ORDER_SCAN = 50;
const EMAIL_RUN_SCAN = 50;

type Read<T> = { data: T[] | null; error: { message: string } | null };

async function readCreatorChannel(db: ReturnType<typeof tenantClient>, lane: "ugc_video"): Promise<Read<OrganicItem>> {
  const orders = (await db
    .from("creator_orders")
    .select("id")
    .eq("package_snapshot->>kind", lane)
    .order("created_at", { ascending: false })
    .limit(CREATOR_ORDER_SCAN)) as Read<{ id: string }>;
  if (orders.error) return { data: null, error: orders.error };
  const ids = (orders.data ?? []).map((o) => o.id);
  if (ids.length === 0) return { data: [], error: null };
  const [pubs, ads] = await Promise.all([
    db
      .from("creator_publications")
      .select("platform, account, post_url, published_at, verification, verified_at, created_at")
      .in("order_id", ids)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(ORGANIC_ITEMS_PER_CHANNEL + 1) as unknown as Promise<Read<PublicationRow>>,
    lane === "ugc_video"
      ? (db
          .from("creator_library_assets")
          .select("meta_ad_id, meta_auto_paused_at, metrics, metrics_read_at, created_at")
          .in("order_id", ids)
          .not("meta_ad_id", "is", null)
          .order("created_at", { ascending: false })
          .limit(ORGANIC_ITEMS_PER_CHANNEL + 1) as unknown as Promise<Read<LibraryAdRow>>)
      : Promise.resolve({ data: [], error: null } as Read<LibraryAdRow>),
  ]);
  const err = pubs.error ?? ads.error;
  if (err) return { data: null, error: err };
  return { data: creatorItems(pubs.data ?? [], ads.data ?? []), error: null };
}

async function readEmailChannel(db: ReturnType<typeof tenantClient>): Promise<Read<OrganicItem>> {
  const [single, campaigns, ledger] = await Promise.all([
    readSingleSends(db),
    optionalRows(
      "campaign",
      db
        .from("channel_actions")
        .select("title, exec_status, executed_at, exec_result")
        .eq("channel_slug", "email_marketing")
        .eq("exec_class", "email_campaign.create_and_send")
        .in("exec_status", ["executed", "failed"])
        .not("executed_at", "is", null)
        .order("executed_at", { ascending: false })
        .limit(ORGANIC_ITEMS_PER_CHANNEL + 1) as unknown as PromiseLike<Read<CampaignSendRow>>,
    ),
    optionalRows(
      "bulk send",
      db
        .from("email_bulk_sends")
        .select("subject, status, total, sent, skipped, failed, unknown, hard_bounces, complaints, hold_reason, created_at, finished_at")
        .order("created_at", { ascending: false })
        .limit(ORGANIC_ITEMS_PER_CHANNEL + 1) as unknown as PromiseLike<Read<LedgerSendRow>>,
    ),
  ]);
  if (single.error) return { data: null, error: single.error };
  return { data: [...(single.data ?? []), ...campaignItems(campaigns), ...ledgerItems(ledger)], error: null };
}

async function optionalRows<T>(what: string, read: PromiseLike<Read<T>>): Promise<T[]> {
  try {
    const r = await read;
    if (!r.error) return r.data ?? [];
    console.warn(`[cgo-evidence] email ${what} read failed, kept the other email evidence: ${r.error.message}`);
  } catch (e) {
    console.warn(`[cgo-evidence] email ${what} read failed, kept the other email evidence: ${e instanceof Error ? e.message : String(e)}`);
  }
  return [];
}

async function readSingleSends(db: ReturnType<typeof tenantClient>): Promise<Read<OrganicItem>> {
  const runs = (await db
    .from("agent_runs")
    .select("id")
    .eq("agent_slug", "email_marketing")
    .order("enqueued_at", { ascending: false })
    .limit(EMAIL_RUN_SCAN)) as Read<{ id: string }>;
  if (runs.error) return { data: null, error: runs.error };
  const runIds = (runs.data ?? []).map((r) => r.id);
  if (runIds.length === 0) return { data: [], error: null };
  const sends = (await db
    .from("decisions")
    .select("status, subject:body->>subject, dispatched_at, dispatch_error")
    .in("agent_run_id", runIds)
    .eq("decision_class", "outbound.send")
    .in("status", ["acted", DISPATCH_FAILED])
    .not("dispatched_at", "is", null)
    .order("dispatched_at", { ascending: false })
    .limit(ORGANIC_ITEMS_PER_CHANNEL + 1)) as Read<OutboundSendRow>;
  if (sends.error) return { data: null, error: sends.error };
  return { data: emailItems(sends.data ?? []), error: null };
}

async function readOrganic(tenant_id: string, slugs: string[], now: Date): Promise<OrganicChannelEvidence[]> {
  const live = slugs.filter((s) => s === "instagram_organic" || s === "tiktok_organic");
  const stored = slugs.filter((s) => s !== "instagram_organic" && s !== "tiktok_organic");
  const [ledger, provider] = await Promise.all([
    readStoredOrganic(tenant_id, stored, now).catch(() => stored.map((slug) => organicChannel(slug, null, "stored evidence unavailable"))),
    Promise.all(live.map(async (slug) => {
      try {
        const { readOwnedOrganicEvidence } = await import("./cgo-channel-readers");
        return await readOwnedOrganicEvidence(tenant_id, slug, now);
      } catch (e) {
        const [fallback] = await readStoredOrganic(tenant_id, [slug], now).catch(() => [organicChannel(slug, null, "stored evidence unavailable")]);
        if (fallback.evidence === "could not read") return { ...fallback, limitation: `Live metrics unavailable (${paidUnread(slug, e).status}); stored evidence also unavailable.` };
        return { ...fallback,
          source: "stored snapshots and publication evidence",
          period: "stored per-post counters; see each item's as_of (not a fresh provider read)",
          limitation: `Live metrics unavailable (${paidUnread(slug, e).status}); using stored snapshots and publication evidence. Snapshot dates remain unchanged; no fresh metrics or business conversion attribution.`,
        };
      }
    })),
  ]);
  return slugs.map((slug) => {
    const ch = [...ledger, ...provider].find((c) => c.channel_slug === slug)!;
    if (slug === "linkedin_organic") return { ...ch, source: "published post ledger and LinkedIn public snapshots", period: "stored per-post counters; see as_of", limitation: "Public reactions/comments/reposts only. LinkedIn private post analytics access is not granted by Zavi's connector; publishing access does not supply impressions or reach." };
    if (slug === "x_organic") return { ...ch, source: "published post ledger and X owned snapshots", period: "stored per-post counters; see as_of (not a 7-day total)" };
    return ch;
  });
}

async function readStoredOrganic(tenant_id: string, slugs: string[], now: Date): Promise<OrganicChannelEvidence[]> {
  const db = tenantClient(asTenantId(tenant_id));
  const socialSlugs = slugs.filter((s) => ORGANIC_MATRIX[s]?.store?.kind === "social_posts");
  const needsTiktok = slugs.some((s) => ORGANIC_MATRIX[s]?.store?.kind === "tiktok");
  const snapshotPlatforms: Record<string, string> = { x_organic: "x", linkedin_organic: "linkedin", instagram_organic: "instagram", tiktok_organic: "tiktok" };
  const since = new Date(now.getTime() - 14 * DAY).toISOString().slice(0, 10);

  const outcomeSlugs = slugs.filter((s) => {
    const k = ORGANIC_MATRIX[s]?.store?.kind;
    return k === "creator_posts" || k === "outbound_email";
  });
  const [postsBySlug, snapshotsBySlug, tiktok, outcomesBySlug, instagramOwner] = await Promise.all([
    Promise.all(
      socialSlugs.map(async (slug) => {
        const st = ORGANIC_MATRIX[slug].store as { kind: "social_posts"; channels: readonly string[] };
        const r = await db
          .from("social_posts")
          .select("channel, account_id, transport, external_post_id, external_url, approved_payload_snapshot, metrics, metrics_read_at, scheduled_at, updated_at")
          .in("channel", [...st.channels])
          .eq("status", "published")
          .order("updated_at", { ascending: false })
          .limit(ORGANIC_ITEMS_PER_CHANNEL + 1);
        return [slug, r] as const;
      }),
    ).then((pairs) => new Map(pairs)),
    Promise.all(slugs.filter((s) => snapshotPlatforms[s]).map(async (slug) => [slug, await db
          .from("social_post_metric_snapshots")
          .select("external_post_id, captured_on, posted_at, text, url, metrics, account_id")
          .eq("channel", snapshotPlatforms[slug])
          .gte("captured_on", since)
          .order("captured_on", { ascending: false })
          .limit(200)] as const)).then((pairs) => new Map(pairs)),
    needsTiktok
      ? db
          .from("tiktok_scheduled_posts")
          .select("content, scheduled_at, external_post_ids")
          .eq("status", "published")
          .order("scheduled_at", { ascending: false })
          .limit(ORGANIC_ITEMS_PER_CHANNEL + 1)
      : null,
    Promise.all(
      outcomeSlugs.map(async (slug) => {
        const st = ORGANIC_MATRIX[slug].store!;
        const r = await (st.kind === "creator_posts" ? readCreatorChannel(db, st.lane) : readEmailChannel(db)).catch(
          (e: Error): Read<OrganicItem> => ({ data: null, error: { message: e.message } }),
        );
        return [slug, r] as const;
      }),
    ).then((pairs) => new Map(pairs)),
    slugs.includes("instagram_organic") ? Promise.all([
      db.from("connector_metadata").select("team_id, connected_at").eq("slug", "composio.instagram").limit(1),
      db.from("social_account_snapshots").select("captured_on, username, account_id, connection_id, created_at")
        .eq("channel", "instagram").gte("captured_on", since).order("captured_on", { ascending: true }),
    ]) : null,
  ]);

  return slugs.map((slug) => {
    const snaps = snapshotsBySlug.get(slug);
    const st = ORGANIC_MATRIX[slug]?.store;
    if (!st || st.kind === "unsupported") return organicChannel(slug, null);
    if (st.kind === "creator_posts" || st.kind === "outbound_email") {
      const r = outcomesBySlug.get(slug);
      if (!r || r.error) return organicChannel(slug, null, r?.error?.message ?? "outcome read skipped");
      return organicChannel(slug, r.data ?? []);
    }
    if (st.kind === "tiktok") {
      if (!tiktok || tiktok.error) return organicChannel(slug, null, tiktok?.error?.message ?? "tiktok read skipped");
      const snapshots = socialItems([], (snaps?.data ?? []) as SnapshotRow[], ["tiktok"], "tiktok");
      const seen = new Set(((snaps?.data ?? []) as SnapshotRow[]).map((s) => s.external_post_id));
      const items = ((tiktok.data ?? []) as TiktokRow[]).filter((t) => !t.external_post_ids?.some((id) => seen.has(id))).map((t) => ({
        first_line: firstLine(t.content?.title ?? t.content?.description),
        url: null,
        published_on: t.scheduled_at.slice(0, 10),
        metrics: "not recorded (TikTok posts keep no per-post numbers here)",
      }));
      const out = organicChannel(slug, [...snapshots, ...items]);
      return snaps?.error ? { ...out, label: `${out.label} (TikTok snapshots ${COULD_NOT_READ})` } : out;
    }
    const posts = postsBySlug.get(slug);
    if (!posts || posts.error) return organicChannel(slug, null, posts?.error?.message ?? "posts read skipped");
    let ledger = (posts.data ?? []) as SocialPostRow[];
    let snapshots = (snaps?.data ?? []) as SnapshotRow[];
    if (slug === "instagram_organic") {
      const [connections, accounts] = instagramOwner!;
      if (connections.error || accounts.error) return organicChannel(slug, null, "Instagram account identity unavailable");
      const connection = (connections.data?.[0] ?? null) as { team_id: string | null; connected_at: string | null } | null;
      snapshots = filterInstagramSnapshots((accounts.data ?? []) as InstagramAccountSnapshot[], snapshots, connection).posts;
      const knownPosts = new Set(snapshots.map((p) => p.external_post_id));
      ledger = ledger.filter((p) => (p.transport === "composio" && !!connection?.team_id && p.account_id === connection.team_id)
        || (!!p.external_post_id && knownPosts.has(p.external_post_id)));
    }
    if (snaps?.error) {
      const items = socialItems(ledger, [], st.channels);
      const out = organicChannel(slug, items);
      return { ...out, label: `${out.label} (${snapshotPlatforms[slug]} post snapshots ${COULD_NOT_READ})` };
    }
    return organicChannel(slug, socialItems(ledger, snapshots, st.channels, snapshotPlatforms[slug] ?? "x"));
  });
}

async function readOwnMoves(tenant_id: string, now: Date, cardClass: string): Promise<string[]> {
  const db = tenantClient(asTenantId(tenant_id));
  const since = new Date(now.getTime() - OWN_MOVES_DAYS * DAY).toISOString();
  const must = <T>(r: { data: unknown; error: { message: string } | null }, what: string): T[] => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return (r.data ?? []) as T[];
  };

  const [cardsR, apActsR, apDecsR] = await Promise.all([
    db
      .from("decisions")
      .select("id, status, emitted_at, body")
      .eq("decision_class", cardClass)
      .eq("body->>dispatched_by", "cgo")
      .gte("emitted_at", since)
      .order("emitted_at", { ascending: false })
      .limit(OWN_MOVES_MAX),
    db
      .from("channel_actions")
      .select("id, run_id, channel_slug, title, status, exec_status, approved_by_source, status_at, proposed_at, exec_class, exec_payload, origin:body->>cgo_order_origin, why:body->step->>body")
      .eq("approved_by_source", "cgo")
      .gte("proposed_at", since)
      .order("proposed_at", { ascending: false })
      .limit(OWN_MOVES_MAX),
    db
      .from("decisions")
      .select("id, agent_run_id, decision_class, status, approved_by_source, approved_at")
      .eq("approved_by_source", "cgo")
      .gte("approved_at", since)
      .order("approved_at", { ascending: false })
      .limit(OWN_MOVES_MAX),
  ]);
  const cards = must<OwnCardRow>(cardsR, "cgo cards");
  const approvedActions = must<LineageActionRow>(apActsR, "cgo-approved cards");
  const approvedDecisions = must<LineageDecisionRow>(apDecsR, "cgo-approved decisions");

  let runs: OwnRunRow[] = [];
  let actions: LineageActionRow[] = [];
  let decisions: LineageDecisionRow[] = [];
  if (cards.length) {
    const runsR = await db
      .from("agent_runs")
      .select("id, status, source_decision_id:payload->>source_decision_id")
      .eq("payload->>dispatched_by", "cgo")
      .in("payload->>source_decision_id", cards.map((c) => c.id))
      .limit(OWN_MOVES_MAX * 2);
    runs = must<OwnRunRow>(runsR, "cgo runs");
  }
  if (runs.length) {
    const ids = runs.map((r) => r.id);
    const [a, d] = await Promise.all([
      db.from("channel_actions").select("id, run_id, channel_slug, title, status, exec_status, approved_by_source, status_at, exec_class, exec_payload").in("run_id", ids).limit(60),
      db.from("decisions").select("id, agent_run_id, decision_class, status, approved_by_source, approved_at").in("agent_run_id", ids).limit(60),
    ]);
    actions = must<LineageActionRow>(a, "cards from cgo runs");
    decisions = must<LineageDecisionRow>(d, "decisions from cgo runs");
  }
  const decIds = [...new Set([...decisions, ...approvedDecisions].map((d) => d.id))];
  const outcomes = decIds.length
    ? must<OutcomeRow>(await db.from("action_outcomes").select("decision_id, reconcile_status, delta_metrics, measured_at").in("decision_id", decIds).limit(60), "outcomes")
    : [];
  return ownMoveLines({ cards, runs, actions, decisions, outcomes, approvedActions, approvedDecisions });
}

const OWED_PAGE = 200;
const OWED_PAGES_MAX = 5;

export async function readFounderOwed(tenant_id: string, now: Date): Promise<{ lines: string[]; more: number }> {
  const db = tenantClient(asTenantId(tenant_id));
  const since = new Date(now.getTime() - OWED_LOOKBACK_DAYS * DAY).toISOString();
  const runs: Array<{ id: string; source_decision_id: string | null }> = [];
  for (let page = 0; page < OWED_PAGES_MAX; page++) {
    const r = await db
      .from("agent_runs")
      .select("id, source_decision_id:payload->>source_decision_id")
      .eq("tenant_id", tenant_id)
      .eq("payload->>dispatched_by", "cgo")
      .gte("enqueued_at", since)
      .order("enqueued_at", { ascending: true })
      .range(page * OWED_PAGE, page * OWED_PAGE + OWED_PAGE - 1);
    if (r.error) throw new Error(`cgo runs: ${r.error.message}`);
    runs.push(...((r.data ?? []) as typeof runs));
    if ((r.data ?? []).length < OWED_PAGE) break;
  }
  if (runs.length === 0) return { lines: [], more: 0 };

  const cardIds = [...new Set(runs.map((r) => r.source_decision_id).filter((x): x is string => !!x))];
  const actions: OwedAction[] = [];
  const intentByCard = new Map<string, string>();
  for (let i = 0; i < runs.length; i += OWED_PAGE) {
    const ids = runs.slice(i, i + OWED_PAGE).map((r) => r.id);
    const a = await db
      .from("channel_actions")
      .select("id, run_id, channel_slug, title, status, status_at, proposed_at, note")
      .eq("tenant_id", tenant_id)
      .in("run_id", ids)
      .is("exec_class", null)
      .in("status", [...OWED_OPEN, ...OWED_CLOSED]);
    if (a.error) throw new Error(`cgo run cards: ${a.error.message}`);
    actions.push(...((a.data ?? []) as OwedAction[]));
  }
  if (actions.length === 0) return { lines: [], more: 0 };
  for (let i = 0; i < cardIds.length; i += OWED_PAGE) {
    const d = await db.from("decisions").select("id, body").eq("tenant_id", tenant_id).in("id", cardIds.slice(i, i + OWED_PAGE));
    if (d.error) throw new Error(`cgo cards: ${d.error.message}`);
    for (const c of (d.data ?? []) as Array<{ id: string; body: Record<string, unknown> | null }>) {
      if (c.body?.dispatched_by === "cgo") intentByCard.set(c.id, String(c.body?.intent ?? ""));
    }
  }
  const intentByRun = new Map<string, string>();
  for (const r of runs) if (r.source_decision_id && intentByCard.has(r.source_decision_id)) intentByRun.set(r.id, intentByCard.get(r.source_decision_id)!);

  const ids = actions.map((a) => a.id);
  const [succ, asked] = await Promise.all([
    db.from("channel_actions").select("repeat_of").eq("tenant_id", tenant_id).in("repeat_of", ids),
    db.from("cgo_questions").select("topic_key, status, asked_at, answered_at, expires_at").eq("tenant_id", tenant_id).in("topic_key", ids.map(owedTopic)),
  ]);
  if (succ.error) throw new Error(`card successors: ${succ.error.message}`);
  if (asked.error) throw new Error(`owed questions: ${asked.error.message}`);
  const successors = new Set(((succ.data ?? []) as Array<{ repeat_of: string | null }>).map((r) => r.repeat_of).filter((x): x is string => !!x));
  const reaskFrom = now.getTime() - REASK_AFTER_DAYS * DAY;
  const askedOn = new Map(
    ((asked.data ?? []) as Array<{ topic_key: string; status: string; asked_at: string; answered_at: string | null; expires_at: string | null }>)
      .filter((q) => q.status === "open" || q.status === "queued" || (q.status === "answered" && Date.parse(q.answered_at ?? q.asked_at) >= reaskFrom))
      .map((q) => [q.topic_key.slice("action:".length), q.asked_at]),
  );
  return founderOwedLines({ actions, intentByRun, successors, askedOn }, now);
}

export const LAUNCH_CLASSES = [
  "meta_ads.duplicate_ad_set",
  "meta_ads.duplicate_campaign",
  "meta_ads.create_ad_set",
  "meta_ads.create_ad",
  "meta_ads.launch_campaign",
  "google_ads.create_campaign",
  "google_ads.create_ad_group",
  "google_ads.create_ad",
] as const;
export const LAUNCH_RESULTS_MAX = 6;
export const LAUNCH_RESULTS_DAYS = 14;
const LAUNCH_LOOKBACK_DAYS = 30;
const LAUNCH_ROWS_MAX = 200;
const LAUNCH_NOTES_MAX = 3;
const STATUS_READ_CAP = 1000;
const ON = new Set(["ACTIVE", "ENABLED"]);

export type LaunchPlatform = "meta" | "google";
export type LaunchRow = {
  id: string;
  exec_class: string;
  title: string;
  by_controller: boolean;
  object_id: string | null;
  live_at: string | null;
};
export type LaunchNumbers = { spend: number; conversions: number; leads: number | null; clicks: number | null } | null | "unread";

export const launchPlatform = (exec_class: string): LaunchPlatform => (exec_class.startsWith("google_ads.") ? "google" : "meta");

export function launchWindow(live_at: string, today: string, zone: string): { days: 3 | 7; since: string; until: string } | null {
  const at = new Date(live_at);
  if (Number.isNaN(at.getTime())) return null;
  const since = shiftDate(dateInZone(at, zone), 1);
  for (const days of [7, 3] as const) {
    const until = shiftDate(since, days - 1);
    if (until < today) return { days, since, until };
  }
  return null;
}

const LAUNCH_VERB: Record<string, string> = {
  "meta_ads.duplicate_ad_set": "copied a Meta ad set as",
  "meta_ads.duplicate_campaign": "copied a Meta campaign as",
  "meta_ads.create_ad_set": "made the Meta ad set",
  "meta_ads.create_ad": "made the Meta ad",
  "meta_ads.launch_campaign": "launched the Meta campaign",
  "google_ads.create_campaign": "made the Google campaign",
  "google_ads.create_ad_group": "made the Google ad group",
  "google_ads.create_ad": "made the Google ad",
};

export function launchResultLine(r: LaunchRow, w: { days: 3 | 7 }, numbers: LaunchNumbers): string {
  const who = r.by_controller ? "Zavi's spend controller" : "Autopilot (your approval)";
  const head = `${shortDate(r.live_at)}: ${who} ${LAUNCH_VERB[r.exec_class] ?? "launched"} "${firstLine(r.title, 70)}"`;
  const label = w.days === 3 ? "first 3 days (provisional: never the only reason to cut)" : "first 7 days";
  if (numbers === "unread") return `${head} -> ${label}: could not read`;
  if (numbers === null) return `${head} -> ${label}: no delivery recorded`;
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  const each = (k: number) => (k > 0 ? ` ($${(numbers.spend / k).toFixed(2)} each)` : "");
  const conv = launchPlatform(r.exec_class) === "google" ? " (every conversion Google counts)" : " (purchases, checkouts, sign-ups)";
  const parts = [`$${numbers.spend.toFixed(2)} spent`, `${n(numbers.conversions, "conversion")}${each(numbers.conversions)}${conv}`];
  if (numbers.leads !== null) parts.push(`${n(numbers.leads, "lead")}${each(numbers.leads)}`);
  if (numbers.clicks !== null) parts.push(n(numbers.clicks, "click"));
  return `${head} -> ${label}: ${parts.join("; ")}`;
}

export type LaunchDeps = {
  zone: (platform: LaunchPlatform) => Promise<string>;
  read: (platform: LaunchPlatform, exec_class: string, object_id: string, since: string, until: string) => Promise<LaunchNumbers>;
};

function launchDeps(tenant_id: string, now: Date): LaunchDeps {
  return {
    zone: async (platform) => {
      const az = await import("./account-zone");
      if (platform === "google") {
        const { gadsCustomerId } = await import("@/services/tools/google-ads/_client");
        return az.googleAccountZone(tenant_id, await gadsCustomerId(tenant_id), now);
      }
      const { metaAdsCreds } = await import("@/services/tools/meta-ads/_client");
      return az.metaAccountZone(tenant_id, (await metaAdsCreds(tenant_id)).ad_account_id, now);
    },
    read: async (platform, exec_class, id, since, until) => {
      if (platform === "google") {
        if (exec_class !== "google_ads.create_campaign") return "unread";
        const { readGoogleSnapshot } = await import("./action-outcomes");
        const snap = await readGoogleSnapshot(tenant_id, id, since, until);
        return snap ? { spend: snap.spend ?? 0, conversions: snap.conversions ?? 0, leads: null, clicks: null } : null;
      }
      const { fbGet, metaActionValue } = await import("@/services/tools/meta-ads/_client");
      const j = (await fbGet(tenant_id, `${id}/insights`, { time_range: JSON.stringify({ since, until }), time_increment: "all_days", fields: "spend,clicks,actions" })) as {
        data?: Array<{ spend?: string; clicks?: string; actions?: Array<{ action_type?: string; value?: string }> }>;
      };
      const row = (j.data ?? [])[0];
      if (!row) return null;
      const a = row.actions;
      const regs = metaActionValue(a, "complete_registration") || metaActionValue(a, "offsite_conversion.fb_pixel_complete_registration");
      return {
        spend: Number(row.spend ?? 0),
        conversions: metaActionValue(a, "purchase") + metaActionValue(a, "initiate_checkout") + regs,
        leads: metaActionValue(a, "lead") || metaActionValue(a, "offsite_conversion.fb_pixel_lead"),
        clicks: Number(row.clicks ?? 0),
      };
    },
  };
}

export async function readOwnLaunchResults(tenant_id: string, now: Date, deps: LaunchDeps = launchDeps(tenant_id, now)): Promise<string[]> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db
    .from("channel_actions")
    .select("id, exec_class, title, executed_at, origin:body->>cgo_order_origin, created_id:exec_result->created->>id, created_status:exec_result->created->>status, ad_set_id:exec_payload->>ad_set_id")
    .eq("approved_by_source", "cgo")
    .in("exec_class", [...LAUNCH_CLASSES])
    .eq("exec_status", "executed")
    .gte("executed_at", new Date(now.getTime() - LAUNCH_LOOKBACK_DAYS * DAY).toISOString())
    .order("executed_at", { ascending: false })
    .limit(LAUNCH_ROWS_MAX);
  if (error) throw new Error(`launches: ${error.message}`);
  type Row = { id: string; exec_class: string; title: string; executed_at: string; origin: string | null; created_id: string | null; created_status: string | null; ad_set_id: string | null };
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return [];
  const copies = rows.filter((r) => r.exec_class.startsWith("meta_ads.duplicate_")).map((r) => r.id);
  const copyIds = new Map<string, string>();
  if (copies.length) {
    const ch = await db
      .from("ad_object_changes")
      .select("action_id, object_id")
      .eq("action_table", "channel_actions")
      .in("action_id", copies)
      .is("before_status", null)
      .eq("change_kind", "status")
      .limit(copies.length * 2);
    if (ch.error) throw new Error(`launch copies: ${ch.error.message}`);
    for (const c of (ch.data ?? []) as Array<{ action_id: string; object_id: string }>) copyIds.set(c.action_id, c.object_id);
  }
  const copyLike = (r: Row) => r.exec_class.startsWith("meta_ads.duplicate_");
  const liveWhenMade = (r: Row) => copyLike(r) || ON.has(r.created_status ?? "");
  const watchOf = (r: Row) => (r.exec_class === "meta_ads.create_ad" ? r.ad_set_id : r.created_id);
  const waiting = rows.filter((r) => !liveWhenMade(r) && !!watchOf(r));
  const statusRows: Array<{ platform: string; object_id: string; after_status: string | null; occurred_at: string }> = [];
  if (waiting.length) {
    const st = await db
      .from("ad_object_changes")
      .select("platform, object_id, after_status, occurred_at")
      .in("platform", ["meta", "google"])
      .eq("change_kind", "status")
      .in("object_id", [...new Set(waiting.map((r) => watchOf(r) as string))])
      .order("occurred_at", { ascending: true })
      .limit(STATUS_READ_CAP);
    if (st.error) throw new Error(`launch switch-ons: ${st.error.message}`);
    const got = (st.data ?? []) as typeof statusRows;
    if (got.length >= STATUS_READ_CAP) throw new Error("launch switch-ons over the read cap");
    statusRows.push(...got);
  }
  const liveAt = (r: Row): string | null => {
    if (liveWhenMade(r)) return r.executed_at;
    const mine = statusRows.filter((x) => x.platform === launchPlatform(r.exec_class) && x.object_id === watchOf(r));
    const before = mine.filter((x) => x.occurred_at <= r.executed_at).at(-1);
    if (r.created_status === "UNVERIFIED" && ON.has(before?.after_status ?? "")) return r.executed_at;
    const on = mine.find((x) => ON.has(x.after_status ?? "") && x.occurred_at >= r.executed_at)?.occurred_at ?? null;
    return on ?? (r.created_status === "UNVERIFIED" ? r.executed_at : null);
  };
  const launches: LaunchRow[] = rows.map((r) => ({
    id: r.id,
    exec_class: r.exec_class,
    title: r.title,
    by_controller: r.origin === "ad_spend_controller",
    object_id: copyLike(r) ? copyIds.get(r.id) ?? null : r.created_id,
    live_at: liveAt(r),
  }));
  const since = now.getTime() - LAUNCH_RESULTS_DAYS * DAY;
  const headOf = (l: LaunchRow, at: string | null) => `${shortDate(at)}: ${l.by_controller ? "Zavi's spend controller" : "Autopilot (your approval)"} ${LAUNCH_VERB[l.exec_class] ?? "launched"} "${firstLine(l.title, 70)}"`;
  const noted: Array<{ l: LaunchRow; at: string; why: string }> = [];
  const readable: LaunchRow[] = [];
  for (const [k, l] of launches.entries()) {
    const r = rows[k]!;
    if (r.exec_class === "google_ads.create_ad_group" || r.exec_class === "google_ads.create_ad") noted.push({ l, at: r.executed_at, why: "no per-object reader for Google ad groups and ads" });
    else if (launchPlatform(r.exec_class) === "google" && r.created_status === "UNVERIFIED") noted.push({ l, at: r.executed_at, why: "its switch-on was not confirmed" });
    else if (l.object_id && l.live_at && Date.parse(l.live_at) >= since) readable.push(l);
  }
  const zones = new Map<LaunchPlatform, string | null>();
  const zoneOf = async (p: LaunchPlatform) => {
    if (!zones.has(p)) zones.set(p, await deps.zone(p).catch(() => null));
    return zones.get(p) ?? null;
  };
  const out: Array<{ at: string; line: string }> = [];
  const zoneless = new Set<LaunchPlatform>();
  let read = 0;
  for (const l of readable.sort((x, y) => (y.live_at as string).localeCompare(x.live_at as string))) {
    if (read >= LAUNCH_RESULTS_MAX) break;
    const platform = launchPlatform(l.exec_class);
    const zone = await zoneOf(platform);
    if (!zone) {
      zoneless.add(platform);
      continue;
    }
    const w = launchWindow(l.live_at as string, dateInZone(now, zone), zone);
    if (!w) continue;
    read += 1;
    const numbers: LaunchNumbers = await deps.read(platform, l.exec_class, l.object_id as string, w.since, w.until).catch(() => "unread" as const);
    out.push({ at: l.live_at as string, line: launchResultLine(l, w, numbers) });
  }
  let notes = 0;
  for (const n of noted) {
    if (notes >= LAUNCH_NOTES_MAX) break;
    if (Date.parse(n.at) < since) continue;
    const zone = await zoneOf(launchPlatform(n.l.exec_class));
    if (zone ? !launchWindow(n.at, dateInZone(now, zone), zone) : now.getTime() - Date.parse(n.at) < 4 * DAY + 3_600_000) continue;
    notes += 1;
    out.push({ at: n.at, line: `${headOf(n.l, n.at)} -> could not read (${n.why})` });
  }
  const lines = out.sort((a, b) => b.at.localeCompare(a.at)).map((o) => o.line);
  for (const p of zoneless) lines.push(`${p === "google" ? "Google" : "Meta"} launches: could not read (the ad account's time zone is unknown)`);
  return lines;
}

const MAX_FOUNDER_AD_CHANGES = 8;

export async function readFounderAdChanges(tenant_id: string, now: Date): Promise<string[]> {
  const { readOutsideChanges, outsideChangeLine } = await import("@/services/decisions/ad-changes");
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  return (await readOutsideChanges(tenant_id, since, MAX_FOUNDER_AD_CHANGES)).map((r) => outsideChangeLine(r));
}

export async function loadCgoEvidence(args: Parameters<typeof loadCgoEvidenceInner>[0]): Promise<CgoEvidence> {
  const { withMetaCaller } = await import("@/services/tools/meta-ads/_cooldown");
  return withMetaCaller("cgo_evidence", () => loadCgoEvidenceInner(args));
}

async function loadCgoEvidenceInner(args: {
  tenant_id: string;
  channelSlugs: readonly string[];
  now: Date;
  cardClass: string;
  goals?: ReadonlyArray<{ id: string; target_metric: unknown; measurement_mode: unknown }>;
}): Promise<CgoEvidence> {
  const slugs = [...new Set(args.channelSlugs)].sort();
  const paidSlugs = slugs.filter((s) => PAID_CHANNELS.has(s));
  const organicSlugs = slugs.filter((s) => !PAID_CHANNELS.has(s));
  const pack = args.goals ? loadDataPack(args.tenant_id, args.goals, args.now, args.cardClass) : null;
  const [paid, organic, own, outside, launches] = await Promise.all([
    readPaid(args.tenant_id, paidSlugs, args.now),
    readOrganic(args.tenant_id, organicSlugs, args.now).catch((e: Error) => organicSlugs.map((s) => organicChannel(s, null, e.message))),
    readOwnMoves(args.tenant_id, args.now, args.cardClass).catch(
      (e: Error) => ({ status: COULD_NOT_READ, reason: e.message.replace(/\s+/g, " ").slice(0, 120) }) as const,
    ),
    readFounderAdChanges(args.tenant_id, args.now).catch(
      (e: Error) => ({ status: COULD_NOT_READ, reason: e.message.replace(/\s+/g, " ").slice(0, 120) }) as const,
    ),
    readOwnLaunchResults(args.tenant_id, args.now).catch(
      (e: Error) => ({ status: COULD_NOT_READ, reason: e.message.replace(/\s+/g, " ").slice(0, 120) }) as const,
    ),
  ]);
  const hasLaunches = !Array.isArray(launches) || launches.length > 0;
  const hasOutside = !Array.isArray(outside) || outside.length > 0;
  const owedR = await readFounderOwed(args.tenant_id, args.now).catch((e: Error) => {
    console.warn(`[cgo-evidence] owed steps unreadable for ${args.tenant_id}: ${e.message}`);
    return { lines: [] as string[], more: 0 };
  });
  const owed = owedR.lines.length > 0 ? { waiting_on_founder: owedR.lines, ...(owedR.more > 0 ? { waiting_on_founder_more: owedR.more } : {}) } : {};
  return { paid, organic, own_moves: own, ...owed, ...(hasOutside ? { founder_ad_changes: outside } : {}), ...(hasLaunches ? { own_launch_results: launches } : {}), ...(pack ? await pack : {}) };
}

async function loadDataPack(
  tenant_id: string,
  goals: ReadonlyArray<{ id: string; target_metric: unknown; measurement_mode: unknown }>,
  now: Date,
  cardClass: string,
): Promise<Pick<CgoEvidence, "outcome" | "traffic" | "search">> {
  const { readOutcome, readTraffic, readSearch } = await import("./cgo-data-pack");
  const fail = (source: string) => (e: Error) => ({
    status: COULD_NOT_READ as typeof COULD_NOT_READ,
    source,
    identity: null,
    window: null,
    as_of: now.toISOString(),
    reason: e.message.replace(/\s+/g, " ").slice(0, 120),
  });
  const [outcome, traffic, search] = await Promise.all([
    goals.length
      ? readOutcome(tenant_id, goals, now, cardClass).catch((e: Error) => ({ goals: [{ goal_id: "*", ...fail("tenant_metric_snapshots")(e) }] }))
      : undefined,
    readTraffic(tenant_id, now).catch(fail("google_analytics")),
    readSearch(tenant_id, now).catch(fail("google_search_console")),
  ]);
  return { ...(outcome ? { outcome } : {}), traffic, search };
}
