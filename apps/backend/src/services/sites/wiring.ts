
import type {
  SiteDeployHandler,
  SitePublisher,
  SiteStarterProvider,
  SiteStore,
  SiteTestSites,
  SupabaseSiteProvisioner,
} from "./contract";
import { viteStarterProvider } from "@/services/provisioning/templates/vite-react-supabase";
import type { PooledBackend } from "@/services/site-shards/facade";

export type SiteWiring = {
  starter: SiteStarterProvider | null;
  supabase: SupabaseSiteProvisioner | null;
  publisher: SitePublisher | null;
  deployHandler: SiteDeployHandler | null;
  pooled?: PooledBackend | null;
  testSites?: SiteTestSites | null;
};

function lazy<T>(make: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    p ??= make().catch((e: unknown) => {
      p = null;
      throw e;
    });
    return p;
  };
}

const provisioner = lazy(async () => (await import("./supabase-site-provisioner")).supabaseSiteProvisioner());

const sitePublisher = lazy(async () => {
  const [{ createSitePublisher }, { siteStore }] = await Promise.all([
    import("@/services/hosting/site-publish"),
    import("./store"),
  ]);
  return createSitePublisher({ store: siteStore(), repoFetchToken: async () => process.env.GITHUB_PROVISION_TOKEN?.trim() || null });
});

const idleDeps = lazy(async () => (await import("./idle")).defaultIdleDeps());

export async function wakeSiteByHostname(hostname: string): Promise<unknown> {
  const deps = await idleDeps();
  const { wakeSite } = await import("./idle");
  return wakeSite(hostname, deps);
}

function lazySupabase(): SupabaseSiteProvisioner {
  return {
    ensureProject: async (i) => (await provisioner()).ensureProject(i),
    configureAuth: async (i) => (await provisioner()).configureAuth(i),
    applySql: async (i) => (await provisioner()).applySql(i),
    verifyCatalog: async (i) => (await provisioner()).verifyCatalog(i),
    ensureOwnerAdmin: async (i) => (await provisioner()).ensureOwnerAdmin(i),
    ownerMagicLink: async (i) => (await provisioner()).ownerMagicLink(i),
    pause: async (i) => (await provisioner()).pause(i),
    restore: async (i) => (await provisioner()).restore(i),
    teardown: async (i) => (await provisioner()).teardown(i),
    purge: async (i) => (await provisioner()).purge(i),
    cancelDeletion: async (i) => (await provisioner()).cancelDeletion(i),
  };
}

function lazyPublisher(): SitePublisher {
  return {
    stage: async (i) => (await sitePublisher()).stage(i),
    activate: async (i) => (await sitePublisher()).activate(i),
    previewUrl: async (i) => (await sitePublisher()).previewUrl(i),
    verify: async (hostname) => (await sitePublisher()).verify(hostname),
    teardown: async (i) => (await sitePublisher()).teardown(i),
  };
}

const pooledBackend = lazy(async () => (await import("@/services/site-shards/facade")).createPooledBackend());

function lazyPooled(): PooledBackend {
  return {
    enabledFor: async (t) => (await pooledBackend()).enabledFor(t),
    starter: async () => (await pooledBackend()).starter(),
    initStatic: async (t, s) => (await pooledBackend()).initStatic(t, s),
    validate: async (i) => (await pooledBackend()).validate(i),
    apply: async (i) => (await pooledBackend()).apply(i),
    reserve: async (i) => (await pooledBackend()).reserve(i),
    ownerMagicLink: async (i) => (await pooledBackend()).ownerMagicLink(i),
    deleteBackend: async (i) => (await pooledBackend()).deleteBackend(i),
    moveToDedicated: async (i) => (await pooledBackend()).moveToDedicated(i),
    kernelSqlAllowed: async (i) => {
      const p = await pooledBackend();
      return p.kernelSqlAllowed ? p.kernelSqlAllowed(i) : false;
    },
  };
}

function lazyTestSites(): SiteTestSites {
  const mod = () => import("@/services/site-shards/test-site");
  return {
    createTestSite: async (i) => {
      const h = await (await mod()).createTestSite(i);
      return { test_site_id: h.test_site_id, preview_host: h.preview_host, owner_login: h.owner_login, customer_login: h.customer_login };
    },
    destroyTestSite: async (i) => {
      await (await mod()).destroyTestSite({ ...i, reason: "gate_done" });
    },
  };
}

