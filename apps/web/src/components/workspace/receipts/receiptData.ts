
import type { BlockReceipt } from "@zavi/shared";

export type ReceiptKind = "catalog" | "compute" | "exploratory" | "pulled" | "worked_out" | "reported";

export type ReceiptData = {
  kind: ReceiptKind;
  figure?: string;
  label?: string;
  sourceSlug?: string;
  source?: string;
  metricId?: string;
  definition?: string;
  window?: { since: string; until: string };
  tz?: string;
  currency?: string | null;
  fetchedAt?: string;
  params?: Array<[string, string]>;
  formula?: string;
  caveats?: string[];
  purpose?: string;
  sql?: string[];
  verified?: false;
};

const SOURCE_NAME: Record<string, string> = {
  stripe: "Stripe",
  stripe_mrr: "Stripe",
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  linkedin_ads: "LinkedIn Ads",
  google_analytics: "Google Analytics",
  ga4: "Google Analytics",
  google_search_console: "Search Console",
  search_console: "Search Console",
  gsc: "Search Console",
  operator_db: "Your database",
  posthog: "PostHog",
  derived: "Worked out from two metrics",
  compute: "Worked out by Zavi",
  metric: "Metric catalog",
  founder_reported: "From you",
};

export function sourceName(slug: string | undefined | null): string | null {
  if (!slug) return null;
  if (SOURCE_NAME[slug]) return SOURCE_NAME[slug];
  const words = slug.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

export function logoSlug(slug: string | undefined | null): string | null {
  if (!slug) return null;
  if (slug === "stripe_mrr") return "stripe";
  if (slug === "ga4") return "google_analytics";
  if (slug === "gsc" || slug === "search_console") return "google_search_console";
  return slug;
}

export function receiptSource(r: ReceiptData): string {
  return r.source ?? sourceName(r.sourceSlug) ?? "Zavi";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDay(d: string): { y: number; m: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) - 1, day: Number(m[3]) };
}

export function formatWindow(w: { since: string; until: string } | undefined | null): string | null {
  if (!w) return null;
  const a = parseDay(w.since);
  const b = parseDay(w.until);
  if (!a || !b) return null;
  if (a.y !== b.y) return `${MONTHS[a.m]} ${a.day}, ${a.y} - ${MONTHS[b.m]} ${b.day}, ${b.y}`;
  if (a.m === b.m && a.day === b.day) return `${MONTHS[a.m]} ${a.day}`;
  if (a.m === b.m) return `${MONTHS[a.m]} ${a.day}-${b.day}`;
  return `${MONTHS[a.m]} ${a.day} - ${MONTHS[b.m]} ${b.day}`;
}

