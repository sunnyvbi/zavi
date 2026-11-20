
import { HarnessFailure } from "@/services/eval/shadow-harness";
import type { BenchModelClient } from "./client";
import type { TaskFixture } from "./fixtures";
import type { ManifestEntry } from "./manifest";
import type { TrialResult } from "./runner";
import { isRetryableProviderError, reservationFor, type SpendLedger } from "./spend";
import { judgeAnswerText } from "./prod-reference";
import { requestText } from "./miner";

const FORBIDDEN_ATTEMPT_CODES = new Set(["shadow_no_side_effect", "bench_tool_outside_boundary"]);
const INVALID_TOOL_CALL_CODES = new Set([
  "tool_input_invalid",
  "tool_unknown",
  "invalid_input",
  "input_validation",
  "bad_input",
  "schema_error",
]);

export type HardChecks = {
  schema_ok: boolean;
  forbidden_attempts: number;
  tool_calls: number;
  invalid_tool_calls: number;
  build_ok?: boolean;
  pass: boolean;
};

export function buildStepOk(raw: NonNullable<TrialResult["raw"]>): boolean {
  const c = raw.engineer_checks;
  if (!c) return true;
  if (c.typecheck_ok === false || c.typecheck_verified === false) return false;
  if (c.tests_failed !== null && c.tests_failed > 0) return false;
  return raw.code_diff === undefined || raw.code_diff.trim().length > 0;
}

export function hardChecks(r: TrialResult): HardChecks {
  const calls = r.raw?.tool_calls ?? [];
  const forbidden = calls.filter((c) => FORBIDDEN_ATTEMPT_CODES.has(c.code ?? "")).length;
  const invalid = calls.filter((c) => INVALID_TOOL_CALL_CODES.has(c.code ?? "")).length;
  const schema_ok = r.raw?.parse_ok === true;
  const build_ok = r.raw?.engineer_checks ? buildStepOk(r.raw) : undefined;
  return {
    schema_ok,
    forbidden_attempts: forbidden,
    tool_calls: calls.length,
    invalid_tool_calls: invalid,
    ...(build_ok === undefined ? {} : { build_ok }),
    pass: r.outcome === "completed" && schema_ok && forbidden === 0 && invalid === 0 && build_ok !== false,
  };
}

const EVIDENCE_CHARS_PER_RECORD = 4_000;
const EVIDENCE_CHARS_TOTAL = 40_000;
const TEXT_CHARS = 12_000;
const PROD_REF_ANSWER_CHARS = 32_000;
export const JUDGE_REASON_CHARS = 200;

export const JUDGE_SYSTEM =
  "You compare two anonymous answers to the same task. You do not know which " +
  "system wrote either answer. Judge which answer better does the task for the " +
  "person who asked, using the task and the evidence the tools returned: correct " +
  "and grounded in the evidence beats fluent, and a usable answer beats an empty " +
  "or failed one. Answer format is not a criterion unless the task asks for one. " +
  'Reply with JSON only: {"better":"A"|"B"|"tie","reason":"<=200 chars"}';

export function buildJudgePrompt(f: TaskFixture, answerA: string, answerB: string): string {
  let used = 0;
  const ev: string[] = [];
  for (const [i, r] of f.evidence.entries()) {
    const block =
      `[${i}] ${r.tool_name}(${JSON.stringify(r.input ?? null).slice(0, 300)})\n` +
      r.content.slice(0, EVIDENCE_CHARS_PER_RECORD);
    if (used + block.length > EVIDENCE_CHARS_TOTAL) break;
    ev.push(block);
    used += block.length;
  }
  const cap = f.prod_reference ? PROD_REF_ANSWER_CHARS : TEXT_CHARS;
  const codeNote = f.prod_reference
    ? `\n## The request\n${requestText({ payload: f.input.payload, prompt_snapshot: null, trigger: f.input.trigger }).slice(0, 4_000) || "(see task)"}\n` +
      "\n## How to read the answers\nThis is a code task on a real repo. Each answer is the agent's final report " +
      "followed by the code change it actually made, as a diff from the SAME starting commit. Judge the code change " +
      "first: does it do what was asked, correctly and completely, without breaking what was there? The report only " +
      "counts where the diff backs it.\n"
    : "";
  return (
    `## Task\n${f.input.prompt.initial_user.slice(0, TEXT_CHARS) || "(see payload)"}\n` +
    `Payload: ${JSON.stringify(f.input.payload ?? null).slice(0, 2_000)}\n${codeNote}\n` +
    `## Evidence (${f.evidence.length} records)\n${ev.join("\n\n") || "(none)"}\n\n` +
    `## Answer A\n${answerA.slice(0, cap)}\n\n## Answer B\n${answerB.slice(0, cap)}`
  );
}

