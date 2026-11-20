
import type { Provider } from "@/services/llm/models";
import type { CallModelResult } from "@/services/llm/call-model";
import type { NormalizedUsage } from "@/services/llm/normalize-usage";
import { estimateParityCostUsd } from "./pricing";

export type ParityTask = {
  task_id: string;
  agent_slug: string;
  label: string;
  system: string;
  prompt: string;
  expects_tools?: string[];
};

export type EngineCellStatus = "pass" | "skip" | "watch-red";

export type EngineCell = {
  task_id: string;
  provider: Provider;
  status: EngineCellStatus;
  reason: string;
  output: string;
  latency_ms: number;
  cost_usd: number;
  usage: NormalizedUsage;
  gated_tool_calls: number;
};

export type EngineRunCapture = {
  output: string;
  latency_ms: number;
  usage: NormalizedUsage;
  model: string;
  gated_tool_calls: number;
  errored: boolean;
  error_detail?: string;
};

export type RunTaskThroughEngine = (
  task: ParityTask,
  provider: Provider,
) => Promise<EngineRunCapture>;

export function assertEngineCell(
  task: ParityTask,
  provider: Provider,
  cap: EngineRunCapture,
): EngineCell {
  const base = {
    task_id: task.task_id,
    provider,
    output: cap.output ?? "",
    latency_ms: cap.latency_ms,
    cost_usd: estimateParityCostUsd(cap.model, cap.usage),
    usage: cap.usage,
    gated_tool_calls: cap.gated_tool_calls,
  };

  if (cap.errored) {
    return {
      ...base,
      status: "watch-red",
      reason: `run errored: ${cap.error_detail ?? "unknown error terminal"}`,
    };
  }
  if (!cap.output || cap.output.trim().length === 0) {
    return { ...base, status: "watch-red", reason: "empty output" };
  }
  const expectsTools = (task.expects_tools?.length ?? 0) > 0;
  if (expectsTools && cap.gated_tool_calls === 0) {
    return {
      ...base,
      status: "watch-red",
      reason: `expected tool calls (${task.expects_tools!.join(", ")}) but 0 fired through dispatchTool (gate not observed)`,
    };
  }
  return { ...base, status: "pass", reason: "" };
}

export function skipEngineCell(
  task_id: string,
  provider: Provider,
  reason: string,
): EngineCell {
  return {
    task_id,
    provider,
    status: "skip",
    reason,
    output: "",
    latency_ms: 0,
    cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    gated_tool_calls: 0,
  };
}

export type JudgeFamily = { name: string; wrapper: string };

export function buildJudgeFamilyLadder(opts?: {
  excludeOpenAiFamily?: boolean;
  homeDir?: string;
  env?: Record<string, string | undefined>;
}): JudgeFamily[] {
  const env = opts?.env ?? {};
  const home = opts?.homeDir ?? env.HOME ?? "";
  const lib = `${home}/.claude/skills/super-engineer/lib`;
  const codex: JudgeFamily = {
    name: "codex",
    wrapper: env.CODEX_CALL_SH || `${lib}/codex-call.sh`,
  };
  const grok: JudgeFamily = {
    name: "grok",
    wrapper: env.GROK_CALL_SH || `${lib}/grok-call.sh`,
  };
  const gemini: JudgeFamily = {
    name: "gemini",
    wrapper: env.GEMINI_CALL_SH || `${lib}/gemini-call.sh`,
  };
  return opts?.excludeOpenAiFamily ? [grok, gemini] : [codex, grok, gemini];
}

export type BedrockJudge = { name: "bedrock"; model: string };

export function buildBedrockJudgeLadder(opts?: {
  env?: Record<string, string | undefined>;
  defaultModel: string;
}): BedrockJudge[] {
  const env = opts?.env ?? {};
  const model = (env.PRAXIS_SHADOW_JUDGE_BEDROCK_MODEL || opts?.defaultModel || "").trim();
  return [{ name: "bedrock", model }];
}

