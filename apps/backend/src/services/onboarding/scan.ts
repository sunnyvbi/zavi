
import type { Request } from "express";
import { getAppSetting } from "@/services/settings";
import { logEvent } from "@/services/logging/logEvent";
import { globalClient, startCardRpc } from "@/services/tenant-client";
import { resolveDomain } from "@/services/onboarding/enrichment/domain-match";
import { inferCompanyName } from "./website-host";
import type { CompetitorCandidate } from "@/services/onboarding/enrichment/competitors";
import type { AppListing, DomainPage } from "@/services/onboarding/enrichment/types";
import {
  retryOnce,
  runEnrichment,
  type EnrichmentSpendInputs,
} from "@/services/onboarding/enrichment/run";
import { withVendorContext, type VendorContext } from "@/services/vendors/usage";

export type SkipReason =
  | "domain_match_failed"
  | "operator_declined"
  | "cost_estimate_unknown"
  | "all_fetches_failed"
  | "user_rate_limit"
  | "tavily_error"
  | "feature_flag_off"
  | "enrichment_disabled";

export type EnrichmentResult =
  | {
      status: "ok";
      domain_pages: DomainPage[];
      app_listings: AppListing[];
      research_pages: DomainPage[];
      competitors?: CompetitorCandidate[];
      description?: string;
      company_name?: string;
      inferredShape?: string;
      inferredStage?: number;
      shapeConfidence?: "high" | "low";
    }
  | { status: "skipped"; reason: SkipReason };

export type FullDebug = {
  resolved_domain: string | null;
  pages_fetched: number;
  total_ms: number;
  total_cost_usd: number;
  aborted_reason?: string;
};

export const PER_USER_LIMIT = 5;
export const ANON_PUBLIC_LIMIT = 20;
const WINDOW_SECONDS = 24 * 60 * 60;

async function tickLimit(key: string, limit: number): Promise<boolean> {
  try {
    const { data, error } = await startCardRpc("tick_enrichment_rate_limit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: WINDOW_SECONDS,
    });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (e) {
    console.error(
      `[enrich] rate-limit RPC failed, failing closed: ${(e as Error).message}`,
    );
    return false;
  }
}

export const tickPerUserLimit = (userId: string): Promise<boolean> =>
  tickLimit(`user:${userId}`, PER_USER_LIMIT);

export const tickAnonPublicLimit = (key: string): Promise<boolean> =>
  tickLimit(key, ANON_PUBLIC_LIMIT);

export function clientRateLimitKey(req: Request, userId: string | null): string | null {
  if (userId) return `user:${userId}`;
  const ip = req.ip || req.socket?.remoteAddress;
  return ip ? `anon:${ip}` : null;
}

export async function isFeatureFlagOn(): Promise<boolean> {
  try {
    const settingOverride = await getAppSetting("onboarding_web_enrichment");
    if (settingOverride !== undefined) return settingOverride === true;
    const { data, error } = await globalClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return false;
    const blob = ((data as { blob?: unknown } | null)?.blob ?? {}) as Record<string, unknown>;
    return blob.onboarding_web_enrichment === true;
  } catch {
    return false;
  }
}

export async function isEnrichmentEnabled(): Promise<boolean> {
  try {
    const v = await getAppSetting("onboarding_enrichment_enabled");
    return v !== false;
  } catch {
    return true;
  }
}

export async function scanSpendAllowed(): Promise<
  { ok: true } | { ok: false; reason: "feature_flag_off" | "enrichment_disabled" }
> {
  if (!(await isFeatureFlagOn())) return { ok: false, reason: "feature_flag_off" };
  if (!(await isEnrichmentEnabled())) return { ok: false, reason: "enrichment_disabled" };
  return { ok: true };
}

export function logRun(
  level: "info" | "warn",
  outcome: string,
  user_id: string | null,
  details: {
    resolved_domain?: string | null;
    pages_fetched?: number;
    total_ms?: number;
    total_cost_usd?: number;
    aborted_reason?: string | null;
    mode: string;
  },
): void {
  const msg = `onboarding.enrichment.run mode=${details.mode} outcome=${outcome} domain=${details.resolved_domain ?? "none"} pages=${details.pages_fetched ?? 0} ms=${details.total_ms ?? 0} cost_usd=${(details.total_cost_usd ?? 0).toFixed(4)} aborted=${details.aborted_reason ?? "none"}`;
  void logEvent({
    level,
    source: "onboarding.enrichment",
    code: outcome.slice(0, 64),
    message: msg,
    meta: { ms: details.total_ms ?? 0 },
  });

  void (async () => {
    try {
      await globalClient()
        .from("enrichment_audit")
        .insert({
          user_id: user_id ?? null,
          mode: details.mode,
          outcome: outcome.slice(0, 64),
          resolved_domain: details.resolved_domain ?? null,
          pages_fetched: details.pages_fetched ?? 0,
          cost_usd: Number((details.total_cost_usd ?? 0).toFixed(4)),
          aborted_reason: details.aborted_reason ?? null,
          total_ms: details.total_ms ?? 0,
        });
    } catch {
    }
  })();
}

