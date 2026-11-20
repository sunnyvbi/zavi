
import type { StartCardSeoEvidence } from "@zavi/shared";
import { fetchForSeoAudit, DEFAULT_PATHS, type SeoFetchResult } from "@/services/tools/growth/seo/fetch";
import { h1CountOf, metaDescriptionOf, schemaTypesOf, titleOf } from "@/services/tools/growth/seo/analyze";
import { StageUnavailableError, rivalsWithSite, type StageContext, type StageOutcome } from "./contract";
import { seoPoints } from "./points";
import { SEO_FETCH_EST_USD } from "./costs";
import { seoNote } from "./notes";

export const CARD_SEO_PAGES = 6;
const MAX_SITE_PAGES = 200;
const MAX_SITE_PAGE_CHARS = 100;

export type SeoDeps = { fetchSite?: (origin: string, paths: string[], opts: { maxPages: number }) => Promise<SeoFetchResult> };

const pathKey = (u: string): string | null => {
  try {
    return new URL(u, "https://x.invalid").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
};

const isBrokenStatus = (s: number) => s === 404 || s === 410 || (s >= 500 && s <= 599);

export function seoEvidenceOf(r: SeoFetchResult): Omit<StartCardSeoEvidence, "rivals" | "note"> | null {
  const home = r.pages[0];
  if (!home || home.status < 200 || home.status >= 300 || !home.html) return null;
  const pointedAt = new Set(
    [...r.graph.sitemap_paths, ...r.graph.linked_paths].map(pathKey).filter((p): p is string => p !== null),
  );
  const broken_links = r.pages
    .filter((p) => isBrokenStatus(p.status))
    .filter((p) => {
      const k = pathKey(p.url);
      return k !== null && pointedAt.has(k);
    })
    .map((p) => ({ url: p.url, status: p.status }));
  return {
    pages_checked: r.pages.filter((p) => p.status > 0).map((p) => p.url),
    title: titleOf(home.html),
    meta_description: metaDescriptionOf(home.html),
    h1_count: h1CountOf(home.html),
    schema_types: schemaTypesOf(home.html),
    robots_allows_root: r.robots.fetched ? !r.robots.disallowsAll : null,
    sitemap_found: r.sitemapReachable === true,
    broken_links,
    site_pages: [...new Set([...r.graph.sitemap_paths, ...r.graph.linked_paths])]
      .filter((p) => p.length <= MAX_SITE_PAGE_CHARS)
      .slice(0, MAX_SITE_PAGES),
  };
}

export async function runSeo(ctx: StageContext, deps: SeoDeps = {}): Promise<StageOutcome<StartCardSeoEvidence>> {
  const fetchSite = deps.fetchSite ?? fetchForSeoAudit;
  const origin = ctx.url.replace(/\/+$/, "");
  const rivals = rivalsWithSite(ctx);
  const [mine, ...theirs] = await Promise.all([
    fetchSite(origin, DEFAULT_PATHS, { maxPages: CARD_SEO_PAGES }).catch(() => null),
    ...rivals.map((r) => fetchSite(`https://${r.domain}`, ["/"], { maxPages: 1 }).catch(() => null)),
  ]);
  const base = mine ? seoEvidenceOf(mine) : null;
  if (!base) throw new StageUnavailableError("site_unreachable", SEO_FETCH_EST_USD);

  const evidence: StartCardSeoEvidence = {
    ...base,
    rivals: rivals.map((r, i) => {
      const ev = theirs[i] ? seoEvidenceOf(theirs[i]!) : null;
      return { domain: r.domain, points: ev ? seoPoints(ev) : null };
    }),
  };
  evidence.note = seoNote(evidence);
  return { evidence, points: seoPoints(evidence), max_points: 20, cost_usd: SEO_FETCH_EST_USD };
}
