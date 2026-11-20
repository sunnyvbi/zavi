import type { ChannelMetric } from "./channelPage";
import { col, colLeft, type ChannelTable, type TableCell, type TableRow } from "./channelTables";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" ? (v as Rec) : null);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function laneOf(lane: unknown): Rec | null {
  const l = rec(lane);
  return l && l.error !== true ? l : null;
}

type CheckStatus = "pass" | "fix" | "not_checked";
export type GeoCheck = { key: string; label: string; owner: "founder" | "developer"; status: CheckStatus; detail: string | null };

const PAGE_CHECKS: ReadonlyArray<{ key: string; code: string; label: string; owner: "founder" | "developer" }> = [
  { key: "server_rendered", code: "geo_not_server_rendered", label: "Readable without JavaScript", owner: "developer" },
  { key: "lead_passage", code: "no_lead_passage", label: "Answer near the top", owner: "founder" },
  { key: "question_headings", code: "headings_not_questions", label: "Question-style headings", owner: "founder" },
  { key: "figures", code: "no_specific_figures", label: "Specific figures", owner: "founder" },
  { key: "schema", code: "no_schema_server_rendered", label: "Structured data (Schema.org)", owner: "developer" },
  { key: "author", code: "no_author_signal", label: "Named author", owner: "founder" },
  { key: "dates", code: "no_visible_dates", label: "Visible dates", owner: "founder" },
  { key: "fresh", code: "content_stale", label: "Updated in the last 6 months", owner: "founder" },
];

export function geoChecklist(readiness: Rec | null): GeoCheck[] {
  const measured = readiness !== null && readiness.status === "ok";
  const findings = arr(readiness?.findings);
  const finding = (code: string) => str(findings.find((f) => f.code === code)?.summary);
  const gate = arr(readiness?.crawlers).filter((c) => c.recommended);
  const robotsRead = gate.some((c) => c.state !== "unknown");
  const blocked = [finding("ai_crawler_blocked"), finding("ai_crawler_partly_blocked")].filter((x): x is string => x !== null);
  const rows: GeoCheck[] = [
    {
      key: "crawlers",
      label: "AI search bots allowed",
      owner: "developer",
      status: !measured || !robotsRead ? "not_checked" : blocked.length > 0 ? "fix" : "pass",
      detail: blocked.length > 0 ? blocked.join(" ") : null,
    },
  ];
  const pagesRead = measured && (num(readiness?.pages_analyzed) ?? 0) > 0;
  for (const c of PAGE_CHECKS) {
    const detail = finding(c.code);
    rows.push({ key: c.key, label: c.label, owner: c.owner, status: !pagesRead ? "not_checked" : detail ? "fix" : "pass", detail });
  }
  return rows;
}

export function geoChecks(readiness: Rec | null): { checked: number; passed: number } {
  const rows = geoChecklist(readiness).filter((c) => c.status !== "not_checked");
  return { checked: rows.length, passed: rows.filter((c) => c.status === "pass").length };
}

function row(key: string, value: number | null, unit = "count", prev: number | null = null): ChannelMetric | null {
  if (value === null) return null;
  return { key, value, unit, grounded: true, prev_value: prev, day: "" };
}

function rate(value: unknown, d: unknown): { now: number; prev: number | null } | null {
  const v = num(value);
  if (v === null) return null;
  const now = Math.round(v * 1000) / 10;
  const delta = rec(d);
  const real = delta && !("unavailable" in delta) && delta.significant ? num(delta.delta_pp) : null;
  return { now, prev: real === null ? null : Math.round((now - real) * 10) / 10 };
}

export function geoKpis(payload: unknown): ChannelMetric[] {
  const p = rec(payload);
  if (!p) return [];
  const rl = laneOf(p.readiness);
  const r = rl && rl.status === "ok" ? rl : null;
  const v = laneOf(p.visibility);
  const c = laneOf(p.crawler_hits);
  const m = rec(v?.metrics);
  const deltas = rec(v?.deltas);
  const mention = rate(rec(m?.mention_rate)?.rate, deltas?.mention_rate);
  const citation = rate(rec(m?.citation_rate)?.rate, deltas?.citation_rate);
  const checks = geoChecks(r);
  const out = [
    row("geo_score", num(rec(r?.score)?.total)),
    checks.checked > 0 ? row("geo_checks", checks.passed) : null,
    mention ? row("geo_mention_rate", mention.now, "pct", mention.prev) : null,
    citation ? row("geo_citation_rate", citation.now, "pct", citation.prev) : null,
    row("geo_crawlers", r ? arr(r.crawlers).filter(admitsPublicPages).length : null),
    row("geo_hits", c && c.state === "ok" ? num(rec(c.totals)?.hits) : null),
    row("geo_prompts", v ? num(rec(v.config)?.prompts_active) : null),
  ];
  return out.filter((x): x is ChannelMetric => x !== null);
}

