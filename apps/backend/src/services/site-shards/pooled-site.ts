
import type { SiteRow } from "@/services/sites/contract";
import { publishFenceOnlySql, publishReserveSql } from "./sql";
import type { SiteDeleteGuard } from "@/services/sites/delete-guard";
import { reportDeleteRefusal } from "@/services/sites/delete-guard";
import type { ShardKeyStore } from "./shard-keys";
import {
  shardKvKey,
  PROVISION_DONE,
  REQUIRED_SHARD_SCHEMA,
  type PooledSiteAuth,
  type ShardEnv,
  type ShardHandle,
  type ShardSql,
  type ShardStorage,
  type SiteManifestPackage,
  type CollectionDef,
  type SiteContractDef,
} from "./contract";
import { CollectionPlanRefused, planCollections, planIsEmpty, planSite, sitePlanIsEmpty, type CollectionPlan, type ManifestChange, type SitePlan } from "./collections-plan";
import { EMPTY_SITE_CONTRACT, V2_SHARD_SCHEMA } from "./contract";
import { applySitePlanSql, readCollectionsV2, readSiteContract, refusalFromError, roleHolders, type RoleHolder } from "./apply-v2";
import { detectDedicatedCapabilities, RAW_SQL_REFUSAL_CODE, rawSqlRefusal, type DedicatedCapability } from "./capabilities";
import { nonAdditiveChanges, notAdditiveReason, NOT_ADDITIVE } from "./additive";
import { exportSiteV2Lines } from "./export-v2";
import { applyQuotaOverrides, type SiteBackendSettings } from "./site-settings";
import { syncHostRecord, type HostSyncDeps, type KvStore } from "@/services/sites/host-record";
import type { GatewayRoutes } from "./gateway-route";
import { collectionsOf, collectionsVia, siteContractVia, uncarriedParts, usesV2, validateWith, validationErrors } from "./manifest-adapter";
import { readLedger } from "./migrations";
import type { ShardRegistry } from "./registry";
import {
  applyCollectionPlan,
  deleteRecordBatch,
  deleteShardSiteRows,
  ensureShardSite,
  isActiveAdmin,
  markShardSiteDeleting,
  readCollections,
  pendingReindexes,
  reindexCollection,
  shardSiteLeftovers,
  siteAuthUserIds,
} from "./shard-ops";

export type PooledSiteDeps = {
  registry: ShardRegistry;
  sql: ShardSql;
  storage: ShardStorage;
  kv: KvStore;
  bumpHost: HostSyncDeps["bump"];
  getSite: HostSyncDeps["get"];
  requestHostVerify?: HostSyncDeps["requestVerify"];
  routes: GatewayRoutes;
  manifest: SiteManifestPackage | null;
  auth: PooledSiteAuth | null;
  env: () => ShardEnv;
  deleteGuard: SiteDeleteGuard;
  roleAudit?: (input: { tenant_id: string; site_id: string; manifest_hash: string; shard_ref: string; holders: RoleHolder[] }) => Promise<void>;
  siteSettings?: (site_id: string) => Promise<SiteBackendSettings | null>;
  signer?: ShardKeyStore | null;
  onShardSchemaMissing?: (shard_ref: string, version: string) => void;
  log?: (line: string) => void;
};

