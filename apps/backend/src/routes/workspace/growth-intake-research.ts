
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient, tenantRpc, type TenantId } from "@/services/tenant-client";
import { getAppSetting } from "@/services/settings";
import { logEvent } from "@/services/logging/logEvent";
import { companyWebsiteHost, eTldPlusOne } from "@/services/onboarding/enrichment/domain-host";
import { researchCompany, RESEARCH_QUERY_COUNT } from "@/services/onboarding/enrichment/web-research";
import { findCompetitors, type CompetitorCandidate } from "@/services/onboarding/enrichment/competitors";
import { capturePlanStage } from "@/services/analytics/posthog";
import { buildPlanDossier, type PlanDossier } from "@/services/growth/plan-dossier";
import { withVendorContext } from "@/services/vendors/usage";
import type { DomainPage } from "@/services/onboarding/enrichment/types";
import {
  estimateCostUsd,
  estimateTokens,
  EXPECTED_OUTPUT_RESERVE_TOKENS,
  OPUS_OUTPUT_PER_TOKEN,
} from "@/services/onboarding/enrichment/pricing";
import { getSeoSiteHealth } from "@/services/tools/growth/seo/snapshot";
import { resolveMarketplaceConfig } from "@/services/marketplace-intel/self-serve";
import { getMarketplaceIntel } from "@/services/tools/growth/marketplace_intelligence";
import { getLiquidityGap } from "@/services/tools/growth/liquidity_gap";
import { learnedCardOf } from "@/services/growth/learned-card";

export const MIN_DOMAIN_MATCHED_SOURCES = 2;

export function researchDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export type GrowthIntakeResearchPayload = {
  domain: string;
  research_pages: DomainPage[];
  competitors: CompetitorCandidate[];
  site: {
    site: string | null;
    pages_analyzed: number;
    findings: Array<{ code: string; severity: string; summary: string; urls: string[] }>;
  } | null;
  marketplace: {
    intel: unknown;
    liquidity: unknown;
  } | null;
  dossier?: PlanDossier | null;
};

export type GrowthIntakeResearchRow = {
  status: "pending" | "ready" | "thin" | "failed";
  reason: string | null;
  payload: GrowthIntakeResearchPayload | null;
  fetched_at: string | null;
};

export type ResearchResponse = {
  status: "pending" | "ready" | "thin" | "failed" | "skipped";
  reason?: string;
  sources?: number;
};

export async function isIntakeResearchEnabled(): Promise<boolean> {
  try {
    return (await getAppSetting("growth_intake_research_enabled")) !== false;
  } catch {
    return true;
  }
}

export async function readTodaysResearch(
  tenant_id: TenantId,
  now: Date = new Date(),
): Promise<GrowthIntakeResearchRow | null> {
  try {
    const { data, error } = await tenantClient(tenant_id)
      .from("growth_intake_research")
      .select("status, reason, payload, fetched_at")
      .eq("tenant_id", tenant_id)
      .eq("day", researchDay(now))
      .maybeSingle();
    if (error || !data) return null;
    return data as GrowthIntakeResearchRow;
  } catch {
    return null;
  }
}

export async function readLatestResearchStrict(
  tenant_id: TenantId,
): Promise<(GrowthIntakeResearchRow & { day: string; updated_at: string }) | null> {
  const { data, error } = await tenantClient(tenant_id)
    .from("growth_intake_research")
    .select("status, reason, payload, fetched_at, day, updated_at")
    .eq("tenant_id", tenant_id)
    .order("day", { ascending: false })
    .limit(1);
  if (error) throw new Error(`growth_intake_research read failed: ${error.message}`);
  return ((data ?? []) as Array<GrowthIntakeResearchRow & { day: string; updated_at: string }>)[0] ?? null;
}

const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost"]);

function registrableHost(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return null;
  if (host.startsWith("[") || host.includes(":")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (labels.some((l) => l.length === 0)) return null;
  const tld = labels[labels.length - 1];
  if (RESERVED_TLDS.has(tld)) return null;
  const ok = /^[a-z]{2,}$/.test(tld) || /^xn--[a-z0-9-]{2,}$/.test(tld);
  return ok ? host : null;
}

export function domainFromProductUrl(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const ordered = [
    o.marketing,
    ...Object.keys(o)
      .filter((k) => k !== "marketing")
      .map((k) => o[k]),
  ];
  for (const candidate of ordered) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
    try {
      const hostname = new URL(candidate.trim()).hostname;
      const normalized = registrableHost(hostname);
      if (!normalized) continue;
      const host = companyWebsiteHost(normalized);
      if (host) return host;
    } catch {
    }
  }
  return null;
}