export function logSpend(
  user_id: string | null,
  estimated_cost_usd: number,
  inputs: EnrichmentSpendInputs,
): void {
  void logEvent({
    level: "info",
    source: "onboarding.enrichment",
    code: "spend",
    message:
      `onboarding.enrichment.spend user=${user_id ?? "anon"} est_cost_usd=${estimated_cost_usd.toFixed(4)}` +
      ` tokens=${inputs.enrichmentTokens} domain_pages=${inputs.domain_pages}` +
      ` research_pages=${inputs.research_pages} app_listings=${inputs.app_listings}` +
      ` tavily=${inputs.tavilyCalls} fetch=${inputs.fetchCalls} apify=${inputs.apifyCalls}`,
  });
}

export type ScanGuardResult = { ok: true } | { ok: false; reason: SkipReason };

export async function checkScanGuards(req: Request, userId: string | null): Promise<ScanGuardResult> {
  const mode = "full";
  const rateLimitKey = clientRateLimitKey(req, userId);
  if (rateLimitKey === null) {
    logRun("warn", "unidentifiable_client", null, { mode });
    return { ok: false, reason: "user_rate_limit" };
  }
  if (!userId && !(await tickAnonPublicLimit(rateLimitKey))) {
    logRun("warn", "user_rate_limit", null, { mode });
    return { ok: false, reason: "user_rate_limit" };
  }
  if (!(await isFeatureFlagOn())) return { ok: false, reason: "feature_flag_off" };
  if (!(await isEnrichmentEnabled())) {
    logRun("warn", "skipped:enrichment_disabled", userId, { mode });
    return { ok: false, reason: "enrichment_disabled" };
  }
  if (userId && !(await tickPerUserLimit(userId))) {
    logRun("warn", "user_rate_limit", userId, { mode });
    return { ok: false, reason: "user_rate_limit" };
  }
  return { ok: true };
}

export type FullEnrichmentOutcome = {
  enrichment: EnrichmentResult;
  debug: FullDebug;
};

function skippedFull(reason: SkipReason, startedAt: number, resolved_domain: string | null = null): FullEnrichmentOutcome {
  return {
    enrichment: { status: "skipped", reason },
    debug: {
      resolved_domain,
      pages_fetched: 0,
      total_ms: Date.now() - startedAt,
      total_cost_usd: 0,
      aborted_reason: reason,
    },
  };
}

export async function runFullEnrichment(args: {
  orgName: string;
  domainOverride?: string;
  userId: string | null;
  startedAt?: number;
  vendor?: VendorContext;
}): Promise<FullEnrichmentOutcome> {
  const startedAt = args.startedAt ?? Date.now();
  const mode = "full";
  let resolved: Awaited<ReturnType<typeof resolveDomain>>;
  try {
    resolved = await retryOnce(() => resolveDomain(args.orgName, { override: args.domainOverride }));
  } catch {
    resolved = null;
  }
  if (!resolved) {
    const out = skippedFull(args.orgName ? "domain_match_failed" : "tavily_error", startedAt);
    logRun("info", "skipped:domain_match_failed", args.userId, {
      mode,
      total_ms: Date.now() - startedAt,
    });
    return out;
  }

  const domain = resolved.domain;
  const crawl = () => runEnrichment({ domain, orgName: args.orgName });
  const run = await (args.vendor ? withVendorContext(args.vendor, crawl) : crawl());
  if (run.status === "all_fetches_failed") {
    const out = skippedFull("all_fetches_failed", startedAt, domain);
    logRun("info", "skipped:all_fetches_failed", args.userId, {
      resolved_domain: domain,
      total_ms: Date.now() - startedAt,
      mode,
    });
    return out;
  }
  const { payload, competitors, description, shape_stage: shapeStage } = run;
  const estimatedCostUsd = run.estimated_cost_usd;
  logSpend(args.userId, estimatedCostUsd, run.spend_inputs);
  const companyName = run.company_name;
  const out: FullEnrichmentOutcome = {
    enrichment: {
      status: "ok",
      domain_pages: payload.domain_pages,
      app_listings: payload.app_listings,
      research_pages: payload.research_pages ?? [],
      ...(competitors.length > 0 ? { competitors } : {}),
      ...(description ? { description } : {}),
      ...(companyName ? { company_name: companyName } : {}),
      ...(shapeStage
        ? {
            inferredShape: shapeStage.shape,
            inferredStage: shapeStage.stage,
            shapeConfidence: shapeStage.confidence,
          }
        : {}),
    },
    debug: {
      resolved_domain: domain,
      pages_fetched: payload.domain_pages.length,
      total_ms: Date.now() - startedAt,
      total_cost_usd: Number(estimatedCostUsd.toFixed(4)),
      aborted_reason: run.aborted_reason,
    },
  };
  logRun("info", "ok", args.userId, {
    resolved_domain: domain,
    pages_fetched: payload.domain_pages.length,
    total_ms: Date.now() - startedAt,
    total_cost_usd: estimatedCostUsd,
    aborted_reason: run.aborted_reason ?? null,
    mode,
  });
  return out;
}

export async function runWebsiteScan(host: string, userId: string | null): Promise<EnrichmentResult> {
  const out = await runFullEnrichment({
    orgName: inferCompanyName(host) || host,
    domainOverride: host,
    userId,
  });
  return out.enrichment;
}

export { inferCompanyName, normalizeWebsiteHost } from "./website-host";
