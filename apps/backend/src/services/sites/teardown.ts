
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import type {
  SiteProviderKind,
  SiteProviderState,
  SitePublisher,
  SiteRow,
  SiteStatus,
  SiteStore,
  SupabaseSiteProvisioner,
} from "./contract";
import { siteStore } from "./store";
import { siteWiring } from "./wiring";
import { createSiteRepoOps, type SiteRepoOps } from "./site-repo";
import type { PooledBackend } from "@/services/site-shards/facade";

export type SiteProviderRow = {
  kind: SiteProviderKind;
  state: SiteProviderState;
  ref: Record<string, unknown>;
  scheduled_delete_at?: string | null;
};

export type SiteTeardownDeps = {
  store: SiteStore;
  listProviders: (tenant_id: string, site_id: string) => Promise<SiteProviderRow[]>;
  publisher: SitePublisher | null;
  supabase: SupabaseSiteProvisioner | null;
  repo: Pick<SiteRepoOps, "deleteRepo" | "org">;
  deleteVaultKeys: (tenant_id: string, site_id: string) => Promise<void>;
  pooled?: Pick<PooledBackend, "deleteBackend"> | null;
  stopFunctions?: ((site_id: string, tenant_id: string) => Promise<void>) | null;
  removeThumbnails?: ((tenant_id: string, site_id: string) => Promise<void>) | null;
};

export type TeardownResult = {
  complete: boolean;
  pending: Array<SiteProviderKind | "vault" | "site_functions" | "thumbnail">;
  scheduled?: SiteProviderKind[];
  error?: string;
};

export async function listSiteProviders(tenant_id: string, site_id: string): Promise<SiteProviderRow[]> {
  const { data, error } = await (tenantClient(asTenantId(tenant_id)).from("site_providers").select("kind, state, ref, scheduled_delete_at") as any)
    .eq("site_id", site_id);
  if (error) throw new Error(`site_providers read failed: ${error.message ?? "unknown error"}`);
  return ((data ?? []) as SiteProviderRow[]).map((r) => ({
    kind: r.kind,
    state: r.state,
    ref: r.ref ?? {},
    scheduled_delete_at: r.scheduled_delete_at ?? null,
  }));
}

async function realDeleteVaultKeys(tenant_id: string, site_id: string): Promise<void> {
  const { error } = await tenantRpc(asTenantId(tenant_id), "delete_site_secrets", { p_site_id: site_id });
  if (error) throw new Error(`delete_site_secrets failed: ${error.message}`);
}

async function siteHasFunctionState(tenant_id: string, site_id: string): Promise<boolean> {
  const { data, error } = await (tenantClient(asTenantId(tenant_id)).from("site_function_state").select("site_id") as any)
    .eq("site_id", site_id)
    .limit(1);
  if (error) throw new Error(`site_function_state read failed: ${error.message ?? "unknown error"}`);
  return ((data ?? []) as unknown[]).length > 0;
}

export const SITE_REPO_DELETE_GRACE_DAYS = 7;

export function realSiteTeardownDeps(): SiteTeardownDeps {
  const w = siteWiring();
  return {
    store: siteStore(),
    listProviders: listSiteProviders,
    publisher: w.publisher,
    supabase: w.supabase,
    repo: createSiteRepoOps(),
    deleteVaultKeys: realDeleteVaultKeys,
    pooled: w.pooled ?? null,
    stopFunctions: async (site_id, tenant_id) => {
      const [{ stopSiteFunctions }, { createSiteFunctionsStore }, { lazyKv }] = await Promise.all([
        import("@/services/site-functions/sweeper"),
        import("@/services/site-functions/store"),
        import("@/services/site-functions/deploy"),
      ]);
      await stopSiteFunctions({ store: createSiteFunctionsStore(), kv: lazyKv(), hasFunctionState: (id) => siteHasFunctionState(tenant_id, id) }, site_id);
    },
    removeThumbnails: async (tenant_id, site_id) => {
      await (await import("./site-thumbnail")).siteThumbnailStore().removeAll({ tenant_id, site_id });
      await (await import("./site-preview-snapshot")).sitePreviewSnapshotStore().removeAll({ tenant_id, site_id });
    },
  };
}

