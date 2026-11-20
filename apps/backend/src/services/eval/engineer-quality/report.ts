
import { meanRubric } from "./rubric";
import type { EvalReport, RubricResult, TaskOutcome } from "./types";

export function buildReport(outcomes: TaskOutcome[]): EvalReport {
  const total = outcomes.length;
  const infra_errors = outcomes.filter(
    (o) => o.deterministic.failure_kind === "infra",
  ).length;
  const scored = total - infra_errors;
  const green = outcomes.filter((o) => o.deterministic.tests_green).length;
  const merge_equivalent_pct =
    scored === 0 ? 0 : Math.round((green / scored) * 1000) / 10;

  const rubrics = outcomes
    .map((o) => o.rubric)
    .filter((r): r is RubricResult => r !== null);
  const mean_rubric = rubrics.length > 0 ? meanRubric(rubrics) : null;

  return {
    ts: new Date().toISOString(),
    total,
    infra_errors,
    scored,
    merge_equivalent_pct,
    mean_rubric,
    outcomes,
  };
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`\nengineer-quality eval — ${report.ts}`);
  lines.push(`  tasks: ${report.total}`);
  lines.push(
    `  baseline merge-equivalent: ${report.merge_equivalent_pct}%  (deterministic tests green, ${report.scored} scored task(s))`,
  );
  if (report.infra_errors > 0) {
    lines.push(
      `  infra errors (excluded from baseline): ${report.infra_errors}  — transient run errors after retries [ERR-infra]`,
    );
  }
  if (report.mean_rubric) {
    const m = report.mean_rubric;
    lines.push(
      `  mean rubric (0-5): correctness=${m.correctness}  scope_fit=${m.scope_fit}  regression_safety=${m.regression_safety}`,
    );
  } else {
    lines.push(`  mean rubric: (skipped — no rubric scores)`);
  }
  lines.push("");
  lines.push("  per-task:");
  for (const o of report.outcomes) {
    const d = o.deterministic;
    let status: string;
    if (d.failure_kind === "infra") status = "ERR-infra ";
    else if (d.failure_kind === "nofix") status = "FAIL-nofix";
    else if (d.error) status = "ERR       ";
    else if (d.tests_green) status = "PASS      ";
    else status = "FAIL      ";
    let line = `    [${status}] ${o.task.task_id.padEnd(28)} bucket=${o.task.bucket}`;
    if (typeof d.attempts === "number" && d.attempts > 1)
      line += `  attempts=${d.attempts}`;
    if (o.rubric && !o.rubric.error) {
      const s = o.rubric.scores;
      line += `  rubric c=${s.correctness} s=${s.scope_fit} r=${s.regression_safety}`;
    } else if (o.rubric?.error) {
      line += `  rubric=ERR(${o.rubric.error})`;
    }
    lines.push(line);
    if (d.error) lines.push(`           det-error: ${d.error}`);
    if (d.out_of_scope.length > 0)
      lines.push(`           out-of-scope edits: ${d.out_of_scope.join(", ")}`);
    if (o.rubric && !o.rubric.error && o.rubric.justification)
      lines.push(`           why: ${o.rubric.justification}`);
  }
  lines.push("");
  return lines.join("\n");
}
