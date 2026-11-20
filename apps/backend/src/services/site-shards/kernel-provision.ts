
import type { SiteRow } from "@/services/sites/contract";
import type { ShardEnv } from "./contract";
import { provisionShard, type ProvisionDeps } from "./provision";
import type { ShardRegistry } from "./registry";

export type KernelPrepDeps = {
  registry: Pick<ShardRegistry, "registerKernel" | "kernelReady" | "get">;
  provision: Omit<ProvisionDeps, "registry"> & { registry: ProvisionDeps["registry"] };
  env: () => ShardEnv;
  applyStarter: ((input: { tenant_id: string; site_id: string }) => Promise<void>) | null;
};

export async function prepareKernelProject(
  deps: KernelPrepDeps,
  input: { tenant_id: string; site_id: string; project_ref: string; region: string },
): Promise<{ kernel_shard_id: string }> {
  let row = await deps.registry.registerKernel(input.tenant_id, input.site_id, deps.env(), input.region);
  if (row.project_ref !== input.project_ref) throw new Error("kernel: the registered project is not the site's project");
  if (row.state !== "full") {
    const r = await provisionShard(deps.provision, { kernel: row });
    if (r.status === "blocked") throw new Error(`kernel provisioning blocked at ${r.step}: ${r.reason}`);
    row = await deps.registry.kernelReady(input.tenant_id, input.site_id);
  }
  if (deps.applyStarter) await deps.applyStarter({ tenant_id: input.tenant_id, site_id: input.site_id });
  return { kernel_shard_id: row.id };
}

export async function defaultKernelPrepDeps(opts: { starter?: boolean } = {}): Promise<KernelPrepDeps> {
  const [{ shardRegistry, shardEnv }, { createShardMgmt }, { cloudflareKv }, { loadShardMigrations }, keys, sb, starter] = await Promise.all([
    import("./registry"),
    import("./shard-mgmt"),
    import("./gateway-kv"),
    import("./migrations"),
    import("./shard-keys"),
    import("@/services/sites/supabase-site-provisioner"),
    import("@/services/provisioning/templates/vite-react-supabase"),
  ]);
  const registry = shardRegistry();
  const kv = cloudflareKv();
  const kek = (process.env.SITE_SIGNER_KEK_PUBLIC_JWK ?? "").trim();
  const signer = kek ? keys.sealedKvKeyStore({ kv, kekPublicJwk: () => JSON.parse(kek) }) : keys.workerSecretKeyStore();
  return {
    registry,
    env: () => shardEnv(),
    provision: {
      registry,
      mgmt: createShardMgmt(),
      files: loadShardMigrations(),
      hookBaseUrl: (process.env.SITE_AUTH_HOOK_BASE_URL ?? "").trim(),
      secrets: registry,
      brokerCallbackUrl: (process.env.SITE_AUTH_BROKER_CALLBACK_URL ?? "").trim(),
      signer,
      kv,
      log: (l) => console.warn(l),
    },
    applyStarter: opts.starter === false ? null : async ({ tenant_id, site_id }) => {
      const sql = starter.viteStarterProvider.starterFiles().starter_sql;
      if (!sql) throw new Error("the dedicated starter has no starter SQL");
      await sb.supabaseSiteProvisioner().applySql({ tenant_id, site_id, migration_id: "000_starter", sql });
    },
  };
}

export type KernelSiteReason = "isolation" | "capacity" | "staff";
export type KernelProvisionState = "requested" | "project_ready" | "kernel_ready" | "attached";
export type KernelProvisionRow = {
  site_id: string;
  tenant_id: string;
  state: KernelProvisionState;
  reason: KernelSiteReason;
  project_ref: string | null;
  region: string | null;
  kernel_shard_id: string | null;
  attempts: number;
  last_error: string | null;
  lease_id: string | null;
  lease_until: string | null;
};
export type KernelProvisionPatch = Partial<Pick<KernelProvisionRow, "project_ref" | "region" | "kernel_shard_id" | "last_error">>;

