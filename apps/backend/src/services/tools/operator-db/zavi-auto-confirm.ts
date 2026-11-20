
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { getBoolSettingStrictResolved } from "@/services/settings";
import { getCatalog, type ResolvedCatalog } from "./catalog";
import type { CanonicalMap, CanonicalMapEntry } from "./mapping";
import type { CatalogTable, OperatorDbCatalog } from "./types";
import {
  readMetricsDeclaration,
  type DeclaredTable,
  type MetricsDeclaration,
} from "@/services/provisioning/metrics-declaration";

export const ZAVI_BUILD_SOURCE = "zavi-build" as const;

function isTimestamp(type: string): boolean {
  return /^timestamp/i.test(type.trim());
}

function findTable(catalog: OperatorDbCatalog, name: string): CatalogTable | null {
  const hits = (catalog.tables ?? []).filter((t) => t.name === name);
  return hits.length === 1 ? hits[0] : null;
}

function checked(catalog: OperatorDbCatalog, d: DeclaredTable | null | undefined): CatalogTable | null {
  if (!d) return null;
  const t = findTable(catalog, d.table);
  const col = t?.columns.find((c) => c.name === d.created_at);
  return t && col && isTimestamp(col.type) ? t : null;
}

function entry(t: CatalogTable, created_at: string, label: string): CanonicalMapEntry {
  const e: Record<string, string> = { table: t.name, label, created_at_field: created_at, source: ZAVI_BUILD_SOURCE };
  if (t.columns.some((c) => c.name === "id")) e.id_field = "id";
  return e as unknown as CanonicalMapEntry;
}

export function strictZaviMapping(
  catalog: OperatorDbCatalog,
  declaration: MetricsDeclaration | null,
): CanonicalMap {
  const map: CanonicalMap = {};

  const declaredUsers = checked(catalog, declaration?.signups);
  if (declaredUsers) {
    map.users = entry(declaredUsers, declaration!.signups!.created_at, "Users / accounts");
  } else if (!declaration?.signups) {
    const tmpl = checked(catalog, { table: "users", created_at: "created_at" });
    if (tmpl) map.users = entry(tmpl, "created_at", "Users / accounts");
  }

  const event = checked(catalog, declaration?.business_event);
  if (event) {
    map.bookings = entry(event, declaration!.business_event!.created_at, "Bookings / orders / trips");
  }

  return map;
}

export type AutoConfirmOutcome =
  | "confirmed"
  | "not_managed"
  | "disabled"
  | "no_catalog"
  | "nothing_unambiguous"
  | "refused";

export type AutoConfirmDeps = {
  isEnabled: (tenant_id: string) => Promise<boolean>;
  readManagedBy: (tenant_id: string) => Promise<string | null>;
  getCatalog: (tenant_id: string) => Promise<ResolvedCatalog | null>;
  readDeclaration: (tenant_id: string) => Promise<MetricsDeclaration | null>;
  confirm: (tenant_id: string, catalog_hash: string, map: CanonicalMap) => Promise<boolean>;
};

export const FLAG_KEY = "built_app_operator_db_enabled";

export const realAutoConfirmDeps: AutoConfirmDeps = {
  isEnabled: (tenant_id) => getBoolSettingStrictResolved(FLAG_KEY, tenant_id),
  async readManagedBy(tenant_id) {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("connector_metadata")
      .select("managed_by")
      .eq("slug", "operator_db")
      .maybeSingle<{ managed_by: string | null }>();
    if (error) throw new Error(`connector_metadata read failed: ${error.message}`);
    return data?.managed_by ?? null;
  },
  getCatalog: (tenant_id) => getCatalog(tenant_id),
  readDeclaration: (tenant_id) => readMetricsDeclaration(tenant_id),
  async confirm(tenant_id, catalog_hash, map) {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "set_mapping_confirmed_by_zavi", {
      p_catalog_hash: catalog_hash,
      p_confirmed_map: map,
    });
    if (error) throw new Error(`set_mapping_confirmed_by_zavi failed: ${error.code ?? error.message}`);
    return data === true;
  },
};

export async function autoConfirmManagedMapping(
  tenant_id: string,
  deps: AutoConfirmDeps = realAutoConfirmDeps,
): Promise<AutoConfirmOutcome> {
  if ((await deps.readManagedBy(tenant_id)) !== "zavi") return "not_managed";
  if (!(await deps.isEnabled(tenant_id))) return "disabled";
  const catalog = await deps.getCatalog(tenant_id);
  if (!catalog || !catalog.catalog_hash || catalog.discovery_error) return "no_catalog";
  const map = strictZaviMapping(catalog.catalog, await deps.readDeclaration(tenant_id));
  if (Object.keys(map).length === 0) return "nothing_unambiguous";
  return (await deps.confirm(tenant_id, catalog.catalog_hash, map)) ? "confirmed" : "refused";
}
