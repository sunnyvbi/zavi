import { findIdentifiers, scrubPublicText } from "./scrub";
import { CHANNELS } from "@zavi/shared";
import { channelLabel } from "./labels";
import { distinctHeadline, plainHeadline } from "./headline";

export type DayKind = "PLAN" | "CHANGE" | "WIN" | "LOSS" | "HUMAN" | "NOT_AVAILABLE" | "WORK";
export const DAY_KINDS: readonly DayKind[] = ["PLAN", "CHANGE", "WIN", "LOSS", "HUMAN", "NOT_AVAILABLE", "WORK"];

export type Entry = {
  day: string;
  kind: DayKind;
  headline: string;
  channels: string[];
  work: string[];
  why: string | null;
  budget: { channel: string; from_usd: number | null; to_usd: number | null }[];
  spent_usd: number | null;
  bookings: number | null;
  hosts: number | null;
};

export type DraftInputs = {
  day: string;
  isFirstDay: boolean;
  budgetChanges: { channel_slug: string; from_usd: number | null; to_usd: number | null; rationale: string | null }[];
  changedLines: string[];
  results: { spent_usd: number | null; bookings: number | null; hosts: number | null; booking_value_usd?: number | null };
  pace?: { bookings_per_week: number | null; hosts_per_week: number | null; booking_value_per_week?: number | null } | null;
  campaignNames: string[];
  priorWhys?: string[];
  moveReasons?: { channel_slug: string; reason: string }[];
  priorHeadlines?: string[];
};

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const clean = (s: string, names: string[]): string | null => {
  const out = scrubPublicText(s, { campaignNames: names });
  return out && findIdentifiers(out).length === 0 ? out : null;
};
const firstSentence = (s: string) => (s.match(/^[^.!?]*[.!?]/)?.[0] ?? s).trim();
const REASONED_LINE = /^(Rejected|Approved|Sent) /;
const PRIVATE_LINE = /^Goal\b/;
const whyKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function budgetHeadline(c: DraftInputs["budgetChanges"][number]): string {
  const ch = channelLabel(c.channel_slug);
  if (c.from_usd == null || c.from_usd === 0) return c.to_usd != null ? `Started a new ${ch} budget: ${usd(c.to_usd)}/day.` : `Started a new ${ch} budget.`;
  if (c.to_usd === 0) return `Stopped a ${ch} budget of ${usd(c.from_usd)}/day.`;
  if (c.to_usd == null) return `Changed a ${ch} budget.`;
  const verb = c.to_usd > c.from_usd ? "Raised" : "Cut";
  return `${verb} ${ch} budget: ${usd(c.from_usd)} → ${usd(c.to_usd)}/day.`;
}

function quietDay(i: DraftInputs): { headline: string; work: string[] } | null {
  const p = i.pace;
  if (!p) return null;
  const metrics = [
    { label: "Bookings", today: i.results.bookings, week: p.bookings_per_week },
    { label: "Booking value", today: i.results.booking_value_usd ?? null, week: p.booking_value_per_week ?? null },
    { label: "New hosts", today: i.results.hosts, week: p.hosts_per_week },
  ].flatMap((m) => (m.today != null && m.week != null && m.week > 0 ? [{ label: m.label, ratio: m.today / (m.week / 7) }] : []));
  if (metrics.length === 0) return null;
  const vs = (r: number) =>
    r >= 2 ? `${(Math.round(r * 10) / 10).toString()}× a usual day`
    : r >= 1.15 ? `${Math.round((r - 1) * 100)}% above a usual day`
    : r <= 0.85 ? `${Math.round((1 - r) * 100)}% below a usual day`
    : "about a usual day";
  const lead = [...metrics].sort((a, b) => Math.abs(Math.log(b.ratio || 1e-9)) - Math.abs(Math.log(a.ratio || 1e-9)))[0];
  const head = vs(lead.ratio) === "about a usual day" ? `${lead.label} held at about a usual day.` : `${lead.label} ran ${vs(lead.ratio)}.`;
  return { headline: `${head} Moved no money.`, work: metrics.map((m) => `${m.label}: ${vs(m.ratio)}.`) };
}

