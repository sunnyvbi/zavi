
import path from "node:path";
import { realRepoTasksFileSchema, type EvalTask, type RealRepoTask } from "./types";

export const REAL_REPO_TASKS_JSON_PATH = path.resolve(
  __dirname,
  "../../../../eval/engineer-quality/real-repo-tasks.json",
);
export const REAL_REPO_CANDIDATES_JSON_PATH = path.resolve(
  __dirname,
  "../../../../eval/engineer-quality/real-repo-candidates.json",
);
export const REAL_REPO_HARD_TASKS_JSON_PATH = path.resolve(
  __dirname,
  "../../../../eval/engineer-quality/real-repo-hard-tasks.json",
);

export function parseRealRepoTasks(rawJson: string): RealRepoTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(
      `real-repo-tasks.json is not valid JSON: ${(e as Error).message}`,
    );
  }
  const result = realRepoTasksFileSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(
      `real-repo-tasks.json failed validation at ${first.path.join(".")}: ${first.message}`,
    );
  }
  const ids = new Set<string>();
  for (const t of result.data) {
    if (ids.has(t.task_id)) {
      throw new Error(
        `real-repo-tasks.json has a duplicate task_id: ${t.task_id}`,
      );
    }
    ids.add(t.task_id);
  }
  return result.data;
}

export function toEvalTask(task: RealRepoTask): EvalTask {
  const oracleHint = task.oracle_test_files
    .map((p) => `npx vitest run ${p}`)
    .join(" && ");
  return {
    task_id: task.task_id,
    agent_slug: task.agent_slug,
    bucket: task.bucket,
    source: task.source,
    prompt: task.prompt,
    fixture_file: task.expected_touch[0],
    test_file: task.oracle_test_files[0],
    pass_check: oracleHint,
    expected_touch: task.expected_touch,
    known_good_reference: task.known_good_reference,
  };
}