export function normalizeForBlind(text: string): string {
  return (text || "")
    .replace(
      /\b(claude|anthropic|openai|chatgpt|gpt-?[0-9.]*o?(?:-[a-z]+)?|gemini|grok|bedrock|aws|qwen|zai|glm|llama)\b/gi,
      "the model",
    )
    .replace(/<\/?(antml:)?(function_calls?|invoke|parameter|thinking|answer|result)\b[^>]*>/gi, "")
    .replace(/\b(tool_calls?|function_call|assistant[_-]?message)\b/gi, "")
    .trim();
}

export function deriveComparisonScore(candidateScore: number, baselineScore: number): number {
  const raw = Math.round(2.5 + (candidateScore - baselineScore));
  return Math.max(0, Math.min(4, raw));
}

export function assignBlindLabels(
  candidateText: string,
  baselineText: string,
  coin: 0 | 1,
): {
  outputA: string;
  outputB: string;
  labelMap: { A: "candidate" | "baseline"; B: "candidate" | "baseline" };
} {
  const c = normalizeForBlind(candidateText);
  const b = normalizeForBlind(baselineText);
  if (coin === 0) {
    return { outputA: c, outputB: b, labelMap: { A: "candidate", B: "baseline" } };
  }
  return { outputA: b, outputB: c, labelMap: { A: "baseline", B: "candidate" } };
}

export function decodeScores(
  verdict: BlindJudgeVerdict,
  labelMap: { A: "candidate" | "baseline"; B: "candidate" | "baseline" },
): { candidate_score: number; baseline_score: number } {
  const scoreByRole = (role: "candidate" | "baseline"): number =>
    labelMap.A === role ? verdict.score_a : verdict.score_b;
  return { candidate_score: scoreByRole("candidate"), baseline_score: scoreByRole("baseline") };
}

export function modelFamily(model: string): string {
  const m = (model ?? "").trim().toLowerCase();
  if (/^claude[-_]/.test(m) || m.includes("anthropic")) return "anthropic";
  if (/^(gpt-?|o[13]|chatgpt)/.test(m) || m.includes("openai")) return "openai";
  if (m.startsWith("qwen")) return "qwen";
  if (m.startsWith("meta.llama") || m.startsWith("llama")) return "llama";
  if (m.startsWith("mistral")) return "mistral";
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("zai") || m.includes("glm")) return "zai";
  if (m.includes("gemini")) return "gemini";
  if (m.includes("grok")) return "grok";
  const seg = m.split(/[.\-]/)[0];
  return seg || "unknown";
}

export function assertJudgeNotContestant(args: {
  judgeModel: string;
  candidateModel: string;
  baselineModel: string;
}): void {
  const { judgeModel, candidateModel, baselineModel } = args;
  const jm = (judgeModel ?? "").trim();
  if (jm.length === 0) {
    throw new Error("blind-grade fairness: judge model is empty (PRAXIS_SHADOW_JUDGE_BEDROCK_MODEL unset?).");
  }
  if (jm === (candidateModel ?? "").trim()) {
    throw new Error(
      `blind-grade fairness: judge_model "${jm}" === shadow_model — a model cannot blind-judge itself. ` +
        `Set PRAXIS_SHADOW_JUDGE_BEDROCK_MODEL to a non-contestant model.`,
    );
  }
  if (jm === (baselineModel ?? "").trim()) {
    throw new Error(
      `blind-grade fairness: judge_model "${jm}" === baseline_model — a model cannot blind-judge itself.`,
    );
  }
  const jf = modelFamily(jm);
  const cf = modelFamily(candidateModel);
  const bf = modelFamily(baselineModel);
  if (jf === cf || jf === bf) {
    throw new Error(
      `blind-grade fairness: judge family "${jf}" matches a contestant family ` +
        `(candidate="${cf}", baseline="${bf}"). The blind judge must not share a family with EITHER contestant.`,
    );
  }
}

export type ShadowJudgeFn = (prompt: { system: string; user: string }) => Promise<string | null>;

export type ShadowGradeRowInput = {
  id: string;
  agent_slug: string;
  input_prompt: string;
  candidate_raw: string;
  baseline_raw: string;
};

