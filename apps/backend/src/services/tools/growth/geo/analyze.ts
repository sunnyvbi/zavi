
import { isHtmlPage, schemaTypesOf, stripTags, uniqueByLanding, visibleWordCount } from "../seo/analyze";
import type { FetchedPage } from "../seo/analyze";
import robotsParser from "robots-parser";
import { AI_BOTS, type BotClass } from "./bots";

type Robot = ReturnType<typeof robotsParser>;

export type GeoSeverity = "blocker" | "high" | "medium";

export type GeoFinding = {
  code: string;
  severity: GeoSeverity;
  summary: string;
  urls: string[];
};

export type AiCrawler = {
  name: string;
  owner: string;
  class: BotClass;
  obeys_robots: boolean;
  recommended: boolean;
  caveat?: string;
};

export const AI_CRAWLERS: AiCrawler[] = AI_BOTS.map((b) => ({
  name: b.name,
  owner: b.owner,
  class: b.class,
  obeys_robots: b.obeys_robots,
  recommended: b.recommended,
  ...(b.caveat ? { caveat: b.caveat } : {}),
}));

export type CrawlerState = "allowed" | "blocked" | "partial" | "unknown";

export type CrawlerAccess = AiCrawler & {
  state: CrawlerState;
  directive: string | null;
  from_wildcard: boolean;
  disallowed_paths?: string[];
  public_blocked?: string[];
};

export type RobotsGroup = {
  agents: string[];
  disallow: string[];
  allow: string[];
};

export function parseRobotsGroups(body: string | null): RobotsGroup[] {
  if (body === null) return [];
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      const agent = value.toLowerCase().split("/")[0].trim();
      if (agent.length > 0) current.agents.push(agent);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "disallow" || key === "allow") {
      if (!current) continue;
      (key === "disallow" ? current.disallow : current.allow).push(value);
    }
  }
  return groups;
}

export const PRIVATE_PATH =
  /^\/(admin|wp-admin|login|signin|account|cart|checkout|api|search|private|dashboard|auth)\b/i;

const ROBOTS_ORIGIN = "https://robots.invalid";

export type SitemapEvidence = { paths: string[]; complete: boolean };
const NO_SITEMAP: SitemapEvidence = { paths: [], complete: false };
const MAX_SITEMAP_PATHS = 5000;
const SITEMAP_SAMPLE_FLOOR = 500;
const urlOf = (path: string): string => ROBOTS_ORIGIN + (path.startsWith("/") ? path : `/${path}`);
const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return "/";
  }
};
const probeOf = (pattern: string): string => pattern.split(/[*$]/)[0] || "/";

