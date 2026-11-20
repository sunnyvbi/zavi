
import type { SiteRow, SiteStarterProvider } from "@/services/sites/contract";
import { defaultSiteDeleteGuard } from "@/services/sites/delete-guard";
import type { PooledSiteAuth, SiteManifestPackage } from "./contract";
import { cloudflareKv } from "./gateway-kv";
import { bumpHostVersion, requestHostVerify } from "@/services/sites/host-record";
import { siteStore } from "@/services/sites/store";
import { cloudflareGatewayRoutes } from "./gateway-route";
import {
  applySiteBackend,
  reserveSitePublish,
  deleteSiteBackend,
  pooledOwnerMagicLink,
  validateSiteBackend,
  type PooledApplyOutcome,
  type PooledSiteDeps,
  type PooledValidateOutcome,
} from "./pooled-site";
import { shardEnv, shardRegistry } from "./registry";
import { requestSchemaRepair } from "./auto-rollout";
import { createPooledReadiness, type PooledReadiness } from "./readiness";
import { defaultPooledSeams } from "./default-seams";
import { createShardMgmt, type ShardMgmt } from "./shard-mgmt";
import { createShardStorage } from "./shard-storage";
import { SiteCredentialsMissing } from "@/services/sites/contract";
import type { KvStore } from "@/services/sites/host-record";
import { sealedKvKeyStore, workerSecretKeyStore, type ShardKeyStore } from "./shard-keys";
import type { DedicatedCapability } from "./capabilities";
import { getSiteBackendSettings } from "./site-settings";
import { reserveLegacyDedication } from "./kernel-provision";
import {
  createGraduationStore,
  NO_IMPORTER,
  kickGraduation,
  requestGraduation,
  resumeGraduations,
  type GraduationDeps,
} from "./graduation";

export type DedicatedMove =
  | { kind: "dedicated" }
  | { kind: "graduating"; available: boolean }
  | { kind: "already_dedicated" };

export interface PooledBackend {
  enabledFor(tenant_id: string): Promise<boolean>;
  starter(): Promise<SiteStarterProvider | null>;
  initStatic(tenant_id: string, site_id: string): Promise<void>;
  validate(input: { tenant_id: string; site: SiteRow; manifestRaw: unknown; paths?: readonly string[] }): Promise<PooledValidateOutcome>;
  apply(input: { tenant_id: string; site: SiteRow; manifestRaw: unknown; paths?: readonly string[]; additiveOnly?: boolean; fence?: () => Promise<boolean>; generation?: number }): Promise<PooledApplyOutcome>;
  reserve(input: { tenant_id: string; site: SiteRow; generation: number }): Promise<"reserved" | "unplaced">;
  ownerMagicLink(input: { tenant_id: string; site: SiteRow; email: string; redirect_to: string }): Promise<string>;
  deleteBackend(input: { tenant_id: string; site: SiteRow }): Promise<"deleted" | "absent" | "refused">;
  moveToDedicated(input: { tenant_id: string; site: SiteRow; capabilities: DedicatedCapability[] }): Promise<DedicatedMove>;
  kernelSqlAllowed?(input: { tenant_id: string; site: SiteRow }): Promise<boolean>;
}

export type PooledSeams = {
  manifest: SiteManifestPackage | null;
  auth: PooledSiteAuth | null;
  starter: SiteStarterProvider | null;
  resumeDeletions: ((project_ref: string) => Promise<number>) | null;
  graduation?: Pick<GraduationDeps, "importer" | "prepareKernel" | "ready"> | null;
};

let seams: PooledSeams | null = null;

export function pooledSeams(): PooledSeams {
  return (seams ??= defaultPooledSeams());
}
export function setPooledSeams(patch: Partial<PooledSeams>): void {
  seams = { ...pooledSeams(), ...patch };
}
export function resetPooledSeams(): void {
  seams = null;
}

let _readiness: PooledReadiness | null = null;
export function pooledReadiness(): PooledReadiness {
  return (_readiness ??= createPooledReadiness({
    env: () => process.env,
    seams: () => pooledSeams(),
    shardEnv: () => shardEnv(),
    placement: (env) => shardRegistry().placementReadiness(env),
    requestMetricsSweep: async (env) => {
      const { isCanonicalContainer } = await import("@/services/agents/boot-role");
      if (process.env.NODE_ENV !== "production" || !isCanonicalContainer()) return;
      const { requestShardMetricsSweep } = await import("@/../workers/functions/site-shards-metrics");
      await requestShardMetricsSweep({ env, reason: "readiness_stale" });
    },
    alert: async (msg) => {
      const { alert } = await import("@/services/logging/alert");
      await alert({ msg, source: "site-shards", code: "sites.pooled_unavailable" });
    },
  }));
}
export function resetPooledReadiness(): void {
  _readiness = null;
}

export function signerStore(env: Record<string, string | undefined> = process.env, kv: KvStore = cloudflareKv()): ShardKeyStore {
  const kek = (env.SITE_SIGNER_KEK_PUBLIC_JWK ?? "").trim();
  const sealed = sealedKvKeyStore({ kv, kekPublicJwk: () => JSON.parse(kek) });
  const worker = workerSecretKeyStore({ env });
  return {
    put: (ref, jwk) => (kek ? sealed.put(ref, jwk) : worker.put(ref, jwk)),
    async remove(ref) {
      await sealed.remove!(ref);
      try {
        await worker.remove!(ref);
      } catch (e) {
        if (!(e instanceof SiteCredentialsMissing)) throw e;
      }
    },
  };
}

let _mgmt: ShardMgmt | null = null;
const mgmt = () => (_mgmt ??= createShardMgmt());

