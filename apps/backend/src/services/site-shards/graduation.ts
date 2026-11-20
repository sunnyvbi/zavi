
import type { SiteRow } from "@/services/sites/contract";
import type { SiteDeleteGuard } from "@/services/sites/delete-guard";
import { hostKey, syncHostRecord, type HostSyncDeps, type KvStore } from "@/services/sites/host-record";
import { asTenantId, tenantRpc, siteShardRpc, type TenantId } from "@/services/tenant-client";
import type { PooledSiteAuth, ShardHandle, ShardSql, ShardStorage } from "./contract";
import type { DedicatedCapability } from "./capabilities";
import { exportSiteV2, hashSite, type ExportSource, type SiteImporter } from "./export-v2";
import { purgeShardSiteData } from "./pooled-site";
import type { ShardRegistry } from "./registry";
import { shardSiteDrained, suspendShardSite, unsuspendShardSite } from "./shard-ops";
import { readLedger } from "./migrations";
import { V2_SHARD_SCHEMA } from "./contract";
import { isUuid } from "./sql";

export type GraduationState =
  | "requested"
  | "suspended"
  | "project_ready"
  | "imported"
  | "verified"
  | "switched"
  | "archived"
  | "rolled_back"
  | "build_dedicated";
export type GraduationReason = "capability" | "founder" | "staff" | "load" | "size";

export type GraduationRow = {
  site_id: string;
  tenant_id: string;
  state: GraduationState;
  reason: GraduationReason;
  capabilities: string[];
  source_shard_id: string | null;
  source_project_ref: string | null;
  target_project_ref: string | null;
  target_url: string | null;
  counts: Record<string, number>;
  sha256: string | null;
  attempts: number;
  last_error: string | null;
  archive_after: string | null;
  switched_at: string | null;
  frozen_at?: string | null;
};

export type GraduationPatch = Partial<Pick<GraduationRow, "target_project_ref" | "target_url" | "counts" | "sha256" | "last_error" | "archive_after" | "frozen_at">>;