export type ShadowGradeCoreOutcome =
  | {
      kind: "graded";
      comparison_score: number;
      candidate_score: number;
      baseline_score: number;
      winner_label: "A" | "B" | "tie";
      justification: string;
      judge_family: string;
    }
  | { kind: "judge_unavailable" };

export async function gradeShadowRowCore(args: {
  row: ShadowGradeRowInput;
  judge: ShadowJudgeFn;
  judgeModel: string;
  candidateModel: string;
  baselineModel: string;
  coin: 0 | 1;
  judgeFamily?: string;
}): Promise<ShadowGradeCoreOutcome> {
  assertJudgeNotContestant({
    judgeModel: args.judgeModel,
    candidateModel: args.candidateModel,
    baselineModel: args.baselineModel,
  });

  const task: ParityTask = {
    task_id: args.row.id,
    agent_slug: args.row.agent_slug,
    label: `shadow grade ${args.row.agent_slug}`,
    system: "",
    prompt: args.row.input_prompt,
  };
  const { outputA, outputB, labelMap } = assignBlindLabels(
    args.row.candidate_raw,
    args.row.baseline_raw,
    args.coin,
  );
  const prompt = buildBlindJudgePrompt(task, outputA, outputB);

  let raw: string | null;
  try {
    raw = await args.judge(prompt);
  } catch {
    raw = null;
  }
  if (raw === null) return { kind: "judge_unavailable" };

  const verdict = parseBlindJudgeReply(task.task_id, raw);
  if (verdict.error) return { kind: "judge_unavailable" };

  const { candidate_score, baseline_score } = decodeScores(verdict, labelMap);
  const comparison_score = deriveComparisonScore(candidate_score, baseline_score);
  return {
    kind: "graded",
    comparison_score,
    candidate_score,
    baseline_score,
    winner_label: verdict.winner_label,
    justification: verdict.justification,
    judge_family: args.judgeFamily ?? "bedrock",
  };
}

export function scoreDirection(
  candidate_score: number,
  baseline_score: number,
): "candidate" | "baseline" | "tie" {
  if (candidate_score === baseline_score) return "tie";
  return candidate_score > baseline_score ? "candidate" : "baseline";
}

export type ShadowGradeAveragedOutcome =
  | {
      kind: "graded";
      comparison_score: number;
      candidate_score: number;
      baseline_score: number;
      winner: "candidate" | "baseline" | "tie";
      justification: string;
      judge_family: string;
      orders_used: 1 | 2;
      orders_agreed: boolean | null;
    }
  | { kind: "judge_unavailable" };

export async function gradeShadowRowSwapAveraged(args: {
  row: ShadowGradeRowInput;
  judge: ShadowJudgeFn;
  judgeModel: string;
  candidateModel: string;
  baselineModel: string;
  judgeFamily?: string;
}): Promise<ShadowGradeAveragedOutcome> {
  const a = await gradeShadowRowCore({ ...args, coin: 0 });
  const b = await gradeShadowRowCore({ ...args, coin: 1 });
  const graded = [a, b].filter(
    (g): g is Extract<ShadowGradeCoreOutcome, { kind: "graded" }> =>
      g.kind === "graded",
  );
  if (graded.length === 0) return { kind: "judge_unavailable" };

  if (graded.length === 1) {
    const g = graded[0];
    return {
      kind: "graded",
      comparison_score: g.comparison_score,
      candidate_score: g.candidate_score,
      baseline_score: g.baseline_score,
      winner: scoreDirection(g.candidate_score, g.baseline_score),
      justification: g.justification,
      judge_family: args.judgeFamily ?? g.judge_family,
      orders_used: 1,
      orders_agreed: null,
    };
  }

  const candAvg = (graded[0].candidate_score + graded[1].candidate_score) / 2;
  const baseAvg = (graded[0].baseline_score + graded[1].baseline_score) / 2;
  const comparison_score = deriveComparisonScore(candAvg, baseAvg);
  const dir0 = scoreDirection(graded[0].candidate_score, graded[0].baseline_score);
  const dir1 = scoreDirection(graded[1].candidate_score, graded[1].baseline_score);
  const agreed = dir0 === dir1;
  return {
    kind: "graded",
    comparison_score,
    candidate_score: candAvg,
    baseline_score: baseAvg,
    winner: agreed ? dir0 : "tie",
    justification: agreed
      ? graded[0].justification
      : `[swap-orders disagreed → tie] ${graded[0].justification}`,
    judge_family: args.judgeFamily ?? graded[0].judge_family,
    orders_used: 2,
    orders_agreed: agreed,
  };
}

