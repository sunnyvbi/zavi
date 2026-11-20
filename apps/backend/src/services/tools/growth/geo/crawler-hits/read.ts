
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { AI_BOTS, botByName, type BotClass } from "../bots";
import { ingestTokenStatus, type IngestTokenStatus } from "./ingest";
import { readRobotsHistory } from "./robots-history";

export const CRAWLER_HITS_DISCLOSURE =
  "Counted from the logs you send us. A hit proves a named AI bot fetched a page; it does not prove any answer cited it. User-Agents can be spoofed, so these are requests claiming to be each bot.";

export const CRAWLER_WINDOWS = [7, 30, 90] as const;

export const BLOCKED_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

type DailyRow = {
  day: string;
  bot: string;
  path: string;
  status: number;
  hits: number;
  first_seen_at: string;
  last_seen_at: string;
};

export type CrawlerBotSummary = {
  bot: string;
  owner: string;
  class: BotClass;
  recommended: boolean;
  hits: number;
  blocked_hits: number;
  server_error_hits: number;
  pages: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  robots: {
    state: "allowed" | "blocked" | "partial" | null;
    directive: string | null;
    changed_at: string | null;
    previous_state: string | null;
  };
  hits_since_robots_change: number | null;
  callout: string | null;
};

export type CrawlerHitsPanel = {
  tier: 3;
  provenance: "server_logs";
  disclosure: string;
  state: "not_connected" | "awaiting_logs" | "ok";
  window_days: number;
  ingest: IngestTokenStatus;
  totals: { hits: number; blocked_hits: number; by_class: Record<BotClass, number> };
  bots: CrawlerBotSummary[];
  daily: Array<{ day: string; hits: number; blocked_hits: number; by_class: Record<BotClass, number> }>;
  top_pages: Array<{ path: string; hits: number; bots: number; last_seen_at: string }>;
};

const DAY_MS = 86_400_000;
const ms = (iso: string): number => Date.parse(iso);
const zeroClasses = (): Record<BotClass, number> => ({ training: 0, search: 0, user: 0 });

function daysAgo(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS));
}

async function readRows(tenantId: string, sinceDay: string, bot?: string, untilDay?: string): Promise<DailyRow[]> {
  let q = tenantClient(asTenantId(tenantId))
    .from("geo_crawler_hits_daily")
    .select("day, bot, path, status, hits, first_seen_at, last_seen_at")
    .gte("day", sinceDay);
  if (untilDay) q = q.lte("day", untilDay);
  if (bot) q = q.eq("bot", bot);
  const { data, error } = await q.limit(50_000);
  if (error) throw new Error(`geo crawler hits read failed: ${error.message}`);
  return (data ?? []) as DailyRow[];
}

export function summarizeCrawlerHits(input: {
  rows: readonly DailyRow[];
  robots: ReadonlyMap<string, { current: { state: string; directive: string | null; observed_at: string }; previous: { state: string } | null }>;
  ingest: IngestTokenStatus;
  windowDays: number;
  now: number;
  end?: number;
}): CrawlerHitsPanel {
  const { rows, robots, ingest, windowDays, now } = input;
  const end = input.end ?? now;

  const bots: CrawlerBotSummary[] = AI_BOTS.filter((b) => b.ua !== null).map((b) => {
    const mine = rows.filter((r) => r.bot === b.name);
    const hist = robots.get(b.name) ?? null;
    const changedAt = hist?.previous ? hist.current.observed_at : null;
    const since = changedAt
      ? mine.filter((r) => ms(r.last_seen_at) >= ms(changedAt)).reduce((n, r) => n + r.hits, 0)
      : null;
    const first = mine.reduce<string | null>((m, r) => (m === null || ms(r.first_seen_at) < ms(m) ? r.first_seen_at : m), null);
    const last = mine.reduce<string | null>((m, r) => (m === null || ms(r.last_seen_at) > ms(m) ? r.last_seen_at : m), null);
    const hits = mine.reduce((n, r) => n + r.hits, 0);
    const blocked = mine.filter((r) => BLOCKED_STATUSES.has(r.status)).reduce((n, r) => n + r.hits, 0);

    let callout: string | null = null;
    if (ingest.connected && b.recommended) {
      if (changedAt && hist?.current.state !== "blocked" && since === 0) {
        callout = `${b.name}: 0 hits since we saw robots.txt change ${daysAgo(changedAt, now)} days ago. Still blocked somewhere (a CDN or firewall rule), or not yet re-crawled.`;
      } else if (hits > 0 && blocked === hits) {
        callout = `${b.name}: every request in this window was turned away (401/403/429). robots.txt is not the block — a CDN, firewall or auth rule is.`;
      }
    }

    return {
      bot: b.name,
      owner: b.owner,
      class: b.class,
      recommended: b.recommended,
      hits,
      blocked_hits: blocked,
      server_error_hits: mine.filter((r) => r.status >= 500).reduce((n, r) => n + r.hits, 0),
      pages: new Set(mine.map((r) => r.path)).size,
      first_seen_at: first,
      last_seen_at: last,
      robots: {
        state: (hist?.current.state as CrawlerBotSummary["robots"]["state"]) ?? null,
        directive: hist?.current.directive ?? null,
        changed_at: changedAt,
        previous_state: hist?.previous?.state ?? null,
      },
      hits_since_robots_change: since,
      callout,
    };
  });
  bots.sort((a, b) => Number(b.recommended) - Number(a.recommended) || b.hits - a.hits);

  const totals = { hits: 0, blocked_hits: 0, by_class: zeroClasses() };
  const dailyMap = new Map<string, CrawlerHitsPanel["daily"][number]>();
  for (let i = windowDays - 1; i >= 0; i--) {
    const day = new Date(end - i * DAY_MS).toISOString().slice(0, 10);
    dailyMap.set(day, { day, hits: 0, blocked_hits: 0, by_class: zeroClasses() });
  }
  const pageMap = new Map<string, { hits: number; bots: Set<string>; last: string }>();
  for (const r of rows) {
    const cls = botByName(r.bot)?.class;
    const blocked = BLOCKED_STATUSES.has(r.status) ? r.hits : 0;
    totals.hits += r.hits;
    totals.blocked_hits += blocked;
    if (cls) totals.by_class[cls] += r.hits;
    const d = dailyMap.get(r.day);
    if (d) {
      d.hits += r.hits;
      d.blocked_hits += blocked;
      if (cls) d.by_class[cls] += r.hits;
    }
    const p = pageMap.get(r.path) ?? { hits: 0, bots: new Set<string>(), last: r.last_seen_at };
    p.hits += r.hits;
    p.bots.add(r.bot);
    if (ms(r.last_seen_at) > ms(p.last)) p.last = r.last_seen_at;
    pageMap.set(r.path, p);
  }

  return {
    tier: 3,
    provenance: "server_logs",
    disclosure: CRAWLER_HITS_DISCLOSURE,
    state: !ingest.connected ? "not_connected" : ingest.last_received_at === null ? "awaiting_logs" : "ok",
    window_days: windowDays,
    ingest,
    totals,
    bots,
    daily: [...dailyMap.values()],
    top_pages: [...pageMap.entries()]
      .map(([path, p]) => ({ path, hits: p.hits, bots: p.bots.size, last_seen_at: p.last }))
      .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path))
      .slice(0, 20),
  };
}

