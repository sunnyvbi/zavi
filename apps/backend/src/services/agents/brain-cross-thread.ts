
import type { ToolCallTrace } from "@/services/tools/types";

export function extractCrossThreadHits(
  tool_calls: readonly ToolCallTrace[] | undefined | null,
  current_thread_id: string | null,
): string[] {
  if (!tool_calls || tool_calls.length === 0) return [];
  const seen = new Set<string>();
  for (const tc of tool_calls) {
    if (tc.name !== "memory_search" && tc.name !== "memory__search") continue;
    if (tc.status !== "ok") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(tc.output_preview);
      if (typeof parsed === "string") {
        parsed = JSON.parse(parsed);
      }
    } catch {
      continue;
    }
    const hits = (parsed as { hits?: unknown })?.hits;
    if (!Array.isArray(hits)) continue;
    for (const h of hits) {
      if (!h || typeof h !== "object") continue;
      const tid = (h as { thread_id?: unknown }).thread_id;
      if (typeof tid !== "string" || tid.length === 0) continue;
      if (current_thread_id !== null && tid === current_thread_id) continue;
      seen.add(tid);
    }
  }
  return [...seen];
}
