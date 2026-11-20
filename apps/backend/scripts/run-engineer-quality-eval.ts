#!/usr/bin/env tsx

import fs from "node:fs";
import { getAnthropic } from "@/services/anthropic";
import {
  parseTasks,
  TASKS_JSON_PATH,
  FIXTURE_REPO_PATH,
  HARD_TASKS_JSON_PATH,
  HARD_FIXTURE_REPO_PATH,
} from "@/services/eval/engineer-quality/task-loader";
import {
  parseRealRepoTasks,
  toEvalTask,
  REAL_REPO_TASKS_JSON_PATH,
  REAL_REPO_HARD_TASKS_JSON_PATH,
} from "@/services/eval/engineer-quality/real-repo-loader";
import { scoreDeterministic } from "@/services/eval/engineer-quality/deterministic";
import { scoreRealRepo } from "@/services/eval/engineer-quality/real-repo-scorer";
import {
  materializeTask,
  removeMaterialization,
  resolveRepoRoot,
} from "@/services/eval/engineer-quality/materialize-repo";
import {
  buildRubricPrompt,
  parseRubricReply,
  RUBRIC_JUDGE_MODEL,
} from "@/services/eval/engineer-quality/rubric";
import {
  driveEngineerRun,
  driveEngineerRunInDir,
  driverPreflight,
} from "@/services/eval/engineer-quality/driver";
import { buildReport, formatReport } from "@/services/eval/engineer-quality/report";
import type {
  DeterministicResult,
  EvalTask,
  ProducedDiff,
  RealRepoTask,
  RubricResult,
  SuiteName,
  TaskOutcome,
} from "@/services/eval/engineer-quality/types";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string): string | null => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const SUITE: SuiteName =
  val("--suite") === "real-repo"
    ? "real-repo"
    : val("--suite") === "hard"
      ? "hard"
      : "fixture";
const JSON_MODE = has("--json");
const NO_RUBRIC = has("--no-rubric");
const DRY = has("--dry-run") || has("--list") || (!has("--run") && !has("--diffs"));
const RUN = has("--run");
const DIFFS_FILE = val("--diffs");
const ONLY_TASK = val("--task");

const HARD_CONCURRENCY_CAP = SUITE === "real-repo" || SUITE === "hard" ? 2 : 3;
const CONCURRENCY = Math.min(
  HARD_CONCURRENCY_CAP,
  Math.max(1, Number(val("--concurrency") ?? "2") || 2),
);

function loadFixtureTasks(): EvalTask[] {
  const raw = fs.readFileSync(TASKS_JSON_PATH, "utf-8");
  let tasks = parseTasks(raw);
  if (ONLY_TASK) {
    tasks = tasks.filter((t) => t.task_id === ONLY_TASK);
    if (tasks.length === 0) {
      throw new Error(`--task ${ONLY_TASK} not found in tasks.json`);
    }
  }
  return tasks;
}

function listFixture(tasks: EvalTask[]): void {
  if (JSON_MODE) {
    console.log(JSON.stringify({ suite: "fixture", task_count: tasks.length, tasks }, null, 2));
    return;
  }
  console.log(`\nengineer-quality eval (fixture suite) — ${tasks.length} fixed tasks`);
  console.log(`  tasks.json:   ${TASKS_JSON_PATH}`);
  console.log(`  fixture repo: ${FIXTURE_REPO_PATH}\n`);
  for (const t of tasks) {
    console.log(`  ${t.task_id.padEnd(28)} [${t.bucket}]  (${t.source})`);
    console.log(`      ${t.pass_check}`);
  }
  console.log(`\nRun live (burns Opus per task):  npm run eval:engineer-quality -- --run`);
  console.log(`Real-repo (harder) baseline:     npm run eval:engineer-quality -- --suite real-repo --run`);
  console.log(`Deterministic only (no rubric):  npm run eval:engineer-quality -- --run --no-rubric\n`);
}

