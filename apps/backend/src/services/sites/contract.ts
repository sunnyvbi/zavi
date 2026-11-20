
import type { SiteVisionFinding, SiteVisionNotReviewedReason } from "./site-vision-review";

export type SiteStatus =
  | "provisioning" | "building" | "publishing" | "live"
  | "paused" | "waking" | "failed" | "fell_back_old" | "deleting" | "deleted";

export type SiteRow = {
  id: string;
  tenant_id: string;
  root_conductor_run_id: string | null;
  started_by_user_id: string | null;
  owner_email: string | null;
  label: string;
  name?: string | null;
  hostname: string;
  github_full_name: string | null;
  supabase_project_ref: string | null;
  supabase_url: string | null;
  status: SiteStatus;
  live_url: string | null;
  desired_sha: string | null;
  live_sha: string | null;
  live_deploy_id: string | null;
  last_visit_at: string | null;
  last_edit_at: string | null;
  paused_at: string | null;
  last_error: string | null;
  shard_id?: string | null;
  kernel_shard_id?: string | null;
  backend_mode?: "static" | "pooled" | "dedicated";
  host_version?: number;
  gateway_binding?: { shard_id: string; shard_url: string; status: "active" | "paused" | "tombstoned"; manifest_hash: string } | null;
  gateway_config?: { turnstile: { enabled: boolean; site_key: string | null } } | null;
  kv_host_version?: number;
  kv_drift_count?: number;
  github_export?: Record<string, unknown> | null;
  thumbnail_path?: string | null;
  publish_generation?: number;
  publish_run_id?: string | null;
  search_released_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type SiteProviderKind = "github_repo" | "supabase_project" | "cloudflare_host" | "r2_prefix" | "pooled_backend";
export type SiteProviderState = "claimed" | "created" | "cleanup_pending" | "delete_scheduled" | "delete_issuing" | "deleted";

export const SITE_PROJECT_DELETE_GRACE_DAYS = 7;

export const siteVaultKey = {
  serviceRole: (siteId: string) => `site.${siteId}.sb_service_role`,
  anon: (siteId: string) => `site.${siteId}.sb_anon`,
  dbPassword: (siteId: string) => `site.${siteId}.sb_db_password`,
};

export type SitePatch = Partial<Pick<SiteRow,
  "github_full_name" | "supabase_project_ref" | "supabase_url" | "status" | "live_url" | "desired_sha"
  | "last_visit_at" | "last_edit_at" | "paused_at" | "last_error" | "owner_email">>;

export interface SiteStore {
  getOrCreateForRun(input: { tenant_id: string; root_conductor_run_id: string; company_name: string; started_by_user_id: string | null; site_name?: string | null }): Promise<SiteRow>;
  get(tenant_id: string, site_id: string): Promise<SiteRow | null>;
  getByRun(tenant_id: string, conductor_run_id: string): Promise<SiteRow | null>;
  getByRepo(tenant_id: string, github_full_name: string): Promise<SiteRow | null>;
  listForTenant(tenant_id: string): Promise<SiteRow[]>;
  update(tenant_id: string, site_id: string, patch: SitePatch): Promise<SiteRow>;
  transition(tenant_id: string, site_id: string, from: SiteStatus[], to: SiteStatus, patch?: SitePatch): Promise<SiteRow | null>;
  activateIfDesired(tenant_id: string, site_id: string, sha: string, deploy_id: string, live_url: string, generation?: number, conductor_run_id?: string | null): Promise<boolean>;
  settleStopped(
    tenant_id: string,
    site_id: string,
    to: "building" | "failed",
    last_error: string,
    generation?: number,
    conductor_run_id?: string,
  ): Promise<SiteRow | null>;
  claimProvider(tenant_id: string, site_id: string, kind: SiteProviderKind, ref: Record<string, unknown>): Promise<void>;
  setProviderState(tenant_id: string, site_id: string, kind: SiteProviderKind, state: SiteProviderState, ref?: Record<string, unknown>): Promise<void>;
  scheduleProviderDelete(tenant_id: string, site_id: string, kind: SiteProviderKind, grace_days: number, ref?: Record<string, unknown>): Promise<string>;
  cancelProviderDelete(tenant_id: string, site_id: string, kind: SiteProviderKind, ref?: Record<string, unknown>): Promise<boolean>;
  beginProviderDelete(tenant_id: string, site_id: string, kind: SiteProviderKind, from: "delete_scheduled" | "delete_issuing"): Promise<boolean>;
}

export interface SitePublicResolver {
  byHostname(hostname: string): Promise<{ tenant_id: string; site_id: string; status: SiteStatus } | null>;
  byRepo(github_full_name: string): Promise<{ tenant_id: string; site_id: string; status: SiteStatus } | null>;
  claimIdleBatch(cutoff_iso: string, limit: number): Promise<Array<{ tenant_id: string; site_id: string; hostname: string }>>;
}

export type SupabaseSiteRef = { project_ref: string; url: string };
export interface SupabaseSiteProvisioner {
  ensureProject(input: { tenant_id: string; site_id: string }): Promise<SupabaseSiteRef>;
  configureAuth(input: { tenant_id: string; site_id: string; site_url: string }): Promise<void>;
  applySql(input: {
    tenant_id: string;
    site_id: string;
    migration_id: string;
    sql: string;
    guard?: (sql: string) => void;
    preserveExistingRows?: boolean;
  }): Promise<"applied" | "skipped">;
  verifyCatalog(input: { tenant_id: string; site_id: string }): Promise<string[]>;
  ensureOwnerAdmin(input: { tenant_id: string; site_id: string; owner_email: string }): Promise<{ user_id: string }>;
  ownerMagicLink(input: { tenant_id: string; site_id: string; owner_email: string; redirect_to: string }): Promise<string>;
  pause(input: { tenant_id: string; site_id: string }): Promise<"paused" | "unsupported" | "no_project">;
  restore(input: { tenant_id: string; site_id: string }): Promise<void>;
  teardown(input: { tenant_id: string; site_id: string }): Promise<"scheduled" | "absent" | "refused" | "retained">;
  purge(input: { tenant_id: string; site_id: string }): Promise<"deleted" | "not_due" | "not_scheduled" | "refused">;
  cancelDeletion(input: { tenant_id: string; site_id: string }): Promise<"restored" | "not_scheduled">;
}

export interface SiteSandbox {
  run(cmd: string, opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; redact?: string[]; user?: "root" | "user" }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean; transportError?: boolean }>;
  readFile(path: string): Promise<Buffer | string>;
  listFiles(dir: string): Promise<string[]>;
}
export interface SiteSandboxResolver {
  forSite(tenant_id: string, site_id: string): Promise<SiteSandbox | null>;
}

