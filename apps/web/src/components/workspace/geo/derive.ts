
import type { IssueOwner } from "../seo/issueCopy";
import type {
  BotClass,
  CrawlerDay,
  CrawlerHitsPanel,
  DeltaOr,
  Lane,
  LaneError,
  ReadinessCrawler,
  ReadinessLane,
  SourceDomain,
  VisibilityHistoryRow,
  VisibilityMetrics,
} from "./types";

export function isLaneError<T>(lane: Lane<T>): lane is LaneError {
  return (
    typeof lane === "object" &&
    lane !== null &&
    (lane as { error?: unknown }).error === true
  );
}

export function pctOf(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "-";
  return `${Math.round(rate * 100)}%`;
}

export function pts(n: number): string {
  const v = Number(Math.abs(n).toFixed(1));
  return `${v} ${v === 1 ? "pt" : "pts"}`;
}

export type DeltaView = {
  text: string;
  tone: "up" | "down" | "flat" | "note";
  title: string;
};

const UNAVAILABLE_COPY: Record<string, DeltaView | null> = {
  no_previous_window: null,
  prompt_set_changed: {
    text: "New prompts",
    tone: "note",
    title: "The tracked prompts changed, so this window is not compared with the last one.",
  },
  rival_set_changed: {
    text: "New rivals",
    tone: "note",
    title: "The rival list changed, so share of voice starts a new baseline.",
  },
};

export function deltaView(d: DeltaOr | null | undefined): DeltaView | null {
  if (!d) return null;
  if ("unavailable" in d) return UNAVAILABLE_COPY[d.unavailable] ?? null;
  const sign = d.delta_pp > 0 ? "+" : d.delta_pp < 0 ? "−" : "";
  if (!d.significant) {
    return {
      text: `${sign}${pts(d.delta_pp)}`,
      tone: "flat",
      title: "Within the noise at 95%. Treat this as no real change.",
    };
  }
  return d.delta_pp > 0
    ? { text: `▲ ${pts(d.delta_pp)}`, tone: "up", title: "Up versus the previous window, outside the noise at 95%." }
    : { text: `▼ ${pts(d.delta_pp)}`, tone: "down", title: "Down versus the previous window, outside the noise at 95%." };
}

export const CRAWLER_VIEWS = [7, 14, 30] as const;
export type CrawlerView = (typeof CRAWLER_VIEWS)[number];

export function fetchWindowFor(view: CrawlerView): 30 | 90 {
  return view * 2 <= 30 ? 30 : 90;
}

export type CrawlerSeries = {
  days: CrawlerDay[];
  total: number;
  change: { kind: "pct"; pct: number } | { kind: "new" } | null;
};

const sumHits = (days: readonly CrawlerDay[]): number =>
  days.reduce((n, d) => n + d.hits, 0);

export function crawlerSeries(
  panel: CrawlerHitsPanel,
  view: CrawlerView,
): CrawlerSeries | null {
  const daily = panel.daily;
  if (daily.length < view) return null;
  const days = daily.slice(-view);
  const total = sumHits(days);

  let change: CrawlerSeries["change"] = null;
  if (daily.length >= view * 2) {
    const prev = daily.slice(-view * 2, -view);
    const since = panel.ingest.created_at?.slice(0, 10) ?? null;
    if (since !== null && prev.length > 0 && since <= prev[0].day) {
      const before = sumHits(prev);
      if (before > 0) {
        change = { kind: "pct", pct: Math.round(((total - before) / before) * 100) };
      } else if (total > 0) {
        change = { kind: "new" };
      }
    }
  }
  return { days, total, change };
}

export const BOT_CLASS_ORDER: readonly BotClass[] = ["search", "user", "training"];

export const BOT_CLASS_LABEL: Record<BotClass, string> = {
  search: "Search bots",
  user: "User fetches",
  training: "Training bots",
};

export function blockedBots(
  panel: CrawlerHitsPanel,
): Array<{ bot: string; reason: "robots" | "turned_away" }> {
  return panel.bots
    .filter((b) => b.robots.state === "blocked" || b.blocked_hits > 0)
    .map((b) => ({
      bot: b.bot,
      reason: b.robots.state === "blocked" ? ("robots" as const) : ("turned_away" as const),
    }));
}

export function dayOfMonth(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : String(d.getUTCDate());
}

export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export type CheckStatus = "pass" | "fix" | "not_checked";

export type CheckKey =
  | "crawlers"
  | "server_rendered"
  | "lead_passage"
  | "question_headings"
  | "figures"
  | "schema"
  | "author"
  | "dates"
  | "fresh";

export type CheckRow = {
  key: CheckKey;
  label: string;
  owner: IssueOwner;
  status: CheckStatus;
  detail: string | null;
};

const PAGE_CHECKS: ReadonlyArray<{ key: CheckKey; code: string; label: string; owner: IssueOwner }> = [
  { key: "server_rendered", code: "geo_not_server_rendered", label: "Readable without JavaScript", owner: "developer" },
  { key: "lead_passage", code: "no_lead_passage", label: "Answer near the top", owner: "founder" },
  { key: "question_headings", code: "headings_not_questions", label: "Question-style headings", owner: "founder" },
  { key: "figures", code: "no_specific_figures", label: "Specific figures", owner: "founder" },
  { key: "schema", code: "no_schema_server_rendered", label: "Structured data (Schema.org)", owner: "developer" },
  { key: "author", code: "no_author_signal", label: "Named author", owner: "founder" },
  { key: "dates", code: "no_visible_dates", label: "Visible dates", owner: "founder" },
  { key: "fresh", code: "content_stale", label: "Updated in the last 6 months", owner: "founder" },
];

