
import path from "node:path";
import { tasksFileSchema, type EvalTask } from "./types";

export const TASKS_JSON_PATH = path.resolve(
  __dirname,
  "../../../../eval/engineer-quality/tasks.json",
);
export const FIXTURE_REPO_PATH = path.resolve(
  __dirname,
  "../../../../eval/engineer-quality/fixtures/repo",
);

export const HARD_TASKS_JSON_PATH = path.resolve(
  __dirname,
  "../../../../eval/engineer-quality/hard-tasks.json",
);
export const HARD_FIXTURE_REPO_PATH = path.resolve(
  __dirname,
  "../../../../eval/engineer-quality/fixtures/repo-hard",
);

export function parseTasks(rawJson: string): EvalTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`tasks.json is not valid JSON: ${(e as Error).message}`);
  }
  const result = tasksFileSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(
      `tasks.json failed validation at ${first.path.join(".")}: ${first.message}`,
    );
  }
  const ids = new Set<string>();
  for (const t of result.data) {
    if (ids.has(t.task_id)) {
      throw new Error(`tasks.json has a duplicate task_id: ${t.task_id}`);
    }
    ids.add(t.task_id);
  }
  return result.data;
}