const pctOf = (rate: unknown): string => {
  const n = num(rate);
  return n === null ? "—" : `${Math.round(n * 100)}%`;
};
const dayLabel = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};
const ownerCell = (owner: "founder" | "developer"): TableCell => (owner === "founder" ? { text: "You", chip: "good" } : { text: "Developer", chip: "muted" });

const PRIVATE_PATH = /^\/(admin|wp-admin|login|signin|account|cart|checkout|api|search|private|dashboard|auth)\b/i;

function keepsOutPublicPages(c: Rec): boolean {
  if (c.state === "blocked") return true;
  if (c.state !== "partial") return false;
  if (Array.isArray(c.public_blocked)) return c.public_blocked.length > 0;
  return (Array.isArray(c.disallowed_paths) ? (c.disallowed_paths as unknown[]) : []).some((d) => typeof d === "string" && !PRIVATE_PATH.test(d));
}
const admitsPublicPages = (c: Rec): boolean => c.state === "allowed" || (c.state === "partial" && !keepsOutPublicPages(c));
const BOT_CLASS_LABEL: Record<string, string> = { search: "Search bots", user: "User fetches", training: "Training bots" };

function crawlerRule(c: Rec): string | null {
  const paths = c.state === "partial" && Array.isArray(c.disallowed_paths) ? (c.disallowed_paths as string[]) : [];
  const directive = str(c.directive);
  if (!directive && paths.length === 0) return null;
  const lines: string[] = [];
  if (directive) lines.push(`The line: ${directive}`);
  if (typeof c.from_wildcard === "boolean") lines.push(c.from_wildcard ? "A rule for every bot" : "A rule written for this bot");
  if (paths.length > 0) lines.push(`Blocked paths: ${paths.join(", ")}`);
  if (Array.isArray(c.public_blocked) && c.public_blocked.length > 0) lines.push(`Public pages it keeps out: ${(c.public_blocked as string[]).join(", ")}`);
  if (keepsOutPublicPages(c)) lines.push("To change it: whoever edits your site removes that Disallow line from /robots.txt. Private areas like /admin can stay blocked.");
  else if (paths.length > 0) lines.push("No change needed: only private areas are blocked, which is right.");
  return lines.join("\n");
}

function robotsCell(state: unknown, recommended: boolean, unread: string): TableCell {
  return state === "allowed"
    ? { text: "Allowed", chip: "good" }
    : state === "blocked"
      ? { text: "Blocked", chip: recommended ? "bad" : "muted" }
      : state === "partial"
        ? { text: "Partly blocked", chip: "warn" }
        : { text: unread, chip: "muted" };
}

function bandsTable(r: Rec): ChannelTable {
  return {
    id: "geo_bands",
    title: "What the readiness score is made of",
    icon: "chartColumn",
    columns: [colLeft("Band", 160), col("Score", 76), col("Weight", 64)],
    rows: arr(rec(r.score)?.bands).map((b) => ({
      id: String(b.key),
      cells: [
        { text: String(b.label), ...(str(b.note) ? { sub: str(b.note) as string } : {}) },
        { text: String(b.score), meter: { value: num(b.score) ?? 0, max: 100 } },
        { text: `${b.weight}%`, dim: true },
      ],
    })),
    empty: "Nothing has scored this site yet.",
    caption: str(r.disclosure),
  };
}

