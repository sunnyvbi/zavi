
import {
  asTenantId,
  tenantClient,
  tenantRpc,
  type TenantId,
  type TenantScopedTable,
} from "@/services/tenant-client";
import type {
  SitePatch,
  SiteProviderKind,
  SiteProviderState,
  SiteRow,
  SiteStatus,
  SiteStore,
} from "./contract";
import { cleanSiteName, siteHostnameConfig, type SiteHostnameConfig } from "./label";
import { POSTGREST_PRE_EXECUTION_CODES } from "./platform-errors";

export const SITE_PATCH_KEYS: ReadonlyArray<keyof SitePatch> = [
  "github_full_name", "supabase_project_ref", "supabase_url", "status", "live_url", "desired_sha",
  "last_visit_at", "last_edit_at", "paused_at", "last_error", "owner_email",
];

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

export type SiteStoreDeps = {
  rpc: (tid: TenantId, name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  table: (tid: TenantId, table: "sites" | "site_providers") => TenantScopedTable;
  hostnameConfig?: () => SiteHostnameConfig;
  sleep?: (ms: number) => Promise<void>;
};

export const SITE_STORE_RETRY_DELAYS_MS: ReadonlyArray<number> = [250, 1_000, 3_000];

const defaultDeps: SiteStoreDeps = {
  rpc: (tid, name, args) => tenantRpc(tid, name, args) as unknown as PromiseLike<RpcResult>,
  table: (tid, table) => tenantClient(tid).from(table),
  hostnameConfig: () => siteHostnameConfig(),
};

function assertPatch(patch: Record<string, unknown>, allowStatus: boolean): void {
  for (const k of Object.keys(patch)) {
    if (!(SITE_PATCH_KEYS as readonly string[]).includes(k) || (!allowStatus && k === "status")) {
      throw new Error(`SiteStore: key '${k}' is not patchable`);
    }
  }
}

const MISSING_FUNCTION_CODES = new Set(["PGRST202", "42883"]);

function rpcError(name: string, error: { message?: string; code?: string }): Error {
  return new Error(`SiteStore: ${name} failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown error"}`);
}

function asRow(data: unknown): SiteRow | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object" || (row as { id?: unknown }).id == null) return null;
  return row as SiteRow;
}

function ownRow(tenant_id: string, row: SiteRow | null): SiteRow | null {
  if (row && row.tenant_id !== tenant_id) {
    throw new Error("SiteStore: row tenant does not match the scope tenant");
  }
  return row;
}

function likeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function createSiteStore(deps: SiteStoreDeps = defaultDeps): SiteStore {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function withPreExecutionRetry<T extends { error: { message?: string; code?: string } | null }>(send: () => PromiseLike<T>): Promise<T> {
    for (let i = 0; ; i++) {
      const res = await send();
      const code = res.error?.code ?? "";
      if (!res.error || !POSTGREST_PRE_EXECUTION_CODES.has(code) || i >= SITE_STORE_RETRY_DELAYS_MS.length) return res;
      await sleep(SITE_STORE_RETRY_DELAYS_MS[i]);
    }
  }

  async function call(tenant_id: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await withPreExecutionRetry(() => deps.rpc(asTenantId(tenant_id), name, args));
    if (error) throw rpcError(name, error);
    return data;
  }

  async function readOne(
    tenant_id: string,
    apply: (q: any) => any,
  ): Promise<SiteRow | null> {
    const { data, error } = await withPreExecutionRetry<{ data: unknown; error: { message?: string; code?: string } | null }>(() =>
      apply(deps.table(asTenantId(tenant_id), "sites").select("*")).limit(1).maybeSingle(),
    );
    if (error) throw new Error(`SiteStore: read failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown error"}`);
    return ownRow(tenant_id, (data as SiteRow | null) ?? null);
  }

  return {
    async getOrCreateForRun({ tenant_id, root_conductor_run_id, company_name, started_by_user_id, site_name }) {
      if (!tenant_id || !root_conductor_run_id) throw new Error("SiteStore: tenant_id and run id are required");
      const host = (deps.hostnameConfig ?? siteHostnameConfig)();
      const base = {
        p_run_id: root_conductor_run_id,
        p_company_name: company_name ?? "",
        p_started_by: started_by_user_id ?? null,
        p_hostname_suffix: host.suffix,
        p_base_domain: host.base_domain,
      };
      const named = cleanSiteName(site_name);
      let data: unknown;
      if (named) {
        const res = await withPreExecutionRetry(() => deps.rpc(asTenantId(tenant_id), "site_get_or_create_for_run", { ...base, p_site_name: named }));
        if (res.error && MISSING_FUNCTION_CODES.has(res.error.code ?? "")) {
          data = await call(tenant_id, "site_get_or_create_for_run", base);
        } else if (res.error) {
          throw rpcError("site_get_or_create_for_run", res.error);
        } else {
          data = res.data;
        }
      } else {
        data = await call(tenant_id, "site_get_or_create_for_run", base);
      }
      const row = ownRow(tenant_id, asRow(data));
      if (!row) throw new Error("SiteStore: site_get_or_create_for_run returned no row");
      return row;
    },

    get(tenant_id, site_id) {
      return readOne(tenant_id, (q) => q.eq("id", site_id));
    },

    getByRun(tenant_id, conductor_run_id) {
      return readOne(tenant_id, (q) => q.eq("root_conductor_run_id", conductor_run_id));
    },

    getByRepo(tenant_id, github_full_name) {
      const name = String(github_full_name ?? "").trim();
      if (!name) return Promise.resolve(null);
      return readOne(tenant_id, (q) => q.ilike("github_full_name", likeLiteral(name)));
    },

    async listForTenant(tenant_id) {
      const { data, error } = await withPreExecutionRetry<{ data: unknown; error: { message?: string; code?: string } | null }>(() =>
        (deps.table(asTenantId(tenant_id), "sites").select("*") as any).order("created_at", { ascending: false }),
      );
      if (error) throw new Error(`SiteStore: list failed: ${error.message ?? "unknown error"}`);
      return ((data ?? []) as SiteRow[]).map((r) => ownRow(tenant_id, r) as SiteRow);
    },

    async update(tenant_id, site_id, patch: SitePatch) {
      assertPatch(patch as Record<string, unknown>, true);
      const row = ownRow(tenant_id, asRow(await call(tenant_id, "site_update", { p_site_id: site_id, p_patch: patch })));
      if (!row) throw new Error("SiteStore: site_update returned no row");
      return row;
    },

    async transition(tenant_id, site_id, from: SiteStatus[], to: SiteStatus, patch: SitePatch = {}) {
      assertPatch(patch as Record<string, unknown>, false);
      if (!from.length) return null;
      const data = await call(tenant_id, "site_transition", {
        p_site_id: site_id,
        p_from: from,
        p_to: to,
        p_patch: patch,
      });
      return ownRow(tenant_id, asRow(data));
    },

    async settleStopped(tenant_id, site_id, to, last_error, generation, conductor_run_id) {
      const data = await call(tenant_id, "site_settle_stopped", {
        p_site_id: site_id,
        p_to: to,
        p_last_error: last_error,
        ...(typeof generation === "number" ? { p_generation: generation } : {}),
        ...(conductor_run_id ? { p_conductor_run_id: conductor_run_id } : {}),
      });
      return ownRow(tenant_id, asRow(data));
    },

    async activateIfDesired(tenant_id, site_id, sha, deploy_id, live_url, generation, conductor_run_id) {
      const data = await call(tenant_id, "site_activate_if_desired", {
        p_site_id: site_id,
        p_sha: sha,
        p_deploy_id: deploy_id,
        p_live_url: live_url,
        ...(typeof generation === "number" ? { p_generation: generation } : {}),
        ...(conductor_run_id ? { p_conductor_run_id: conductor_run_id } : {}),
      });
      return data === true;
    },

    async claimProvider(tenant_id, site_id, kind: SiteProviderKind, ref) {
      await call(tenant_id, "site_provider_claim", { p_site_id: site_id, p_kind: kind, p_ref: ref ?? {} });
    },

    async setProviderState(tenant_id, site_id, kind: SiteProviderKind, state: SiteProviderState, ref) {
      await call(tenant_id, "site_provider_set", {
        p_site_id: site_id,
        p_kind: kind,
        p_state: state,
        p_ref: ref ?? null,
      });
    },

    async scheduleProviderDelete(tenant_id, site_id, kind: SiteProviderKind, grace_days, ref) {
      const at = await call(tenant_id, "site_provider_schedule_delete", {
        p_site_id: site_id,
        p_kind: kind,
        p_grace_days: grace_days,
        p_ref: ref ?? null,
      });
      if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
        throw new Error("site_provider_schedule_delete returned no schedule");
      }
      return at;
    },

    async cancelProviderDelete(tenant_id, site_id, kind: SiteProviderKind, ref) {
      const data = await call(tenant_id, "site_provider_cancel_delete", { p_site_id: site_id, p_kind: kind, p_ref: ref ?? null });
      return data === true;
    },

    async beginProviderDelete(tenant_id, site_id, kind: SiteProviderKind, from) {
      const data = await call(tenant_id, "site_provider_begin_delete", { p_site_id: site_id, p_kind: kind, p_from: from });
      return data === true;
    },
  };
}

let _store: SiteStore | null = null;
export function siteStore(): SiteStore {
  return (_store ??= createSiteStore());
}
