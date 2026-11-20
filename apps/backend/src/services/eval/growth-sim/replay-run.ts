
import { buildReview, replayApply, type ReplayOutcome, type ReplayToolCall, type ReplayWorld } from "./decision-replay";
import type { ReplayCase } from "./replay-cases";

export type ReplayCall = (
  systemPrompt: string,
  userPrompt: string,
  world: ReplayWorld,
) => Promise<{ text: string; toolCalls: ReplayToolCall[]; tokens: number; costUsd: number; turns?: number }>;

export type AttemptResult = {
  pass: boolean;
  judge: string[];
  safety: string[];
  outcome: ReplayOutcome;
  raw: string;
  costUsd: number;
  tokens: number;
  turns: number;
  error?: string;
};

export type CaseResult = { id: string; title: string; pass: boolean; attempts: AttemptResult[]; costUsd: number };

export async function runReplayCases(args: {
  cases: ReplayCase[];
  k: number;
  systemPrompt: (company: string) => Promise<string>;
  call: ReplayCall;
  onAttempt?: (id: string, i: number, a: AttemptResult) => void;
}): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of args.cases) {
    const { payload, userPrompt } = buildReview(c.world);
    const system = await args.systemPrompt(c.world.company);
    const attempts: AttemptResult[] = [];
    for (let i = 0; i < args.k; i++) {
      let a: AttemptResult;
      try {
        const r = await args.call(system, userPrompt, c.world);
        const outcome = replayApply(c.world, payload, r.text, r.toolCalls);
        const judge = c.judge(outcome);
        const safety = c.safety(outcome);
        a = { pass: judge.length === 0 && safety.length === 0, judge, safety, outcome, raw: r.text, costUsd: r.costUsd, tokens: r.tokens, turns: r.turns ?? 0 };
      } catch (e) {
        a = {
          pass: false,
          judge: [],
          safety: [],
          outcome: { parsed: { ok: false, reason: "call failed" }, applied: [], held: [], questions: [], refused: [], left: [], items: [], toolCalls: [] },
          raw: "",
          costUsd: 0,
          tokens: 0,
          turns: 0,
          error: (e as Error).message.slice(0, 500),
        };
      }
      attempts.push(a);
      args.onAttempt?.(c.id, i, a);
    }
    out.push({ id: c.id, title: c.title, pass: attempts.every((a) => a.pass), attempts, costUsd: attempts.reduce((s, a) => s + a.costUsd, 0) });
  }
  return out;
}

export function replayReport(results: CaseResult[], k: number, model: string): string {
  const cost = results.reduce((s, r) => s + r.costUsd, 0);
  const passed = results.filter((r) => r.pass).length;
  const lines = [
    `# cgo decision replay (live)`,
    ``,
    `Model: ${model} · pass^${k} · ${passed}/${results.length} cases passed · cost $${cost.toFixed(2)}`,
    ``,
    `| case | result | why | cost |`,
    `|---|---|---|---|`,
  ];
  for (const r of results) {
    const why = r.attempts
      .map((a, i) => (a.error ? `#${i + 1} error: ${a.error}` : a.pass ? `#${i + 1} ok` : `#${i + 1} ${[...a.judge, ...a.safety.map((s) => `SERVER: ${s}`)].join("; ")}`))
      .join(" / ");
    lines.push(`| ${r.id} | ${r.pass ? "PASS" : "FAIL"} | ${why.replace(/\|/g, "/")} | $${r.costUsd.toFixed(2)} |`);
  }
  return lines.join("\n");
}
