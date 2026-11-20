
import type { SiteGraphReport } from "./site-graph";

export type FetchedPage = {
  url: string;
  status: number;
  headers: Record<string, string>;
  html: string;
  truncated?: boolean;
  final_url?: string;
};

export type SeoSeverity = "blocker" | "high" | "medium" | "low";

export type SeoFinding = {
  code: string;
  severity: SeoSeverity;
  summary: string;
  urls: string[];
  scope?: "site" | "partial";
};

const TAG = {
  title: /<title[^>]*>([\s\S]*?)<\/title>/i,
  metaDesc:
    /<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i,
  metaRobots:
    /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']*)["'][^>]*>/i,
  canonical:
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']*)["'][^>]*>/i,
  h1: /<h1[^>]*>([\s\S]*?)<\/h1>/gi,
  jsonLd:
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
};

export function stripTags(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleOf(html: string): string | null {
  const m = TAG.title.exec(html);
  return m ? stripTags(m[1]) : null;
}

export function metaDescriptionOf(html: string): string | null {
  const m = TAG.metaDesc.exec(html);
  return m ? stripTags(m[1]) : null;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

export function canonicalOf(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(tag, "rel");
    if (!rel || !rel.toLowerCase().split(/\s+/).includes("canonical")) continue;
    const href = attr(tag, "href");
    if (href !== undefined) return href.trim();
  }
  return null;
}

export function h1CountOf(html: string): number {
  return [...html.matchAll(TAG.h1)].length;
}

export function schemaTypesOf(html: string): string[] {
  const types: string[] = [];
  for (const m of html.matchAll(TAG.jsonLd)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      const t = (node as Record<string, unknown>)["@type"];
      if (typeof t === "string") types.push(t);
      else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.push(x));
      for (const v of Object.values(node as Record<string, unknown>)) visit(v);
    };
    visit(parsed);
  }
  return [...new Set(types)];
}

export function isHomepageUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return path === "" || path === "/";
  } catch {
    return false;
  }
}

export function isNoindex(page: FetchedPage): boolean {
  const m = TAG.metaRobots.exec(page.html);
  if (m && /\bnoindex\b/i.test(m[1])) return true;
  const xr = page.headers["x-robots-tag"];
  return typeof xr === "string" && /\bnoindex\b/i.test(xr);
}

const HTML_DOC_OPENER = /^<(?:!doctype\s+html|html|head)[\s>]/i;
const SNIFF_PREFIX = 2048;

function opensAsHtmlDocument(body: string): boolean {
  let s = body.slice(0, SNIFF_PREFIX).replace(/^\uFEFF/, "").trimStart();
  if (s.startsWith("<?xml")) {
    const end = s.indexOf("?>");
    if (end < 0) return false;
    s = s.slice(end + 2).trimStart();
  }
  while (s.startsWith("<!--")) {
    const end = s.indexOf("-->", 4);
    if (end < 0) return false;
    s = s.slice(end + 3).trimStart();
  }
  return HTML_DOC_OPENER.test(s);
}

const TEXT_FILE_PATH = /\.(?:md|markdown|txt)$/i;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function isHtmlPage(page: FetchedPage): boolean {
  if (opensAsHtmlDocument(page.html)) return true;
  if (TEXT_FILE_PATH.test(pathOf(page.final_url ?? page.url))) return false;
  return String(page.headers?.["content-type"] ?? "text/html").toLowerCase().includes("html");
}

const PRIVATE_FIRST_SEGMENT =
  /^(?:cart|checkout|(?:my-)?account|(?:wp-)?admin|log-?in|sign-?in|log-?out|sign-?out|auth|oauth|sso)$/i;
const STORE_SEGMENT = /^(?:shop|store)$/i;
const CART_SEGMENT = /^(?:cart|checkout)$/i;
const LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2})?$/i;

export function isPrivatePath(pathOrUrl: string): boolean {
  let path = pathOrUrl;
  try {
    path = new URL(pathOrUrl).pathname;
  } catch {
  }
  const segs = path.split("/").filter((s) => s.length > 0);
  const first = segs.length > 1 && LOCALE_SEGMENT.test(segs[0]) ? segs[1] : segs[0];
  return (first !== undefined && PRIVATE_FIRST_SEGMENT.test(first)) || segs.some((s, k) => k > 0 && CART_SEGMENT.test(s) && STORE_SEGMENT.test(segs[k - 1]));
}

