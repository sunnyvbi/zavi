
import {
  type StartCardAiEvidence,
  type StartCardCheckKey,
  type StartCardCompareEvidence,
  type StartCardDesignEvidence,
  type StartCardGoogleEvidence,
  type StartCardParts,
  type StartCardSeoEvidence,
} from "@zavi/shared";
import { StageUnavailableError, rivalsWithSite, type StageContext, type StageOutcome } from "./contract";
import { aiPointsFromCounts, comparePoints, googlePoints, rankOf } from "./points";
import { compareNote } from "./notes";

const SUMMED: readonly StartCardCheckKey[] = ["google", "ai", "seo", "design"];

type SiteScores = Partial<Record<StartCardCheckKey, number | null>>;

function done<E>(part: { state: string; evidence: E | null; points?: number } | undefined): { evidence: E; points: number } | null {
  return part?.state === "done" && part.evidence && typeof part.points === "number"
    ? { evidence: part.evidence, points: part.points }
    : null;
}

export function rivalScores(parts: StartCardParts, domain: string): SiteScores {
  const out: SiteScores = {};
  const g = done<StartCardGoogleEvidence>(parts.google);
  if (g) {
    const row = g.evidence.rivals.find((r) => r.domain === domain);
    out.google = row ? googlePoints(row.position) : null;
  }
  const a = done<StartCardAiEvidence>(parts.ai);
  if (a) {
    const answered = a.evidence.engines.filter((e) => e.answered);
    out.ai = answered.every((e) => Array.isArray(e.rivals_mentioned))
      ? aiPointsFromCounts(answered.filter((e) => e.rivals_mentioned!.includes(domain)).length, answered.length)
      : null;
  }
  const s = done<StartCardSeoEvidence>(parts.seo);
  if (s) out.seo = s.evidence.rivals?.find((r) => r.domain === domain)?.points ?? null;
  const d = done<StartCardDesignEvidence>(parts.design);
  if (d) out.design = d.evidence.rivals.find((r) => r.domain === domain)?.points ?? null;
  return out;
}

export function buildCompare(
  business: string,
  parts: StartCardParts,
  rivals: readonly string[],
): { evidence: StartCardCompareEvidence; points: number } | null {
  if (rivals.length === 0) return null;
  const mine: SiteScores = {};
  for (const k of SUMMED) {
    const p = parts[k];
    if (p?.state === "done" && typeof p.points === "number") mine[k] = p.points;
  }
  const all = rivals.map((d) => ({ domain: d, scores: rivalScores(parts, d) }));
  const measured = SUMMED.filter((k) => typeof mine[k] === "number");
  let checks_used: StartCardCheckKey[] = [];
  let theirs: typeof all = [];
  for (let mask = 1; mask < 1 << measured.length; mask++) {
    const keys = measured.filter((_, i) => mask & (1 << i));
    const kept = all.filter((t) => keys.every((k) => typeof t.scores[k] === "number"));
    const gain = kept.length * keys.length - theirs.length * checks_used.length;
    if (gain > 0 || (gain === 0 && kept.length > theirs.length)) {
      checks_used = keys;
      theirs = kept;
    }
  }
  if (checks_used.length === 0 || theirs.length === 0) return null;

  const sum = (s: SiteScores) => checks_used.reduce((acc, k) => acc + (s[k] as number), 0);
  const sites = [
    { domain: business, is_business: true, checks_total: sum(mine) },
    ...theirs.map((t) => ({ domain: t.domain, is_business: false, checks_total: sum(t.scores) })),
  ];
  const totals = sites.map((s) => s.checks_total);
  const ranking = sites
    .map((s) => ({ ...s, rank: rankOf(s.checks_total, totals) }))
    .sort((x, y) => x.rank - y.rank || Number(y.is_business) - Number(x.is_business) || x.domain.localeCompare(y.domain));
  const me = ranking.find((r) => r.is_business)!;
  const evidence: StartCardCompareEvidence = { ranking, checks_used };
  evidence.note = compareNote(evidence);
  return { evidence, points: comparePoints(me.rank, ranking.length) };
}

export async function runCompare(ctx: StageContext): Promise<StageOutcome<StartCardCompareEvidence>> {
  const rivals = rivalsWithSite(ctx).map((r) => r.domain);
  if (rivals.length === 0) throw new StageUnavailableError("no_rival_with_site");
  const built = buildCompare(ctx.domain, ctx.parts, rivals);
  if (!built) throw new StageUnavailableError("no_shared_checks");
  return { evidence: built.evidence, points: built.points, max_points: 20, cost_usd: 0 };
}
