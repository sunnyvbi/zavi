
import { z } from "zod";
import type {
  ResearchEvalTask,
  ResearchRubricResult,
  ResearchRubricScores,
} from "./types";

export const RESEARCH_RUBRIC_JUDGE_MODEL = "claude-opus-4-7";

const score = z.number().int().min(0).max(5);
const rubricReplySchema = z.object({
  source_independence: score,
  recency: score,
  primary_vs_secondary: score,
  so_what: score,
  fact_vs_judgment: score,
  justification: z.string().min(1).max(2000),
});

const RUBRIC_CONTRACT = `You are grading a single research report produced by an AI research analyst for a fixed operator ask.
You are BLIND: you see ONLY the ask and the rendered report — there is NO reference answer. Judge the report on its own merits as a senior analyst would.
Score FIVE dimensions, each an integer 0-5 (5 = best), then give ONE short justification line.

- source_independence: are the load-bearing numbers corroborated by INDEPENDENT sources, not the same fact echoed across same-domain mirror pages or one wire story? A claim "validated" on two URLs from the same publisher is NOT independently corroborated.
- recency: are figures carried with an as-of date, and is any stale (older than ~2 years) load-bearing number EXPLICITLY hedged ("dates to <year>; may be stale") rather than silently presented as current? Silent stale numbers score low.
- primary_vs_secondary: do verifiable vendor/price/spec facts cite the PRIMARY source (the vendor's own pricing/docs page), not a secondary "2026 fee guide" roundup/listicle? Primary-cited = high.
- so_what: does the report LEAD with the decision-relevant implication (the bottom line / recommendation) in the first sentences, not a data dump? For a decision-shaped ask, is there a synthesized recommendation or gap, not just a wall of facts?
- fact_vs_judgment: are checkable facts tiered AS facts (with citations) while judgments/recommendations are framed as reasoned opinion (inferred) with trade-offs — never a recommendation asserted as established fact?

Output ONLY a JSON object, no prose around it:
{"source_independence": <0-5>, "recency": <0-5>, "primary_vs_secondary": <0-5>, "so_what": <0-5>, "fact_vs_judgment": <0-5>, "justification": "<one line>"}`;

export function buildResearchRubricPrompt(
  task: ResearchEvalTask,
  renderedReport: string,
): { system: string; user: string } {
  const user = [
    `OPERATOR ASK (${task.task_id}):`,
    task.ask,
    ``,
    `WHAT A SENIOR ANSWER WOULD GET RIGHT (judge steer — NOT a reference answer): ${task.notes}`,
    ``,
    `RENDERED RESEARCH REPORT:`,
    renderedReport || "(no report produced)",
  ].join("\n");

  return { system: RUBRIC_CONTRACT, user };
}

export function parseResearchRubricReply(taskId: string, raw: string): ResearchRubricResult {
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
    return zeroed(taskId, `rubric reply invalid at ${first.path.join(".")}: ${first.message}`);
  }
  return {
    task_id: taskId,
    scores: {
      source_independence: result.data.source_independence,
      recency: result.data.recency,
      primary_vs_secondary: result.data.primary_vs_secondary,
      so_what: result.data.so_what,
      fact_vs_judgment: result.data.fact_vs_judgment,
    },
    justification: result.data.justification,
  };
}

function zeroed(taskId: string, error: string): ResearchRubricResult {
  return {
    task_id: taskId,
    scores: {
      source_independence: 0,
      recency: 0,
      primary_vs_secondary: 0,
      so_what: 0,
      fact_vs_judgment: 0,
    },
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

export function meanResearchRubric(results: ResearchRubricResult[]): ResearchRubricScores | null {
  const ok = results.filter((r) => !r.error);
  if (ok.length === 0) return null;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    source_independence: r2(mean(ok.map((r) => r.scores.source_independence))),
    recency: r2(mean(ok.map((r) => r.scores.recency))),
    primary_vs_secondary: r2(mean(ok.map((r) => r.scores.primary_vs_secondary))),
    so_what: r2(mean(ok.map((r) => r.scores.so_what))),
    fact_vs_judgment: r2(mean(ok.map((r) => r.scores.fact_vs_judgment))),
  };
}
