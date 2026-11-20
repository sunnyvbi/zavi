
import { meanResearchRubric } from "./rubric";
import type {
  ResearchEvalReport,
  ResearchRubricScores,
  ResearchTaskOutcome,
} from "./types";

const DIMS: (keyof ResearchRubricScores)[] = [
  "source_independence",
  "recency",
  "primary_vs_secondary",
  "so_what",
  "fact_vs_judgment",
];

export function buildResearchReport(
  outcomes: ResearchTaskOutcome[],
  baseline: ResearchRubricScores | null,
): ResearchEvalReport {
  const total = outcomes.length;
  const run_errors = outcomes.filter((o) => o.run_error).length;
  const rubrics = outcomes.map((o) => o.rubric);
  const scored = rubrics.filter((r) => !r.error).length;
  const mean_rubric = meanResearchRubric(rubrics);

  let passed_baseline = true;
  if (baseline && mean_rubric) {
    passed_baseline = DIMS.every((d) => mean_rubric[d] >= baseline[d]);
  }

  return {
    ts: new Date().toISOString(),
    total,
    run_errors,
    scored,
    mean_rubric,
    baseline,
    passed_baseline,
    outcomes,
  };
}

export function formatResearchReport(report: ResearchEvalReport): string {
  const lines: string[] = [];
  lines.push(`\nresearch-quality eval — ${report.ts}`);
  lines.push(`  tasks: ${report.total}  scored: ${report.scored}  run-errors: ${report.run_errors}`);
  if (report.mean_rubric) {
    const m = report.mean_rubric;
    lines.push(`  mean rubric (0-5):`);
    for (const d of DIMS) {
      const floor = report.baseline ? report.baseline[d] : null;
      const flag = floor != null && m[d] < floor ? "  ⬇ BELOW BASELINE" : "";
      const floorStr = floor != null ? ` (floor ${floor})` : "";
      lines.push(`    ${d.padEnd(20)} = ${m[d]}${floorStr}${flag}`);
    }
    lines.push(`  baseline: ${report.passed_baseline ? "PASS" : "FAIL"}`);
  } else {
    lines.push(`  mean rubric: (none — every run/judge errored)`);
  }
  lines.push("");
  lines.push("  per-task:");
  for (const o of report.outcomes) {
    const status = o.run_error ? "RUN-ERR" : o.rubric.error ? "JUDGE-ERR" : "OK";
    let line = `    [${status.padEnd(9)}] ${o.task.task_id.padEnd(28)}`;
    if (!o.rubric.error) {
      const s = o.rubric.scores;
      line += `  si=${s.source_independence} rc=${s.recency} pvs=${s.primary_vs_secondary} sw=${s.so_what} fvj=${s.fact_vs_judgment}`;
    }
    lines.push(line);
    if (o.run_error) lines.push(`           run-error: ${o.run_error}`);
    else if (o.rubric.error) lines.push(`           judge-error: ${o.rubric.error}`);
    else if (o.rubric.justification) lines.push(`           why: ${o.rubric.justification}`);
  }
  lines.push("");
  return lines.join("\n");
}
