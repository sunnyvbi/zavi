
import type {
  FastBuildContext,
  SiteDeployHandler,
  SitePublisher,
  SiteRow,
  SiteStarterProvider,
  SiteStatus,
  SiteStore,
  StarterFiles,
  SupabaseSiteProvisioner,
} from "@/services/sites/contract";
import { SITE_MANIFEST_PATH, STARTER_SQL_PATH, SiteCredentialsMissing } from "@/services/sites/contract";
import type { FastBuildOutcome } from "@/services/agents/start-product-build";
import type { ConductorNode } from "@/services/agents/conductor";
import type { ProvisionedTarget } from "@/services/agents/autopilot-pipeline-contract";
import { buildSiteGoalGraph } from "@/services/agents/product-pipeline";
import { siteStore } from "@/services/sites/store";
import { cleanSiteName, siteLabelName } from "@/services/sites/label";
import { personalizeSiteStarter, starterShowsLogo } from "@/services/sites/site-head";
import { designBriefSummary, generateDesignBrief, type DesignBrief, type DesignBriefResult } from "@/services/sites/design-brief";
import {
  BRAND_DIRECTION_ID,
  applyDirectionToFiles,
  designDirections,
  fallbackDesignBrief,
  findDirection,
  liveSwitchable,
  lookIsGiven,
  presetBriefColors,
  themeModeOf,
  withCompleteLook,
  type DesignDirection,
} from "@/services/sites/design-directions";
import { logoIntent, logoLetters, seedSiteLogo, type SeededLogo } from "@/services/sites/site-logo";
import { BUILD_LOGO_WAIT_MS, liveBuildLogoDeps, prepareBuildLogo, type BuildLogoInput } from "@/services/sites/site-logo-generate";
import { SITE_LOGO_URL } from "@/services/sites/site-head";
import { siteDesignStore, type SiteDesignRow, type SiteDesignStore } from "@/services/sites/site-design-store";
import { applySiteTemplate, designBriefTemplateLines, parseSiteTemplate, type SiteTemplate } from "@/services/sites/site-templates";
import {
  applyCompanyBrand,
  brandAppliesToSite,
  ideaNamesColours,
  liveCompanyBrandSources,
  loadCompanyBrand,
  type CompanyBrand,
} from "@/services/sites/company-brand";
import { SITE_BUILD_WAITS_FOR_LOOK_SETTING } from "@/services/sites/look-wait";
import { SITE_LOOK_INDUSTRY_RULES_SETTING, applyIndustryLook } from "@/services/sites/industry-look";
import { webBaseUrl } from "@/services/web-base";
import { siteWiring } from "@/services/sites/wiring";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { createSiteRepoOps, type SiteRepoOps } from "@/services/sites/site-repo";
import type { PooledBackend } from "@/services/site-shards/facade";
import { detectDedicatedCapabilities } from "@/services/site-shards/capabilities";

export function pooledStarterNeedsDedicated(starter: { files: Record<string, string>; manifest_json: string }): boolean {
  let raw: unknown = null;
  try {
    raw = JSON.parse(starter.manifest_json);
  } catch {
    raw = null;
  }
  return detectDedicatedCapabilities({ manifestRaw: raw, paths: Object.keys(starter.files) }).capabilities.length > 0;
}

function siteWebBase(): string {
  try {
    return webBaseUrl();
  } catch {
    return "";
  }
}

export const DEFAULT_FAST_BUILD_ESTIMATE_USD = 2;
export function fastBuildEstimateUsd(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FAST_BUILD_ESTIMATE_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FAST_BUILD_ESTIMATE_USD;
}

export const SITE_SETUP_CONFIG_ALERT_CODE = "sites.build_prereqs_missing";

export type FastBuildRunDeps = {
  updateConductorRunStatus?: (p: { conductor_run_id: string; status: "active"; goal_graph: ConductorNode[] }) => Promise<void>;
  ensureGithubConnector?: (tenant_id: string, github_full_name: string, default_branch: string) => Promise<void>;
  requestTick?: (conductor_run_id: string) => Promise<unknown>;
};

