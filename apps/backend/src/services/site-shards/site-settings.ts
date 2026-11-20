
import { siteShardRpc } from "@/services/tenant-client";
import { syncHostRecord, type HostSyncDeps } from "@/services/sites/host-record";
import type { ShardSql } from "./contract";
import type { ShardRegistry } from "./registry";
import { intLit, isUuid, uuidLit } from "./sql";

export const QUOTA_KEYS = ["max_records", "max_bytes", "max_writes_per_min", "recipient_creates_per_min"] as const;
export type QuotaKey = (typeof QUOTA_KEYS)[number];

export type SiteBackendSettings = {
  site_id: string;
  tenant_id: string;
  max_records: number | null;
  max_bytes: number | null;
  max_writes_per_min: number | null;
  recipient_creates_per_min: number | null;
  turnstile_enabled: boolean | null;
  turnstile_site_key: string | null;
  turnstile_secret_set: boolean;
  updated_at?: string;
};

export type SettingsPatch = Partial<Record<QuotaKey, number | null>> & {
  turnstile_enabled?: boolean | null;
  turnstile_site_key?: string | null;
};

export const PLATFORM_DEFAULTS = {
  max_records: 10_000,
  max_bytes: 52_428_800,
  max_writes_per_min: 600,
  recipient_creates_per_min: 30,
  turnstile_enabled: true,
  turnstile_site_key: null as string | null,
} as const;

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };
export type SettingsRpc = (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;

const defaultRpc: SettingsRpc = (name, args) => siteShardRpc(name, args) as unknown as PromiseLike<RpcResult>;

export class SiteSettingsError extends Error {
  constructor(public readonly code: "not_found" | "invalid" | "unavailable", msg: string) {
    super(msg);
    this.name = "SiteSettingsError";
  }
}

async function call(rpc: SettingsRpc, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await rpc(name, args);
  if (error) {
    if (error.code === "P0002") throw new SiteSettingsError("not_found", "site not found");
    if (error.code === "22023" || error.code === "22P02" || error.code === "23514") throw new SiteSettingsError("invalid", error.message ?? "invalid settings");
    throw new Error(`site settings: ${name} failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown"}`);
  }
  return Array.isArray(data) ? data[0] : data;
}

export async function getSiteBackendSettings(site_id: string, rpc: SettingsRpc = defaultRpc): Promise<SiteBackendSettings | null> {
  if (!isUuid(site_id)) throw new SiteSettingsError("invalid", "site_id must be a uuid");
  const r = (await call(rpc, "site_backend_settings_get", { p_site_id: site_id })) as SiteBackendSettings | null;
  return r && typeof r === "object" && r.site_id ? r : null;
}

export function quotaSql(site_id: string, s: Pick<SiteBackendSettings, QuotaKey> | null, hasRecipientCap: boolean): string {
  const v = (k: QuotaKey) => (s && s[k] != null ? intLit(Number(s[k])) : "default");
  const sets = [`max_records = ${v("max_records")}`, `max_bytes = ${v("max_bytes")}`, `max_writes_per_min = ${v("max_writes_per_min")}`];
  if (hasRecipientCap) sets.push(`max_recipient_creates_per_min = ${v("recipient_creates_per_min")}`);
  return `update zsite.quotas set ${sets.join(", ")} where site_id = ${uuidLit(site_id)} returning site_id`;
}

export async function applyQuotaOverrides(
  sql: ShardSql,
  ref: string,
  site_id: string,
  s: Pick<SiteBackendSettings, QuotaKey> | null,
): Promise<{ applied: boolean; recipient_cap: boolean }> {
  const col = (await sql.query(
    ref,
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'zsite' and table_name = 'quotas' and column_name = 'max_recipient_creates_per_min'`,
  )) as Array<{ n?: number }>;
  const hasRecipientCap = Number(col[0]?.n ?? 0) > 0;
  const rows = (await sql.query(ref, quotaSql(site_id, s, hasRecipientCap))) as unknown[];
  return { applied: rows.length > 0, recipient_cap: hasRecipientCap };
}

export type SetSettingsDeps = {
  rpc?: SettingsRpc;
  registry: Pick<ShardRegistry, "get">;
  sql: ShardSql;
  host: HostSyncDeps;
};

export async function setSiteBackendSettings(
  deps: SetSettingsDeps,
  input: {
    site_id: string;
    actor: { user_id: string; email: string };
    patch: SettingsPatch;
    turnstile_secret?: string | null;
    clear_turnstile_secret?: boolean;
  },
): Promise<{ settings: SiteBackendSettings; shard: { applied: boolean; recipient_cap: boolean } | null; host_version: number }> {
  if (!isUuid(input.site_id) || !isUuid(input.actor.user_id)) throw new SiteSettingsError("invalid", "site_id and actor must be uuids");
  const r = (await call(deps.rpc ?? defaultRpc, "site_backend_settings_set", {
    p_site_id: input.site_id,
    p_actor_user_id: input.actor.user_id,
    p_actor_email: input.actor.email,
    p_patch: input.patch,
    p_turnstile_secret: input.turnstile_secret ?? null,
    p_clear_secret: input.clear_turnstile_secret === true,
  })) as (SiteBackendSettings & { shard_id: string | null; host_version: number }) | null;
  if (!r?.site_id || r.site_id !== input.site_id) throw new Error("site settings: the RPC returned another site");
  let shard: { applied: boolean; recipient_cap: boolean } | null = null;
  if (r.shard_id) {
    const row = await deps.registry.get(r.shard_id);
    if (!row?.project_ref) throw new SiteSettingsError("unavailable", "the site's shard is not reachable");
    shard = await applyQuotaOverrides(deps.sql, row.project_ref, input.site_id, r);
  }
  const host_version = await syncHostRecord(deps.host, { tenant_id: r.tenant_id, site_id: input.site_id });
  const { shard_id: _s, host_version: _h, ...settings } = r as SiteBackendSettings & { shard_id?: unknown; host_version?: unknown; changes?: unknown };
  delete (settings as { changes?: unknown }).changes;
  return { settings, shard, host_version };
}

export async function siteTurnstileSecret(site_id: string, rpc: SettingsRpc = defaultRpc): Promise<string | null> {
  if (!isUuid(site_id)) return null;
  const v = await call(rpc, "site_backend_turnstile_secret", { p_site_id: site_id });
  return typeof v === "string" && v ? v : null;
}
