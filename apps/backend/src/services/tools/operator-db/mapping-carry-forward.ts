
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { getCatalog, type ResolvedCatalog } from "./catalog";
import type { OperatorDbCatalog } from "./types";

const DATE_FIELDS = new Set(["created_at_field", "listed_at_field"]);

export function isStrictlyDateTyped(type: unknown): boolean {
  if (typeof type !== "string") return false;
  const parts = type.split("|").map((p) => p.trim()).filter((p) => p !== "" && p !== "Null");
  return parts.length === 1 && /^(date|datetime|timestamp|timestamptz)([^a-z]|$)/i.test(parts[0]);
}

export type FitResult = { ok: true } | { ok: false; reason: string };

export function mapStillFits(catalog: OperatorDbCatalog, map: unknown): FitResult {
  if (!map || typeof map !== "object" || Array.isArray(map)) return { ok: false, reason: "not_a_map" };
  const tables = catalog.tables ?? [];
  let roles = 0;
  for (const [role, raw] of Object.entries(map as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (!("table" in entry)) continue;
    if (typeof entry.table !== "string" || entry.table.trim() === "") return { ok: false, reason: `${role}: no table` };
    const hits = tables.filter((t) => t.name === entry.table);
    if (hits.length !== 1) return { ok: false, reason: `${role}: table ${hits.length === 0 ? "gone" : "ambiguous"}` };
    const cols = new Map(hits[0].columns.map((c) => [c.name, c]));
    for (const [key, value] of Object.entries(entry)) {
      if (key !== "field" && !key.endsWith("_field")) continue;
      if (typeof value !== "string" || value.trim() === "") continue;
      const col = cols.get(value);
      if (!col) return { ok: false, reason: `${role}.${key}: column gone` };
      if (DATE_FIELDS.has(key) && !isStrictlyDateTyped(col.type)) return { ok: false, reason: `${role}.${key}: no longer a date` };
    }
    roles += 1;
  }
  return roles > 0 ? { ok: true } : { ok: false, reason: "no_tables" };
}

export type CarryForwardOutcome =
  | "carried"
  | "already_confirmed"
  | "no_catalog"
  | "no_prior"
  | "schema_changed"
  | "refused";

type ConfirmationRow = { catalog_hash: string; confirmed_map: unknown; confirmed_at: string; confirmed_by: string | null };

export type CarryForwardDeps = {
  getCatalog: (tenant_id: string) => Promise<ResolvedCatalog | null>;
  readConfirmations: (tenant_id: string) => Promise<ConfirmationRow[]>;
  carry: (tenant_id: string, catalog_hash: string) => Promise<boolean>;
};

export const realCarryForwardDeps: CarryForwardDeps = {
  getCatalog: (tenant_id) => getCatalog(tenant_id),
  async readConfirmations(tenant_id) {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("mapping_confirmed")
      .select("catalog_hash, confirmed_map, confirmed_at, confirmed_by")
      .order("confirmed_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(`mapping_confirmed read failed: ${error.message}`);
    return (data ?? []) as ConfirmationRow[];
  },
  async carry(tenant_id, catalog_hash) {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "carry_forward_mapping_confirmation", {
      p_catalog_hash: catalog_hash,
    });
    if (error) throw new Error(`carry_forward_mapping_confirmation failed: ${error.code ?? error.message}`);
    return data === true;
  },
};

export async function carryForwardConfirmedMapping(
  tenant_id: string,
  deps: CarryForwardDeps = realCarryForwardDeps,
): Promise<CarryForwardOutcome> {
  const current = await deps.getCatalog(tenant_id);
  if (!current?.catalog_hash || current.discovery_error || (current.catalog.tables?.length ?? 0) === 0) return "no_catalog";
  const rows = await deps.readConfirmations(tenant_id);
  if (rows.some((r) => r.catalog_hash === current.catalog_hash)) return "already_confirmed";
  const prior = rows
    .filter((r) => r.catalog_hash !== current.catalog_hash && r.confirmed_by)
    .sort((a, b) => Date.parse(b.confirmed_at) - Date.parse(a.confirmed_at))[0];
  if (!prior) return "no_prior";
  if (!mapStillFits(current.catalog, prior.confirmed_map).ok) return "schema_changed";
  return (await deps.carry(tenant_id, current.catalog_hash)) ? "carried" : "refused";
}
