
import { companyWebsiteHost } from "./domain-host";
import { sanitizeFetchedContent, xmlEscapeContent } from "./sanitize";
import { assertSafeUrl, SsrfBlockedError } from "./url-guard";
import type { DomainPage } from "./types";
import { discoverUrls } from "./discover";

const PATH_ALLOWLIST: readonly string[] = [
  "/",
  "/about",
  "/about-us",
  "/pricing",
  "/faq",
  "/help",
  "/help-center",
  "/support",
  "/contact",
  "/terms",
  "/privacy",
  "/refunds",
  "/policies/refund-policy",
] as const;

export const PER_PAGE_TIMEOUT_MS = 8_000;
export const TOTAL_WALL_CLOCK_MS = 30_000;
export const MAX_BYTES_PER_PAGE = 1024 * 1024;
export const EXCERPT_MAX_CHARS = 6 * 1024;
export const MAX_REDIRECT_HOPS = 2;
export const CONCURRENCY = 4;

export type FetchBudget = {
  perPageTimeoutMs?: number;
  totalWallClockMs?: number;
  maxBytesPerPage?: number;
  excerptMaxChars?: number;
  concurrency?: number;
};

export type FetchDomainResult = {
  pages: DomainPage[];
  pages_attempted: number;
  pages_fetched: number;
  discovered_attempted: number;
  ssrf_blocked: number;
  total_bytes: number;
  total_ms: number;
  aborted_reason?: "wall_clock_cap";
};