async function anchorOf(
  tenant_id: TenantId,
): Promise<{ orgName: string | null; domain: string | null }> {
  try {
    const { data } = await tenantClient(tenant_id)
      .from("tenants")
      .select("display_name, product_url")
      .eq("id", tenant_id)
      .maybeSingle();
    const row = data as { display_name?: string; product_url?: unknown } | null;
    const name = row?.display_name?.trim();
    return {
      orgName: name ? name : null,
      domain: domainFromProductUrl(row?.product_url),
    };
  } catch {
    return { orgName: null, domain: null };
  }
}

export async function isMarketplaceShaped(tenant_id: string): Promise<boolean> {
  return (await resolveMarketplaceConfig(tenant_id)) !== null;
}

function hostsOf(pages: DomainPage[]): string[] {
  const seen: string[] = [];
  for (const p of pages) {
    let host: string;
    try {
      host = eTldPlusOne(new URL(p.url).hostname);
    } catch {
      continue;
    }
    if (!seen.includes(host)) seen.push(host);
  }
  return seen;
}

function estimatePassCostUsd(args: {
  enrichmentTokens: number;
  tavilyCalls: number;
  fetchCalls: number;
  apifyCalls: number;
}): number {
  const withOutputReserve = estimateCostUsd({ basePromptTokens: 0, ...args });
  const outputReserve = EXPECTED_OUTPUT_RESERVE_TOKENS * OPUS_OUTPUT_PER_TOKEN;
  return Math.max(0, withOutputReserve - outputReserve);
}

function payloadTokens(payload: GrowthIntakeResearchPayload): number {
  let total = 0;
  for (const p of payload.research_pages) {
    total += estimateTokens(p.url) + estimateTokens(p.title) + estimateTokens(p.text_excerpt);
  }
  for (const c of payload.competitors) {
    total += estimateTokens(c.name) + estimateTokens(c.url) + estimateTokens(c.snippet);
  }
  for (const f of payload.site?.findings ?? []) {
    total += estimateTokens(f.summary);
  }
  return total;
}

function log(level: "info" | "warn", outcome: string, detail: string): void {
  void logEvent({
    level,
    source: "growth.intake.research",
    code: outcome.slice(0, 64),
    message: `growth.intake.research ${outcome} ${detail}`,
  });
}