function loadRealRepoTasks(): RealRepoTask[] {
  let raw: string;
  try {
    raw = fs.readFileSync(REAL_REPO_TASKS_JSON_PATH, "utf-8");
  } catch {
    throw new Error(
      `real-repo-tasks.json not found at ${REAL_REPO_TASKS_JSON_PATH}.\n` +
        `Curate it first:  tsx scripts/curate-real-repo-eval-tasks.ts`,
    );
  }
  let tasks = parseRealRepoTasks(raw);
  if (ONLY_TASK) {
    tasks = tasks.filter((t) => t.task_id === ONLY_TASK);
    if (tasks.length === 0) {
      throw new Error(`--task ${ONLY_TASK} not found in real-repo-tasks.json`);
    }
  }
  return tasks;
}

function listRealRepo(tasks: RealRepoTask[]): void {
  if (JSON_MODE) {
    console.log(JSON.stringify({ suite: "real-repo", task_count: tasks.length, tasks }, null, 2));
    return;
  }
  console.log(`\nengineer-quality eval (REAL-REPO suite) — ${tasks.length} curated tasks`);
  console.log(`  real-repo-tasks.json: ${REAL_REPO_TASKS_JSON_PATH}\n`);
  for (const t of tasks) {
    console.log(`  ${t.task_id.padEnd(32)} [${t.bucket}]  base=${t.base_sha.slice(0, 9)} head=${t.head_sha.slice(0, 9)}`);
    console.log(`      oracle: ${t.oracle_test_files.join(", ")}`);
  }
  console.log(`\nRun live (burns Opus + materializes the repo per task):`);
  console.log(`  npm run eval:engineer-quality -- --suite real-repo --run\n`);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runRubric(
  task: EvalTask,
  diff: ProducedDiff,
  det: DeterministicResult,
): Promise<RubricResult> {
  try {
    const { system, user } = buildRubricPrompt(task, diff, det);
    const resp = await getAnthropic().messages.create({
      model: RUBRIC_JUDGE_MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return parseRubricReply(task.task_id, text);
  } catch (e) {
    return {
      task_id: task.task_id,
      scores: { correctness: 0, scope_fit: 0, regression_safety: 0 },
      justification: "",
      error: `rubric call failed: ${(e as Error).message}`,
    };
  }
}

async function scoreOneFixture(task: EvalTask, diff: ProducedDiff): Promise<TaskOutcome> {
  const deterministic = scoreDeterministic(FIXTURE_REPO_PATH, task, diff);
  const rubric = NO_RUBRIC ? null : await runRubric(task, diff, deterministic);
  return { task, deterministic, rubric };
}

async function fixtureDiffsMode(tasks: EvalTask[]): Promise<number> {
  const raw = fs.readFileSync(DIFFS_FILE as string, "utf-8");
  const captured = JSON.parse(raw) as ProducedDiff[];
  const byId = new Map(captured.map((d) => [d.task_id, d]));
  const outcomes = await mapLimit(tasks, CONCURRENCY, async (task) => {
    const diff = byId.get(task.task_id) ?? { task_id: task.task_id, files: [] };
    return scoreOneFixture(task, diff);
  });
  emit(buildReport(outcomes));
  return 0;
}

async function fixtureRunMode(tasks: EvalTask[]): Promise<number> {
  const pre = driverPreflight();
  if (!pre.ok) {
    console.error(`cannot --run: ${pre.reason}`);
    console.error(`(use --diffs <file> to score captured diffs without a live run, or --list)`);
    return 2;
  }
  console.error(
    `[engineer-quality:fixture] driving ${tasks.length} live engineer run(s), concurrency=${CONCURRENCY}` +
      `${NO_RUBRIC ? " (rubric OFF)" : " + Opus rubric"} — this burns Opus per task.`,
  );
  const outcomes = await mapLimit(tasks, CONCURRENCY, async (task) => {
    const diff = await driveEngineerRun(FIXTURE_REPO_PATH, task);
    return scoreOneFixture(task, diff);
  });
  emit(buildReport(outcomes));
  return 0;
}

async function realRepoRunMode(tasks: RealRepoTask[]): Promise<number> {
  const pre = driverPreflight();
  if (!pre.ok) {
    console.error(`cannot --run: ${pre.reason}`);
    return 2;
  }
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot();
  } catch (e) {
    console.error(`cannot --run real-repo: ${(e as Error).message}`);
    return 2;
  }
  console.error(
    `[engineer-quality:real-repo] driving ${tasks.length} live engineer run(s) against REAL Praxis history, concurrency=${CONCURRENCY}` +
      `${NO_RUBRIC ? " (rubric OFF)" : " + Opus rubric"} — burns Opus + materializes the repo per task.`,
  );
  console.error(`[engineer-quality:real-repo] repo root: ${repoRoot}`);

  const outcomes = await mapLimit(tasks, CONCURRENCY, async (rrTask) => {
    const evalTask = toEvalTask(rrTask);
    let materialization: ReturnType<typeof materializeTask> | null = null;
    try {
      materialization = materializeTask(repoRoot, rrTask);
      console.error(
        `[engineer-quality:real-repo] ${rrTask.task_id}: materialized @ ${rrTask.base_sha.slice(0, 9)}` +
          ` (node_modules ${materialization.nodeModulesFromCache ? "from cache" : "freshly installed"})`,
      );
      const diff = await driveEngineerRunInDir(materialization.repoDir, evalTask);
      const deterministic = scoreRealRepo(rrTask, diff, materialization);
      const rubric = NO_RUBRIC ? null : await runRubric(evalTask, diff, deterministic);
      return { task: evalTask, deterministic, rubric } as TaskOutcome;
    } catch (e) {
      const deterministic: DeterministicResult = {
        task_id: rrTask.task_id,
        tests_green: false,
        typecheck_ok: null,
        touched: [],
        out_of_scope: [],
        output_tail: "",
        failure_kind: "infra",
        error: `real-repo harness error: ${(e as Error).message}`,
      };
      return { task: evalTask, deterministic, rubric: null } as TaskOutcome;
    } finally {
      if (materialization) {
        try {
          removeMaterialization(repoRoot, materialization);
        } catch {
        }
      }
    }
  });
  emit(buildReport(outcomes));
  return 0;
}

function loadHardSyntheticTasks(): EvalTask[] {
  let raw: string;
  try {
    raw = fs.readFileSync(HARD_TASKS_JSON_PATH, "utf-8");
  } catch {
    throw new Error(`hard-tasks.json not found at ${HARD_TASKS_JSON_PATH}`);
  }
  let tasks = parseTasks(raw);
  if (ONLY_TASK) tasks = tasks.filter((t) => t.task_id === ONLY_TASK);
  return tasks;
}

function loadHardRealRepoTasks(): RealRepoTask[] {
  let raw: string;
  try {
    raw = fs.readFileSync(REAL_REPO_HARD_TASKS_JSON_PATH, "utf-8");
  } catch {
    throw new Error(
      `real-repo-hard-tasks.json not found at ${REAL_REPO_HARD_TASKS_JSON_PATH}.\n` +
        `Curate it:  tsx scripts/curate-real-repo-eval-tasks.ts --min-files 2 --behavioral-only --out hard-candidates`,
    );
  }
  let tasks = parseRealRepoTasks(raw);
  if (ONLY_TASK) tasks = tasks.filter((t) => t.task_id === ONLY_TASK);
  return tasks;
}

function listHard(syn: EvalTask[], rr: RealRepoTask[]): void {
  if (JSON_MODE) {
    console.log(
      JSON.stringify(
        { suite: "hard", synthetic_count: syn.length, real_repo_count: rr.length, synthetic: syn, real_repo: rr },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`\nengineer-quality eval (HARD suite) — ${syn.length + rr.length} tasks`);
  console.log(`  ${syn.length} synthetic-hard (fixtures/repo-hard, behavioral node-test oracles)`);
  console.log(`  ${rr.length} real-repo-hard (multi-file Praxis fixes, behavioral vitest oracles)\n`);
  for (const t of syn) {
    console.log(`  [syn]      ${t.task_id.padEnd(28)} [${t.bucket}]  ${t.pass_check}`);
  }
  for (const t of rr) {
    console.log(`  [real-repo] ${t.task_id.padEnd(32)} [${t.bucket}]  base=${t.base_sha.slice(0, 9)} head=${t.head_sha.slice(0, 9)}`);
  }
  console.log(`\nRun live (discriminating baseline — burns Opus per task):`);
  console.log(`  npm run eval:engineer-quality -- --suite hard --run --concurrency 2\n`);
}

async function hardRunMode(syn: EvalTask[], rr: RealRepoTask[]): Promise<number> {
  const pre = driverPreflight();
  if (!pre.ok) {
    console.error(`cannot --run: ${pre.reason}`);
    return 2;
  }
  let repoRoot: string | null = null;
  if (rr.length > 0) {
    try {
      repoRoot = resolveRepoRoot();
    } catch (e) {
      console.error(`cannot --run hard real-repo half: ${(e as Error).message}`);
      return 2;
    }
  }
  console.error(
    `[engineer-quality:hard] driving ${syn.length} synthetic-hard + ${rr.length} real-repo-hard live run(s), concurrency=${CONCURRENCY}` +
      `${NO_RUBRIC ? " (rubric OFF)" : " + Opus rubric"} — burns Opus per task.`,
  );

  type Item = { kind: "syn"; task: EvalTask } | { kind: "rr"; task: RealRepoTask };
  const items: Item[] = [
    ...syn.map((task) => ({ kind: "syn" as const, task })),
    ...rr.map((task) => ({ kind: "rr" as const, task })),
  ];

  const outcomes = await mapLimit(items, CONCURRENCY, async (item) => {
    if (item.kind === "syn") {
      const diff = await driveEngineerRun(HARD_FIXTURE_REPO_PATH, item.task);
      const deterministic = scoreDeterministic(HARD_FIXTURE_REPO_PATH, item.task, diff);
      const rubric = NO_RUBRIC ? null : await runRubric(item.task, diff, deterministic);
      return { task: item.task, deterministic, rubric } as TaskOutcome;
    }
    const rrTask = item.task;
    const evalTask = toEvalTask(rrTask);
    let materialization: ReturnType<typeof materializeTask> | null = null;
    try {
      materialization = materializeTask(repoRoot as string, rrTask);
      console.error(
        `[engineer-quality:hard] ${rrTask.task_id}: materialized @ ${rrTask.base_sha.slice(0, 9)}` +
          ` (node_modules ${materialization.nodeModulesFromCache ? "from cache" : "freshly installed"})`,
      );
      const diff = await driveEngineerRunInDir(materialization.repoDir, evalTask);
      const deterministic = scoreRealRepo(rrTask, diff, materialization);
      const rubric = NO_RUBRIC ? null : await runRubric(evalTask, diff, deterministic);
      return { task: evalTask, deterministic, rubric } as TaskOutcome;
    } catch (e) {
      const deterministic: DeterministicResult = {
        task_id: rrTask.task_id,
        tests_green: false,
        typecheck_ok: null,
        touched: [],
        out_of_scope: [],
        output_tail: "",
        failure_kind: "infra",
        error: `real-repo harness error: ${(e as Error).message}`,
      };
      return { task: evalTask, deterministic, rubric: null } as TaskOutcome;
    } finally {
      if (materialization) {
        try {
          removeMaterialization(repoRoot as string, materialization);
        } catch {
        }
      }
    }
  });
  emit(buildReport(outcomes));
  return 0;
}

function emit(report: ReturnType<typeof buildReport>): void {
  if (JSON_MODE) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
}

async function main(): Promise<void> {
  if (SUITE === "hard") {
    const syn = loadHardSyntheticTasks();
    const rr = loadHardRealRepoTasks();
    if (DRY) {
      listHard(syn, rr);
      process.exit(0);
    }
    if (DIFFS_FILE) {
      console.error("--diffs is not supported for the hard suite");
      process.exit(2);
    }
    if (RUN) {
      process.exit(await hardRunMode(syn, rr));
    }
    listHard(syn, rr);
    process.exit(0);
  }

  if (SUITE === "real-repo") {
    const tasks = loadRealRepoTasks();
    if (DRY) {
      listRealRepo(tasks);
      process.exit(0);
    }
    if (DIFFS_FILE) {
      console.error("--diffs is only supported for the fixture suite");
      process.exit(2);
    }
    if (RUN) {
      process.exit(await realRepoRunMode(tasks));
    }
    listRealRepo(tasks);
    process.exit(0);
  }

  const tasks = loadFixtureTasks();
  if (DRY) {
    listFixture(tasks);
    process.exit(0);
  }
  if (DIFFS_FILE) {
    process.exit(await fixtureDiffsMode(tasks));
  }
  if (RUN) {
    process.exit(await fixtureRunMode(tasks));
  }
  listFixture(tasks);
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
