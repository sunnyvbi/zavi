
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { marketingUrlOf } from "@/services/brand/resolve-brand-kit";
import { analyzeSeo, type SeoAuditReport } from "./analyze";
import { analyzeSiteGraph } from "./site-graph";
import { analyzeGeo, type GeoReport } from "../geo/analyze";
import { fetchForSeoAudit, DEFAULT_PATHS, UA } from "./fetch";

export type SeoAuditRunResult = SeoAuditReport & {
  site: string;
  provenance: "public";
  notes: string[];
};

export type SiteAuditRunResult = {
  site: string;
  provenance: "public";
  notes: string[];
  seo: SeoAuditReport;
  geo: GeoReport;
};

export async function resolveTenantSite(tenant_id: string): Promise<string | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data: t } = await db
    .from("tenants")
    .select("product_url")
    .eq("id", tenant_id)
    .maybeSingle();
  const fromProductUrl = marketingUrlOf((t as Record<string, unknown> | null)?.product_url ?? null);
  if (fromProductUrl) return fromProductUrl;

  const { data: facts } = await db
    .from("tenant_fact")
    .select("key, value_text")
    .eq("tenant_id", tenant_id);
  const domain = (facts as Array<{ key: string; value_text: string }> | null)?.find(
    (f) => f.key === "domain",
  )?.value_text;
  if (!domain) return null;
  const trimmed = domain.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export async function runSiteAudit(
  tenant_id: string,
  paths?: string[],
): Promise<SiteAuditRunResult> {
  const site = await resolveTenantSite(tenant_id);
  if (!site) {
    throw new ExpectedToolError(
      "seo_site_unknown",
      "There's no website on file yet, so there's nothing to audit. " +
        "Add the site URL in Settings and run this again.",
    );
  }
  return runAuditForUrl(site, paths ?? DEFAULT_PATHS);
}

export async function runAuditForUrl(site: string, paths: string[] = DEFAULT_PATHS): Promise<SiteAuditRunResult> {
  const fetched = await fetchForSeoAudit(site, paths);
  const report = {
    ...analyzeSeo({
      pages: fetched.pages,
      robots: fetched.robots,
      sitemapReachable: fetched.sitemapReachable,
    }),
    site_graph: analyzeSiteGraph({ pages: fetched.pages, ...fetched.graph }),
  };
  const geo = analyzeGeo({
    pages: fetched.pages,
    robotsBody: fetched.robotsBody,
    robotsFetched: fetched.robots.fetched,
    llmsTxt: fetched.llmsTxt,
    pagesPlanned: fetched.pages_planned,
    sitemapPaths: fetched.graph.sitemap_as_written,
    sitemapComplete: fetched.graph.sitemap_complete,
  });

  const notes: string[] = [];
  if (fetched.truncated) {
    notes.push("The crawl hit its time budget, so not every page was checked. Findings are partial.");
  }
  if (fetched.ssrf_blocked > 0) {
    notes.push(`${fetched.ssrf_blocked} URL(s) were skipped by the safety guard.`);
  }
  if (!fetched.robots.fetched) {
    notes.push(
      "robots.txt could not be read, so crawl rules are unknown. That is not the same as 'crawling is allowed'.",
    );
  }
  if (fetched.crawl_delay_ms) {
    notes.push(
      `Your robots.txt asks for ${fetched.crawl_delay_ms / 1000}s between requests, so the check went slower to respect it.`,
    );
  }
  if (fetched.throttled) {
    notes.push("Your host asked us to slow down (HTTP 429/503), so the check slowed its pace.");
  }
  if (report.pages_analyzed === 0) {
    throw new ExpectedToolError(
      "seo_site_unreachable",
      `Couldn't read any page at ${site}. ${unreachableReason(fetched)}`,
    );
  }

  return { site, provenance: "public" as const, notes, seo: report, geo };
}

const STATUS_TEXT: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  410: "Gone",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

const labelOf = (s: number): string => `HTTP ${s}${STATUS_TEXT[s] ? ` (${STATUS_TEXT[s]})` : ""}`;

function reasonFor(s: number): string {
  if (s === 403 || s === 429) {
    return (
      `The server answered ${labelOf(s)}. ` +
      `That usually means a firewall or rate limit is blocking automated requests. ` +
      `Our crawler identifies itself as "${UA}"; asking your host to allow it should fix this.`
    );
  }
  if (s === 503) {
    return (
      `The server answered ${labelOf(503)}. The site may be down or briefly unavailable, ` +
      `or the host may be limiting automated requests. If it loads in a browser, ask your host ` +
      `to allow our crawler, "${UA}".`
    );
  }
  return `The server answered ${labelOf(s)}. Check that the address on file loads in a browser.`;
}

export function unreachableReason(fetched: {
  pages: Array<{ status: number }>;
  ssrf_blocked: number;
}): string {
  const home = fetched.pages[0];
  if (home && home.status > 0) return reasonFor(home.status);
  if (fetched.pages.length === 0 && fetched.ssrf_blocked > 0) {
    return "The address was refused by our safety check. It needs to be a public website address.";
  }
  const limited =
    fetched.pages.find((p) => p.status === 403 || p.status === 429) ??
    fetched.pages.find((p) => p.status === 503);
  if (limited) return reasonFor(limited.status);
  if (fetched.pages.some((p) => p.status > 0)) {
    return "Your homepage did not answer in time (the connection timed out or was refused). The site may be down, or the address on file may be wrong.";
  }
  return "Nothing answered in time (the connection timed out or was refused). The site may be down, or the address on file may be wrong.";
}

export function seoShapeOf(run: SiteAuditRunResult): SeoAuditRunResult {
  return { site: run.site, provenance: "public", ...run.seo, notes: run.notes };
}

export async function runSeoAudit(
  tenant_id: string,
  paths?: string[],
): Promise<SeoAuditRunResult> {
  return seoShapeOf(await runSiteAudit(tenant_id, paths));
}