export function checklistOf(r: ReadinessLane | null): CheckRow[] {
  const finding = (code: string) =>
    r?.findings.find((f) => f.code === code)?.summary ?? null;
  const measured = r !== null && r.status === "ok";

  const gate = r?.crawlers.filter((c) => c.recommended) ?? [];
  const robotsRead = gate.some((c) => c.state !== "unknown");
  const blocked = [finding("ai_crawler_blocked"), finding("ai_crawler_partly_blocked")].filter(
    (x): x is string => x !== null,
  );
  const rows: CheckRow[] = [
    {
      key: "crawlers",
      label: "AI search bots allowed",
      owner: "developer",
      status: !measured || !robotsRead ? "not_checked" : blocked.length > 0 ? "fix" : "pass",
      detail: blocked.length > 0 ? blocked.join(" ") : null,
    },
  ];

  const pagesRead = measured && r.pages_analyzed > 0;
  for (const c of PAGE_CHECKS) {
    const detail = finding(c.code);
    rows.push({
      key: c.key,
      label: c.label,
      owner: c.owner,
      status: !pagesRead ? "not_checked" : detail ? "fix" : "pass",
      detail,
    });
  }
  return rows;
}

export const PRIVATE_PATH =
  /^\/(admin|wp-admin|login|signin|account|cart|checkout|api|search|private|dashboard|auth)\b/i;

export function keepsOutPublicPages(c: ReadinessCrawler): boolean {
  if (c.state === "blocked") return true;
  if (c.state !== "partial") return false;
  if (c.public_blocked) return c.public_blocked.length > 0;
  return (c.disallowed_paths ?? []).some((d) => !PRIVATE_PATH.test(d));
}

export const admitsPublicPages = (c: ReadinessCrawler): boolean =>
  c.state === "allowed" || (c.state === "partial" && !keepsOutPublicPages(c));

export type SiteFileRow = {
  name: "robots.txt" | "llms.txt";
  status: "found" | "missing" | "unreadable" | "not_checked";
};

export function siteFilesOf(r: ReadinessLane | null): SiteFileRow[] {
  if (!r || r.status !== "ok") {
    return [
      { name: "robots.txt", status: "not_checked" },
      { name: "llms.txt", status: "not_checked" },
    ];
  }
  const robots: SiteFileRow["status"] =
    r.crawlers.length === 0
      ? "not_checked"
      : r.crawlers.some((c) => c.state !== "unknown")
        ? "found"
        : "unreadable";
  const llms: SiteFileRow["status"] =
    r.llms_txt === null ? "not_checked" : r.llms_txt ? "found" : "missing";
  return [
    { name: "robots.txt", status: robots },
    { name: "llms.txt", status: llms },
  ];
}

export type SourceGroup = {
  kind: SourceDomain["kind"];
  label: string;
  citations: number;
  share: number;
  domains: number;
};

const GROUP_LABEL: Record<SourceDomain["kind"], string> = {
  owned: "Your site",
  rival: "Rivals",
  other: "Third-party sites",
};

export function sourceGroupsOf(m: VisibilityMetrics): {
  groups: SourceGroup[];
  total: number;
  partial: boolean;
} {
  const kinds: SourceDomain["kind"][] = ["owned", "rival", "other"];
  const total = m.source_mix.domains.reduce((n, d) => n + d.citations, 0);
  const groups = kinds.map((kind) => {
    const list = m.source_mix.domains.filter((d) => d.kind === kind);
    const citations = list.reduce((n, d) => n + d.citations, 0);
    return {
      kind,
      label: GROUP_LABEL[kind],
      citations,
      share: total > 0 ? Math.round((citations / total) * 100) : 0,
      domains: list.length,
    };
  });
  return {
    groups,
    total,
    partial: m.source_mix.domains_total > m.source_mix.domains.length,
  };
}

export type ProgressKey = "mention_rate" | "citation_rate" | "share_of_voice";

export type ProgressRow = {
  key: ProgressKey;
  label: string;
  points: number[];
  from: number | null;
  to: number | null;
  change: number | null;
  trimmed: boolean;
};

const PROGRESS_LABEL: Record<ProgressKey, string> = {
  mention_rate: "Mention rate",
  citation_rate: "Citation rate",
  share_of_voice: "Share of voice",
};

export function progressRowsOf(history: readonly VisibilityHistoryRow[]): ProgressRow[] {
  const keys: ProgressKey[] = ["mention_rate", "citation_rate", "share_of_voice"];
  return keys.map((key) => {
    let start = 0;
    history.forEach((h, i) => {
      if (h.prompt_set_changed || (key === "share_of_voice" && h.rival_set_changed)) start = i;
    });
    const points = history
      .slice(start)
      .map((h) => h[key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      .map((v) => Math.round(v * 100));
    const from = points.length > 0 ? points[0] : null;
    const to = points.length > 0 ? points[points.length - 1] : null;
    return {
      key,
      label: PROGRESS_LABEL[key],
      points,
      from,
      to,
      change: points.length >= 2 && from !== null && to !== null ? to - from : null,
      trimmed: start > 0,
    };
  });
}
