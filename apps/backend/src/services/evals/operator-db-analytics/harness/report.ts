
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Verdict } from "./grade";

export type Summary = ReturnType<typeof import("./grade").summarise>;

export async function writeReport(input: {
  dialect: string;
  verdicts: Verdict[];
  summary: Summary;
}): Promise<string> {
  const dir = path.resolve(process.cwd(), "../../docs/qa-reports/operator-db-analytics");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = path.join(dir, `eval-${input.dialect}-${stamp}.md`);

  const pct = (p: number, t: number) => (t === 0 ? "-" : `${((p / t) * 100).toFixed(0)}%`);
  const lines: string[] = [
    `# Operator-DB analytics eval — ${input.dialect}`,
    "",
    `${input.summary.passed}/${input.summary.total} correct (${(input.summary.accuracy * 100).toFixed(1)}%)`,
    "",
    "## By business shape",
    "",
    "| shape | correct |",
    "|---|---|",
    ...Object.entries(input.summary.byShape).map(
      ([k, v]) => `| ${k} | ${v.passed}/${v.total} (${pct(v.passed, v.total)}) |`,
    ),
    "",
    "## By trap",
    "",
    "| trap | correct |",
    "|---|---|",
    ...Object.entries(input.summary.byTrap)
      .sort((a, b) => a[1].passed / a[1].total - b[1].passed / b[1].total)
      .map(([k, v]) => `| ${k} | ${v.passed}/${v.total} (${pct(v.passed, v.total)}) |`),
    "",
    "## Diagnosed mistakes",
    "",
    Object.keys(input.summary.diagnosedMistakes).length === 0
      ? "_none — every wrong answer was wrong in a way the bank does not yet name._"
      : Object.entries(input.summary.diagnosedMistakes)
          .map(([k, n]) => `- ${n}x ${k}`)
          .join("\n"),
    "",
    "## Every question",
    "",
    "| id | shape | pass | failure | expected | got | notes |",
    "|---|---|---|---|---|---|---|",
    ...input.verdicts.map(
      (v) =>
        `| ${v.question_id} | ${v.shape} | ${v.pass ? "yes" : "NO"} | ${v.failure_mode ?? ""} | ${
          v.expected ?? ""
        } | ${v.got ?? ""} | ${(v.diagnosed_mistake ?? v.notes ?? "").replace(/\|/g, "/")} |`,
    ),
    "",
  ];

  await writeFile(file, lines.join("\n"), "utf8");
  console.log(`[eval] report written: ${file}`);
  return file;
}
