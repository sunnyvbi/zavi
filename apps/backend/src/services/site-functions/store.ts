
import { asTenantId, siteFunctionsRpc, tenantRpc, type TenantId } from "@/services/tenant-client";

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

export interface StoreDeps {
  tenantRpc: (tid: TenantId, name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  platformRpc: (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
}

export class SiteFunctionsStoreError extends Error {
  constructor(public rpc: string, public sqlstate: string | null, message: string) {
    super(`site-functions ${rpc} failed${sqlstate ? ` (${sqlstate})` : ""}: ${message}`);
  }
  get notFound() {
    return this.sqlstate === "P0002";
  }
  get invalid() {
    return this.sqlstate === "22023";
  }
}

export interface ActivateOutcome {
  outcome: "activated" | "already" | "superseded" | "deleting";
  script?: string | null;
  previous_script?: string | null;
  status?: string;
  active_generation?: number;
}

export interface DueSchedule { id: string; site_id: string; tenant_id: string; name: string; cron: string; next_run_at: string }
export interface ClaimedRun {
  id: string; site_id: string; tenant_id: string; schedule_name: string; slot: string; idempotency_key: string;
  attempt: number; max_attempts: number; data_access: "function" | "admin" | null; hostname: string | null;
}
export interface SyncState {
  site_id: string;
  tenant_id: string;
  status: "active" | "disabled" | "deleting" | "deleted";
  active_generation: number | null;
  active_script: string | null;
  sync_version: number;
  manifest: Record<string, unknown> | null;
}

export interface SweepCandidate { kind: "site" | "script"; site_id: string; tenant_id: string; script: string | null }

export interface SiteFunctionsStore {
  secretSet(tenant_id: string, site_id: string, scope: "live" | "test", name: string, value: string): Promise<{ name: string; scope: string; updated_at: string; rotated: boolean }>;
  secretDelete(tenant_id: string, site_id: string, scope: "live" | "test", name: string): Promise<boolean>;
  secretList(tenant_id: string, site_id: string): Promise<Array<{ name: string; scope: string; created_at: string; updated_at: string }>>;
  secretValues(tenant_id: string, site_id: string, scope: "live" | "test"): Promise<Array<{ name: string; value: string }>>;
  stage(i: { tenant_id: string; live_site_id: string; site_id: string; kind: "live" | "test"; generation: number; script: string; manifest: unknown; bundle_sha256: string }): Promise<"staged" | "superseded">;
  activate(tenant_id: string, site_id: string, generation: number, script: string | null, schedules: unknown[]): Promise<ActivateOutcome>;
  setStatus(tenant_id: string, site_id: string, status: "active" | "disabled", reason: string | null): Promise<{ outcome: string; status?: string; generation?: number | null; script?: string | null }>;
  scheduleSetEnabled(tenant_id: string, site_id: string, name: string, enabled: boolean): Promise<boolean>;
  overview(tenant_id: string, site_id: string): Promise<Record<string, unknown>>;
  runsList(tenant_id: string, site_id: string, limit: number): Promise<unknown[]>;
  logsList(tenant_id: string, site_id: string, before: number | null, limit: number): Promise<unknown[]>;
  schedulesDue(now: Date, limit: number, leaseS: number): Promise<DueSchedule[]>;
  scheduleFire(id: string, expectedNext: string, slot: Date, newNext: Date, maxAttempts: number): Promise<"fired" | "duplicate" | "stale">;
  runsClaim(now: Date, limit: number, leaseS: number, siteConcurrency: number): Promise<ClaimedRun[]>;
  runLeased(id: string, attempt: number, now: Date): Promise<ClaimedRun | null>;
  runFinish(id: string, attempt: number, ok: boolean, status: number | null, error: string | null, retryAt: Date | null): Promise<string>;
  logsInsert(entries: unknown[]): Promise<number>;
  secretsForScripts(scripts: string[]): Promise<Array<{ script: string; value: string }>>;
  sweepCandidates(now: Date, limit: number): Promise<SweepCandidate[]>;
  reconcileBegin(site_id: string, holder: string, leaseS: number): Promise<SyncState | null>;
  reconcileEnd(site_id: string, holder: string, version: number, ok: boolean): Promise<boolean>;
  dirtySites(limit: number): Promise<string[]>;
  scriptDeleted(script: string): Promise<boolean>;
  teardownBegin(site_id: string): Promise<string[]>;
  teardownFinish(site_id: string): Promise<boolean>;
  retention(now: Date, batch: number): Promise<{ logs: number; runs: number }>;
}

const defaultDeps = (): StoreDeps => ({
  tenantRpc: (tid, name, args) => tenantRpc(tid, name, args) as unknown as PromiseLike<RpcResult>,
  platformRpc: (name, args) => siteFunctionsRpc(name, args) as unknown as PromiseLike<RpcResult>,
});

const list = <T>(d: unknown): T[] => (Array.isArray(d) ? (d as T[]) : d ? [d as T] : []);

export function createSiteFunctionsStore(deps: StoreDeps = defaultDeps()): SiteFunctionsStore {
  async function t(tenant_id: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await deps.tenantRpc(asTenantId(tenant_id), name, args);
    if (error) throw new SiteFunctionsStoreError(name, error.code ?? null, (error.message ?? "unknown").slice(0, 200));
    return data;
  }
  async function p(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await deps.platformRpc(name, args);
    if (error) throw new SiteFunctionsStoreError(name, error.code ?? null, (error.message ?? "unknown").slice(0, 200));
    return data;
  }
  return {
    async secretSet(tenant_id, site_id, scope, name, value) {
      return (await t(tenant_id, "site_fn_secret_set", { p_site_id: site_id, p_scope: scope, p_name: name, p_value: value })) as never;
    },
    async secretDelete(tenant_id, site_id, scope, name) {
      return (await t(tenant_id, "site_fn_secret_delete", { p_site_id: site_id, p_scope: scope, p_name: name })) === true;
    },
    async secretList(tenant_id, site_id) {
      return list(await t(tenant_id, "site_fn_secret_list", { p_site_id: site_id }));
    },
    async secretValues(tenant_id, site_id, scope) {
      return list(await t(tenant_id, "site_fn_secret_values", { p_site_id: site_id, p_scope: scope }));
    },
    async stage(i) {
      const r = await t(i.tenant_id, "site_fn_stage", {
        p_live_site_id: i.live_site_id, p_site_id: i.site_id, p_kind: i.kind, p_generation: i.generation,
        p_script: i.script, p_manifest: i.manifest, p_bundle_sha256: i.bundle_sha256,
      });
      return r === "superseded" ? "superseded" : "staged";
    },
    async activate(tenant_id, site_id, generation, script, schedules) {
      return (await t(tenant_id, "site_fn_activate", { p_site_id: site_id, p_generation: generation, p_script: script, p_schedules: schedules })) as ActivateOutcome;
    },
    async setStatus(tenant_id, site_id, status, reason) {
      return (await t(tenant_id, "site_fn_set_status", { p_site_id: site_id, p_status: status, p_reason: reason })) as never;
    },
    async scheduleSetEnabled(tenant_id, site_id, name, enabled) {
      return (await t(tenant_id, "site_fn_schedule_set_enabled", { p_site_id: site_id, p_name: name, p_enabled: enabled })) === true;
    },
    async overview(tenant_id, site_id) {
      return ((await t(tenant_id, "site_fn_overview", { p_site_id: site_id })) ?? {}) as Record<string, unknown>;
    },
    async runsList(tenant_id, site_id, limit) {
      return list(await t(tenant_id, "site_fn_runs_list", { p_site_id: site_id, p_limit: limit }));
    },
    async logsList(tenant_id, site_id, before, limit) {
      return list(await t(tenant_id, "site_fn_logs_list", { p_site_id: site_id, p_before: before, p_limit: limit }));
    },
    async schedulesDue(now, limit, leaseS) {
      return list(await p("site_fn_schedules_due", { p_now: now.toISOString(), p_limit: limit, p_lease_s: leaseS }));
    },
    async scheduleFire(id, expectedNext, slot, newNext, maxAttempts) {
      return (await p("site_fn_schedule_fire", {
        p_id: id, p_expected_next: expectedNext, p_slot: slot.toISOString(), p_new_next: newNext.toISOString(), p_max_attempts: maxAttempts,
      })) as "fired" | "duplicate" | "stale";
    },
    async runsClaim(now, limit, leaseS, siteConcurrency) {
      return list(await p("site_fn_runs_claim", { p_now: now.toISOString(), p_limit: limit, p_lease_s: leaseS, p_site_concurrency: siteConcurrency }));
    },
    async runLeased(id, attempt, now) {
      return list<ClaimedRun>(await p("site_fn_run_leased", { p_id: id, p_attempt: attempt, p_now: now.toISOString() }))[0] ?? null;
    },
    async runFinish(id, attempt, ok, status, error, retryAt) {
      return String(await p("site_fn_run_finish", {
        p_id: id, p_attempt: attempt, p_ok: ok, p_status: status, p_error: error, p_retry_at: retryAt ? retryAt.toISOString() : null,
      }));
    },
    async logsInsert(entries) {
      return Number(await p("site_fn_logs_insert", { p_entries: entries })) || 0;
    },
    async secretsForScripts(scripts) {
      if (!scripts.length) return [];
      return list(await p("site_fn_secrets_for_scripts", { p_scripts: scripts }));
    },
    async reconcileBegin(site_id, holder, leaseS) {
      const d = await p("site_fn_reconcile_begin", { p_site_id: site_id, p_holder: holder, p_lease_s: leaseS });
      return d && typeof d === "object" ? (d as SyncState) : null;
    },
    async reconcileEnd(site_id, holder, version, ok) {
      return (await p("site_fn_reconcile_end", { p_site_id: site_id, p_holder: holder, p_version: version, p_ok: ok })) === true;
    },
    async dirtySites(limit) {
      return list<unknown>(await p("site_fn_dirty_sites", { p_limit: limit })).map((x) =>
        typeof x === "string" ? x : String((x as Record<string, unknown>).site_fn_dirty_sites ?? ""),
      ).filter(Boolean);
    },
    async sweepCandidates(now, limit) {
      return list(await p("site_fn_sweep_candidates", { p_now: now.toISOString(), p_limit: limit }));
    },
    async scriptDeleted(script) {
      return (await p("site_fn_script_deleted", { p_script: script })) === true;
    },
    async teardownBegin(site_id) {
      return list<unknown>(await p("site_fn_teardown_begin", { p_site_id: site_id })).map((x) =>
        typeof x === "string" ? x : String((x as Record<string, unknown>).site_fn_teardown_begin ?? ""),
      ).filter(Boolean);
    },
    async teardownFinish(site_id) {
      return (await p("site_fn_teardown_finish", { p_site_id: site_id })) === true;
    },
    async retention(now, batch) {
      return ((await p("site_fn_retention", { p_now: now.toISOString(), p_batch: batch })) ?? { logs: 0, runs: 0 }) as { logs: number; runs: number };
    },
  };
}