function schemaMissing(deps: Pick<PooledSiteDeps, "onShardSchemaMissing" | "log">, ref: string, version: string, label: string): PooledBackendUnavailable {
  try {
    deps.onShardSchemaMissing?.(ref, version);
  } catch (e) {
    deps.log?.(`[pooled-site] schema repair request failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  return new PooledBackendUnavailable(`shard ${label} lacks schema ${version}${version === FENCE_SHARD_SCHEMA ? " (publish fencing)" : ""}`);
}

export type PooledApplyOutcome =
  | { kind: "static" }
  | {
      kind: "active";
      shard: ShardHandle;
      manifest_hash: string;
      binding_version: number;
      plan: CollectionPlan;
      changes: ManifestChange[];
      index_building: string[];
    }
  | { kind: "invalid"; errors: string[] }
  | { kind: "refused"; reason: string; code?: string }
  | { kind: "dedicated_required"; capabilities: DedicatedCapability[] };

export class PooledBackendUnavailable extends Error {
  constructor(reason: string) {
    super(`pooled backend unavailable: ${reason}`);
    this.name = "PooledBackendUnavailable";
  }
}

export async function kernelShardOf(deps: Pick<PooledSiteDeps, "registry">, site: SiteRow): Promise<ShardHandle> {
  const row = site.kernel_shard_id ? await deps.registry.get(site.kernel_shard_id) : null;
  if (!row?.project_ref || !row.url || row.dedicated_site_id !== site.id) throw new PooledBackendUnavailable("the site's kernel shard is not registered to it");
  return { id: row.id, project_ref: row.project_ref, url: row.url };
}

export async function existingShardRef(deps: Pick<PooledSiteDeps, "registry">, tenant_id: string, site: SiteRow): Promise<string | null> {
  if (site.tenant_id !== tenant_id) throw new Error("pooled site: site tenant mismatch");
  if (site.kernel_shard_id) return (await kernelShardOf(deps, site)).project_ref;
  const row = site.shard_id ? await deps.registry.get(site.shard_id) : null;
  return row?.project_ref ?? null;
}

export function declaresCollections(value: unknown): boolean {
  return collectionsOf(value).length > 0;
}

const hostDeps = (d: PooledSiteDeps): HostSyncDeps => ({ kv: d.kv, bump: d.bumpHost, get: d.getSite, requestVerify: d.requestHostVerify });

async function assertShardReady(deps: PooledSiteDeps, shard: ShardHandle): Promise<Set<string>> {
  const row = await deps.registry.get(shard.id);
  if (!row || row.project_ref !== shard.project_ref) throw new PooledBackendUnavailable("shard not in the registry");
  if (!["open", "full", "draining"].includes(row.state) || row.provision_step !== PROVISION_DONE) {
    throw new PooledBackendUnavailable(`shard ${row.name} is not fully provisioned`);
  }
  const ledger = await readLedger(deps.sql, shard.project_ref);
  if (!ledger.has(REQUIRED_SHARD_SCHEMA)) throw schemaMissing(deps, shard.project_ref, REQUIRED_SHARD_SCHEMA, row.name);
  return ledger;
}

type PreparedManifest = {
  kernelSite: boolean;
  mode: NonNullable<SiteRow["backend_mode"]>;
  hash: string;
  desired: CollectionDef[];
  desiredContract: SiteContractDef;
  v2: boolean;
};

function prepareManifest(
  deps: Pick<PooledSiteDeps, "manifest">,
  input: { tenant_id: string; site: SiteRow; manifestRaw: unknown; paths?: readonly string[] },
  who: string,
): Exclude<PooledApplyOutcome, { kind: "active" }> | PreparedManifest {
  const { tenant_id, site } = input;
  if (site.tenant_id !== tenant_id) throw new Error(`${who}: site tenant mismatch`);
  const mode = site.backend_mode ?? "dedicated";
  const kernelSite = mode === "dedicated" && !!site.kernel_shard_id;
  if (mode === "dedicated" && !kernelSite) throw new Error(`${who}: dedicated site`);

  if (!kernelSite) {
    const detected = detectDedicatedCapabilities({ manifestRaw: input.manifestRaw, paths: input.paths ?? [] });
    if (detected.declaredRawSql) return { kind: "refused", code: RAW_SQL_REFUSAL_CODE, reason: rawSqlRefusal([]).reason };
    if (detected.capabilities.length) return { kind: "dedicated_required", capabilities: detected.capabilities };
    if (detected.rawSql) return { kind: "refused", code: RAW_SQL_REFUSAL_CODE, reason: rawSqlRefusal(detected.sqlPaths).reason };
  }

  if (input.manifestRaw == null) {
    return mode === "static" ? { kind: "static" } : { kind: "invalid", errors: ["zavi-site.json is missing"] };
  }
  const v = validateWith(deps.manifest, input.manifestRaw);
  if (!v.ok) return { kind: "invalid", errors: validationErrors(v).slice(0, 20) };
  const lost = uncarriedParts(v.value);
  if (lost.length) {
    return { kind: "invalid", errors: [`zavi-site.json uses ${lost.slice(0, 5).join(", ")}, which this database cannot apply yet. Nothing was changed.`] };
  }
  const desired = collectionsVia(deps.manifest, v.value);
  const desiredContract = siteContractVia(deps.manifest, v.value);
  const v2 = usesV2(v.value);
  if (!desired.length && mode === "static" && !v2) return { kind: "static" };
  return { kernelSite, mode, hash: v.hash, desired, desiredContract, v2 };
}

async function fenceOnly(deps: Pick<PooledSiteDeps, "sql">, ref: string, site_id: string, generation: number): Promise<PooledApplyOutcome | null> {
  try {
    await deps.sql.query(ref, publishFenceOnlySql(site_id, generation));
    return null;
  } catch (e) {
    if (refusalFromError(e)?.code === LEASE_LOST_CODE) return LEASE_LOST;
    throw e;
  }
}

export async function reserveSitePublish(
  deps: PooledSiteDeps,
  input: { tenant_id: string; site: SiteRow; generation: number },
): Promise<"reserved" | "unplaced"> {
  if (input.site.tenant_id !== input.tenant_id) throw new Error("reserveSitePublish: site tenant mismatch");
  const shard = await existingShard(deps, input.site);
  if (!shard) return "unplaced";
  await reserveOn(deps, shard, input.site.id, input.generation);
  return "reserved";
}

async function reserveOn(deps: PooledSiteDeps, shard: ShardHandle, site_id: string, generation: number): Promise<void> {
  const ledger = await readLedger(deps.sql, shard.project_ref);
  if (!ledger.has(FENCE_SHARD_SCHEMA)) throw schemaMissing(deps, shard.project_ref, FENCE_SHARD_SCHEMA, shard.project_ref);
  await deps.sql.query(shard.project_ref, publishReserveSql(site_id, generation));
}

export const FENCE_SHARD_SCHEMA = "0011_site_publish_fence";

export const LEASE_LOST_CODE = "lease_lost";
const LEASE_LOST: Extract<PooledApplyOutcome, { kind: "refused" }> = {
  kind: "refused",
  code: LEASE_LOST_CODE,
  reason: "This publish no longer holds its commit lease, so its data model change was not applied.",
};

const V2_UNAVAILABLE: Extract<PooledApplyOutcome, { kind: "refused" }> = {
  kind: "refused",
  code: "v2_unavailable",
  reason:
    "This site's database does not support roles, unique rules, states, references, actions or aggregates yet. " +
    "Nothing was changed; the site keeps its current data model.",
};

async function existingShard(deps: Pick<PooledSiteDeps, "registry">, site: SiteRow): Promise<ShardHandle | null> {
  if (site.kernel_shard_id) return kernelShardOf(deps, site);
  if (!site.shard_id) return null;
  const row = await deps.registry.get(site.shard_id);
  if (!row?.project_ref || !row.url) throw new PooledBackendUnavailable("the site's shard is not in the registry");
  return { id: row.id, project_ref: row.project_ref, url: row.url };
}

export type PooledValidateOutcome =
  | Exclude<PooledApplyOutcome, { kind: "active" }>
  | { kind: "ok"; unchanged: boolean };

export async function validateSiteBackend(
  deps: Pick<PooledSiteDeps, "registry" | "sql" | "manifest">,
  input: { tenant_id: string; site: SiteRow; manifestRaw: unknown; paths?: readonly string[] },
): Promise<PooledValidateOutcome> {
  const p = prepareManifest(deps, input, "validateSiteBackend");
  if ("kind" in p) return p;
  const shard = await existingShard(deps, input.site);
  if (!shard) return { kind: "ok", unchanged: false };
  const ledger = await readLedger(deps.sql, shard.project_ref);
  const shardV2 = ledger.has(V2_SHARD_SCHEMA);
  if (p.v2 && !shardV2) return V2_UNAVAILABLE;
  const current = shardV2
    ? await readCollectionsV2(deps.sql, shard.project_ref, input.site.id)
    : await readCollections(deps.sql, shard.project_ref, input.site.id);
  const currentContract = shardV2 ? await readSiteContract(deps.sql, shard.project_ref, input.site.id) : EMPTY_SITE_CONTRACT;
  let unchanged: boolean;
  try {
    unchanged = shardV2
      ? !!currentContract && sitePlanIsEmpty(planSite(current, p.desired, currentContract, p.desiredContract))
      : planIsEmpty(planCollections(current, p.desired));
  } catch (e) {
    if (e instanceof CollectionPlanRefused) return { kind: "refused", reason: e.message };
    throw e;
  }
  const problems = nonAdditiveChanges(current, p.desired, currentContract ?? EMPTY_SITE_CONTRACT, shardV2 ? p.desiredContract : EMPTY_SITE_CONTRACT);
  if (problems.length) return { kind: "refused", code: NOT_ADDITIVE, reason: notAdditiveReason(problems) };
  return { kind: "ok", unchanged };
}

export async function applySiteBackend(
  deps: PooledSiteDeps,
  input: {
    tenant_id: string;
    site: SiteRow;
    manifestRaw: unknown;
    paths?: readonly string[];
    additiveOnly?: boolean;
    fence?: () => Promise<boolean>;
    generation?: number;
  },
): Promise<PooledApplyOutcome> {
  const { tenant_id, site } = input;
  const p = prepareManifest(deps, input, "applySiteBackend");
  if ("kind" in p) return p;
  const { kernelSite, desired, desiredContract, v2 } = p;
  const v = { hash: p.hash };
  if (!deps.auth) throw new PooledBackendUnavailable("site auth broker is not wired");

  if (input.fence && !(await input.fence())) return LEASE_LOST;

  const shard = kernelSite ? await kernelShardOf(deps, site) : (await deps.registry.place(tenant_id, site.id, deps.env())).shard;

  const ledger = await assertShardReady(deps, shard);
  const shardV2 = ledger.has(V2_SHARD_SCHEMA);
  if (v2 && !shardV2) return V2_UNAVAILABLE;
  if (input.generation !== undefined && !ledger.has(FENCE_SHARD_SCHEMA)) throw schemaMissing(deps, shard.project_ref, FENCE_SHARD_SCHEMA, shard.project_ref);

  await ensureShardSite(deps.sql, shard.project_ref, site.id);
  if (input.generation !== undefined) await reserveOn(deps, shard, site.id, input.generation);
  if (deps.siteSettings) {
    const s = await deps.siteSettings(site.id);
    if (s) await applyQuotaOverrides(deps.sql, shard.project_ref, site.id, s);
  }

  let plan: SitePlan | null = null;
  if (!shardV2) {
    let p1: CollectionPlan | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await readCollections(deps.sql, shard.project_ref, site.id);
      try {
        p1 = planCollections(current, desired);
      } catch (e) {
        if (e instanceof CollectionPlanRefused) return { kind: "refused", reason: e.message };
        throw e;
      }
      if (input.additiveOnly) {
        const problems = nonAdditiveChanges(current, desired, EMPTY_SITE_CONTRACT, EMPTY_SITE_CONTRACT);
        if (problems.length) return { kind: "refused", code: NOT_ADDITIVE, reason: notAdditiveReason(problems) };
      }
      if (planIsEmpty(p1)) {
        if (input.generation !== undefined) {
          const fenced = await fenceOnly(deps, shard.project_ref, site.id, input.generation);
          if (fenced) return fenced;
        }
        break;
      }
      try {
        if (input.fence && !(await input.fence())) return LEASE_LOST;
        await applyCollectionPlan(deps.sql, shard.project_ref, site.id, p1, current, input.generation);
        break;
      } catch (e) {
        const m = String((e as Error)?.message ?? e);
        if (/collections_changed/.test(m) && attempt === 0) continue;
        if (refusalFromError(e)?.code === LEASE_LOST_CODE) return LEASE_LOST;
        if (/collections_valid/.test(m)) return { kind: "refused", reason: "the database rejected a collection definition (rules, schema, fields or indexes)" };
        throw e;
      }
    }
    if (!p1) throw new Error("applySiteBackend: no plan");
    plan = { collections: p1, contract: { current: EMPTY_SITE_CONTRACT, desired: EMPTY_SITE_CONTRACT, changed: false }, changes: [], backfill: { uniques: [], states: [], references: [], recipients: [], counters: [], removedRoles: [] } };
  } else {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await readCollectionsV2(deps.sql, shard.project_ref, site.id);
      const currentContract = await readSiteContract(deps.sql, shard.project_ref, site.id);
      try {
        plan = planSite(current, desired, currentContract ?? EMPTY_SITE_CONTRACT, desiredContract);
      } catch (e) {
        if (e instanceof CollectionPlanRefused) return { kind: "refused", reason: e.message };
        throw e;
      }
      if (input.additiveOnly) {
        const problems = nonAdditiveChanges(current, desired, currentContract ?? EMPTY_SITE_CONTRACT, desiredContract);
        if (problems.length) return { kind: "refused", code: NOT_ADDITIVE, reason: notAdditiveReason(problems) };
      }
      if (sitePlanIsEmpty(plan) && currentContract) {
        if (input.generation !== undefined) {
          const fenced = await fenceOnly(deps, shard.project_ref, site.id, input.generation);
          if (fenced) return fenced;
        }
        break;
      }
      const holders = await roleHolders(deps.sql, shard.project_ref, site.id, plan.backfill.removedRoles);
      try {
        if (input.fence && !(await input.fence())) return LEASE_LOST;
        await deps.sql.query(shard.project_ref, applySitePlanSql(site.id, plan, current, currentContract, holders, v.hash, input.generation));
        if (holders.length && deps.roleAudit) {
          await deps.roleAudit({ tenant_id, site_id: site.id, manifest_hash: v.hash, shard_ref: shard.project_ref, holders }).catch((e: unknown) => {
            deps.log?.(`[site-shards] role audit pointer for site ${site.id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
          });
        }
        break;
      } catch (e) {
        const m = String((e as Error)?.message ?? e);
        if (/collections_changed/.test(m) && attempt < 2) continue;
        const refused = refusalFromError(e);
        if (refused) return { kind: "refused", reason: refused.message, code: refused.code };
        throw e;
      }
    }
  }
  if (!plan) throw new Error("applySiteBackend: no plan");

  if (input.fence && !(await input.fence())) return LEASE_LOST;

  const index_building: string[] = [];
  for (const p of await pendingReindexes(deps.sql, shard.project_ref, site.id)) {
    if (!(await reindexCollection(deps.sql, shard.project_ref, site.id, p.name))) index_building.push(p.name);
  }

  if (site.owner_email) {
    const { user_id } = await deps.auth.ensureFounderAdmin({ shard, site_id: site.id, email: site.owner_email });
    if (!(await isActiveAdmin(deps.sql, shard.project_ref, site.id, user_id))) {
      throw new PooledBackendUnavailable("founder admin membership did not verify");
    }
  }

  await deps.routes.ensure(site.hostname);

  if (input.fence && !(await input.fence())) return LEASE_LOST;
  let binding_version: number;
  try {
    binding_version = await syncHostRecord(hostDeps(deps), {
      tenant_id,
      site_id: site.id,
      binding: { shard_id: shard.project_ref, shard_url: shard.url, status: "active", manifest_hash: v.hash },
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
    });
  } catch (e) {
    if (/stale_generation/.test(String((e as Error)?.message ?? e))) return LEASE_LOST;
    throw e;
  }
  return { kind: "active", shard, manifest_hash: v.hash, binding_version, plan: plan.collections, changes: plan.changes, index_building };
}

