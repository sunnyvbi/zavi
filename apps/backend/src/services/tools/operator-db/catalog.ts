
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type {
  OperatorDbType,
  OperatorDbCatalog,
  DiscoveryCoverage,
  EntityHints,
  SchemaMap,
} from "./types";

export type ResolvedCatalog = {
  dialect: OperatorDbType;
  catalog: OperatorDbCatalog;
  hints: EntityHints;
  catalog_hash: string | null;
  coverage: DiscoveryCoverage | null;
  discovery_error: string | null;
  updated_at: string | null;
  discovered_at?: string | null;
  rescan_error?: string | null;
  rescan_failed_at?: string | null;
};

type CatalogRow = {
  dialect: unknown;
  catalog: unknown;
  hints: unknown;
  catalog_hash: unknown;
  coverage: unknown;
  discovery_error: unknown;
  updated_at: unknown;
  discovered_at: unknown;
  rescan_error: unknown;
  rescan_failed_at: unknown;
  source_epoch: unknown;
};

function parseCoverage(v: unknown): DiscoveryCoverage | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  if (typeof c.tables_total !== "number" || typeof c.tables_indexed !== "number") return null;
  return {
    tables_total: c.tables_total,
    tables_indexed: c.tables_indexed,
    skipped_unsafe_names: typeof c.skipped_unsafe_names === "number" ? c.skipped_unsafe_names : 0,
    deadline_hit: c.deadline_hit === true,
    listing_truncated: c.listing_truncated === true,
  };
}

type DeclaredDialectRow = { type: unknown };

export async function getCatalog(tenantId: string): Promise<ResolvedCatalog | null> {
  const client = tenantClient(asTenantId(tenantId));
  const [{ data, error }, epoch] = await Promise.all([
    client
      .from("tenant_db_catalog")
      .select("dialect, catalog, hints, catalog_hash, coverage, discovery_error, updated_at, discovered_at, rescan_error, rescan_failed_at, source_epoch")
      .maybeSingle() as unknown as Promise<{ data: CatalogRow | null; error: { message?: string } | null }>,
    client.from("tenant_db_generation").select("source_epoch").maybeSingle() as unknown as Promise<{
      data: { source_epoch?: number | string | null } | null;
      error: { message?: string } | null;
    }>,
  ]);
  if (error || !data || epoch.error) return null;
  if (Number(data.source_epoch ?? 0) !== Number(epoch.data?.source_epoch ?? 0)) return null;
  return {
    dialect: data.dialect as OperatorDbType,
    catalog: (data.catalog as OperatorDbCatalog) ?? { tables: [] },
    hints: (data.hints as EntityHints) ?? {},
    catalog_hash: (data.catalog_hash as string | null) ?? null,
    coverage: parseCoverage(data.coverage),
    discovery_error: (data.discovery_error as string | null) ?? null,
    updated_at: (data.updated_at as string | null) ?? null,
    discovered_at: (data.discovered_at as string | null) ?? null,
    rescan_error: (data.rescan_error as string | null) ?? null,
    rescan_failed_at: (data.rescan_failed_at as string | null) ?? null,
  };
}

export async function getDeclaredDialect(tenantId: string): Promise<OperatorDbType | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("tenant_db_config")
    .select("type")
    .maybeSingle() as { data: DeclaredDialectRow | null; error: { message?: string } | null };
  if (error || !data) return null;
  return (data.type as OperatorDbType) ?? null;
}

export function allowedCollectionsFromCatalog(
  catalog: OperatorDbCatalog,
): Set<string> {
  const out = new Set<string>();
  for (const t of catalog.tables ?? []) {
    if (typeof t.name === "string" && t.name.length > 0) {
      out.add(t.name.toLowerCase());
    }
  }
  return out;
}

export function renderCatalogDigest(
  catalog: OperatorDbCatalog,
  opts?: { only?: readonly string[] },
): string {
  const all = catalog.tables ?? [];
  if (!all.length) return "(operator DB schema not yet discovered)";
  const only = opts?.only;
  const tables = only ? all.filter((t) => only.includes(t.name)) : all;
  if (!tables.length) return "(no matching tables)";
  return tables
    .map((t) => {
      const cols = t.columns
        .map((c) => `${c.name}:${c.type}${c.nullable ? "?" : ""}`)
        .join(", ");
      const est = t.rowEstimate == null ? "" : ` ~${t.rowEstimate} rows`;
      return `- ${t.name}${est}\n    ${cols}`;
    })
    .join("\n");
}

export function renderCatalogIndex(
  catalog: OperatorDbCatalog,
): Array<{ name: string; rows?: number }> {
  return (catalog.tables ?? []).map((t) =>
    t.rowEstimate == null ? { name: t.name } : { name: t.name, rows: t.rowEstimate },
  );
}

function s(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function hintsToSchemaMapShape(hints: EntityHints): SchemaMap {
  const m = {} as SchemaMap;
  const uTable = s(hints.users?.table);
  const uId = s(hints.users?.id_field);
  m.users = uTable && uId ? { table: uTable, id_field: uId } : { table: "", id_field: "" };

  const lTable = s(hints.listings?.table);
  if (lTable) m.listings = { table: lTable, id_field: s(hints.listings?.id_field) ?? "id" };

  const tTable = s(hints.transactions?.table);
  if (tTable) m.transactions = { table: tTable, id_field: "id" };

  const bTable = s(hints.bookings?.table);
  if (bTable) {
    m.bookings = {
      table: bTable,
      id_field: "id",
      geo_field: s(hints.bookings?.geo_field) ?? "",
      category_field: s(hints.bookings?.category_field) ?? "",
      created_at_field: s(hints.bookings?.created_at_field) ?? "",
      gmv_proxy_field: s(hints.bookings?.gmv_proxy_field),
      listing_ref_field: s(hints.bookings?.listing_ref_field),
    };
  }
  return m;
}
