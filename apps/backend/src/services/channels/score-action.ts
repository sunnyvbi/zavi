
export const SCORE_VERSION = 2;

export const SCORE_WEIGHTS = {
  impact: 60,
  goal_fit: 25,
  rank: 15,
  previously_rejected: 30,
} as const;

export type ScoreInput = {
  impact: number | null;
  position: number;
  run_of: number;
  channel_in_plan: boolean;
  metric_matches_goal: boolean;
  previously_rejected: boolean;
  money_at_stake_usd?: number | null;
  money_at_stake_max_usd?: number | null;
};

export type ScoreInputs = ScoreInput & {
  impact_n: number;
  goal_fit: number;
  rank_n: number;
  weights: typeof SCORE_WEIGHTS;
  version: number;
};

export type ScoredAction = { score: number; score_inputs: ScoreInputs };

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function finitePositive(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

export function scoreAction(input: ScoreInput): ScoredAction {
  const impact =
    typeof input.impact === "number" && Number.isInteger(input.impact) && input.impact >= 1 && input.impact <= 5
      ? input.impact
      : null;
  const impact_n = impact === null ? 0.5 : (impact - 1) / 4;
  const goal_fit =
    input.channel_in_plan && input.metric_matches_goal
      ? 1
      : input.channel_in_plan || input.metric_matches_goal
        ? 0.5
        : 0;
  const position = Math.max(1, Math.floor(input.position || 1));
  const run_of = Math.max(1, Math.floor(input.run_of || 1));
  const money = finitePositive(input.money_at_stake_usd);
  const moneyMax = finitePositive(input.money_at_stake_max_usd);
  const rank_n =
    money !== null && moneyMax !== null
      ? clamp01(money / moneyMax)
      : clamp01(1 - (position - 1) / Math.max(run_of - 1, 1));
  const raw =
    SCORE_WEIGHTS.impact * impact_n +
    SCORE_WEIGHTS.goal_fit * goal_fit +
    SCORE_WEIGHTS.rank * rank_n -
    SCORE_WEIGHTS.previously_rejected * (input.previously_rejected ? 1 : 0);
  const score = Math.round(Math.min(100, Math.max(0, raw)) * 100) / 100;
  return {
    score,
    score_inputs: {
      ...input,
      impact,
      impact_n,
      goal_fit,
      rank_n,
      weights: SCORE_WEIGHTS,
      version: SCORE_VERSION,
    },
  };
}

export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 300);
}
