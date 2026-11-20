
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import type { SeoFinding, SeoAuditReport } from "./analyze";
import { completenessOf, READINESS_DISCLOSURE, type GeoReport } from "../geo/analyze";
import { recordRobotsObservations } from "../geo/crawler-hits/robots-history";
import {
  AGENT_READINESS_DISCLOSURE,
  computeAgentReadiness,
  type AgentReadiness,
  type AgentReadinessField,
} from "./agent-readiness";
import {
  fetchSeoPerformance,
  seoPerformanceIsConfigured,
  type SeoFieldState,
  type SeoLabState,
  type SeoPerformanceReport,
} from "./performance";
import { resolveTenantSite, runSiteAudit, type SiteAuditRunResult } from "./run";

export const SEO_AUDIT_SCHEMA = 9;

export const SEO_AUDIT_TTL_MS = 24 * 60 * 60 * 1000;

export const SEO_AUDIT_ERROR_TTL_MS = 30 * 60 * 1000;

export const SEO_PERFORMANCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SEO_PERFORMANCE_ERROR_TTL_MS = 60 * 60 * 1000;

type SnapshotRow = {
  site: string | null;
  status: "ok" | "error";
  error_code: string | null;
  report: SeoAuditReport | null;
  geo_report: GeoReport | null;
  performance_report: SeoPerformanceReport | null;
  notes: string[] | null;
  schema_version: number | null;
  fetched_at: string;
};

type AuditEnvelope = {
  status: "ok" | "error";
  site: string | null;
  error_code: string | null;
  fetched_at: string;
  stale: boolean;
  notes: string[];
};

export type SeoSiteHealth = AuditEnvelope & {
  pages_analyzed: number;
  non_html_urls: string[];
  findings: SeoFinding[];
  pages: SeoAuditReport["pages"];
};

export type GeoReadiness = AuditEnvelope & GeoReport;

function isoOf(v: unknown): string {
  if (typeof v === "string") return v;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

const CRAWL_COLUMNS =
  "site, status, error_code, report, geo_report, notes, schema_version, fetched_at";

function isMissingPerformanceColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "42703" && (error.message ?? "").includes("performance_report");
}

async function readSnapshot(tenantId: string): Promise<SnapshotRow | null> {
  const row = await readSnapshotAnySchema(tenantId);
  return row ? servableRow(row) : null;
}

async function readSnapshotAnySchema(tenantId: string): Promise<SnapshotRow | null> {
  try {
    const db = tenantClient(asTenantId(tenantId));
    const { data, error } = await db
      .from("seo_audit_snapshots")
      .select(`${CRAWL_COLUMNS}, performance_report`)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error && isMissingPerformanceColumn(error)) {
      const degraded = await db
        .from("seo_audit_snapshots")
        .select(CRAWL_COLUMNS)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (degraded.error || !degraded.data) return null;
      return { ...(degraded.data as object), performance_report: null } as SnapshotRow;
    }
    if (error || !data) return null;
    return data as SnapshotRow;
  } catch {
    return null;
  }
}

function servableRow(row: SnapshotRow): SnapshotRow | null {
  return (row.schema_version ?? 0) === SEO_AUDIT_SCHEMA ? row : null;
}

async function writeSnapshot(
  tenantId: string,
  row: {
    site: string | null;
    status: "ok" | "error";
    error_code: string | null;
    report: SeoAuditReport | null;
    geo_report: GeoReport | null;
    notes: string[];
  },
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const db = tenantClient(asTenantId(tenantId));
    await db.from("seo_audit_snapshots").upsert(
      {
        tenant_id: tenantId,
        site: row.site,
        status: row.status,
        error_code: row.error_code,
        report: row.report,
        geo_report: row.geo_report,
        notes: row.notes,
        schema_version: SEO_AUDIT_SCHEMA,
        fetched_at: now,
        updated_at: now,
      },
      { onConflict: "tenant_id" },
    );
  } catch {
  }
}

export async function cacheSiteAuditRun(
  tenantId: string,
  run: SiteAuditRunResult,
): Promise<void> {
  await writeSnapshot(tenantId, {
    site: run.site,
    status: "ok",
    error_code: null,
    report: run.seo,
    geo_report: run.geo,
    notes: run.notes,
  });
  await recordRobotsObservations(tenantId, run.geo.crawlers);
}

async function writePerformance(
  tenantId: string,
  report: SeoPerformanceReport,
): Promise<{ stored: boolean }> {
  if (report.field.state === "not_configured" && report.lab.state === "not_configured")
    return { stored: true };
  try {
    const db = tenantClient(asTenantId(tenantId));
    const { error } = await db
      .from("seo_audit_snapshots")
      .update({ performance_report: report, updated_at: new Date().toISOString() });
    return { stored: !error };
  } catch {
    return { stored: false };
  }
}

