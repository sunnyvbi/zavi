
import type { DashboardBuilder } from "./_contract";
import { buildSearchConsoleSummary } from "@/services/tools/google-search-console/summary";
import {
  getGeoReadiness,
  getSeoPerformance,
  getSeoSiteHealth,
} from "@/services/tools/growth/seo/snapshot";
import { getSitePublishState, sitePublishDeps } from "@/services/tools/growth/seo/site-publish-state";
import { ExpectedToolError } from "@/services/tools/types";

const NOT_CONNECTED_CODES = new Set([
  "google_search_console_not_connected",
  "google_search_console_not_configured",
]);

async function searchLane(tenantId: string): Promise<Record<string, unknown>> {
  try {
    return await buildSearchConsoleSummary(tenantId, 28);
  } catch (e) {
    if (e instanceof ExpectedToolError && NOT_CONNECTED_CODES.has(e.code)) {
      return { connected: false };
    }
    return { connected: true, load_error: true };
  }
}

async function healthLane(
  tenantId: string,
  opts: { maxAgeMs?: number },
): Promise<Record<string, unknown>> {
  try {
    return { site_health: await getSeoSiteHealth(tenantId, opts) };
  } catch {
    return { site_health: null };
  }
}

async function geoLane(
  tenantId: string,
  opts: { maxAgeMs?: number },
): Promise<Record<string, unknown>> {
  try {
    return { geo: await getGeoReadiness(tenantId, opts) };
  } catch {
    return { geo: null };
  }
}

async function performanceLane(
  tenantId: string,
  opts: { maxAgeMs?: number },
): Promise<Record<string, unknown>> {
  try {
    return { performance: await getSeoPerformance(tenantId, opts) };
  } catch {
    return { performance: null };
  }
}

export const build: DashboardBuilder = async ({ tenantId, refresh, sb }) => {
  const opts = refresh ? { maxAgeMs: 0 } : {};
  const [search, health, geo, performance] = await Promise.all([
    searchLane(tenantId),
    healthLane(tenantId, opts),
    geoLane(tenantId, opts),
    performanceLane(tenantId, opts),
  ]);
  const crawled = (health.site_health as { site?: string | null } | null)?.site ?? null;
  const site_publish = await getSitePublishState(tenantId, crawled, sitePublishDeps(sb));
  return { ...search, ...health, ...geo, ...performance, site_publish };
};