export interface GraduationStore {
  request(tenant_id: string, site_id: string, reason: GraduationReason, capabilities: string[]): Promise<GraduationRow>;
  requestBySite(site_id: string, reason: "load" | "size" | "staff"): Promise<GraduationRow | null>;
  status(site_id: string): Promise<GraduationRow | null>;
  get(tenant_id: string, site_id: string): Promise<GraduationRow | null>;
  claim(tenant_id: string, site_id: string, leaseSeconds: number): Promise<GraduationRow | null>;
  advance(tenant_id: string, site_id: string, from: GraduationState, to: GraduationState, patch?: GraduationPatch): Promise<GraduationRow | null>;
  switchOver(tenant_id: string, site_id: string, expectedHostVersion: number, binding: NonNullable<SiteRow["gateway_binding"]>, archiveAfter: string): Promise<SiteRow>;
  due(limit: number): Promise<Array<{ tenant_id: string; site_id: string; state: GraduationState }>>;
  dedicateStatic(tenant_id: string, site_id: string, capabilities: string[]): Promise<SiteRow>;
  auditPointer(tenant_id: string, site_id: string, manifest_hash: string, shard_ref: string, demoted: number): Promise<number>;
}

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };
export type GraduationStoreDeps = {
  tenantRpc: (tid: TenantId, name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  platformRpc: (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
};

export class HostVersionConflict extends Error {
  constructor() {
    super("host_version_conflict");
    this.name = "HostVersionConflict";
  }
}

function firstRow<T>(data: unknown): T | null {
  const r = Array.isArray(data) ? data[0] : data;
  return r && typeof r === "object" && isUuid((r as { site_id?: unknown; id?: unknown }).site_id ?? (r as { id?: unknown }).id) ? (r as T) : null;
}

export function createGraduationStore(
  deps: GraduationStoreDeps = {
    tenantRpc: (tid, name, args) => tenantRpc(tid, name, args) as unknown as PromiseLike<RpcResult>,
    platformRpc: (name, args) => siteShardRpc(name, args) as unknown as PromiseLike<RpcResult>,
  },
): GraduationStore {
  async function site(tenant_id: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isUuid(tenant_id) || !isUuid(args.p_site_id)) throw new Error(`GraduationStore: ${name} needs uuids`);
    const { data, error } = await deps.tenantRpc(asTenantId(tenant_id), name, args);
    if (error) {
      if (/host_version_conflict/.test(error.message ?? "")) throw new HostVersionConflict();
      throw new Error(`GraduationStore: ${name} failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown error"}`);
    }
    return data;
  }
  async function platform(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await deps.platformRpc(name, args);
    if (error) throw new Error(`GraduationStore: ${name} failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown error"}`);
    return data;
  }
  return {
    async request(tenant_id, site_id, reason, capabilities) {
      const r = firstRow<GraduationRow>(await site(tenant_id, "site_graduation_request", { p_site_id: site_id, p_reason: reason, p_capabilities: capabilities }));
      if (!r) throw new Error("GraduationStore: site_graduation_request returned no row");
      return r;
    },
    async requestBySite(site_id, reason) {
      if (!isUuid(site_id)) return null;
      return firstRow<GraduationRow>(await platform("site_graduation_request_by_site", { p_site_id: site_id, p_reason: reason }));
    },
    async status(site_id) {
      if (!isUuid(site_id)) return null;
      return firstRow<GraduationRow>(await platform("site_graduation_status", { p_site_id: site_id }));
    },
    async get(tenant_id, site_id) {
      return firstRow<GraduationRow>(await site(tenant_id, "site_graduation_get", { p_site_id: site_id }));
    },
    async claim(tenant_id, site_id, leaseSeconds) {
      return firstRow<GraduationRow>(await site(tenant_id, "site_graduation_claim", { p_site_id: site_id, p_lease_seconds: leaseSeconds }));
    },
    async advance(tenant_id, site_id, from, to, patch = {}) {
      return firstRow<GraduationRow>(await site(tenant_id, "site_graduation_advance", { p_site_id: site_id, p_from: from, p_to: to, p_patch: patch }));
    },
    async switchOver(tenant_id, site_id, expectedHostVersion, binding, archiveAfter) {
      const r = firstRow<SiteRow>(
        await site(tenant_id, "site_graduation_switch", {
          p_site_id: site_id,
          p_expected_host_version: expectedHostVersion,
          p_binding: binding,
          p_archive_after: archiveAfter,
        }),
      );
      if (!r || r.tenant_id !== tenant_id) throw new Error("GraduationStore: site_graduation_switch returned no row");
      return r;
    },
    async due(limit) {
      const data = await platform("site_graduation_due", { p_limit: limit });
      return (Array.isArray(data) ? data : []).filter(
        (r): r is { tenant_id: string; site_id: string; state: GraduationState } => isUuid((r as { site_id?: unknown })?.site_id) && isUuid((r as { tenant_id?: unknown })?.tenant_id),
      );
    },
    async dedicateStatic(tenant_id, site_id, capabilities) {
      const r = firstRow<SiteRow>(await site(tenant_id, "site_backend_dedicate_static", { p_site_id: site_id, p_capabilities: capabilities }));
      if (!r || r.tenant_id !== tenant_id) throw new Error("GraduationStore: site_backend_dedicate_static returned no row");
      return r;
    },
    async auditPointer(tenant_id, site_id, manifest_hash, shard_ref, demoted) {
      return Number(await site(tenant_id, "site_member_role_audit_record", { p_site_id: site_id, p_manifest_hash: manifest_hash, p_shard_ref: shard_ref, p_demoted: demoted })) || 0;
    },
  };
}

export const GRADUATION_LEASE_SECONDS = 1800;
export const UPLOAD_TOKEN_TTL_MS = 600_000;
export const GRADUATION_MAX_ATTEMPTS = 8;

export type GraduationDeps = {
  store: GraduationStore;
  registry: Pick<ShardRegistry, "get">;
  sql: ShardSql;
  storage: ShardStorage;
  auth: PooledSiteAuth | null;
  kv: KvStore;
  bumpHost: HostSyncDeps["bump"];
  getSite: HostSyncDeps["get"];
  requestHostVerify?: HostSyncDeps["requestVerify"];
  importer: SiteImporter;
  ensureDedicatedProject: (input: { tenant_id: string; site_id: string }) => Promise<{ project_ref: string; url: string }>;
  prepareKernel: ((input: { tenant_id: string; site_id: string; project_ref: string; region: string }) => Promise<void>) | null;
  ready?: () => boolean;
  deleteGuard: SiteDeleteGuard;
  graceDays: () => Promise<number>;
  alert?: (msg: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  drainTimeoutMs?: number;
  uploadTokenTtlMs?: number;
  sourceLedger?: (project_ref: string) => Promise<Set<string>>;
  ops?: Partial<GraduationOps>;
  log?: (l: string) => void;
};

export type GraduationOps = {
  suspend: (sql: ShardSql, ref: string, site_id: string) => Promise<string>;
  drained: (sql: ShardSql, ref: string, frozen_at: string) => Promise<boolean>;
  unsuspend: (sql: ShardSql, ref: string, site_id: string) => Promise<void>;
  exporter: (src: ExportSource) => AsyncIterable<Uint8Array>;
  hash: (src: ExportSource) => Promise<{ counts: { records: number }; sha256: string }>;
  purge: (deps: GraduationDeps, shard: ShardHandle, site_id: string, label: string) => Promise<void>;
};

const DEFAULT_OPS: GraduationOps = {
  suspend: suspendShardSite,
  drained: shardSiteDrained,
  unsuspend: unsuspendShardSite,
  exporter: exportSiteV2,
  hash: hashSite,
  purge: (deps, shard, site_id, label) => purgeShardSiteData(deps, shard, site_id, label),
};
const opsOf = (deps: GraduationDeps): GraduationOps => ({ ...DEFAULT_OPS, ...deps.ops });

export type GraduationOutcome =
  | { kind: "unavailable"; reason: string }
  | { kind: "busy" }
  | { kind: "draining" }
  | { kind: "switched" }
  | { kind: "archived" }
  | { kind: "rolled_back"; reason: string }
  | { kind: "error"; state: GraduationState; error: string };

export function graduationAvailable(deps: Pick<GraduationDeps, "importer" | "prepareKernel" | "ready">): boolean {
  return deps.importer.available() && !!deps.prepareKernel && (deps.ready ? deps.ready() : true);
}

export const NO_IMPORTER: SiteImporter = {
  available: () => false,
  import: async () => {
    throw new Error("site importer is not wired");
  },
};

async function sourceShard(deps: GraduationDeps, g: GraduationRow): Promise<ShardHandle & { name: string; region: string }> {
  const row = g.source_shard_id ? await deps.registry.get(g.source_shard_id) : null;
  if (!row?.project_ref || !row.url || row.project_ref !== g.source_project_ref) throw new Error("graduation: source shard not found");
  return { id: row.id, project_ref: row.project_ref, url: row.url, name: row.name, region: row.region };
}

const source = (deps: GraduationDeps, shard: ShardHandle, site_id: string): ExportSource => ({
  sql: deps.sql,
  project_ref: shard.project_ref,
  site_id,
  listFiles: () => deps.storage.list(shard, `${site_id}/`),
});

const target = (deps: GraduationDeps, project_ref: string, site_id: string): ExportSource => ({
  sql: deps.sql,
  project_ref,
  site_id,
  listFiles: () => deps.storage.list({ id: project_ref, project_ref, url: `https://${project_ref}.supabase.co` }, `${site_id}/`),
});

async function kvServes(deps: GraduationDeps, site: SiteRow): Promise<boolean> {
  const raw = await deps.kv.get(hostKey(site.hostname));
  if (!raw) return false;
  try {
    return Number((JSON.parse(raw) as { rv?: unknown }).rv) === (site.host_version ?? 0);
  } catch {
    return false;
  }
}

export async function rollbackGraduation(deps: GraduationDeps, tenant_id: string, site_id: string, reason: string): Promise<GraduationOutcome> {
  const g = await deps.store.get(tenant_id, site_id);
  if (!g) return { kind: "rolled_back", reason };
  if (!["requested", "suspended", "project_ready", "imported", "verified"].includes(g.state)) {
    throw new Error(`graduation: cannot roll back from ${g.state}`);
  }
  const shard = await sourceShard(deps, g);
  await opsOf(deps).unsuspend(deps.sql, shard.project_ref, site_id);
  await deps.store.advance(tenant_id, site_id, g.state, "rolled_back", { last_error: reason.slice(0, 500) });
  await deps.alert?.(`site graduation rolled back tenant=${tenant_id} site=${site_id}: ${reason.slice(0, 300)}`).catch(() => undefined);
  return { kind: "rolled_back", reason };
}

export async function advanceGraduation(deps: GraduationDeps, input: { tenant_id: string; site_id: string }): Promise<GraduationOutcome> {
  const { tenant_id, site_id } = input;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ops = opsOf(deps);
  if (!graduationAvailable(deps)) {
    const cur = await deps.store.get(tenant_id, site_id);
    if (!cur || cur.state === "requested") return { kind: "unavailable", reason: "graduation is not available yet" };
  }
  let g = await deps.store.claim(tenant_id, site_id, GRADUATION_LEASE_SECONDS);
  if (!g) return { kind: "busy" };
  if (g.tenant_id !== tenant_id) throw new Error("graduation: tenant mismatch");
  if (g.attempts > GRADUATION_MAX_ATTEMPTS && ["requested", "project_ready", "suspended", "imported", "verified"].includes(g.state)) {
    return rollbackGraduation(deps, tenant_id, site_id, g.last_error ?? "too many attempts");
  }

  const step = async (from: GraduationState, to: GraduationState, patch?: GraduationPatch) => {
    const next = await deps.store.advance(tenant_id, site_id, from, to, patch);
    if (!next) throw new Error(`graduation: state moved under the runner (expected ${from})`);
    g = next;
  };

  try {
    for (let guard = 0; guard < 12; guard++) {
      const cur: GraduationRow = g;
      switch (cur.state) {
        case "requested": {
          if (!graduationAvailable(deps)) {
            await deps.store.advance(tenant_id, site_id, "requested", "requested", { last_error: "graduation is not available yet (importer / kernel preparation not wired)" });
            return { kind: "unavailable", reason: "graduation is not available yet" };
          }
          if (cur.attempts > GRADUATION_MAX_ATTEMPTS) return rollbackGraduation(deps, tenant_id, site_id, cur.last_error ?? "too many attempts");
          const shard = await sourceShard(deps, cur);
          const ledger = await (deps.sourceLedger ?? ((ref: string) => readLedger(deps.sql, ref)))(shard.project_ref);
          if (!ledger.has(V2_SHARD_SCHEMA)) {
            await deps.store.advance(tenant_id, site_id, "requested", "requested", { last_error: `source shard ${shard.name} lacks ${V2_SHARD_SCHEMA}: roll it out first` });
            await deps.alert?.(`site graduation waits for a schema rollout: shard ${shard.name} lacks ${V2_SHARD_SCHEMA} (site ${site_id})`).catch(() => undefined);
            return { kind: "unavailable", reason: "the source shard needs the v2 schema first" };
          }
          const p = await deps.ensureDedicatedProject({ tenant_id, site_id });
          await deps.prepareKernel!({ tenant_id, site_id, project_ref: p.project_ref, region: shard.region });
          await step("requested", "project_ready", { target_project_ref: p.project_ref, target_url: p.url });
          break;
        }
        case "project_ready": {
          const shard = await sourceShard(deps, cur);
          const frozenAt = await ops.suspend(deps.sql, shard.project_ref, site_id);
          const deadline = now() + (deps.drainTimeoutMs ?? 60_000);
          while (!(await ops.drained(deps.sql, shard.project_ref, frozenAt))) {
            if (now() > deadline) {
              await deps.store.advance(tenant_id, site_id, "project_ready", "project_ready", { last_error: "waiting for in-flight writes to finish" });
              return { kind: "draining" };
            }
            await sleep(1_000);
          }
          await step("project_ready", "suspended", { frozen_at: new Date(now()).toISOString() });
          break;
        }
        case "suspended": {
          const ttl = deps.uploadTokenTtlMs ?? UPLOAD_TOKEN_TTL_MS;
          const frozen = cur.frozen_at ? Date.parse(cur.frozen_at) : NaN;
          const until = (Number.isFinite(frozen) ? frozen : now()) + ttl;
          if (!Number.isFinite(frozen)) await deps.store.advance(tenant_id, site_id, "suspended", "suspended", { frozen_at: new Date(now()).toISOString() });
          while (now() < until) await sleep(Math.min(until - now(), 30_000));
          const shard = await sourceShard(deps, cur);
          const ref = cur.target_project_ref as string;
          const res = await deps.importer.import({ tenant_id, site_id, project_ref: ref, dump: ops.exporter(source(deps, shard, site_id)) });
          await step("suspended", "imported", {
            sha256: res.sha256,
            counts: { records: res.records, files: res.files, members: res.members },
          });
          break;
        }
        case "imported": {
          const shard = await sourceShard(deps, cur);
          const [a, b] = await Promise.all([
            ops.hash(source(deps, shard, site_id)),
            ops.hash(target(deps, cur.target_project_ref as string, site_id)),
          ]);
          if (a.sha256 !== b.sha256 || a.sha256 !== cur.sha256) {
            if (cur.attempts > GRADUATION_MAX_ATTEMPTS) return rollbackGraduation(deps, tenant_id, site_id, "the dedicated copy never matched the pooled copy");
            await step("imported", "suspended", { last_error: `verify mismatch: pooled ${a.counts.records} records, dedicated ${b.counts.records}` });
            return { kind: "error", state: "imported", error: "verify mismatch; re-importing on the next pass" };
          }
          await step("imported", "verified", { counts: { ...(a.counts as Record<string, number>) } });
          break;
        }
        case "verified": {
          const grace = Math.max(0, Math.min(90, Math.floor(await deps.graceDays())));
          const archiveAfter = new Date(now() + grace * 86_400_000).toISOString();
          let switched: SiteRow | null = null;
          for (let i = 0; i < 5 && !switched; i++) {
            const site = await deps.getSite(tenant_id, site_id);
            if (!site) throw new Error("graduation: site is gone");
            const binding = {
              shard_id: cur.target_project_ref as string,
              shard_url: cur.target_url as string,
              status: "active" as const,
              manifest_hash: String(site.gateway_binding?.manifest_hash ?? ""),
            };
            try {
              switched = await deps.store.switchOver(tenant_id, site_id, site.host_version ?? 0, binding, archiveAfter);
            } catch (e) {
              if (!(e instanceof HostVersionConflict)) throw e;
            }
          }
          if (!switched) throw new Error("graduation: the host record kept changing; retrying later");
          await syncHostRecord({ kv: deps.kv, bump: deps.bumpHost, get: deps.getSite, requestVerify: deps.requestHostVerify }, { tenant_id, site_id });
          g = (await deps.store.get(tenant_id, site_id)) ?? g;
          break;
        }
        case "switched": {
          const site = await deps.getSite(tenant_id, site_id);
          if (site && !(await kvServes(deps, site))) {
            await syncHostRecord({ kv: deps.kv, bump: deps.bumpHost, get: deps.getSite, requestVerify: deps.requestHostVerify }, { tenant_id, site_id });
          }
          if (!cur.archive_after || Date.parse(cur.archive_after) > now()) return { kind: "switched" };
          const allowed = (await deps.deleteGuard.tick("site_delete:pooled", deps.deleteGuard.maxPerHour, 3600).catch(() => false)) === true;
          if (!allowed) return { kind: "switched" };
          const shard = await sourceShard(deps, cur);
          await ops.purge(deps, shard, site_id, shard.name);
          await step("switched", "archived");
          return { kind: "archived" };
        }
        case "archived":
          return { kind: "archived" };
        case "rolled_back":
          return { kind: "rolled_back", reason: cur.last_error ?? "" };
        default:
          return { kind: "error", state: cur.state, error: "nothing to do" };
      }
    }
    return { kind: "error", state: g.state, error: "too many steps in one pass" };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 400);
    deps.log?.(`[site-graduation] tenant=${tenant_id} site=${site_id} state=${g.state}: ${msg}`);
    await deps.store.advance(tenant_id, site_id, g.state, g.state, { last_error: msg }).catch(() => undefined);
    if (g.attempts >= GRADUATION_MAX_ATTEMPTS - 1) {
      await deps.alert?.(`site graduation stuck tenant=${tenant_id} site=${site_id} state=${g.state}: ${msg}`).catch(() => undefined);
    }
    return { kind: "error", state: g.state, error: msg };
  }
}

export async function requestGraduation(
  deps: Pick<GraduationDeps, "store" | "importer" | "prepareKernel" | "ready" | "alert">,
  input: { tenant_id: string; site: SiteRow; reason: GraduationReason; capabilities: DedicatedCapability[] | string[] },
): Promise<{ row: GraduationRow; available: boolean }> {
  const { tenant_id, site } = input;
  if (site.tenant_id !== tenant_id) throw new Error("requestGraduation: site tenant mismatch");
  const row = await deps.store.request(tenant_id, site.id, input.reason, [...input.capabilities]);
  const available = graduationAvailable(deps);
  if (!available) {
    await deps.alert?.(`site needs graduation but it is not available: tenant=${tenant_id} site=${site.id} reason=${input.reason} caps=${input.capabilities.join(",")}`).catch(() => undefined);
  }
  return { row, available };
}

export async function resumeGraduations(deps: GraduationDeps, limit = 20): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const d of await deps.store.due(limit)) {
    const r = await advanceGraduation(deps, d).catch((e: unknown): GraduationOutcome => ({ kind: "error", state: d.state, error: String(e) }));
    out[r.kind] = (out[r.kind] ?? 0) + 1;
  }
  return out;
}

export function kickGraduation(deps: GraduationDeps, input: { tenant_id: string; site_id: string }): void {
  void advanceGraduation(deps, input).catch((e: unknown) => {
    deps.log?.(`[site-graduation] kick tenant=${input.tenant_id} site=${input.site_id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  });
}