function windowOf(days: number | null | undefined): number {
  return CRAWLER_WINDOWS.find((d) => d === days) ?? 30;
}

export async function getCrawlerHits(tenantId: string, q: { days?: number | null; range?: { since: string; until: string } | null }): Promise<CrawlerHitsPanel> {
  const now = Date.now();
  const end = q.range ? Math.min(Date.parse(`${q.range.until}T00:00:00Z`), now) : now;
  const windowDays = q.range ? Math.max(1, Math.round((end - Date.parse(`${q.range.since}T00:00:00Z`)) / DAY_MS) + 1) : windowOf(q.days);
  const sinceDay = q.range ? q.range.since : new Date(now - (windowDays - 1) * DAY_MS).toISOString().slice(0, 10);
  const [rows, robots, ingest] = await Promise.all([
    readRows(tenantId, sinceDay, undefined, q.range ? q.range.until : undefined),
    readRobotsHistory(tenantId),
    ingestTokenStatus(tenantId),
  ]);
  return summarizeCrawlerHits({ rows, robots, ingest, windowDays, now, end });
}

export async function getCrawlerBotDetail(
  tenantId: string,
  botName: string,
  q: { days?: number | null },
): Promise<{
  bot: string;
  window_days: number;
  pages: Array<{ path: string; hits: number; blocked_hits: number; statuses: Record<string, number>; last_seen_at: string }>;
  daily: Array<{ day: string; hits: number; blocked_hits: number }>;
} | null> {
  const bot = botByName(botName);
  if (!bot || bot.ua === null) return null;
  const windowDays = windowOf(q.days);
  const now = Date.now();
  const sinceDay = new Date(now - (windowDays - 1) * DAY_MS).toISOString().slice(0, 10);
  const rows = await readRows(tenantId, sinceDay, bot.name);

  const pages = new Map<string, { hits: number; blocked_hits: number; statuses: Record<string, number>; last: string }>();
  const daily = new Map<string, { hits: number; blocked_hits: number }>();
  for (let i = windowDays - 1; i >= 0; i--) {
    daily.set(new Date(now - i * DAY_MS).toISOString().slice(0, 10), { hits: 0, blocked_hits: 0 });
  }
  for (const r of rows) {
    const blocked = BLOCKED_STATUSES.has(r.status) ? r.hits : 0;
    const p = pages.get(r.path) ?? { hits: 0, blocked_hits: 0, statuses: {}, last: r.last_seen_at };
    p.hits += r.hits;
    p.blocked_hits += blocked;
    p.statuses[String(r.status)] = (p.statuses[String(r.status)] ?? 0) + r.hits;
    if (ms(r.last_seen_at) > ms(p.last)) p.last = r.last_seen_at;
    pages.set(r.path, p);
    const d = daily.get(r.day);
    if (d) {
      d.hits += r.hits;
      d.blocked_hits += blocked;
    }
  }
  return {
    bot: bot.name,
    window_days: windowDays,
    pages: [...pages.entries()]
      .map(([path, p]) => ({ path, hits: p.hits, blocked_hits: p.blocked_hits, statuses: p.statuses, last_seen_at: p.last }))
      .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path))
      .slice(0, 200),
    daily: [...daily.entries()].map(([day, d]) => ({ day, ...d })),
  };
}
