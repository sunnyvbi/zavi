export type TimelineEntry<R, X> =
  | { kind: "row"; row: R; index: number; at: string }
  | { kind: "extra"; item: X; at: string };

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

export function interleaveByTime<R extends { created_at: string }, X extends { at: string }>(
  rows: readonly R[],
  extras: readonly X[],
): TimelineEntry<R, X>[] {
  const sorted = extras
    .map((item, order) => ({ item, order, t: timeOf(item.at) }))
    .sort((a, b) => a.t - b.t || a.order - b.order);
  const out: TimelineEntry<R, X>[] = [];
  let x = 0;
  rows.forEach((row, index) => {
    const t = timeOf(row.created_at);
    while (x < sorted.length && sorted[x]!.t < t) {
      out.push({ kind: "extra", item: sorted[x]!.item, at: sorted[x]!.item.at });
      x++;
    }
    out.push({ kind: "row", row, index, at: row.created_at });
  });
  for (; x < sorted.length; x++) {
    out.push({ kind: "extra", item: sorted[x]!.item, at: sorted[x]!.item.at });
  }
  return out;
}

export function decisionRunsOf<R extends { kind: string }, X>(
  timeline: readonly TimelineEntry<R, X>[],
): Map<number, Array<{ row: R; index: number }> | null> {
  const out = new Map<number, Array<{ row: R; index: number }> | null>();
  let k = 0;
  while (k < timeline.length) {
    const run: Array<{ row: R; index: number }> = [];
    let j = k;
    for (; j < timeline.length; j++) {
      const e = timeline[j]!;
      if (e.kind !== "row" || e.row.kind !== "decision") break;
      run.push({ row: e.row, index: e.index });
    }
    if (run.length >= 2) {
      out.set(k, run);
      for (let m = k + 1; m < j; m++) out.set(m, null);
    }
    k = Math.max(j, k + 1);
  }
  return out;
}

export function lastTurnRowIndex(rows: readonly { kind: string }[]): number {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.kind !== "decision") return i;
  return -1;
}

export function hideCardsWhileFiling<R extends { kind: string; agent_run_id: string | null; created_at: string }>(
  rows: readonly R[],
  inflight: { run_id: string; since: string | null } | null,
): R[] {
  if (!inflight) return [...rows];
  const since = inflight.since ? Date.parse(inflight.since) : NaN;
  return rows.filter((r) => {
    if (r.kind !== "decision") return true;
    if (r.agent_run_id === inflight.run_id) return false;
    return !(Number.isFinite(since) && Date.parse(r.created_at) >= since);
  });
}

export function originLabel(
  body: { from_other_chat?: unknown; filed_at?: unknown } | null | undefined,
  locale?: string,
  timeZone?: string,
): string | null {
  if (body?.from_other_chat !== true || typeof body.filed_at !== "string") return null;
  const t = Date.parse(body.filed_at);
  if (!Number.isFinite(t)) return null;
  const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) }).format(new Date(t));
  return `From your ${day} chat`;
}
