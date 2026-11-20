import { toCsv, type ReportModel } from "@zavi/shared";

export function reportFileStem(title: string): string {
  return title.replace(/[^\w-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "report";
}

export function reportToMarkdown(model: ReportModel, summary: string): string {
  const cell = (s: string) => (s || "-").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const table = [
    `| ${model.columns.map(cell).join(" | ")} |`,
    `| ${model.columns.map(() => "---").join(" | ")} |`,
    ...model.rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
  const kpis = model.kpis.map((k) => `- **${k.name}:** ${k.value}${k.change ? ` (${k.change})` : ""}`).join("\n");
  return [`# ${model.title}`, summary.trim(), kpis, table, model.note ?? ""].filter(Boolean).join("\n\n") + "\n";
}

export function saveTextFile(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadReportCsv(model: ReportModel) {
  saveTextFile(toCsv(model.columns, model.rows), `${reportFileStem(model.title)}.csv`, "text/csv");
}

export function downloadReportMarkdown(model: ReportModel, summary: string) {
  saveTextFile(reportToMarkdown(model, summary), `${reportFileStem(model.title)}.md`, "text/markdown");
}
