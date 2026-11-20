
export const MEMORY_PILL_RECENT_REPLIES = 10;

type Row = { kind: string; agent_run_id: string | null };

export function memoryPillRowIndexes(rows: readonly Row[], max = MEMORY_PILL_RECENT_REPLIES): Set<number> {
  const out = new Set<number>();
  const runs = new Set<string>();
  for (let i = rows.length - 1; i >= 0 && runs.size < max; i--) {
    const r = rows[i]!;
    if (r.kind !== "chat_assistant" || !r.agent_run_id || runs.has(r.agent_run_id)) continue;
    runs.add(r.agent_run_id);
    out.add(i);
  }
  return out;
}