function lazyDeployHandler(supabase: SupabaseSiteProvisioner, publisher: SitePublisher, pooled: PooledBackend, testSites: SiteTestSites | null): SiteDeployHandler {
  const handler = lazy(async () => {
    const [deploy, checkpoints, publish, activate, store, sandboxes, settings, timing, generations, design] = await Promise.all([
      import("./site-deploy"),
      import("./deploy-checkpoints"),
      import("@/services/hosting/site-publish"),
      import("@/../workers/functions/site-activate"),
      import("./store"),
      import("./sandbox-resolver"),
      import("@/services/settings"),
      import("./site-timing"),
      import("./publish-generation"),
      import("./site-design-store"),
    ]);
    const s = store.siteStore();
    return deploy.createSiteDeployHandler({
      store: s,
      sandboxes: sandboxes.createSiteSandboxResolver({ store: s }),
      supabase: {
        applySql: (i) => supabase.applySql(i),
        verifyCatalog: (i) => supabase.verifyCatalog(i),
      },
      publisher: { stage: (i) => publisher.stage(i), previewUrl: (i) => publisher.previewUrl(i) },
      generations: generations.createPublishGenerations(),
      testSites,
      requestActivate: (i) => activate.requestSiteActivate(i),
      activationState: publish.activationState,
      verifySiteDeploy: (hostname, deploy_id) => publish.verifySiteDeploy(hostname, deploy_id),
      ownerAdminEnabled: (tenant_id) => settings.getBoolSetting("build_auto_site_owner", tenant_id),
      skipUnchangedMigrations: (tenant_id) => settings.getBoolSetting("site_deploy_skip_unchanged_migrations", tenant_id),
      lightGateEnabled: (tenant_id) => settings.getBoolSetting("site_light_gate_copy_edits", tenant_id),
      lightGateColorEdits: (tenant_id) => settings.getBoolSetting("site_light_gate_color_edits", tenant_id),
      seedMetaCheckEnabled: (tenant_id) => settings.getBoolSetting("site_meta_and_404", tenant_id),
      signedImageCheckEnabled: (tenant_id) => settings.getBoolSetting("site_images_downloaded", tenant_id),
      bookingJourneyRequired: (tenant_id) => settings.getBoolSetting("site_booking_journey_required", tenant_id),
      brandCheckEnabled: (tenant_id) => settings.getBoolSetting("site_favicon_og_404_check", tenant_id),
      imagesCheckEnabled: (tenant_id) => settings.getBoolSetting("site_images", tenant_id),
      logDeployTiming: (row) => timing.logSiteDeployTiming(row),
      designBriefs: design.siteDesignStore(),
      alertOps: async (i) => {
        await (await import("@/services/logging/alert")).alert({ msg: i.msg, source: "site-deploy", code: i.code, tenant_id: i.tenant_id });
      },
      wakeSite: wakeSiteByHostname,
      pooled,
      checkpoints: checkpoints.nodePayloadCheckpoints(),
      thumbnails: (await import("./site-thumbnail")).siteThumbnailStore(),
      repoFetchToken: async () => process.env.GITHUB_PROVISION_TOKEN?.trim() || null,
    });
  });
  return {
    step: async (input) => (await handler()).step(input),
  };
}

function defaultWiring(): SiteWiring {
  const supabase = lazySupabase();
  const publisher = lazyPublisher();
  const pooled = lazyPooled();
  const testSites = lazyTestSites();
  return {
    starter: viteStarterProvider,
    supabase,
    publisher,
    deployHandler: lazyDeployHandler(supabase, publisher, pooled, testSites),
    testSites,
    pooled,
  };
}

let _wiring: SiteWiring | null = null;

export function siteWiring(): SiteWiring {
  return (_wiring ??= defaultWiring());
}

export function siteWiringComplete(): boolean {
  const w = siteWiring();
  return Boolean(w.starter && w.supabase && w.publisher && w.deployHandler);
}

export function siteOwnerMagicLink(
  deps: { store?: () => Promise<Pick<SiteStore, "get">> } = {},
): SupabaseSiteProvisioner["ownerMagicLink"] | null {
  const w = siteWiring();
  const sb = w.supabase;
  const pooled = w.pooled ?? null;
  if (!sb && !pooled) return null;
  const store = deps.store ?? (async () => (await import("./store")).siteStore());
  return async (i) => {
    const site = await (await store()).get(i.tenant_id, i.site_id);
    if (!site || site.tenant_id !== i.tenant_id) throw new Error("ownerMagicLink: site not found for tenant");
    const onShard = (site.backend_mode ?? "dedicated") !== "dedicated" || !!site.kernel_shard_id;
    if (onShard) {
      if (!pooled) throw new Error("ownerMagicLink: pooled backend not wired");
      return pooled.ownerMagicLink({ tenant_id: i.tenant_id, site, email: i.owner_email, redirect_to: i.redirect_to });
    }
    if (!sb) throw new Error("ownerMagicLink: site provisioner not wired");
    return sb.ownerMagicLink(i);
  };
}

export function setSiteWiring(patch: Partial<SiteWiring>): void {
  _wiring = { ...siteWiring(), ...patch };
}

export function resetSiteWiring(): void {
  _wiring = null;
}
