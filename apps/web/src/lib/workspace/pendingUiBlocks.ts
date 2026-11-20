
import type { ChatRow } from "./useChatThread";

export type PendingUiBlock = { key: string; kind: "chart" | "kpi" | "table" | "posts" | "html"; title: string | null };

const KIND_OF: Record<string, PendingUiBlock["kind"]> = {
  show_chart: "chart",
  show_kpis: "kpi",
  show_table: "table",
  show_posts: "posts",
  show_html: "html",
};

function field(row: ChatRow, key: string): string {
  return String((row.body as Record<string, unknown>)[key] ?? "");
}

export function pendingUiBlocks(rows: ChatRow[]): PendingUiBlock[] {
  const out: PendingUiBlock[] = [];
  for (const r of rows) {
    if (field(r, "teKind") !== "tool_call") continue;
    const m = /(?:^|__)(show_chart|show_kpis|show_table|show_posts|show_html)$/.exec(field(r, "tool_name"));
    if (!m) continue;
    const target = field(r, "target");
    if (!target) continue;
    const t = /"title"\s*:\s*"((?:[^"\\]|\\.){0,120})/.exec(target);
    out.push({ key: r.id, kind: KIND_OF[m[1]], title: t ? t[1].replace(/\\"/g, '"') : null });
  }
  return out;
}
