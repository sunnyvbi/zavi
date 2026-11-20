import { apiFetch } from "@/lib/api";

export type DbType = "postgres" | "mongodb" | "mysql" | "dynamodb";
export type ReadOnlyCheck = "verified" | "can_write" | "unknown";
export type DiscoveryState = "pending" | "ready" | "failed";

export type DbSetup =
  | { connected: false }
  | {
      connected: true;
      mode: "direct" | "connector";
      dialect: DbType | null;
      legacy: boolean;
      managed_by: string | null;
      discovery: DiscoveryState;
      settings_confirmed: boolean;
      transport?: Transport | null;
    };

export type Transport = "verified_tls" | "unverified_tls" | "plaintext";

export type DbVisibility = {
  dialect: DbType;
  catalog_hash: string | null;
  discovery: DiscoveryState;
  settings_confirmed: boolean;
  read_only: ReadOnlyCheck | null;
  tables: Array<{ name: string; rows: number | null; view_of: string | null; enabled: boolean; columns: string[] }>;
  sensitive: Array<{ table: string; field: string; kind: string; hidden: boolean }>;
  removed_by_view: string[];
  hidden_fields: string[];
  transport?: Transport | null;
  last_rescan_failed_at?: string | null;
  last_good_scan_at?: string | null;
};

export type DbPrivacy = {
  raw_results_retention: "run" | "7" | "30" | null;
  chat_retention: "forever" | "90" | "30" | null;
  providers: Array<{ name: string; line: string }>;
};

export type ConnectResult = {
  ok?: boolean;
  type?: string;
  read_only_check?: ReadOnlyCheck;
  write_capable?: "true" | "false" | "unknown";
  discovery?: string;
  discovery_error?: string;
  error?: { code?: string; message?: string };
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new ApiError(body.error?.message ?? `HTTP ${res.status}`, res.status);
  return body;
}

const BASE = "/api/connectors/operator-db";

export const getSetup = () => call<DbSetup>(`${BASE}/setup`);
export const getVisibility = (check: boolean) => call<DbVisibility>(`${BASE}/visibility${check ? "?check=1" : ""}`);
export const putVisibility = (body: { catalog_hash: string; disabled_tables: string[]; hidden_fields: string[]; unhidden_fields: string[] }) =>
  call<{ ok: true }>(`${BASE}/visibility`, { method: "PUT", body: JSON.stringify(body) });
export const getPrivacy = () => call<DbPrivacy>(`${BASE}/privacy`);
export const putPrivacy = (body: { raw_results_retention: string; chat_retention: string }) =>
  call<{ ok: true }>(`${BASE}/privacy`, { method: "PUT", body: JSON.stringify(body) });
export const disconnectDb = () => call<{ ok: true; dialect: string | null; revoke_command: string }>(`${BASE}/disconnect`, { method: "POST" });
export const requestAccess = () =>
  call<{ ok: true; sent: boolean; already_requested: boolean }>("/api/workspace/database/request-access", { method: "POST" });

export async function connectDb(type: DbType, connection_string: string): Promise<ConnectResult> {
  const res = await apiFetch(BASE, { method: "POST", body: JSON.stringify({ type, connection_string }) });
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    return {};
  }
  const body = (await res.json().catch(() => ({}))) as ConnectResult;
  if (res.status >= 400 || (body.error && !body.discovery_error)) {
    throw new ApiError(body.error?.message ?? `HTTP ${res.status}`, res.status);
  }
  return body;
}

export type ConnectorRules = {
  allowed_tables: string[];
  blocked_fields: string[];
  what_can_leave: "totals_and_counts_only" | "rows_without_blocked_columns";
  max_rows: number;
};

export type ConnectorStatus =
  | { paired: false }
  | {
      paired: true;
      online: boolean;
      machine: string | null;
      version: string | null;
      dialect: "postgres" | "mysql" | "mongodb" | null;
      last_seen_at: string | null;
      last_seen_age: string | null;
      paired_at: string;
      pairing_id: string | null;
      rules?: ConnectorRules | null;
      skipped?: { feature: string; at: string; emailed: boolean } | null;
    };

export type PairCode = { code: string; pairing_id: string; issued_at: string; expires_at: string; expires_in_seconds: number; command: string };

export const getConnector = () => call<ConnectorStatus>(`${BASE}/connector`);
export const createPairCode = () => call<PairCode>(`${BASE}/connector/pair-code`, { method: "POST" });
export const removeConnector = () =>
  call<{ ok: true; removed: boolean; machine: string | null; removal_command: string }>(`${BASE}/connector/remove`, { method: "POST" });