export interface KernelProvisionLedger {
  claim(tenant_id: string, site_id: string, reason: KernelSiteReason, leaseSeconds: number): Promise<KernelProvisionRow | null>;
  advance(
    tenant_id: string,
    site_id: string,
    lease_id: string,
    from: KernelProvisionState,
    to: KernelProvisionState,
    patch?: KernelProvisionPatch,
    release?: boolean,
  ): Promise<KernelProvisionRow | null>;
  attach(tenant_id: string, site_id: string, lease_id: string | null): Promise<SiteRow>;
}

export type KernelSiteRefusalCode = "site_not_found" | "site_deleting" | "pooled_site_must_graduate" | "legacy_dedicated_site";
export class KernelSiteRefused extends Error {
  constructor(
    public readonly code: KernelSiteRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "KernelSiteRefused";
  }
}
export class KernelSiteUnavailable extends Error {
  constructor(
    public readonly code: "not_configured" | "busy",
    message: string,
  ) {
    super(message);
    this.name = "KernelSiteUnavailable";
  }
}

type LedgerRpcResult = { data: unknown; error: { message?: string; code?: string } | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function kernelRefusalOf(error: { message?: string; code?: string }): KernelSiteRefused | null {
  const m = error.message ?? "";
  if (error.code === "P0002" || /\bnot found for tenant\b/.test(m)) return new KernelSiteRefused("site_not_found", "The site does not exist in this workspace.");
  if (/already has pooled data|must graduate/.test(m)) {
    return new KernelSiteRefused("pooled_site_must_graduate", "This site already keeps data in the shared database; it moves to its own through graduation.");
  }
  if (/legacy dedicated site/.test(m)) return new KernelSiteRefused("legacy_dedicated_site", "This site already has its own database project on the older setup.");
  if (/ is (deleting|deleted|failed|fell_back_old)\b/.test(m)) return new KernelSiteRefused("site_deleting", "This site is being deleted or has failed.");
  return null;
}

export function kernelLedgerError(name: string, error: { message?: string; code?: string }): Error {
  return kernelRefusalOf(error) ?? new Error(`KernelProvisionLedger: ${name} failed${error.code ? ` (${error.code})` : ""}: ${error.message ?? "unknown error"}`);
}

function firstRow<T>(data: unknown): T | null {
  const r = Array.isArray(data) ? data[0] : data;
  return r && typeof r === "object" ? (r as T) : null;
}

async function defaultLedgerRpc(tenant_id: string, name: string, args: Record<string, unknown>): Promise<LedgerRpcResult> {
  const { asTenantId, tenantRpc } = await import("@/services/tenant-client");
  return (await tenantRpc(asTenantId(tenant_id), name, args)) as unknown as LedgerRpcResult;
}

export async function reserveLegacyDedication(
  input: { tenant_id: string; site_id: string },
  rpc: (tenant_id: string, name: string, args: Record<string, unknown>) => PromiseLike<LedgerRpcResult> = defaultLedgerRpc,
): Promise<void> {
  if (!UUID.test(input.tenant_id) || !UUID.test(input.site_id)) throw new Error("reserveLegacyDedication needs uuids");
  const { error } = await rpc(input.tenant_id, "site_backend_dedicate_static_reserve", { p_site_id: input.site_id });
  if (error) throw kernelLedgerError("site_backend_dedicate_static_reserve", error);
}

export const KERNEL_SITE_LEASE_SECONDS = 1800;
export const KERNEL_SITE_ALERT_ATTEMPTS = 3;

export function createKernelProvisionLedger(
  rpc: (tenant_id: string, name: string, args: Record<string, unknown>) => PromiseLike<LedgerRpcResult> = defaultLedgerRpc,
): KernelProvisionLedger {
  async function call(tenant_id: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!UUID.test(tenant_id) || !UUID.test(String(args.p_site_id ?? ""))) throw new Error(`KernelProvisionLedger: ${name} needs uuids`);
    const { data, error } = await rpc(tenant_id, name, args);
    if (error) throw kernelLedgerError(name, error);
    return data;
  }
  return {
    async claim(tenant_id, site_id, reason, leaseSeconds) {
      return firstRow<KernelProvisionRow>(await call(tenant_id, "site_kernel_provision_claim", { p_site_id: site_id, p_reason: reason, p_lease_seconds: leaseSeconds }));
    },
    async advance(tenant_id, site_id, lease_id, from, to, patch = {}, release = false) {
      if (!UUID.test(lease_id)) throw new Error("KernelProvisionLedger: advance needs the lease token");
      return firstRow<KernelProvisionRow>(
        await call(tenant_id, "site_kernel_provision_advance", {
          p_site_id: site_id,
          p_lease_id: lease_id,
          p_from: from,
          p_to: to,
          p_patch: patch,
          p_release: release,
          p_lease_seconds: KERNEL_SITE_LEASE_SECONDS,
        }),
      );
    },
    async attach(tenant_id, site_id, lease_id) {
      const r = firstRow<SiteRow>(await call(tenant_id, "site_kernel_attach", { p_site_id: site_id, p_lease_id: lease_id }));
      if (!r || r.tenant_id !== tenant_id || r.id !== site_id) throw new Error("KernelProvisionLedger: site_kernel_attach returned no row");
      return r;
    },
  };
}