export function buildDayDraft(i: DraftInputs): { full: Entry; neutral: Entry } {
  const names = i.campaignNames;
  const lines = i.changedLines.filter((l) => !PRIVATE_LINE.test(l.trim())).map((l) => clean(l, names)).filter((x): x is string => !!x);
  let work = lines.slice(0, 6);
  const budget = i.budgetChanges.map((c) => ({ channel: channelLabel(c.channel_slug), from_usd: c.from_usd, to_usd: c.to_usd }));
  const channels = [...new Set(i.budgetChanges.map((c) => channelLabel(c.channel_slug)))];
  const used = new Set((i.priorWhys ?? []).map(whyKey).filter(Boolean));
  const fresh = (w: string | null) => (w && !used.has(whyKey(w)) ? w : null);

  let kind: DayKind;
  let headline: string;
  let why: string | null = null;
  if (i.budgetChanges.length > 0) {
    kind = i.isFirstDay ? "PLAN" : "CHANGE";
    headline = i.budgetChanges.length === 1 ? budgetHeadline(i.budgetChanges[0]) : `Changed ${i.budgetChanges.length} budgets across ${channels.join(" and ")}.`;
    why = i.budgetChanges.map((c) => fresh(c.rationale ? clean(c.rationale, names) : null)).find((x) => !!x) ?? null;
  } else if (lines.length > 0) {
    kind = i.isFirstDay ? "PLAN" : "WORK";
    const reasonOf = (l: string) => {
      if (!REASONED_LINE.test(l)) return null;
      const h = firstSentence(l);
      return fresh(l.slice(l.indexOf(h) + h.length).trim() || null);
    };
    const startedReason = (l: string) => {
      const label = l.match(/^Started ([^:]+):/)?.[1]?.trim().toLowerCase();
      if (!label) return null;
      const startedName = (slug: string) => (CHANNELS.find((c) => c.slug === slug)?.name ?? slug).toLowerCase();
      const m = (i.moveReasons ?? []).find((r) => startedName(r.channel_slug) === label);
      return m ? fresh(clean(m.reason, names)) : null;
    };
    const lead = lines.find((l) => reasonOf(l)) ?? lines[0];
    if (!work.includes(lead)) work = [...work.slice(0, 5), lead];
    headline = firstSentence(lead);
    why = reasonOf(lead) ?? startedReason(lead);
  } else {
    kind = "WORK";
    const q = quietDay(i);
    headline = q?.headline ?? "Watched the numbers. Moved no money.";
    work = q?.work ?? [];
  }

  headline = plainHeadline(headline) || "Watched the numbers. Moved no money.";
  headline = distinctHeadline(headline, i.priorHeadlines ?? [], { work, channels, spent_usd: i.results.spent_usd, bookings: i.results.bookings });
  const full: Entry = {
    day: i.day, kind, headline, channels, work, why, budget,
    spent_usd: i.results.spent_usd, bookings: i.results.bookings, hosts: i.results.hosts,
  };
  const neutralHeadline =
    i.budgetChanges.length === 0 ? "Reviewed the numbers. Moved no money."
    : i.budgetChanges.length === 1 ? `Changed a ${channelLabel(i.budgetChanges[0].channel_slug)} budget.`
    : `Changed ${i.budgetChanges.length} budgets across ${channels.join(" and ")}.`;
  const neutral: Entry = {
    day: i.day,
    kind: kind === "PLAN" ? "PLAN" : "WORK",
    headline: neutralHeadline,
    channels,
    work: [],
    why: null,
    budget: budget.map((b) => ({ channel: b.channel, from_usd: null, to_usd: null })),
    spent_usd: null, bookings: null, hosts: null,
  };
  return { full, neutral };
}
