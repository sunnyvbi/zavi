
import { randomBytes } from "node:crypto";

export type StoredResult = {
  result_id: string;
  kind: "metric" | "compute";
  value: number | null;
  compare_value?: number | null;
  receipt: Record<string, unknown>;
  label?: string;
  unit?: string;
  series?: Array<{ start: string; end: string; value: number | null; partial: boolean }>;
  delta_pct?: number | null;
  verified?: boolean;
  sourced?: boolean;
};

export function resultIsVerified(r: StoredResult): boolean {
  return r.kind === "metric" || r.verified === true;
}

const MAX_RUNS = 500;
const MAX_RESULTS_PER_RUN = 200;

const store = new Map<string, Map<string, StoredResult>>();

function scope(tenant_id: string, run_id: string | undefined): string {
  return `${tenant_id}:${run_id ?? "no-run"}`;
}

export function newResultId(kind: StoredResult["kind"]): string {
  return `${kind === "metric" ? "m" : "c"}_${randomBytes(5).toString("hex")}`;
}

export function putResult(tenant_id: string, run_id: string | undefined, r: StoredResult): void {
  const key = scope(tenant_id, run_id);
  let m = store.get(key);
  if (!m) {
    m = new Map();
    store.set(key, m);
    if (store.size > MAX_RUNS) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
  }
  if (m.size >= MAX_RESULTS_PER_RUN) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
  m.set(r.result_id, r);
}

export function getResult(tenant_id: string, run_id: string | undefined, result_id: string): StoredResult | null {
  return store.get(scope(tenant_id, run_id))?.get(result_id) ?? null;
}

export function listResults(tenant_id: string, run_id: string | undefined): StoredResult[] {
  return [...(store.get(scope(tenant_id, run_id))?.values() ?? [])];
}

export function _clearResults(): void {
  store.clear();
}