export const SITE_POINTER_TERMINAL: ReadonlySet<SiteStatus> = new Set<SiteStatus>(["deleting", "deleted", "fell_back_old"]);

export interface SitePointerLedger {
  markProjected(tenant_id: string, site_id: string, version: number, drift: boolean): Promise<number>;
  noteDrift(tenant_id: string, site_id: string): Promise<number>;
  driftBatch(settle_before_iso: string, limit: number): Promise<Array<{ tenant_id: string; site_id: string }>>;
}

export type SitePointerOutcome = "in_sync" | "repaired" | "removed" | "gone";
export type SitePointerResult = { outcome: SitePointerOutcome; site: SiteRow | null; drift_count?: number };

export type StagedDeploy = { deploy_id: string; preview_url: string; sha: string };
export interface SitePublisher {
  stage(input: {
    tenant_id: string;
    site_id: string;
    sha: string;
    sandbox: SiteSandbox;
    reuseInstall?: boolean;
    shouldYield?: () => Promise<boolean>;
  }): Promise<StagedDeploy>;
  previewUrl(input: { tenant_id: string; site_id: string; deploy_id: string; host: string }): Promise<string>;
  activate(input: { tenant_id: string; site_id: string; staged: StagedDeploy; generation?: number; conductor_run_id?: string | null }): Promise<{ url: string } | { superseded: true }>;
  verify(hostname: string): Promise<boolean>;
  teardown(input: { tenant_id: string; site_id: string }): Promise<void>;
}

export type SiteOwnerJourney = "passed" | "failed" | "not_required";
export type SiteGateResult = {
  ok: boolean;
  reason: string;
  evidence: string;
  owner_journey: SiteOwnerJourney;
  journeys?: string[];
  failed_journeys?: string[];
  fingerprints?: Record<string, string>;
  error_text?: "only" | "with_others";
  all_fingerprints?: Record<string, string>;
  page_text?: SiteGatePageText[];
  vision?: SiteGateVision;
  thumbnail?: string;
};
export type SiteGateVision = {
  status: "reviewed" | "not_reviewed";
  reason?: SiteVisionNotReviewedReason;
  ok?: boolean;
  findings: SiteVisionFinding[];
};

