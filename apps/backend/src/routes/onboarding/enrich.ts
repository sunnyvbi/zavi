
import type { Request, Response } from "express";
import { z } from "zod";
import { verifyBearer } from "@/services/auth/jwt";
import { serviceClient } from "@/services/supabase";
import { resolveDomain } from "@/services/onboarding/enrichment/domain-match";
import { retryOnce } from "@/services/onboarding/enrichment/run";
import {
  clientRateLimitKey,
  isEnrichmentEnabled,
  isFeatureFlagOn,
  logRun,
  runFullEnrichment,
  tickAnonPublicLimit,
  tickPerUserLimit,
  type EnrichmentResult,
  type FullDebug,
  type SkipReason,
} from "@/services/onboarding/scan";

export { retryOnce, domainMayExist } from "@/services/onboarding/enrichment/run";

const Body = z.object({
  orgName: z.string().min(1).max(200),
  domainOverride: z.string().max(255).optional(),
  mode: z.enum(["resolve_only", "full"]).default("full"),
});

type ResolveOnlyResult =
  | { status: "resolved"; resolved_domain: string; confidence: number; via: "override" | "tavily" }
  | { status: "skipped"; reason: SkipReason };

type ResolveDebug = { total_ms: number; aborted_reason?: string };
type EnrichResponse =
  | { mode: "resolve_only"; result: ResolveOnlyResult | null; debug: ResolveDebug }
  | { mode: "full"; enrichment: EnrichmentResult | null; debug: FullDebug };

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 50;
const responseCache = new Map<string, { at: number; body: EnrichResponse }>();
function cacheKey(orgName: string, override: string | undefined, mode: string): string {
  return `${mode}|${orgName.toLowerCase().trim()}|${(override ?? "").toLowerCase().trim()}`;
}
function cacheGet(key: string): EnrichResponse | null {
  const e = responseCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return e.body;
}
function cacheSet(key: string, body: EnrichResponse): void {
  if (responseCache.size >= CACHE_MAX) {
    const first = responseCache.keys().next().value;
    if (first) responseCache.delete(first);
  }
  responseCache.set(key, { at: Date.now(), body });
}

export async function onboardingEnrich(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body);
  } catch (e) {
    res.status(400).json({ error: { code: "validation", message: e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message } });
    return;
  }

  const verified = await verifyBearer(req).catch(() => null);
  const userId = verified?.user_id ?? null;
  const rateLimitKey = clientRateLimitKey(req, userId);

  if (rateLimitKey === null) {
    const r = buildSkipped(body.mode, "user_rate_limit", startedAt);
    logRun("warn", "unidentifiable_client", null, { mode: body.mode });
    res.json(r);
    return;
  }

  if (!userId && !(await tickAnonPublicLimit(rateLimitKey))) {
    const r = buildSkipped(body.mode, "user_rate_limit", startedAt);
    logRun("warn", "user_rate_limit", null, { mode: body.mode });
    res.json(r);
    return;
  }

  const flagOn = await isFeatureFlagOn();
  if (!flagOn) {
    const r: EnrichResponse =
      body.mode === "resolve_only"
        ? {
            mode: "resolve_only",
            result: { status: "skipped", reason: "feature_flag_off" },
            debug: { total_ms: Date.now() - startedAt, aborted_reason: "feature_flag_off" },
          }
        : {
            mode: "full",
            enrichment: { status: "skipped", reason: "feature_flag_off" },
            debug: {
              resolved_domain: null,
              pages_fetched: 0,
              total_ms: Date.now() - startedAt,
              total_cost_usd: 0,
              aborted_reason: "feature_flag_off",
            },
          };
    res.json(r);
    return;
  }

  if (body.mode === "full" && !(await isEnrichmentEnabled())) {
    const r = buildSkipped(body.mode, "enrichment_disabled", startedAt);
    logRun("warn", "skipped:enrichment_disabled", userId, { mode: body.mode });
    res.json(r);
    return;
  }

  if (body.mode === "full" && userId) {
    if (!(await tickPerUserLimit(userId))) {
      const r = buildSkipped(body.mode, "user_rate_limit", startedAt);
      logRun("warn", "user_rate_limit", userId, { mode: body.mode });
      res.json(r);
      return;
    }
  }

  const key = cacheKey(body.orgName, body.domainOverride, body.mode);
  const cached = cacheGet(key);
  if (cached) {
    res.json(cached);
    return;
  }

  if (body.mode === "full") {
    const out = await runFullEnrichment({
      orgName: body.orgName,
      domainOverride: body.domainOverride,
      userId,
      startedAt,
      vendor: { tenant_id: null, source: "onboarding" },
    });
    const r: EnrichResponse = { mode: "full", enrichment: out.enrichment, debug: out.debug };
    cacheSet(key, r);
    res.json(r);
    return;
  }

  let resolved: Awaited<ReturnType<typeof resolveDomain>>;
  try {
    resolved = await retryOnce(() => resolveDomain(body.orgName, { override: body.domainOverride }));
  } catch {
    resolved = null;
  }
  if (!resolved) {
    const r = buildSkipped(
      body.mode,
      body.orgName ? "domain_match_failed" : "tavily_error",
      startedAt,
    );
    logRun("info", "skipped:domain_match_failed", userId, {
      mode: body.mode,
      total_ms: Date.now() - startedAt,
    });
    cacheSet(key, r);
    res.json(r);
    return;
  }

  const r: EnrichResponse = {
    mode: "resolve_only",
    result: {
      status: "resolved",
      resolved_domain: resolved.domain,
      confidence: resolved.confidence,
      via: resolved.via,
    },
    debug: { total_ms: Date.now() - startedAt },
  };
  logRun("info", "resolved", userId, {
    resolved_domain: resolved.domain,
    total_ms: Date.now() - startedAt,
    mode: body.mode,
  });
  cacheSet(key, r);
  res.json(r);
}

function buildSkipped(
  mode: "resolve_only" | "full",
  reason: SkipReason,
  startedAt: number,
  resolved_domain: string | null = null,
): EnrichResponse {
  const total_ms = Date.now() - startedAt;
  if (mode === "resolve_only") {
    return {
      mode: "resolve_only",
      result: { status: "skipped", reason },
      debug: { total_ms, aborted_reason: reason },
    };
  }
  return {
    mode: "full",
    enrichment: { status: "skipped", reason },
    debug: {
      resolved_domain,
      pages_fetched: 0,
      total_ms,
      total_cost_usd: 0,
      aborted_reason: reason,
    },
  };
}

export const __test = {
  resetRateLimits: async (): Promise<void> => {
    await serviceClient().from("enrichment_rate_limit").delete().neq("key", "");
  },
  resetCache: (): void => {
    responseCache.clear();
  },
};