export type BlindJudgeVerdict = {
  task_id: string;
  winner_label: "A" | "B" | "tie";
  score_a: number;
  score_b: number;
  justification: string;
  error?: string;
};

const BLIND_JUDGE_CONTRACT = `You are blind-judging two answers (A and B) to the SAME task, produced by two different AI engines whose identities are hidden from you.
Score EACH answer 0-5 (5 = best) on overall quality for the task — correctness, completeness, and usefulness — then pick the better one.
Judge ONLY the answer content. Do NOT guess which model wrote which. Do NOT reward length.

If a "MECHANICAL ATOM-GROUNDING PRE-SCORE" block is shown for an answer, treat it as ONE advisory rubric input, NOT a verdict:
- It is a deterministic, post-hoc check of whether the answer's load-bearing numbers actually appear in this run's tool evidence (0..1; higher = more numbers backed by real data). It does NOT judge correctness, completeness, or usefulness, and it cannot see prose claims or URLs.
- An answer that FABRICATES numbers (low atom-grade) should weigh on the "grounded/correct" part of your score; a high atom-grade does NOT by itself make an answer good (it may still be incomplete or unhelpful), and a low atom-grade does NOT by itself make it bad (the numbers may be unverifiable for benign reasons).
- The pre-score is an INPUT to your judgment. It must NEVER override it. You may disagree with it — say so in your justification.

Output ONLY a JSON object, no prose around it:
{"score_a": <0-5>, "score_b": <0-5>, "winner": "A" | "B" | "tie", "justification": "<one line>"}`;

export type AtomRubricInput = {
  grade: number;
  surviving: number;
  total: number;
};

function renderAtomRubric(label: "A" | "B", atom?: AtomRubricInput): string {
  if (!atom || atom.total <= 0) return "";
  const pct = Math.round(Math.max(0, Math.min(1, atom.grade)) * 100);
  return [
    `--- MECHANICAL ATOM-GROUNDING PRE-SCORE (ANSWER ${label}, advisory input — NOT a verdict) ---`,
    `grade=${pct}% (${atom.surviving}/${atom.total} verifiable atoms backed by this run's tool evidence)`,
  ].join("\n");
}

export function buildBlindJudgePrompt(
  task: ParityTask,
  outputA: string,
  outputB: string,
  atom?: { a?: AtomRubricInput; b?: AtomRubricInput },
): { system: string; user: string } {
  const rubricA = renderAtomRubric("A", atom?.a);
  const rubricB = renderAtomRubric("B", atom?.b);
  const user = [
    `TASK (${task.task_id}): ${task.label}`,
    task.prompt,
    ``,
    `=== ANSWER A ===`,
    outputA || "(empty)",
    ...(rubricA ? [``, rubricA] : []),
    ``,
    `=== ANSWER B ===`,
    outputB || "(empty)",
    ...(rubricB ? [``, rubricB] : []),
  ].join("\n");
  return { system: BLIND_JUDGE_CONTRACT, user };
}