export type SiteGatePageBlock = { len: number; head: string; mark?: string };
export type SiteGatePageText = { path: string; text: string; sections?: string[]; blocks?: SiteGatePageBlock[] };

export type SiteTestSite = {
  test_site_id: string;
  preview_host: string;
  owner_login: string | null;
  customer_login?: string | null;
};
export interface SiteTestSites {
  createTestSite(input: { tenant_id: string; live_site_id: string; manifestRaw: unknown; ttl: number; deploy_id: string }): Promise<SiteTestSite>;
  destroyTestSite(input: { tenant_id: string; test_site_id: string }): Promise<void>;
}

export class SiteGateUnavailable extends Error {
  readonly code = "SITE_GATE_UNAVAILABLE";
  constructor(reason: string) {
    super(`the publish check is unavailable: ${reason}`);
    this.name = "SiteGateUnavailable";
  }
}

export type SitePublishLease = "leased" | "superseded" | "busy";
export interface SitePublishGenerations {
  begin(tenant_id: string, site_id: string, sha: string, conductor_run_id?: string): Promise<number | "busy">;
  lease(tenant_id: string, site_id: string, generation: number, ttl_s: number, token: string): Promise<SitePublishLease>;
  release(tenant_id: string, site_id: string, generation: number, token: string): Promise<void>;
}
export type SiteDeployOutcome =
  | { kind: "waiting" }
  | {
      kind: "live";
      url: string;
      verified_at: string;
      deploy_id?: string;
      notes?: string[];
    }
  | {
      kind: "repair";
      signal: string;
      journeys?: SiteKeptJourneys;
      free_fix?: "brief_journey";
    }
  | { kind: "failed"; reason: string };
export type SiteKeptJourneys = { names: string[]; must_pass: string[]; fingerprints?: Record<string, string> };
export type JourneyFixClaim =
  | { status: "claimed"; token: string }
  | { status: "already_used" }
  | { status: "unavailable"; reason: string };
export interface SiteDeployHandler {
  step(input: { tenant_id: string; conductor_run_id: string; site_id: string; sha: string; attempt: number; brief?: string; kept_journeys?: SiteKeptJourneys }): Promise<SiteDeployOutcome>;
}

export const SITE_IDLE_PAUSE_DAYS = 30;
export const siteKv = {
  host: (hostname: string) => `host:${hostname}`,
  lastSeen: (hostname: string) => `lastseen:${hostname}`,
  paused: (hostname: string) => `paused:${hostname}`,
};
export const SITE_WAKE_PATH = "/api/public/sites/wake";
export const VITE_STARTER_ID = "vite-react-supabase";
export const E2B_VITE_TEMPLATE_ALIAS = "zavi-vite-starter";
export const E2B_ZAVI_TEMPLATE_ALIAS = "zavi-vite-pooled-starter";
export const VITE_DEV_PORT = 5173;
export const SITE_REPO_DIR = "/home/user/repo";
export const STARTER_SQL_PATH = "supabase/starter.sql";
export const SITE_MIGRATIONS_DIR = "supabase/migrations";
export const SITE_MANIFEST_PATH = "zavi-site.json";
export const SMOKE_SCRIPT_PATH = "scripts/smoke.mjs";

export class SiteCredentialsMissing extends Error {
  constructor(public missing: string[]) { super(`site credentials missing: ${missing.join(", ")}`); }
}

export class SitePublishPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SitePublishPlatformError";
  }
}

export class SitePublishTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SitePublishTransientError";
  }
}

export class SiteBuildFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteBuildFailed";
  }
}

export type StarterFiles = { files: Record<string, string>; starter_sql?: string; manifest_json: string };
export interface SiteStarterProvider {
  starterFiles(): StarterFiles;
}

export type FastBuildContext = {
  tenant_id: string;
  conductor_run_id: string;
  company_name: string;
  workspace_name?: string | null;
  site_name?: string | null;
  idea: string;
  max_usd: number;
  started_by_user_id: string | null;
  owner_email: string | null;
  first_build_free: boolean;
  first_site?: boolean;
  reference_images?: string[];
  await_look_pick?: boolean;
  site_template?: unknown;
};

export type SiteSandboxReadyContext = {
  tenant_id: string;
  run_id: string;
  site_id: string;
  repo_full_name: string;
  e2b_sandbox_id: string;
};
