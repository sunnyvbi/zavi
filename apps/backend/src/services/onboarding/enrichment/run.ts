
import { lookup } from "node:dns/promises";
import { fetchDomain, pickCompanyName } from "./fetch-domain";
import { fetchAppListings } from "./fetch-app-store";
import { researchCompany, RESEARCH_QUERY_COUNT } from "./web-research";
import { findCompetitors, type CompetitorCandidate } from "./competitors";
import { describeCompany } from "./describe";
import { classifyShapeStage, type ShapeStageResult } from "./classify-shape-stage";
import type { EnrichmentComplete } from "./text-model";
import type { AppListing, DomainPage, EnrichmentPayload } from "./types";
import { estimateCostUsd, estimateTokens } from "./pricing";
import { buildEnrichmentContext } from "./context";

const FIRST_PARTY_SUFFICIENT_CHARS = 2_000;

export async function retryOnce<T>(fn: () => Promise<T>, jitterMaxMs = 250): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * jitterMaxMs) + 50));
    return await fn();
  }
}

export async function domainMayExist(domain: string): Promise<boolean> {
  const probe = (host: string) =>
    Promise.race([
      lookup(host).then(
        () => "yes" as const,
        (e: NodeJS.ErrnoException) => (e?.code === "ENOTFOUND" ? ("no" as const) : ("unsure" as const)),
      ),
      new Promise<"unsure">((r) => setTimeout(() => r("unsure"), 3_000).unref()),
    ]);
  const answers = await Promise.all([probe(domain), probe(`www.${domain}`)]);
  return answers.some((a) => a !== "no");
}

function payloadTokens(p: EnrichmentPayload): number {
  let total = 0;
  for (const pg of [...p.domain_pages, ...(p.research_pages ?? [])]) {
    total += estimateTokens(pg.url) + estimateTokens(pg.title) + estimateTokens(pg.text_excerpt);
  }
  for (const al of p.app_listings) {
    total +=
      estimateTokens(al.url) +
      estimateTokens(al.name ?? "") +
      estimateTokens(al.version ?? "") +
      estimateTokens(al.last_updated ?? "") +
      estimateTokens(String(al.rating ?? "")) +
      estimateTokens(String(al.ratings_count ?? "")) +
      estimateTokens(al.support_url ?? "");
  }
  return total;
}

export type EnrichmentSpendInputs = {
  enrichmentTokens: number;
  domain_pages: number;
  research_pages: number;
  app_listings: number;
  tavilyCalls: number;
  fetchCalls: number;
  apifyCalls: number;
};

export type RunEnrichmentResult =
  | { status: "all_fetches_failed"; org_name: string }
  | {
      status: "ok";
      org_name: string;
      payload: EnrichmentPayload;
      competitors: CompetitorCandidate[];
      description?: string;
      shape_stage?: ShapeStageResult;
      company_name: string;
      aborted_reason?: string;
      estimated_cost_usd: number;
      spend_inputs: EnrichmentSpendInputs;
    };

export async function runEnrichment(
  input: { domain: string; orgName?: string },
  opts: { complete?: EnrichmentComplete } = {},
): Promise<RunEnrichmentResult> {
  const { domain } = input;
  const callerName = input.orgName?.trim() || "";

  const [domainResult, appListings] = await Promise.all([
    retryOnce(() => fetchDomain(domain)).catch(() => null),
    callerName
      ? retryOnce(() => fetchAppListings(callerName)).catch(() => [] as AppListing[])
      : Promise.resolve([] as AppListing[]),
  ]);
  const orgName = callerName || pickCompanyName(domainResult?.pages ?? [], domain) || domainLabel(domain);
  const firstPartyChars = (domainResult?.pages ?? []).reduce(
    (sum, page) => sum + page.text_excerpt.length,
    0,
  );
  const gotHomepage = (domainResult?.pages ?? []).some((page) => {
    try {
      return new URL(page.url).pathname.replace(/\/+$/, "") === "";
    } catch {
      return false;
    }
  });
  const resolvable = await domainMayExist(domain);
  const needsResearch =
    resolvable && (!gotHomepage || firstPartyChars < FIRST_PARTY_SUFFICIENT_CHARS);
  const researchPages = needsResearch
    ? await researchCompany(orgName, domain, {
        preferOwnDomain: true,
      }).catch(() => [] as DomainPage[])
    : [];
  const totalPages = domainResult?.pages.length ?? 0;
  const usefulListings = appListings.filter(
    (al) =>
      al.name != null ||
      al.version != null ||
      al.last_updated != null ||
      al.rating != null ||
      al.ratings_count != null ||
      al.support_url != null,
  );
  const totalListings = usefulListings.length;
  if (totalPages === 0 && totalListings === 0 && researchPages.length === 0) {
    return { status: "all_fetches_failed", org_name: orgName };
  }

  const competitorContext = buildEnrichmentContext(domainResult?.pages ?? [], researchPages);
  const [competitors, description, shapeStage] = await Promise.all([
    findCompetitors(orgName, domain, competitorContext, opts.complete).catch(() => [] as CompetitorCandidate[]),
    describeCompany(orgName, domain, competitorContext, opts.complete).catch(() => undefined),
    classifyShapeStage(competitorContext, opts.complete).catch(() => undefined),
  ]);

  const payload: EnrichmentPayload = {
    domain_pages: domainResult?.pages ?? [],
    app_listings: usefulListings,
    research_pages: researchPages,
  };
  const enrichmentTokens = payloadTokens(payload);
  const tavilyCalls = 3;
  const fetchCalls = (domainResult?.pages_attempted ?? 0) + totalListings;
  const apifyCalls = needsResearch ? RESEARCH_QUERY_COUNT : 0;
  const estimatedCostUsd = estimateCostUsd({
    basePromptTokens: 1500,
    enrichmentTokens,
    tavilyCalls,
    fetchCalls,
    apifyCalls,
  });

  return {
    status: "ok",
    org_name: orgName,
    payload,
    competitors,
    ...(description ? { description } : {}),
    ...(shapeStage ? { shape_stage: shapeStage } : {}),
    company_name: pickCompanyName(payload.domain_pages, domain, researchPages),
    ...(domainResult?.aborted_reason ? { aborted_reason: domainResult.aborted_reason } : {}),
    estimated_cost_usd: estimatedCostUsd,
    spend_inputs: {
      enrichmentTokens,
      domain_pages: payload.domain_pages.length,
      research_pages: researchPages.length,
      app_listings: totalListings,
      tavilyCalls,
      fetchCalls,
      apifyCalls,
    },
  };
}

function domainLabel(domain: string): string {
  return domain.replace(/^www\./i, "").split(".")[0] ?? domain;
}
