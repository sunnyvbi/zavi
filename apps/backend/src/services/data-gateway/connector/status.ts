import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ConnectorRulesSummary } from "@zavi/shared/db-guard";

export const OFFLINE_AFTER_MS = 30_000;

export type ConnectorRow = {
  id: string;
  machine_name: string | null;
  version: string | null;
  dialect: "postgres" | "mysql" | "mongodb" | null;
  rules: ConnectorRulesSummary | null;
  last_seen_at: string | null;
  last_skipped_feature: string | null;
  last_skipped_at: string | null;
  offline_notified_at: string | null;
  pair_code_id: string | null;
  created_at: string;
};

const COLUMNS =
  "id, machine_name, version, dialect, rules, last_seen_at, last_skipped_feature, last_skipped_at, offline_notified_at, pair_code_id, created_at";

export async function readActiveConnector(tenant_id: string): Promise<ConnectorRow | null> {
  const { data, error } = (await tenantClient(asTenantId(tenant_id))
    .from("db_connectors")
    .select(COLUMNS)
    .is("revoked_at", null)
    .maybeSingle()) as { data: (Omit<ConnectorRow, "rules"> & { rules: unknown }) | null; error: { message?: string } | null };
  if (error) throw new Error("db_connectors read failed");
  if (!data) return null;
  const rules = ConnectorRulesSummary.safeParse(data.rules);
  return { ...data, rules: rules.success ? rules.data : null };
}

export function isOnline(row: Pick<ConnectorRow, "last_seen_at">, now = Date.now()): boolean {
  if (!row.last_seen_at) return false;
  const t = Date.parse(row.last_seen_at);
  return Number.isFinite(t) && now - t <= OFFLINE_AFTER_MS;
}

export function ageText(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "1 minute" : `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? "1 hour" : `${h} hours`;
  const d = Math.round(h / 24);
  return `${d} days`;
}