export function agoText(iso: string | undefined | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const ms = now.getTime() - t;
  if (ms < -60_000) return null;
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

export function formatStamp(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function chipLabel(r: ReceiptData, now: Date = new Date()): string {
  if (r.kind === "worked_out") return "Worked out";
  const parts = [receiptSource(r).replace(/\s*\(call \d+\)$/, "")];
  const w = formatWindow(r.window);
  if (w) parts.push(w);
  const ago = agoText(r.fetchedAt, now);
  if (ago) parts.push(ago);
  return parts.join(" · ");
}

export function isNeutralMetric(idOrLabel: string | undefined | null): boolean {
  if (!idOrLabel) return false;
  return /(^|[_\s-])(ad_)?spend($|[_\s-])|ad spend|ads spend|spend_total|ad_spend/i.test(idOrLabel);
}

export function fromBlockReceipt(rc: BlockReceipt, extra: Partial<ReceiptData> = {}): ReceiptData {
  return {
    kind: rc.source === "compute" ? "compute" : "catalog",
    sourceSlug: rc.source,
    metricId: rc.metric_id,
    definition: rc.definition,
    window: rc.window,
    tz: rc.tz,
    currency: rc.currency,
    fetchedAt: rc.fetched_at,
    formula: rc.formula,
    caveats: rc.caveats,
    ...extra,
  };
}

export type FigureReceiptMeta = ReceiptData & { figure: string };

const KINDS = new Set<ReceiptKind>(["catalog", "compute", "exploratory", "pulled", "worked_out", "reported"]);
const s = (v: unknown, max = 400): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);

export function parseFigureReceipts(raw: unknown): FigureReceiptMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: FigureReceiptMeta[] = [];
  for (const x of raw.slice(0, 40)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const figure = s(o.figure, 40);
    const kind = o.kind as ReceiptKind;
    if (!figure || !KINDS.has(kind)) continue;
    const w = o.window as { since?: unknown; until?: unknown } | undefined;
    out.push({
      figure,
      kind,
      source: s(o.source, 120) === s(o.source_slug, 40) ? undefined : s(o.source, 120),
      sourceSlug: s(o.source_slug, 40),
      metricId: s(o.metric_id, 60),
      label: s(o.label, 120),
      definition: s(o.definition),
      window: w && typeof w.since === "string" && typeof w.until === "string" ? { since: w.since, until: w.until } : undefined,
      tz: s(o.tz, 64),
      currency: typeof o.currency === "string" ? o.currency : o.currency === null ? null : undefined,
      fetchedAt: s(o.fetched_at, 40),
      params: Array.isArray(o.params)
        ? (o.params as unknown[])
            .filter((p): p is [string, string] => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string")
            .slice(0, 12)
        : undefined,
      formula: s(o.formula),
      caveats: Array.isArray(o.caveats) ? (o.caveats as unknown[]).filter((c): c is string => typeof c === "string").slice(0, 6) : undefined,
      purpose: s(o.purpose, 300),
      sql: Array.isArray(o.sql) ? (o.sql as unknown[]).filter((q): q is string => typeof q === "string").slice(0, 5) : undefined,
      ...(o.verified === false ? { verified: false as const } : {}),
    });
  }
  return out;
}

export function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

export function figureKey(raw: string): string | null {
  const d = digitsOf(raw);
  if (d.length === 0) return null;
  const marked = /[$%.,\p{Sc}]/u.test(raw);
  if (!marked && d.length <= 2) return `#${d}`;
  const unit = raw.includes("%") ? "%" : (raw.match(/\p{Sc}/u)?.[0] ?? "");
  if (d.length === 1 && !unit) return null;
  const m = raw.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  const value = m ? Number(m[0]) : NaN;
  if (!Number.isFinite(value)) return null;
  const sign = /^\s*[-−]/.test(raw) ? "-" : "";
  return unit === "%" ? `${sign}${value}%` : `${unit}${sign}${value}`;
}

const MONTH_BEFORE = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i;
const MONTH_AFTER = /^\s(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;

export function isBareCount(text: string, at: number, raw: string): boolean {
  const before = text.slice(Math.max(0, at - 12), at);
  const after = text.slice(at + raw.length, at + raw.length + 12);
  if (MONTH_BEFORE.test(before.trimEnd()) && /\s$/.test(before)) return false;
  if (MONTH_AFTER.test(after)) return false;
  if (/^\s?(?:st|nd|rd|th)\b/i.test(after)) return false;
  if (/^\s?[ap]\.?m\b\.?/i.test(after)) return false;
  if (/\b(?:id|no|number|ticket|order|campaign)\s*[:#]?\s*$/i.test(before)) return false;
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  if (/^\s*$/.test(text.slice(lineStart, at)) && /^[.)]/.test(after)) return false;
  return true;
}

export type TrendTone = "green" | "amber" | "red";

const TREND_LEAD = /^\s*\*\*(green|amber|red)\*\*\s*(?:[:.,]|\s-\s|\s)\s*/i;
const MAX_PILL_CHARS = 72;
const TONE_FALLBACK: Record<TrendTone, string> = {
  green: "Trending up",
  amber: "Holding flat",
  red: "Needs attention",
};

export function parseTrendLead(text: string): { tone: TrendTone; pill: string; body: string } | null {
  const m = TREND_LEAD.exec(text);
  if (!m) return null;
  const tone = m[1].toLowerCase() as TrendTone;
  const rest = text.slice(m[0].length);
  const end = /[.!?](?=\s|$)|\n/.exec(rest);
  const first = (end ? rest.slice(0, end.index) : rest).trim();
  if (first && first.length <= MAX_PILL_CHARS && !/\*\*|\[|`/.test(first)) {
    const body = rest.slice(end ? end.index + (rest[end.index] === "\n" ? 0 : 1) : rest.length).replace(/^\s+/, "");
    return { tone, pill: first.charAt(0).toUpperCase() + first.slice(1), body };
  }
  return { tone, pill: TONE_FALLBACK[tone], body: rest };
}
