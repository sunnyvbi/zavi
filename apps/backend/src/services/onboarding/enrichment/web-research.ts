
import { sanitizeFetchedContent, xmlEscapeContent } from "./sanitize";
import { ragMemoryMb } from "@/services/mcp/internal/apify";
import { apifyRanAndBilled, recordApifyCall } from "@/services/vendors/usage";
import type { DomainPage } from "./types";

const APIFY_BASE = "https://api.apify.com/v2/acts";
const RAG_WEB_BROWSER_ACTOR = "apify~rag-web-browser";

export const RESEARCH_QUERY_COUNT = 4;
const MAX_RESULTS_PER_QUERY = 6;
const MAX_KEPT_PAGES = 10;
const EXCERPT_MAX_CHARS = 8 * 1024;
const MIN_USEFUL_CHARS = 80;
const PER_QUERY_TIMEOUT_MS = 30_000;
const TOTAL_WALL_CLOCK_MS = 45_000;

type RwbItem = {
  metadata?: { url?: string; title?: string };
  markdown?: string;
  text?: string;
};

export function researchQueries(orgName: string, domain: string): string[] {
  const org = orgName.trim();
  return [
    `${org} ${domain} reviews reputation complaints customer experience`,
    `${org} ${domain} what is the company pricing how it works`,
    `${org} ${domain} competitors alternatives comparison`,
    `${org} ${domain} news funding growth traction hiring`,
  ];
}

async function ragSearch(token: string, query: string, deadline: number): Promise<RwbItem[]> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(PER_QUERY_TIMEOUT_MS, remaining));
  const startedAt = Date.now();
  const memoryMb = ragMemoryMb();
  let itemCount = 0;
  let billed = false;
  try {
    const res = await fetch(
      `${APIFY_BASE}/${RAG_WEB_BROWSER_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&memory=${memoryMb}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          maxResults: MAX_RESULTS_PER_QUERY,
          outputFormats: ["markdown"],
        }),
        signal: controller.signal,
      },
    );
    billed = res.ok || apifyRanAndBilled(res.status);
    if (!res.ok) return [];
    const items = (await res.json().catch(() => [])) as unknown;
    const list = Array.isArray(items) ? (items as RwbItem[]) : [];
    itemCount = list.length;
    return list;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") billed = true;
    return [];
  } finally {
    clearTimeout(timer);
    if (billed) {
      recordApifyCall({ actor: RAG_WEB_BROWSER_ACTOR, ms: Date.now() - startedAt, memoryMb, items: itemCount, search: true, at: new Date(startedAt) });
    }
  }
}

export type ResearchOptions = {
  preferOwnDomain?: boolean;
};

export async function researchCompany(
  orgName: string,
  domain: string,
  opts: ResearchOptions = {},
): Promise<DomainPage[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token || !orgName.trim() || !domain.trim()) return [];
  const anchor = domain.trim().toLowerCase().replace(/^www\./, "");
  if (!anchor) return [];

  const deadline = Date.now() + TOTAL_WALL_CLOCK_MS;
  const queries = researchQueries(orgName, domain);
  const batches = await Promise.all(queries.map((q) => ragSearch(token, q, deadline)));

  const seenUrls = new Set<string>();
  const candidates: Array<DomainPage & { own: boolean }> = [];
  for (const items of batches) {
    for (const it of items) {
      const url = (it.metadata?.url ?? "").trim();
      const raw = it.markdown ?? it.text ?? "";
      if (!url || !raw) continue;
      if (!`${url}\n${raw}`.toLowerCase().includes(anchor)) continue;
      const key = dedupKey(url);
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      const sanitized = sanitizeFetchedContent(raw);
      if (sanitized.length < MIN_USEFUL_CHARS) continue;
      candidates.push({
        url,
        title: sanitizeFetchedContent(it.metadata?.title ?? "").replace(/[<>]/g, " ").slice(0, 200),
        text_excerpt: xmlEscapeContent(sanitized.slice(0, EXCERPT_MAX_CHARS)),
        own: isOwnDomainUrl(url, anchor),
      });
    }
  }
  const ownFirst = opts.preferOwnDomain === true;
  candidates.sort((a, b) => (ownFirst ? Number(b.own) - Number(a.own) : Number(a.own) - Number(b.own)));
  return candidates.slice(0, MAX_KEPT_PAGES).map(({ own: _own, ...page }) => page);
}

export function dedupKey(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase().replace(/^www\./, "")}${path}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function isOwnDomainUrl(url: string, anchor: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase().replace(/^www\./, "");
    return host === anchor || host.endsWith(`.${anchor}`);
  } catch {
    return false;
  }
}