function repoFullName(ref: Record<string, unknown>, site: SiteRow, org: string): string | null {
  if (typeof ref.full_name === "string" && ref.full_name.includes("/")) return ref.full_name;
  if (typeof ref.name === "string" && ref.name) return `${typeof ref.owner === "string" ? ref.owner : org}/${ref.name}`;
  return site.github_full_name ?? null;
}

export async function teardownSiteProviders(
  tenant_id: string,
  site: SiteRow,
  deps: SiteTeardownDeps,
  opts: {
    allowPurge?: boolean;
    repoGrace?: boolean;
  } = {},
): Promise<TeardownResult> {
  if (site.tenant_id !== tenant_id) throw new Error("teardownSiteProviders: site tenant mismatch");
  let functionsStopped = true;
  if (deps.stopFunctions) {
    try {
      await deps.stopFunctions(site.id, tenant_id);
    } catch (e) {
      functionsStopped = false;
      console.warn(JSON.stringify({ evt: "site_teardown", step: "stop_functions", outcome: "failed", site_id: site.id, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }));
    }
  }
  const providers = await deps.listProviders(tenant_id, site.id);
  const live = (kind: SiteProviderKind) => providers.find((p) => p.kind === kind && p.state !== "deleted");
  const pending: TeardownResult["pending"] = [];
  const scheduled: SiteProviderKind[] = [];

  async function settle(kind: SiteProviderKind, ok: boolean): Promise<void> {
    await deps.store.setProviderState(tenant_id, site.id, kind, ok ? "deleted" : "cleanup_pending");
    if (!ok) pending.push(kind);
  }

  async function attempt(fn: (() => Promise<void>) | null, label: string): Promise<boolean> {
    if (!fn) return false;
    try {
      await fn();
      return true;
    } catch (e) {
      console.warn(`[site-teardown] ${label} failed for tenant=${tenant_id} site=${site.id}: ${(e as Error).message ?? e}`);
      return false;
    }
  }

  const edge = (["cloudflare_host", "r2_prefix"] as const).filter((k) => live(k));
  if (edge.length) {
    const publisher = deps.publisher;
    const ok = await attempt(publisher ? () => publisher.teardown({ tenant_id, site_id: site.id }) : null, "publisher teardown");
    for (const k of edge) await settle(k, ok);
  }

  const sbRow = live("supabase_project");
  let projectGone = !sbRow;
  if (sbRow) {
    const supabase = deps.supabase;
    if (typeof sbRow.ref.hard_deleted_at === "string") {
      await settle("supabase_project", true);
      projectGone = true;
    } else if (sbRow.state === "delete_scheduled" || sbRow.state === "delete_issuing") {
      let outcome: string = "not_due";
      if (opts.allowPurge) {
        outcome = "failed";
        await attempt(supabase ? async () => { outcome = await supabase.purge({ tenant_id, site_id: site.id }); } : null, "supabase purge");
      }
      if (outcome === "deleted") projectGone = true;
      else if (outcome === "not_due") scheduled.push("supabase_project");
      else pending.push("supabase_project");
    } else if (sbRow.ref.retained === true) {
      scheduled.push("supabase_project");
    } else {
      let outcome: string = "failed";
      await attempt(supabase ? async () => { outcome = await supabase.teardown({ tenant_id, site_id: site.id }); } : null, "supabase teardown");
      if (outcome === "absent") projectGone = true;
      else if (outcome === "scheduled" || outcome === "retained") scheduled.push("supabase_project");
      else await settle("supabase_project", false);
    }
  }

  if (live("pooled_backend")) {
    let outcome: string = "failed";
    const pooled = deps.pooled;
    await attempt(pooled ? async () => { outcome = await pooled.deleteBackend({ tenant_id, site }); } : null, "pooled backend delete");
    await settle("pooled_backend", outcome === "deleted" || outcome === "absent");
  }

  const repoRow = live("github_repo");
  if (repoRow) {
    const full = repoFullName(repoRow.ref, site, deps.repo.org());
    if (!full) {
      await settle("github_repo", true);
    } else if (repoRow.state === "delete_scheduled" || repoRow.state === "delete_issuing") {
      const go = opts.allowPurge
        ? await deps.store.beginProviderDelete(tenant_id, site.id, "github_repo", repoRow.state).catch(() => false)
        : false;
      if (!go) {
        scheduled.push("github_repo");
      } else if (await attempt(() => deps.repo.deleteRepo(full), "repo delete")) {
        await deps.store.setProviderState(tenant_id, site.id, "github_repo", "deleted");
      } else {
        pending.push("github_repo");
      }
    } else if (opts.repoGrace && repoRow.ref.retained !== true) {
      await deps.store.scheduleProviderDelete(tenant_id, site.id, "github_repo", SITE_REPO_DELETE_GRACE_DAYS);
      scheduled.push("github_repo");
    } else if (opts.repoGrace) {
      scheduled.push("github_repo");
    } else {
      const ok = await attempt(() => deps.repo.deleteRepo(full), "repo delete");
      await settle("github_repo", ok);
    }
  }

  if (projectGone) {
    const vaultOk = await attempt(() => deps.deleteVaultKeys(tenant_id, site.id), "vault delete");
    if (!vaultOk) {
      pending.push("vault");
      if (providers.some((p) => p.kind === "supabase_project")) {
        await deps.store.setProviderState(tenant_id, site.id, "supabase_project", "cleanup_pending");
      }
    }
  }

  if (deps.removeThumbnails && !(await attempt(() => deps.removeThumbnails!(tenant_id, site.id), "thumbnail delete"))) {
    pending.push("thumbnail");
  }

  if (!functionsStopped) pending.push("site_functions");
  return {
    complete: pending.length === 0 && scheduled.length === 0,
    pending,
    ...(scheduled.length ? { scheduled } : {}),
  };
}

