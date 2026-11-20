
export const NONCE_RE = /\b[A-Z]{3,}-[A-Z]{3,}-\d{3}\b/g;

export type NeedleVerdict =
  | "pass"
  | "prompt_missing"
  | "answer_missing"
  | "hallucinated"
  | "bleed";

export type NeedleResult = {
  nonce: string;
  prompt_has: boolean;
  answer_has: boolean;
  foreign_known: string[];
  hallucinated: string[];
  verdict: NeedleVerdict;
};

export function evaluateNeedle(args: {
  prompt: string;
  answer: string;
  nonce: string;
  allNonces: string[];
}): NeedleResult {
  const { prompt, answer, nonce } = args;
  const others = new Set(args.allNonces.filter((n) => n !== nonce));

  const prompt_has = prompt.includes(nonce);
  const answer_has = answer.includes(nonce);

  const found = answer.match(NONCE_RE) ?? [];
  const foreign_known: string[] = [];
  const hallucinated: string[] = [];
  for (const tok of new Set(found)) {
    if (tok === nonce) continue;
    if (others.has(tok)) foreign_known.push(tok);
    else hallucinated.push(tok);
  }

  let verdict: NeedleVerdict;
  if (!prompt_has) verdict = "prompt_missing";
  else if (hallucinated.length > 0) verdict = "hallucinated";
  else if (!answer_has) verdict = "answer_missing";
  else if (foreign_known.length > 0) verdict = "bleed";
  else verdict = "pass";

  return { nonce, prompt_has, answer_has, foreign_known, hallucinated, verdict };
}

export type NeedleSummary = {
  total: number;
  passed: number;
  pass_rate: number;
  by_verdict: Record<NeedleVerdict, number>;
  failures: NeedleResult[];
};

const VERDICTS: NeedleVerdict[] = [
  "pass",
  "prompt_missing",
  "answer_missing",
  "hallucinated",
  "bleed",
];

export function summarizeNeedleRun(results: NeedleResult[]): NeedleSummary {
  const by_verdict = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<
    NeedleVerdict,
    number
  >;
  for (const r of results) by_verdict[r.verdict] += 1;
  const passed = by_verdict.pass;
  const total = results.length;
  return {
    total,
    passed,
    pass_rate: total === 0 ? 0 : passed / total,
    by_verdict,
    failures: results.filter((r) => r.verdict !== "pass"),
  };
}