export type DedicatedKernelSiteDeps = {
  getSite: (tenant_id: string, site_id: string) => Promise<SiteRow | null>;
  ledger: KernelProvisionLedger;
  ensureProject: (input: { tenant_id: string; site_id: string }) => Promise<{ project_ref: string; url: string }>;
  projectRegion: (project_ref: string) => Promise<string>;
  prepareKernel: (input: { tenant_id: string; site_id: string; project_ref: string; region: string }) => Promise<{ kernel_shard_id: string }>;
  ready: () => boolean;
  log?: (rec: Record<string, unknown>) => void;
  alert?: (msg: string) => Promise<void>;
};

export type DedicatedKernelSite = { kernel_shard_id: string; project_ref: string; site: SiteRow };

const INELIGIBLE: ReadonlySet<string> = new Set(["deleting", "deleted", "failed", "fell_back_old"]);
const REGION_RE = /^[a-z0-9-]{2,40}$/;

export async function provisionDedicatedKernelSiteWith(
  deps: DedicatedKernelSiteDeps,
  input: { tenant_id: string; site_id: string; reason?: KernelSiteReason },
): Promise<DedicatedKernelSite> {
  const { tenant_id, site_id } = input;
  const reason = input.reason ?? "isolation";
  const log = deps.log ?? ((rec: Record<string, unknown>) => console.warn(JSON.stringify(rec)));
  const evt = (step: string, extra: Record<string, unknown> = {}) => log({ evt: "site_kernel_provision", tenant_id, site_id, step, ...extra });

  const site = await deps.getSite(tenant_id, site_id);
  if (!site || site.tenant_id !== tenant_id) throw new KernelSiteRefused("site_not_found", "The site does not exist in this workspace.");
  if (INELIGIBLE.has(site.status)) throw new KernelSiteRefused("site_deleting", "This site is being deleted or has failed.");
  if (site.backend_mode === "dedicated" && site.kernel_shard_id && site.supabase_project_ref) {
    return { kernel_shard_id: site.kernel_shard_id, project_ref: site.supabase_project_ref, site };
  }
  if (!deps.ready()) throw new KernelSiteUnavailable("not_configured", "Sites with their own database are not available right now.");

  const claimed = await deps.ledger.claim(tenant_id, site_id, reason, KERNEL_SITE_LEASE_SECONDS);
  if (!claimed) throw new KernelSiteUnavailable("busy", "This site's own database is already being set up.");
  if (claimed.tenant_id !== tenant_id || claimed.site_id !== site_id) throw new Error("provisionDedicatedKernelSite: ledger row mismatch");
  let row: KernelProvisionRow = claimed;
  const lease = claimed.lease_id;

  const step = async (from: KernelProvisionState, to: KernelProvisionState, patch?: KernelProvisionPatch) => {
    const next = await deps.ledger.advance(tenant_id, site_id, lease as string, from, to, patch);
    if (!next) throw new Error(`provisionDedicatedKernelSite: lost the lease or the ledger moved (expected ${from})`);
    row = next;
    if (from !== to) evt(to, { attempts: next.attempts });
  };

  try {
    if (row.state !== "attached" && !lease) throw new Error("provisionDedicatedKernelSite: the claim returned no lease");
    for (let guard = 0; guard < 4; guard++) {
      const cur: KernelProvisionRow = row;
      if (cur.state === "requested") {
        const p = await deps.ensureProject({ tenant_id, site_id });
        await step("requested", "project_ready", { project_ref: p.project_ref });
      } else if (cur.state === "project_ready") {
        await step("project_ready", "project_ready");
        const fresh = await deps.getSite(tenant_id, site_id);
        const ref = fresh?.supabase_project_ref ?? null;
        if (!ref || (cur.project_ref && cur.project_ref !== ref)) throw new Error("the site's project is not the one recorded for it");
        let region = cur.region;
        if (!region) {
          region = (await deps.projectRegion(ref)).trim();
          if (!REGION_RE.test(region)) throw new Error("the project's region could not be read");
          await step("project_ready", "project_ready", { region });
        }
        let k: { kernel_shard_id: string };
        try {
          k = await deps.prepareKernel({ tenant_id, site_id, project_ref: ref, region });
        } catch (e) {
          throw kernelRefusalOf({ message: String((e as Error)?.message ?? e) }) ?? e;
        }
        await step("project_ready", "kernel_ready", { kernel_shard_id: k.kernel_shard_id });
      } else if (cur.state === "kernel_ready" || cur.state === "attached") {
        const attached = await deps.ledger.attach(tenant_id, site_id, cur.state === "attached" ? null : lease);
        if (!attached.kernel_shard_id || !attached.supabase_project_ref || attached.backend_mode !== "dedicated") {
          throw new Error("provisionDedicatedKernelSite: attach left no kernel on the site");
        }
        evt("attached", { kernel_shard_id: attached.kernel_shard_id });
        return { kernel_shard_id: attached.kernel_shard_id, project_ref: attached.supabase_project_ref, site: attached };
      } else {
        throw new Error(`provisionDedicatedKernelSite: unknown state ${String((cur as { state?: unknown }).state)}`);
      }
    }
    throw new Error("provisionDedicatedKernelSite: too many steps in one pass");
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 400);
    evt("failed", { state: row.state, attempts: row.attempts, error: msg, ...(e instanceof KernelSiteRefused ? { code: e.code } : {}) });
    if (lease) await deps.ledger.advance(tenant_id, site_id, lease, row.state, row.state, { last_error: msg }, true).catch(() => undefined);
    if (!(e instanceof KernelSiteRefused) && row.attempts >= KERNEL_SITE_ALERT_ATTEMPTS) {
      await deps
        .alert?.(`own-database site provisioning keeps failing tenant=${tenant_id} site=${site_id} state=${row.state} attempts=${row.attempts}: ${msg}`)
        .catch(() => undefined);
    }
    throw e;
  }
}

