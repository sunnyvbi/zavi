
import type { StartCardGoogleEvidence } from "@zavi/shared";
import { fetchSerp, type SerpAnswer, type SerpOrganic } from "@/services/channels/reddit/google-rank";
import { isOutOfCredit } from "@/services/tools/growth/geo/visibility/dataforseo-credit";
import { companyWebsiteHost } from "@/services/onboarding/enrichment/domain-host";
import { StageUnavailableError, rivalsWithSite, type StageContext, type StageOutcome } from "./contract";
import { googlePoints } from "./points";
import { SERP_EST_USD, roundUsd } from "./costs";
import { googleNote } from "./notes";
import { findRankedBuyerTerm, RANKED_MAX_RANK, type RankedDeps, type RankedTerm } from "./ranked-terms";

export const CARD_SERP_DEPTH = 100;

export const DIRECTORY_DOMAINS = new Set([
  "yelp.com",
  "yelp.co.uk",
  "yellowpages.com",
  "tripadvisor.com",
  "amazon.com",
  "amazon.co.uk",
  "amazon.in",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "youtube.com",
  "reddit.com",
  "quora.com",
  "wikipedia.org",
  "pinterest.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "bbb.org",
  "angi.com",
  "thumbtack.com",
  "houzz.com",
  "g2.com",
  "capterra.com",
  "trustpilot.com",
  "glassdoor.com",
  "indeed.com",
  "justdial.com",
  "yell.com",
  "maps.google.com",
  "google.com",
]);

export type GoogleDeps = { serp?: (keyword: string, country: string) => Promise<SerpAnswer> } & RankedDeps;

const defaultSerp = (keyword: string, country: string) => fetchSerp(keyword, { country, depth: CARD_SERP_DEPTH });

function resultHost(result: SerpOrganic): string {
  try {
    return companyWebsiteHost(new URL(result.url).hostname);
  } catch {
    return companyWebsiteHost(result.domain);
  }
}

export function positionOf(organic: readonly SerpOrganic[], domain: string): number | null {
  const want = companyWebsiteHost(domain);
  let best: number | null = null;
  for (const r of organic) {
    if (resultHost(r) !== want) continue;
    if (best === null || r.rank < best) best = r.rank;
  }
  return best;
}

export function topDomains(organic: readonly SerpOrganic[], limit = 5): string[] {
  const out: string[] = [];
  for (const r of organic) {
    const d = resultHost(r);
    if (DIRECTORY_DOMAINS.has(d) || out.includes(d)) continue;
    out.push(d);
    if (out.length >= limit) break;
  }
  return out;
}

export async function runGoogle(ctx: StageContext, deps: GoogleDeps = {}): Promise<StageOutcome<StartCardGoogleEvidence>> {
  const profile = ctx.profile;
  if (!profile) throw new StageUnavailableError("no_profile");
  const broad = profile.search_term;
  const serp = deps.serp ?? defaultSerp;

  const ranked = await findRankedBuyerTerm(
    ctx.domain,
    profile.country,
    { company_name: profile.company_name, category: profile.category, description: profile.description },
    deps,
  );
  if (ranked.pick) return scoreRankedTerm(ctx, ranked.pick, ranked.cost_usd, serp);
  if (!broad) throw new StageUnavailableError("no_search_term", roundUsd(ranked.cost_usd));

  const answer = await serp(broad, profile.country);
  if (!answer.ok) {
    const reason =
      answer.error_code === "dataforseo_not_configured"
        ? "vendor_not_configured"
        : isOutOfCredit(answer.error_code)
          ? "vendor_out_of_credit"
          : answer.error_code;
    const unbilled = reason === "vendor_not_configured" || reason === "vendor_out_of_credit";
    const cost = answer.cost_usd ?? (unbilled ? 0 : SERP_EST_USD);
    throw new StageUnavailableError(reason.slice(0, 64), roundUsd(cost + ranked.cost_usd));
  }

  const cost = ranked.cost_usd + (answer.cost_usd ?? SERP_EST_USD);
  if (answer.organic.length === 0) throw new StageUnavailableError("no_results", roundUsd(cost));
  const position = positionOf(answer.organic, ctx.domain);
  const evidence: StartCardGoogleEvidence = {
    search_term: broad,
    term_source: "profile",
    scored_term: broad,
    locale: profile.country,
    results_checked: resultsChecked(answer.organic),
    position,
    rivals: rivalsWithSite(ctx).map((r) => ({ domain: r.domain, position: positionOf(answer.organic, r.domain) })),
    top_domains: topDomains(answer.organic.filter((r) => resultHost(r) !== companyWebsiteHost(ctx.domain))),
  };
  evidence.note = googleNote(evidence);
  return {
    evidence,
    points: googlePoints(position),
    max_points: 20,
    cost_usd: roundUsd(cost),
  };
}

const resultsChecked = (organic: readonly SerpOrganic[]): number =>
  Math.max(organic.length, organic.at(-1)?.rank ?? 0);

async function scoreRankedTerm(
  ctx: StageContext,
  pick: RankedTerm,
  rankedCost: number,
  serp: NonNullable<GoogleDeps["serp"]>,
): Promise<StageOutcome<StartCardGoogleEvidence>> {
  const profile = ctx.profile!;
  const broad = profile.search_term;
  let cost = rankedCost;
  const evidence: StartCardGoogleEvidence = {
    search_term: pick.term,
    term_source: "ranked",
    scored_term: pick.term,
    locale: profile.country,
    results_checked: RANKED_MAX_RANK,
    position: pick.position,
    rivals: [],
  };
  if (broad && broad !== pick.term) {
    evidence.broad_term = broad;
    try {
      const answer = await serp(broad, profile.country);
      if (answer.ok) {
        cost += answer.cost_usd ?? SERP_EST_USD;
        if (answer.organic.length > 0) {
          const own = companyWebsiteHost(ctx.domain);
          evidence.broad_position = positionOf(answer.organic, ctx.domain);
          evidence.broad_results_checked = resultsChecked(answer.organic);
          evidence.broad_top_domain = topDomains(answer.organic.filter((r) => resultHost(r) !== own), 1)[0] ?? null;
        }
      } else {
        const unbilled = answer.error_code === "dataforseo_not_configured" || isOutOfCredit(answer.error_code);
        cost += answer.cost_usd ?? (unbilled ? 0 : SERP_EST_USD);
      }
    } catch (e) {
      cost += SERP_EST_USD;
      console.error(`[start-card] google gap SERP failed: ${(e as Error)?.message?.slice(0, 200)}`);
    }
  }
  evidence.note = googleNote(evidence);
  return {
    evidence,
    points: googlePoints(pick.position),
    max_points: 20,
    cost_usd: roundUsd(cost),
  };
}