export async function pooledOwnerMagicLink(
  deps: PooledSiteDeps,
  input: { tenant_id: string; site: SiteRow; email: string; redirect_to: string },
): Promise<string> {
  if (input.site.tenant_id !== input.tenant_id) throw new Error("pooledOwnerMagicLink: site tenant mismatch");
  if (!deps.auth) throw new PooledBackendUnavailable("site auth broker is not wired");
  let shard: ShardHandle;
  if (input.site.kernel_shard_id) {
    shard = await kernelShardOf(deps, input.site);
  } else {
    const row = input.site.shard_id ? await deps.registry.get(input.site.shard_id) : null;
    if (!row?.project_ref || !row.url) throw new PooledBackendUnavailable("site is not on a shard");
    shard = { id: row.id, project_ref: row.project_ref, url: row.url };
  }
  return deps.auth.ownerMagicLink({ shard, site_id: input.site.id, email: input.email, redirect_to: input.redirect_to });
}

export const POOLED_DELETE_BUCKET = "site_delete:pooled";

async function retireKernelShard(deps: PooledSiteDeps, input: { tenant_id: string; site: SiteRow }): Promise<"deleted" | "absent"> {
  const { tenant_id, site } = input;
  const ref = await deps.registry.kernelRef(tenant_id, site.id);
  if (!ref) {
    await deps.registry.retireKernel(tenant_id, site.id);
    return "absent";
  }
  await syncHostRecord(hostDeps(deps), {
    tenant_id,
    site_id: site.id,
    binding: {
      shard_id: ref,
      shard_url: `https://${ref}.supabase.co`,
      status: "tombstoned",
      manifest_hash: String(site.gateway_binding?.manifest_hash ?? ""),
    },
  });
  await deps.routes.remove(site.hostname);
  if (!deps.kv.delete) throw new PooledBackendUnavailable("kv cannot delete keys");
  await deps.kv.delete(shardKvKey(ref));
  if (!deps.signer?.remove) throw new PooledBackendUnavailable("signer key store is not wired");
  await deps.signer.remove(ref);
  await deps.registry.retireKernel(tenant_id, site.id);
  return "deleted";
}

