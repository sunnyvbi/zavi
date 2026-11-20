import type { ChannelMetric } from "./channelPage";
import { ISSUE_COPY, type IssueOwner } from "./seoIssueCopy";
import { col, colLeft, type ChannelTable, type TableCell, type TableRow } from "./channelTables";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" ? (v as Rec) : null);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

type Band = "pass" | "warn" | "fail";
type Severity = "error" | "warning" | "notice";

const VITALS: Record<string, { acronym: string; unit: "ms" | "score"; good: number; poor: number }> = {
  largest_contentful_paint: { acronym: "LCP", unit: "ms", good: 2500, poor: 4000 },
  interaction_to_next_paint: { acronym: "INP", unit: "ms", good: 200, poor: 500 },
  cumulative_layout_shift: { acronym: "CLS", unit: "score", good: 0.1, poor: 0.25 },
};
const CORE = ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift"];

const vitalBand = (key: string, value: number): Band => {
  const t = VITALS[key];
  return value <= t.good ? "pass" : value <= t.poor ? "warn" : "fail";
};
const BAND_WORD: Record<Band, string> = { pass: "good", warn: "needs work", fail: "poor" };
const BAND_TONE: Record<Band, "good" | "warn" | "bad"> = { pass: "good", warn: "warn", fail: "bad" };

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  if (Math.abs(ms) >= 1000) {
    const s = ms / 1000;
    return `${s >= 10 ? Math.round(s) : Number(s.toFixed(1))} s`;
  }
  return `${Math.round(ms)} ms`;
}
const fmtVital = (key: string, value: number) => (VITALS[key].unit === "ms" ? fmtMs(value) : value.toFixed(2));

export function categoryScore100(score: unknown): number | null {
  const n = num(score);
  return n === null ? null : Math.max(0, Math.min(100, Math.round(n * 100)));
}
export function scoreBand(score100: number): Band {
  return score100 >= 90 ? "pass" : score100 >= 50 ? "warn" : "fail";
}

