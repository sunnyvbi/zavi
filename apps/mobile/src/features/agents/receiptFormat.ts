import { agoText as connectionAgoText } from "../connectors/health";

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function sourceName(slug: string | undefined | null): string | null {
  if (!slug) return null;
  if (SOURCE_NAME[slug]) return SOURCE_NAME[slug];
  const words = slug.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

function parseDay(d: string): { y: number; m: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]) - 1, day: Number(match[3]) };
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

export function formatStamp(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function agoText(iso: string | undefined | null, now: number = Date.now()): string | null {
  return connectionAgoText(iso ?? undefined, now) ?? null;
}
