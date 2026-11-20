
import { Bot, Gauge, ListChecks, SearchCheck, Timer } from "lucide-react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { ExtraCell, ExtraColumn, ExtraRow, ExtraTableData } from "../actions/ExtraTable";
import type { ChannelHealth, HealthCount } from "../metrics/HealthSummary";
import {
  BAND_WORD,
  CORE_WEB_VITALS,
  VITAL_ORDER,
  VITAL_THRESHOLDS,
  categoryScore100,
  fmtBytes,
  fmtMetricSaving,
  fmtVital,
  humanizeId,
  humanizeReason,
  positive,
  scoreBand,
  shortUrl,
  vitalBand,
  type Band,
} from "./format";
import type { IssueOwner } from "./issueCopy";
import type {
  CruxMetricKey,
  LabPage,
  SeoChannelPayload,
  SeoFinding,
  SeoGeoLane,
  SeoPageFact,
  SeoSiteHealth,
} from "./types";

export const SEO_TABLE_IDS = {
  vitals: "seo_vitals",
  opportunities: "seo_opportunities",
  google: "seo_google",
  ai: "seo_ai",
  pages: "seo_pages",
} as const;

function bandCell(text: string, band: "pass" | "warn" | "fail"): ExtraCell {
  if (band === "fail") return { text, tone: "bad" };
  if (band === "warn") return { text };
  return { text, tone: "dim" };
}

const col = (label: string, align?: "left" | "right"): ExtraColumn =>
  align ? { label, align } : { label };

function asPayload(payload: unknown): SeoChannelPayload | null {
  const p = (payload ?? null) as SeoChannelPayload | null;
  if (!p || typeof p !== "object" || p.generic) return null;
  return p;
}

function crawlOf(p: SeoChannelPayload): SeoSiteHealth | null {
  return p.site_health && p.site_health.status === "ok" ? p.site_health : null;
}

function firstLabPage(p: SeoChannelPayload): LabPage | null {
  const lab = p.performance?.lab;
  if (!lab || lab.state !== "ok") return null;
  return (Array.isArray(lab.pages) ? lab.pages : [])[0] ?? null;
}

function categoryOf(page: LabPage | null, id: string): number | null {
  const c = (page?.categories ?? []).find((x) => x.id === id);
  return categoryScore100(c?.score);
}

function geoOf(p: SeoChannelPayload): SeoGeoLane | null {
  const g = p.geo;
  return g && g.status === "ok" && typeof g.score?.total === "number" ? g : null;
}

function crawlMissing(p: SeoChannelPayload): string {
  const sh = p.site_health;
  if (sh && sh.status === "error") {
    return `Couldn't read your site${sh.error_code ? ` (${humanizeReason(sh.error_code)?.toLowerCase()})` : ""}. Press Refresh to try again.`;
  }
  return "Not read yet. Press Refresh to read your site now.";
}

function labMissing(p: SeoChannelPayload): string {
  if (p.performance?.warming) return "Measuring now. Check back in a few minutes.";
  return "Google's page test has not run on this site yet.";
}

function fieldMissing(p: SeoChannelPayload): string {
  const field = p.performance?.field;
  if (field?.state === "no_data") return "Too few Chrome visitors for Google to report yet.";
  if (p.performance?.warming) return "Measuring now. Check back in a few minutes.";
  return "Google has not reported real-visitor timings yet.";
}

function geoMissing(): string {
  return "Not read yet. Press Refresh to read your site now.";
}

export type Severity = "error" | "warning" | "notice";

export function severityOf(f: Pick<SeoFinding, "severity">): Severity {
  if (f.severity === "blocker" || f.severity === "high") return "error";
  if (f.severity === "low") return "notice";
  return "warning";
}

type Issue = {
  sev: Severity;
  urls: string[];
  coversAll: boolean;
};

