
import { createGunzip } from "node:zlib";
import { companyWebsiteHost } from "./domain-host";
import { assertSafeUrl, SsrfBlockedError } from "./url-guard";

export const DISCOVERY_WALL_MS = 5_000;
export const DISCOVERY_PER_FETCH_TIMEOUT_MS = 4_000;
export const MAX_ROBOTS_BYTES = 64 * 1024;
export const MAX_SITEMAP_BYTES = 512 * 1024;
export const MAX_SITEMAP_ENTRIES = 1000;
export const MAX_ROBOTS_SITEMAPS = 3;
export const MAX_INDEX_CHILDREN = 5;
export const MAX_DISCOVERED_PAGES = 4;
export const MAX_REDIRECT_HOPS = 2;

type SkippableTopic = "SUPPLY" | "ICP" | "PRODUCTS" | "CLIENTS";

const TOPIC_PATH_PATTERNS: Record<SkippableTopic, RegExp> = {
  SUPPLY: /(^|[/-])(sell|sellers?|host|hosts?|supply|suppliers?|providers?|partners?|become-a|list-your|drive|earn)([/-]|$)/i,
  ICP: /(^|[/-])(customers?|for-teams?|for-business|use-cases?|industries|solutions?|who-we-serve)([/-]|$)/i,
  PRODUCTS: /(^|[/-])(products?|catalog|catalogue|collections?|shop|inventory)([/-]|$)/i,
  CLIENTS: /(^|[/-])(clients?|case-stud(y|ies)|portfolio|testimonials?|success-stor(y|ies))([/-]|$)/i,
};

const TOPIC_NEGATIVE = /(privacy|terms|legal|cookie|gdpr|ccpa|your-data|policy|policies)/i;

export const TOPIC_TEXT_SIGNALS: Record<SkippableTopic, string[]> = {
  SUPPLY: ["become a", "list your", "earn", "our hosts", "our sellers", "our suppliers", "join as a", "start hosting", "start selling"],
  ICP: ["our customers", "built for", "designed for", "who we serve", "use cases", "trusted by", "for teams", "for businesses"],
  PRODUCTS: ["our products", "shop", "browse", "collection", "catalog", "add to cart", "sku", "in stock"],
  CLIENTS: ["case study", "case studies", "our clients", "worked with", "testimonial", "success story", "portfolio"],
};

export const SKIPPABLE_TOPICS: readonly SkippableTopic[] = ["SUPPLY", "ICP", "PRODUCTS", "CLIENTS"];

export function parseSitemap(xml: string): string[] {
  if (!xml) return [];
  const safe = xml.replace(/<!DOCTYPE[\s\S]*?>/gi, "").replace(/<!ENTITY[\s\S]*?>/gi, "");
  const out: string[] = [];
  for (const m of safe.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const raw = (m[1] ?? "").trim();
    if (raw) out.push(decodeXmlEntities(raw));
    if (out.length >= MAX_SITEMAP_ENTRIES) break;
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function extractNavLinks(html: string, baseUrl: string): Array<{ url: string; anchor: string }> {
  if (!html) return [];
  const head = html.slice(0, 40 * 1024);
  const out: Array<{ url: string; anchor: string }> = [];
  const seen = new Set<string>();
  for (const m of head.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1] ?? "").trim();
    const anchor = (m[2] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ url: abs, anchor });
    if (out.length >= 200) break;
  }
  return out;
}

export function classifyPageTopic(
  url: string,
  anchor: string,
  text: string,
): { topic: SkippableTopic; strong: boolean } | null {
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (TOPIC_NEGATIVE.test(path)) return null;
  const hay = `${anchor} ${text}`.toLowerCase();
  for (const topic of SKIPPABLE_TOPICS) {
    const pathHit = TOPIC_PATH_PATTERNS[topic].test(path);
    const textHit = TOPIC_TEXT_SIGNALS[topic].some((s) => hay.includes(s));
    if (pathHit || textHit) {
      if (TOPIC_NEGATIVE.test(hay) && !textHit) return null;
      return { topic, strong: textHit };
    }
  }
  return null;
}

function sameApexOrWww(host: string, rootEtld: string): boolean {
  const h = host.toLowerCase();
  return h === rootEtld || h === `www.${rootEtld}`;
}

export async function safeFetchText(
  startUrl: string,
  rootEtld: string,
  deadline: number,
  maxBytes: number,
  redirectAllowed: (host: string) => boolean = (host) => sameApexOrWww(host, rootEtld),
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let currentUrl = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    try {
      await assertSafeUrl(currentUrl);
    } catch (e) {
      if (e instanceof SsrfBlockedError) return null;
      return null;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(DISCOVERY_PER_FETCH_TIMEOUT_MS, remaining));
    let res: Response;
    try {
      res = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "ZaviBot/1.0 (+https://www.zaviagent.com; read-only SEO audit)" },
      });
    } catch {
      clearTimeout(timer);
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const loc = res.headers.get("location");
      if (!loc || hop >= MAX_REDIRECT_HOPS) return null;
      let next: URL;
      try {
        next = new URL(loc, currentUrl);
      } catch {
        return null;
      }
      if (next.protocol !== "https:" || !redirectAllowed(next.hostname.toLowerCase())) return null;
      currentUrl = next.toString();
      continue;
    }
    if (!res.ok) {
      clearTimeout(timer);
      return null;
    }
    const text = await readCapped(res, maxBytes, controller);
    clearTimeout(timer);
    return text;
  }
  return null;
}

