
import { Bot, Gauge, ListChecks, MessageSquareQuote, Radio, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { ExtraCell, ExtraColumn, ExtraRow, ExtraTableData } from "../actions/ExtraTable";
import type { ChannelChrome } from "../agent/legacyChannelActions";
import { ownerCell } from "../seo/extraTables";
import {
  BOT_CLASS_LABEL,
  admitsPublicPages,
  checklistOf,
  dayLabel,
  isLaneError,
  keepsOutPublicPages,
  pctOf,
  siteFilesOf,
} from "./derive";
import type {
  CrawlerHitsPanel,
  DeltaOr,
  GeoChannelPayload,
  GeoPrompt,
  ReadinessCrawler,
  ReadinessLane,
  VisibilityPanel,
} from "./types";

export const GEO_TABLE_IDS = {
  bands: "geo_bands",
  checks: "geo_checks",
  crawlers: "geo_crawlers",
  hits: "geo_hits",
  prompts: "geo_prompts",
  mentions: "geo_mentions",
  sources: "geo_sources",
} as const;

function sharePct(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "-";
  const pct = rate * 100;
  return pct > 0 && pct < 10 ? `${Number(pct.toFixed(1))}%` : pctOf(rate);
}

const col = (label: string, align?: "left" | "right"): ExtraColumn =>
  align ? { label, align } : { label };

function laneOf<T>(lane: T | { error: true } | undefined | null): T | null {
  if (lane === undefined || lane === null) return null;
  return isLaneError(lane as never) ? null : (lane as T);
}

function readiness(p: GeoChannelPayload | null): ReadinessLane | null {
  const r = laneOf<ReadinessLane | null>(p?.readiness);
  return r && r.status === "ok" ? r : null;
}
function visibility(p: GeoChannelPayload | null): VisibilityPanel | null {
  return laneOf<VisibilityPanel>(p?.visibility);
}
function crawlerHits(p: GeoChannelPayload | null): CrawlerHitsPanel | null {
  return laneOf<CrawlerHitsPanel>(p?.crawler_hits);
}

function bandsTable(r: ReadinessLane): ExtraTableData {
  return {
    id: GEO_TABLE_IDS.bands,
    title: "What the readiness score is made of",
    icon: Gauge,
    columns: [col("Band", "left"), col("Score"), col("Weight")],
    rows: r.score.bands.map<ExtraRow>((b) => ({
      id: b.key,
      cells: [
        { text: b.label, sub: b.note },
        { text: String(b.score), meter: { value: b.score, max: 100, name: `${b.label} score` } },
        { text: `${b.weight}%`, tone: "dim" },
      ],
    })),
    empty: "Nothing has scored this site yet.",
    caption: r.disclosure,
  };
}

function checksTable(r: ReadinessLane | null): ExtraTableData {
  const rows = checklistOf(r).map<ExtraRow>((c) => {
    const status: ExtraCell =
      c.status === "pass"
        ? { text: "Pass", chip: "good" }
        : c.status === "fix"
          ? { text: "Needs work", chip: "warn" }
          : { text: "Not checked", chip: "muted" };
    return { id: c.key, cells: [{ text: c.label, sub: c.detail ?? undefined }, status, ownerCell(c.owner)] };
  });
  const files = siteFilesOf(r).map<ExtraRow>((f) => ({
    id: `file-${f.name}`,
    cells: [
      { text: f.name },
      f.status === "found"
        ? { text: "Found", chip: "good" }
        : f.status === "missing"
          ? { text: "Missing", chip: "warn" }
          : f.status === "unreadable"
            ? { text: "Could not read it", chip: "muted" }
            : { text: "Not checked", chip: "muted" },
      ownerCell("developer"),
    ],
  }));
  return {
    id: GEO_TABLE_IDS.checks,
    title: "What an AI crawler finds",
    icon: ListChecks,
    columns: [col("Check", "left"), col("Result", "left"), col("Who", "left")],
    rows: [...rows, ...files],
    empty: "Nothing has read this site yet.",
  };
}

function crawlerRule(c: ReadinessCrawler): string | null {
  const paths = c.state === "partial" ? (c.disallowed_paths ?? []) : [];
  if (!c.directive && paths.length === 0) return null;
  const lines: string[] = [];
  if (c.directive) lines.push(`The line: ${c.directive}`);
  if (typeof c.from_wildcard === "boolean") {
    lines.push(c.from_wildcard ? "A rule for every bot" : "A rule written for this bot");
  }
  if (paths.length > 0) lines.push(`Blocked paths: ${paths.join(", ")}`);
  if (c.public_blocked?.length) lines.push(`Public pages it keeps out: ${c.public_blocked.join(", ")}`);
  if (keepsOutPublicPages(c)) {
    lines.push(
      "To change it: whoever edits your site removes that Disallow line from /robots.txt. Private areas like /admin can stay blocked.",
    );
  } else if (paths.length > 0) {
    lines.push("No change needed: only private areas are blocked, which is right.");
  }
  return lines.join("\n");
}

function crawlersTable(r: ReadinessLane): ExtraTableData {
  return {
    id: GEO_TABLE_IDS.crawlers,
    title: "AI crawler rules",
    icon: Radio,
    columns: [col("Crawler", "left"), col("robots.txt", "left")],
    rows: r.crawlers.map<ExtraRow>((c) => {
      const rule = crawlerRule(c);
      return {
        id: c.name,
        cells: [
          { text: c.name, sub: c.recommended ? "Worth allowing" : undefined },
          c.state === "allowed"
            ? { text: "Allowed", chip: "good" }
            : c.state === "blocked"
              ? { text: "Blocked", chip: c.recommended ? "bad" : "muted" }
              : c.state === "partial"
                ? admitsPublicPages(c)
                  ? { text: "Allowed", sub: "Private areas blocked", chip: "good" }
                  : { text: "Partly blocked", chip: "warn" }
                : { text: "Could not read it", chip: "muted" },
        ],
        ...(rule
          ? {
              detail: {
                title: "The rule in robots.txt",
                text: rule,
                openLabel: "See the rule",
                closeLabel: "Hide the rule",
              },
            }
          : {}),
      };
    }),
    empty: "robots.txt did not come back, so no rule could be read.",
  };
}

export const SHOW_CRAWLER_HITS: boolean = false;

export function hitsTable(c: CrawlerHitsPanel): ExtraTableData {
  const counted = c.state === "ok" || c.totals.hits > 0;
  const last = c.ingest.last_received_at ? dayLabel(c.ingest.last_received_at.slice(0, 10)) : null;
  const quiet =
    c.state === "ok" && c.totals.hits === 0
      ? `No AI crawler fetched a page in this window.${
          last ? ` Last log arrived ${last}; if that is over a day ago, the feed may have stopped.` : ""
        }`
      : null;
  return {
    id: GEO_TABLE_IDS.hits,
    title: "AI crawler hits",
    icon: Bot,
    columns: [col("Bot", "left"), col("Hits"), col("Blocked"), col("robots.txt", "left")],
    rows: (counted ? c.bots : []).map<ExtraRow>((b) => ({
      id: b.bot,
      cells: [
        { text: b.bot, sub: [b.owner, BOT_CLASS_LABEL[b.class]].filter(Boolean).join(" · ") },
        { text: String(b.hits), strong: b.hits > 0 },
        b.blocked_hits > 0 ? { text: String(b.blocked_hits), tone: "bad" } : { text: "0", tone: "dim" },
        b.robots.state === "allowed"
          ? { text: "Allowed", chip: "good" }
          : b.robots.state === "blocked"
            ? { text: "Blocked", chip: b.recommended ? "bad" : "muted" }
            : b.robots.state === "partial"
              ? { text: "Partly blocked", chip: "warn" }
              : { text: "Not read", chip: "muted" },
      ],
      ...(b.callout ? { detail: { title: "What we noticed", text: b.callout, openLabel: "Why", closeLabel: "Hide" } } : {}),
    })),
    empty:
      c.state === "not_connected"
        ? "Zavi is not receiving your logs yet, so there is nothing to count."
        : c.state === "awaiting_logs"
          ? "Your log feed is connected but no log has arrived yet."
          : (quiet ?? "No AI crawler fetched a page in this window."),
    caption:
      [
        quiet,
        c.state !== "ok" && c.totals.hits > 0
          ? c.state === "not_connected"
            ? "Zavi is not receiving your logs now, so these counts stopped when the feed did."
            : "Your log feed is connected but no new log has arrived yet."
          : null,
        c.disclosure,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

function mentionsTable(v: VisibilityPanel): ExtraTableData {
  const sov = v.metrics?.share_of_voice ?? null;
  const brand = v.config.brand ?? "Your brand";
  const show = sov !== null && sov.state !== "no_mentions";
  const rows: ExtraRow[] = show
    ? [
        {
          id: "__brand__",
          cells: [
            { text: brand },
            { text: "Yours", chip: "good" },
            { text: String(sov!.brand_mentions), strong: true },
            { text: sharePct(sov!.share) },
          ],
        },
        ...sov!.rivals.map<ExtraRow>((r) => ({
          id: r.name,
          cells: [
            { text: r.name },
            { text: "A rival", chip: "warn" },
            { text: String(r.mentions) },
            { text: sharePct(r.share) },
          ],
        })),
      ]
    : [];
  return {
    id: GEO_TABLE_IDS.mentions,
    title: "Who the answers named",
    icon: MessageSquareQuote,
    columns: [col("Name", "left"), col("Whose", "left"), col("Mentions"), col("Share of voice")],
    rows,
    empty:
      sov?.state === "no_rivals"
        ? "No rivals are set to compare against. Add rivals in Settings and mentions will split brand vs rivals."
        : "No sampled answer named your brand or a rival in this window.",
    caption: v.metrics?.disclosure,
  };
}

function sourcesTable(v: VisibilityPanel): ExtraTableData {
  const domains = v.metrics?.source_mix.domains ?? [];
  return {
    id: GEO_TABLE_IDS.sources,
    title: "What the answers cited",
    icon: MessageSquareQuote,
    columns: [col("Domain", "left"), col("Whose", "left"), col("Answers citing it"), col("Citations")],
    rows: domains.map<ExtraRow>((d) => ({
      id: d.domain,
      cells: [
        { text: d.domain },
        d.kind === "owned"
          ? { text: "Yours", chip: "good" }
          : d.kind === "rival"
            ? { text: d.rival ?? "A rival", chip: "warn" }
            : { text: "Someone else", chip: "muted" },
        { text: sharePct(d.used), strong: d.kind === "owned" },
        { text: String(d.citations) },
      ],
    })),
    empty: "No sampled answer cited a source in this window.",
    caption: v.metrics?.disclosure,
  };
}

function promptsTable(
  prompts: GeoPrompt[],
  v: VisibilityPanel | null,
  onChanged?: () => void,
): ExtraTableData {
  const write = async (path: string, method: "POST" | "DELETE", body?: unknown) => {
    const res = await apiFetch(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const parsed = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(parsed.error?.message ?? "That did not save. Try again.");
    }
    onChanged?.();
  };
  const rows = prompts.map<ExtraRow>((p) => {
    const suggested = p.status === "suggested";
    return {
      id: p.id,
      cells: [
        { text: p.prompt_text, sub: p.rationale ?? undefined },
        suggested
          ? { text: "Waiting for you", chip: "warn" }
          : { text: "Tracked", chip: "good" },
      ],
      actions: [
        ...(suggested
          ? [
              {
                label: "Track it",
                busyLabel: "Saving…",
                retryLabel: "Try again",
                onClick: () => write("/api/geo/prompts/accept", "POST", { ids: [p.id] }),
              },
            ]
          : []),
        {
          label: suggested ? "Decline" : "Remove",
          busyLabel: suggested ? "Declining…" : "Removing…",
          retryLabel: "Try again",
          onClick: () => write(`/api/geo/prompts/${encodeURIComponent(p.id)}`, "DELETE"),
        },
      ],
    };
  });
  return {
    id: GEO_TABLE_IDS.prompts,
    title: "Questions Zavi asks the AI engines",
    icon: Sparkles,
    columns: [col("Prompt", "left"), col("Status", "left")],
    actionsLabel: "Track or stop tracking this prompt",
    rows,
    empty:
      v?.config.configured === false
        ? "Zavi's AI-answer sampler is not set up on our side yet, so there is nothing to ask the engines. Nothing here needs you."
        : v != null && !v.config.brand
          ? "Add your company name in Settings and Zavi can choose the questions to track."
          : v != null
            ? "Zavi has not chosen any questions yet. It picks a starter set on its next read of this page."
            : "Zavi has not chosen any questions yet.",
    caption:
      v && typeof v.config.prompts_active === "number"
        ? `${v.config.prompts_active} tracked. Every rate above is measured against this set.`
        : undefined,
  };
}

export function geoTables(payload: unknown, onChanged?: () => void): ExtraTableData[] {
  const p = (payload ?? null) as GeoChannelPayload | null;
  if (!p || typeof p !== "object") return [];
  const r = readiness(p);
  const v = visibility(p);
  const c = crawlerHits(p);
  const out: ExtraTableData[] = [];
  if (r) out.push(bandsTable(r));
  if (r) out.push(checksTable(r));
  if (r && r.crawlers.length > 0) out.push(crawlersTable(r));
  if (c && SHOW_CRAWLER_HITS) out.push(hitsTable(c));
  if (v?.metrics) out.push(mentionsTable(v));
  if (v?.metrics) out.push(sourcesTable(v));
  if (p.prompts) out.push(promptsTable([...p.prompts.active, ...p.prompts.suggested], v, onChanged));
  return out;
}

function row(key: string, value: number | null, unit = "count", prev: number | null = null): ChannelMetric | null {
  if (value === null || !Number.isFinite(value)) return null;
  return {
    key,
    value,
    unit,
    window_kind: null,
    day: "",
    grounded: true,
    prev_value: prev,
    prev_day: null,
  };
}

export function geoKpis(payload: unknown): ChannelMetric[] {
  const p = (payload ?? null) as GeoChannelPayload | null;
  if (!p || typeof p !== "object") return [];
  const r = readiness(p);
  const v = visibility(p);
  const c = crawlerHits(p);
  const m = v?.metrics ?? null;
  const rate = (value: number | null | undefined, d: DeltaOr | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    const now = Math.round(value * 1000) / 10;
    const real = d && !("unavailable" in d) && d.significant ? d.delta_pp : null;
    const prev = real === null ? null : Math.round((now - real) * 10) / 10;
    return { now, prev };
  };
  const mention = rate(m?.mention_rate.rate, v?.deltas.mention_rate);
  const citation = rate(m?.citation_rate.rate, v?.deltas.citation_rate);
  const checks = r ? checklistOf(r).filter((c) => c.status !== "not_checked") : [];
  const out = [
    row("geo_score", r ? r.score.total : null),
    checks.length > 0 ? row("geo_checks", checks.filter((c) => c.status === "pass").length) : null,
    mention ? row("geo_mention_rate", mention.now, "pct", mention.prev) : null,
    citation ? row("geo_citation_rate", citation.now, "pct", citation.prev) : null,
    row("geo_crawlers", r ? r.crawlers.filter(admitsPublicPages).length : null),
    row("geo_hits", SHOW_CRAWLER_HITS && c && c.state === "ok" ? c.totals.hits : null),
    row("geo_prompts", v ? v.config.prompts_active : null),
  ];
  return out.filter((x): x is ChannelMetric => x !== null);
}

export function geoChrome(payload: unknown): ChannelChrome | null {
  const p = (payload ?? null) as GeoChannelPayload | null;
  if (!p || typeof p !== "object") return null;
  const r = readiness(p);
  const v = visibility(p);
  const lane = laneOf<ReadinessLane | null>(p.readiness);
  if (!("readiness" in p) && !("visibility" in p) && !("crawler_hits" in p)) return null;
  return {
    connected: true,
    ranges: [
      { id: "7d", label: "Last 7 days", days: 7 },
      { id: "30d", label: "Last 30 days", days: 30 },
      { id: "90d", label: "Last 90 days", days: 90 },
    ],
    period: null,
    account:
      r && r.site
        ? {
            name: r.site.replace(/^https?:\/\//, "").replace(/\/$/, ""),
            sub: `${r.pages_analyzed} ${r.pages_analyzed === 1 ? "page" : "pages"} read`,
          }
        : null,
    problem: (() => {
      const lines = [
        lane === null || !r
          ? "Zavi could not read your site just now, so the readiness numbers are missing. The rest of this page is unaffected."
          : null,
        v?.state === "no_data_in_window"
          ? `No AI answers were checked in the last ${v.window_days} days, so Mentioned and Cited are not shown. Pick a longer range, or press Check AI answers.`
          : null,
      ].filter((x): x is string => x !== null);
      return lines.length > 0 ? { text: lines.join(" "), reconnect: false } : null;
    })(),
    plan: null,
  };
}
