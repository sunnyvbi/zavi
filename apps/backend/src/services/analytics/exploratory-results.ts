
import { digitsOf } from "@/services/agents/engine/figure-ledger";

export type ExploratoryRead = {
  sql_reads: string[];
  purpose: string;
  session_tz: string | null;
  fetched_at: string;
  caveats: string[];
  digits: Set<string>;
};

const MAX_RUNS = 500;
const MAX_CALLS_PER_RUN = 50;
const MAX_SQL_CHARS = 2_000;
const MAX_READS_KEPT = 5;

const store = new Map<string, ExploratoryRead[]>();

function scope(tenant_id: string, run_id: string): string {
  return `${tenant_id}:${run_id}`;
}

export function digitSetOf(value: unknown): Set<string> {
  let raw: string;
  try {
    raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  for (const re of [/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g, /\d+/g]) {
    for (const m of raw.matchAll(re)) {
      const d = digitsOf(m[0]);
      if (d.length >= 2) out.add(d);
    }
  }
  return out;
}

export function putExploratory(
  tenant_id: string,
  run_id: string | undefined,
  read: { sql_reads: string[]; purpose: string; session_tz: string | null; caveats?: string[]; result: unknown },
): void {
  if (!run_id) return;
  try {
    const key = scope(tenant_id, run_id);
    let list = store.get(key);
    if (!list) {
      list = [];
      store.set(key, list);
      if (store.size > MAX_RUNS) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
    }
    if (list.length >= MAX_CALLS_PER_RUN) list.shift();
    list.push({
      sql_reads: read.sql_reads.slice(0, MAX_READS_KEPT).map((s) => s.slice(0, MAX_SQL_CHARS)),
      purpose: read.purpose.slice(0, 300),
      session_tz: read.session_tz,
      fetched_at: new Date().toISOString(),
      caveats: (read.caveats ?? []).slice(0, 4).map((c) => c.slice(0, 300)),
      digits: digitSetOf(read.result),
    });
  } catch {
  }
}

export function exploratoryFor(tenant_id: string, run_id: string, digits: string): ExploratoryRead | null {
  const list = store.get(scope(tenant_id, run_id));
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].digits.has(digits)) return list[i];
  return null;
}

export function _clearExploratory(): void {
  store.clear();
}
