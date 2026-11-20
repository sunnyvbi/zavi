
import { asTenantId, tenantRpc, type TenantId } from "@/services/tenant-client";
import type { SitePublishGenerations, SitePublishLease } from "./contract";

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };
export type PublishGenerationDeps = {
  rpc: (tid: TenantId, name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
};

const defaultDeps: PublishGenerationDeps = {
  rpc: (tid, name, args) => tenantRpc(tid, name, args) as unknown as PromiseLike<RpcResult>,
};

const LEASES: ReadonlySet<string> = new Set(["leased", "superseded", "busy"]);

export function createPublishGenerations(deps: PublishGenerationDeps = defaultDeps): SitePublishGenerations {
  async function call(tenant_id: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await deps.rpc(asTenantId(tenant_id), name, args);
    if (error) throw new Error(`${name} failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown error"}`);
    return data;
  }
  return {
    async begin(tenant_id, site_id, sha, conductor_run_id) {
      const raw = await call(tenant_id, "site_publish_begin", {
        p_site_id: site_id,
        p_sha: sha,
        ...(conductor_run_id ? { p_conductor_run_id: conductor_run_id } : {}),
      });
      const n = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
      if (n === 0) return "busy";
      if (!Number.isSafeInteger(n) || n < 1) throw new Error("site_publish_begin returned no generation");
      return n;
    },
    async lease(tenant_id, site_id, generation, ttl_s, token) {
      const out = String(await call(tenant_id, "site_publish_lease", { p_site_id: site_id, p_generation: generation, p_ttl_seconds: ttl_s, p_token: token }));
      if (out === "not_found") return "superseded";
      if (!LEASES.has(out)) throw new Error(`site_publish_lease returned ${out.slice(0, 40)}`);
      return out as SitePublishLease;
    },
    async release(tenant_id, site_id, generation, token) {
      await call(tenant_id, "site_publish_release", { p_site_id: site_id, p_generation: generation, p_token: token });
    },
  };
}
