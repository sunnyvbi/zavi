
import { assertSafeUrl, SsrfBlockedError } from "@/services/onboarding/enrichment/url-guard";
import {
  MAX_INDEX_CHILDREN,
  MAX_REDIRECT_HOPS,
  MAX_ROBOTS_SITEMAPS,
  MAX_SITEMAP_BYTES,
  MAX_SITEMAP_ENTRIES,
  parseSitemap,
  safeFetchText,
} from "@/services/onboarding/enrichment/discover";
import { companyWebsiteHost } from "@/services/onboarding/enrichment/domain-host";
import type { FetchedPage, RobotsFacts } from "./analyze";
import { parseRobots } from "./analyze";
import { isLoginPath, normPath } from "./site-graph";

export const PER_REQUEST_TIMEOUT_MS = 8_000;
export const TOTAL_WALL_CLOCK_MS = 25_000;
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_PAGES = 24;
const MAX_PAGES_CAP = MAX_PAGES;

export const FETCH_CONCURRENCY = 6;

export const SITEMAP_WALL_MS = 6_000;

export const MAX_SITEMAP_URLS_CONSIDERED = 200;

export const SITEMAP_RESERVE_PAGES = 6;

export const DEFAULT_PATHS = ["/", "/pricing", "/about", "/blog", "/features", "/contact"];

export const UA = "ZaviBot/1.0 (+https://www.zaviagent.com; read-only SEO audit)";

export const MAX_CRAWL_DELAY_MS = 10_000;
export const THROTTLED_SPACING_MS = 1_000;
export const THROTTLE_BACKOFF_MS = [1_000, 3_000];
export const MAX_RETRY_WAIT_MS = 10_000;
export const PACED_WALL_CLOCK_MS = 45_000;
const THROTTLE_STATUSES = new Set([429, 503]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type Pacer = {
  slowTo(ms: number): void;
  readonly intervalMs: number;
  throttled: boolean;
  wait(deadline: number): Promise<boolean>;
};

export function createPacer(intervalMs = 0): Pacer {
  let interval = Math.max(0, intervalMs);
  let nextAt = 0;
  let lastStart: number | null = null;
  return {
    throttled: false,
    slowTo(ms) {
      interval = Math.max(interval, ms);
      if (lastStart !== null) nextAt = Math.max(nextAt, lastStart + interval);
    },
    get intervalMs() {
      return interval;
    },
    async wait(deadline) {
      const now = Date.now();
      if (interval <= 0) {
        lastStart = now;
        return true;
      }
      const at = Math.max(now, nextAt);
      if (at >= deadline) return false;
      nextAt = at + interval;
      lastStart = at;
      if (at > now) await sleep(at - now);
      return true;
    },
  };
}

export function parseCrawlDelayMs(body: string | null): number {
  if (!body) return 0;
  let agents: string[] = [];
  let inAgentRun = false;
  let star: number | null = null;
  let ours: number | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    if (k === "user-agent") {
      if (!inAgentRun) agents = [];
      agents.push(v.toLowerCase());
      inAgentRun = true;
      continue;
    }
    inAgentRun = false;
    if (k !== "crawl-delay") continue;
    const secs = Number(v);
    if (!Number.isFinite(secs) || secs <= 0) continue;
    if (agents.some((a) => a.includes("zavibot"))) ours = secs;
    else if (agents.includes("*")) star = secs;
  }
  const secs = ours ?? star ?? 0;
  return Math.min(Math.round(secs * 1000), MAX_CRAWL_DELAY_MS);
}

export function retryAfterMs(value: string | undefined): number | null {
  if (!value) return null;
  const secs = Number(value.trim());
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 : null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

type CappedResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  finalUrl?: string;
};

async function getCapped(
  url: string,
  deadline: number,
  pacer: Pacer = createPacer(),
): Promise<CappedResponse | null> {
  const r = await getPaced(url, deadline, pacer);
  return r === NO_SLOT ? null : r;
}

const NO_SLOT = Symbol("no_slot");

