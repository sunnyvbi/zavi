
import { z } from "zod";
import type {
  DeterministicResult,
  EvalTask,
  ProducedDiff,
  RubricResult,
  RubricScores,
} from "./types";

export const RUBRIC_JUDGE_MODEL = "claude-opus-4-7";

const score = z.number().int().min(0).max(5);
const rubricReplySchema = z.object({
  correctness: score,
  scope_fit: score,
  regression_safety: score,
  justification: z.string().min(1).max(2000),
});

const RUBRIC_CONTRACT = `You are grading a single code change produced by an AI software engineer for a fixed eval task.
Score THREE dimensions, each an integer 0-5 (5 = best), then give ONE short justification line.

- correctness: does the change actually solve the task as described? (The deterministic test result is the strongest signal — if tests are GREEN the change is very likely correct; if RED it almost certainly is not. Use the diff to judge whether a green result is a real fix vs. a test-gaming hack.)
- scope_fit: is the change minimal and on-target — only what the task needs, no unrelated edits, no files touched outside the expected set, no dead code?
- regression_safety: does the change avoid breaking adjacent behavior — guards preserved, no removed validation, edge cases (null/empty/boundary/zero) handled, money-path math exact?

Output ONLY a JSON object, no prose around it:
{"correctness": <0-5>, "scope_fit": <0-5>, "regression_safety": <0-5>, "justification": "<one line>"}`;

export function buildRubricPrompt(
  task: EvalTask,
  diff: ProducedDiff,
  det: DeterministicResult,
): { system: string; user: string } {
  const fileDump = diff.files
    .map((f) => {
      if (f.action === "delete") return `--- DELETE ${f.path} ---`;
      return `--- ${f.action.toUpperCase()} ${f.path} ---\n${f.content ?? ""}`;
    })
    .join("\n\n");

  const user = [
    `TASK (${task.task_id}, bucket=${task.bucket}):`,
    task.prompt,
    ``,
    `INTENDED FIX (reference — NOT shown to the engineer): ${task.known_good_reference}`,
    `EXPECTED FILES TO TOUCH: ${task.expected_touch.join(", ")}`,
    ``,
    `DETERMINISTIC RESULT: tests_green=${det.tests_green} typecheck_ok=${det.typecheck_ok} touched=[${det.touched.join(", ")}] out_of_scope=[${det.out_of_scope.join(", ")}]`,
    det.output_tail ? `TEST OUTPUT TAIL:\n${det.output_tail}` : ``,
    ``,
    `PRODUCED DIFF:`,
    fileDump || "(no files produced)",
  ].join("\n");

  return { system: RUBRIC_CONTRACT, user };
}

export function parseRubricReply(taskId: string, raw: string): RubricResult {
  const json = extractFirstJsonObject(raw);
  if (json === null) {
    return zeroed(taskId, "rubric judge returned no JSON object");
  }
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return zeroed(taskId, `rubric JSON parse failed: ${(e as Error).message}`);
  }
  const result = rubricReplySchema.safeParse(obj);
  if (!result.success) {
    const first = result.error.issues[0];
    return zeroed(
      taskId,
      `rubric reply invalid at ${first.path.join(".")}: ${first.message}`,
    );
  }
  return {
    task_id: taskId,
    scores: {
      correctness: result.data.correctness,
      scope_fit: result.data.scope_fit,
      regression_safety: result.data.regression_safety,
    },
    justification: result.data.justification,
  };
}

function zeroed(taskId: string, error: string): RubricResult {
  return {
    task_id: taskId,
    scores: { correctness: 0, scope_fit: 0, regression_safety: 0 },
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
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function mean(ns: number[]): number {
  if (ns.length === 0) return 0;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

export function meanRubric(results: RubricResult[]): RubricScores | null {
  const ok = results.filter((r) => !r.error);
  if (ok.length === 0) return null;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    correctness: r2(mean(ok.map((r) => r.scores.correctness))),
    scope_fit: r2(mean(ok.map((r) => r.scores.scope_fit))),
    regression_safety: r2(mean(ok.map((r) => r.scores.regression_safety))),
  };
}