export function parseBlindJudgeReply(
  taskId: string,
  raw: string,
): BlindJudgeVerdict {
  const json = extractFirstJsonObject(raw);
  if (json === null) {
    return zeroedVerdict(taskId, "blind judge returned no JSON object");
  }
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return zeroedVerdict(taskId, `judge JSON parse failed: ${(e as Error).message}`);
  }
  if (!obj || typeof obj !== "object") {
    return zeroedVerdict(taskId, "judge reply not an object");
  }
  const o = obj as Record<string, unknown>;
  const sa = intScore(o.score_a);
  const sb = intScore(o.score_b);
  const winnerRaw = typeof o.winner === "string" ? o.winner.trim().toUpperCase() : "";
  const winner: "A" | "B" | "tie" =
    winnerRaw === "A" ? "A" : winnerRaw === "B" ? "B" : "tie";
  const justification =
    typeof o.justification === "string" ? o.justification.slice(0, 2000) : "";
  if (sa === null || sb === null) {
    return zeroedVerdict(taskId, "judge scores missing or out of 0-5 range");
  }
  return {
    task_id: taskId,
    winner_label: winner,
    score_a: sa,
    score_b: sb,
    justification,
  };
}

function intScore(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0 || v > 5) return null;
  return Math.round(v);
}

function zeroedVerdict(taskId: string, error: string): BlindJudgeVerdict {
  return {
    task_id: taskId,
    winner_label: "tie",
    score_a: 0,
    score_b: 0,
    justification: "",
    error,
  };
}

export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export type ParityDiff = {
  task_id: string;
  label: string;
  anthropic: EngineCell;
  openai: EngineCell;
  blind: {
    winner: Provider | "tie";
    anthropic_score: number;
    openai_score: number;
    justification: string;
    error?: string;
  } | null;
  latency_delta_ms: number | null;
  cost_delta_usd: number | null;
  classification: "parity" | "diverged" | "one-sided" | "skipped" | "both-red";
};

export const PARITY_SCORE_TOLERANCE = 1;

export function buildParityDiff(
  task: ParityTask,
  anthropic: EngineCell,
  openai: EngineCell,
  verdict: BlindJudgeVerdict | null,
  labelMap: { A: Provider; B: Provider } | null,
): ParityDiff {
  const aPass = anthropic.status === "pass";
  const oPass = openai.status === "pass";
  const oSkipped = openai.status === "skip";

  let blind: ParityDiff["blind"] = null;
  if (verdict && labelMap) {
    const scoreByProvider = (p: Provider): number =>
      labelMap.A === p ? verdict.score_a : verdict.score_b;
    const winner: Provider | "tie" =
      verdict.winner_label === "tie"
        ? "tie"
        : verdict.winner_label === "A"
          ? labelMap.A
          : labelMap.B;
    blind = {
      winner,
      anthropic_score: scoreByProvider("anthropic"),
      openai_score: scoreByProvider("openai"),
      justification: verdict.justification,
      ...(verdict.error ? { error: verdict.error } : {}),
    };
  }

  let classification: ParityDiff["classification"];
  if (!aPass && !oPass) {
    classification = oSkipped ? "skipped" : "both-red";
  } else if (aPass && oPass) {
    if (blind && !blind.error) {
      const gap = Math.abs(blind.anthropic_score - blind.openai_score);
      classification = gap <= PARITY_SCORE_TOLERANCE ? "parity" : "diverged";
    } else {
      classification = "diverged";
    }
  } else {
    classification = oSkipped ? "skipped" : "one-sided";
  }

  const bothRan = anthropic.status !== "skip" && openai.status !== "skip";
  return {
    task_id: task.task_id,
    label: task.label,
    anthropic,
    openai,
    blind,
    latency_delta_ms: bothRan ? openai.latency_ms - anthropic.latency_ms : null,
    cost_delta_usd: bothRan
      ? Math.round((openai.cost_usd - anthropic.cost_usd) * 10000) / 10000
      : null,
    classification,
  };
}

export type ParityReport = {
  ts: string;
  total_cells: number;
  gate_cells: number;
  pass: number;
  skip: number;
  watch_red: number;
  diffs: ParityDiff[];
  parity_tasks: number;
  diverged_tasks: number;
  one_sided_tasks: number;
  skipped_tasks: number;
  both_red_tasks: number;
  total_cost_usd: number;
};

