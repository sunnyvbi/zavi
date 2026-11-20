import type { Transport } from "./direct/tls";
import { isSensitiveColumn, sensitiveColumnKind } from "@zavi/shared/db-guard";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { getCatalog, type ResolvedCatalog } from "@/services/tools/operator-db/catalog";
import type { OperatorDbType } from "@/services/tools/operator-db/types";
import { readDbConfig } from "./resolve";
import { readActiveConnector } from "./connector/status";

export type DiscoveryState = "pending" | "ready" | "failed";

export type DbSetup =
  | { connected: false }
  | {
      connected: true;
      mode: "direct" | "connector";
      dialect: OperatorDbType | null;
      legacy: boolean;
      managed_by: string | null;
      discovery: DiscoveryState;
      settings_confirmed: boolean;
      transport: Transport | null;
    };

export type DbVisibility = {
  dialect: OperatorDbType;
  catalog_hash: string | null;
  discovery: DiscoveryState;
  settings_confirmed: boolean;
  tables: Array<{ name: string; rows: number | null; view_of: string | null; enabled: boolean; columns: string[] }>;
  sensitive: Array<{ table: string; field: string; kind: string; hidden: boolean }>;
  removed_by_view: string[];
  hidden_fields: string[];
  transport: Transport | null;
  last_rescan_failed_at: string | null;
  last_good_scan_at: string | null;
};

export type VisibilityInput = { disabled_tables: string[]; hidden_fields: string[]; unhidden_fields: string[] };

export function discoveryState(cat: ResolvedCatalog | null): DiscoveryState {
  if (!cat) return "pending";
  if (cat.discovery_error) return "failed";
  return cat.catalog.tables.length > 0 ? "ready" : "pending";
}

export async function readDbSetup(tenant_id: string): Promise<DbSetup> {
  const row = await readDbConfig(tenant_id);
  if (!row) {
    const connector = await readActiveConnector(tenant_id);
    if (!connector) return { connected: false };
    return { connected: true, mode: "connector", dialect: null, legacy: false, managed_by: null, discovery: "pending", settings_confirmed: false, transport: null };
  }
  const cat = await getCatalog(tenant_id);
  const { data: meta } = (await tenantClient(asTenantId(tenant_id))
    .from("connector_metadata")
    .select("managed_by")
    .eq("slug", "operator_db")
    .maybeSingle()) as { data: { managed_by: string | null } | null };
  const managed_by = meta?.managed_by ?? null;
  return {
    connected: true,
    mode: row.mode === "connector" ? "connector" : "direct",
    dialect: (cat?.dialect ?? row.type) as OperatorDbType,
    legacy: !row.auto_hide && !row.settings_confirmed_at && managed_by !== "zavi",
    managed_by,
    discovery: discoveryState(cat),
    settings_confirmed: Boolean(row.settings_confirmed_at),
    transport: directTransport(row),
  };
}

const TRANSPORTS = new Set<Transport>(["verified_tls", "unverified_tls", "plaintext"]);
function directTransport(row: { mode: string | null; transport?: string | null }): Transport | null {
  if (row.mode === "connector") return null;
  return row.transport && TRANSPORTS.has(row.transport as Transport) ? (row.transport as Transport) : null;
}