async function finish(
  tenant_id: TenantId,
  day: string,
  row: {
    status: "ready" | "thin" | "failed";
    reason?: string;
    payload?: GrowthIntakeResearchPayload | null;
    est_cost_usd?: number;
  },
): Promise<boolean> {
  try {
    const { error } = await tenantClient(tenant_id)
      .from("growth_intake_research")
      .update({
        status: row.status,
        reason: row.reason?.slice(0, 200) ?? null,
        payload: row.payload ?? null,
        est_cost_usd: row.est_cost_usd ?? null,
        fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenant_id)
      .eq("day", day);
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    log("warn", "write_failed", `err=${(e as Error).message.slice(0, 200)}`);
    return false;
  }
}

export async function postGrowthIntakeResearch(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  await researchFor(asTenantId(auth.tenant_id), res);
}

export async function getGrowthIntakeLearned(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  res.json(learnedCardOf(await readTodaysResearch(asTenantId(auth.tenant_id))));
}

export async function runIntakeResearch(tenant_id: TenantId): Promise<ResearchResponse | null> {
  let out: ResearchResponse | null = null;
  await researchFor(tenant_id, { json: (r) => { out = r; } });
  return out;
}

async function researchFor(tenant_id: TenantId, res: { json: (r: ResearchResponse) => unknown }): Promise<void> {
  const startedAt = Date.now();
  const day = researchDay(new Date());

  if (!(await isIntakeResearchEnabled())) {
    res.json({ status: "skipped", reason: "disabled" } satisfies ResearchResponse);
    return;
  }

  let won = false;
  try {
    const { data, error } = await tenantRpc(tenant_id, "claim_growth_intake_research", {
      p_day: day,
    });
    if (error) throw new Error(error.message);
    won = data === true;
  } catch (e) {
    log("warn", "claim_failed", `err=${(e as Error).message.slice(0, 200)}`);
    const existing = await readTodaysResearch(tenant_id);
    res.json(
      existing
        ? ({
            status: existing.status,
            ...(existing.payload ? { sources: existing.payload.research_pages.length } : {}),
          } satisfies ResearchResponse)
        : ({ status: "skipped", reason: "claim_unavailable" } satisfies ResearchResponse),
    );
    return;
  }

  if (!won) {
    const existing = await readTodaysResearch(tenant_id);
    res.json(
      existing
        ? ({
            status: existing.status,
            ...(existing.payload ? { sources: existing.payload.research_pages.length } : {}),
          } satisfies ResearchResponse)
        :
          ({ status: "pending" } satisfies ResearchResponse),
    );
    return;
  }

  const { orgName, domain } = await anchorOf(tenant_id);
  if (!orgName) {
    await finish(tenant_id, day, { status: "failed", reason: "no_org_name" });
    log("info", "failed", `reason=no_org_name ms=${Date.now() - startedAt}`);
    res.json({ status: "failed", reason: "no_org_name" } satisfies ResearchResponse);
    return;
  }

  if (!domain) {
    await finish(tenant_id, day, { status: "failed", reason: "no_domain_on_file" });
    log("info", "failed", `reason=no_domain_on_file ms=${Date.now() - startedAt}`);
    res.json({ status: "failed", reason: "no_domain_on_file" } satisfies ResearchResponse);
    return;
  }

  try {
    const sitePromise = getSeoSiteHealth(tenant_id).catch(() => null);
    const researchPages = await withVendorContext({ tenant_id, source: "growth_research" }, () => researchCompany(orgName, domain)).catch(
      () => [] as DomainPage[],
    );

    const context = researchPages
      .map((p) => `${p.title}\n${p.text_excerpt}`)
      .join("\n\n")
      .slice(0, 8_000);
    const [competitors, dossier, site] = await Promise.all([
      withVendorContext({ tenant_id, source: "growth_research" }, () => findCompetitors(orgName, domain, context)).catch(
        () => [] as CompetitorCandidate[],
      ),
      withVendorContext({ tenant_id, source: "growth_research" }, () =>
        buildPlanDossier({ orgName, domain, researchPages, tenant_id }),
      ).catch(() => null),
      sitePromise,
    ]);

    let marketplace: GrowthIntakeResearchPayload["marketplace"] = null;
    if (await isMarketplaceShaped(tenant_id)) {
      const [intel, liquidity] = await Promise.all([
        getMarketplaceIntel(tenant_id).catch(() => null),
        getLiquidityGap(tenant_id).catch(() => null),
      ]);
      if (intel || liquidity) marketplace = { intel, liquidity };
    }

    const payload: GrowthIntakeResearchPayload = {
      domain,
      research_pages: researchPages,
      competitors,
      site:
        site && site.status === "ok"
          ? {
              site: site.site,
              pages_analyzed: site.pages_analyzed,
              findings: site.findings.map((f) => ({
                code: f.code,
                severity: f.severity,
                summary: f.summary,
                urls: f.urls,
              })),
            }
          : null,
      marketplace,
      dossier,
    };

    const apifyCalls = researchPages.length > 0 ? RESEARCH_QUERY_COUNT : 0;
    const est_cost_usd = Number(
      (estimatePassCostUsd({
        enrichmentTokens: payloadTokens(payload),
        tavilyCalls: 4,
        fetchCalls: payload.site?.pages_analyzed ?? 0,
        apifyCalls,
      }) + (dossier?.cost_usd ?? 0)).toFixed(4),
    );

    const sources = hostsOf(researchPages).length;
    const ready = sources >= MIN_DOMAIN_MATCHED_SOURCES;
    const stored = await finish(tenant_id, day, {
      status: ready ? "ready" : "thin",
      ...(ready ? {} : { reason: `only ${sources} independent source domain(s)` }),
      payload,
      est_cost_usd,
    });
    log(
      "info",
      stored ? (ready ? "ready" : "thin") : "failed",
      `sources=${sources} competitors=${competitors.length} site_pages=${payload.site?.pages_analyzed ?? 0}` +
        ` marketplace=${marketplace ? "yes" : "no"} est_cost_usd=${est_cost_usd.toFixed(4)}` +
        ` stored=${stored} ms=${Date.now() - startedAt}`,
    );
    capturePlanStage(tenant_id, null, "research", Date.now() - startedAt, { outcome: stored ? (ready ? "ready" : "thin") : "failed" });
    if (!stored) {
      res.json({ status: "failed", reason: "research_not_saved" } satisfies ResearchResponse);
      return;
    }
    res.json({ status: ready ? "ready" : "thin", sources } satisfies ResearchResponse);
  } catch (e) {
    const message = (e as Error).message ?? "unknown";
    await finish(tenant_id, day, { status: "failed", reason: message });
    log("warn", "failed", `reason=unexpected err=${message.slice(0, 200)} ms=${Date.now() - startedAt}`);
    capturePlanStage(tenant_id, null, "research", Date.now() - startedAt, { outcome: "failed" });
    res.json({ status: "failed", reason: "research_failed" } satisfies ResearchResponse);
  }
}