export type FastBuildDeps = FastBuildRunDeps & {
  store: SiteStore;
  holdSearch: (tenant_id: string, site_id: string) => Promise<unknown>;
  starter: SiteStarterProvider | null;
  supabase: SupabaseSiteProvisioner | null;
  publisher: SitePublisher | null;
  deployHandler: SiteDeployHandler | null;
  pooled?: Pick<PooledBackend, "enabledFor" | "starter" | "initStatic"> | null;
  repo: SiteRepoOps;
  now: () => Date;
  autoSiteOwner?: (tenant_id: string) => Promise<boolean>;
  publishOnRequest: (tenant_id: string) => Promise<boolean>;
  waitsForLook?: (tenant_id: string) => Promise<boolean>;
  industryLookRules?: (tenant_id: string) => Promise<boolean>;
  designBrief: (input: { idea: string; name?: string | null; templateLines?: string | null }) => Promise<DesignBriefResult>;
  buildLogo?: ((input: BuildLogoInput) => Promise<string | null>) | null;
  buildLogoWaitMs?: number;
  companyBrand?: (tenant_id: string) => Promise<CompanyBrand | null>;
  designStore?: SiteDesignStore | null;
  sleep: (ms: number) => Promise<void>;
  alert?: (input: { code: string; msg: string; tenant_id: string }) => Promise<void>;
};

export const OWNER_ADMIN_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;

function permanentOwnerError(e: unknown): boolean {
  if (e instanceof SiteCredentialsMissing) return true;
  const m = String((e as Error)?.message ?? e);
  return m === "invalid owner email" || m === "owner user id is not a uuid";
}

