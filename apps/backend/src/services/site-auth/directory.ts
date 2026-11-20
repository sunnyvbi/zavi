
import { sitePublicRpc } from "@/services/tenant-client";
import { createHash } from "node:crypto";
import type { ShardRow } from "@/services/site-shards/contract";
import type { ShardMgmt } from "@/services/site-shards/shard-mgmt";
import { registryAuthConfigResolver, type ShardAuthConfig } from "@/services/site-shards/auth-config";
import { shardEnv, shardRegistry } from "@/services/site-shards/registry";
import { createGoTrue } from "./gotrue";
import { createPgShardStore } from "./store";
import type { ShardHandle, SiteAuthDirectory, SiteRecord } from "./types";

const LIVE = new Set(["live", "building", "publishing", "paused", "waking", "provisioning"]);
export const SHARD_REF_RE = /^[a-z0-9]{20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DirectorySiteRow = {
  id: string;
  hostname: string;
  label: string | null;
  status: string;
  shard_id: string | null;
  backend_mode: string | null;
  kernel_shard_id?: string | null;
  is_test?: boolean | null;
  name?: string | null;
};

export function siteDisplayName(s: Pick<DirectorySiteRow, "name" | "hostname">): string {
  const name = typeof s.name === "string" ? s.name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return name || String(s.hostname).toLowerCase();
}

export interface RegistryDirectoryDeps {
  readSite(siteId: string): Promise<DirectorySiteRow | null>;
  listShards(): Promise<ShardRow[]>;
  resolveConfig(registryId: string): Promise<ShardAuthConfig | null>;
  makeHandle(ref: string, cfg: ShardAuthConfig): ShardHandle;
  now(): number;
  listTtlMs?: number;
  missRefreshMs?: number;
  handleTtlMs?: number;
}

const cfgKey = (c: ShardAuthConfig) =>
  createHash("sha256").update(JSON.stringify([c.url, c.anonKey, c.serviceKey, c.dbUrl, c.hookSecret])).digest("hex");

export function createRegistryDirectory(deps: RegistryDirectoryDeps): SiteAuthDirectory {
  const listTtl = deps.listTtlMs ?? 60_000;
  const missRefresh = deps.missRefreshMs ?? 10_000;
  const handleTtl = deps.handleTtlMs ?? 5 * 60_000;
  let list: { rows: ShardRow[]; at: number } | null = null;
  let lastRefresh = -Infinity;
  const handles = new Map<string, { h: ShardHandle; at: number; key: string }>();

  async function refresh(): Promise<ShardRow[]> {
    lastRefresh = deps.now();
    const rows = await deps.listShards();
    list = { rows, at: deps.now() };
    return rows;
  }
  async function shards(): Promise<ShardRow[]> {
    if (!list || deps.now() - list.at > listTtl) return refresh();
    return list.rows;
  }
  async function find(pred: (r: ShardRow) => boolean): Promise<ShardRow | null> {
    const hit = (await shards()).find(pred);
    if (hit) return hit;
    if (deps.now() - lastRefresh < missRefresh) return null;
    return (await refresh()).find(pred) ?? null;
  }
  const usable = (r: ShardRow | null): r is ShardRow & { project_ref: string; url: string } =>
    !!r && typeof r.project_ref === "string" && SHARD_REF_RE.test(r.project_ref) &&
    r.url === `https://${r.project_ref}.supabase.co` && r.state !== "retired" && r.state !== "provisioning";

  return {
    async site(siteId): Promise<SiteRecord | null> {
      if (typeof siteId !== "string" || !UUID_RE.test(siteId)) return null;
      const s = await deps.readSite(siteId);
      if (!s || s.id !== siteId) return null;
      const rowId = s.backend_mode === "pooled" ? s.shard_id
        : s.backend_mode === "dedicated" ? s.kernel_shard_id ?? null : null;
      if (!rowId) return null;
      const row = await find((r) => r.id === rowId);
      if (!usable(row)) return null;
      return {
        siteId: s.id,
        shardId: row.project_ref,
        hostname: String(s.hostname).toLowerCase(),
        name: siteDisplayName(s),
        active: LIVE.has(String(s.status)),
        ...(s.is_test === true ? { test: true } : {}),
      };
    },
    async shard(ref) {
      if (typeof ref !== "string" || !SHARD_REF_RE.test(ref)) return null;
      const cached = handles.get(ref);
      if (cached && deps.now() - cached.at <= handleTtl) return cached.h;
      const row = await find((r) => r.project_ref === ref);
      if (!usable(row)) {
        handles.delete(ref);
        return null;
      }
      const cfg = await deps.resolveConfig(row.id);
      if (!cfg || cfg.url !== row.url) {
        handles.delete(ref);
        return null;
      }
      const key = cfgKey(cfg);
      const h = cached && cached.key === key ? cached.h : deps.makeHandle(ref, cfg);
      handles.set(ref, { h, at: deps.now(), key });
      return h;
    },
  };
}

export function createDefaultDirectory(): SiteAuthDirectory {
  const registry = shardRegistry();
  let mgmt: ShardMgmt | null = null;
  const resolver = registryAuthConfigResolver(registry, {
    async repairBrokerUrl(row) {
      const [{ createShardMgmt }, { repairShardBrokerDbUrl }] = await Promise.all([
        import("@/services/site-shards/shard-mgmt"),
        import("@/services/site-shards/broker-db-url"),
      ]);
      mgmt ??= createShardMgmt();
      await repairShardBrokerDbUrl({ secrets: registry, mgmt, log: (l) => console.warn(l) }, row);
      return registry.getSecret(row.id, "broker_db_url");
    },
    log: (l) => console.warn(l),
  });
  return createRegistryDirectory({
    async readSite(siteId) {
      const { data, error } = await sitePublicRpc("site_auth_directory", { p_site_id: siteId });
      if (error || !Array.isArray(data) || data.length === 0) return null;
      return data[0] as unknown as DirectorySiteRow;
    },
    listShards: () => registry.list(shardEnv()),
    resolveConfig: (id) => resolver.resolve(id),
    makeHandle: (ref, c) => ({
      shardId: ref,
      gotrue: createGoTrue({ url: c.url, anonKey: c.anonKey, serviceKey: c.serviceKey }),
      store: createPgShardStore(c.dbUrl),
      hookSecret: c.hookSecret,
    }),
    now: () => Date.now(),
  });
}