function crawlIssues(sh: SeoSiteHealth): Issue[] {
  return (sh.findings ?? []).map((f) => ({
    sev: severityOf(f),
    urls: (f.urls ?? []).filter((u) => /^https?:\/\//i.test(u)),
    coversAll: f.scope === "site",
  }));
}

function gapIssue(p: SeoChannelPayload): Issue | null {
  const gap = p.performance?.delivery_gap;
  if (!gap || gap.state !== "diverged") return null;
  if (typeof gap.lab_ms !== "number" || typeof gap.field_ms !== "number") return null;
  return { sev: "warning", urls: [], coversAll: false };
}

function allIssues(p: SeoChannelPayload): Issue[] {
  const sh = crawlOf(p);
  const gap = gapIssue(p);
  return [...(sh ? crawlIssues(sh) : []), ...(gap ? [gap] : [])];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function otherFilesRead(sh: SeoSiteHealth): number {
  return sh.non_html_urls?.length ?? Math.max(0, (sh.pages_analyzed ?? 0) - (sh.pages ?? []).length);
}

function noPagesWords(sh: SeoSiteHealth): string {
  const files = otherFilesRead(sh);
  return files > 0
    ? `The crawl read ${plural(files, "file")}, but none of them is a web page.`
    : "The crawl read no pages.";
}

export function seoSiteName(payload: unknown): string | null {
  const site = asPayload(payload)?.site_health?.site;
  return site ? shortUrl(site).replace(/^www\./, "").replace(/\/$/, "") : null;
}

export function seoPagesReadWords(sh: SeoSiteHealth): string {
  const pages = (sh.pages ?? []).length;
  const files = otherFilesRead(sh);
  if (pages === 0 && files > 0) return `${plural(files, "file")} read, no web pages`;
  return `${plural(pages, "page")} read`;
}

export function ownerCell(owner: IssueOwner | null): ExtraCell {
  return owner === "founder"
    ? { text: "You", chip: "good", title: "You can do this yourself, no developer needed" }
    : owner === "developer"
      ? { text: "Developer", chip: "muted", title: "This needs a developer" }
      : { text: "-", tone: "dim" };
}

function vitalsTable(p: SeoChannelPayload): ExtraTableData {
  const field = p.performance?.field;
  const metrics = field && field.state === "ok" ? (field.metrics ?? {}) : {};
  const rows: ExtraRow[] = VITAL_ORDER.filter((k) => metrics[k]?.p75 !== undefined).map((key) => {
    const t = VITAL_THRESHOLDS[key];
    const value = metrics[key]?.p75 as number;
    const core = CORE_WEB_VITALS.includes(key as CruxMetricKey);
    const band = vitalBand(key, value);
    return {
      id: key,
      cells: [
        { text: t.label, sub: t.acronym },
        { text: fmtVital(key, value), strong: true },
        core ? bandCell(BAND_WORD[band], band) : { text: "-", tone: "dim" },
        { text: core ? `good at or under ${fmtVital(key, t.good)}` : "not banded by Google", tone: "dim" },
      ],
    };
  });
  return {
    id: SEO_TABLE_IDS.vitals,
    title: "What real visitors got",
    icon: Timer,
    columns: [col("Measure", "left"), col("75th percentile"), col("Verdict", "left"), col("Google's bar", "left")],
    rows,
    empty: field && field.state === "ok" ? "Google reported no timings for this site." : fieldMissing(p),
    caption: `Chrome User Experience Report, 28 days of real visitors.${field && field.state === "ok" ? measuredNote(p) : ""}`,
  };
}

function measuredNote(p: SeoChannelPayload): string {
  const perf = p.performance;
  const at = perf?.fetched_at ? Date.parse(perf.fetched_at) : Number.NaN;
  if (!Number.isFinite(at)) return "";
  const day = new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return ` Measured ${day}.${perf?.warming ? " A fresh test is running now." : ""}`;
}

function opportunitiesTable(p: SeoChannelPayload, page: LabPage | null): ExtraTableData {
  const rows: ExtraRow[] = (page?.opportunities ?? []).map((o, i) => {
    const saving =
      (o.metricSavings ?? [])
        .map((s) => {
          const t = fmtMetricSaving(s);
          return t && s.unit === "score" && s.metric ? `${t} ${s.metric}` : t;
        })
        .find((x): x is string => !!x) ??
      (positive(o.savingsMs) !== null ? fmtMetricSaving({ value: o.savingsMs as number, unit: "ms" }) : null) ??
      (positive(o.savingsBytes) !== null ? fmtBytes(o.savingsBytes as number) : null);
    const culprits = (o.culprits ?? []).filter((c) => typeof c?.label === "string");
    const founder = culprits.filter((c) => c.owner === "founder").length;
    return {
      id: o.id || `opportunity-${i}`,
      cells: [
        { text: o.title || humanizeId(o.id) || "Fix", sub: culprits[0]?.detail ?? undefined },
        {
          text:
            culprits.length === 0
              ? "-"
              : founder === culprits.length
                ? "You can do this"
                : founder > 0
                  ? "You and a developer"
                  : "Needs a developer",
          tone: culprits.length === 0 ? "dim" : undefined,
        },
        { text: saving ?? "-", strong: !!saving },
      ],
    };
  });
  return {
    id: SEO_TABLE_IDS.opportunities,
    title: "What the page test says to fix",
    icon: Gauge,
    columns: [col("Fix", "left"), col("Who", "left"), col("Recovers")],
    rows,
    empty: page ? "The page test found nothing worth fixing on the page it measured." : labMissing(p),
    caption: page?.final_url
      ? `PageSpeed Insights, ${shortUrl(page.final_url)}${page.strategy === "mobile" ? ", simulated phone" : page.strategy === "desktop" ? ", simulated desktop" : ""}.${measuredNote(p)}`
      : "PageSpeed Insights, simulated run.",
  };
}

function googleTable(p: SeoChannelPayload, page: LabPage | null): ExtraTableData {
  const rows: ExtraRow[] = (page?.categories ?? [])
    .map((c) => ({ c, score: categoryScore100(c.score) }))
    .filter((x): x is { c: (typeof x)["c"]; score: number } => x.score !== null)
    .map(({ c, score }) => ({
      id: c.id || c.title || "category",
      cells: [
        { text: c.title || humanizeId(c.id) || "Category" },
        { text: String(score), meter: { value: score, max: 100, name: `${c.title ?? c.id} score` } },
        bandCell(BAND_WORD[scoreBand(score)], scoreBand(score)),
      ],
    }));
  return {
    id: SEO_TABLE_IDS.google,
    title: "Google's page test, by category",
    icon: SearchCheck,
    columns: [col("Category", "left"), col("Score"), col("Verdict", "left")],
    rows,
    empty: page ? "Google's page test returned no category scores." : labMissing(p),
    caption: page?.final_url
      ? `PageSpeed Insights, ${shortUrl(page.final_url)}${page.strategy === "mobile" ? ", simulated phone" : ""}. Scored 0-100 by Google.${measuredNote(p)}`
      : undefined,
  };
}

function aiTable(p: SeoChannelPayload): ExtraTableData {
  const g = geoOf(p);
  const rows: ExtraRow[] = (g?.score?.bands ?? [])
    .filter((b) => typeof b.score === "number")
    .map((b, i) => ({
      id: b.key || `band-${i}`,
      cells: [
        { text: b.label ?? humanizeId(b.key) ?? "Band", sub: b.note },
        { text: String(b.score), meter: { value: b.score as number, max: 100, name: `${b.label ?? b.key} score` } },
        { text: typeof b.weight === "number" ? `${b.weight}%` : "-", tone: "dim" },
      ],
    }));
  return {
    id: SEO_TABLE_IDS.ai,
    title: "Can AI answers use this site",
    icon: Bot,
    columns: [col("Band", "left"), col("Score"), col("Weight")],
    rows,
    empty: g ? "Nothing has scored this site yet." : geoMissing(),
    caption: g?.disclosure,
  };
}

function pagesTable(p: SeoChannelPayload): ExtraTableData {
  const sh = crawlOf(p);
  const rows: ExtraRow[] = (sh?.pages ?? []).map((pg: SeoPageFact) => ({
    id: pg.url,
    cells: [
      { text: shortUrl(pg.url), sub: pg.title ?? "No title", href: pg.url, title: pg.url },
      pg.noindex
        ? { text: "Hidden from search", chip: "warn", title: "This page carries a noindex tag" }
        : pg.status >= 400
          ? { text: `HTTP ${pg.status}`, chip: "bad" }
          : { text: "Indexable", chip: "good" },
      (pg.schema_types ?? []).length > 0
        ? { text: "Yes", tone: "dim", title: pg.schema_types.join(", ") }
        : pg.truncated
          ? { text: "Not read to the end", tone: "dim", title: "This page is larger than the crawl reads, so structured data may sit past where it stopped" }
          : { text: "None", tone: "bad" },
      pg.h1_count === 1
        ? { text: "1", tone: "dim" }
        : { text: String(pg.h1_count), tone: "bad", title: pg.h1_count === 0 ? "No H1 on this page" : "More than one H1" },
      { text: typeof pg.visible_words === "number" ? String(pg.visible_words) : "-" },
    ],
  }));
  return {
    id: SEO_TABLE_IDS.pages,
    title: "Every page the crawl read",
    icon: ListChecks,
    columns: [col("Page", "left"), col("In search", "left"), col("Structured data", "left"), col("H1s"), col("Words")],
    rows,
    empty: !sh
      ? crawlMissing(p)
      : otherFilesRead(sh) > 0
        ? noPagesWords(sh)
        : "The crawl has not read any page of this site yet.",
    caption: "Counted from the HTML the server returned, before any JavaScript ran.",
  };
}

export function seoTables(payload: unknown): ExtraTableData[] {
  const p = asPayload(payload);
  if (!p) return [];
  const page = firstLabPage(p);
  return [
    opportunitiesTable(p, page),
    vitalsTable(p),
    googleTable(p, page),
    aiTable(p),
    pagesTable(p),
  ];
}

const BAND_TONE: Record<Band, NonNullable<ChannelMetric["tone"]>> = { pass: "good", warn: "warn", fail: "bad" };

function metric(key: string, over: Partial<ChannelMetric>): ChannelMetric {
  return {
    key,
    value: 0,
    unit: "count",
    window_kind: null,
    day: "",
    grounded: true,
    prev_value: null,
    prev_day: null,
    ...over,
  };
}

type Reach = {
  pages: Record<Severity, Set<string>>;
  files: Record<Severity, Set<string>>;
  siteLevel: Record<Severity, number>;
};

function reachOf(sh: SeoSiteHealth, issues: Issue[]): Reach {
  const read = new Set((sh.pages ?? []).map((pg) => pg.url));
  const other = new Set(sh.non_html_urls ?? []);
  const pages: Reach["pages"] = { error: new Set(), warning: new Set(), notice: new Set() };
  const files: Reach["files"] = { error: new Set(), warning: new Set(), notice: new Set() };
  const siteLevel: Reach["siteLevel"] = { error: 0, warning: 0, notice: 0 };
  for (const x of issues) {
    const hits = x.coversAll ? [...read] : x.urls.filter((u) => read.has(u));
    const fileHits = x.urls.filter((u) => other.has(u) && !read.has(u));
    if (hits.length === 0 && fileHits.length === 0) siteLevel[x.sev] += 1;
    for (const u of hits) pages[x.sev].add(u);
    for (const u of fileHits) files[x.sev].add(u);
  }
  return { pages, files, siteLevel };
}

function whereWords(pageCount: number, fileCount: number, siteLevel: number): string {
  const parts = [
    pageCount > 0 ? `on ${plural(pageCount, "page")}` : "",
    fileCount > 0 ? `${pageCount > 0 ? "" : "on "}${plural(fileCount, "other file")}` : "",
    siteLevel > 0 ? "site-wide" : "",
  ];
  return parts.filter(Boolean).join(" + ");
}

export function seoKpis(payload: unknown): ChannelMetric[] {
  const p = asPayload(payload);
  if (!p) return [];
  const sh = crawlOf(p);
  const page = firstLabPage(p);

  const issues = allIssues(p);
  const errors = issues.filter((x) => x.sev === "error").length;
  const warnings = issues.filter((x) => x.sev === "warning").length;
  const notices = issues.filter((x) => x.sev === "notice").length;
  const reach = sh ? reachOf(sh, issues) : null;
  const hurt = reach ? new Set([...reach.pages.error, ...reach.pages.warning]).size : 0;
  const hurtFiles = reach ? new Set([...reach.files.error, ...reach.files.warning]).size : 0;
  const where = reach ? whereWords(hurt, hurtFiles, reach.siteLevel.error + reach.siteLevel.warning) : "";
  const issuesTile = sh
    ? metric("seo_issues", {
        value: errors + warnings,
        tone: errors > 0 ? "bad" : warnings > 0 ? "warn" : "good",
        note: [errors + warnings > 0 ? where : "Nothing costing rank", notices ? plural(notices, "notice") : ""]
          .filter(Boolean)
          .join(" · "),
      })
    : metric("seo_issues", { unmeasured: crawlMissing(p) });

  const speed = categoryOf(page, "performance");
  const speedTile =
    speed === null
      ? metric("seo_speed", { unmeasured: labMissing(p) })
      : metric("seo_speed", {
          value: speed,
          outOf: { max: 100 },
          tone: BAND_TONE[scoreBand(speed)],
          note: `${cap(BAND_WORD[scoreBand(speed)])} · simulated phone`,
        });

  const field = p.performance?.field && p.performance.field.state === "ok" ? (p.performance.field.metrics ?? {}) : null;
  const measured = field ? CORE_WEB_VITALS.filter((k) => typeof field[k]?.p75 === "number") : [];
  const passing = field ? measured.filter((k) => vitalBand(k, field[k]?.p75 as number) === "pass") : [];
  const worst = field
    ? (measured.find((k) => vitalBand(k, field[k]?.p75 as number) === "fail") ??
      measured.find((k) => vitalBand(k, field[k]?.p75 as number) === "warn"))
    : undefined;
  const vitalsTile =
    !field || measured.length === 0
      ? metric("seo_vitals_passing", { unmeasured: fieldMissing(p) })
      : metric("seo_vitals_passing", {
          value: passing.length,
          outOf: { max: measured.length, of: true, tail: "pass" },
          tone: passing.length === measured.length ? "good" : passing.length === 0 ? "bad" : "warn",
          note: worst
            ? `Worst: ${VITAL_THRESHOLDS[worst].acronym} ${fmtVital(worst, field[worst]?.p75 as number)}`
            : "All pass Google's bar",
        });

  const google = categoryOf(page, "seo");
  const googleTile =
    google === null
      ? metric("seo_google", { unmeasured: labMissing(p) })
      : metric("seo_google", {
          value: google,
          outOf: { max: 100 },
          tone: BAND_TONE[scoreBand(google)],
          note: cap(BAND_WORD[scoreBand(google)]),
        });

  const g = geoOf(p);
  const total = g?.score?.total;
  const bands = (g?.score?.bands ?? []).filter((b) => typeof b.score === "number");
  const weakest = bands.reduce<(typeof bands)[number] | null>(
    (w, b) => (w === null || (b.score as number) < (w.score as number) ? b : w),
    null,
  );
  const aiTile =
    typeof total !== "number"
      ? metric("seo_ai", { unmeasured: geoMissing() })
      : metric("seo_ai", {
          value: total,
          outOf: { max: 100 },
          tone: BAND_TONE[scoreBand(total)],
          ...(weakest ? { note: `Weakest: ${weakest.label ?? humanizeId(weakest.key)} ${weakest.score}` } : {}),
        });

  const pages = (sh?.pages ?? []).filter((pg) => !pg.truncated || (pg.schema_types ?? []).length > 0);
  const withSchema = pages.filter((pg) => (pg.schema_types ?? []).length > 0).length;
  const schemaTile = !sh
    ? metric("seo_schema", { unmeasured: crawlMissing(p) })
    : pages.length === 0
      ? metric("seo_schema", {
          unmeasured: (sh.pages ?? []).length > 0 ? "No page was read to the end, so this is unknown." : noPagesWords(sh),
        })
      : metric("seo_schema", {
          value: withSchema,
          outOf: { max: pages.length, of: true },
          tone: withSchema === pages.length ? "good" : withSchema * 2 >= pages.length ? "warn" : "bad",
          note: "pages declare it",
        });

  return [issuesTile, speedTile, vitalsTile, googleTile, aiTile, schemaTile];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function seoHealth(payload: unknown): ChannelHealth | null {
  const p = asPayload(payload);
  if (!p) return null;
  const sh = crawlOf(p);
  const help = "The share of the pages we read with no error and no warning. Notices don't count against it.";
  const issues = allIssues(p);
  const reach = sh ? reachOf(sh, issues) : null;
  const count = (kind: Severity, label: string): HealthCount => {
    const n = issues.filter((x) => x.sev === kind).length;
    return {
      kind,
      label,
      value: sh ? n : null,
      sub: !reach
        ? "Not measured yet"
        : n === 0
          ? "None found"
          : whereWords(reach.pages[kind].size, reach.files[kind].size, reach.siteLevel[kind]),
    };
  };
  const counts = [count("error", "Errors"), count("warning", "Warnings"), count("notice", "Notices")];
  const notice = publishNotice(p);
  if (!sh || !reach) {
    return {
      ...(notice ? { notice } : {}),
      label: "Site health",
      score: null,
      headline: p.site_health?.status === "error" ? "Couldn't read your site" : "Not measured yet",
      note: crawlMissing(p),
      help,
      counts,
    };
  }
  const total = (sh.pages ?? []).length;
  const errored = reach.pages.error;
  const warnedOnly = new Set([...reach.pages.warning].filter((u) => !errored.has(u)));
  const siteLevelHurt = reach.siteLevel.error + reach.siteLevel.warning;
  const filesHurt = new Set([...reach.files.error, ...reach.files.warning]).size;
  const clean = Math.max(0, total - errored.size - warnedOnly.size);
  const score = total > 0 ? Math.round((clean / total) * 100) : null;
  return {
    label: "Site health",
    score,
    ...(score !== null ? { tone: score >= 80 ? "good" : score >= 60 ? "warn" : "bad" } : {}),
    headline:
      total === 0
        ? noPagesWords(sh).replace(/\.$/, "")
        : total - clean === 0
          ? `All ${plural(total, "page")} are healthy`
          : `${total - clean} of ${plural(total, "page")} need fixes`,
    note: [
      total > 0 && total - clean > 0 ? `${clean} ${clean === 1 ? "is" : "are"} healthy.` : "",
      "Errors and warnings count; notices don't.",
      siteLevelHurt > 0
        ? `${plural(siteLevelHurt, "site-wide issue")} ${siteLevelHurt === 1 ? "is" : "are"} counted below, not in this share.`
        : "",
      filesHurt > 0
        ? `${plural(filesHurt, "file")} that ${filesHurt === 1 ? "is" : "are"} not a web page ${filesHurt === 1 ? "has" : "have"} issues counted below, not in this share.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    help,
    counts,
    segmentsLabel: seoPagesReadWords(sh),
    segments: [
      { label: "Healthy", value: clean, tone: "good" },
      { label: "With warnings", value: warnedOnly.size, tone: "warn" },
      { label: "With errors", value: errored.size, tone: "bad" },
    ],
  };
}

function publishNotice(p: SeoChannelPayload): string | null {
  const sp = p.site_publish;
  if (!sp || !(sp.pending > 0)) return null;
  const n = sp.capped ? `${sp.pending}+ changes` : plural(sp.pending, "change");
  const are = sp.pending === 1 && !sp.capped ? "is" : "are";
  return `${n} to your site ${are} waiting for Publish. These numbers are read from your live site, so they update once you publish.`;
}

export function seoSpeedBandWord(payload: unknown): string | null {
  const p = asPayload(payload);
  const score = categoryOf(p ? firstLabPage(p) : null, "performance");
  return score === null ? null : BAND_WORD[scoreBand(score)];
}