export type JudgeVerdict = { better: "A" | "B" | "tie"; reason: string };

export function parseJudge(text: string): JudgeVerdict {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("judge returned no JSON");
  const o = JSON.parse(m[0]) as Record<string, unknown>;
  if (o.better !== "A" && o.better !== "B" && o.better !== "tie") {
    throw new Error(`judge verdict 'better' must be A | B | tie`);
  }
  if (typeof o.reason !== "string") throw new Error("judge verdict 'reason' must be a string");
  return { better: o.better, reason: o.reason.slice(0, JUDGE_REASON_CHARS) };
}

export type Verdict = "better" | "same" | "worse";

export function aggregateVerdict(votes: ReadonlyArray<Verdict>): Verdict {
  const n = (v: Verdict) => votes.filter((x) => x === v).length;
  if (n("better") * 2 > votes.length) return "better";
  if (n("worse") * 2 > votes.length) return "worse";
  return "same";
}

export const VERDICT_SCORE: Readonly<Record<Verdict, number>> = { better: 1, same: 0, worse: -1 };

export type PairJudgement = {
  task_id: string;
  trial: number;
  votes: Verdict[];
  verdict: Verdict;
  judge_calls: number;
};

export async function judgePair(args: {
  fixture: TaskFixture;
  candidate: TrialResult;
  reference: TrialResult;
  judges: readonly [ManifestEntry, ManifestEntry];
  client: BenchModelClient;
  ledger: SpendLedger;
}): Promise<PairJudgement | null> {
  const { fixture: f, candidate, reference } = args;
  const cand = judgeAnswerText(candidate.raw);
  const ref = judgeAnswerText(reference.raw);
  const votes: Verdict[] = [];
  for (const judge of args.judges) {
    for (const candidateIsA of [true, false]) {
      const res = args.ledger.tryReserve(reservationFor("judge"), `judge:${f.task_id}#${candidate.trial}`);
      if (!res) {
        console.warn(`[model-bench] judge pair ${f.task_id}#${candidate.trial} incomplete: --max-usd reached`);
        return null;
      }
      let billed: number | undefined;
      try {
        const out = await args.client.complete({
          model: judge,
          system: JUDGE_SYSTEM,
          user: candidateIsA ? buildJudgePrompt(f, cand, ref) : buildJudgePrompt(f, ref, cand),
          maxTokens: 4000,
        });
        billed = out.billedUsd;
        const v = parseJudge(out.text);
        const candLabel = candidateIsA ? "A" : "B";
        votes.push(v.better === "tie" ? "same" : v.better === candLabel ? "better" : "worse");
      } catch (e) {
        if (e instanceof HarnessFailure) throw e;
        if (isRetryableProviderError(e, "openrouter")) throw e;
        console.warn(
          `[model-bench] judge ${judge.key} call dropped (${f.task_id}#${candidate.trial}): ${(e as Error)?.message ?? String(e)}`.slice(0, 400),
        );
      } finally {
        args.ledger.settle(res, billed);
      }
    }
  }
  if (votes.length !== args.judges.length * 2) return null;
  return {
    task_id: f.task_id,
    trial: candidate.trial,
    votes,
    verdict: aggregateVerdict(votes),
    judge_calls: votes.length,
  };
}

export type ScoredTrial = {
  task_id: string;
  unit: string;
  cohort: TaskFixture["cohort"];
  company: string;
  trial: number;
  outcome: TrialResult["outcome"] | "judge_incomplete";
  hard: HardChecks;
  judge: PairJudgement | null;
  verdict: Verdict | null;
  pass: boolean | null;
};