export function buildParityReport(diffs: ParityDiff[]): ParityReport {
  const cells: EngineCell[] = [];
  for (const d of diffs) cells.push(d.anthropic, d.openai);

  const pass = cells.filter((c) => c.status === "pass").length;
  const skip = cells.filter((c) => c.status === "skip").length;
  const watch_red = cells.filter((c) => c.status === "watch-red").length;
  const gate_cells = cells.filter((c) => c.status !== "skip").length;
  const total_cost_usd =
    Math.round(cells.reduce((s, c) => s + c.cost_usd, 0) * 10000) / 10000;

  const count = (k: ParityDiff["classification"]) =>
    diffs.filter((d) => d.classification === k).length;

  return {
    ts: new Date().toISOString(),
    total_cells: cells.length,
    gate_cells,
    pass,
    skip,
    watch_red,
    diffs,
    parity_tasks: count("parity"),
    diverged_tasks: count("diverged"),
    one_sided_tasks: count("one-sided"),
    skipped_tasks: count("skipped"),
    both_red_tasks: count("both-red"),
    total_cost_usd,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function formatParityReport(report: ParityReport): string {
  const lines: string[] = [];
  lines.push(`\ncross-engine parity — ${report.ts}`);
  lines.push(
    `  GATE: ${report.pass}/${report.gate_cells} PASS · ` +
      `${report.skip} SKIP · ${report.watch_red} WATCH-RED · ` +
      `${report.total_cells} cells attempted (${report.diffs.length} tasks × 2 engines)`,
  );
  lines.push(
    `  parity breakdown: ${report.parity_tasks} parity · ` +
      `${report.diverged_tasks} diverged · ${report.one_sided_tasks} one-sided · ` +
      `${report.skipped_tasks} skipped(openai) · ${report.both_red_tasks} both-red`,
  );
  lines.push(`  total est. cost: $${round2(report.total_cost_usd)}`);
  lines.push("");

  const skipCells = report.diffs
    .flatMap((d) => [d.anthropic, d.openai])
    .filter((c) => c.status === "skip");
  if (skipCells.length > 0) {
    lines.push("  SKIP (not a pass — precondition unmet):");
    for (const c of skipCells) {
      lines.push(`    - ${c.task_id} [${c.provider}]: ${c.reason}`);
    }
    lines.push("");
  }

  const redCells = report.diffs
    .flatMap((d) => [d.anthropic, d.openai])
    .filter((c) => c.status === "watch-red");
  if (redCells.length > 0) {
    lines.push("  WATCH-RED (ran but an assertion failed):");
    for (const c of redCells) {
      lines.push(`    - ${c.task_id} [${c.provider}]: ${c.reason}`);
    }
    lines.push("");
  }

  lines.push("  per-task (Claude vs OpenAI):");
  for (const d of report.diffs) {
    lines.push(`    [${d.classification.toUpperCase()}] ${d.task_id} — ${d.label}`);
    lines.push(
      `        anthropic: ${cellLine(d.anthropic)}`,
    );
    lines.push(`        openai:    ${cellLine(d.openai)}`);
    if (d.blind) {
      const tag = d.blind.error ? ` (judge ERR: ${d.blind.error})` : "";
      lines.push(
        `        blind judge: winner=${d.blind.winner} ` +
          `anthropic=${d.blind.anthropic_score}/5 openai=${d.blind.openai_score}/5${tag}`,
      );
      if (d.blind.justification)
        lines.push(`          why: ${d.blind.justification}`);
    }
    if (d.latency_delta_ms !== null)
      lines.push(
        `        Δ latency: ${d.latency_delta_ms >= 0 ? "+" : ""}${d.latency_delta_ms}ms (openai − anthropic)` +
          (d.cost_delta_usd !== null
            ? ` · Δ cost: ${d.cost_delta_usd >= 0 ? "+" : ""}$${round2(d.cost_delta_usd)}`
            : ""),
      );
  }
  lines.push("");
  return lines.join("\n");
}

function cellLine(c: EngineCell): string {
  if (c.status === "skip") return `SKIP (${c.reason})`;
  const flag = c.status === "pass" ? "PASS" : "WATCH-RED";
  const note = c.status === "watch-red" ? ` — ${c.reason}` : "";
  return (
    `${flag}  ${c.latency_ms}ms  $${round2(c.cost_usd)}  ` +
    `tools=${c.gated_tool_calls}  out=${c.output.length}ch${note}`
  );
}

export type ParityRunDeps = {
  runTask: RunTaskThroughEngine;
  openaiLive: boolean;
  openaiSkipReason: string;
  judge?: (prompt: { system: string; user: string }) => Promise<string>;
  flip?: (taskId: string) => boolean;
};

export async function runParitySuite(
  tasks: ParityTask[],
  deps: ParityRunDeps,
): Promise<ParityReport> {
  const flip = deps.flip ?? (() => Math.random() < 0.5);
  const diffs: ParityDiff[] = [];

  for (const task of tasks) {
    const anthropic = await runOneCell(task, "anthropic", deps.runTask);

    const openai = deps.openaiLive
      ? await runOneCell(task, "openai", deps.runTask)
      : skipEngineCell(task.task_id, "openai", deps.openaiSkipReason);

    let verdict: BlindJudgeVerdict | null = null;
    let labelMap: { A: Provider; B: Provider } | null = null;
    const bothPassed = anthropic.status === "pass" && openai.status === "pass";
    if (bothPassed && deps.judge) {
      const anthropicIsA = flip(task.task_id);
      labelMap = anthropicIsA
        ? { A: "anthropic", B: "openai" }
        : { A: "openai", B: "anthropic" };
      const outputA = anthropicIsA ? anthropic.output : openai.output;
      const outputB = anthropicIsA ? openai.output : anthropic.output;
      const prompt = buildBlindJudgePrompt(task, outputA, outputB);
      try {
        const raw = await deps.judge(prompt);
        verdict = parseBlindJudgeReply(task.task_id, raw);
      } catch (e) {
        verdict = parseBlindJudgeReplyError(task.task_id, e);
      }
    }

    diffs.push(buildParityDiff(task, anthropic, openai, verdict, labelMap));
  }

  return buildParityReport(diffs);
}

async function runOneCell(
  task: ParityTask,
  provider: Provider,
  runTask: RunTaskThroughEngine,
): Promise<EngineCell> {
  try {
    const cap = await runTask(task, provider);
    return assertEngineCell(task, provider, cap);
  } catch (e) {
    return assertEngineCell(task, provider, {
      output: "",
      latency_ms: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      model: "",
      gated_tool_calls: 0,
      errored: true,
      error_detail: (e as Error)?.name || "Error",
    });
  }
}

function parseBlindJudgeReplyError(taskId: string, e: unknown): BlindJudgeVerdict {
  return {
    task_id: taskId,
    winner_label: "tie",
    score_a: 0,
    score_b: 0,
    justification: "",
    error: `judge call threw: ${(e as Error)?.name || "Error"}`,
  };
}

export const REPRESENTATIVE_TASKS: ParityTask[] = [
  {
    task_id: "parity-pm-prioritize",
    agent_slug: "pm",
    label: "PM: prioritize 3 features with a crisp rationale",
    system:
      "You are a senior product manager. Be concise, decisive, and concrete.",
    prompt:
      "We have 3 candidate features: (a) faster onboarding, (b) Slack digest, (c) export to CSV. " +
      "Pick the order to build them and give a one-line rationale each. Output a numbered list.",
  },
  {
    task_id: "parity-support-reply",
    agent_slug: "support-lead",
    label: "Support: draft a calm reply to an angry refund request",
    system:
      "You are a support lead. Write empathetic, policy-grounded, brief replies.",
    prompt:
      "A customer is furious their subscription renewed and demands a refund. " +
      "Draft a 4-sentence reply that is empathetic, states next steps, and does not promise anything you can't.",
  },
  {
    task_id: "parity-research-summary",
    agent_slug: "research",
    label: "Research: summarize a tradeoff in 3 bullets",
    system: "You are a research analyst. Summarize tradeoffs tightly.",
    prompt:
      "Summarize the tradeoff between building on a single LLM provider vs. a provider-agnostic engine, in exactly 3 bullets.",
  },
];
