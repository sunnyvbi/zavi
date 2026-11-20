
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import type {
  OperatorDbType,
  RawIntrospection,
  RawTable,
  OperatorDbCatalog,
  CatalogTable,
  DiscoveryCoverage,
} from "../types";
import { heuristicHints, refineHintsWithHaiku } from "./hints";
import { sanitizeDiscoveryError } from "./errors";

const DEFAULT_CAP_MS = 25_000;

export const WORKER_DISCOVER_CAP_MS = 240_000;
export const WORKER_DISCOVER_TABLE_CAP = 1000;

export function normalizeRawCatalog(raw: RawIntrospection): OperatorDbCatalog {
  const tables: CatalogTable[] = raw.tables.map((t: RawTable) => ({
    name: t.name,
    columns: t.columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      ...(c.json_keys && c.json_keys.length > 0 ? { json_keys: [...c.json_keys] } : {}),
      ...(c.json_sampled ? { json_sampled: c.json_sampled } : {}),
      ...(c.json_map_like ? { json_map_like: true } : {}),
    })),
    rowEstimate: t.rowEstimate,
    ...(t.view_of ? { view_of: t.view_of, removed_fields: t.removed_fields ?? [] } : {}),
    ...(t.partitioned ? { partitioned: true, partitions: [...(t.partitions ?? [])] } : {}),
    ...(t.parents && t.parents.length > 0 ? { parents: [...t.parents] } : {}),
  }));
  return { tables };
}

export function coverageFromRaw(raw: RawIntrospection): DiscoveryCoverage {
  return {
    tables_total: raw.namesSeenTotal,
    tables_indexed: raw.tables.length,
    skipped_unsafe_names: raw.skippedUnsafeNames,
    deadline_hit: raw.deadlineHit,
    listing_truncated: raw.listingTruncated,
  };
}

async function persist(
  tenantId: string,
  dialect: OperatorDbType,
  catalog: OperatorDbCatalog | Record<string, never>,
  hints: object,
  discoveryError: string | null,
  coverage: DiscoveryCoverage | Record<string, never>,
): Promise<void> {
  const { error } = await serviceClient().rpc("set_tenant_db_catalog", {
    p_tenant_id: tenantId,
    p_dialect: dialect,
    p_catalog: catalog,
    p_hints: hints,
    p_discovery_error: discoveryError,
    p_coverage: coverage,
  });
  if (error) throw new Error(`set_tenant_db_catalog failed: ${error.message}`);
}

export const SOURCE_CHANGED_DISCOVERY = "source_changed";

export const RESCAN_KEPT_LAST_GOOD = "rescan_kept_last_good";

export type ScanOutcome = "stored" | "stored_error" | "kept_last_good" | "stale";
const LOCK_CONFLICT_CODES: ReadonlySet<string> = new Set(["55P03", "40P01"]);
const APPLY_LOCK_RETRIES = 3;
const APPLY_LOCK_BACKOFF_MS = 250;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SCAN_OUTCOMES: ReadonlySet<string> = new Set(["stored", "stored_error", "kept_last_good", "stale"]);