export async function cacheSeoAuditFailure(
  tenantId: string,
  code: string,
  site: string | null,
  detail?: string | null,
): Promise<void> {
  await writeSnapshot(tenantId, {
    site,
    status: "error",
    error_code: code,
    report: null,
    geo_report: null,
    notes: detail ? [detail] : [],
  });
}

function failureDetailOf(e: ExpectedToolError): string | null {
  return e.code === "seo_site_unreachable" && e.message ? e.message : null;
}

export function siteHostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function expireSeoAuditForSite(tenantId: string, liveUrl: string): Promise<{ expired: boolean }> {
  try {
    const host = siteHostOf(liveUrl);
    const row = await readSnapshotAnySchema(tenantId);
    if (!host || !row || siteHostOf(row.site) !== host) return { expired: false };
    const { error } = await tenantClient(asTenantId(tenantId))
      .from("seo_audit_snapshots")
      .update({ fetched_at: new Date(0).toISOString(), updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("site", row.site);
    return { expired: !error };
  } catch {
    return { expired: false };
  }
}

type LoadedAudit = AuditEnvelope & {
  seo: SeoAuditReport | null;
  geo: GeoReport | null;
  performance: SeoPerformanceReport | null;
};

function loadedOf(row: SnapshotRow, stale: boolean): LoadedAudit {
  return {
    status: row.status,
    site: row.site,
    error_code: row.error_code,
    fetched_at: isoOf(row.fetched_at),
    stale,
    notes: row.notes ?? [],
    seo: row.report,
    geo: row.geo_report,
    performance: row.performance_report,
  };
}

const inFlight = new Map<string, Promise<LoadedAudit | null>>();

function withinTtl(row: SnapshotRow, maxAge: number): boolean {
  if (maxAge <= 0) return false;
  const ttl = row.status === "error" ? Math.min(maxAge, SEO_AUDIT_ERROR_TTL_MS) : maxAge;
  return Date.now() - Date.parse(isoOf(row.fetched_at)) <= ttl;
}

async function failureIsStillAboutThisSite(
  tenantId: string,
  row: SnapshotRow,
): Promise<boolean> {
  const site = await safeResolveSite(tenantId);
  return site === undefined ? true : site === row.site;
}

async function safeResolveSite(tenantId: string): Promise<string | null | undefined> {
  try {
    return await resolveTenantSite(tenantId);
  } catch {
    return undefined;
  }
}

async function loadSiteAudit(
  tenantId: string,
  maxAge: number,
  persist: boolean,
): Promise<LoadedAudit | null> {
  const stored = await readSnapshotAnySchema(tenantId);
  const cached = stored ? servableRow(stored) : null;
  if (cached && withinTtl(cached, maxAge)) {
    if (cached.status === "ok") return loadedOf(cached, false);
    if (await failureIsStillAboutThisSite(tenantId, cached))
      return loadedOf(cached, false);
  }

  try {
    const run = await runSiteAudit(tenantId);
    if (persist) await cacheSiteAuditRun(tenantId, run);
    return {
      status: "ok",
      site: run.site,
      error_code: null,
      fetched_at: new Date().toISOString(),
      stale: false,
      notes: run.notes,
      seo: run.seo,
      geo: run.geo,
      performance: stored?.performance_report ?? null,
    };
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      const site = (await safeResolveSite(tenantId)) ?? cached?.site ?? null;
      const detail = failureDetailOf(e);
      if (persist) await cacheSeoAuditFailure(tenantId, e.code, site, detail);
      return {
        status: "error",
        site,
        error_code: e.code,
        fetched_at: new Date().toISOString(),
        stale: false,
        notes: detail ? [detail] : [],
        seo: null,
        geo: null,
        performance: null,
      };
    }
    return cached ? loadedOf(cached, true) : null;
  }
}

export async function getSiteAudit(
  tenantId: string,
  opts: { maxAgeMs?: number; persist?: boolean } = {},
): Promise<LoadedAudit | null> {
  const maxAge = opts.maxAgeMs ?? SEO_AUDIT_TTL_MS;
  const persist = opts.persist ?? true;
  const key = `${tenantId}:${maxAge}:${persist}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = loadSiteAudit(tenantId, maxAge, persist).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

export async function seoSnapshotShowsReadableSite(tenantId: string): Promise<boolean> {
  const cached = await readSnapshot(tenantId);
  if (!cached) return false;
  if (cached.status !== "ok") return false;
  if (cached.error_code) return false;
  return (cached.report?.pages_analyzed ?? 0) > 0;
}

export type SiteReadState = {
  state: "ok" | "error" | "unknown";
  site: string | null;
  error_code: string | null;
};

export async function readSiteReadState(tenantId: string): Promise<SiteReadState> {
  const unknown: SiteReadState = { state: "unknown", site: null, error_code: null };
  try {
    const cached = await readSnapshot(tenantId);
    if (!cached) return unknown;
    if (cached.status === "ok" && !cached.error_code && (cached.report?.pages_analyzed ?? 0) > 0)
      return { state: "ok", site: cached.site, error_code: null };
    const onFile = await safeResolveSite(tenantId);
    if (onFile !== undefined && onFile !== cached.site)
      return onFile
        ? { state: "error", site: onFile, error_code: "seo_site_unchecked" }
        : { state: "error", site: null, error_code: "seo_site_unknown" };
    return { state: "error", site: cached.site, error_code: cached.error_code };
  } catch {
    return unknown;
  }
}

export async function getSeoSiteHealth(
  tenantId: string,
  opts: { maxAgeMs?: number } = {},
): Promise<SeoSiteHealth | null> {
  const audit = await getSiteAudit(tenantId, opts);
  if (!audit) return null;
  const { seo, geo: _geo, performance: _performance, ...envelope } = audit;
  return {
    ...envelope,
    pages_analyzed: seo?.pages_analyzed ?? 0,
    non_html_urls: seo?.non_html_urls ?? [],
    findings: seo?.findings ?? [],
    pages: seo?.pages ?? [],
  };
}

export async function getGeoReadiness(
  tenantId: string,
  opts: { maxAgeMs?: number; persist?: boolean } = {},
): Promise<GeoReadiness | null> {
  const audit = await getSiteAudit(tenantId, opts);
  if (!audit) return null;
  const { geo, seo: _seo, performance: _performance, ...envelope } = audit;
  return {
    ...envelope,
    pages_analyzed: geo?.pages_analyzed ?? 0,
    score: geo?.score ?? { total: 0, bands: [] },
    completeness:
      geo?.completeness ??
      completenessOf({ pagesPlanned: 0, pagesReturned: 0, robotsFetched: false, llmsTxt: null }),
    disclosure: geo?.disclosure ?? READINESS_DISCLOSURE,
    crawlers: geo?.crawlers ?? [],
    llms_txt: geo?.llms_txt ?? null,
    findings: geo?.findings ?? [],
    pages: geo?.pages ?? [],
    not_checked: geo?.not_checked ?? [],
  };
}

export type SeoPerformance = Omit<AuditEnvelope, "fetched_at"> & {
  field: SeoFieldState | null;
  lab: SeoLabState | null;
  fetched_at: string | null;
  warming: boolean;
  audit_fetched_at: string;
  agent_readiness: AgentReadiness & { disclosure: string };
};

function readinessOf(
  seo: SeoAuditReport | null,
  geo: GeoReport | null,
  field: SeoFieldState | null,
  site: string | null,
): AgentReadiness & { disclosure: string } {
  return {
    ...computeAgentReadiness({
      llmsTxt: geo?.llms_txt ?? null,
      crawlers: geo?.crawlers ?? null,
      pages: seo?.pages ?? null,
      field: readinessFieldOf(field),
      site,
    }),
    disclosure: AGENT_READINESS_DISCLOSURE,
  };
}

function readinessFieldOf(field: SeoFieldState | null): AgentReadinessField | null {
  if (!field) return null;
  if (field.state === "ok")
    return { state: "ok", cls: field.metrics.cumulative_layout_shift?.p75 ?? null };
  return { state: field.state };
}

function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function performanceWithinTtl(report: SeoPerformanceReport, maxAge: number): boolean {
  if (maxAge <= 0) return false;
  if (report.field.state === "not_configured" && report.lab.state === "not_configured") return false;
  const at = Date.parse(report.fetched_at);
  if (Number.isNaN(at)) return false;
  const ttl =
    report.lab.state === "unavailable" ? Math.min(maxAge, SEO_PERFORMANCE_ERROR_TTL_MS) : maxAge;
  return Date.now() - at <= ttl;
}

function performanceIsAboutSite(report: SeoPerformanceReport, site: string | null): boolean {
  const want = originOf(site);
  if (!want) return true;
  const measured: string[] = [];
  if (report.field.state === "ok") measured.push(report.field.key);
  if (report.lab.state === "ok") measured.push(...report.lab.pages.map((p) => p.requested_url));
  if (measured.length === 0) return true;
  return measured.some((u) => originOf(u) === want);
}

const perfInFlight = new Map<string, Promise<void>>();

function isWarming(tenantId: string): boolean {
  return perfInFlight.has(tenantId);
}

type WarmFailure = {
  at: number;
  kind: "persist" | "fetch";
  reason: string;
};

const perfWarmFailures = new Map<string, WarmFailure>();

const PERSIST_FAILURE_REASON =
  "We measured your site but couldn't save the result, so there's nothing to show yet.";
const FETCH_FAILURE_REASON = "We couldn't measure your site's speed just now.";

function liveWarmFailure(tenantId: string): WarmFailure | null {
  const failure = perfWarmFailures.get(tenantId);
  if (!failure) return null;
  if (Date.now() - failure.at > SEO_PERFORMANCE_ERROR_TTL_MS) {
    perfWarmFailures.delete(tenantId);
    return null;
  }
  return failure;
}

function startPerformanceWarm(tenantId: string, pageUrls: string[]): void {
  if (perfInFlight.has(tenantId)) return;
  if (liveWarmFailure(tenantId)) return;
  const p = (async () => {
    try {
      const report = await fetchSeoPerformance(pageUrls);
      const { stored } = await writePerformance(tenantId, report);
      if (stored) perfWarmFailures.delete(tenantId);
      else
        perfWarmFailures.set(tenantId, {
          at: Date.now(),
          kind: "persist",
          reason: PERSIST_FAILURE_REASON,
        });
    } catch {
      perfWarmFailures.set(tenantId, {
        at: Date.now(),
        kind: "fetch",
        reason: FETCH_FAILURE_REASON,
      });
    }
  })()
    .catch(() => {})
    .finally(() => {
      perfInFlight.delete(tenantId);
    });
  perfInFlight.set(tenantId, p);
}

function noSiteReason(errorCode: string | null): string {
  if (errorCode === "seo_site_unknown")
    return "There's no website on file yet, so there was nothing to check.";
  if (errorCode === "seo_site_unreachable")
    return "Couldn't read your site, so there was nothing to measure.";
  return "The site check didn't finish, so speed wasn't measured.";
}

export async function getSeoPerformance(
  tenantId: string,
  opts: { maxAgeMs?: number } = {},
): Promise<SeoPerformance | null> {
  const audit = await getSiteAudit(tenantId, opts);
  if (!audit) return null;

  const { seo, geo, performance: stored, fetched_at, ...envelope } = audit;
  const base = { ...envelope, audit_fetched_at: fetched_at };

  const pageUrls = (seo?.pages ?? []).map((p) => p.url);
  if (audit.status !== "ok" || pageUrls.length === 0) {
    const reason = noSiteReason(audit.error_code);
    const field: SeoFieldState = { state: "unavailable", reason };
    return {
      ...base,
      field,
      lab: { state: "unavailable", reason },
      fetched_at: new Date().toISOString(),
      warming: false,
      agent_readiness: readinessOf(seo, geo, field, audit.site),
    };
  }

  const maxAge = opts.maxAgeMs ?? SEO_PERFORMANCE_TTL_MS;
  const usable =
    stored && performanceWithinTtl(stored, maxAge) && performanceIsAboutSite(stored, audit.site);
  if (usable && stored) {
    return {
      ...base,
      ...stored,
      warming: isWarming(tenantId),
      agent_readiness: readinessOf(seo, geo, stored.field, audit.site),
    };
  }

  if (!seoPerformanceIsConfigured()) {
    return {
      ...base,
      field: { state: "not_configured" },
      lab: { state: "not_configured" },
      fetched_at: new Date().toISOString(),
      warming: false,
      agent_readiness: readinessOf(seo, geo, { state: "not_configured" }, audit.site),
    };
  }

  const failure = liveWarmFailure(tenantId);
  if (!failure) startPerformanceWarm(tenantId, pageUrls);

  const serveStale = stored && performanceIsAboutSite(stored, audit.site) ? stored : null;

  if (!serveStale && failure) {
    const unavailable = { state: "unavailable" as const, reason: failure.reason };
    return {
      ...base,
      field: unavailable,
      lab: unavailable,
      fetched_at: new Date().toISOString(),
      warming: false,
      agent_readiness: readinessOf(seo, geo, unavailable, audit.site),
    };
  }

  return {
    ...base,
    field: serveStale?.field ?? null,
    lab: serveStale?.lab ?? null,
    fetched_at: serveStale?.fetched_at ?? null,
    warming: isWarming(tenantId),
    agent_readiness: readinessOf(seo, geo, serveStale?.field ?? null, audit.site),
  };
}