function deps(): PooledSiteDeps {
  const sql = { query: (ref: string, q: string) => mgmt().query(ref, q) };
  return {
    registry: shardRegistry(),
    sql,
    storage: createShardStorage({
      sql,
      serviceKey: async (ref) => {
        const { createSupabaseMgmt } = await import("@/services/sites/supabase-mgmt");
        return (await createSupabaseMgmt().apiKeys(ref)).service_role;
      },
    }),
    kv: cloudflareKv(),
    bumpHost: bumpHostVersion,
    getSite: (t, id) => siteStore().get(t, id),
    requestHostVerify,
    routes: cloudflareGatewayRoutes(),
    manifest: pooledSeams().manifest,
    auth: pooledSeams().auth,
    env: () => shardEnv(),
    deleteGuard: defaultSiteDeleteGuard(),
    siteSettings: (site_id) => getSiteBackendSettings(site_id),
    signer: signerStore(),
    onShardSchemaMissing: (ref, version) => requestSchemaRepair(ref, version),
    roleAudit: ({ tenant_id, site_id, manifest_hash, shard_ref, holders }) =>
      createGraduationStore().auditPointer(tenant_id, site_id, manifest_hash, shard_ref, holders.length).then(() => undefined),
    log: (l) => console.warn(l),
  };
}

export function pooledSiteDeps(): PooledSiteDeps {
  return deps();
}

export function graduationDeps(): GraduationDeps {
  const d = deps();
  const g = pooledSeams().graduation;
  return {
    store: createGraduationStore(),
    registry: d.registry,
    sql: d.sql,
    storage: d.storage,
    auth: d.auth,
    kv: d.kv,
    bumpHost: d.bumpHost,
    getSite: d.getSite,
    requestHostVerify: d.requestHostVerify,
    importer: g?.importer ?? NO_IMPORTER,
    prepareKernel: g?.prepareKernel ?? null,
    ready: g?.ready,
    ensureDedicatedProject: async (i) => {
      const { supabaseSiteProvisioner } = await import("@/services/sites/supabase-site-provisioner");
      return supabaseSiteProvisioner().ensureProject(i);
    },
    deleteGuard: d.deleteGuard,
    graceDays: async () => (await import("@/services/settings")).getNumberSetting("site_graduation_grace_days"),
    alert: async (msg) => {
      const { alert } = await import("@/services/logging/alert");
      await alert({ msg, source: "site-graduation", code: "sites.graduation" });
    },
    log: (l) => console.warn(l),
  };
}

export async function runGraduations(limit = 20) {
  return resumeGraduations(graduationDeps(), limit);
}

async function dedicateStaticSite(input: { tenant_id: string; site: SiteRow; capabilities: DedicatedCapability[] }): Promise<void> {
  const { tenant_id, site } = input;
  const [{ supabaseSiteProvisioner }, { viteStarterProvider }] = await Promise.all([
    import("@/services/sites/supabase-site-provisioner"),
    import("@/services/provisioning/templates/vite-react-supabase"),
  ]);
  const sb = supabaseSiteProvisioner();
  const starterSql = viteStarterProvider.starterFiles().starter_sql;
  if (!starterSql) throw new Error("the dedicated starter has no starter SQL");
  await reserveLegacyDedication({ tenant_id, site_id: site.id });
  await sb.ensureProject({ tenant_id, site_id: site.id });
  await sb.configureAuth({ tenant_id, site_id: site.id, site_url: `https://${site.hostname}` });
  await sb.applySql({ tenant_id, site_id: site.id, migration_id: "000_starter", sql: starterSql });
  if (site.owner_email) await sb.ensureOwnerAdmin({ tenant_id, site_id: site.id, owner_email: site.owner_email });
  await createGraduationStore().dedicateStatic(tenant_id, site.id, [...input.capabilities]);
}

export function createPooledBackend(): PooledBackend {
  return {
    enabledFor: (tenant_id) => pooledReadiness().enabledFor(tenant_id),
    starter: async () => pooledSeams().starter,
    initStatic: (tenant_id, site_id) => shardRegistry().initStatic(tenant_id, site_id),
    validate: (i) => validateSiteBackend(deps(), i),
    apply: (i) => applySiteBackend(deps(), i),
    reserve: (i) => reserveSitePublish(deps(), i),
    ownerMagicLink: (i) => pooledOwnerMagicLink(deps(), i),
    deleteBackend: (i) => deleteSiteBackend(deps(), i),
    async moveToDedicated(i) {
      if (i.site.tenant_id !== i.tenant_id) throw new Error("moveToDedicated: site tenant mismatch");
      const mode = i.site.backend_mode ?? "dedicated";
      if (mode === "dedicated") return { kind: "already_dedicated" };
      if (mode === "static" && !i.site.shard_id) {
        await dedicateStaticSite(i);
        return { kind: "dedicated" };
      }
      const gd = graduationDeps();
      const r = await requestGraduation(gd, { tenant_id: i.tenant_id, site: i.site, reason: "capability", capabilities: i.capabilities });
      if (r.available) kickGraduation(gd, { tenant_id: i.tenant_id, site_id: i.site.id });
      return { kind: "graduating", available: r.available };
    },
    async kernelSqlAllowed(i) {
      if (i.site.tenant_id !== i.tenant_id) throw new Error("kernelSqlAllowed: site tenant mismatch");
      if (!i.site.kernel_shard_id) return false;
      const g = await createGraduationStore().get(i.tenant_id, i.site.id);
      return !!g && (g.state === "switched" || g.state === "archived");
    },
  };
}
