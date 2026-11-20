
import type { Question } from "../questions";

export type Verdict = {
  question_id: string;
  shape: string;
  traps: string[];
  pass: boolean;
  failure_mode?: string;
  diagnosed_mistake?: string;
  expected?: number | string;
  got?: number | string;
  tool_calls: number;
  failed_tool_calls: number;
  notes?: string;
};

const ANSWER_RE = /ANSWER:\s*[*_`]{0,2}\s*(CANNOT_ANSWER|-?[\d.]+)\s*[*_`]{0,2}\s*$/im;

export function extractAnswer(text: string): { kind: "number"; value: number } | { kind: "cannot" } | null {
  const m = ANSWER_RE.exec(text.trim());
  if (!m) return null;
  if (m[1].toUpperCase() === "CANNOT_ANSWER") return { kind: "cannot" };
  const n = Number(m[1]);
  return Number.isFinite(n) ? { kind: "number", value: n } : null;
}

export function gradeNumeric(
  q: Extract<Question, { kind: "numeric" }>,
  answerText: string,
  toolCalls: { ok: boolean }[],
): Verdict {
  const base = {
    question_id: q.id,
    shape: q.shape,
    traps: q.traps,
    tool_calls: toolCalls.length,
    failed_tool_calls: toolCalls.filter((c) => !c.ok).length,
    expected: q.expected,
  };
  const parsed = extractAnswer(answerText);
  if (!parsed) {
    return { ...base, pass: false, failure_mode: "no_answer_emitted", got: answerText.slice(-200) };
  }
  if (parsed.kind === "cannot") {
    return { ...base, pass: false, failure_mode: "abstained_when_answerable", got: "CANNOT_ANSWER" };
  }

  const drift =
    q.expected === 0 ? Math.abs(parsed.value) : Math.abs(parsed.value - q.expected) / Math.abs(q.expected);
  if (drift <= Math.max(q.tolerance, 1e-9)) {
    return { ...base, pass: true, got: parsed.value };
  }

  const matched = (q.knownWrongAnswers ?? []).find((w) => {
    const d = w.value === 0 ? Math.abs(parsed.value) : Math.abs(parsed.value - w.value) / Math.abs(w.value);
    return d <= Math.max(q.tolerance, 1e-9);
  });

  return {
    ...base,
    pass: false,
    failure_mode: "wrong_number",
    diagnosed_mistake: matched?.because,
    got: parsed.value,
  };
}

export function stripAnswerLine(text: string): string {
  return text.replace(/\n?\s*ANSWER:\s*[*_`]{0,2}\s*(CANNOT_ANSWER|-?[\d.]+)\s*[*_`]{0,2}\s*$/i, "").trimEnd();
}

export function judgePrompt(q: Extract<Question, { kind: "narrative" }>, answerText: string): string {
  return [
    "You are grading one answer from a data analyst. Grade ONLY against the checklist below.",
    "Do not reward good writing. Do not penalise a correct answer for being blunt.",
    "",
    `THE OPERATOR ASKED: ${q.prompt}`,
    "",
    "THE ANSWER MUST CONTAIN ALL OF THESE:",
    ...q.mustAssert.map((a, i) => `  ${i + 1}. ${a}`),
    "",
    "THE ANSWER MUST CONTAIN NONE OF THESE:",
    ...q.mustNotAssert.map((a, i) => `  ${i + 1}. ${a}`),
    "",
    "THE ANSWER:",
    "-----",
    stripAnswerLine(answerText),
    "-----",
    "",
    'Reply with JSON only: {"pass": true|false, "missing": [<numbers of unmet must-contain items>],',
    '"violated": [<numbers of must-not-contain items present>], "why": "<one sentence>"}',
  ].join("\n");
}

export function summarise(verdicts: Verdict[]): {
  total: number;
  passed: number;
  accuracy: number;
  byTrap: Record<string, { total: number; passed: number }>;
  byShape: Record<string, { total: number; passed: number }>;
  diagnosedMistakes: Record<string, number>;
} {
  const byTrap: Record<string, { total: number; passed: number }> = {};
  const byShape: Record<string, { total: number; passed: number }> = {};
  const diagnosedMistakes: Record<string, number> = {};

  for (const v of verdicts) {
    for (const t of v.traps) {
      byTrap[t] ??= { total: 0, passed: 0 };
      byTrap[t].total += 1;
      if (v.pass) byTrap[t].passed += 1;
    }
    byShape[v.shape] ??= { total: 0, passed: 0 };
    byShape[v.shape].total += 1;
    if (v.pass) byShape[v.shape].passed += 1;
    if (v.diagnosed_mistake) {
      diagnosedMistakes[v.diagnosed_mistake] = (diagnosedMistakes[v.diagnosed_mistake] ?? 0) + 1;
    }
  }

  const passed = verdicts.filter((v) => v.pass).length;
  return {
    total: verdicts.length,
    passed,
    accuracy: verdicts.length === 0 ? 0 : passed / verdicts.length,
    byTrap,
    byShape,
    diagnosedMistakes,
  };
}

export async function judgeNarrative(
  q: Extract<Question, { kind: "narrative" }>,
  answerText: string,
  toolCalls: { ok: boolean }[],
): Promise<Verdict> {
  const base = {
    question_id: q.id,
    shape: q.shape,
    traps: q.traps,
    tool_calls: toolCalls.length,
    failed_tool_calls: toolCalls.filter((c) => !c.ok).length,
  };

  if (answerText.trim().length === 0) {
    return { ...base, pass: false, failure_mode: "no_answer_emitted" };
  }

  if (q.traps.includes("abstain_missing_field")) {
    const parsed = extractAnswer(answerText);
    if (parsed && parsed.kind === "number") {
      return {
        ...base,
        pass: false,
        failure_mode: "answered_when_unanswerable",
        got: parsed.value,
        notes: "the schema has no field that supports this question",
      };
    }
  }

  const { initChatModel } = await import("langchain/chat_models/universal");
  const { deepAgentModelId, resolveDeepAgentModel } = await import(
    "@/services/agents/deepagent/resolve-model"
  );
  const id =
    process.env.EVAL_OPDB_JUDGE_MODEL?.trim() ||
    process.env.EVAL_OPDB_MODEL?.trim() ||
    deepAgentModelId();
  const resolved = resolveDeepAgentModel(id);
  const judge =
    typeof resolved === "string"
      ? await initChatModel(resolved, /(^|[:/-])(gpt-5|o1|o3|o4)/i.test(resolved) ? {} : { temperature: 0 })
      : resolved;

  const reply = await (judge as unknown as { invoke: (s: string) => Promise<{ content: unknown }> }).invoke(
    judgePrompt(q, answerText),
  );
  const text = typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content);
  const json = /\{[\s\S]*\}/.exec(text);
  if (!json) {
    return { ...base, pass: false, failure_mode: "judge_unparseable", notes: text.slice(0, 200) };
  }
  const parsed = JSON.parse(json[0]) as {
    pass?: boolean;
    missing?: number[];
    violated?: number[];
    why?: string;
  };
  return {
    ...base,
    pass: parsed.pass === true,
    failure_mode: parsed.pass === true ? undefined : "checklist_not_met",
    notes: [
      parsed.why,
      parsed.missing?.length ? `missing: ${parsed.missing.join(",")}` : "",
      parsed.violated?.length ? `violated: ${parsed.violated.join(",")}` : "",
    ]
      .filter(Boolean)
      .join(" | "),
  };
}
