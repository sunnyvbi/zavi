
import { asTenantId, siteShardRpc, tenantRpc, type TenantId } from "@/services/tenant-client";
import {
  NoShardCapacity,
  SHARD_NAME_RE,
  type ShardEnv,
  type ShardHandle,
  type ShardMetrics,
  type ShardRow,
  type ShardSecretName,
  type ShardState,
} from "./contract";

export interface ShardSecretStore {
  getSecret(shard_id: string, name: ShardSecretName): Promise<string | null>;
  setSecret(shard_id: string, name: ShardSecretName, value: string): Promise<void>;
}

export interface ShardMigrationChecksums {
  record(shard_id: string, version: string, sha256: string): Promise<string>;
}
import { isUuid } from "./sql";

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

export type ShardRegistryDeps = {
  shardRpc: (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  tenantRpc: (tid: TenantId, name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
};

const defaultDeps: ShardRegistryDeps = {
  shardRpc: (name, args) => siteShardRpc(name, args) as unknown as PromiseLike<RpcResult>,
  tenantRpc: (tid, name, args) => tenantRpc(tid, name, args) as unknown as PromiseLike<RpcResult>,
};

export type ShardPatch = Partial<{
  project_ref: string;
  url: string;
  state: ShardState;
  is_canary: boolean;
  schema_version: string;
  provision_step: string;
  max_sites: number;
  fill_ratio: number;
}>;

export type ShardCapacityInputs = { placements_1h: number; placements_24h: number; lead_time_s: number | null };

export type ShardPlacementReadiness = { open: number; placeable: number; stale: number; paused: number };

export type ShardMetricsRecord = ShardMetrics & {
  measured_at?: Partial<Record<"db" | "gateway" | "cpu" | "sweep", string>>;
  cpu_sample?: Record<string, number> | null;
  unconfigured?: Array<"gateway" | "cpu">;
};

export interface ShardRegistry extends ShardSecretStore, ShardMigrationChecksums {
  register(input: { env: ShardEnv; name: string; region: string; is_canary?: boolean }): Promise<ShardRow>;
  update(id: string, patch: ShardPatch): Promise<ShardRow>;
  recordMetrics(id: string, metrics: ShardMetricsRecord): Promise<ShardRow>;
  pausePlacement(id: string, reason: string, seconds: number | null): Promise<ShardRow>;
  pausePlacementUnlessHeld(id: string, reason: string, adoptPrefixes: string[]): Promise<{ taken: boolean; held_reason: string | null }>;
  resumePlacement(id: string, expectReason?: string): Promise<ShardRow>;
  rolloutClaim(env: ShardEnv, holder: string, seconds: number): Promise<boolean>;
  rolloutRelease(env: ShardEnv, holder: string): Promise<void>;
  capacityInputs(env: ShardEnv): Promise<ShardCapacityInputs>;
  placementReadiness(env: ShardEnv): Promise<ShardPlacementReadiness>;
  alertClaim(id: string, key: string, everySeconds: number): Promise<boolean>;
  list(env: ShardEnv): Promise<ShardRow[]>;
  get(id: string): Promise<ShardRow | null>;
  initStatic(tenant_id: string, site_id: string): Promise<void>;
  place(tenant_id: string, site_id: string, env: ShardEnv): Promise<{ shard: ShardHandle; placed: boolean }>;
  release(tenant_id: string, site_id: string, to: "static" | "dedicated"): Promise<boolean>;
  registerKernel(tenant_id: string, site_id: string, env: ShardEnv, region: string): Promise<ShardRow>;
  kernelReady(tenant_id: string, site_id: string): Promise<ShardRow>;
  kernelRef(tenant_id: string, site_id: string): Promise<string | null>;
  retireKernel(tenant_id: string, site_id: string): Promise<string | null>;
  validationReady(id: string): Promise<ShardRow>;
}

function fail(name: string, error: { message?: string; code?: string }): Error {
  if (error.code === "53400") return new NoShardCapacity(/ in (\w+)/.exec(error.message ?? "")?.[1] ?? "env");
  return new Error(`ShardRegistry: ${name} failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown error"}`);
}

function rows(data: unknown): ShardRow[] {
  const list = Array.isArray(data) ? data : data ? [data] : [];
  return list.filter((r): r is ShardRow => !!r && typeof r === "object" && isUuid((r as ShardRow).id));
}

const PATCH_KEYS = new Set([
  "project_ref", "url", "state", "is_canary", "schema_version", "provision_step", "max_sites", "fill_ratio",
]);

export function createShardRegistry(deps: ShardRegistryDeps = defaultDeps): ShardRegistry {
  async function platform(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await deps.shardRpc(name, args);
    if (error) throw fail(name, error);
    return data;
  }
  async function site(tenant_id: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isUuid(tenant_id) || !isUuid(args.p_site_id)) throw new Error(`ShardRegistry: ${name} needs uuids`);
    const { data, error } = await deps.tenantRpc(asTenantId(tenant_id), name, args);
    if (error) throw fail(name, error);
    return data;
  }
  function one(name: string, data: unknown): ShardRow {
    const r = rows(data)[0];
    if (!r) throw new Error(`ShardRegistry: ${name} returned no shard`);
    return r;
  }

  return {
    async register({ env, name, region, is_canary }) {
      if (!SHARD_NAME_RE.test(name) || !name.startsWith(`zavi-shard-${env}-`)) {
        throw new Error("ShardRegistry: shard name must be zavi-shard-<env>-<n>");
      }
      return one("site_shard_register", await platform("site_shard_register", {
        p_env: env, p_name: name, p_region: region, p_is_canary: is_canary ?? false,
      }));
    },

    async update(id, patch) {
      for (const k of Object.keys(patch)) if (!PATCH_KEYS.has(k)) throw new Error(`ShardRegistry: key '${k}' is not patchable`);
      return one("site_shard_update", await platform("site_shard_update", { p_id: id, p_patch: patch }));
    },

    async recordMetrics(id, metrics) {
      return one("site_shard_record_metrics", await platform("site_shard_record_metrics", { p_id: id, p_metrics: metrics }));
    },

    async pausePlacement(id, reason, seconds) {
      return one("site_shard_placement_pause", await platform("site_shard_placement_pause", { p_id: id, p_reason: reason.slice(0, 300), p_seconds: seconds }));
    },

    async pausePlacementUnlessHeld(id, reason, adoptPrefixes) {
      if (!isUuid(id)) throw new Error("ShardRegistry: pausePlacementUnlessHeld needs a shard uuid");
      const raw = await platform("site_shard_placement_pause_unless_held", { p_id: id, p_reason: reason.slice(0, 300), p_adopt_prefixes: adoptPrefixes });
      const d = (Array.isArray(raw) ? raw[0] : raw) as { taken?: unknown; held_reason?: unknown } | null | undefined;
      if (!d || typeof d.taken !== "boolean") throw new Error("ShardRegistry: site_shard_placement_pause_unless_held returned no row");
      return { taken: d.taken, held_reason: d.taken ? null : String(d.held_reason ?? "(no reason)") };
    },

    async resumePlacement(id, expectReason) {
      return one("site_shard_placement_resume", await platform("site_shard_placement_resume", { p_id: id, p_expect_reason: expectReason ?? null }));
    },

    async rolloutClaim(env, holder, seconds) {
      const v = await platform("site_shard_rollout_claim", { p_env: env, p_holder: holder.slice(0, 200), p_seconds: seconds });
      return v === true || (Array.isArray(v) && v[0] === true);
    },

    async rolloutRelease(env, holder) {
      await platform("site_shard_rollout_release", { p_env: env, p_holder: holder.slice(0, 200) });
    },

    async capacityInputs(env) {
      const raw = await platform("site_shard_capacity_inputs", { p_env: env });
      const d = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null | undefined;
      const n = (v: unknown) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : 0);
      const lead = d?.lead_time_s;
      return {
        placements_1h: n(d?.placements_1h),
        placements_24h: n(d?.placements_24h),
        lead_time_s: lead === null || lead === undefined || !Number.isFinite(Number(lead)) ? null : Number(lead),
      };
    },

    async placementReadiness(env) {
      const raw = await platform("site_shard_placement_readiness", { p_env: env });
      const d = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null | undefined;
      if (!d || typeof d !== "object") throw new Error("ShardRegistry: site_shard_placement_readiness returned no row");
      const n = (v: unknown) => (v !== null && Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);
      return { open: n(d.open_count), placeable: n(d.placeable_count), stale: n(d.stale_count), paused: n(d.paused_count) };
    },

    async alertClaim(id, key, everySeconds) {
      return (await platform("site_shard_metrics_alert_claim", { p_id: id, p_key: key, p_every_s: everySeconds })) === true;
    },

    async list(env) {
      return rows(await platform("site_shard_list", { p_env: env }));
    },

    async get(id) {
      if (!isUuid(id)) return null;
      return rows(await platform("site_shard_get", { p_id: id }))[0] ?? null;
    },

    async getSecret(shard_id, name) {
      if (!isUuid(shard_id)) return null;
      const v = await platform("site_shard_secret_get", { p_shard_id: shard_id, p_name: name });
      return typeof v === "string" && v ? v : null;
    },

    async setSecret(shard_id, name, value) {
      if (!isUuid(shard_id)) throw new Error("ShardRegistry: setSecret needs a shard uuid");
      await platform("site_shard_secret_set", { p_shard_id: shard_id, p_name: name, p_value: value });
    },

    async record(shard_id, version, sha256) {
      const v = await platform("site_shard_migration_record", { p_shard_id: shard_id, p_version: version, p_sha256: sha256 });
      if (typeof v !== "string") throw new Error("ShardRegistry: site_shard_migration_record returned nothing");
      return v;
    },

    async initStatic(tenant_id, site_id) {
      await site(tenant_id, "site_backend_init_static", { p_site_id: site_id });
    },

    async place(tenant_id, site_id, env) {
      const data = await site(tenant_id, "site_backend_place", { p_site_id: site_id, p_env: env });
      const r = (Array.isArray(data) ? data[0] : data) as
        | { shard_id?: string; project_ref?: string; url?: string; placed?: boolean }
        | undefined;
      if (!r || !isUuid(r.shard_id) || typeof r.project_ref !== "string" || typeof r.url !== "string") {
        throw new Error("ShardRegistry: site_backend_place returned no shard");
      }
      return { shard: { id: r.shard_id, project_ref: r.project_ref, url: r.url }, placed: r.placed === true };
    },

    async registerKernel(tenant_id, site_id, env, region) {
      return one("site_kernel_register", await site(tenant_id, "site_kernel_register", { p_site_id: site_id, p_env: env, p_region: region }));
    },

    async kernelReady(tenant_id, site_id) {
      return one("site_kernel_ready", await site(tenant_id, "site_kernel_ready", { p_site_id: site_id }));
    },

    async kernelRef(tenant_id, site_id) {
      const v = await site(tenant_id, "site_kernel_ref", { p_site_id: site_id });
      return typeof v === "string" && v ? v : null;
    },

    async retireKernel(tenant_id, site_id) {
      const v = await site(tenant_id, "site_kernel_retire", { p_site_id: site_id });
      return typeof v === "string" && v ? v : null;
    },

    async validationReady(id) {
      if (!isUuid(id)) throw new Error("ShardRegistry: validationReady needs a shard uuid");
      return one("site_shard_validation_ready", await platform("site_shard_validation_ready", { p_id: id }));
    },

    async release(tenant_id, site_id, to) {
      return (await site(tenant_id, "site_backend_release", { p_site_id: site_id, p_to: to })) === true;
    },
  };
}

let _registry: ShardRegistry | null = null;
export function shardRegistry(): ShardRegistry {
  return (_registry ??= createShardRegistry());
}

export function shardEnv(env: Record<string, string | undefined> = process.env): ShardEnv {
  let onProd = false;
  try {
    onProd = new URL(String(env.SUPABASE_URL ?? "")).hostname === "wmycgyjsenvgtczlupoe.supabase.co";
  } catch {
    onProd = false;
  }
  if (!onProd) return "dev";
  return (env.SITE_SHARD_ENV ?? "").trim() === "dev" ? "dev" : "prod";
}