export async function readDbVisibility(tenant_id: string): Promise<DbVisibility | null> {
  const row = await readDbConfig(tenant_id);
  if (!row) return null;
  const cat = await getCatalog(tenant_id);
  const dialect = (cat?.dialect ?? row.type) as OperatorDbType;
  const base = {
    dialect,
    catalog_hash: cat?.catalog_hash ?? null,
    discovery: discoveryState(cat),
    settings_confirmed: Boolean(row.settings_confirmed_at),
    hidden_fields: row.hidden_fields ?? [],
    transport: directTransport(row),
    last_rescan_failed_at: cat?.rescan_failed_at ?? null,
    last_good_scan_at: cat?.rescan_failed_at ? (cat.discovered_at ?? null) : null,
  };
  if (!cat || base.discovery !== "ready") return { ...base, tables: [], sensitive: [], removed_by_view: [] };

  const disabled = new Set((row.disabled_tables ?? []).map((t) => t.trim().toLowerCase()));
  const unhiddenValid = Boolean(row.policy_catalog_hash) && row.policy_catalog_hash === cat.catalog_hash;
  const unhidden = new Set(unhiddenValid ? (row.unhidden_fields ?? []) : []);
  const explicitHidden = new Set((row.hidden_fields ?? []).map((e) => e.trim().toLowerCase()));

  const tables: DbVisibility["tables"] = [];
  const sensitive: DbVisibility["sensitive"] = [];
  const removed_by_view: string[] = [];
  for (const t of cat.catalog.tables) {
    tables.push({
      name: t.name,
      rows: t.rowEstimate ?? null,
      view_of: t.view_of ?? null,
      enabled: !t.view_of && !disabled.has(t.name.toLowerCase()),
      columns: t.columns.map((c) => c.name),
    });
    if (t.view_of) {
      for (const f of t.removed_fields ?? []) removed_by_view.push(`${t.view_of}.${f}`);
      continue;
    }
    for (const c of t.columns) {
      const key = `${t.name}.${c.name}`;
      if (!isSensitiveColumn(t.name, c) && !explicitHidden.has(key.toLowerCase())) continue;
      sensitive.push({ table: t.name, field: c.name, kind: sensitiveColumnKind(t.name, c), hidden: !unhidden.has(key) });
    }
  }
  return { ...base, tables, sensitive, removed_by_view };
}

export function checkVisibilityNames(cat: ResolvedCatalog, input: VisibilityInput): string | null {
  const byName = new Map(cat.catalog.tables.map((t) => [t.name, t]));
  for (const t of input.disabled_tables) if (!byName.has(t)) return t;
  for (const entry of [...input.hidden_fields, ...input.unhidden_fields]) {
    let ok = false;
    for (const t of cat.catalog.tables) {
      if (!entry.startsWith(`${t.name}.`)) continue;
      const field = entry.slice(t.name.length + 1);
      if (t.columns.some((c) => c.name === field)) {
        ok = true;
        break;
      }
    }
    if (!ok) return entry;
  }
  return null;
}

export type RawResultsRetention = "run" | "7" | "30";
export type ChatRetention = "forever" | "90" | "30";
export type DbRetention = {
  exists: boolean;
  raw_results_retention: RawResultsRetention | null;
  chat_retention: ChatRetention | null;
};

export async function readDbRetention(tenant_id: string): Promise<DbRetention> {
  const { data, error } = (await tenantClient(asTenantId(tenant_id))
    .from("tenant_db_settings")
    .select("raw_results_retention, chat_retention")
    .maybeSingle()) as { data: { raw_results_retention: string | null; chat_retention: string | null } | null; error: { message?: string } | null };
  if (error) throw new Error(`tenant_db_settings read failed: ${error.message ?? "unknown"}`);
  const raw = data?.raw_results_retention;
  const chat = data?.chat_retention;
  return {
    exists: Boolean(data),
    raw_results_retention: raw === "run" || raw === "7" || raw === "30" ? raw : null,
    chat_retention: chat === "forever" || chat === "90" || chat === "30" ? chat : null,
  };
}

export async function rawResultsRetention(tenant_id: string): Promise<RawResultsRetention | null> {
  const r = await readDbRetention(tenant_id);
  if (!r.exists) return "run";
  return r.raw_results_retention;
}

export const MANAGED_DB_LOGIN = "zavi_readonly";

export function revokeCommandFor(dialect: OperatorDbType | string | null | undefined, managedBy?: string | null): string {
  if (managedBy === "zavi") return `DROP OWNED BY ${MANAGED_DB_LOGIN};\nDROP ROLE ${MANAGED_DB_LOGIN};`;
  if (dialect === "mongodb") return '// Use the login name you gave Zavi\ndb.dropUser("zavi_reader")';
  if (dialect === "mysql") return "-- Use the login name you gave Zavi\nDROP USER 'zavi_reader'@'%';";
  if (dialect === "dynamodb") return "In AWS IAM, delete the access key you gave Zavi.";
  return "-- Use the login name you gave Zavi\nDROP OWNED BY zavi_reader;\nDROP ROLE zavi_reader;";
}
