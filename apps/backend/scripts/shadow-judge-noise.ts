#!/usr/bin/env tsx

import { serviceClient } from "../src/services/supabase";
import { MODELS } from "../src/services/llm/models";
import {
  gradeShadowRowCore,
  type ShadowJudgeFn,
} from "../src/services/eval/engine-parity/engine-parity";
import { makeBedrockJudgeFn, resolveBedrockJudgeModel } from "../src/services/eval/engine-parity/bedrock-judge";

const DOGFOOD_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

export type NoiseRow = {
  shadow_id: string;
  agent_slug: string;
  input_prompt: string;
  candidate_raw: string;
  baseline_raw: string;
  shadow_model: string;
};

export type NoiseResult = {
  rows_evaluated: number;
  pairs: number;
  flips: number;
  flip_rate: number;
  judge_unavailable: number;
  threshold: number;
  reliable: boolean;
};

export function countRowFlips(scores: number[]): { flips: number; pairs: number } {
  let flips = 0;
  const pairs = Math.max(0, scores.length - 1);
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] !== scores[i - 1]) flips++;
  }
  return { flips, pairs };
}

export function summarizeNoise(
  perRow: { flips: number; pairs: number }[],
  judgeUnavailable: number,
  rowsEvaluated: number,
  threshold: number,
): NoiseResult {
  const flips = perRow.reduce((s, r) => s + r.flips, 0);
  const pairs = perRow.reduce((s, r) => s + r.pairs, 0);
  const flip_rate = pairs > 0 ? flips / pairs : 0;
  const reliable = pairs > 0 && flip_rate < threshold && judgeUnavailable === 0;
  return {
    rows_evaluated: rowsEvaluated,
    pairs,
    flips,
    flip_rate: Math.round(flip_rate * 10000) / 10000,
    judge_unavailable: judgeUnavailable,
    threshold,
    reliable,
  };
}

type Args = { limit: number; rounds: number; threshold: number; agent?: string };

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 50, rounds: 3, threshold: 0.1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") out.limit = Math.max(1, Number(argv[++i]) || 50);
    else if (argv[i] === "--rounds") out.rounds = Math.max(2, Number(argv[++i]) || 3);
    else if (argv[i] === "--threshold") out.threshold = Math.max(0, Math.min(1, Number(argv[++i]) || 0.1));
    else if (argv[i] === "--agent") out.agent = argv[++i];
  }
  return out;
}

async function selectDogfoodRows(args: Args): Promise<NoiseRow[]> {
  const sb = serviceClient();
  let q = sb
    .from("agent_shadow_runs")
    .select(
      "id, agent_slug, output_text, model, " +
        "agent_runs!inner(tenant_id, payload, raw_response_text)",
    )
    .in("status", ["success", "parse_failed"])
    .not("output_text", "is", null)
    .eq("agent_runs.tenant_id", DOGFOOD_TENANT)
    .order("created_at", { ascending: false })
    .limit(args.limit);
  if (args.agent) q = q.eq("agent_slug", args.agent);

  const { data, error } = await q;
  if (error) throw new Error(`select failed: ${error.message}`);

  return ((data ?? []) as unknown as Record<string, unknown>[])
    .map((r) => {
      const src = (r.agent_runs ?? {}) as { payload?: unknown; raw_response_text?: string | null };
      return {
        shadow_id: String(r.id),
        agent_slug: String(r.agent_slug),
        input_prompt: typeof src.payload === "string" ? src.payload : JSON.stringify(src.payload ?? {}),
        candidate_raw: (r.output_text as string | null) ?? "",
        baseline_raw: src.raw_response_text ?? "",
        shadow_model: typeof r.model === "string" ? (r.model as string) : "",
      };
    })
    .filter((r) => r.candidate_raw.trim().length > 0 && r.baseline_raw.trim().length > 0);
}

export async function runNoise(
  rows: NoiseRow[],
  judge: ShadowJudgeFn,
  judgeModel: string,
  rounds: number,
  threshold: number,
): Promise<NoiseResult> {
  const perRow: { flips: number; pairs: number }[] = [];
  let judgeUnavailable = 0;
  let evaluated = 0;

  for (const row of rows) {
    const scores: number[] = [];
    let outage = false;
    for (let round = 0; round < rounds; round++) {
      const coin: 0 | 1 = round % 2 === 0 ? 0 : 1;
      const candidateModel = row.shadow_model || MODELS.bedrock.qwen3Next80b;
      const result = await gradeShadowRowCore({
        row: {
          id: row.shadow_id,
          agent_slug: row.agent_slug,
          input_prompt: row.input_prompt,
          candidate_raw: row.candidate_raw,
          baseline_raw: row.baseline_raw,
        },
        judge,
        judgeModel,
        candidateModel,
        baselineModel: MODELS.anthropic.opus,
        coin,
        judgeFamily: "bedrock",
      });
      if (result.kind === "judge_unavailable") {
        outage = true;
        break;
      }
      scores.push(result.comparison_score);
    }
    if (outage) {
      judgeUnavailable++;
      continue;
    }
    evaluated++;
    perRow.push(countRowFlips(scores));
  }

  return summarizeNoise(perRow, judgeUnavailable, evaluated, threshold);
}

function render(res: NoiseResult): string {
  const lines: string[] = [];
  lines.push("\nshadow judge-noise gate (Bedrock in-VPC blind judge)");
  lines.push(`  rows evaluated:    ${res.rows_evaluated}`);
  lines.push(`  swapped pairs:     ${res.pairs}`);
  lines.push(`  score flips:       ${res.flips}`);
  lines.push(`  FLIP-RATE:         ${(res.flip_rate * 100).toFixed(1)}%  (threshold <${(res.threshold * 100).toFixed(0)}%)`);
  lines.push(`  judge unavailable: ${res.judge_unavailable}`);
  lines.push(
    `  VERDICT: ${res.reliable ? "GO — judge is reliable (low position-bias noise)" : "NO-GO — judge too noisy or unavailable; do NOT trust the shadow scorecard"}`,
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await selectDogfoodRows(args);
  if (rows.length === 0) {
    console.log("no gradeable dogfood shadow rows (need both raw outputs present).");
    process.exit(1);
  }
  console.log(`re-grading ${rows.length} dogfood row(s) × ${args.rounds} swapped rounds via gradeShadowRowCore...`);
  const judge = makeBedrockJudgeFn();
  const res = await runNoise(rows, judge, resolveBedrockJudgeModel(), args.rounds, args.threshold);
  console.log(render(res));
  process.exit(res.reliable ? 0 : 1);
}

if (process.argv[1] && /shadow-judge-noise\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