function humanizeReason(reason: unknown): string | null {
  const s = str(reason);
  if (!s) return null;
  const words = s.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const otherFilesRead = (sh: Rec): number =>
  Array.isArray(sh.non_html_urls) ? sh.non_html_urls.length : Math.max(0, (num(sh.pages_analyzed) ?? 0) - arr(sh.pages).length);

const noPagesWords = (sh: Rec): string => {
  const files = otherFilesRead(sh);
  return files > 0 ? `The crawl read ${plural(files, "file")}, but none of them is a web page.` : "The crawl read no pages.";
};

function asPayload(payload: unknown): Rec | null {
  const p = rec(payload);
  return !p || p.generic ? null : p;
}

const crawlOf = (p: Rec): Rec | null => {
  const sh = rec(p.site_health);
  return sh && sh.status === "ok" ? sh : null;
};

function firstLabPage(p: Rec): Rec | null {
  const lab = rec(rec(p.performance)?.lab);
  return lab && lab.state === "ok" ? arr(lab.pages)[0] ?? null : null;
}

const categoryOf = (page: Rec | null, id: string): number | null =>
  categoryScore100(arr(page?.categories).find((c) => c.id === id)?.score);

function geoOf(p: Rec): Rec | null {
  const g = rec(p.geo);
  return g && g.status === "ok" && num(rec(g.score)?.total) !== null ? g : null;
}

function crawlMissing(p: Rec): string {
  const sh = rec(p.site_health);
  if (sh && sh.status === "error") {
    const reason = humanizeReason(sh.error_code)?.toLowerCase();
    return `Couldn't read your site${reason ? ` (${reason})` : ""}. Press Refresh to try again.`;
  }
  return "Not read yet. Press Refresh to read your site now.";
}
const labMissing = (p: Rec): string =>
  rec(p.performance)?.warming ? "Measuring now. Check back in a few minutes." : "Google's page test has not run on this site yet.";
function fieldMissing(p: Rec): string {
  const perf = rec(p.performance);
  if (rec(perf?.field)?.state === "no_data") return "Too few Chrome visitors for Google to report yet.";
  if (perf?.warming) return "Measuring now. Check back in a few minutes.";
  return "Google has not reported real-visitor timings yet.";
}
const geoMissing = () => "Not read yet. Press Refresh to read your site now.";

type Issue = {
  id: string;
  sev: Severity;
  title: string;
  why: string;
  how: string | null;
  owner: IssueOwner | null;
  urls: string[];
  pageCount: number;
  siteWide: boolean;
  coversAll: boolean;
};

const asFiles = (title: string) => title.replace(/\bpages\b/g, "files").replace(/\bpage\b/g, "file");

function severityOf(f: Rec): Severity {
  if (f.severity === "blocker" || f.severity === "high") return "error";
  if (f.severity === "low") return "notice";
  return "warning";
}
const SEV_RANK: Record<Severity, number> = { error: 0, warning: 1, notice: 2 };

function allIssues(p: Rec): Issue[] {
  const sh = crawlOf(p);
  const list: Issue[] = arr(sh?.findings).map((f, i) => {
    const urls = (Array.isArray(f.urls) ? (f.urls as unknown[]) : []).filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
    const coversAll = f.scope === "site";
    const nonHtml = sh?.non_html_urls;
    const other = new Set((Array.isArray(nonHtml) ? nonHtml : []).map(String));
    const fileCount = urls.filter((u) => other.has(u)).length;
    const pageCount = urls.length - fileCount;
    const code = str(f.code) ?? "";
    const copy = Object.prototype.hasOwnProperty.call(ISSUE_COPY, code) ? ISSUE_COPY[code] : null;
    return {
      id: code || `finding-${i}`,
      sev: severityOf(f),
      title: !copy ? humanizeReason(code) ?? "Issue" : pageCount > 0 ? copy.title(pageCount) : fileCount > 0 ? asFiles(copy.title(fileCount)) : copy.title(urls.length),
      why: copy?.why ?? str(f.summary) ?? "",
      how: copy?.how ?? null,
      owner: copy?.owner ?? null,
      urls,
      pageCount,
      siteWide: coversAll || urls.length === 0,
      coversAll,
    };
  });
  const gap = rec(rec(p.performance)?.delivery_gap);
  if (gap && gap.state === "diverged" && num(gap.lab_ms) !== null && num(gap.field_ms) !== null) {
    list.push({
      id: "delivery_gap",
      sev: "warning",
      title: `Real visitors wait ${fmtMs(gap.field_ms as number)} for the first byte. The test load took ${fmtMs(gap.lab_ms as number)}.`,
      why: str(gap.note) ?? "The delay is in front of the application, not inside it.",
      how: null,
      owner: "developer",
      urls: [],
      pageCount: 0,
      siteWide: true,
      coversAll: false,
    });
  }
  const reach = (x: Issue) => (x.siteWide ? Number.MAX_SAFE_INTEGER : x.urls.length);
  return list.sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || reach(b) - reach(a));
}

type Reach = { pages: Record<Severity, Set<string>>; files: Record<Severity, Set<string>>; siteLevel: Record<Severity, number> };

function reachOf(sh: Rec, issues: Issue[]): Reach {
  const read = new Set(arr(sh.pages).map((pg) => String(pg.url)));
  const other = new Set((Array.isArray(sh.non_html_urls) ? sh.non_html_urls : []).map(String));
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
  return [pageCount > 0 ? `on ${plural(pageCount, "page")}` : "", fileCount > 0 ? `${pageCount > 0 ? "" : "on "}${plural(fileCount, "other file")}` : "", siteLevel > 0 ? "site-wide" : ""]
    .filter(Boolean)
    .join(" + ");
}

