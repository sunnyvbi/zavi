
import type { GeoReadiness } from "@/services/tools/growth/seo/snapshot";
import { getGeoReadiness } from "@/services/tools/growth/seo/snapshot";
import { retireClearedGeoCards } from "./retire-cleared-cards";
import { getVisibility, type VisibilityPanel } from "./visibility/read";
import { getCrawlerHits, type CrawlerHitsPanel } from "./crawler-hits/read";
import type { GeoEngine } from "./visibility/engines";

export type ReadinessGrade = "low" | "medium" | "high" | "not_measured";

export function readinessGrade(total: number, pagesAnalyzed: number): ReadinessGrade {
  if (pagesAnalyzed === 0) return "not_measured";
  if (total >= 70) return "high";
  if (total >= 40) return "medium";
  return "low";
}

export type ReadinessLane = Omit<GeoReadiness, "pages"> & {
  tier: 1;
  provenance: "crawl";
  grade: ReadinessGrade;
};

type Lane<T> = T | { error: true };

export type GeoMetricsPayload = {
  readiness: Lane<ReadinessLane | null>;
  visibility: Lane<VisibilityPanel>;
  crawler_hits: Lane<CrawlerHitsPanel>;
};

async function lane<T>(fn: () => Promise<T>): Promise<Lane<T>> {
  try {
    return await fn();
  } catch {
    return { error: true };
  }
}

export async function getGeoMetrics(
  tenantId: string,
  q: { country?: string | null; engine?: GeoEngine | null; days?: number | null; range?: { since: string; until: string } | null; refresh?: boolean },
): Promise<GeoMetricsPayload> {
  const [readiness, visibility, crawler_hits] = await Promise.all([
    lane(async (): Promise<ReadinessLane | null> => {
      const r = await getGeoReadiness(tenantId, q.refresh ? { maxAgeMs: 0 } : {});
      if (!r) return null;
      void retireClearedGeoCards(tenantId, r);
      const { pages: _pages, ...rest } = r;
      return { ...rest, tier: 1, provenance: "crawl", grade: readinessGrade(r.score.total, r.pages_analyzed) };
    }),
    lane(() => getVisibility(tenantId, q)),
    lane(() => getCrawlerHits(tenantId, { days: q.days, range: q.range })),
  ]);
  return { readiness, visibility, crawler_hits };
}