async function streamWithCap(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<{ text: string; bytes: number; capHit: boolean }> {
  if (!res.body) return { text: "", bytes: 0, capHit: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let bytes = 0;
  const chunks: string[] = [];
  let capHit = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        capHit = true;
        controller.abort();
        try {
          await reader.cancel();
        } catch {
        }
        break;
      }
      chunks.push(decoder.decode(chunk, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (e) {
  }
  return { text: chunks.join(""), bytes, capHit };
}

export function cleanHeadText(raw: string, max: number): string {
  return sanitizeFetchedContent(raw).replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function extractTitle(html: string): string {
  const m = html.match(/<title[^<>]*>([^<]*)<\/title>/i);
  return m ? cleanHeadText(m[1], 200) : "";
}

function metaContent(html: string, key: string): string {
  for (const tag of html.match(/<meta\b[^<>]*>/gi) ?? []) {
    const k = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (k?.toLowerCase() !== key) continue;
    const v = tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
    return v ? cleanHeadText(v[1] ?? v[2] ?? "", 300) : "";
  }
  return "";
}

export function extractSiteName(html: string): string {
  return metaContent(html, "og:site_name").slice(0, 100);
}

export function extractMetaDescription(html: string): string {
  return metaContent(html, "description") || metaContent(html, "og:description");
}

export function brandFromTitle(title: string, domain: string): string {
  const segments = title
    .split(/\s*\|\s*|\s+[–—\-:·•]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const label = key(domain.replace(/^www\./i, "").split(".")[0] ?? "");
  const matches = segments.filter((s) => {
    const k = key(s);
    return k.length >= 3 && label.length >= 3 && (label.includes(k) || k.includes(label));
  });
  if (matches.length > 0) return matches.sort((a, b) => a.length - b.length)[0].slice(0, 120);
  if (segments.length === 1 && segments[0].split(/\s+/).length <= 5) return segments[0].slice(0, 120);
  return "";
}

function isHomepage(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
}

const SURFACE_SITE_NAME =
  /(help\s*cent(er|re)|support\s*cent(er|re)|knowledge\s*base|documentation|developer\s+docs?|api\s+docs?|status\s*page|community\s+forum)/i;

export function pickCompanyName(
  pages: DomainPage[],
  domain: string,
  researchPages: DomainPage[] = [],
): string {
  const home = pages.find((p) => isHomepage(p.url));
  if (home?.site_name) return home.site_name;
  const anySiteName = pages.find((p) => p.site_name && !SURFACE_SITE_NAME.test(p.site_name))?.site_name;
  if (anySiteName) return anySiteName;
  const fromHome = home ? brandFromTitle(home.title, domain) : "";
  if (fromHome) return fromHome;
  return exactLabelSegment([...pages, ...researchPages], domain);
}

function exactLabelSegment(pages: DomainPage[], domain: string): string {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const label = key(domain.replace(/^www\./i, "").split(".")[0] ?? "");
  if (label.length < 3) return "";
  for (const p of pages) {
    const segments = cleanHeadText(p.title ?? "", 200)
      .split(/\s*\|\s*|\s+[–—\-:·•]\s+/)
      .map((s) => s.trim());
    const hit = segments.find((s) => key(s) === label);
    if (hit) return hit.slice(0, 100);
  }
  return "";
}

const AUTH_PATH_RE =
  /(^|\/)(login|signin|sign-in|sign_in|auth|authenticate|session|sso|account\/login|users\/sign_in)(\/|$)/i;
const AUTH_RETURN_PARAMS = [
  "next",
  "redirect",
  "redirect_uri",
  "redirect_url",
  "redirecturl",
  "return",
  "return_to",
  "returnto",
  "returnurl",
  "continue",
  "callback",
];
function looksLikeAuthRedirect(u: URL): boolean {
  if (AUTH_PATH_RE.test(u.pathname)) return true;
  return AUTH_RETURN_PARAMS.some((k) => u.searchParams.has(k));
}

function dedupePages(pages: DomainPage[]): DomainPage[] {
  const seen = new Set<string>();
  const out: DomainPage[] = [];
  for (const p of pages) {
    const key = `${p.title}${p.text_excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

async function fetchOnePage(
  pageUrl: string,
  rootHost: string,
  budget: Required<FetchBudget>,
  globalDeadline: number,
): Promise<DomainPage | { error: "ssrf" | "timeout" | "redirect" | "status" | "other" }> {
  let currentUrl = pageUrl;
  for (let hop = 0; hop <= budget["concurrency"]  * 0 + MAX_REDIRECT_HOPS + 1; hop++) {
    try {
      await assertSafeUrl(currentUrl);
    } catch (e) {
      if (e instanceof SsrfBlockedError) return { error: "ssrf" };
      return { error: "other" };
    }
    const remainingWall = globalDeadline - Date.now();
    if (remainingWall <= 0) return { error: "timeout" };
    const timeoutMs = Math.min(budget.perPageTimeoutMs, remainingWall);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "PraxisBot/1.0 (+https://zaviagent.com)" },
      });
    } catch (e) {
      clearTimeout(timer);
      return { error: "timeout" };
    }
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const loc = res.headers.get("location");
      if (!loc || hop >= MAX_REDIRECT_HOPS) return { error: "redirect" };
      let nextUrl: URL;
      try {
        nextUrl = new URL(loc, currentUrl);
      } catch {
        return { error: "redirect" };
      }
      if (companyWebsiteHost(nextUrl.hostname) !== rootHost) return { error: "redirect" };
      if (looksLikeAuthRedirect(nextUrl)) return { error: "redirect" };
      currentUrl = nextUrl.toString();
      continue;
    }
    if (!res.ok) {
      clearTimeout(timer);
      return { error: "status" };
    }
    const stream = await streamWithCap(res, budget.maxBytesPerPage, controller);
    clearTimeout(timer);
    if (stream.text.length === 0) return { error: "other" };
    const title = extractTitle(stream.text);
    const siteName = extractSiteName(stream.text);
    const metaDescription = extractMetaDescription(stream.text);
    const body = sanitizeFetchedContent(stream.text);
    const sanitized = metaDescription
      ? `${sanitizeFetchedContent(metaDescription)} ${body}`.trim()
      : body;
    const truncated = sanitized.slice(0, budget.excerptMaxChars);
    const escaped = xmlEscapeContent(truncated);
    return {
      url: currentUrl,
      title,
      text_excerpt: escaped,
      ...(siteName ? { site_name: siteName } : {}),
    };
  }
  return { error: "redirect" };
}

export async function fetchDomain(
  domain: string,
  budget: FetchBudget = {},
): Promise<FetchDomainResult> {
  const b: Required<FetchBudget> = {
    perPageTimeoutMs: budget.perPageTimeoutMs ?? PER_PAGE_TIMEOUT_MS,
    totalWallClockMs: budget.totalWallClockMs ?? TOTAL_WALL_CLOCK_MS,
    maxBytesPerPage: budget.maxBytesPerPage ?? MAX_BYTES_PER_PAGE,
    excerptMaxChars: budget.excerptMaxChars ?? EXCERPT_MAX_CHARS,
    concurrency: budget.concurrency ?? CONCURRENCY,
  };
  const start = Date.now();
  const deadline = start + b.totalWallClockMs;
  const rootHost = companyWebsiteHost(domain);
  const urls = Array.from(
    new Set(PATH_ALLOWLIST.map((p) => `https://${rootHost}${p}`)),
  );
  let discovered_attempted = 0;
  try {
    const discovered = await discoverUrls(rootHost, start);
    discovered_attempted = discovered.length;
    for (const d of discovered) {
      if (!urls.includes(d.url)) urls.push(d.url);
    }
  } catch {
  }
  const pages: DomainPage[] = [];
  let ssrf_blocked = 0;
  let pages_fetched = 0;
  let total_bytes = 0;
  let aborted_reason: FetchDomainResult["aborted_reason"];

  const queue = [...urls];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < b.concurrency; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          if (Date.now() >= deadline) {
            aborted_reason = "wall_clock_cap";
            return;
          }
          const url = queue.shift();
          if (!url) return;
          const r = await fetchOnePage(url, rootHost, b, deadline);
          if ("error" in r) {
            if (r.error === "ssrf") ssrf_blocked++;
            continue;
          }
          pages.push(r);
          pages_fetched++;
          total_bytes += r.text_excerpt.length;
        }
      })(),
    );
  }
  await Promise.all(workers);

  return {
    pages: dedupePages(pages),
    pages_attempted: urls.length,
    pages_fetched,
    discovered_attempted,
    ssrf_blocked,
    total_bytes,
    total_ms: Date.now() - start,
    aborted_reason,
  };
}
