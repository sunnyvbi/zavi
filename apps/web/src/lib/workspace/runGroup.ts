
export type RunGroupRef = {
  run_id: string;
  position: number;
  of: number;
};

export type GroupableDecision = {
  id: string;
  emitted_at: string;
  run_group?: RunGroupRef | null;
};

export type ChannelRow<T> = {
  key: string;
  run_id: string | null;
  items: T[];
};

export function groupByRun<T extends GroupableDecision>(
  decisions: readonly T[],
): ChannelRow<T>[] {
  const rows: ChannelRow<T>[] = [];
  const byRun = new Map<string, ChannelRow<T>>();

  for (const d of decisions) {
    const runId = d.run_group?.run_id ?? null;
    if (!runId) {
      rows.push({ key: d.id, run_id: null, items: [d] });
      continue;
    }
    const seen = byRun.get(runId);
    if (seen) {
      seen.items.push(d);
      continue;
    }
    const row: ChannelRow<T> = { key: runId, run_id: runId, items: [d] };
    byRun.set(runId, row);
    rows.push(row);
  }

  for (const row of rows) {
    if (row.run_id && row.items.length > 1) {
      row.items.sort(
        (a, b) => (a.run_group?.position ?? 0) - (b.run_group?.position ?? 0),
      );
    }
  }
  return rows;
}

export function runProgress<T extends GroupableDecision>(
  row: ChannelRow<T>,
  notDone = 0,
): { remaining: number; total: number; done: number; notDone: number } | null {
  if (!row.run_id) return null;
  const total = row.items[0]?.run_group?.of ?? row.items.length;
  return { total, ...splitClosed(total, row.items.length, notDone) };
}

export function splitClosed(
  total: number,
  remaining: number,
  notDone: number,
): { remaining: number; done: number; notDone: number } {
  const closed = Math.max(0, total - remaining);
  const held = Math.min(Math.max(0, notDone), closed);
  return { remaining, notDone: held, done: closed - held };
}