function metric(key: string, over: Partial<ChannelMetric>): ChannelMetric {
  return { key, value: 0, unit: "count", grounded: true, prev_value: null, day: "", ...over };
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
        note: [errors + warnings > 0 ? where : "Nothing costing rank", notices ? plural(notices, "notice") : ""].filter(Boolean).join(" · "),
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

  const perf = rec(p.performance);
  const fieldLane = rec(perf?.field);
  const field = fieldLane && fieldLane.state === "ok" ? rec(fieldLane.metrics) ?? {} : null;
  const p75 = (k: string) => num(rec(field?.[k])?.p75);
  const measured = field ? CORE.filter((k) => p75(k) !== null) : [];
  const passing = measured.filter((k) => vitalBand(k, p75(k) as number) === "pass");
  const worst = field
    ? measured.find((k) => vitalBand(k, p75(k) as number) === "fail") ?? measured.find((k) => vitalBand(k, p75(k) as number) === "warn")
    : undefined;
  const vitalsTile =
    !field || measured.length === 0
      ? metric("seo_vitals_passing", { unmeasured: fieldMissing(p) })
      : metric("seo_vitals_passing", {
          value: passing.length,
          outOf: { max: measured.length, of: true, tail: "pass" },
          tone: passing.length === measured.length ? "good" : passing.length === 0 ? "bad" : "warn",
          note: worst ? `Worst: ${VITALS[worst].acronym} ${fmtVital(worst, p75(worst) as number)}` : "All pass Google's bar",
        });

  const google = categoryOf(page, "seo");
  const googleTile =
    google === null
      ? metric("seo_google", { unmeasured: labMissing(p) })
      : metric("seo_google", { value: google, outOf: { max: 100 }, tone: BAND_TONE[scoreBand(google)], note: cap(BAND_WORD[scoreBand(google)]) });

  const g = geoOf(p);
  const score = rec(g?.score);
  const total = num(score?.total);
  const bands = arr(score?.bands).filter((b) => num(b.score) !== null);
  const weakest = bands.reduce<Rec | null>((w, b) => (w === null || (b.score as number) < (w.score as number) ? b : w), null);
  const aiTile =
    total === null
      ? metric("seo_ai", { unmeasured: geoMissing() })
      : metric("seo_ai", {
          value: total,
          outOf: { max: 100 },
          tone: BAND_TONE[scoreBand(total)],
          ...(weakest ? { note: `Weakest: ${str(weakest.label) ?? humanizeReason(weakest.key) ?? ""} ${weakest.score}` } : {}),
        });

  const hasSchema = (pg: Rec) => Array.isArray(pg.schema_types) && pg.schema_types.length > 0;
  const pages = arr(sh?.pages).filter((pg) => !pg.truncated || hasSchema(pg));
  const withSchema = pages.filter(hasSchema).length;
  const schemaTile = !sh
    ? metric("seo_schema", { unmeasured: crawlMissing(p) })
    : pages.length === 0
      ? metric("seo_schema", { unmeasured: arr(sh.pages).length > 0 ? "No page was read to the end, so this is unknown." : noPagesWords(sh) })
      : metric("seo_schema", {
          value: withSchema,
          outOf: { max: pages.length, of: true },
          tone: withSchema === pages.length ? "good" : withSchema * 2 >= pages.length ? "warn" : "bad",
          note: "pages declare it",
        });

  return [issuesTile, speedTile, vitalsTile, googleTile, aiTile, schemaTile];
}

export type HealthCount = { kind: Severity; label: string; value: number | null; sub: string };
export type HealthSegment = { label: string; value: number; tone: "good" | "warn" | "bad" };
export type SeoHealth = {
  score: number | null;
  tone?: "good" | "warn" | "bad";
  headline: string;
  note: string;
  counts: HealthCount[];
  segmentsLabel?: string;
  segments?: HealthSegment[];
};