export async function defaultDedicatedKernelSiteDeps(): Promise<DedicatedKernelSiteDeps> {
  const [{ siteStore }, { supabaseSiteProvisioner }, { createSupabaseMgmt }, { kernelPrepConfigured }] = await Promise.all([
    import("@/services/sites/store"),
    import("@/services/sites/supabase-site-provisioner"),
    import("@/services/sites/supabase-mgmt"),
    import("./default-seams"),
  ]);
  return {
    getSite: (t, id) => siteStore().get(t, id),
    ledger: createKernelProvisionLedger(),
    ensureProject: (i) => supabaseSiteProvisioner().ensureProject(i),
    projectRegion: async (ref) => {
      const p = await createSupabaseMgmt().getProject(ref);
      if (!p?.region) throw new Error("the project's region is unknown");
      return p.region;
    },
    prepareKernel: async (i) => prepareKernelProject(await defaultKernelPrepDeps({ starter: false }), i),
    ready: () => kernelPrepConfigured(),
    alert: async (msg) => {
      const { alert } = await import("@/services/logging/alert");
      await alert({ msg, source: "site-shards", code: "sites.kernel_provision" });
    },
  };
}

export async function provisionDedicatedKernelSite(input: { tenant_id: string; site_id: string; reason?: KernelSiteReason }): Promise<DedicatedKernelSite> {
  return provisionDedicatedKernelSiteWith(await defaultDedicatedKernelSiteDeps(), input);
}