export async function deleteSiteBackend(
  deps: PooledSiteDeps,
  input: { tenant_id: string; site: SiteRow },
): Promise<"deleted" | "absent" | "refused"> {
  const { tenant_id, site } = input;
  if (site.tenant_id !== tenant_id) throw new Error("deleteSiteBackend: site tenant mismatch");
  const kernelRef = typeof deps.registry.kernelRef === "function" ? await deps.registry.kernelRef(tenant_id, site.id) : null;
  if (!site.shard_id && !site.kernel_shard_id && !kernelRef) return "absent";

  const guard = deps.deleteGuard;
  let allowed = false;
  let detail = `phase=pooled limit=${guard.maxPerHour}/h`;
  try {
    allowed = (await guard.tick(POOLED_DELETE_BUCKET, guard.maxPerHour, 3600)) === true;
  } catch (e) {
    detail += ` counter_unavailable: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
  }
  if (!allowed) {
    await reportDeleteRefusal(guard, "sites.delete.circuit_open", { tenant_id, site_id: site.id, detail });
    return "refused";
  }

  if (!site.shard_id) return retireKernelShard(deps, input);

  const row = await deps.registry.get(site.shard_id);
  if (!row?.project_ref || !row.url) throw new Error("deleteSiteBackend: shard not found");
  const shard: ShardHandle = { id: row.id, project_ref: row.project_ref, url: row.url };
  const ref = shard.project_ref;

  await markShardSiteDeleting(deps.sql, ref, site.id);
  await syncHostRecord(hostDeps(deps), {
    tenant_id,
    site_id: site.id,
    binding: {
      shard_id: shard.project_ref,
      shard_url: shard.url,
      status: "tombstoned",
      manifest_hash: String(site.gateway_binding?.manifest_hash ?? ""),
    },
  });
  await deps.routes.remove(site.hostname);

  await purgeShardSiteData(deps, shard, site.id, row.name);

  await deps.registry.release(tenant_id, site.id, "static");
  if (kernelRef) await retireKernelShard(deps, input);
  return "deleted";
}

export async function purgeShardSiteData(
  deps: Pick<PooledSiteDeps, "sql" | "storage" | "auth">,
  shard: ShardHandle,
  site_id: string,
  label: string,
): Promise<void> {
  const ref = shard.project_ref;
  const files = await deps.storage.list(shard, `${site_id}/`);
  if (files.some((f) => !f.startsWith(`${site_id}/`))) throw new Error("purgeShardSiteData: storage listing escaped the site prefix");
  if (files.length) await deps.storage.remove(shard, files);

  for (let i = 0; i < 100_000; i++) {
    if ((await deleteRecordBatch(deps.sql, ref, site_id)) === 0) break;
  }

  const users = await siteAuthUserIds(deps.sql, ref, site_id);
  if (users.length && !deps.auth) throw new PooledBackendUnavailable("site auth broker is not wired");
  for (const auth_user_id of users) await deps.auth!.deleteAuthUser({ shard, auth_user_id });

  await deleteShardSiteRows(deps.sql, ref, site_id);

  const left = await shardSiteLeftovers(deps.sql, ref, site_id);
  const leftFiles = await deps.storage.list(shard, `${site_id}/`);
  const remaining = Object.entries(left).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`);
  if (leftFiles.length) remaining.push(`files=${leftFiles.length}`);
  if (remaining.length) throw new Error(`deleteSiteBackend: leftovers on ${label}: ${remaining.join(", ")}`);
}