export function isExcludedOutcome(o: TrialResult["outcome"]): boolean {
  return o === "infra" || o === "unattributed" || o === "discarded_unpinned" || o === "capped";
}

export function scoreTrial(r: TrialResult, judge: PairJudgement | null, judgesRequired = false): ScoredTrial {
  const hard = hardChecks(r);
  const excluded = isExcludedOutcome(r.outcome);
  const judgeMissing = judgesRequired && r.outcome === "completed" && !judge;
  let pass: boolean | null = null;
  if (!excluded && !judgeMissing) pass = hard.pass && judge?.verdict !== "worse";
  return {
    task_id: r.task_id,
    unit: r.unit,
    cohort: r.cohort,
    company: r.company,
    trial: r.trial,
    outcome: judgeMissing ? "judge_incomplete" : r.outcome,
    hard,
    judge,
    verdict: excluded ? null : (judge?.verdict ?? null),
    pass,
  };
}

export type TaskRate = {
  task_id: string;
  unit: string;
  cohort: TaskFixture["cohort"];
  company: string;
  passes: number;
  n: number;
};

export function taskRates(scored: ReadonlyArray<ScoredTrial>): TaskRate[] {
  const m = new Map<string, TaskRate>();
  for (const s of scored) {
    if (s.pass === null) continue;
    const t = m.get(s.task_id) ?? {
      task_id: s.task_id,
      unit: s.unit,
      cohort: s.cohort,
      company: s.company,
      passes: 0,
      n: 0,
    };
    t.n++;
    if (s.pass) t.passes++;
    m.set(s.task_id, t);
  }
  return [...m.values()].sort((a, b) => (a.task_id < b.task_id ? -1 : 1));
}

export function trialPassRate(scored: ReadonlyArray<ScoredTrial>): { passes: number; n: number; rate: number } {
  const counted = scored.filter((s) => s.pass !== null);
  const passes = counted.filter((s) => s.pass).length;
  return { passes, n: counted.length, rate: counted.length ? passes / counted.length : 0 };
}

export function verdictCounts(scored: ReadonlyArray<ScoredTrial>): Record<Verdict, number> & { unjudged: number } {
  const c = { better: 0, same: 0, worse: 0, unjudged: 0 };
  for (const s of scored) {
    if (s.verdict) c[s.verdict]++;
    else c.unjudged++;
  }
  return c;
}

export function allTrialsPassed(rates: ReadonlyArray<TaskRate>, trials: number): { k: number; of: number } {
  const full = rates.filter((r) => r.n === trials);
  return { k: full.filter((r) => r.passes === r.n).length, of: full.length };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PairedGap = {
  tasks: number;
  gap: number;
  lo: number;
  hi: number;
};

export function verdictGap(
  scored: ReadonlyArray<ScoredTrial>,
  opts: { iterations?: number; seed?: number } = {},
): PairedGap | null {
  const perTask = new Map<string, { stratum: string; sum: number; n: number }>();
  for (const s of scored) {
    if (!s.verdict) continue;
    const t = perTask.get(s.task_id) ?? { stratum: `${s.cohort}|${s.company}`, sum: 0, n: 0 };
    t.sum += VERDICT_SCORE[s.verdict];
    t.n++;
    perTask.set(s.task_id, t);
  }
  const diffs = [...perTask.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, t]) => ({ stratum: t.stratum, d: t.sum / t.n }));
  if (diffs.length === 0) return null;
  const gap = diffs.reduce((s, x) => s + x.d, 0) / diffs.length;
  const strata = new Map<string, number[]>();
  for (const x of diffs) strata.set(x.stratum, [...(strata.get(x.stratum) ?? []), x.d]);
  const rand = mulberry32(opts.seed ?? 20260925);
  const B = opts.iterations ?? 2000;
  const boots: number[] = [];
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (const ds of strata.values()) {
      for (let i = 0; i < ds.length; i++) sum += ds[Math.floor(rand() * ds.length)];
    }
    boots.push(sum / diffs.length);
  }
  boots.sort((a, b) => a - b);
  const q = (p: number) => boots[Math.min(boots.length - 1, Math.max(0, Math.floor(p * boots.length)))];
  return { tasks: diffs.length, gap, lo: q(0.025), hi: q(0.975) };
}