function checksTable(r: Rec | null): ChannelTable {
  const rows: TableRow[] = geoChecklist(r).map((c) => ({
    id: c.key,
    cells: [
      { text: c.label, ...(c.detail ? { sub: c.detail } : {}) },
      c.status === "pass" ? { text: "Pass", chip: "good" } : c.status === "fix" ? { text: "Needs work", chip: "warn" } : { text: "Not checked", chip: "muted" },
      ownerCell(c.owner),
    ],
  }));
  const measured = r !== null && r.status === "ok";
  const crawlers = arr(r?.crawlers);
  const files: Array<[string, string]> = [
    ["robots.txt", !measured || crawlers.length === 0 ? "not_checked" : crawlers.some((c) => c.state !== "unknown") ? "found" : "unreadable"],
    ["llms.txt", !measured || r?.llms_txt === null || r?.llms_txt === undefined ? "not_checked" : r.llms_txt ? "found" : "missing"],
  ];
  for (const [name, status] of files) {
    rows.push({
      id: `file-${name}`,
      cells: [
        { text: name },
        status === "found" ? { text: "Found", chip: "good" } : status === "missing" ? { text: "Missing", chip: "warn" } : status === "unreadable" ? { text: "Could not read it", chip: "muted" } : { text: "Not checked", chip: "muted" },
        ownerCell("developer"),
      ],
    });
  }
  return {
    id: "geo_checks",
    title: "What an AI crawler finds",
    icon: "check",
    columns: [colLeft("Check", 250), colLeft("Result", 90), colLeft("Who", 82)],
    rows,
    empty: "Nothing has read this site yet.",
  };
}

function crawlersTable(r: Rec): ChannelTable {
  return {
    id: "geo_crawlers",
    title: "AI crawler rules",
    icon: "bot",
    columns: [colLeft("Crawler", 170), colLeft("robots.txt", 108)],
    rows: arr(r.crawlers).map((c) => {
      const rule = crawlerRule(c);
      return {
        id: String(c.name),
        cells: [{ text: String(c.name), ...(c.recommended ? { sub: "Worth allowing" } : {}) }, c.state === "partial" && admitsPublicPages(c) ? { text: "Allowed", sub: "Private areas blocked", chip: "good" } : robotsCell(c.state, c.recommended === true, "Could not read it")],
        ...(rule ? { detail: { title: "The rule in robots.txt", text: rule, openLabel: "See the rule", closeLabel: "Hide the rule" } } : {}),
      };
    }),
    empty: "robots.txt did not come back, so no rule could be read.",
  };
}

function hitsTable(c: Rec): ChannelTable {
  const totals = rec(c.totals);
  const hits = num(totals?.hits) ?? 0;
  const counted = c.state === "ok" || hits > 0;
  const ingest = rec(c.ingest);
  const lastAt = str(ingest?.last_received_at);
  const last = lastAt ? dayLabel(lastAt.slice(0, 10)) : null;
  const quiet = c.state === "ok" && hits === 0 ? `No AI crawler fetched a page in this window.${last ? ` Last log arrived ${last}; if that is over a day ago, the feed may have stopped.` : ""}` : null;
  const caption = [
    quiet,
    c.state !== "ok" && hits > 0
      ? c.state === "not_connected"
        ? "Zavi is not receiving your logs now, so these counts stopped when the feed did."
        : "Your log feed is connected but no new log has arrived yet."
      : null,
    str(c.disclosure),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    id: "geo_hits",
    title: "AI crawler hits",
    icon: "bot",
    columns: [colLeft("Bot", 170), col("Hits", 52), col("Blocked", 68), colLeft("robots.txt", 104)],
    rows: (counted ? arr(c.bots) : []).map((b) => {
      const robots = rec(b.robots);
      const blockedHits = num(b.blocked_hits) ?? 0;
      return {
        id: String(b.bot),
        cells: [
          { text: String(b.bot), sub: [str(b.owner), BOT_CLASS_LABEL[String(b.class)]].filter(Boolean).join(" · ") },
          { text: String(num(b.hits) ?? 0), strong: (num(b.hits) ?? 0) > 0 },
          blockedHits > 0 ? { text: String(blockedHits), bad: true } : { text: "0", dim: true },
          robotsCell(robots?.state, b.recommended === true, "Not read"),
        ],
        ...(str(b.callout) ? { detail: { title: "What we noticed", text: str(b.callout) as string, openLabel: "Why", closeLabel: "Hide" } } : {}),
      };
    }),
    empty:
      c.state === "not_connected"
        ? "Zavi is not receiving your logs yet, so there is nothing to count."
        : c.state === "awaiting_logs"
          ? "Your log feed is connected but no log has arrived yet."
          : quiet ?? "No AI crawler fetched a page in this window.",
    caption: caption || null,
  };
}

