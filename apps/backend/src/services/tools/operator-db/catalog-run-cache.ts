
import type { McpCallResult } from "../../mcp/types";

export const CATALOG_RUN_CACHE_TTL_MS = 10 * 60_000;
const MAX_RUNS = 500;
const MAX_INPUTS_PER_RUN = 8;

type Cached = { fence: string; result: Promise<McpCallResult> };
type Entry = { at: number; byInput: Map<string, Cached> };
const runs = new Map<string, Entry>();

const runKey = (tenantId: string, runId: string) => `${tenantId}|${runId}`;

export function catalogInputKey(parsed: { tables?: readonly string[] } | undefined): string {
  const tables = parsed?.tables;
  return tables?.length ? JSON.stringify([...new Set(tables)].sort()) : "";
}

function sweep(now: number): void {
  for (const [key, entry] of runs) {
    if (now - entry.at > CATALOG_RUN_CACHE_TTL_MS) runs.delete(key);
  }
}

export function getCachedCatalog(
  tenantId: string,
  runId: string,
  inputKey: string,
  fence: string,
  now: number = Date.now(),
): Promise<McpCallResult> | undefined {
  const key = runKey(tenantId, runId);
  const entry = runs.get(key);
  if (!entry) return undefined;
  if (now - entry.at > CATALOG_RUN_CACHE_TTL_MS) {
    runs.delete(key);
    return undefined;
  }
  const hit = entry.byInput.get(inputKey);
  if (!hit) return undefined;
  if (hit.fence !== fence) {
    runs.delete(key);
    return undefined;
  }
  return hit.result;
}

export function putCachedCatalog(
  tenantId: string,
  runId: string,
  inputKey: string,
  fence: string,
  result: Promise<McpCallResult>,
  now: number = Date.now(),
): void {
  const key = runKey(tenantId, runId);
  let entry = runs.get(key);
  if (!entry) {
    sweep(now);
    while (runs.size >= MAX_RUNS) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined) break;
      runs.delete(oldest);
    }
    entry = { at: now, byInput: new Map() };
    runs.set(key, entry);
  }
  if (!entry.byInput.has(inputKey) && entry.byInput.size >= MAX_INPUTS_PER_RUN) return;
  const cached: Cached = { fence, result };
  entry.byInput.set(inputKey, cached);
  const forget = () => {
    if (runs.get(key)?.byInput.get(inputKey) === cached) dropRunCatalogCache(tenantId, runId);
  };
  result.then((r) => {
    if (!r.ok || r.is_error || !isReadyCatalog(r.content)) forget();
  }, forget);
}

export function dropRunCatalogCache(tenantId: string, runId: string): void {
  runs.delete(runKey(tenantId, runId));
}

function isReadyCatalog(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { ok?: unknown; data?: { ready?: unknown } } | null;
    return parsed?.ok === true && parsed.data?.ready === true;
  } catch {
    return false;
  }
}

export const __testOnly = { runs, MAX_INPUTS_PER_RUN };
