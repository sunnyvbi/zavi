
import path from "node:path";
import { z } from "zod";
import { researchTasksFileSchema, type ResearchEvalTask, type ResearchRubricScores } from "./types";

export const RESEARCH_TASKS_JSON_PATH = path.resolve(
  __dirname,
  "../../../../eval/research-quality/tasks.json",
);
export const RESEARCH_BASELINE_JSON_PATH = path.resolve(
  __dirname,
  "../../../../eval/research-quality/baseline.json",
);

export function parseResearchTasks(rawJson: string): ResearchEvalTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`research tasks.json is not valid JSON: ${(e as Error).message}`);
  }
  const result = researchTasksFileSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(
      `research tasks.json failed validation at ${first.path.join(".")}: ${first.message}`,
    );
  }
  const ids = new Set<string>();
  for (const t of result.data) {
    if (ids.has(t.task_id)) {
      throw new Error(`research tasks.json has a duplicate task_id: ${t.task_id}`);
    }
    ids.add(t.task_id);
  }
  return result.data;
}

const baselineSchema = z.object({
  source_independence: z.number().min(0).max(5),
  recency: z.number().min(0).max(5),
  primary_vs_secondary: z.number().min(0).max(5),
  so_what: z.number().min(0).max(5),
  fact_vs_judgment: z.number().min(0).max(5),
});

export function parseResearchBaseline(rawJson: string): ResearchRubricScores {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`research baseline.json is not valid JSON: ${(e as Error).message}`);
  }
  const result = baselineSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(
      `research baseline.json failed validation at ${first.path.join(".")}: ${first.message}`,
    );
  }
  return result.data;
}