function mentionsTable(v: Rec): ChannelTable {
  const m = rec(v.metrics);
  const sov = rec(m?.share_of_voice);
  const brand = str(rec(v.config)?.brand) ?? "Your brand";
  const show = sov !== null && sov.state !== "no_mentions";
  const rows: TableRow[] = show
    ? [
        { id: "__brand__", cells: [{ text: brand }, { text: "Yours", chip: "good" }, { text: String(num(sov?.brand_mentions) ?? 0), strong: true }, { text: sov?.share === null ? "—" : pctOf(sov?.share) }] },
        ...arr(sov?.rivals).map((r) => ({
          id: String(r.name),
          cells: [{ text: String(r.name) }, { text: "A rival", chip: "warn" as const }, { text: String(num(r.mentions) ?? 0) }, { text: r.share === null ? "—" : pctOf(r.share) }],
        })),
      ]
    : [];
  return {
    id: "geo_mentions",
    title: "Who the answers named",
    icon: "messages",
    columns: [colLeft("Name", 90), colLeft("Whose", 72), col("Mentions", 70), col("Share of voice", 70)],
    rows,
    empty:
      sov?.state === "no_rivals"
        ? "No rivals are set to compare against. Add rivals in Settings and mentions will split brand vs rivals."
        : "No sampled answer named your brand or a rival in this window.",
    caption: str(m?.disclosure),
  };
}

function sourcesTable(v: Rec): ChannelTable {
  const m = rec(v.metrics);
  return {
    id: "geo_sources",
    title: "What the answers cited",
    icon: "messages",
    columns: [colLeft("Domain", 140), colLeft("Whose", 92), col("Answers citing it", 82), col("Citations", 76)],
    rows: arr(rec(m?.source_mix)?.domains).map((d) => ({
      id: String(d.domain),
      cells: [
        { text: String(d.domain) },
        d.kind === "owned" ? { text: "Yours", chip: "good" } : d.kind === "rival" ? { text: str(d.rival) ?? "A rival", chip: "warn" } : { text: "Someone else", chip: "muted" },
        { text: pctOf(d.used), strong: d.kind === "owned" },
        { text: String(num(d.citations) ?? 0) },
      ],
    })),
    empty: "No sampled answer cited a source in this window.",
    caption: str(m?.disclosure),
  };
}

function promptsTable(prompts: Rec[], v: Rec | null): ChannelTable {
  const config = rec(v?.config);
  const rows: TableRow[] = prompts.map((p) => {
    const suggested = p.status === "suggested";
    const id = String(p.id);
    return {
      id,
      cells: [{ text: String(p.prompt_text), ...(str(p.rationale) ? { sub: str(p.rationale) as string } : {}) }, suggested ? { text: "Waiting for you", chip: "warn" } : { text: "Tracked", chip: "good" }],
      actions: [
        ...(suggested
          ? [{ id: `accept-${id}`, label: "Track it", busyLabel: "Saving…", call: { method: "POST" as const, path: "/api/geo/prompts/accept", body: { ids: [id] } } }]
          : []),
        { id: `remove-${id}`, label: suggested ? "Decline" : "Remove", busyLabel: suggested ? "Declining…" : "Removing…", call: { method: "DELETE" as const, path: `/api/geo/prompts/${encodeURIComponent(id)}` } },
      ],
    };
  });
  const active = num(config?.prompts_active);
  return {
    id: "geo_prompts",
    title: "Questions Zavi asks the AI engines",
    icon: "sparkles",
    columns: [colLeft("Prompt", 200), colLeft("Status", 108)],
    rows,
    empty:
      config?.configured === false
        ? "Zavi's AI-answer sampler is not set up on our side yet, so there is nothing to ask the engines. Nothing here needs you."
        : v !== null && !config?.brand
          ? "Add your company name in Settings and Zavi can choose the questions to track."
          : v !== null
            ? "Zavi has not chosen any questions yet. It picks a starter set on its next read of this page."
            : "Zavi has not chosen any questions yet.",
    caption: active === null ? null : `${active} tracked. Every rate above is measured against this set.`,
  };
}

export function geoTables(payload: unknown): ChannelTable[] {
  const p = rec(payload);
  if (!p) return [];
  const rl = laneOf(p.readiness);
  const r = rl && rl.status === "ok" ? rl : null;
  const v = laneOf(p.visibility);
  const c = laneOf(p.crawler_hits);
  const out: ChannelTable[] = [];
  if (r) out.push(bandsTable(r), checksTable(r));
  if (r && arr(r.crawlers).length > 0) out.push(crawlersTable(r));
  if (c) out.push(hitsTable(c));
  if (rec(v?.metrics) && v) out.push(mentionsTable(v), sourcesTable(v));
  const prompts = rec(p.prompts);
  if (prompts) out.push(promptsTable([...arr(prompts.active), ...arr(prompts.suggested)], v));
  return out;
}