function decidingLine(robots: Robot, lines: string[], path: string, ua: string): string | null {
  const n = robots.getMatchingLineNumber(urlOf(path), ua);
  if (n < 1) return null;
  const line = (lines[n - 1] ?? "").replace(/#.*$/, "").trim();
  return line.length > 0 ? line : null;
}

function verdictOf(
  robots: Robot,
  lines: string[],
  group: RobotsGroup,
  ua: string,
  samplePaths: string[],
  sitemap: SitemapEvidence,
): { state: CrawlerState; directive: string | null; paths?: string[]; publicBlocked?: string[] } {
  const closed = (path: string) => robots.isDisallowed(urlOf(path), ua) === true;

  const probes = ["/", ...samplePaths, ...group.allow.filter((a) => a.length > 0).map(probeOf)];
  if (probes.every(closed)) {
    return { state: "blocked", directive: decidingLine(robots, lines, "/", ua) };
  }

  const real = [...new Set(group.disallow.filter((d) => d.length > 0))].filter((d) =>
    closed(probeOf(d)),
  );
  if (real.length > 0) {
    const ordered = [
      ...real.filter((d) => !PRIVATE_PATH.test(d)),
      ...real.filter((d) => PRIVATE_PATH.test(d)),
    ];
    const published = [...new Set([...sitemap.paths, ...samplePaths])];
    const listed = published.filter((p) => !PRIVATE_PATH.test(p) && closed(p));
    const byName = real.filter((d) => !PRIVATE_PATH.test(d));
    const useSitemap =
      sitemap.paths.length > 0 &&
      (listed.length > 0 || sitemap.complete || sitemap.paths.length >= SITEMAP_SAMPLE_FLOOR);
    const publicBlocked = (useSitemap ? listed : byName.map(probeOf)).slice(0, 5);
    const quoted = publicBlocked[0] ?? probeOf(real[0]);
    return {
      state: "partial",
      directive: decidingLine(robots, lines, quoted, ua),
      paths: ordered.slice(0, 5),
      publicBlocked: useSitemap ? publicBlocked : byName.slice(0, 5),
    };
  }

  const directive =
    decidingLine(robots, lines, "/", ua) ?? (group.disallow.includes("") ? "Disallow:" : null);
  return { state: "allowed", directive };
}

export function resolveCrawlerAccess(
  body: string | null,
  robotsFetched: boolean,
  samplePaths: string[] = [],
  sitemap: SitemapEvidence = NO_SITEMAP,
): CrawlerAccess[] {
  const groups = parseRobotsGroups(body);
  const robots = robotsParser(`${ROBOTS_ORIGIN}/robots.txt`, body ?? "");
  const lines = (body ?? "").split(/\r\n|\r|\n/);
  const merged = (agent: string): RobotsGroup | null => {
    const hits = groups.filter((g) => g.agents.includes(agent));
    if (hits.length === 0) return null;
    return {
      agents: [agent],
      disallow: hits.flatMap((g) => g.disallow),
      allow: hits.flatMap((g) => g.allow),
    };
  };
  const wildcard = merged("*");

  return AI_CRAWLERS.map((c) => {
    if (!robotsFetched) {
      return { ...c, state: "unknown" as const, directive: null, from_wildcard: false };
    }
    const ua = c.name.toLowerCase();
    const named = merged(ua);
    const group = named ?? wildcard;
    if (!group) {
      return { ...c, state: "allowed" as const, directive: null, from_wildcard: false };
    }
    const { state, directive, paths, publicBlocked } = verdictOf(robots, lines, group, ua, samplePaths, sitemap);
    return {
      ...c,
      state,
      directive,
      from_wildcard: named === null,
      ...(paths ? { disallowed_paths: paths } : {}),
      ...(publicBlocked ? { public_blocked: publicBlocked } : {}),
    };
  });
}

const BLOCK_SPLIT =
  /<\/?(?:p|div|section|article|main|header|footer|aside|li|ul|ol|table|tr|td|th|h[1-6]|br|blockquote|figure|figcaption|nav)\b[^>]*>/gi;

export function textBlocksOf(html: string): string[] {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .split(BLOCK_SPLIT)
    .map((b) => stripTags(b))
    .filter((b) => b.length > 0);
}

const wordsIn = (s: string): number => (s.trim() === "" ? 0 : s.trim().split(/\s+/).length);

export type Heading = { level: number; text: string };

export function headingsOf(html: string): Heading[] {
  const out: Heading[] = [];
  for (const m of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = stripTags(m[2]);
    if (text.length > 0) out.push({ level: Number(m[1]), text });
  }
  return out;
}

const QUESTION_OPENERS =
  /^(how|what|why|when|where|which|who|whom|whose|can|could|do|does|did|is|are|was|were|should|will|would|"?is\b)/i;

export function isQuestionHeading(text: string): boolean {
  const t = text.trim();
  return t.endsWith("?") || QUESTION_OPENERS.test(t);
}

export function headingSkips(headings: Heading[]): number {
  let skips = 0;
  let prev = 0;
  for (const h of headings) {
    if (prev > 0 && h.level > prev + 1) skips++;
    prev = h.level;
  }
  return skips;
}

const FIGURE = /(\d+(?:\.\d+)?\s?%|[$£€]\s?\d|(?:^|\s)\d{2,}(?:[,.]\d+)*(?:\s|$))/;

export function figureSentences(text: string): number {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => FIGURE.test(s)).length;
}

const DEFINITION = /\b\w[\w\s'-]{1,60}\s+(?:is|are|refers to|means|stands for)\s+(?:an?|the|a\s|any|when|not)\b/i;

export const LEAD_MIN_WORDS = 40;
export const PASSAGE_BAND: readonly [number, number] = [100, 220];
export const SSR_WORD_FLOOR = 60;
export const LEAD_ZONE = 0.3;
export const STALE_DAYS = 180;

export type GeoPageFact = {
  url: string;
  visible_words: number;
  server_rendered: boolean;
  lead_passage_words: number | null;
  lead_in_band: boolean;
  definition_lead: boolean;
  figure_sentences: number;
  h1_count: number;
  heading_count: number;
  question_headings: number;
  heading_skips: number;
  avg_paragraph_words: number | null;
  tables: number;
  lists: number;
  images: number;
  images_with_alt: number;
  media_embeds: number;
  has_author: boolean;
  published_at: string | null;
  updated_at: string | null;
  age_days: number | null;
  schema_types: string[];
  outbound_citations: number;
  truncated: boolean;
};

const AUTHOR_HINT =
  /(?:rel=["']author["']|itemprop=["']author["']|class=["'][^"']*\b(?:author|byline)\b[^"']*["']|\bby\s+[A-Z][a-z]+\s+[A-Z][a-z]+)/;

function jsonLdDates(html: string): { published: string | null; updated: string | null } {
  let published: string | null = null;
  let updated: string | null = null;
  for (const m of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (typeof o.datePublished === "string" && !published) published = o.datePublished;
      if (typeof o.dateModified === "string" && !updated) updated = o.dateModified;
      for (const v of Object.values(o)) visit(v);
    };
    visit(parsed);
  }
  return { published, updated };
}

function timeElementDate(html: string): string | null {
  const m = /<time[^>]+datetime=["']([^"']+)["']/i.exec(html);
  return m ? m[1] : null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function outboundCitations(html: string, url: string): number {
  const self = originOf(url);
  const hosts = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]+href=["'](https?:\/\/[^"']+)["']/gi)) {
    const h = originOf(m[1]);
    if (h && h !== self) hosts.add(h);
  }
  return hosts.size;
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

export function analyzePage(page: FetchedPage, now: number): GeoPageFact {
  const html = page.html;
  const blocks = textBlocksOf(html);
  const totalWords = blocks.reduce((n, b) => n + wordsIn(b), 0);
  const leadBudget = Math.max(1, Math.floor(totalWords * LEAD_ZONE));

  let seen = 0;
  let leadPassage: string | null = null;
  for (const b of blocks) {
    const w = wordsIn(b);
    if (leadPassage === null && w >= LEAD_MIN_WORDS) leadPassage = b;
    seen += w;
    if (seen >= leadBudget) break;
  }
  const leadWords = leadPassage ? wordsIn(leadPassage) : null;

  const headings = headingsOf(html);
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => wordsIn(stripTags(m[1])))
    .filter((w) => w > 0);

  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const ld = jsonLdDates(html);
  const published = ld.published ?? timeElementDate(html);
  const updated = ld.updated;
  const schema_types = schemaTypesOf(html);

  return {
    url: page.url,
    visible_words: visibleWordCount(html),
    server_rendered: visibleWordCount(html) >= SSR_WORD_FLOOR,
    lead_passage_words: leadWords,
    lead_in_band:
      leadWords !== null && leadWords >= PASSAGE_BAND[0] && leadWords <= PASSAGE_BAND[1],
    definition_lead: leadPassage !== null && DEFINITION.test(leadPassage),
    figure_sentences: figureSentences(blocks.join(" ")),
    h1_count: headings.filter((h) => h.level === 1).length,
    heading_count: headings.length,
    question_headings: headings.filter((h) => isQuestionHeading(h.text)).length,
    heading_skips: headingSkips(headings),
    avg_paragraph_words:
      paragraphs.length > 0
        ? Math.round(paragraphs.reduce((a, b) => a + b, 0) / paragraphs.length)
        : null,
    tables: [...html.matchAll(/<table\b/gi)].length,
    lists: [...html.matchAll(/<[uo]l\b/gi)].length,
    images: images.length,
    images_with_alt: images.filter((t) => /\balt=["'][^"']+["']/i.test(t)).length,
    media_embeds: [...html.matchAll(/<(?:video|iframe)\b/gi)].length,
    has_author: AUTHOR_HINT.test(html) || schema_types.includes("Person"),
    published_at: published,
    updated_at: updated,
    age_days: daysSince(updated ?? published, now),
    schema_types,
    outbound_citations: outboundCitations(html, page.url),
    truncated: page.truncated === true,
  };
}

export type GeoBand = {
  key: "citability" | "structure" | "multimodal" | "authority" | "technical";
  label: string;
  weight: number;
  score: number;
  note: string;
};

export type GeoScore = { total: number; bands: GeoBand[] };

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

function citabilityScore(p: GeoPageFact): number {
  return (
    (p.lead_passage_words !== null ? 40 : 0) +
    (p.lead_in_band ? 20 : 0) +
    (p.figure_sentences >= 2 ? 20 : p.figure_sentences === 1 ? 10 : 0) +
    (p.definition_lead ? 20 : 0)
  );
}

function structureScore(p: GeoPageFact): number {
  return (
    (p.h1_count === 1 ? 30 : 0) +
    (p.heading_count > 0 && p.heading_skips === 0 ? 20 : 0) +
    (p.question_headings > 0 ? 20 : 0) +
    (p.avg_paragraph_words !== null && p.avg_paragraph_words <= 90 ? 15 : 0) +
    (p.tables + p.lists > 0 ? 15 : 0)
  );
}

function multimodalScore(p: GeoPageFact): number {
  const alt = p.images > 0 ? p.images_with_alt / p.images : 0;
  return (
    (p.images > 0 ? 40 : 0) +
    (alt >= 0.8 ? 20 : alt >= 0.5 ? 10 : 0) +
    (p.media_embeds > 0 || p.tables > 0 ? 40 : 0)
  );
}

function authorityScore(p: GeoPageFact): number {
  return (
    (p.has_author ? 30 : 0) +
    (p.published_at && p.updated_at ? 30 : p.published_at || p.updated_at ? 15 : 0) +
    (p.age_days !== null && p.age_days <= STALE_DAYS ? 20 : 0) +
    (p.outbound_citations >= 2 ? 20 : p.outbound_citations === 1 ? 10 : 0)
  );
}

function technicalScore(pages: GeoPageFact[], crawlers: CrawlerAccess[]): number {
  const ssr = pages.length > 0 ? pages.filter((p) => p.server_rendered).length / pages.length : 0;
  const gate = crawlers.filter((c) => c.recommended);
  const open = gate.filter((c) => c.state === "allowed" || c.state === "partial").length;
  const access = gate.length > 0 ? open / gate.length : 0;
  const structured = pages.some((p) => p.schema_types.length > 0) ? 1 : 0;
  return 50 * ssr + 30 * access + 20 * structured;
}

export const READINESS_COMPLETENESS_FLOOR = 0.8;

export const READINESS_DISCLOSURE =
  "Our own heuristic, computed only from the pages we fetched this run. Useful for finding your own problems; not comparable across companies, and not a measure of how often AI answers cite you.";

export type GeoCompleteness = {
  planned: number;
  returned: number;
  ratio: number;
  below_floor: boolean;
  warning: string | null;
};

export type GeoReport = {
  pages_analyzed: number;
  score: GeoScore;
  completeness: GeoCompleteness;
  disclosure: string;
  crawlers: CrawlerAccess[];
  llms_txt: boolean | null;
  findings: GeoFinding[];
  pages: GeoPageFact[];
  not_checked: string[];
};

export type GeoAuditInput = {
  pages: FetchedPage[];
  robotsBody: string | null;
  robotsFetched: boolean;
  llmsTxt: boolean | null;
  pagesPlanned?: number;
  sitemapPaths?: string[];
  sitemapComplete?: boolean;
  now?: number;
};

export function completenessOf(input: {
  pagesPlanned: number;
  pagesReturned: number;
  robotsFetched: boolean;
  llmsTxt: boolean | null;
}): GeoCompleteness {
  const planned = Math.max(0, input.pagesPlanned) + 2;
  const returned =
    Math.min(input.pagesReturned, Math.max(0, input.pagesPlanned)) +
    (input.robotsFetched ? 1 : 0) +
    (input.llmsTxt !== null ? 1 : 0);
  const ratio = planned === 0 ? 0 : Math.round((returned / planned) * 100) / 100;
  const below_floor = ratio < READINESS_COMPLETENESS_FLOOR;
  return {
    planned,
    returned,
    ratio,
    below_floor,
    warning: below_floor
      ? `Only ${returned} of ${planned} planned checks came back, so this score rests on less of the site than it should. Treat it as partial.`
      : null,
  };
}

export function analyzeGeo(input: GeoAuditInput): GeoReport {
  const now = input.now ?? Date.now();
  const readable = input.pages.filter((p) => p.status >= 200 && p.status < 300 && p.html.length > 0);
  const ok = uniqueByLanding(readable);
  const facts = ok.filter(isHtmlPage).map((p) => analyzePage(p, now));
  const crawlers = resolveCrawlerAccess(
    input.robotsBody,
    input.robotsFetched,
    ok.map((p) => pathOf(p.url)),
    {
      paths: (input.sitemapPaths ?? []).slice(0, MAX_SITEMAP_PATHS),
      complete: (input.sitemapComplete ?? false) && (input.sitemapPaths ?? []).length <= MAX_SITEMAP_PATHS,
    },
  );
  const findings: GeoFinding[] = [];

  const blocked = crawlers.filter((c) => c.recommended && c.state === "blocked");
  if (blocked.length > 0) {
    findings.push({
      code: "ai_crawler_blocked",
      severity: "blocker",
      summary:
        `robots.txt blocks ${blocked.map((c) => c.name).join(", ")} from the whole site. ` +
        "These are the search crawlers that fetch pages to cite in AI answers, so nothing here can be cited by them until that line is removed.",
      urls: ["/robots.txt"],
    });
  }

  const partly = crawlers
    .filter((c) => c.recommended && c.state === "partial")
    .map((c) => ({ c, paths: c.public_blocked ?? [] }))
    .filter((x) => x.paths.length > 0);
  if (partly.length > 0) {
    const byPaths = new Map<string, string[]>();
    for (const x of partly) {
      const key = x.paths.join(", ");
      byPaths.set(key, [...(byPaths.get(key) ?? []), x.c.name]);
    }
    const clauses = [...byPaths].map(([paths, bots]) => `${bots.join(", ")} out of ${paths}`);
    const wildcard = partly.every((x) => x.c.from_wildcard);
    const named = partly.every((x) => !x.c.from_wildcard);
    const source = wildcard
      ? "a rule for every bot"
      : named
        ? partly.length === 1
          ? "a rule written for that bot"
          : "rules written for those bots"
        : "a rule for every bot and rules written for specific bots";
    findings.push({
      code: "ai_crawler_partly_blocked",
      severity: "medium",
      summary:
        `robots.txt keeps ${clauses.join("; ")} (${source}). ` +
        "If those pages should be cited in AI answers, whoever edits your site removes that Disallow line from /robots.txt; private areas like /admin are fine to keep blocked.",
      urls: ["/robots.txt"],
    });
  }

  const shells = facts.filter((p) => !p.server_rendered);
  if (shells.length > 0) {
    findings.push({
      code: "geo_not_server_rendered",
      severity: "blocker",
      summary:
        `${shells.length} of ${facts.length} page(s) returned almost no readable text without JavaScript. ` +
        "AI crawlers do not execute JavaScript, so whatever only appears after load is content they cannot cite. This outranks everything below it.",
      urls: shells.map((p) => p.url),
    });
  }

  const noLead = facts.filter((p) => p.server_rendered && p.lead_passage_words === null);
  if (noLead.length > 0) {
    findings.push({
      code: "no_lead_passage",
      severity: "high",
      summary:
        `${noLead.length} page(s) have no self-contained passage of ${LEAD_MIN_WORDS}+ words in their first third. ` +
        "AI answers lift whole blocks; a page assembled from one-line fragments gives them nothing to quote.",
      urls: noLead.map((p) => p.url),
    });
  }

  const noQuestions = facts.filter((p) => p.heading_count > 0 && p.question_headings === 0);
  if (noQuestions.length > 0) {
    findings.push({
      code: "headings_not_questions",
      severity: "medium",
      summary:
        `${noQuestions.length} page(s) have no question-form heading. Headings phrased as the question a buyer types are what an answer engine matches against.`,
      urls: noQuestions.map((p) => p.url),
    });
  }

  const noFigures = facts.filter((p) => p.server_rendered && p.figure_sentences === 0);
  if (noFigures.length > 0) {
    findings.push({
      code: "no_specific_figures",
      severity: "medium",
      summary:
        `${noFigures.length} page(s) state no specific figure. Answer engines prefer passages carrying a checkable number over general claims.`,
      urls: noFigures.map((p) => p.url),
    });
  }

  const readFully = facts.filter((p) => !p.truncated);
  const partialNote = readFully.length < facts.length ? " we read in full" : " checked";

  const undated = readFully.filter((p) => !p.published_at && !p.updated_at);
  if (undated.length > 0) {
    findings.push({
      code: "no_visible_dates",
      severity: "medium",
      summary:
        `${undated.length} page(s) carry no published or last-updated date in the HTML. Recency is one of the strongest AI-citation signals, and an undated page cannot demonstrate it.`,
      urls: undated.map((p) => p.url),
    });
  }
  const stale = facts.filter((p) => p.age_days !== null && p.age_days > STALE_DAYS);
  if (stale.length > 0) {
    findings.push({
      code: "content_stale",
      severity: "medium",
      summary:
        `${stale.length} page(s) were last updated more than ${STALE_DAYS} days ago. Pages stale past six months lose citation eligibility; a refresh cadence is one of the highest-return plays available here.`,
      urls: stale.map((p) => p.url),
    });
  }
  if (readFully.length > 0 && facts.every((p) => !p.has_author)) {
    findings.push({
      code: "no_author_signal",
      severity: "medium",
      summary:
        `No author byline or Person structured data was found on any page${partialNote}. Attributed authorship is part of how an answer engine decides a source is worth citing.`,
      urls: readFully.map((p) => p.url),
    });
  }

  if (readFully.length > 0 && facts.every((p) => p.schema_types.length === 0)) {
    findings.push({
      code: "no_schema_server_rendered",
      severity: "medium",
      summary:
        `No structured data was present in the server-rendered HTML of any page${partialNote}. Structured data is how an answer engine resolves a page to a real entity. Some CMSs add it with JavaScript, which this read cannot see — Google's Rich Results Test settles it either way.`,
      urls: readFully.map((p) => p.url),
    });
  }

  const bands: GeoBand[] = [
    {
      key: "citability",
      label: "Passage citability",
      weight: 25,
      score: clamp(mean(facts.map(citabilityScore))),
      note: "Is there a self-contained answer, near the top, carrying specific figures?",
    },
    {
      key: "structure",
      label: "Structural readability",
      weight: 20,
      score: clamp(mean(facts.map(structureScore))),
      note: "One H1, no skipped heading levels, question-form headings, short paragraphs.",
    },
    {
      key: "multimodal",
      label: "Multi-modal content",
      weight: 15,
      score: clamp(mean(facts.map(multimodalScore))),
      note: "Images with alt text, video or tables alongside the prose.",
    },
    {
      key: "authority",
      label: "Authority signals",
      weight: 20,
      score: clamp(mean(facts.map(authorityScore))),
      note: "Named author, visible dates, recency, and links to primary sources.",
    },
    {
      key: "technical",
      label: "Technical accessibility",
      weight: 20,
      score: clamp(technicalScore(facts, crawlers)),
      note: "Content survives a JavaScript-free fetch, AI crawlers are admitted, entities are declared.",
    },
  ];

  const total =
    facts.length === 0
      ? 0
      : clamp(bands.reduce((sum, b) => sum + (b.score * b.weight) / 100, 0));

  const not_checked = [
    "Whether you are actually cited in AI Overviews, AI Mode, ChatGPT or Perplexity. No API from anyone returns that — this panel measures readiness, never visibility.",
    "Off-site entity presence (Wikipedia, Reddit, YouTube, LinkedIn). Brand mentions correlate far more strongly with AI citation than backlinks do; ask the SEO agent in chat to check them.",
    "Anything your site renders with JavaScript. This read runs JS-free on purpose, because that is what an AI crawler sees.",
  ];
  if (facts.length > 0) {
    not_checked.push(
      `Every page beyond the ${facts.length} fetched here. Findings describe those pages, not the whole site.`,
    );
  }
  if (!input.robotsFetched) {
    not_checked.push(
      "Which AI crawlers you admit — robots.txt could not be read, and that is not the same as 'everything is allowed'.",
    );
  }
  const cutOff = facts.length - readFully.length;
  if (cutOff > 0) {
    not_checked.push(
      `The rest of ${cutOff} very large page(s): they passed our read limit, so only their first part was read. Nothing here claims those pages lack structured data, dates or an author.`,
    );
  }

  return {
    pages_analyzed: ok.length,
    score: { total, bands },
    completeness: completenessOf({
      pagesPlanned: input.pagesPlanned ?? input.pages.length,
      pagesReturned: readable.length,
      robotsFetched: input.robotsFetched,
      llmsTxt: input.llmsTxt,
    }),
    disclosure: READINESS_DISCLOSURE,
    crawlers,
    llms_txt: input.llmsTxt,
    findings,
    pages: facts,
    not_checked,
  };
}