export function seoHealth(payload: unknown): SeoHealth | null {
  const p = asPayload(payload);
  if (!p) return null;
  const sh = crawlOf(p);
  const issues = allIssues(p);
  const reach = sh ? reachOf(sh, issues) : null;
  const count = (kind: Severity, label: string): HealthCount => {
    const n = issues.filter((x) => x.sev === kind).length;
    return { kind, label, value: sh ? n : null, sub: !reach ? "Not measured yet" : n === 0 ? "None found" : whereWords(reach.pages[kind].size, reach.files[kind].size, reach.siteLevel[kind]) };
  };
  const counts = [count("error", "Errors"), count("warning", "Warnings"), count("notice", "Notices")];
  if (!sh || !reach) {
    return {
      score: null,
      headline: rec(p.site_health)?.status === "error" ? "Couldn't read your site" : "Not measured yet",
      note: crawlMissing(p),
      counts,
    };
  }
  const total = arr(sh.pages).length;
  const errored = reach.pages.error;
  const warnedOnly = new Set([...reach.pages.warning].filter((u) => !errored.has(u)));
  const siteLevelHurt = reach.siteLevel.error + reach.siteLevel.warning;
  const filesHurt = new Set([...reach.files.error, ...reach.files.warning]).size;
  const clean = Math.max(0, total - errored.size - warnedOnly.size);
  const score = total > 0 ? Math.round((clean / total) * 100) : null;
  return {
    score,
    ...(score !== null ? { tone: score >= 80 ? ("good" as const) : score >= 60 ? ("warn" as const) : ("bad" as const) } : {}),
    headline: total === 0 ? noPagesWords(sh).replace(/\.$/, "") : total - clean === 0 ? `All ${plural(total, "page")} are healthy` : `${total - clean} of ${plural(total, "page")} need fixes`,
    note: [
      total > 0 && total - clean > 0 ? `${clean} ${clean === 1 ? "is" : "are"} healthy.` : "",
      "Errors and warnings count; notices don't.",
      siteLevelHurt > 0 ? `${plural(siteLevelHurt, "site-wide issue")} ${siteLevelHurt === 1 ? "is" : "are"} counted below, not in this share.` : "",
      filesHurt > 0
        ? `${plural(filesHurt, "file")} that ${filesHurt === 1 ? "is" : "are"} not a web page ${filesHurt === 1 ? "has" : "have"} issues counted below, not in this share.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    counts,
    segmentsLabel: total === 0 && otherFilesRead(sh) > 0 ? `${plural(otherFilesRead(sh), "file")} read, no web pages` : `${plural(total, "page")} read`,
    segments: [
      { label: "Healthy", value: clean, tone: "good" },
      { label: "With warnings", value: warnedOnly.size, tone: "warn" },
      { label: "With errors", value: errored.size, tone: "bad" },
    ],
  };
}

export type SeoIssueRow = {
  id: string;
  sev: Severity;
  title: string;
  why: string;
  how: string | null;
  owner: IssueOwner | null;
  siteWide: boolean;
  pageCount: number;
  where: string;
  pages: string[];
  fixDraft: string;
};

function shortUrl(url: string): string {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (!m) return url;
  return `${m[1]}${m[2] === "/" ? "" : m[2]}`;
}

function issueWhere(x: Issue): string {
  if (x.siteWide) return "Whole site";
  const files = x.urls.length - x.pageCount;
  if (x.pageCount === 0) return plural(files, "file");
  return files > 0 ? `${plural(x.pageCount, "page")} + ${plural(files, "other file")}` : plural(x.pageCount, "page");
}

function fixDraft(x: Issue): string {
  const shown = x.urls.slice(0, 5).map(shortUrl);
  const more = x.urls.length > shown.length ? ` and ${x.urls.length - shown.length} more` : "";
  const where = shown.length ? ` Pages: ${shown.join(", ")}${more}.` : "";
  return `Help me fix this on my site: ${x.title.replace(/[.\s]+$/, "")}.${where} Tell me exactly what to change, and draft it for me.`;
}

export function seoIssues(payload: unknown): { rows: SeoIssueRow[]; empty: string } | null {
  const p = asPayload(payload);
  if (!p) return null;
  const sh = crawlOf(p);
  const rows = allIssues(p).map((x) => ({
    id: x.id,
    sev: x.sev,
    title: x.title,
    why: x.why,
    how: x.how,
    owner: x.owner,
    siteWide: x.siteWide,
    pageCount: x.pageCount,
    where: issueWhere(x),
    pages: x.urls.map(shortUrl),
    fixDraft: fixDraft(x),
  }));
  return { rows, empty: sh ? "The crawl found none of the issues it checks for." : crawlMissing(p) };
}

export function seoAccount(payload: unknown): { name: string; sub: string } | null {
  const p = asPayload(payload);
  const health = rec(p?.site_health);
  const site = str(health?.site);
  if (!health || health.status !== "ok" || !site) return null;
  const pages = Array.isArray(health.pages) ? health.pages.length : num(health.pages_analyzed);
  const files = otherFilesRead(health);
  const name = site.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (pages === null) return { name, sub: "Pages could not be read" };
  return { name, sub: pages === 0 && files > 0 ? `${plural(files, "file")} read, no web pages` : `${plural(pages, "page")} read` };
}

const fmtScore = (n: number) => n.toFixed(2);
function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-";
  if (Math.abs(bytes) >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : Number(mb.toFixed(1))} MB`;
  }
  return Math.abs(bytes) >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${Math.round(bytes)} B`;
}
const positive = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);

function fmtMetricSaving(saving: unknown): string | null {
  const s = rec(saving);
  const v = positive(s?.value);
  return v === null ? null : s?.unit === "score" ? fmtScore(v) : fmtMs(v);
}

function bandCell(text: string, band: Band): TableCell {
  return band === "fail" ? { text, bad: true } : band === "warn" ? { text } : { text, dim: true };
}

const VITAL_META: Record<string, { label: string; acronym: string }> = {
  largest_contentful_paint: { label: "Largest paint", acronym: "LCP" },
  interaction_to_next_paint: { label: "Tap response", acronym: "INP" },
  cumulative_layout_shift: { label: "Layout shift", acronym: "CLS" },
  first_contentful_paint: { label: "First paint", acronym: "FCP" },
  experimental_time_to_first_byte: { label: "Server response", acronym: "TTFB" },
};
const VITAL_ORDER = [...CORE, "first_contentful_paint", "experimental_time_to_first_byte"];
const VITAL_FULL: Record<string, { good: number; unit: "ms" | "score" }> = {
  ...Object.fromEntries(Object.entries(VITALS).map(([k, v]) => [k, { good: v.good, unit: v.unit }])),
  first_contentful_paint: { good: 1800, unit: "ms" },
  experimental_time_to_first_byte: { good: 800, unit: "ms" },
};
const fmtVitalAny = (key: string, value: number) => (VITAL_FULL[key].unit === "ms" ? fmtMs(value) : fmtScore(value));

function vitalsTable(p: Rec): ChannelTable {
  const fieldLane = rec(rec(p.performance)?.field);
  const metrics = fieldLane && fieldLane.state === "ok" ? rec(fieldLane.metrics) ?? {} : {};
  const rows: TableRow[] = VITAL_ORDER.filter((k) => num(rec(metrics[k])?.p75) !== null).map((key) => {
    const value = num(rec(metrics[key])?.p75) as number;
    const core = CORE.includes(key);
    const band = core ? vitalBand(key, value) : null;
    return {
      id: key,
      cells: [
        { text: VITAL_META[key].label, sub: VITAL_META[key].acronym },
        { text: fmtVitalAny(key, value), strong: true },
        band ? bandCell(BAND_WORD[band], band) : { text: "—", dim: true },
        { text: core ? `good at or under ${fmtVitalAny(key, VITAL_FULL[key].good)}` : "not banded by Google", dim: true },
      ],
    };
  });
  return {
    id: "seo_vitals",
    title: "What real visitors got",
    icon: "chartColumn",
    columns: [colLeft("Measure", 120), col("75th percentile", 84), colLeft("Verdict", 72), colLeft("Google's bar", 110)],
    rows,
    empty: fieldLane && fieldLane.state === "ok" ? "Google reported no timings for this site." : fieldMissing(p),
    caption: "Chrome User Experience Report, 28 days of real visitors.",
  };
}

function strategyWords(page: Rec | null): string {
  const s = page?.strategy;
  return s === "mobile" ? ", simulated phone" : s === "desktop" ? ", simulated desktop" : "";
}

function opportunitiesTable(p: Rec, page: Rec | null): ChannelTable {
  const rows: TableRow[] = arr(page?.opportunities).map((o, i) => {
    const saving =
      arr(o.metricSavings).map((m) => fmtMetricSaving(m)).find((x): x is string => !!x) ??
      (positive(o.savingsMs) !== null ? fmtMetricSaving({ value: o.savingsMs, unit: "ms" }) : null) ??
      (positive(o.savingsBytes) !== null ? fmtBytes(o.savingsBytes as number) : null);
    const culprits = arr(o.culprits).filter((c) => typeof c.label === "string");
    const founder = culprits.some((c) => c.owner === "founder");
    return {
      id: str(o.id) ?? `opportunity-${i}`,
      cells: [
        { text: str(o.title) ?? humanizeReason(o.id) ?? "Fix", ...(str(culprits[0]?.detail) ? { sub: str(culprits[0]?.detail) as string } : {}) },
        culprits.length === 0 ? { text: "—", dim: true } : { text: founder ? "You can do this" : "Needs a developer" },
        saving ? { text: saving, strong: true } : { text: "—" },
      ],
    };
  });
  const url = str(page?.final_url);
  return {
    id: "seo_opportunities",
    title: "What the page test says to fix",
    icon: "chartColumn",
    columns: [colLeft("Fix", 150), colLeft("Who", 92), col("Recovers", 72)],
    rows,
    empty: page ? "The page test found nothing worth fixing on the page it measured." : labMissing(p),
    caption: url ? `PageSpeed Insights, ${shortUrl(url)}${strategyWords(page)}.` : "PageSpeed Insights, simulated run.",
  };
}

function googleTable(p: Rec, page: Rec | null): ChannelTable {
  const rows: TableRow[] = arr(page?.categories)
    .map((c) => ({ c, score: categoryScore100(c.score) }))
    .filter((x): x is { c: Rec; score: number } => x.score !== null)
    .map(({ c, score }) => ({
      id: str(c.id) ?? str(c.title) ?? "category",
      cells: [
        { text: str(c.title) ?? humanizeReason(c.id) ?? "Category" },
        { text: String(score), meter: { value: score, max: 100 } },
        bandCell(BAND_WORD[scoreBand(score)], scoreBand(score)),
      ],
    }));
  const url = str(page?.final_url);
  return {
    id: "seo_google",
    title: "Google's page test, by category",
    icon: "search",
    columns: [colLeft("Category", 150), col("Score", 76), colLeft("Verdict", 80)],
    rows,
    empty: page ? "Google's page test returned no category scores." : labMissing(p),
    caption: url ? `PageSpeed Insights, ${shortUrl(url)}${page?.strategy === "mobile" ? ", simulated phone" : ""}. Scored 0-100 by Google.` : null,
  };
}

function aiTable(p: Rec): ChannelTable {
  const g = geoOf(p);
  const rows: TableRow[] = arr(rec(g?.score)?.bands)
    .filter((b) => num(b.score) !== null)
    .map((b, i) => ({
      id: str(b.key) ?? `band-${i}`,
      cells: [
        { text: str(b.label) ?? humanizeReason(b.key) ?? "Band", ...(str(b.note) ? { sub: str(b.note) as string } : {}) },
        { text: String(b.score), meter: { value: b.score as number, max: 100 } },
        { text: num(b.weight) === null ? "—" : `${b.weight}%`, dim: true },
      ],
    }));
  return {
    id: "seo_ai",
    title: "Can AI answers use this site",
    icon: "sparkles",
    columns: [colLeft("Band", 160), col("Score", 76), col("Weight", 64)],
    rows,
    empty: g ? "Nothing has scored this site yet." : geoMissing(),
    caption: str(g?.disclosure),
  };
}

function pagesTable(p: Rec): ChannelTable {
  const sh = crawlOf(p);
  const rows: TableRow[] = arr(sh?.pages).map((pg) => {
    const types = Array.isArray(pg.schema_types) ? (pg.schema_types as unknown[]) : [];
    const status = num(pg.status) ?? 0;
    const h1 = num(pg.h1_count) ?? 0;
    return {
      id: String(pg.url),
      cells: [
        { text: shortUrl(String(pg.url)), sub: str(pg.title) ?? "No title", href: String(pg.url) },
        pg.noindex ? { text: "Hidden from search", chip: "warn" } : status >= 400 ? { text: `HTTP ${status}`, chip: "bad" } : { text: "Indexable", chip: "good" },
        types.length > 0 ? { text: "Yes", dim: true } : pg.truncated ? { text: "Not read to the end", dim: true } : { text: "None", bad: true },
        h1 === 1 ? { text: "1", dim: true } : { text: String(h1), bad: true },
        { text: num(pg.visible_words) === null ? "—" : String(pg.visible_words) },
      ],
    };
  });
  return {
    id: "seo_pages",
    title: "Every page the crawl read",
    icon: "file",
    columns: [colLeft("Page", 150), colLeft("In search", 86), colLeft("Structured data", 86), col("H1s", 44), col("Words", 58)],
    rows,
    empty: !sh ? crawlMissing(p) : otherFilesRead(sh) > 0 ? noPagesWords(sh) : "The crawl has not read any page of this site yet.",
    caption: "Counted from the HTML the server returned, before any JavaScript ran.",
  };
}

export function seoTables(payload: unknown): ChannelTable[] {
  const p = asPayload(payload);
  if (!p) return [];
  const page = firstLabPage(p);
  return [opportunitiesTable(p, page), vitalsTable(p), googleTable(p, page), aiTable(p), pagesTable(p)];
}