async function getPaced(
  url: string,
  deadline: number,
  pacer: Pacer,
): Promise<CappedResponse | null | typeof NO_SLOT> {
  let last: CappedResponse | null = null;
  for (let attempt = 0; ; attempt++) {
    if (!(await pacer.wait(deadline))) return last ?? NO_SLOT;
    const r = await getOnce(url, deadline);
    if (!r) return last;
    last = r;
    if (!THROTTLE_STATUSES.has(r.status)) return r;
    pacer.throttled = true;
    pacer.slowTo(THROTTLED_SPACING_MS);
    if (attempt >= THROTTLE_BACKOFF_MS.length) return r;
    const told = retryAfterMs(r.headers["retry-after"]);
    if (told !== null) pacer.slowTo(told);
    const wait = told ?? THROTTLE_BACKOFF_MS[attempt]!;
    if (wait > MAX_RETRY_WAIT_MS || Date.now() + wait >= deadline) return r;
    if (wait > 0) await sleep(wait);
  }
}

async function getOnce(url: string, deadline: number): Promise<CappedResponse | null> {
  const budget = Math.min(PER_REQUEST_TIMEOUT_MS, deadline - Date.now());
  if (budget <= 0) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budget);
  try {
    let currentUrl = url;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      try {
        await assertSafeUrl(currentUrl);
      } catch {
        return null;
      }
      res = await fetch(currentUrl, {
        signal: ac.signal,
        redirect: "manual",
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain,*/*" },
      });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get("location");
      if (!loc || hop === MAX_REDIRECT_HOPS) return null;
      try {
        currentUrl = new URL(loc, currentUrl).toString();
      } catch {
        return null;
      }
      res = null;
    }
    if (!res) return null;
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const finalUrl = currentUrl !== url ? currentUrl : undefined;

    const reader = res.body?.getReader();
    if (!reader) return { status: res.status, headers, body: "", truncated: false, finalUrl };
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - MAX_BYTES))));
        truncated = true;
        void reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return { status: res.status, headers, body: Buffer.concat(chunks).toString("utf-8"), truncated, finalUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const JSON_LD_ATTRS = /\btype\s*=\s*["']?application\/ld\+json/i;

export function compactHtml(html: string, truncated: boolean): string {
  let out = html
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attrs: string) =>
      JSON_LD_ATTRS.test(attrs) ? whole : `<script${attrs}></script>`,
    )
    .replace(/<style\b([^>]*)>[\s\S]*?<\/style>/gi, "<style$1></style>");
  if (truncated) {
    for (const tag of ["script", "style"]) {
      const open = out.toLowerCase().lastIndexOf(`<${tag}`);
      const close = out.toLowerCase().lastIndexOf(`</${tag}>`);
      if (open > close) out = out.slice(0, open);
    }
  }
  return out;
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function sameSite(host: string, originHost: string): boolean {
  const h = host.toLowerCase();
  if (h === originHost) return true;
  const root = companyWebsiteHost(originHost);
  return h === root || h === `www.${root}`;
}

function onSitePath(url: string, originHost: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (!sameSite(parsed.hostname, originHost)) return null;
  const path = parsed.pathname.replace(/\/{2,}/g, "/");
  return path.length > 0 ? path : "/";
}

const ASSET_PATH = /\.(?:pdf|png|jpe?g|gif|svg|webp|avif|ico|zip|gz|xml|txt|json|css|js|mjs|map|mp4|webm|mp3|wav|woff2?|ttf|csv|xlsx?|docx?|pptx?)$/i;

function isCrawlablePath(path: string): boolean {
  return !ASSET_PATH.test(path) && !isLoginPath(path);
}

export function isHtmlBody(headers: Record<string, string>, body: string): boolean {
  const head = body.trimStart().slice(0, 200).toLowerCase();
  if (/^<(?:!doctype html|html|head)[\s>]/.test(head)) return true;
  return String(headers["content-type"] ?? "").toLowerCase().includes("html") && head.startsWith("<");
}

const notSitemap = (body: string): boolean => isHtmlBody({}, body);

export function extractSameSiteLinks(html: string, pageUrl: string, originHost: string): string[] {
  const out = new Set<string>();
  let self: string | null = null;
  try {
    self = normPath(new URL(pageUrl).pathname);
  } catch {
    return [];
  }
  const re = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of html.matchAll(re)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? "").trim().replace(/&amp;/gi, "&");
    if (!href || href.startsWith("#")) continue;
    let abs: string;
    try {
      abs = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    const path = onSitePath(abs, originHost);
    if (path === null) continue;
    const norm = normPath(path);
    if (norm !== self) out.add(norm);
  }
  return [...out];
}

export function parseLlmsTxtPaths(body: string, base: string, originHost: string): string[] | null {
  if (/^\s*</.test(body)) return null;
  const out = new Set<string>();
  const candidates: string[] = [];
  for (const m of body.matchAll(/\]\(\s*([^)\s]+)/g)) candidates.push(m[1]);
  for (const m of body.matchAll(/https:\/\/[^\s)<>"'\]]+/g)) candidates.push(m[0]);
  for (const c of candidates) {
    let abs: string;
    try {
      abs = new URL(c, `${base}/`).toString();
    } catch {
      continue;
    }
    const path = onSitePath(abs, originHost);
    if (path !== null) out.add(normPath(path));
  }
  return [...out];
}

async function pathsFromSitemaps(
  base: string,
  originHost: string,
  declared: string[],
  wallDeadline: number,
  pacer: Pacer = createPacer(),
): Promise<{
  paths: string[];
  all: string[];
  queryOnly: string[];
  asWritten: string[];
  complete: boolean;
  reachable: boolean | null;
}> {
  const root = companyWebsiteHost(originHost);
  const onSite = (declared.length > 0 ? declared : [`${base}/sitemap.xml`]).filter(
    (u) => onSitePath(u, originHost) !== null,
  );
  const sources = onSite.slice(0, MAX_ROBOTS_SITEMAPS);

  let reachable: boolean | null = sources.length > 0 ? false : null;
  let complete = sources.length === onSite.length;
  const locs: string[] = [];
  let indexChildren = 0;

  const readWhole = (xml: string, found: string[]): boolean =>
    found.length < MAX_SITEMAP_ENTRIES && /<\/(?:urlset|sitemapindex)>\s*$/i.test(xml);

  for (const source of sources) {
    if (Date.now() >= wallDeadline) {
      complete = false;
      break;
    }
    const fetched = (await pacer.wait(wallDeadline))
      ? await safeFetchText(source, root, wallDeadline, MAX_SITEMAP_BYTES)
      : null;
    const xml = fetched && !notSitemap(fetched) ? fetched : null;
    if (!xml) {
      if (declared.length > 0) complete = false;
      continue;
    }
    reachable = true;
    const found = parseSitemap(xml);
    if (!readWhole(xml, found)) complete = false;
    if (/<sitemapindex[\s>]/i.test(xml)) {
      for (const child of found) {
        if (onSitePath(child, originHost) === null) continue;
        if (indexChildren >= MAX_INDEX_CHILDREN || Date.now() >= wallDeadline) {
          complete = false;
          break;
        }
        indexChildren++;
        const childXml = (await pacer.wait(wallDeadline))
          ? await safeFetchText(child, root, wallDeadline, MAX_SITEMAP_BYTES)
          : null;
        if (!childXml || notSitemap(childXml)) {
          complete = false;
          continue;
        }
        const childLocs = parseSitemap(childXml);
        if (!readWhole(childXml, childLocs)) complete = false;
        locs.push(...childLocs);
      }
    } else {
      locs.push(...found);
    }
  }

  const all = new Set<string>();
  const bare = new Set<string>();
  const asWritten = new Set<string>();
  for (const loc of locs) {
    const path = onSitePath(loc, originHost);
    if (path === null) continue;
    try {
      const u = new URL(loc);
      asWritten.add(u.pathname + u.search);
    } catch {
      asWritten.add(path);
    }
    all.add(normPath(path));
    if (!/\?./.test(loc)) bare.add(normPath(path));
  }
  const queryOnly = [...all].filter((p) => !bare.has(p));

  const bySection = new Map<string, string[]>();
  for (const loc of locs.slice(0, MAX_SITEMAP_URLS_CONSIDERED)) {
    if (/\?./.test(loc)) continue;
    const path = onSitePath(loc, originHost);
    if (path === null) continue;
    const norm = normPath(path);
    if (norm === "/") continue;
    const section = norm.split("/")[1] ?? "";
    const list = bySection.get(section) ?? [];
    if (!list.includes(norm)) list.push(norm);
    bySection.set(section, list);
  }
  const paths: string[] = [];
  const lists = [...bySection.values()];
  for (let round = 0; paths.length < MAX_PAGES && lists.some((l) => l.length > round); round++) {
    for (const l of lists) {
      if (round < l.length) paths.push(l[round]);
      if (paths.length >= MAX_PAGES) break;
    }
  }
  return {
    paths,
    all: [...all],
    queryOnly,
    asWritten: [...asWritten],
    complete: complete && reachable === true,
    reachable,
  };
}

export type SeoFetchResult = {
  pages: FetchedPage[];
  robots: RobotsFacts;
  robotsBody: string | null;
  sitemapReachable: boolean | null;
  llmsTxt: boolean | null;
  ssrf_blocked: number;
  truncated: boolean;
  pages_planned: number;
  crawl_delay_ms?: number;
  throttled?: boolean;
  graph: {
    sitemap_paths: string[];
    sitemap_query_only_paths: string[];
    sitemap_as_written: string[];
    sitemap_complete: boolean;
    llms_txt_paths: string[] | null;
    linked_paths: string[];
  };
};

export async function fetchForSeoAudit(
  origin: string,
  paths: string[] = DEFAULT_PATHS,
  opts: { maxPages?: number } = {},
): Promise<SeoFetchResult> {
  const MAX_PAGES = Math.max(1, Math.min(opts.maxPages ?? MAX_PAGES_CAP, MAX_PAGES_CAP));
  const startedAt = Date.now();
  let deadline = startedAt + TOTAL_WALL_CLOCK_MS;
  const base = origin.trim().replace(/\/+$/, "").replace(/^http:\/\//i, "https://");
  const pacer = createPacer();
  let root = base;
  try {
    root = new URL(base).origin;
  } catch {
  }
  let ssrf_blocked = 0;

  const safe = async (u: string): Promise<string | null> => {
    try {
      await assertSafeUrl(u);
      return u;
    } catch (e) {
      if (e instanceof SsrfBlockedError) ssrf_blocked++;
      return null;
    }
  };

  let robots: RobotsFacts = { fetched: false, disallowsAll: false, sitemaps: [] };
  let robotsBody: string | null = null;
  const robotsUrl = await safe(`${root}/robots.txt`);
  if (robotsUrl) {
    const r = await getCapped(robotsUrl, deadline, pacer);
    robotsBody = r && r.status >= 200 && r.status < 300 && !isHtmlBody(r.headers, r.body) ? r.body : null;
    robots = parseRobots(robotsBody);
  }
  const crawlDelayMs = parseCrawlDelayMs(robotsBody);
  if (crawlDelayMs > 0) {
    pacer.slowTo(crawlDelayMs);
    deadline = startedAt + PACED_WALL_CLOCK_MS;
  }

  let llmsTxt: boolean | null = null;
  let llmsBody: string | null = null;
  const llmsUrl = await safe(`${root}/llms.txt`);
  if (llmsUrl) {
    const r = await getCapped(llmsUrl, deadline, pacer);
    llmsTxt = r !== null && r.status >= 200 && r.status < 300 && !isHtmlBody(r.headers, r.body);
    if (llmsTxt && r) llmsBody = r.body;
  }

  let sitemapReachable: boolean | null = null;
  let sitemapPaths: string[] = [];
  let sitemapAll: string[] = [];
  let sitemapQueryOnly: string[] = [];
  let sitemapAsWritten: string[] = [];
  let sitemapComplete = false;
  const originHost = hostOf(base);
  if (originHost) {
    const sm = await pathsFromSitemaps(
      root,
      originHost,
      robots.sitemaps,
      Math.min(deadline, Date.now() + SITEMAP_WALL_MS + pacer.intervalMs),
      pacer,
    );
    sitemapPaths = sm.paths;
    sitemapAll = sm.all;
    sitemapQueryOnly = sm.queryOnly;
    sitemapAsWritten = sm.asWritten;
    sitemapComplete = sm.complete;
    sitemapReachable = sm.reachable;
  }
  const llmsPaths =
    llmsBody !== null && originHost ? parseLlmsTxtPaths(llmsBody, root, originHost) : null;

  const sitemapSet = new Set(sitemapAll);
  const requested = paths.filter((p) => !DEFAULT_PATHS.includes(p)).map(normPath);
  const rest = [...sitemapPaths, ...(sitemapReachable === true ? [] : paths.map(normPath))];
  const discovered: string[] = [];
  const claimed = new Set<string>();
  const linked = new Set<string>();
  const discoveredBudget = MAX_PAGES - 1 - Math.min(sitemapPaths.length, SITEMAP_RESERVE_PAGES);
  let discoveredTaken = 0;

  const offer = (path: string): void => {
    if (sitemapSet.has(path) || claimed.has(path) || !isCrawlablePath(path)) return;
    if (!discovered.includes(path)) discovered.push(path);
  };
  for (const p of llmsPaths ?? []) offer(p);

  const take = (q: string[]): string | null => {
    while (q.length > 0) {
      const p = q.shift() as string;
      if (!claimed.has(p)) return p;
    }
    return null;
  };
  const next = (): string | null => {
    if (claimed.size >= MAX_PAGES) return null;
    let p = take(requested);
    if (p === null && discoveredTaken < discoveredBudget) {
      p = take(discovered);
      if (p !== null) discoveredTaken++;
    }
    if (p === null) p = take(rest);
    if (p === null) p = take(discovered);
    if (p !== null) claimed.add(p);
    return p;
  };
  const pending = (): number =>
    new Set([...requested, ...discovered, ...rest].filter((p) => !claimed.has(p))).size;

  const order: string[] = [];
  const results = new Map<string, FetchedPage>();
  let truncated = false;

  async function visit(path: string): Promise<void> {
    const u = await safe(path === "/" ? `${base}/` : `${root}${path}`);
    if (!u) return;
    const r = await getPaced(u, deadline, pacer);
    if (r === NO_SLOT) {
      truncated = true;
      return;
    }
    const page: FetchedPage = {
      url: u,
      status: r?.status ?? 0,
      headers: r?.headers ?? {},
      html: compactHtml(r?.body ?? "", r?.truncated ?? false),
      truncated: r?.truncated ?? false,
      ...(r?.finalUrl ? { final_url: r.finalUrl } : {}),
    };
    results.set(path, page);
    if (originHost && r && r.status >= 200 && r.status < 300) {
      for (const l of extractSameSiteLinks(page.html, r.finalUrl ?? u, originHost)) {
        linked.add(l);
        offer(l);
      }
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() >= deadline) {
        if (claimed.size < MAX_PAGES && pending() > 0) truncated = true;
        return;
      }
      const p = next();
      if (p === null) return;
      order.push(p);
      await visit(p);
    }
  }

  claimed.add("/");
  order.push("/");
  await visit("/");
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => worker()));

  const pages = order
    .map((p) => results.get(p))
    .filter((p): p is FetchedPage => p !== undefined);

  return {
    pages,
    robots,
    robotsBody,
    sitemapReachable,
    llmsTxt,
    ssrf_blocked,
    truncated,
    pages_planned: Math.min(MAX_PAGES, claimed.size + pending()),
    crawl_delay_ms: crawlDelayMs,
    throttled: pacer.throttled,
    graph: {
      sitemap_paths: sitemapAll,
      sitemap_query_only_paths: sitemapQueryOnly,
      sitemap_as_written: sitemapAsWritten,
      sitemap_complete: sitemapComplete,
      llms_txt_paths: llmsPaths,
      linked_paths: [...linked],
    },
  };
}
