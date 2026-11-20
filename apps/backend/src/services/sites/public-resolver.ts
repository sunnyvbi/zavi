
import { sitePublicRpc } from "@/services/tenant-client";
import type { SitePublicResolver, SiteStatus } from "./contract";

type RpcResult = { data: unknown; error: { message?: string } | null };
export type SitePublicResolverDeps = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
};

const defaultDeps: SitePublicResolverDeps = {
  rpc: (name, args) => sitePublicRpc(name, args) as unknown as PromiseLike<RpcResult>,
};

const MAX_BATCH = 500;

type SiteRef = { tenant_id: string; site_id: string; status: SiteStatus };

function siteRef(data: unknown): SiteRef | null {
  const row = (Array.isArray(data) ? data[0] : data) as
    | { tenant_id?: string; site_id?: string; status?: string }
    | null
    | undefined;
  if (!row?.tenant_id || !row.site_id || !row.status) return null;
  return { tenant_id: row.tenant_id, site_id: row.site_id, status: row.status as SiteStatus };
}

export function createSitePublicResolver(deps: SitePublicResolverDeps = defaultDeps): SitePublicResolver {
  return {
    async byHostname(hostname) {
      const host = String(hostname ?? "").trim().toLowerCase();
      if (!host) return null;
      const { data, error } = await deps.rpc("site_by_hostname", { p_hostname: host });
      if (error) throw new Error(`site_by_hostname failed: ${error.message ?? "unknown error"}`);
      return siteRef(data);
    },

    async byRepo(github_full_name) {
      const name = String(github_full_name ?? "").trim();
      if (!name) return null;
      const { data, error } = await deps.rpc("site_by_repo", { p_github_full_name: name });
      if (error) throw new Error(`site_by_repo failed: ${error.message ?? "unknown error"}`);
      return siteRef(data);
    },

    async claimIdleBatch(cutoff_iso, limit) {
      const n = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(limit) || 0)));
      const { data, error } = await deps.rpc("site_claim_idle_batch", { p_cutoff: cutoff_iso, p_limit: n });
      if (error) throw new Error(`site_claim_idle_batch failed: ${error.message ?? "unknown error"}`);
      const rows = (Array.isArray(data) ? data : []) as Array<{ tenant_id?: string; site_id?: string; hostname?: string }>;
      return rows
        .filter((r) => r?.tenant_id && r.site_id && r.hostname)
        .map((r) => ({ tenant_id: r.tenant_id as string, site_id: r.site_id as string, hostname: r.hostname as string }));
    },
  };
}

let _resolver: SitePublicResolver | null = null;
export function sitePublicResolver(): SitePublicResolver {
  return (_resolver ??= createSitePublicResolver());
}