async function ensureOwnerAdminWithRetry(
  supabase: SupabaseSiteProvisioner,
  input: { tenant_id: string; site_id: string; owner_email: string },
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await supabase.ensureOwnerAdmin(input);
      return;
    } catch (e) {
      if (attempt >= OWNER_ADMIN_RETRY_DELAYS_MS.length || permanentOwnerError(e)) throw e;
      console.warn(
        `[fast-build] owner admin setup failed for tenant=${input.tenant_id} site=${input.site_id} (attempt ${attempt + 1}), retrying: ${msg(e)}`,
      );
      await sleep(OWNER_ADMIN_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export async function provisionDedicatedSite(
  supabase: SupabaseSiteProvisioner,
  input: { tenant_id: string; site: SiteRow; starter_sql: string; owner_email: string | null },
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const { tenant_id, site } = input;
  await supabase.ensureProject({ tenant_id, site_id: site.id });
  await supabase.configureAuth({ tenant_id, site_id: site.id, site_url: `https://${site.hostname}` });
  await supabase.applySql({ tenant_id, site_id: site.id, migration_id: "000_starter", sql: input.starter_sql });
  if (input.owner_email) {
    await ensureOwnerAdminWithRetry(supabase, { tenant_id, site_id: site.id, owner_email: input.owner_email }, sleep);
  }
}

async function productionAlert(input: { code: string; msg: string; tenant_id: string }): Promise<void> {
  const { alert } = await import("@/services/logging/alert");
  await alert({ msg: input.msg, source: "site-build", code: input.code, tenant_id: input.tenant_id });
}

async function productionWaitsForLook(tenant_id: string): Promise<boolean> {
  const { getBoolSetting } = await import("@/services/settings");
  return getBoolSetting(SITE_BUILD_WAITS_FOR_LOOK_SETTING, tenant_id);
}

async function productionIndustryLookRules(tenant_id: string): Promise<boolean> {
  const { getBoolSetting } = await import("@/services/settings");
  return getBoolSetting(SITE_LOOK_INDUSTRY_RULES_SETTING, tenant_id);
}

async function productionPublishOnRequest(tenant_id: string): Promise<boolean> {
  const { getBoolSetting } = await import("@/services/settings");
  return getBoolSetting("build_publish_on_request", tenant_id);
}

export const DESIGN_BRIEF_TIMEOUT_MS = 20_000;

export function sameBriefName(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

function firstSiteOf(ctx: FastBuildContext): boolean {
  return ctx.first_site === true || ctx.first_build_free === true;
}

async function holdSiteSearch(tenant_id: string, site_id: string): Promise<void> {
  const { error } = await tenantRpc(asTenantId(tenant_id), "site_hold_search", { p_site_id: site_id });
  if (error) throw new Error(error.message ?? "site_hold_search failed");
}

function resolveDeps(partial: Partial<FastBuildDeps>): FastBuildDeps {
  const w = siteWiring();
  return {
    ...partial,
    store: partial.store ?? siteStore(),
    starter: partial.starter !== undefined ? partial.starter : w.starter,
    supabase: partial.supabase !== undefined ? partial.supabase : w.supabase,
    publisher: partial.publisher !== undefined ? partial.publisher : w.publisher,
    deployHandler: partial.deployHandler !== undefined ? partial.deployHandler : w.deployHandler,
    pooled: partial.pooled !== undefined ? partial.pooled : w.pooled ?? null,
    repo: partial.repo ?? createSiteRepoOps(),
    holdSearch: partial.holdSearch ?? holdSiteSearch,
    now: partial.now ?? (() => new Date()),
    publishOnRequest: partial.publishOnRequest ?? productionPublishOnRequest,
    waitsForLook: partial.waitsForLook ?? productionWaitsForLook,
    industryLookRules: partial.industryLookRules ?? productionIndustryLookRules,
    designBrief: partial.designBrief ?? ((input) => generateDesignBrief(input, { timeoutMs: DESIGN_BRIEF_TIMEOUT_MS })),
    buildLogo: partial.buildLogo !== undefined ? partial.buildLogo : productionBuildLogo,
    designStore: partial.designStore !== undefined ? partial.designStore : siteDesignStore(),
    companyBrand: partial.companyBrand ?? ((tenant_id) => loadCompanyBrand(tenant_id, liveCompanyBrandSources)),
    sleep: partial.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    alert: partial.alert ?? productionAlert,
  };
}

const DEAD: ReadonlySet<SiteStatus> = new Set<SiteStatus>(["fell_back_old", "failed", "deleting", "deleted"]);
const PROVISIONABLE: SiteStatus[] = ["provisioning", "building"];

function msg(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 500);
}

class SetupConfigError extends Error {}

function failed(reason: string, opts: { site_id?: string; retryable?: boolean; detail?: string } = {}): FastBuildOutcome {
  return {
    kind: "setup_failed",
    reason,
    retryable: opts.retryable !== false,
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(opts.site_id ? { site_id: opts.site_id } : {}),
  };
}

function alertConfig(deps: FastBuildDeps, tenant_id: string, line: string): void {
  console.warn(`[fast-build] ${line}`);
  void Promise.resolve()
    .then(() => deps.alert?.({ code: SITE_SETUP_CONFIG_ALERT_CODE, msg: line, tenant_id }))
    .catch(() => undefined);
}

type Backend =
  | { mode: "pooled"; pooled: NonNullable<FastBuildDeps["pooled"]>; starter: StarterFiles }
  | { mode: "dedicated"; supabase: SupabaseSiteProvisioner; starter: StarterFiles & { starter_sql: string } };

function dedicatedBackend(deps: FastBuildDeps): Backend {
  if (!deps.supabase) throw new SetupConfigError("dedicated site provisioner not wired");
  if (!deps.starter) throw new SetupConfigError("dedicated site starter not wired");
  let starter: StarterFiles;
  try {
    starter = deps.starter.starterFiles();
  } catch (e) {
    throw new SetupConfigError(`dedicated site starter unavailable: ${msg(e)}`);
  }
  if (!starter.starter_sql) throw new SetupConfigError("the dedicated site starter has no starter SQL");
  return { mode: "dedicated", supabase: deps.supabase, starter: { ...starter, starter_sql: starter.starter_sql } };
}

async function chooseBackend(deps: FastBuildDeps, tenant_id: string, site: SiteRow | null): Promise<Backend> {
  if (site?.supabase_project_ref) return dedicatedBackend(deps);
  const pooled = deps.pooled;
  if (!pooled) throw new SetupConfigError("pooled site backend not wired");
  let ready = false;
  try {
    ready = (await pooled.enabledFor(tenant_id)) === true;
  } catch {
    ready = false;
  }
  if (!ready) throw new Error("pooled_backend_unavailable");
  let starter: StarterFiles;
  try {
    const provider = await pooled.starter();
    if (!provider) throw new Error("not wired");
    starter = provider.starterFiles();
  } catch (e) {
    throw new SetupConfigError(`pooled site starter unavailable: ${msg(e)}`);
  }
  if (site?.backend_mode !== "static" && site?.backend_mode !== "pooled" && pooledStarterNeedsDedicated(starter)) {
    return dedicatedBackend(deps);
  }
  return { mode: "pooled", pooled, starter };
}

export async function startFastBuild(
  ctx: FastBuildContext,
  partial: Partial<FastBuildDeps> = {},
): Promise<FastBuildOutcome> {
  const deps = resolveDeps(partial);
  const { tenant_id, conductor_run_id } = ctx;
  if (!deps.publisher || !deps.deployHandler) {
    alertConfig(deps, tenant_id, `site setup refused for tenant=${tenant_id}: site publisher / deploy handler not wired`);
    return failed("site_providers_not_wired");
  }
  if (!deps.updateConductorRunStatus) return failed("run_writer_missing");

  const brandP = companyBrandOf(deps, tenant_id);
  const template = parseSiteTemplate(ctx.site_template);
  let briefRun = startDesignBrief(deps, ctx.idea, cleanSiteName(ctx.site_name), template);
  const ownerOnP = ctx.owner_email ? autoSiteOwnerOn(deps, tenant_id) : Promise.resolve(false);
  const publishOnRequestP = publishOnRequestOn(deps, tenant_id);
  const waitsForLookP = ctx.await_look_pick === true ? waitsForLookOn(deps, tenant_id) : Promise.resolve(false);

  let existing: SiteRow | null;
  try {
    existing = await deps.store.getByRun(tenant_id, conductor_run_id);
  } catch (e) {
    console.warn(`[fast-build] site read failed for tenant=${tenant_id} run=${conductor_run_id}: ${msg(e)}`);
    return failed("site_row_failed");
  }
  if (existing) {
    if (existing.tenant_id !== tenant_id) throw new Error("startFastBuild: site belongs to another tenant");
    if (DEAD.has(existing.status) || !PROVISIONABLE.includes(existing.status)) {
      return failed(`site_${existing.status}`, { site_id: existing.id, retryable: false });
    }
  }

  const provisionStartedAt = deps.now().toISOString();

  let backend: Backend;
  try {
    backend = await chooseBackend(deps, tenant_id, existing);
  } catch (e) {
    if (existing) return setupFailed(deps, existing, "backend", e);
    reportSetupError(deps, tenant_id, `run=${conductor_run_id}`, "backend", e);
    return failed("provisioning_failed:backend");
  }

  let site: SiteRow;
  try {
    site =
      existing ??
      (await deps.store.getOrCreateForRun({
        tenant_id,
        root_conductor_run_id: conductor_run_id,
        company_name: siteLabelName({ idea: ctx.idea, company_name: ctx.company_name, workspace_name: ctx.workspace_name }),
        started_by_user_id: ctx.started_by_user_id,
        ...(ctx.site_name ? { site_name: ctx.site_name } : {}),
      }));
  } catch (e) {
    console.warn(`[fast-build] site row failed for tenant=${tenant_id} run=${conductor_run_id}: ${msg(e)}`);
    return failed("site_row_failed");
  }
  if (site.tenant_id !== tenant_id) throw new Error("startFastBuild: site belongs to another tenant");
  if (DEAD.has(site.status) || !PROVISIONABLE.includes(site.status)) {
    return failed(`site_${site.status}`, { site_id: site.id, retryable: false });
  }
  if (!existing && firstSiteOf(ctx)) await deps.holdSearch(tenant_id, site.id).catch((e: unknown) => {
    console.warn(`[fast-build] search hold failed for tenant=${tenant_id} site=${site.id}: ${msg(e)}`);
  });
  if (!sameBriefName(site.name, briefRun.name)) briefRun = startDesignBrief(deps, ctx.idea, site.name, template);
  const logoP = existing ? null : startBuildLogo(deps, ctx, brandP, site.name);
  try {
    await deps.store.claimProvider(tenant_id, site.id, "github_repo", { name: site.label, owner: deps.repo.org() });
  } catch (e) {
    return setupFailed(deps, site, "repo", e);
  }

  if (backend.mode === "pooled") {
    try {
      await backend.pooled.initStatic(tenant_id, site.id);
    } catch (e) {
      if (!/already has a dedicated database/.test(msg(e))) return setupFailed(deps, site, "backend_mode", e);
      try {
        backend = dedicatedBackend(deps);
      } catch (e2) {
        return setupFailed(deps, site, "backend", e2);
      }
    }
  }
  const starter = backend.starter;

  const ownerEmail = ctx.owner_email && (await ownerOnP) ? ctx.owner_email : null;
  const usedBrief = briefRun;
  const designP = siteDesign(deps, usedBrief, tenant_id, site, ctx.idea, brandP, ctx.reference_images ?? [], template);
  designP.catch(() => undefined);
  let seededBrief: DesignBrief | null = null;
  let repo_ms: number | null = null;
  let seed_ms: number | null = null;
  let seededThemeMode: ReturnType<typeof themeModeOf> = "none";
  const repoSaga = async () => {
    const repoStartedAt = Date.now();
    const ref = await deps.repo.ensureRepo(site.label);
    await deps.store.setProviderState(tenant_id, site.id, "github_repo", "created", { full_name: ref.full_name });
    await deps.store.update(tenant_id, site.id, { github_full_name: ref.full_name });
    repo_ms = Date.now() - repoStartedAt;
    let design = await designP;
    const brand = await brandP;
    const uploadedSvg = brandAppliesToSite(brand, site.name) && design.brief.brand?.logo ? brand?.logoSvg ?? null : null;
    const canShowLogo = starterShowsLogo(starter.files);
    const aiLogo = logoP && !uploadedSvg && canShowLogo ? await settleWithin(logoP, deps.buildLogoWaitMs ?? BUILD_LOGO_WAIT_MS) : null;
    if (logoP && aiLogo === null) console.info(`[fast-build] tenant=${tenant_id} site=${site.id} AI logo not used; letter mark`);
    const letterMark = logoP !== null && aiLogo === null && !uploadedSvg && canShowLogo;
    const logoFor = (d: SiteDesign, stored: boolean): SeededLogo<DesignBrief> => {
      if (aiLogo) return withFileLogo(d.brief, aiLogo);
      if (letterMark && !stored) {
        const brief: DesignBrief = { ...d.brief, logo: { icon: null, shape: d.brief.logo?.shape ?? "rounded", letters: logoLetters(site.name) } };
        d = { ...d, brief };
      }
      const colors = presetBriefColors(d.direction.preset);
      return seedSiteLogo({
        brief: d.brief,
        stored,
        idea: ctx.idea,
        uploadedSvg,
        canShowLogo,
        colors: { primary: colors.primary, primaryForeground: colors["primary-foreground"] },
      });
    };
    const freshLogo = logoFor(design, design.stored);
    design = { ...design, brief: freshLogo.brief };
    const head = { label: site.label, name: site.name, hostname: site.hostname, webBase: siteWebBase() };
    const themeMode = themeModeOf(personalizeSiteStarter(starter.files, { ...head, logoSvg: null }));
    seededThemeMode = themeMode;
    let logoSvg = freshLogo.svg;
    let faviconSvg = freshLogo.favicon;
    if (deps.designStore && !design.stored) {
      const row = await deps.designStore.createIfAbsent({
        tenant_id,
        site_id: site.id,
        conductor_run_id,
        brief: design.brief,
        directions: designDirections(design.brief),
        theme_mode: themeMode,
      });
      design = designFromRow(row);
      const stored = logoFor(design, true);
      logoSvg = stored.svg;
      faviconSvg = stored.favicon;
      design = { ...design, brief: stored.brief };
    }
    const personalized = personalizeSiteStarter(starter.files, { ...head, logoSvg, faviconSvg });
    seededBrief = design.brief;
    const seedStartedAt = Date.now();
    const seed_sha = await deps.repo.seed(tenant_id, ref.full_name, {
      ...applyDirectionToFiles(personalized, design.brief, design.direction),
      ...(backend.mode === "dedicated" ? { [STARTER_SQL_PATH]: backend.starter.starter_sql } : {}),
      [SITE_MANIFEST_PATH]: starter.manifest_json,
    }, { default_branch: ref.default_branch });
    seed_ms = Date.now() - seedStartedAt;
    return { ref, seed_sha };
  };
  const [repoR, dedicatedR] = await Promise.allSettled([
    repoSaga(),
    backend.mode === "dedicated"
      ? provisionDedicatedSite(backend.supabase, { tenant_id, site, starter_sql: backend.starter.starter_sql, owner_email: ownerEmail }, deps.sleep)
      : Promise.resolve(),
  ]);
  if (repoR.status === "rejected") return setupFailed(deps, site, "repo", repoR.reason);
  if (dedicatedR.status === "rejected") return setupFailed(deps, site, "dedicated_backend", dedicatedR.reason);
  const { ref, seed_sha } = repoR.value;

  try {
    const moved = await deps.store.transition(tenant_id, site.id, PROVISIONABLE, "building", {
      desired_sha: seed_sha,
      last_error: null,
      ...(ownerEmail ? { owner_email: ownerEmail } : {}),
    });
    if (!moved) return setupFailed(deps, site, "setup", new Error("site left provisioning while it was being set up"));
    site = moved;
  } catch (e) {
    return setupFailed(deps, site, "setup", e);
  }

  const target: ProvisionedTarget = {
    github_full_name: ref.full_name,
    repo_url: ref.repo_url,
    default_branch: "main",
    github_target_mode: "umbrella",
  };
  const goal_graph = buildSiteGoalGraph(
    { tenant_id, company_name: site.name?.trim() || ctx.company_name, idea: ctx.idea, max_usd: ctx.max_usd },
    {
      site_id: site.id,
      target,
      seed_sha,
      reference_images: ctx.reference_images,
      provision_started_at: provisionStartedAt,
      provision_finished_at: deps.now().toISOString(),
      site_backend: backend.mode,
      publish_on_request: !firstSiteOf(ctx) && (await publishOnRequestP),
      design_brief: seededBrief ?? (await designP).brief,
      await_look:
        !!deps.designStore &&
        liveSwitchable(seededThemeMode) &&
        !lookIsGiven(seededBrief ?? (await designP).brief) &&
        (await waitsForLookP),
    },
  );
  try {
    await deps.updateConductorRunStatus({ conductor_run_id, status: "active", goal_graph });
  } catch (e) {
    if ((e as Error)?.name === "RunNoLongerProvisioning") throw e;
    return setupFailed(deps, site, "run_update", e);
  }

  const requestTick = deps.requestTick;
  const ensureGithubConnector = deps.ensureGithubConnector;
  await Promise.all([
    requestTick
      ? Promise.resolve()
          .then(() => requestTick(conductor_run_id))
          .catch((e: unknown) => {
            console.warn(`[fast-build] conductor tick request failed for tenant=${tenant_id} run=${conductor_run_id}: ${msg(e)}`);
          })
      : undefined,
    ensureGithubConnector
      ? Promise.resolve()
          .then(() => ensureGithubConnector(tenant_id, ref.full_name, "main"))
          .catch((e: unknown) => {
            console.warn(`[fast-build] github connector row failed for tenant=${tenant_id}: ${msg(e)}`);
          })
      : undefined,
  ]);

  return {
    kind: "started",
    timing: { brief_ms: (await usedBrief.settled).ms, repo_ms, seed_ms },
    result: {
      conductor_run_id,
      provision: {
        provisioned: backend.mode === "pooled" ? ["repo"] : ["repo", "db"],
        connected: [],
        pending_creds: [],
        failed: [],
        context: {
          github_full_name: ref.full_name,
          repo_url: ref.repo_url,
          default_branch: "main",
          site_id: site.id,
          site_hostname: site.hostname,
        },
      },
      target,
      first_build_free: ctx.first_build_free,
    },
  };
}

async function productionBuildLogo(input: BuildLogoInput): Promise<string | null> {
  const out = await prepareBuildLogo(input, liveBuildLogoDeps());
  return "svg" in out ? out.svg : null;
}

function startBuildLogo(
  deps: FastBuildDeps,
  ctx: FastBuildContext,
  brandP: Promise<CompanyBrand | null>,
  siteName: string | null | undefined,
): Promise<string | null> | null {
  const make = deps.buildLogo;
  if (!make || logoIntent(ctx.idea) === "none") return null;
  const p = brandP
    .then((brand) =>
      brand?.logoSvg && brandAppliesToSite(brand, siteName)
        ? null
        : make({
            tenant_id: ctx.tenant_id,
            run_id: ctx.conductor_run_id,
            site_name: cleanSiteName(siteName) ?? cleanSiteName(ctx.site_name) ?? "",
            idea: ctx.idea,
            ...(brandAppliesToSite(brand, siteName) && brand?.colors && !ideaNamesColours(ctx.idea)
              ? { primary: brand.colors.primary, ...(brand.colors.accent ? { accent: brand.colors.accent } : {}) }
              : {}),
          }),
    )
    .catch(() => null);
  return p;
}

async function settleWithin<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withFileLogo(brief: DesignBrief, svg: string): SeededLogo<DesignBrief> {
  const rest: DesignBrief = { ...brief };
  delete rest.logo;
  return { svg, favicon: svg, brief: { ...rest, brand: { ...brief.brand, logo: SITE_LOGO_URL } } };
}

async function autoSiteOwnerOn(deps: FastBuildDeps, tenant_id: string): Promise<boolean> {
  if (!deps.autoSiteOwner) return true;
  try {
    return (await deps.autoSiteOwner(tenant_id)) === true;
  } catch {
    return true;
  }
}

type DesignBriefRun = {
  name: string | null;
  settled: Promise<{ ok: true; result: DesignBriefResult; ms: number } | { ok: false; error: unknown; ms: number }>;
};

async function companyBrandOf(deps: FastBuildDeps, tenant_id: string): Promise<CompanyBrand | null> {
  if (!deps.companyBrand) return null;
  try {
    return await deps.companyBrand(tenant_id);
  } catch (e) {
    console.warn(`[design-brief] tenant=${tenant_id} company brand unreadable: ${msg(e)}`);
    return null;
  }
}

function startDesignBrief(deps: FastBuildDeps, idea: string, name: string | null | undefined, template: SiteTemplate | null): DesignBriefRun {
  const startedAt = Date.now();
  const settled = Promise.resolve()
    .then(() => deps.designBrief({ idea, name, ...(template ? { templateLines: designBriefTemplateLines(template) } : {}) }))
    .then(
      (result) => ({ ok: true as const, result, ms: Date.now() - startedAt }),
      (error: unknown) => ({ ok: false as const, error, ms: Date.now() - startedAt }),
    );
  return { name: name ?? null, settled };
}

async function siteDesignBrief(run: DesignBriefRun, tenant_id: string, site: SiteRow): Promise<DesignBrief | null> {
  const r = await run.settled;
  if (!r.ok) {
    console.warn(`[design-brief] tenant=${tenant_id} site=${site.id} skipped: ${msg(r.error)}`);
    return null;
  }
  const result = r.result;
  if (result.brief) {
    console.info(`[design-brief] tenant=${tenant_id} site=${site.id} ${designBriefSummary(result.brief)}`);
    return result.brief;
  }
  console.info(`[design-brief] tenant=${tenant_id} site=${site.id} skipped: ${result.reason}`);
  return null;
}

type SiteDesign = { brief: DesignBrief; direction: DesignDirection; stored: boolean };

function designFromRow(row: SiteDesignRow): SiteDesign {
  const direction = findDirection(row.brief, row.chosen_direction, row.directions) ?? designDirections(row.brief)[0]!;
  return { brief: row.brief, direction, stored: true };
}

async function siteDesign(
  deps: FastBuildDeps,
  run: DesignBriefRun,
  tenant_id: string,
  site: SiteRow,
  idea: string,
  brandP: Promise<CompanyBrand | null>,
  referenceImages: readonly string[] = [],
  template: SiteTemplate | null = null,
): Promise<SiteDesign> {
  let stored: SiteDesignRow | null = null;
  if (deps.designStore) stored = await deps.designStore.get(tenant_id, site.id);
  if (stored) return designFromRow(stored);
  const rulesOnP = industryLookRulesOn(deps, tenant_id);
  const modelBrief = await siteDesignBrief(run, tenant_id, site);
  const brand = await brandP;
  const raw = modelBrief ?? fallbackDesignBrief({ idea });
  const shaped = template ? applySiteTemplate(raw, template) : raw;
  const looked = referenceImages.length === 0 && (await rulesOnP) ? applyIndustryLook(shaped, idea) : shaped;
  if (looked !== shaped) console.info(`[design-brief] tenant=${tenant_id} site=${site.id} industry look ${designBriefSummary(looked)}`);
  const made = withCompleteLook(applyCompanyBrand(looked, brandAppliesToSite(brand, site.name) ? brand : null, idea), idea);
  const brief: DesignBrief = !made.look_given && referenceImages.length > 0 ? { ...made, look_given: "references" } : made;
  if (!modelBrief) console.info(`[design-brief] tenant=${tenant_id} site=${site.id} fallback ${designBriefSummary(brief)}`);
  return { brief, direction: findDirection(brief, BRAND_DIRECTION_ID) ?? designDirections(brief)[0]!, stored: false };
}

async function waitsForLookOn(deps: FastBuildDeps, tenant_id: string): Promise<boolean> {
  if (!deps.waitsForLook) return true;
  try {
    return (await deps.waitsForLook(tenant_id)) === true;
  } catch {
    return true;
  }
}

async function industryLookRulesOn(deps: FastBuildDeps, tenant_id: string): Promise<boolean> {
  if (!deps.industryLookRules) return true;
  try {
    return (await deps.industryLookRules(tenant_id)) === true;
  } catch {
    return true;
  }
}

async function publishOnRequestOn(deps: FastBuildDeps, tenant_id: string): Promise<boolean> {
  try {
    return (await deps.publishOnRequest(tenant_id)) === true;
  } catch {
    return true;
  }
}

function reportSetupError(deps: FastBuildDeps, tenant_id: string, where: string, step: string, err: unknown): string {
  const reason = `${step}: ${msg(err)}`.slice(0, 500);
  if (err instanceof SetupConfigError || err instanceof SiteCredentialsMissing) {
    alertConfig(deps, tenant_id, `site setup failed for tenant=${tenant_id} ${where} on configuration: ${reason}`);
  } else {
    console.warn(`[fast-build] site setup failed for tenant=${tenant_id} ${where} (retryable): ${reason}`);
  }
  return reason;
}

async function setupFailed(deps: FastBuildDeps, site: SiteRow, step: string, err: unknown): Promise<FastBuildOutcome> {
  const tenant_id = site.tenant_id;
  const reason = reportSetupError(deps, tenant_id, `site=${site.id}`, step, err);
  const current = await deps.store.get(tenant_id, site.id).catch(() => null);
  if (current && DEAD.has(current.status)) {
    if (current.status === "failed") throw new Error("The build was stopped while its site was being set up.");
    return failed(`site_${current.status}`, { site_id: site.id, retryable: false });
  }
  await deps.store.update(tenant_id, site.id, { last_error: reason }).catch((e: unknown) => {
    console.warn(`[fast-build] could not record last_error on site ${site.id}: ${msg(e)}`);
  });
  return failed(`provisioning_failed:${step}`, { site_id: site.id, detail: msg(err) });
}