async function readCapped(res: Response, maxBytes: number, controller: AbortController): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += (value as Uint8Array).byteLength;
      if (bytes > maxBytes) {
        controller.abort();
        try {
          await reader.cancel();
        } catch {
        }
        break;
      }
      chunks.push(value as Uint8Array);
    }
  } catch {
  }
  const body = Buffer.concat(chunks);
  if (isGzip(body)) return gunzipCapped(body, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function gunzipCapped(input: Uint8Array, maxOut: number): Promise<string | null> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let held = 0;
    let settled = false;
    const gz = createGunzip();
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(held > 0 ? new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(out)) : null);
    };
    gz.on("data", (chunk: Buffer) => {
      if (settled) return;
      const room = maxOut - held;
      if (room > 0) {
        const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
        out.push(kept);
        held += kept.length;
      }
      if (held >= maxOut) {
        finish();
        gz.destroy();
      }
    });
    gz.on("end", finish);
    gz.on("close", finish);
    gz.on("error", finish);
    gz.end(Buffer.from(input));
  });
}

export function parseRobots(txt: string): { sitemaps: string[] } {
  const sitemaps: string[] = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (m) sitemaps.push(m[1].trim());
    if (sitemaps.length >= 10) break;
  }
  return { sitemaps };
}

function dedupeApexHttps(urls: string[], rootEtld: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:") continue;
    if (!sameApexOrWww(parsed.hostname, rootEtld)) continue;
    if (companyWebsiteHost(parsed.hostname) !== rootEtld) continue;
    const key = parsed.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

const FIXED_PATHS = new Set([
  "/", "/about", "/about-us", "/pricing", "/faq", "/help", "/help-center",
  "/support", "/contact", "/terms", "/privacy", "/refunds", "/policies/refund-policy",
]);

export async function discoverUrls(
  rootEtld: string,
  startedAt: number,
): Promise<Array<{ url: string; topic: SkippableTopic }>> {
  const deadline = Math.min(startedAt + DISCOVERY_WALL_MS, Date.now() + DISCOVERY_WALL_MS);
  const candidates: string[] = [];

  const robotsTxt = await safeFetchText(`https://${rootEtld}/robots.txt`, rootEtld, deadline, MAX_ROBOTS_BYTES);
  const robotsSitemaps = robotsTxt ? parseRobots(robotsTxt).sitemaps.slice(0, MAX_ROBOTS_SITEMAPS) : [];

  const sitemapUrls = dedupeApexHttps([`https://${rootEtld}/sitemap.xml`, ...robotsSitemaps], rootEtld).slice(
    0,
    1 + MAX_ROBOTS_SITEMAPS,
  );
  let indexChildrenFetched = 0;
  for (const sm of sitemapUrls) {
    if (Date.now() >= deadline) break;
    const xml = await safeFetchText(sm, rootEtld, deadline, MAX_SITEMAP_BYTES);
    if (!xml) continue;
    const locs = parseSitemap(xml);
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    if (isIndex) {
      for (const child of dedupeApexHttps(locs, rootEtld)) {
        if (indexChildrenFetched >= MAX_INDEX_CHILDREN || Date.now() >= deadline) break;
        indexChildrenFetched++;
        const childXml = await safeFetchText(child, rootEtld, deadline, MAX_SITEMAP_BYTES);
        if (childXml) candidates.push(...parseSitemap(childXml));
      }
    } else {
      candidates.push(...locs);
    }
  }

  let navAnchors: Map<string, string> | undefined;
  if (candidates.length === 0 && Date.now() < deadline) {
    const homepageHtml = await safeFetchText(`https://${rootEtld}/`, rootEtld, deadline, MAX_SITEMAP_BYTES);
    if (homepageHtml) {
      navAnchors = new Map();
      for (const { url, anchor } of extractNavLinks(homepageHtml, `https://${rootEtld}/`)) {
        candidates.push(url);
        navAnchors.set(url, anchor);
      }
    }
  }

  const apexCandidates = dedupeApexHttps(candidates, rootEtld);
  const picked: Array<{ url: string; topic: SkippableTopic }> = [];
  const topicsTaken = new Set<SkippableTopic>();
  for (const url of apexCandidates) {
    if (picked.length >= MAX_DISCOVERED_PAGES) break;
    let path = "";
    try {
      path = new URL(url).pathname.toLowerCase().replace(/\/+$/, "") || "/";
    } catch {
      continue;
    }
    if (FIXED_PATHS.has(path)) continue;
    const cls = classifyPageTopic(url, navAnchors?.get(url) ?? "", "");
    if (!cls) continue;
    if (topicsTaken.has(cls.topic)) continue;
    topicsTaken.add(cls.topic);
    picked.push({ url, topic: cls.topic });
  }
  return picked;
}
