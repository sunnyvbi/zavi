
export type SourceQuality =
  | "confirmed_live_mongo"
  | "hardcoded_upcar"
  | "synthetic_only"
  | "weak_inferred";

const RANKABLE_QUALITIES: ReadonlySet<SourceQuality> = new Set([
  "confirmed_live_mongo",
  "hardcoded_upcar",
]);

const QUALITY_WEIGHT: Record<SourceQuality, number> = {
  confirmed_live_mongo: 1.0,
  hardcoded_upcar: 0.8,
  synthetic_only: 0.4,
  weak_inferred: 0.2,
};

export type LeverCandidate = {
  constraint: string;
  numerator: number;
  denominator: number;
  source_quality: SourceQuality;
  confirmed_map: boolean;
  metric_probe_passed: boolean;
  k_anon_passed: boolean;
  live_validated: boolean;
  elasticity_hint?: string;
  build_cost_hint?: string;
  query_id?: string;
  abstain_reason?: string;
};

export type RankedLever = LeverCandidate & {
  rate: number;
  bucket_volume: number;
  score: number;
  rank: number;
};

export type AbstainedLever = {
  constraint: string;
  reason: string;
  source_quality?: SourceQuality;
};

export function isRankable(c: LeverCandidate): boolean {
  return (
    c.confirmed_map &&
    c.metric_probe_passed &&
    c.k_anon_passed &&
    c.live_validated &&
    RANKABLE_QUALITIES.has(c.source_quality) &&
    c.denominator > 0 &&
    !c.abstain_reason
  );
}

function nonRankableReason(c: LeverCandidate): string {
  if (c.abstain_reason) return c.abstain_reason;
  if (!c.confirmed_map) return "mapping_unconfirmed";
  if (c.denominator <= 0) return "no_data";
  if (!c.metric_probe_passed) return "metric_contract_failed";
  if (!c.k_anon_passed) return "k_anon_below_threshold";
  if (!c.live_validated) return "requires_sql_validation";
  if (!RANKABLE_QUALITIES.has(c.source_quality)) return `not_rankable_source_${c.source_quality}`;
  return "not_rankable";
}

export type RankResult = { ranked: RankedLever[]; abstained: AbstainedLever[] };

export function rankLevers(candidates: LeverCandidate[], topN = 5): RankResult {
  const ranked: RankedLever[] = [];
  const abstained: AbstainedLever[] = [];

  for (const c of candidates) {
    if (!isRankable(c)) {
      abstained.push({
        constraint: c.constraint,
        reason: nonRankableReason(c),
        source_quality: c.source_quality,
      });
      continue;
    }
    const rate = c.numerator / c.denominator;
    const bucket_volume = c.denominator;
    const score = bucket_volume * rate * QUALITY_WEIGHT[c.source_quality];
    ranked.push({ ...c, rate, bucket_volume, score, rank: 0 });
  }

  ranked.sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, topN).map((r, i) => ({ ...r, rank: i + 1 }));
  for (const r of ranked.slice(topN)) {
    abstained.push({ constraint: r.constraint, reason: "outside_top_5", source_quality: r.source_quality });
  }
  return { ranked: top, abstained };
}
