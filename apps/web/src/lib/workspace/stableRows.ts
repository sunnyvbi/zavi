
type Keyed = { id: string };

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function shareStableRows<T extends Keyed>(prev: T[], next: T[]): T[] {
  if (prev === next) return prev;
  if (prev.length === 0) return next.length === 0 ? prev : next;
  const byId = new Map<string, T>();
  for (const row of prev) byId.set(row.id, row);
  let unchanged = prev.length === next.length;
  const out = next.map((row, i) => {
    const old = byId.get(row.id);
    if (old !== undefined && sameValue(old, row)) {
      if (prev[i] !== old) unchanged = false;
      return old;
    }
    unchanged = false;
    return row;
  });
  return unchanged ? prev : out;
}

export function shareStableRowMap<T extends Keyed>(
  prev: Map<string, T[]>,
  next: Map<string, T[]>,
): Map<string, T[]> {
  if (prev === next) return prev;
  if (prev.size === 0 && next.size === 0) return prev;
  let unchanged = prev.size === next.size;
  const out = new Map<string, T[]>();
  for (const [key, rows] of next) {
    const old = prev.get(key);
    const shared = old ? shareStableRows(old, rows) : rows;
    if (shared !== old) unchanged = false;
    out.set(key, shared);
  }
  return unchanged ? prev : out;
}
