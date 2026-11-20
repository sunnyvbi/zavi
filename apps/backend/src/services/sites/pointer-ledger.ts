
import { asTenantId, sitePublicRpc, tenantRpc, type TenantId } from "@/services/tenant-client";
import type { SitePointerLedger } from "./contract";

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

export type SitePointerLedgerDeps = {
  rpc: (tid: TenantId, name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  publicRpc: (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
};

const defaultDeps: SitePointerLedgerDeps = {
  rpc: (tid, name, args) => tenantRpc(tid, name, args) as unknown as PromiseLike<RpcResult>,
  publicRpc: (name, args) => sitePublicRpc(name, args) as unknown as PromiseLike<RpcResult>,
};

const MAX_BATCH = 500;

function fail(name: string, error: { message?: string; code?: string }): Error {
  return new Error(`SitePointerLedger: ${name} failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown error"}`);
}

export function createSitePointerLedger(deps: SitePointerLedgerDeps = defaultDeps): SitePointerLedger {
  async function count(tenant_id: string, name: string, args: Record<string, unknown>): Promise<number> {
    const { data, error } = await deps.rpc(asTenantId(tenant_id), name, args);
    if (error) throw fail(name, error);
    const n = typeof data === "number" || typeof data === "string" ? Number(data) : NaN;
    if (!Number.isInteger(n)) throw new Error(`SitePointerLedger: ${name} returned no count`);
    return n;
  }

  return {
    markProjected(tenant_id, site_id, version, drift) {
      if (!Number.isSafeInteger(version) || version < 0) return Promise.reject(new Error("SitePointerLedger: markProjected needs a host_version"));
      return count(tenant_id, "site_mark_host_projected", { p_site_id: site_id, p_version: version, p_drift: drift });
    },
    noteDrift(tenant_id, site_id) {
      return count(tenant_id, "site_note_projection_drift", { p_site_id: site_id });
    },
    async driftBatch(settle_before_iso, limit) {
      const n = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(limit) || 0)));
      const { data, error } = await deps.publicRpc("site_projection_drift_batch", { p_settle_before: settle_before_iso, p_limit: n });
      if (error) throw fail("site_projection_drift_batch", error);
      const rows = (Array.isArray(data) ? data : []) as Array<{ tenant_id?: string; site_id?: string }>;
      return rows
        .filter((r) => r?.tenant_id && r.site_id)
        .map((r) => ({ tenant_id: r.tenant_id as string, site_id: r.site_id as string }));
    },
  };
}

let _ledger: SitePointerLedger | null = null;
export function sitePointerLedger(): SitePointerLedger {
  return (_ledger ??= createSitePointerLedger());
}
