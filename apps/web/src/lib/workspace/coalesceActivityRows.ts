
import type { ChatRow } from "./useChatThread";

export type ActivityGroup = { key: string; row: ChatRow; count: number };

function field(row: ChatRow, key: string): string {
  return String((row.body as Record<string, unknown>)[key] ?? "");
}

export function coalesceActivityRows(rows: ChatRow[]): ActivityGroup[] {
  const out: ActivityGroup[] = [];
  for (const r of rows) {
    const kind = field(r, "teKind");
    const prev = out[out.length - 1];
    if (
      prev &&
      kind === "tool_call" &&
      field(prev.row, "teKind") === "tool_call" &&
      field(prev.row, "tool_name") === field(r, "tool_name") &&
      (field(prev.row, "target") === field(r, "target") ||
        !field(prev.row, "target") ||
        !field(r, "target"))
    ) {
      prev.count += 1;
      if (!field(prev.row, "target") && field(r, "target")) prev.row = r;
      continue;
    }
    out.push({ key: r.id, row: r, count: 1 });
  }
  return out;
}