export async function applyScan(
  tenantId: string,
  dialect: OperatorDbType,
  catalog: OperatorDbCatalog | Record<string, never>,
  hints: object,
  discoveryError: string | null,
  coverage: DiscoveryCoverage | Record<string, never>,
  generation: number,
): Promise<ScanOutcome> {
  const args = {
    p_tenant_id: tenantId,
    p_dialect: dialect,
    p_catalog: catalog,
    p_hints: hints,
    p_discovery_error: discoveryError,
    p_coverage: coverage,
    p_generation: generation,
  };
  let { data, error } = await serviceClient().rpc("apply_tenant_db_scan", args);
  for (let i = 0; error && LOCK_CONFLICT_CODES.has(String((error as { code?: unknown }).code)) && i < APPLY_LOCK_RETRIES; i++) {
    await sleep(APPLY_LOCK_BACKOFF_MS * (i + 1));
    ({ data, error } = await serviceClient().rpc("apply_tenant_db_scan", args));
  }
  if (error) throw new Error(`apply_tenant_db_scan failed: ${error.message}`);
  const outcome = typeof data === "string" && SCAN_OUTCOMES.has(data) ? (data as ScanOutcome) : null;
  if (!outcome) throw new Error(`apply_tenant_db_scan returned ${JSON.stringify(data)}`);
  const tables = Array.isArray((catalog as OperatorDbCatalog).tables) ? (catalog as OperatorDbCatalog).tables.length : 0;
  if (outcome === "kept_last_good") {
    await logEvent({
      level: "warn",
      source: "operator-db.discovery",
      code: "rescan_kept_last_good",
      tenant_id: tenantId,
      message: discoveryError ?? (tables === 0 ? "The latest scan found no tables" : "The latest scan was partial and smaller"),
      meta: { dialect, tables_found: tables },
    });
  } else if (outcome === "stored_error") {
    await logEvent({
      level: "error",
      source: "operator-db.discovery",
      code: "discovery_failed",
      tenant_id: tenantId,
      message: discoveryError ?? "discovery failed",
      meta: { dialect },
    });
  } else if (outcome === "stored" && tables === 0) {
    await logEvent({ level: "warn", source: "operator-db.discovery", code: "discovery_empty", tenant_id: tenantId, meta: { dialect } });
  }
  return outcome;
}

export async function persistDiscoveryFailure(
  tenantId: string,
  type: OperatorDbType,
  discoveryError: string,
  generation: number,
): Promise<void> {
  try {
    await applyScan(tenantId, type, {}, {}, discoveryError, {}, generation);
  } catch (e) {
    console.warn(`[operator-db] discovery failure record FAILED for tenant=${tenantId} (${discoveryError}): ${(e as Error).message}`);
  }
}

export async function markCatalogRediscovering(
  tenantId: string,
  type: OperatorDbType,
): Promise<void> {
  await persist(tenantId, type, {}, {}, null, {});
}

export type DiscoverResult =
  | { ok: true; tables_found: number; entities_inferred: string[] }
  | { ok: false; discovery_error: string; kept_last_good?: true };

export async function persistIntrospection(
  tenantId: string,
  type: OperatorDbType,
  raw: RawIntrospection,
  deadline: number,
  generation: number,
): Promise<DiscoverResult> {
  const catalog = normalizeRawCatalog(raw);
  const coverage = coverageFromRaw(raw);
  const heuristic = heuristicHints(catalog);

  const outcome = await applyScan(tenantId, type, catalog, heuristic, null, coverage, generation);
  if (outcome === "stale") return { ok: false, discovery_error: SOURCE_CHANGED_DISCOVERY };
  if (outcome === "kept_last_good") return { ok: false, discovery_error: RESCAN_KEPT_LAST_GOOD, kept_last_good: true };

  const remaining = deadline - Date.now();
  if (remaining > 1500) {
    const refined = await refineHintsWithHaiku(catalog, heuristic, remaining - 500, tenantId);
    if (refined !== heuristic && (await applyScan(tenantId, type, catalog, refined, null, coverage, generation)) === "stale") {
      return { ok: false, discovery_error: SOURCE_CHANGED_DISCOVERY };
    }
  }

  const entities = Object.keys(heuristic).filter((k) => k !== "_confidence");
  return { ok: true, tables_found: catalog.tables.length, entities_inferred: entities };
}

export async function persistDiscoveryError(tenantId: string, type: OperatorDbType, e: unknown, generation: number): Promise<DiscoverResult> {
  const safe = sanitizeDiscoveryError(e);
  try {
    const outcome = await applyScan(tenantId, type, {}, {}, safe, {}, generation);
    if (outcome === "stale") return { ok: false, discovery_error: SOURCE_CHANGED_DISCOVERY };
    if (outcome === "kept_last_good") return { ok: false, discovery_error: safe, kept_last_good: true };
  } catch (err) {
    console.warn(`[operator-db] discovery failure record FAILED for tenant=${tenantId}: ${(err as Error).message}`);
  }
  return { ok: false, discovery_error: safe };
}

export { DEFAULT_CAP_MS };
