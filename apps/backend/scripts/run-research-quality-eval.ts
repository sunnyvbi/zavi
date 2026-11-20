#!/usr/bin/env tsx

import fs from "node:fs";
import { getAnthropic } from "@/services/anthropic";
import {
  parseResearchTasks,
  parseResearchBaseline,
  RESEARCH_TASKS_JSON_PATH,
  RESEARCH_BASELINE_JSON_PATH,
} from "@/services/eval/research-quality/task-loader";
import {
  buildResearchRubricPrompt,
  parseResearchRubricReply,
  RESEARCH_RUBRIC_JUDGE_MODEL,
} from "@/services/eval/research-quality/rubric";
import { driveResearchRun, researchDriverPreflight } from "@/services/eval/research-quality/driver";
import {
  buildResearchReport,
  formatResearchReport,
} from "@/services/eval/research-quality/report";
import type {
  ResearchEvalTask,
  ResearchRubricResult,
  ResearchRubricScores,
  ResearchTaskOutcome,
} from "@/services/eval/research-quality/types";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string): string | null => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const JSON_MODE = has("--json");
const LIST = has("--list") || has("--dry-run");
const ONLY_TASK = val("--task");
const CONCURRENCY = Math.min(3, Math.max(1, Number(val("--concurrency") ?? "2") || 2));

function loadTasks(): ResearchEvalTask[] {
  const raw = fs.readFileSync(RESEARCH_TASKS_JSON_PATH, "utf-8");
  let tasks = parseResearchTasks(raw);
  if (ONLY_TASK) {
    tasks = tasks.filter((t) => t.task_id === ONLY_TASK);
    if (tasks.length === 0) throw new Error(`--task ${ONLY_TASK} not found in tasks.json`);
  }
  return tasks;
}

function loadBaseline(): ResearchRubricScores | null {
  try {
    return parseResearchBaseline(fs.readFileSync(RESEARCH_BASELINE_JSON_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function listTasks(tasks: ResearchEvalTask[]): void {
  if (JSON_MODE) {
    console.log(JSON.stringify({ suite: "research-quality", task_count: tasks.length, tasks }, null, 2));
    return;
  }
  console.log(`\nresearch-quality eval — ${tasks.length} frozen tasks`);
  console.log(`  tasks.json:    ${RESEARCH_TASKS_JSON_PATH}`);
  console.log(`  baseline.json: ${RESEARCH_BASELINE_JSON_PATH}\n`);
  for (const t of tasks) {
    console.log(`  ${t.task_id.padEnd(30)} ${t.ask.slice(0, 80)}`);
  }
  console.log(`\nRun live (burns Opus per task — gated):`);
  console.log(`  RESEARCH_QUALITY_EVAL=1 npm run eval:research-quality\n`);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function judge(task: ResearchEvalTask, rendered: string): Promise<ResearchRubricResult> {
  try {
    const { system, user } = buildResearchRubricPrompt(task, rendered);
    const resp = await getAnthropic().messages.create({
      model: RESEARCH_RUBRIC_JUDGE_MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return parseResearchRubricReply(task.task_id, text);
  } catch (e) {
    return {
      task_id: task.task_id,
      scores: {
        source_independence: 0,
        recency: 0,
        primary_vs_secondary: 0,
        so_what: 0,
        fact_vs_judgment: 0,
      },
      justification: "",
      error: `rubric call failed: ${(e as Error).message}`,
    };
  }
}

async function scoreOne(task: ResearchEvalTask): Promise<ResearchTaskOutcome> {
  const drive = await driveResearchRun(task);
  if (drive.error) {
    return {
      task,
      rendered_preview: "",
      run_error: drive.error,
      rubric: {
        task_id: task.task_id,
        scores: {
          source_independence: 0,
          recency: 0,
          primary_vs_secondary: 0,
          so_what: 0,
          fact_vs_judgment: 0,
        },
        justification: "",
        error: `run failed: ${drive.error}`,
      },
    };
  }
  const rubric = await judge(task, drive.rendered);
  return { task, rendered_preview: drive.rendered.slice(0, 800), rubric };
}

async function main(): Promise<void> {
  const tasks = loadTasks();

  if (LIST) {
    listTasks(tasks);
    process.exit(0);
  }

  if (process.env.RESEARCH_QUALITY_EVAL !== "1") {
    console.error(
      "[research-quality] skipped: set RESEARCH_QUALITY_EVAL=1 to drive live research runs " +
        "(burns Opus per task). Use --list to inspect the suite without spend.",
    );
    process.exit(0);
  }

  const pre = researchDriverPreflight();
  if (!pre.ok) {
    console.error(`cannot run: ${pre.reason}`);
    process.exit(2);
  }

  const baseline = loadBaseline();
  console.error(
    `[research-quality] driving ${tasks.length} live research run(s), concurrency=${CONCURRENCY} + Opus rubric — burns Opus per task.`,
  );

  const outcomes = await mapLimit(tasks, CONCURRENCY, scoreOne);
  const report = buildResearchReport(outcomes, baseline);

  if (JSON_MODE) console.log(JSON.stringify(report, null, 2));
  else console.log(formatResearchReport(report));

  process.exit(report.passed_baseline ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
