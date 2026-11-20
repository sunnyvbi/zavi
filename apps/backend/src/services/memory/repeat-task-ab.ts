
import { AB_ARMS, type AbArm, type AbArmResult } from "./repeat-task-ab-types";

export type AbDispatchResult = {
  output_text: string;
  parse_ok: boolean;
  prompt_snapshot?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
  };
};

export function dispatcherResultToArmResult(args: {
  golden: { id: string; tenant_id: string; agent_slug: string };
  arm: AbArm;
  eval_run_id: string;
  result: AbDispatchResult;
  walltime_ms: number;
}): AbArmResult {
  const { golden, arm, eval_run_id, result, walltime_ms } = args;
  const u = result.usage;
  return {
    tenant_id: golden.tenant_id,
    agent_slug: golden.agent_slug,
    golden_id: golden.id,
    eval_run_id,
    arm,
    correctness_score: null,
    model_cost_usd: typeof u?.cost_usd === "number" ? u.cost_usd : null,
    retrieval_cost_usd: null,
    judge_cost_usd: null,
    walltime_ms,
    terminal_status: result.parse_ok ? "finished" : "parse_failed",
  };
}

export interface RepeatTaskAbDeps {
  dispatch: (
    golden: RepeatTaskGoldenLite,
    arm: AbArm,
  ) => Promise<AbDispatchResult>;
  writeMetric: (row: AbArmResult) => Promise<void>;
  newEvalRunId: () => string;
  now: () => number;
}

export type RepeatTaskGoldenLite = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  query: string;
};

export type AbArmOutcome =
  | { arm: AbArm; ok: true; row: AbArmResult; output_text: string }
  | { arm: AbArm; ok: false; kind: "dispatch_error" | "metric_write_error"; error: string };

export async function runRepeatTaskAb(
  golden: RepeatTaskGoldenLite,
  deps: RepeatTaskAbDeps,
): Promise<{ eval_run_id: string; outcomes: AbArmOutcome[] }> {
  const eval_run_id = deps.newEvalRunId();
  const outcomes: AbArmOutcome[] = [];

  for (const arm of AB_ARMS) {
    const started = deps.now();

    let result: AbDispatchResult;
    try {
      result = await deps.dispatch(golden, arm);
    } catch (e) {
      const errRow: AbArmResult = {
        tenant_id: golden.tenant_id,
        agent_slug: golden.agent_slug,
        golden_id: golden.id,
        eval_run_id,
        arm,
        correctness_score: null,
        model_cost_usd: null,
        retrieval_cost_usd: null,
        judge_cost_usd: null,
        walltime_ms: deps.now() - started,
        terminal_status: "dispatch_error",
      };
      try {
        await deps.writeMetric(errRow);
      } catch {
      }
      outcomes.push({ arm, ok: false, kind: "dispatch_error", error: (e as Error).message });
      continue;
    }

    const row = dispatcherResultToArmResult({
      golden,
      arm,
      eval_run_id,
      result,
      walltime_ms: deps.now() - started,
    });
    try {
      await deps.writeMetric(row);
    } catch (e) {
      outcomes.push({
        arm,
        ok: false,
        kind: "metric_write_error",
        error: (e as Error).message,
      });
      continue;
    }
    outcomes.push({ arm, ok: true, row, output_text: result.output_text });
  }

  return { eval_run_id, outcomes };
}