export async function exportSiteBackend(
  deps: Pick<PooledSiteDeps, "registry" | "sql" | "storage">,
  input: { tenant_id: string; site: SiteRow },
  write: (chunk: string) => Promise<void>,
): Promise<{ records: number; files: number; members: number; sha256: string }> {
  const { tenant_id, site } = input;
  if (site.tenant_id !== tenant_id) throw new Error("exportSiteBackend: site tenant mismatch");
  if (!site.shard_id) throw new Error("exportSiteBackend: site is not on a shard");
  const row = await deps.registry.get(site.shard_id);
  if (!row?.project_ref || !row.url) throw new Error("exportSiteBackend: shard not found");
  const shard: ShardHandle = { id: row.id, project_ref: row.project_ref, url: row.url };
  let end: { counts: { records: number; files: number; members: number }; sha256: string } | null = null;
  for await (const line of exportSiteV2Lines({
    sql: deps.sql,
    project_ref: shard.project_ref,
    site_id: site.id,
    listFiles: () => deps.storage.list(shard, `${site.id}/`),
  })) {
    if (line.t === "end") end = line;
    await write(`${JSON.stringify(line)}\n`);
  }
  if (!end) throw new Error("exportSiteBackend: export did not finish");
  return { records: end.counts.records, files: end.counts.files, members: end.counts.members, sha256: end.sha256 };
}

