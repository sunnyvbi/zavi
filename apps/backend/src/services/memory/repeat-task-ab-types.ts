
export type AbArm = "brain_on" | "brain_off";
export const AB_ARMS: readonly AbArm[] = ["brain_on", "brain_off"] as const;

export type RepeatTaskGolden = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  query: string;
  ideal_answer: string;
  rubric: Record<string, unknown>;
  active: boolean;
};

export type AbArmResult = {
  tenant_id: string;
  agent_slug: string;
  golden_id: string;
  eval_run_id: string;
  arm: AbArm;
  correctness_score: number | null;
  model_cost_usd: number | null;
  retrieval_cost_usd: number | null;
  judge_cost_usd: number | null;
  walltime_ms: number | null;
  terminal_status: string | null;
};

export type AbGoldenDelta = {
  golden_id: string;
  eval_run_id: string;
  correctness_on: number | null;
  correctness_off: number | null;
  correctness_delta: number | null;
  customer_cost_delta: number | null;
  total_cost_delta: number | null;
  both_arms_finished: boolean;
};

const CORRECTNESS_MIN = 0;
const CORRECTNESS_MAX = 1;

export function clampCorrectness(v: number | null | undefined): number | null {
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  return Math.min(CORRECTNESS_MAX, Math.max(CORRECTNESS_MIN, v));
}

function customerCost(r: AbArmResult): number | null {
  const m = r.model_cost_usd;
  const rt = r.retrieval_cost_usd;
  if (m == null && rt == null) return null;
  return (m ?? 0) + (rt ?? 0);
}

function totalCost(r: AbArmResult): number | null {
  const m = r.model_cost_usd;
  const rt = r.retrieval_cost_usd;
  const j = r.judge_cost_usd;
  if (m == null && rt == null && j == null) return null;
  return (m ?? 0) + (rt ?? 0) + (j ?? 0);
}

function sub(a: number | null, b: number | null): number | null {
  return a == null || b == null ? null : a - b;
}

export function computeGoldenDelta(results: readonly AbArmResult[]): AbGoldenDelta {
  const on = results.find((r) => r.arm === "brain_on");
  const off = results.find((r) => r.arm === "brain_off");
  const anchor = on ?? off;
  if (!anchor) {
    throw new Error("computeGoldenDelta: no arm results supplied");
  }
  for (const r of results) {
    if (r.golden_id !== anchor.golden_id || r.eval_run_id !== anchor.eval_run_id) {
      throw new Error("computeGoldenDelta: results span multiple goldens/runs");
    }
  }
  const armCounts = new Map<AbArm, number>();
  for (const r of results) armCounts.set(r.arm, (armCounts.get(r.arm) ?? 0) + 1);
  for (const [a, n] of armCounts) {
    if (n > 1) throw new Error(`computeGoldenDelta: duplicate '${a}' arm results (${n})`);
  }

  const cOn = clampCorrectness(on?.correctness_score);
  const cOff = clampCorrectness(off?.correctness_score);
  const bothFinished =
    on?.terminal_status === "finished" && off?.terminal_status === "finished";

  return {
    golden_id: anchor.golden_id,
    eval_run_id: anchor.eval_run_id,
    correctness_on: cOn,
    correctness_off: cOff,
    correctness_delta: sub(cOn, cOff),
    customer_cost_delta: sub(
      on ? customerCost(on) : null,
      off ? customerCost(off) : null,
    ),
    total_cost_delta: sub(on ? totalCost(on) : null, off ? totalCost(off) : null),
    both_arms_finished: bothFinished,
  };
}

export type AbRunSummary = {
  eval_run_id: string;
  goldens_compared: number;
  mean_correctness_delta: number | null;
  mean_customer_cost_delta: number | null;
  brain_helped_count: number;
  brain_hurt_count: number;
};

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function summarizeAbRun(
  eval_run_id: string,
  deltas: readonly AbGoldenDelta[],
): AbRunSummary {
  const scored = deltas.filter(
    (d) => d.both_arms_finished && d.correctness_delta != null,
  );
  const corr = scored.map((d) => d.correctness_delta as number);
  const cost = scored
    .map((d) => d.customer_cost_delta)
    .filter((x): x is number => x != null);
  return {
    eval_run_id,
    goldens_compared: scored.length,
    mean_correctness_delta: mean(corr),
    mean_customer_cost_delta: mean(cost),
    brain_helped_count: corr.filter((d) => d > 0).length,
    brain_hurt_count: corr.filter((d) => d < 0).length,
  };
}
