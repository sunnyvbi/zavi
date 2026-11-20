
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { SITE_POINTER_TERMINAL, type SiteRow } from "./contract";

export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

export type GatewayBindingRow = NonNullable<SiteRow["gateway_binding"]>;

export type HostSyncDeps = {
  kv: KvStore;
  bump: (tenant_id: string, site_id: string, binding?: GatewayBindingRow | null, generation?: number) => Promise<SiteRow>;
  get: (tenant_id: string, site_id: string) => Promise<SiteRow | null>;
  requestVerify?: (tenant_id: string, site_id: string, version: number) => Promise<void>;
};

export const HOST_TOMBSTONE_TTL_SECONDS = 7 * 24 * 3600;
const DEPLOY_ID_RE = /^d[0-9a-z]{9}-[0-9a-f]{8}$/;
const VOLATILE = new Set(["published_at", "tombstoned_at"]);

export function hostKey(hostname: string): string {
  const h = String(hostname ?? "").trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,63}$/.test(h)) throw new Error("invalid hostname for a host record");
  return `host:${h}`;
}

export function renderHostRecord(row: SiteRow): { value: Record<string, unknown>; ttl?: number } | null {
  const out: Record<string, unknown> = {};
  const terminal = SITE_POINTER_TERMINAL.has(row.status);
  const deploy = !terminal && !!row.live_deploy_id && DEPLOY_ID_RE.test(row.live_deploy_id) && !!row.live_sha;
  if (deploy) {
    Object.assign(out, { deploy_id: row.live_deploy_id, sha: row.live_sha, tenant_id: row.tenant_id, published_at: row.updated_at, spa: true });
    if (row.search_released_at === null) out.noindex = true;
  }
  const b = row.gateway_binding;
  const status = b ? (terminal ? "tombstoned" : b.status) : null;
  if (b) {
    Object.assign(out, {
      v: 1,
      site_id: row.id,
      shard_id: b.shard_id,
      shard_url: b.shard_url,
      status,
      binding_version: row.host_version ?? 0,
      manifest_hash: b.manifest_hash,
      ...(row.gateway_config?.turnstile ? { turnstile: row.gateway_config.turnstile.enabled !== false } : {}),
      ...(row.gateway_config?.turnstile?.site_key ? { turnstile_site_key: row.gateway_config.turnstile.site_key } : {}),
      ...(status === "tombstoned" ? { tombstoned_at: row.updated_at } : {}),
    });
  }
  if (!Object.keys(out).length) return null;
  out.rv = row.host_version ?? 0;
  return { value: out, ...(status === "tombstoned" && !deploy ? { ttl: HOST_TOMBSTONE_TTL_SECONDS } : {}) };
}

export class HostSyncError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "HostSyncError";
  }
}

function parseRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function kvVersion(rec: Record<string, unknown> | null): number {
  const v = Number(rec?.rv);
  return rec && Number.isSafeInteger(v) ? v : -1;
}

function stable(v: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(v).filter((k) => !VOLATILE.has(k)).sort().map((k) => [k, v[k]]));
}

function same(rec: Record<string, unknown> | null, want: Record<string, unknown> | null): boolean {
  if (!rec || !want) return rec === want;
  return stable(rec) === stable(want);
}

function foreignTo(rec: Record<string, unknown>, row: SiteRow): boolean {
  if (typeof rec.site_id === "string") return rec.site_id !== row.id;
  return typeof rec.tenant_id === "string" && rec.tenant_id !== row.tenant_id;
}

export type HostProjection = {
  outcome: "in_sync" | "written" | "removed" | "gone";
  site: SiteRow | null;
  version: number;
  before: Record<string, unknown> | null;
};

export async function projectHostRecord(
  deps: Pick<HostSyncDeps, "kv" | "get">,
  input: { tenant_id: string; site_id: string },
  maxRounds = 8,
): Promise<HostProjection> {
  let before: Record<string, unknown> | null | undefined;
  let wrote: "written" | "removed" | null = null;
  let ahead = false;
  for (let round = 0; round < maxRounds; round++) {
    const row = await deps.get(input.tenant_id, input.site_id);
    if (!row) return { outcome: "gone", site: null, version: -1, before: before ?? null };
    if (row.tenant_id !== input.tenant_id) throw new HostSyncError("host record: site tenant mismatch");
    const key = hostKey(row.hostname);
    const latest = row.host_version ?? 0;
    const r = renderHostRecord(row);
    const rec = parseRecord(await deps.kv.get(key));
    if (before === undefined) before = rec;
    if (rec && foreignTo(rec, row)) {
      if (!r) return { outcome: wrote ?? "in_sync", site: row, version: latest, before };
      throw new HostSyncError("host record: the hostname holds another site's record");
    }
    if (same(rec, r?.value ?? null)) {
      return { outcome: wrote ?? "in_sync", site: row, version: latest, before };
    }
    ahead = kvVersion(rec) > latest;
    if (ahead) continue;
    if (r) {
      await deps.kv.put(key, JSON.stringify(r.value), r.ttl ? { expirationTtl: r.ttl } : undefined);
      wrote = "written";
    } else {
      if (!deps.kv.delete) throw new HostSyncError("host record: this KV store cannot remove a record");
      await deps.kv.delete(key);
      wrote = "removed";
    }
  }
  throw new HostSyncError(ahead ? "host record: KV is ahead of the database" : "host record did not converge");
}

export async function syncHostRecord(
  deps: HostSyncDeps,
  input: { tenant_id: string; site_id: string; binding?: GatewayBindingRow | null; generation?: number },
  maxRounds = 8,
): Promise<number> {
  const bumped = await deps.bump(input.tenant_id, input.site_id, input.binding, input.generation);
  if (bumped.tenant_id !== input.tenant_id) throw new HostSyncError("host record: site tenant mismatch");
  hostKey(bumped.hostname);
  let p: HostProjection;
  try {
    p = await projectHostRecord(deps, input, maxRounds);
  } catch (e) {
    await deps.requestVerify?.(input.tenant_id, input.site_id, bumped.host_version ?? 0).catch(() => undefined);
    throw e;
  }
  if (p.outcome === "gone") throw new HostSyncError("host record: site is gone");
  await deps.requestVerify?.(input.tenant_id, input.site_id, p.version).catch((e: unknown) => {
    console.warn(`[host-record] verify request failed for site ${input.site_id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  });
  return p.version;
}

export async function requestHostVerify(tenant_id: string, site_id: string, version: number): Promise<void> {
  const m = await import("@/../workers/functions/site-reconcile");
  if (!m.sitePointerSweepAllowed()) return;
  await m.requestSiteVerify({ tenant_id, site_id, version });
}

export async function bumpHostVersion(tenant_id: string, site_id: string, binding?: GatewayBindingRow | null, generation?: number): Promise<SiteRow> {
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "site_host_bump", {
    p_site_id: site_id,
    p_set_binding: binding !== undefined,
    p_binding: binding ?? null,
    ...(typeof generation === "number" ? { p_generation: generation } : {}),
  });
  if (error) throw new HostSyncError(`site_host_bump failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown"}`);
  const row = (Array.isArray(data) ? data[0] : data) as SiteRow | null;
  if (!row?.id || row.tenant_id !== tenant_id) throw new HostSyncError("site_host_bump returned no row");
  return row;
}