const NOT_DELETED: SiteStatus[] = [
  "provisioning", "building", "publishing", "live", "paused", "waking", "failed", "fell_back_old", "deleting",
];

export async function deleteSite(
  tenant_id: string,
  site_id: string,
  deps: SiteTeardownDeps = realSiteTeardownDeps(),
): Promise<TeardownResult> {
  const site = await deps.store.get(tenant_id, site_id);
  if (!site || site.status === "deleted") return { complete: true, pending: [] };
  const marked = (await deps.store.transition(tenant_id, site_id, NOT_DELETED, "deleting")) ?? site;
  const result = await teardownSiteProviders(tenant_id, marked, deps);
  if (result.complete) await deps.store.transition(tenant_id, site_id, ["deleting"], "deleted");
  return result;
}

export async function deleteTenantSites(
  tenant_id: string,
  deps: SiteTeardownDeps = realSiteTeardownDeps(),
): Promise<{ site_id: string; result: TeardownResult }[]> {
  const sites = await deps.store.listForTenant(tenant_id);
  for (const s of sites) {
    if (s.status === "deleted" || s.status === "deleting") continue;
    await deps.store.transition(tenant_id, s.id, NOT_DELETED, "deleting").catch(() => null);
  }
  const out: { site_id: string; result: TeardownResult }[] = [];
  for (const s of sites) {
    try {
      out.push({ site_id: s.id, result: await deleteSite(tenant_id, s.id, deps) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push({ site_id: s.id, result: { complete: false, pending: [], error: msg.slice(0, 300) } });
    }
  }
  return out;
}