export function landingKey(page: FetchedPage): string {
  const raw = page.final_url ?? page.url;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`;
  } catch {
    return raw;
  }
}

export function uniqueByLanding(pages: FetchedPage[]): FetchedPage[] {
  const seen = new Set<string>();
  return pages.filter((p) => {
    const k = landingKey(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function visibleWordCount(html: string): number {
  const text = stripTags(html);
  return text.length === 0 ? 0 : text.split(/\s+/).length;
}

const SHELL_WORD_FLOOR = 60;

const NAMED_ENTITY: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", middot: "\u00b7",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#")) {
      const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\ufffd";
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITY, k) ? NAMED_ENTITY[k] : m;
  });
}

const TITLE_MAX_CHARS = 60;

export type RobotsFacts = {
  fetched: boolean;
  disallowsAll: boolean;
  sitemaps: string[];
};

export function parseRobots(body: string | null): RobotsFacts {
  if (body === null) return { fetched: false, disallowsAll: false, sitemaps: [] };
  const sitemaps: string[] = [];
  let inStar = false;
  let disallowsAll = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const [kRaw, ...rest] = line.split(":");
    const k = kRaw.trim().toLowerCase();
    const v = rest.join(":").trim();
    if (k === "sitemap" && v) sitemaps.push(v);
    else if (k === "user-agent") inStar = v === "*";
    else if (k === "disallow" && inStar && v === "/") disallowsAll = true;
  }
  return { fetched: true, disallowsAll, sitemaps };
}

export type SeoAuditInput = {
  pages: FetchedPage[];
  robots: RobotsFacts;
  sitemapReachable: boolean | null;
};

export type SeoAuditReport = {
  pages_analyzed: number;
  non_html_urls?: string[];
  findings: SeoFinding[];
  site_graph?: SiteGraphReport;
  pages: Array<{
    url: string;
    status: number;
    title: string | null;
    title_length: number | null;
    meta_description: string | null;
    canonical: string | null;
    h1_count: number;
    schema_types: string[];
    noindex: boolean;
    visible_words: number;
    truncated?: boolean;
  }>;
};

export function analyzeSeo(input: SeoAuditInput): SeoAuditReport {
  const ok = uniqueByLanding(
    input.pages.filter((p) => p.status >= 200 && p.status < 300 && p.html.length > 0),
  );
  const findings: SeoFinding[] = [];

  if (input.robots.fetched && input.robots.disallowsAll) {
    findings.push({
      code: "robots_disallow_all",
      severity: "blocker",
      scope: "site",
      summary:
        "robots.txt tells every search engine not to crawl any page on the site. Nothing can rank until that line is removed.",
      urls: ["/robots.txt"],
    });
  }
  const indexable = ok.filter((p) => !isPrivatePath(p.final_url ?? p.url));
  const noindexed = indexable.filter(isNoindex);
  if (noindexed.length > 0) {
    const htmlRead = indexable.filter(isHtmlPage);
    const pagesHit = noindexed.filter(isHtmlPage).length;
    const filesHit = noindexed.length - pagesHit;
    const filesRead = indexable.length - htmlRead.length;
    const everyPage = htmlRead.length > 0 ? pagesHit === htmlRead.length : noindexed.length === indexable.length;
    const homepage = noindexed.some((p) => isHomepageUrl(p.final_url ?? p.url) && isHtmlPage(p));
    const count = (n: number, of: number, noun: string) => `${n} of ${of} ${of === 1 ? noun : `${noun}s`} checked`;
    findings.push({
      code: "noindex",
      severity: (everyPage && htmlRead.length > 0) || homepage ? "blocker" : "high",
      scope: everyPage && htmlRead.length > 0 ? "site" : "partial",
      summary: everyPage
        ? `Every ${htmlRead.length > 0 ? "page" : "file"} checked asks search engines not to index it. This is usually a staging setting left on after launch.`
        : `${[pagesHit > 0 ? count(pagesHit, htmlRead.length, "page") : "", filesHit > 0 ? count(filesHit, filesRead, htmlRead.length > 0 ? "other file" : "file") : ""]
            .filter(Boolean)
            .join(" and ")} ask search engines not to index them.`,
      urls: noindexed.map((p) => p.url),
    });
  }

  const html = ok.filter(isHtmlPage);
  const titled = html.map((p) => ({ url: p.url, title: titleOf(p.html) }));
  const missingTitle = titled.filter((t) => !t.title || t.title.length === 0);
  if (missingTitle.length > 0) {
    findings.push({
      code: "title_missing",
      severity: "high",
      summary: `${missingTitle.length} page(s) have no title. The title is the headline a searcher sees before they ever reach the site.`,
      urls: missingTitle.map((t) => t.url),
    });
  }
  const byTitle = new Map<string, string[]>();
  for (const t of titled) {
    if (!t.title) continue;
    const key = t.title.toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), t.url]);
  }
  const dupes = [...byTitle.values()].filter((urls) => urls.length > 1);
  if (dupes.length > 0) {
    findings.push({
      code: "title_duplicate",
      severity: "high",
      summary:
        "Different pages share the same title, so search engines cannot tell which one answers which query. This is the most common reason a real page never ranks.",
      urls: dupes.flat(),
    });
  }

  const missingDesc = html.filter((p) => !metaDescriptionOf(p.html));
  if (missingDesc.length > 0) {
    findings.push({
      code: "meta_description_missing",
      severity: "medium",
      summary: `${missingDesc.length} page(s) have no meta description, so the search result snippet is whatever Google decides to quote.`,
      urls: missingDesc.map((p) => p.url),
    });
  }

  const noH1 = html.filter((p) => h1CountOf(p.html) === 0);
  if (noH1.length > 0) {
    findings.push({
      code: "h1_missing",
      severity: "medium",
      summary: `${noH1.length} page(s) have no H1 heading.`,
      urls: noH1.map((p) => p.url),
    });
  }

  const manyH1 = html.filter((p) => h1CountOf(p.html) > 1);
  if (manyH1.length > 0) {
    findings.push({
      code: "h1_multiple",
      severity: "medium",
      summary: `${manyH1.length} page(s) have more than one H1 heading, so the page does not say which one thing it is about.`,
      urls: manyH1.map((p) => p.url),
    });
  }

  const longTitle = titled.filter((t) => t.title && decodeEntities(t.title).length > TITLE_MAX_CHARS);
  if (longTitle.length > 0) {
    findings.push({
      code: "title_too_long",
      severity: "low",
      summary: `${longTitle.length} page(s) have a title over ${TITLE_MAX_CHARS} characters, which search results often cut off.`,
      urls: longTitle.map((t) => t.url),
    });
  }

  const shells = html.filter((p) => visibleWordCount(p.html) < SHELL_WORD_FLOOR);
  if (shells.length > 0) {
    findings.push({
      code: "thin_server_html",
      severity: "high",
      summary:
        `${shells.length} page(s) returned almost no readable text in the HTML itself (under ${SHELL_WORD_FLOOR} words). ` +
        "That usually means the content is rendered by JavaScript after load. We cannot tell from one fetch whether search engines see it, so this is worth checking rather than assuming it is broken.",
      urls: shells.map((p) => p.url),
    });
  }

  if (input.robots.fetched && input.robots.sitemaps.length === 0 && input.sitemapReachable !== true) {
    findings.push({
      code: "sitemap_missing",
      severity: "medium",
      summary:
        "No sitemap is declared in robots.txt and none was found at the usual location, so search engines have to discover every page by following links.",
      urls: ["/robots.txt"],
    });
  }

  const withSchema = html.filter((p) => schemaTypesOf(p.html).length > 0);
  const readFully = html.filter((p) => !p.truncated);
  if (readFully.length > 0 && withSchema.length === 0) {
    findings.push({
      code: "schema_absent",
      severity: "medium",
      summary:
        `No structured data (Schema.org JSON-LD) was found on any page ${readFully.length < html.length ? "we read in full" : "checked"}. Structured data is what lets a result show ratings, prices, or FAQs instead of a plain blue link.`,
      urls: readFully.map((p) => p.url),
    });
  }

  if (withSchema.length > 0) {
    const bare = readFully.filter((p) => schemaTypesOf(p.html).length === 0);
    if (bare.length > 0) {
      findings.push({
        code: "schema_missing_page",
        severity: "low",
        summary: `${bare.length} page(s) carry no structured data, while other pages on the site do.`,
        urls: bare.map((p) => p.url),
      });
    }
  }

  return {
    pages_analyzed: ok.length,
    non_html_urls: ok.filter((p) => !isHtmlPage(p)).map((p) => p.url),
    findings,
    pages: html.map((p) => {
      const raw = titleOf(p.html);
      const title = raw === null ? null : decodeEntities(raw);
      const description = metaDescriptionOf(p.html);
      return {
        url: p.url,
        status: p.status,
        title,
        title_length: title ? title.length : null,
        meta_description: description === null ? null : decodeEntities(description),
        canonical: canonicalOf(p.html),
        h1_count: h1CountOf(p.html),
        schema_types: schemaTypesOf(p.html),
        noindex: isNoindex(p),
        visible_words: visibleWordCount(p.html),
        ...(p.truncated ? { truncated: true } : {}),
      };
    }),
  };
}
