
import type { PooledSiteAuth, ShardHandle, ShardRow } from "./contract";
import { isPooledBrokerDbUrl } from "./broker-db-url";
import type { ShardRegistry } from "./registry";

export type ShardAuthConfig = { url: string; anonKey: string; serviceKey: string; dbUrl: string; hookSecret: string };

export interface ShardAuthConfigResolver {
  resolve(shard_id: string): Promise<ShardAuthConfig | null>;
}

export type ResolverOptions = {
  repairBrokerUrl?: (row: ShardRow) => Promise<string | null>;
  log?: (line: string) => void;
  now?: () => number;
};

export const REPAIR_BACKOFF_MS = 30_000;

export function registryAuthConfigResolver(
  registry: Pick<ShardRegistry, "get" | "getSecret">,
  opts: ResolverOptions = {},
): ShardAuthConfigResolver {
  const inflight = new Map<string, Promise<string | null>>();
  const failedAt = new Map<string, number>();
  const now = opts.now ?? (() => Date.now());
  async function healed(row: ShardRow, dbUrl: string): Promise<string | null> {
    const ref = row.project_ref;
    if (!opts.repairBrokerUrl || !ref || isPooledBrokerDbUrl(dbUrl, ref)) return dbUrl;
    const last = failedAt.get(row.id);
    if (last !== undefined && now() - last < REPAIR_BACKOFF_MS) return null;
    let p = inflight.get(row.id);
    if (!p) {
      p = opts.repairBrokerUrl(row).finally(() => inflight.delete(row.id));
      inflight.set(row.id, p);
    }
    try {
      const next = await p;
      if (next && isPooledBrokerDbUrl(next, ref)) {
        failedAt.delete(row.id);
        return next;
      }
      throw new Error("repair did not produce a pooled URL");
    } catch (e) {
      failedAt.set(row.id, now());
      opts.log?.(`[site-auth] code=sites.broker_db_url.repair_failed shard=${row.name}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return null;
    }
  }
  return {
    async resolve(shard_id) {
      const row = await registry.get(shard_id);
      if (!row || !row.url || row.state === "retired") return null;
      const [anonKey, serviceKey, dbUrl, hookSecret] = await Promise.all([
        registry.getSecret(row.id, "anon_key"),
        registry.getSecret(row.id, "service_key"),
        registry.getSecret(row.id, "broker_db_url"),
        registry.getSecret(row.id, "hook_secret"),
      ]);
      if (!anonKey || !serviceKey || !dbUrl || !hookSecret) return null;
      const db = await healed(row, dbUrl);
      if (!db) return null;
      return { url: row.url, anonKey, serviceKey, dbUrl: db, hookSecret };
    },
  };
}

export function pooledAuthFromBroker(b: {
  ensureSiteAdmin(args: { siteId: string; email: string; sendPasswordSetup?: boolean }): Promise<{ authUserId: string }>;
  ownerMagicLink(args: { shardId: string; siteId: string; email: string; redirectTo: string }): Promise<string>;
  deleteAuthUser(args: { shardId: string; authUserId: string }): Promise<void>;
  ensureSiteCustomer?(args: { siteId: string; email: string; adminEmail: string }): Promise<{ authUserId: string }>;
  customerMagicLink?(args: { shardId: string; siteId: string; email: string; redirectTo: string }): Promise<string>;
}): PooledSiteAuth {
  const ensureSiteCustomer = b.ensureSiteCustomer;
  const customerMagicLink = b.customerMagicLink;
  return {
    ...(ensureSiteCustomer
      ? {
          ensureCustomer: async ({ site_id, email, admin_email }: { shard: ShardHandle; site_id: string; email: string; admin_email: string }) => {
            const r = await ensureSiteCustomer({ siteId: site_id, email, adminEmail: admin_email });
            return { user_id: r.authUserId };
          },
        }
      : {}),
    ...(customerMagicLink
      ? {
          customerMagicLink: ({ shard, site_id, email, redirect_to }: { shard: ShardHandle; site_id: string; email: string; redirect_to: string }) =>
            customerMagicLink({ shardId: shard.project_ref, siteId: site_id, email, redirectTo: redirect_to }),
        }
      : {}),
    async ensureFounderAdmin({ site_id, email }) {
      const r = await b.ensureSiteAdmin({ siteId: site_id, email });
      return { user_id: r.authUserId };
    },
    ownerMagicLink: ({ shard, site_id, email, redirect_to }: { shard: ShardHandle; site_id: string; email: string; redirect_to: string }) =>
      b.ownerMagicLink({ shardId: shard.project_ref, siteId: site_id, email, redirectTo: redirect_to }),
    deleteAuthUser: ({ shard, auth_user_id }) => b.deleteAuthUser({ shardId: shard.project_ref, authUserId: auth_user_id }),
  };
}
