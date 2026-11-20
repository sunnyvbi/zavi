
import { randomUUID } from "node:crypto";
import { ensureSiteCommit } from "./site-commit";
import { isDatabaseConnectionFailure, isTransientPlatformError } from "./platform-errors";
import { SiteSqlError } from "./supabase-mgmt";
import { SiteMigrationChecksumMismatch } from "./supabase-site-provisioner";
import {
  SITE_MANIFEST_PATH,
  SITE_MIGRATIONS_DIR,
  SITE_REPO_DIR,
  SiteBuildFailed,
  SiteCredentialsMissing,
  SiteGateUnavailable,
  SitePublishPlatformError,
  SitePublishTransientError,
  type SiteDeployHandler,
  type SiteDeployOutcome,
  type SiteGateResult,
  type SiteKeptJourneys,
  type SitePublishGenerations,
  type SitePublisher,
  type SiteRow,
  type SiteSandbox,
  type SiteSandboxResolver,
  type SiteStore,
  type SiteTestSites,
  type StagedDeploy,
  type SupabaseSiteProvisioner,
} from "./contract";
import { ERROR_TEXT_JOURNEY, runSiteGate, type SiteGateInput } from "./site-gate";
import { JOURNEY_FIX_MARK, checkFidelity, fidelityAddendum, journeyDeadEnd, journeyRepairSignal, type FidelityResult } from "./design-fidelity";
import { briefForChosenLook, directionInThemeCss } from "./design-directions";
import type { SiteDesignRow, SiteDesignStore } from "./site-design-store";
import {
  SITE_VISION_CHECKPOINT_KEY,
  VISION_FIX_MARK,
  compactVisionBrief,
  mergeReviewFindings,
  qualifyingFindings,
  visionAddendum,
  visionModeOf,
  visionRepairSignal,
  visionReviewEnabled,
  type SiteVisionFinding,
  type SiteVisionMode,
} from "./site-vision-review";
import { checkSiteCopy, type SiteCopyCheck } from "./site-copy-check";
import { THEME_CSS_PATH } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { checkSiteMigrationSql } from "./site-sql-policy";
import { ROWS_CHANGED_MARKER } from "./site-row-guard";
import { classifySiteChange, runSiteLightGate, type SiteChange, type SiteLightGateInput, type SiteLightGateResult } from "./site-light-gate";
import { checkSiteContent, type SiteContentCheckInput, type SiteContentCheckResult } from "./site-content-check";
import type { SiteThumbnailStore } from "./site-thumbnail";
import type { PooledBackend } from "@/services/site-shards/facade";
import {
  CAPABILITY_NOT_SUPPORTED_CODE,
  capabilityNotSupported,
  describeCapabilities,
  detectDedicatedCapabilities,
  rawSqlRefusal,
  type DedicatedCapability,
} from "@/services/site-shards/capabilities";

export class SiteMigrationRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SiteMigrationRefused";
  }
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const MIGRATION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.sql$/;
const MAX_MIGRATIONS = 200;
const SIGNAL_MAX = 1_500;
const DEFAULT_ACTIVATION_WAIT_MS = 20_000;
const ACTIVATION_POLL_MS = 2_000;
const MAX_VERIFY_FAILURES = 3;
const VERIFY_BACKOFF_BASE_MS = 60_000;
const VERIFY_BACKOFF_MAX_MS = 10 * 60_000;
const VERIFY_GIVE_UP_MS = 30 * 60_000;
export const TEST_SITE_TTL_S = 30 * 60;
export const PUBLISH_LEASE_TTL_S = 10 * 60;
export const PUBLISH_LEASE_RENEW_MS = 2 * 60_000;
export const TEST_SITE_DESTROY_TIMEOUT_MS = 60_000;
export const STYLE_EDIT_NOT_LIGHT = "the change edits styles and needs the phone width check";
export const SUPERSEDED_REASON = "A newer version of this site is publishing, so this one was not published.";

const NOT_DEPLOYABLE = new Set(["fell_back_old", "deleting", "deleted"]);
const PRE_LIVE = ["provisioning", "building", "publishing"] as const;

export type SiteDeployTiming = {
  started_at: number;
  migrations_ms: number | null;
  stage_ms: number;
  gate: "light" | "full";
  gate_ms: number;
  activate_requested_at: number;
};

export type DeployCheckpoint = {
  deploy_id: string;
  sha: string;
  verify_failures: number;
  timing?: SiteDeployTiming;
  verify_failing_since?: number;
  next_verify_at?: number;
  verify_alerted_at?: number;
  generation?: number;
  phase?: "begun" | "gated";
  commit?: "pooled" | "none";
  gate_timing?: Omit<SiteDeployTiming, "activate_requested_at">;
  notes?: string[];
  test_site_id?: string;
};

export type SiteDeployTimingRow = Omit<SiteDeployTiming, "activate_requested_at"> & {
  tenant_id: string;
  site_id: string;
  conductor_run_id: string;
  activate_ms: number;
  total_ms: number;
};

export type DeployCheckpoints = {
  get(key: string): Promise<DeployCheckpoint | null>;
  set(key: string, value: DeployCheckpoint | null): Promise<void>;
};

export function memoryCheckpoints(ttlMs = 6 * 3600_000, now: () => number = Date.now): DeployCheckpoints {
  const m = new Map<string, { at: number; v: DeployCheckpoint }>();
  return {
    async get(key) {
      const e = m.get(key);
      if (!e) return null;
      if (now() - e.at > ttlMs) {
        m.delete(key);
        return null;
      }
      return { ...e.v };
    },
    async set(key, value) {
      if (value === null) m.delete(key);
      else m.set(key, { at: now(), v: { ...value } });
      if (m.size > 5_000) {
        const oldest = m.keys().next();
        if (!oldest.done) m.delete(oldest.value);
      }
    },
  };
}

export type SiteDeployDeps = {
  store: SiteStore;
  sandboxes: SiteSandboxResolver;
  supabase: Pick<SupabaseSiteProvisioner, "applySql" | "verifyCatalog">;
  alertOps?: (input: { tenant_id: string; code: string; msg: string }) => Promise<void>;
  publisher: Pick<SitePublisher, "stage" | "previewUrl">;
  requestActivate: (input: { tenant_id: string; site_id: string; deploy_id: string; sha: string; conductor_run_id?: string; generation?: number }) => Promise<void>;
  activationState: (site: SiteRow, staged: Pick<StagedDeploy, "deploy_id" | "sha">) => "live" | "superseded" | "pending";
  verifySiteDeploy: (hostname: string, deploy_id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  generations: SitePublishGenerations;
  testSites?: SiteTestSites | null;
  ownerAdminEnabled?: (tenant_id: string) => Promise<boolean>;
  pooled?: (Pick<PooledBackend, "validate" | "apply"> & Partial<Pick<PooledBackend, "moveToDedicated" | "kernelSqlAllowed" | "reserve">>) | null;
  wakeSite?: (hostname: string) => Promise<unknown>;
  checkpoints?: DeployCheckpoints;
  repoFetchToken?: () => Promise<string | null>;
  runGate?: (input: SiteGateInput) => Promise<SiteGateResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  activationWaitMs?: number;
  skipUnchangedMigrations?: (tenant_id: string) => Promise<boolean>;
  lightGateEnabled?: (tenant_id: string) => Promise<boolean>;
  classifyChange?: (sandbox: SiteSandbox, live_sha: string, sha: string) => Promise<SiteChange | null>;
  runLightGate?: (input: SiteLightGateInput) => Promise<SiteLightGateResult>;
  seedMetaCheckEnabled?: (tenant_id: string) => Promise<boolean>;
  signedImageCheckEnabled?: (tenant_id: string) => Promise<boolean>;
  lightGateColorEdits?: (tenant_id: string) => Promise<boolean>;
  bookingJourneyRequired?: (tenant_id: string) => Promise<boolean>;
  brandCheckEnabled?: (tenant_id: string) => Promise<boolean>;
  imagesCheckEnabled?: (tenant_id: string) => Promise<boolean>;
  checkContent?: (input: SiteContentCheckInput) => Promise<SiteContentCheckResult>;
  logDeployTiming?: (row: SiteDeployTimingRow) => Promise<void>;
  designBriefs?: Pick<SiteDesignStore, "get" | "recordFidelity">;
  env?: NodeJS.ProcessEnv;
  visionMode?: (tenant_id: string) => Promise<string>;
  repairMaxAttempts?: (tenant_id: string) => Promise<number>;
  recordVision?: (record: SiteVisionRecord) => Promise<void>;
  thumbnails?: SiteThumbnailStore | null;
};

export type SiteVisionAction =
  | "none"
  | "repair"
  | "rode_along"
  | "skipped_used"
  | "skipped_no_attempts"
  | "skipped_no_room"
  | "skipped_error_text"
  | "deferred_free_fix"
  | "declined";
export type SiteVisionRecord = {
  status: "reviewed" | "not_reviewed";
  reason?: string;
  ok?: boolean;
  mode: SiteVisionMode;
  sha: string;
  attempt: number;
  at: string;
  action: SiteVisionAction;
  counts: { findings: number; high: number; qualifying: number; preferences: number; qualifying_page?: number };
  page_check?: { pages: number };
  findings: SiteVisionFinding[];
};
const VISION_RECORD_FINDINGS = 5;
const VISION_RECORD_TEXT = 200;

async function defaultVisionMode(tenant_id: string): Promise<string> {
  const { getStringSetting } = await import("@/services/settings");
  return getStringSetting("site_vision_review_mode", tenant_id);
}

async function defaultRepairMax(tenant_id: string): Promise<number> {
  const { getNumberSetting } = await import("@/services/settings");
  return getNumberSetting("fast_build_repair_attempts", tenant_id);
}

function clip(s: string, n = SIGNAL_MAX): string {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function errText(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

class SiteMigrationCandidateInvalid extends Error {}

async function listMigrations(sandbox: SiteSandbox, sha: string): Promise<string[]> {
  const r = await sandbox.run(`git ls-tree --name-only ${sha} ${SITE_MIGRATIONS_DIR}/`, { cwd: SITE_REPO_DIR, timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error(`could not list ${SITE_MIGRATIONS_DIR} at ${sha.slice(0, 7)}: ${clip(r.stderr, 300)}`);
  const names = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => p.slice(p.lastIndexOf("/") + 1))
    .filter((n) => n.endsWith(".sql"));
  const bad = names.find((n) => !MIGRATION_NAME_RE.test(n));
  if (bad) throw new SiteMigrationCandidateInvalid(`migration file name "${bad}" is not allowed (use NNN_name.sql)`);
  if (names.length > MAX_MIGRATIONS) throw new SiteMigrationCandidateInvalid(`too many migration files (${names.length})`);
  return [...names].sort();
}

async function readMigration(sandbox: SiteSandbox, sha: string, name: string): Promise<string> {
  const r = await sandbox.run(`git show ${sha}:${SITE_MIGRATIONS_DIR}/${name}`, { cwd: SITE_REPO_DIR, timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error(`could not read ${name}: ${clip(r.stderr, 300)}`);
  return r.stdout;
}

async function forbiddenSqlPathsAt(sandbox: SiteSandbox, sha: string): Promise<string[]> {
  const r = await sandbox.run(`git ls-tree -r --name-only ${sha}`, { cwd: SITE_REPO_DIR, timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error(`could not list files at ${sha.slice(0, 7)}: ${clip(r.stderr, 300)}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter(Boolean)
    .filter((p) => {
      const n = p.toLowerCase();
      return n === "supabase" || n.startsWith("supabase/") || n.endsWith(".sql");
    });
}

async function readManifestAt(sandbox: SiteSandbox, sha: string): Promise<{ raw: unknown } | { parseError: string }> {
  const listed = await sandbox.run(`git ls-tree --name-only ${sha} -- ${SITE_MANIFEST_PATH}`, { cwd: SITE_REPO_DIR, timeoutMs: 60_000 });
  if (listed.exitCode !== 0) throw new Error(`could not list ${SITE_MANIFEST_PATH} at ${sha.slice(0, 7)}: ${clip(listed.stderr, 300)}`);
  if (!listed.stdout.trim()) return { raw: null };
  const r = await sandbox.run(`git show ${sha}:${SITE_MANIFEST_PATH}`, { cwd: SITE_REPO_DIR, timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error(`could not read ${SITE_MANIFEST_PATH}: ${clip(r.stderr, 300)}`);
  try {
    return { raw: JSON.parse(r.stdout) };
  } catch (e) {
    return { parseError: clip(errText(e), 200) };
  }
}

function mentionsCollections(raw: unknown): boolean {
  const c = (raw as { collections?: unknown } | null)?.collections;
  return Array.isArray(c) ? c.length > 0 : !!c && typeof c === "object" && Object.keys(c).length > 0;
}

export function checkpointKey(i: { tenant_id: string; conductor_run_id: string; site_id: string; sha: string; attempt: number }): string {
  return `${i.tenant_id}:${i.conductor_run_id}:${i.site_id}:${i.sha}:${i.attempt}`;
}

type DbScan =
  | { db: "static" }
  | { db: "pooled"; manifestRaw: unknown; unchanged: boolean }
  | { db: "dedicated"; notes: string[] };

function noReplaceRefs(sandbox: SiteSandbox): SiteSandbox {
  return {
    run: (cmd, opts) => sandbox.run(cmd, { ...(opts ?? {}), env: { ...(opts?.env ?? {}), GIT_NO_REPLACE_OBJECTS: "1" } }),
    readFile: (path) => sandbox.readFile(path),
    listFiles: (dir) => sandbox.listFiles(dir),
  };
}

function isTestSiteRefused(e: unknown): e is { reason?: string; errors?: string[] } {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "TestSiteRefused";
}

const TEST_SITE_ID_RE =/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function createSiteDeployHandler(deps: SiteDeployDeps): SiteDeployHandler {
  const checkpoints = deps.checkpoints ?? memoryCheckpoints();
  const runGate = deps.runGate ?? runSiteGate;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const activationWaitMs = deps.activationWaitMs ?? DEFAULT_ACTIVATION_WAIT_MS;
  const classifyChange = deps.classifyChange ?? classifySiteChange;
  const runLightGate = deps.runLightGate ?? runSiteLightGate;
  const checkContent = deps.checkContent ?? checkSiteContent;
  const recordVision =
    deps.recordVision ?? ((record: SiteVisionRecord) => checkpoints.set(SITE_VISION_CHECKPOINT_KEY, record as unknown as DeployCheckpoint));

  async function readVisionMode(tenant_id: string): Promise<SiteVisionMode> {
    try {
      return visionModeOf(await (deps.visionMode ?? defaultVisionMode)(tenant_id));
    } catch (e) {
      console.warn(`[site-deploy] vision mode unreadable, observing only: ${clip(errText(e), 200)}`);
      return "observe";
    }
  }

  async function readRepairMax(tenant_id: string): Promise<number | null> {
    try {
      const max = Math.floor(await (deps.repairMaxAttempts ?? defaultRepairMax)(tenant_id));
      return Number.isFinite(max) ? Math.max(0, max) : null;
    } catch {
      return null;
    }
  }

  async function noteVision(input: {
    tenant_id: string;
    site_id: string;
    sha: string;
    attempt: number;
    mode: SiteVisionMode;
    gate: SiteGateResult;
    copy: SiteCopyCheck | null;
    action: SiteVisionAction;
  }): Promise<void> {
    const v = input.gate.vision;
    if (!v) return;
    const findings = mergeReviewFindings(input.copy?.findings ?? [], v.findings);
    const qualifying = qualifyingFindings(findings);
    const record: SiteVisionRecord = {
      status: v.status,
      ...(v.status === "reviewed" ? { ok: v.ok === true } : { reason: v.reason ?? "error" }),
      mode: input.mode,
      sha: input.sha,
      attempt: input.attempt,
      at: new Date(now()).toISOString(),
      action: input.action,
      counts: {
        findings: findings.length,
        high: findings.filter((f) => f.severity === "high").length,
        qualifying: qualifying.length,
        preferences: findings.filter((f) => f.class === "preference").length,
        ...(input.copy ? { qualifying_page: qualifying.filter((f) => f.source === "page").length } : {}),
      },
      ...(input.copy ? { page_check: { pages: input.copy.pages } } : {}),
      findings: findings.slice(0, VISION_RECORD_FINDINGS).map((f) => ({
        ...f,
        evidence: f.evidence.slice(0, VISION_RECORD_TEXT),
        suggestion: f.suggestion.slice(0, VISION_RECORD_TEXT),
      })),
    };
    console.info(
      `[site-deploy] event=vision_review tenant=${input.tenant_id} site=${input.site_id} sha=${input.sha.slice(0, 7)} attempt=${input.attempt} mode=${record.mode} status=${record.status}${record.reason ? ` reason=${record.reason}` : ""} findings=${record.counts.findings} high=${record.counts.high} qualifying=${record.counts.qualifying}${input.copy ? ` page_findings=${input.copy.findings.length}` : ""} action=${record.action}`,
    );
    await recordVision(record).catch((e: unknown) => {
      console.warn(`[site-deploy] vision review not recorded for site ${input.site_id}: ${clip(errText(e), 200)}`);
    });
  }

  async function recordError(tenant_id: string, site_id: string, reason: string): Promise<void> {
    await deps.store.update(tenant_id, site_id, { last_error: clip(reason, 500) }).catch(() => undefined);
  }

  async function alert(tenant_id: string, code: string, msg: string): Promise<void> {
    await deps.alertOps?.({ tenant_id, code, msg }).catch(() => undefined);
  }

  async function flag(read: ((tenant_id: string) => Promise<boolean>) | undefined, tenant_id: string): Promise<boolean> {
    if (!read) return false;
    try {
      return (await read(tenant_id)) === true;
    } catch {
      return false;
    }
  }

  async function logTiming(tenant_id: string, site_id: string, conductor_run_id: string, timing: SiteDeployTiming | undefined): Promise<void> {
    if (!timing || !deps.logDeployTiming) return;
    const at = now();
    const { activate_requested_at, ...rest } = timing;
    await deps
      .logDeployTiming({
        ...rest,
        tenant_id,
        site_id,
        conductor_run_id,
        activate_ms: Math.max(0, at - activate_requested_at),
        total_ms: Math.max(0, at - timing.started_at),
      })
      .catch(() => undefined);
  }

  async function destroyTestSite(tenant_id: string, site_id: string, test_site_id: string): Promise<boolean> {
    if (!deps.testSites) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        deps.testSites.destroyTestSite({ tenant_id, test_site_id }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), TEST_SITE_DESTROY_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch (e) {
      console.error(`[site-deploy] test site ${test_site_id} of site ${site_id} was not destroyed: ${clip(errText(e), 200)}`);
      await alert(tenant_id, "site_test_site_not_destroyed", `Test site ${test_site_id} (gate of site ${site_id}) was not destroyed; the next tick retries and its TTL reaps it.`);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function pooledScan(tenant_id: string, site: SiteRow, sandbox: SiteSandbox, sha: string, kernel: boolean, graduatedSql = false): Promise<SiteDeployOutcome | DbScan> {
    const sqlFiles = graduatedSql ? [] : await forbiddenSqlPathsAt(sandbox, sha);
    const m = await readManifestAt(sandbox, sha);
    const detected = detectDedicatedCapabilities({ manifestRaw: "raw" in m ? m.raw : null, paths: sqlFiles });
    if (detected.declaredRawSql && !graduatedSql) {
      const refusal = rawSqlRefusal([], SITE_MANIFEST_PATH);
      await recordError(tenant_id, site.id, refusal.reason);
      return { kind: "repair", signal: refusal.signal };
    }
    if (kernel && !graduatedSql && detected.capabilities.length) {
      const reason = capabilityNotSupported(detected.capabilities);
      await recordError(tenant_id, site.id, `${CAPABILITY_NOT_SUPPORTED_CODE}: ${reason}`);
      return { kind: "failed", reason };
    }
    if (!kernel && deps.pooled?.moveToDedicated && detected.capabilities.length) {
      return moveToDedicated(tenant_id, site, detected.capabilities);
    }
    if (detected.rawSql && !graduatedSql) {
      const refusal = rawSqlRefusal(detected.sqlPaths, SITE_MANIFEST_PATH);
      await recordError(tenant_id, site.id, refusal.reason);
      return { kind: "repair", signal: refusal.signal };
    }
    if ("parseError" in m) {
      const reason = `${SITE_MANIFEST_PATH} is not valid JSON: ${m.parseError}`;
      await recordError(tenant_id, site.id, reason);
      return { kind: "repair", signal: `${reason}\nFix ${SITE_MANIFEST_PATH} so it is one valid JSON object.` };
    }
    if (!deps.pooled) {
      if (site.backend_mode === "pooled" || kernel || mentionsCollections(m.raw)) {
        await recordError(tenant_id, site.id, "pooled backend not configured");
        return { kind: "failed", reason: "The site's database is not available right now." };
      }
      return { db: "static" };
    }
    const out = await deps.pooled.validate({ tenant_id, site, manifestRaw: m.raw, paths: sqlFiles });
    if (out.kind === "static") return { db: "static" };
    if (out.kind === "ok") return { db: "pooled", manifestRaw: m.raw, unchanged: out.unchanged };
    if (out.kind === "dedicated_required") {
      if (deps.pooled.moveToDedicated) return moveToDedicated(tenant_id, site, out.capabilities);
      const reason = `This site needs ${describeCapabilities(out.capabilities)}, which needs its own database project; that is not available right now.`;
      await recordError(tenant_id, site.id, reason);
      return { kind: "failed", reason };
    }
    return refusalRepair(tenant_id, site.id, out);
  }

  async function refusalRepair(
    tenant_id: string,
    site_id: string,
    out: { kind: "invalid"; errors: string[] } | { kind: "refused"; reason: string; code?: string },
  ): Promise<SiteDeployOutcome> {
    const reason =
      out.kind === "invalid"
        ? `${SITE_MANIFEST_PATH} was rejected: ${clip(out.errors.join("; "), 800)}`
        : `The site's collections could not be applied: ${clip(out.reason, 800)}`;
    await recordError(tenant_id, site_id, reason);
    if (out.kind === "refused" && out.code === "not_additive") return { kind: "repair", signal: reason };
    return {
      kind: "repair",
      signal: `${reason}\nFix the collections in ${SITE_MANIFEST_PATH}. A live site's collections, fields and rules can only be added to (never removed, renamed or narrowed), and a collection cannot switch between records and files.`,
    };
  }

  async function moveToDedicated(tenant_id: string, site: SiteRow, caps: DedicatedCapability[]): Promise<SiteDeployOutcome | DbScan> {
    const need = describeCapabilities(caps);
    const move = await deps.pooled!.moveToDedicated!({ tenant_id, site, capabilities: caps });
    if (move.kind === "dedicated" || move.kind === "already_dedicated") {
      return {
        db: "dedicated",
        notes: [
          `This site needs ${need}, which the built-in database does not offer, so it now has its own database project. ` +
            `Read and write data with the Supabase client (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY), keep schema changes in ${SITE_MIGRATIONS_DIR}/, ` +
            `and stop calling the built-in /api/data routes.`,
        ],
      };
    }
    const reason = move.available
      ? `This site needs ${need}, so it is moving to its own database project. Its data, files and members move with it; ` +
        `writes pause for a few minutes during the move, and members sign in again with the same password. Deploy again once the move has finished.`
      : `This site needs ${need}, which needs its own database project. The move has been requested and the Zavi team has been alerted; ` +
        `the site keeps running on the built-in database until then.`;
    await recordError(tenant_id, site.id, reason);
    return { kind: "failed", reason };
  }

  async function unverified(
    tenant_id: string,
    site_id: string,
    hostname: string,
    cp: DeployCheckpoint,
    error: string,
  ): Promise<DeployCheckpoint> {
    const failures = cp.verify_failures + 1;
    const t = now();
    const next: DeployCheckpoint = {
      ...cp,
      verify_failures: failures,
      verify_failing_since: cp.verify_failing_since ?? t,
      next_verify_at: t + Math.min(VERIFY_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 10), VERIFY_BACKOFF_MAX_MS),
    };
    if (failures >= MAX_VERIFY_FAILURES && typeof cp.verify_alerted_at !== "number") {
      next.verify_alerted_at = t;
      const minutes = Math.round((t - (next.verify_failing_since ?? t)) / 60_000);
      await recordError(tenant_id, site_id, `Published, but ${hostname} is not serving the new version yet. Zavi keeps checking and the team has been alerted.`);
      console.error(
        JSON.stringify({ evt: "site_deploy.live_unverified", tenant_id, site_id, deploy_id: cp.deploy_id, failures, minutes, error: clip(error, 300) }),
      );
      await deps
        .alertOps?.({
          tenant_id,
          code: "site_live_unverified",
          msg: `Site ${site_id} deploy ${cp.deploy_id} is live in the row and host record but its hostname has not served it for ${minutes} min (${failures} checks): ${clip(error, 200)}`,
        })
        .catch(() => undefined);
    }
    return next;
  }

  async function settle(
    tenant_id: string,
    site_id: string,
    conductor_run_id: string,
    key: string,
    cp: DeployCheckpoint,
  ): Promise<SiteDeployOutcome> {
    const deadline = now() + activationWaitMs;
    for (;;) {
      const site = await deps.store.get(tenant_id, site_id);
      if (!site) return { kind: "failed", reason: "The site no longer exists." };
      let state = deps.activationState(site, cp);
      if (state === "pending" && cp.generation !== undefined && typeof site.publish_generation === "number" && site.publish_generation !== cp.generation) {
        state = "superseded";
      }
      if (state === "superseded") {
        await checkpoints.set(key, null);
        return { kind: "failed", reason: SUPERSEDED_REASON };
      }
      if (state === "live") {
        if (typeof cp.next_verify_at === "number" && now() < cp.next_verify_at) return { kind: "waiting" };
        const verified = await deps.verifySiteDeploy(site.hostname, cp.deploy_id);
        if (!verified.ok) {
          const next = await unverified(tenant_id, site_id, site.hostname, cp, verified.error);
          if (now() - (next.verify_failing_since ?? now()) >= VERIFY_GIVE_UP_MS) {
            await deps.store.transition(tenant_id, site_id, [...PRE_LIVE], "live").catch(() => false);
            await checkpoints.set(key, null);
            console.error(
              JSON.stringify({ evt: "site_deploy.live_unverified_released", tenant_id, site_id, deploy_id: cp.deploy_id, failures: next.verify_failures }),
            );
            await deps
              .alertOps?.({
                tenant_id,
                code: "site_live_unverified_released",
                msg: `Site ${site_id} deploy ${cp.deploy_id} stays live in the row and host record, but its hostname never served it in ${Math.round(VERIFY_GIVE_UP_MS / 60_000)} min; the build run ended so the workspace can edit again. Fix the hostname route.`,
              })
              .catch(() => undefined);
            return {
              kind: "failed",
              reason: `Your site was published, but ${site.hostname} is not answering yet. The Zavi team has been alerted; you do not need to publish again.`,
            };
          }
          await checkpoints.set(key, next);
          return { kind: "waiting" };
        }
        await deps.store.transition(tenant_id, site_id, [...PRE_LIVE], "live", { last_error: null });
        if (site.last_error) await deps.store.update(tenant_id, site_id, { last_error: null }).catch(() => undefined);
        await checkpoints.set(key, null);
        await logTiming(tenant_id, site_id, conductor_run_id, cp.timing);
        return {
          kind: "live",
          url: site.live_url ?? `https://${site.hostname}`,
          verified_at: new Date(now()).toISOString(),
          deploy_id: cp.deploy_id,
          ...(cp.notes?.length ? { notes: cp.notes } : {}),
        };
      }
      if (now() >= deadline) return { kind: "waiting" };
      await sleep(ACTIVATION_POLL_MS);
    }
  }

  async function commitAndActivate(
    tenant_id: string,
    site_id: string,
    conductor_run_id: string,
    key: string,
    cp: DeployCheckpoint,
    manifestRaw: unknown,
  ): Promise<SiteDeployOutcome> {
    const generation = cp.generation;
    if (generation === undefined || !cp.gate_timing) throw new Error("deploy checkpoint has no generation");
    const notes = [...(cp.notes ?? [])];
    if (cp.commit === "pooled" && !deps.pooled) {
      await recordError(tenant_id, site_id, "pooled backend not configured");
      return { kind: "failed", reason: "The site's database is not available right now." };
    }
    const token = randomUUID();
    const lease = await deps.generations.lease(tenant_id, site_id, generation, PUBLISH_LEASE_TTL_S, token);
    if (lease === "superseded") {
      await checkpoints.set(key, null);
      return { kind: "failed", reason: SUPERSEDED_REASON };
    }
    if (lease === "busy") return { kind: "waiting" };
    let active: DeployCheckpoint;
    let lost = false;
    let released = false;
    let inflight: Promise<void> | null = null;
    const renew = async (): Promise<boolean> => {
      if (released || lost) return !lost && !released;
      try {
        const r = await deps.generations.lease(tenant_id, site_id, generation, PUBLISH_LEASE_TTL_S, token);
        if (r === "leased") return true;
        console.error(`[site-deploy] publish lease renewal for site ${site_id} answered ${r}`);
        await alert(tenant_id, "site_publish_lease_lost", `The commit lease of site ${site_id} (generation ${generation}) was lost: ${r}.`);
      } catch (e) {
        console.warn(`[site-deploy] publish lease renewal failed for site ${site_id}: ${clip(errText(e), 200)}`);
      }
      lost = true;
      return false;
    };
    const heartbeat = setInterval(() => {
      if (released || inflight) return;
      inflight = renew().then(() => undefined).finally(() => {
        inflight = null;
      });
    }, PUBLISH_LEASE_RENEW_MS);
    const fence = async (): Promise<boolean> => !lost && (await renew());
    try {
      const fresh = await deps.store.get(tenant_id, site_id);
      if (!fresh || fresh.tenant_id !== tenant_id) {
        await checkpoints.set(key, null);
        return { kind: "failed", reason: "The site no longer exists." };
      }
      if (cp.commit === "pooled") {
        const out = await deps.pooled!.apply({ tenant_id, site: fresh, manifestRaw, additiveOnly: true, fence, generation });
        if (out.kind === "active") {
          const building = out.index_building ?? [];
          if (building.length) {
            notes.push(
              `The index of ${building.join(", ")} is still rebuilding: filtered or sorted lists answer index_building until it finishes (usually within the hour). Plain lists, reads and writes work now.`,
            );
          }
        } else if (out.kind === "dedicated_required") {
          await checkpoints.set(key, null);
          const reason = `This site needs ${describeCapabilities(out.capabilities)}, which needs its own database project.`;
          await recordError(tenant_id, site_id, reason);
          return { kind: "failed", reason };
        } else if (out.kind === "refused" && out.code === "lease_lost") {
          const now_ = await deps.store.get(tenant_id, site_id);
          if (!now_ || (typeof now_.publish_generation === "number" && now_.publish_generation !== generation)) {
            await checkpoints.set(key, null);
            return { kind: "failed", reason: SUPERSEDED_REASON };
          }
          return { kind: "waiting" };
        } else if (out.kind !== "static") {
          await checkpoints.set(key, null);
          return refusalRepair(tenant_id, site_id, out);
        }
      }
      if (!(await fence())) {
        const cur = await deps.store.get(tenant_id, site_id);
        if (!cur || (typeof cur.publish_generation === "number" && cur.publish_generation !== generation)) {
          await checkpoints.set(key, null);
          return { kind: "failed", reason: SUPERSEDED_REASON };
        }
        return { kind: "waiting" };
      }
      const now_ = await deps.store.get(tenant_id, site_id);
      if (!now_) {
        await checkpoints.set(key, null);
        return { kind: "failed", reason: "The site no longer exists." };
      }
      if (typeof now_.publish_generation === "number" && now_.publish_generation !== generation) {
        await checkpoints.set(key, null);
        return { kind: "failed", reason: SUPERSEDED_REASON };
      }
      active = {
        deploy_id: cp.deploy_id,
        sha: cp.sha,
        verify_failures: 0,
        timing: { ...cp.gate_timing, activate_requested_at: now() },
        generation,
        ...(notes.length ? { notes } : {}),
        ...(cp.test_site_id ? { test_site_id: cp.test_site_id } : {}),
      };
      await checkpoints.set(key, active);
      await deps.requestActivate({ tenant_id, site_id, deploy_id: cp.deploy_id, sha: cp.sha, conductor_run_id, generation });
    } finally {
      released = true;
      clearInterval(heartbeat);
      if (inflight) await (inflight as Promise<void>).catch(() => undefined);
      await deps.generations.release(tenant_id, site_id, generation, token).catch((e: unknown) => {
        console.warn(`[site-deploy] publish lease release failed for site ${site_id}: ${clip(errText(e), 200)}`);
      });
    }
    return settle(tenant_id, site_id, conductor_run_id, key, active);
  }

  async function gateOnTestSite(input: {
    tenant_id: string;
    site: SiteRow;
    sandbox: SiteSandbox;
    sha: string;
    key: string;
    cp: DeployCheckpoint;
    deploy_id: string;
    manifestRaw: unknown;
    ownerRequired: boolean;
    brief?: string; booking_required?: boolean; brand_checks?: boolean;
    images_check?: boolean; first_build?: boolean;
    kept_journeys?: SiteKeptJourneys;
    page_text?: boolean;
    vision?: SiteGateInput["vision"];
    thumbnail?: boolean;
  }): Promise<{ gate: SiteGateResult; owner_supplied: boolean; left: () => string | null }> {
    const { tenant_id, site, key, cp } = input;
    if (!deps.testSites) throw new SiteGateUnavailable("no test-site backend is wired");
    let ts: Awaited<ReturnType<SiteTestSites["createTestSite"]>>;
    try {
      ts = await deps.testSites.createTestSite({
        tenant_id,
        live_site_id: site.id,
        manifestRaw: input.manifestRaw,
        ttl: TEST_SITE_TTL_S,
        deploy_id: input.deploy_id,
      });
    } catch (e) {
      if (isTestSiteRefused(e)) {
        const why = [e.reason, ...(e.errors ?? [])].filter(Boolean).join("; ");
        return {
          gate: { ok: false, reason: clip(`the candidate could not be set up on a test site: ${why}`, 600), evidence: "", owner_journey: "not_required" },
          owner_supplied: false,
          left: () => null,
        };
      }
      throw e;
    }
    if (!ts || typeof ts.test_site_id !== "string" || !TEST_SITE_ID_RE.test(ts.test_site_id)) {
      throw new SiteGateUnavailable("the test site came back without an id");
    }
    await checkpoints.set(key, { ...cp, test_site_id: ts.test_site_id });
    let left: string | null = ts.test_site_id;
    try {
      if (input.ownerRequired && !ts.owner_login) throw new SiteGateUnavailable("the test site has no owner sign-in");
      const preview_url = await deps.publisher.previewUrl({ tenant_id, site_id: site.id, deploy_id: input.deploy_id, host: ts.preview_host });
      const owner_link = input.ownerRequired ? ts.owner_login : null;
      const customer_link = ts.customer_login ?? null;
      const gate = await runGate({
        sandbox: input.sandbox,
        preview_url,
        owner_link,
        customer_link,
        customer_expected: ts.owner_login !== null,
        allow_writes: true,
        sha: input.sha,
        tenant_id,
        site_id: site.id,
        backend_mode: "pooled",
        brief: input.brief, booking_required: input.booking_required, brand_checks: input.brand_checks,
        images_check: input.images_check, first_build: input.first_build,
        kept_journeys: input.kept_journeys,
        site_name: site.name ?? null,
        page_text: input.page_text === true,
        ...(input.vision ? { vision: input.vision } : {}),
        ...(input.thumbnail ? { thumbnail: true } : {}),
      });
      return { gate, owner_supplied: owner_link !== null, left: () => left };
    } finally {
      if (await destroyTestSite(tenant_id, site.id, ts.test_site_id)) left = null;
      await checkpoints.set(key, left ? { ...cp, test_site_id: left } : { ...cp });
    }
  }

  async function loadDesign(tenant_id: string, site_id: string): Promise<SiteDesignRow | null> {
    if (!deps.designBriefs) return null;
    try {
      return await deps.designBriefs.get(tenant_id, site_id);
    } catch (e) {
      console.warn(`[site-deploy] design brief unreadable for site ${site_id}: ${clip(errText(e), 200)}`);
      return null;
    }
  }

  async function recordDesignCheck(input: {
    tenant_id: string;
    site: SiteRow;
    sandbox: SiteSandbox;
    sha: string;
    design: SiteDesignRow;
    gate: SiteGateResult;
  }): Promise<FidelityResult | null> {
    const { tenant_id, site, design } = input;
    let fidelity: FidelityResult | null = null;
    try {
      fidelity = input.gate.page_text?.length ? checkFidelity({ brief: briefForChosenLook(design), siteName: site.name ?? null, pages: input.gate.page_text }) : null;
    } catch (e) {
      console.warn(`[site-deploy] brief fidelity not checked for site ${site.id}: ${clip(errText(e), 200)}`);
    }
    let applied: string | null = null;
    if (design.theme_mode === "theme_css") {
      try {
        const r = await input.sandbox.run(`git --no-replace-objects show ${input.sha}:${THEME_CSS_PATH}`, { cwd: SITE_REPO_DIR, timeoutMs: 60_000 });
        applied = r.exitCode === 0 ? directionInThemeCss(r.stdout) : null;
      } catch {
        applied = null;
      }
    }
    if (fidelity) {
      console.info(
        `[site-deploy] brief fidelity site=${site.id} found=${fidelity.found}/${fidelity.total} gross=${fidelity.gross} look=${applied ?? "?"}`,
      );
      await deps.designBriefs?.recordFidelity(tenant_id, site.id, fidelity, applied).catch((e: unknown) => {
        console.warn(`[site-deploy] brief fidelity not recorded for site ${site.id}: ${clip(errText(e), 200)}`);
      });
    }
    return fidelity;
  }

  async function run(input: { tenant_id: string; conductor_run_id: string; site_id: string; sha: string; attempt: number; brief?: string; kept_journeys?: SiteKeptJourneys }, key: string): Promise<SiteDeployOutcome> {
    const { tenant_id, conductor_run_id, site_id, sha } = input;
    const site = await deps.store.get(tenant_id, site_id);
    if (!site || site.tenant_id !== tenant_id) return { kind: "failed", reason: "The site no longer exists." };
    if (NOT_DEPLOYABLE.has(site.status)) return { kind: "failed", reason: `The site is ${site.status.replace(/_/g, " ")}.` };

    let cp = await checkpoints.get(key);
    if (cp && cp.sha !== sha) cp = null;
    if (cp?.test_site_id) {
      if (await destroyTestSite(tenant_id, site_id, cp.test_site_id)) {
        const { test_site_id: _gone, ...rest } = cp;
        cp = rest;
        await checkpoints.set(key, cp);
      } else if (cp.phase === "begun") {
        throw new SiteGateUnavailable(`test site ${cp.test_site_id} is not destroyed yet`);
      }
    }

    if (cp && !cp.phase && cp.deploy_id) {
      if (deps.activationState(site, cp) === "pending") {
        await deps.requestActivate({ tenant_id, site_id, deploy_id: cp.deploy_id, sha: cp.sha, conductor_run_id, ...(cp.generation ? { generation: cp.generation } : {}) });
      }
      return settle(tenant_id, site_id, conductor_run_id, key, cp);
    }
    if (site.live_sha === sha && site.live_deploy_id && site.desired_sha === sha) {
      return settle(tenant_id, site_id, conductor_run_id, key, { deploy_id: site.live_deploy_id, sha, verify_failures: 0 });
    }

    if (site.status === "paused" || site.status === "waking") {
      if (site.status === "paused" && deps.wakeSite) {
        await deps.wakeSite(site.hostname).catch((e: unknown) => {
          console.warn(`[site-deploy] wake failed for site ${site_id}: ${clip(errText(e), 200)}`);
        });
      }
      return { kind: "waiting" };
    }

    if (!cp?.generation) {
      const generation = await deps.generations.begin(tenant_id, site_id, sha, conductor_run_id);
      if (generation === "busy") return { kind: "waiting" };
      cp ={ deploy_id: "", sha, verify_failures: 0, ...(cp ?? {}), generation, phase: "begun" };
      await checkpoints.set(key, cp);
    }
    if (cp.phase === "begun" && cp.generation && deps.pooled?.reserve && (site.shard_id || site.kernel_shard_id)) {
      await deps.pooled.reserve({ tenant_id, site, generation: cp.generation });
    }
    await deps.store.transition(tenant_id, site_id, ["provisioning", "building"], "publishing");

    const siteSandbox = await deps.sandboxes.forSite(tenant_id, site_id);
    if (!siteSandbox) {
      await recordError(tenant_id, site_id, "site sandbox gone");
      return { kind: "failed", reason: "The site's build sandbox is gone. Start the build again." };
    }
    const sandbox = noReplaceRefs(siteSandbox);

    const fetchToken = deps.repoFetchToken ? await deps.repoFetchToken().catch(() => null) : null;
    await ensureSiteCommit(sandbox, site.github_full_name, sha, fetchToken);

    if (cp.phase === "gated") {
      let manifestRaw: unknown = null;
      if (cp.commit === "pooled") {
        const m = await readManifestAt(sandbox, sha);
        if ("parseError" in m) throw new Error(`${SITE_MANIFEST_PATH} at the gated commit no longer parses`);
        manifestRaw = m.raw;
      }
      return commitAndActivate(tenant_id, site_id, conductor_run_id, key, cp, manifestRaw);
    }

    const started_at = now();
    const liveSha = site.live_sha && SHA_RE.test(site.live_sha) && site.live_sha !== sha ? site.live_sha : null;
    const skipOn = liveSha ? await flag(deps.skipUnchangedMigrations, tenant_id) : false;
    const lightOn = liveSha ? await flag(deps.lightGateEnabled, tenant_id) : false;
    let change: SiteChange | null = null;
    if (liveSha && (skipOn || lightOn)) {
      try {
        change = await classifyChange(sandbox, liveSha, sha);
      } catch {
        change = null;
      }
    }

    let mode = site.backend_mode ?? "dedicated";
    const kernelSite = mode === "dedicated" && !!site.kernel_shard_id;
    let graduatedSql = false;
    if (kernelSite) {
      try {
        graduatedSql = deps.pooled?.kernelSqlAllowed ? await deps.pooled.kernelSqlAllowed({ tenant_id, site }) : false;
      } catch (e) {
        throw new Error(`could not read the site's database policy: ${clip(errText(e), 200)}`);
      }
    }
    let pooledActive = false;
    let manifestRaw: unknown = null;
    let deployNotes: string[] = [];
    let databaseUnchanged = true;
    let movedToDedicated = false;
    if (kernelSite || mode !== "dedicated") {
      let r: SiteDeployOutcome | DbScan;
      try {
        r = await pooledScan(tenant_id, site, sandbox, sha, kernelSite, graduatedSql);
      } catch (e) {
        if (e instanceof SiteCredentialsMissing) return { kind: "failed", reason: "Site hosting is not configured." };
        throw e;
      }
      if ("kind" in r) return r;
      if (r.db === "dedicated") {
        mode = "dedicated";
        deployNotes = r.notes;
        movedToDedicated = true;
        databaseUnchanged = false;
      } else if (r.db === "pooled") {
        pooledActive = true;
        manifestRaw = r.manifestRaw;
        if (!r.unchanged) databaseUnchanged = false;
      }
    }
    const testSiteGate = pooledActive && !kernelSite;
    if (testSiteGate && !deps.testSites) {
      console.error(`[site-deploy] publish gate unavailable for site ${site_id}: no test-site backend`);
      throw new SiteGateUnavailable("no test-site backend is wired");
    }

    const stage_started = now();
    let staged: StagedDeploy;
    try {
      staged = await deps.publisher.stage({ tenant_id, site_id, sha, sandbox });
    } catch (e) {
      if (e instanceof SiteCredentialsMissing) return { kind: "failed", reason: "Site hosting is not configured." };
      if (e instanceof SitePublishTransientError) throw e;
      if (e instanceof SitePublishPlatformError) {
        const reason = `Publishing hit a problem on our side: ${clip(errText(e), 300)}`;
        console.error(`[site-deploy] platform publish failure for site ${site_id}: ${clip(errText(e), 300)}`);
        await recordError(tenant_id, site_id, reason);
        return { kind: "failed", reason };
      }
      if (!(e instanceof SiteBuildFailed)) {
        console.warn(
          `[site-deploy] event=platform_publish_retry tenant=${tenant_id} site=${site_id} transient=${isTransientPlatformError(e)} reason=${JSON.stringify(clip(errText(e), 200))}`,
        );
        throw e;
      }
      const reason = `The site did not build: ${clip(errText(e))}`;
      await recordError(tenant_id, site_id, reason);
      return { kind: "repair", signal: reason };
    }

    const stage_ms = now() - stage_started;
    let gate_started = now();
    const firstBuild = !site.live_sha;
    const [seedMetaOn, signedImages] = await Promise.all([
      flag(deps.seedMetaCheckEnabled, tenant_id),
      flag(deps.signedImageCheckEnabled, tenant_id),
    ]);
    const seedMeta = seedMetaOn && firstBuild;
    if (seedMeta || signedImages) {
      let content: SiteContentCheckResult;
      try {
        content = await checkContent({ sandbox, sha, seedMeta, signedImages, since: firstBuild ? null : site.live_sha });
      } catch (e) {
        console.warn(`[site-deploy] content check could not run for site ${site_id}: ${clip(errText(e), 200)}`);
        throw e;
      }
      if (!content.ok) {
        await recordError(tenant_id, site_id, `check: ${content.reason}`);
        return { kind: "repair", signal: clip(content.signal) };
      }
    }

    let migrations_ms: number | null = null;
    const migrations_started = now();
    if (mode === "dedicated" && !(kernelSite && !graduatedSql)) {
      const skipMigrations = skipOn && !movedToDedicated && change !== null && !change.migrations_touched;
      try {
        const names = skipMigrations ? [] : await listMigrations(sandbox, sha);
        if (names.length) {
          console.warn(JSON.stringify({ event: "site_deploy.dedicated_migrations_on_live", tenant_id, site_id, sha: sha.slice(0, 12), count: names.length }));
        }
        for (const name of names) {
          const sql = await readMigration(sandbox, sha, name);
          try {
            await deps.supabase.applySql({
              tenant_id,
              site_id,
              migration_id: name.replace(/\.sql$/, ""),
              sql,
              guard: (text) => {
                const verdict = checkSiteMigrationSql(text);
                if (!verdict.ok) throw new SiteMigrationRefused(verdict.reason);
              },
              preserveExistingRows: true,
            });
          } catch (e) {
            if (e instanceof SiteCredentialsMissing) throw e;
            if (e instanceof SiteMigrationRefused) {
              const reason = `Database migration ${name} was refused: ${clip(e.message, 600)}`;
              await recordError(tenant_id, site_id, reason);
              return {
                kind: "repair",
                signal:
                  `${reason}\nSite migrations may only ADD to the public schema: create tables, indexes, views, ` +
                  `types, policies, triggers and functions; alter table add column / add constraint / enable row level ` +
                  `security (every new table, in the same file); grants to anon or authenticated; and insert (new ` +
                  `rows only: never UPDATE, DELETE or ON CONFLICT DO UPDATE existing rows). Never touch the starter's profiles, ` +
                  `is_admin() or handle_new_user(). No DROP ` +
                  `(except DROP POLICY / DROP TRIGGER IF EXISTS), no DO blocks, no BEGIN / COMMIT, no SECURITY ` +
                  `DEFINER, views only WITH (security_invoker = true), and nothing that reads or writes auth or ` +
                  `storage (auth.uid() and a foreign key to auth.users are fine). Rewrite ${name} (it did not run).`,
              };
            }
            const ownFailure =
              e instanceof SiteMigrationChecksumMismatch || (e instanceof SiteSqlError && !isDatabaseConnectionFailure(e.sqlMessage));
            if (!ownFailure) throw e;
            const rowsChanged = new RegExp(`${ROWS_CHANGED_MARKER}: (.*)`, "s").exec(errText(e));
            if (rowsChanged) {
              const reason = `Database migration ${name} would change rows that already exist: ${clip(rowsChanged[1], 600)}`;
              await recordError(tenant_id, site_id, reason);
              return {
                kind: "repair",
                signal:
                  `${reason}\nThe whole migration was rolled back (nothing in it was applied). A site migration runs on the ` +
                  `live database before the publish check, so it may add tables, columns and new rows, but never update, ` +
                  `delete, truncate or rewrite rows that are already there (no UPDATE, DELETE, MERGE, ON CONFLICT DO UPDATE, ` +
                  `or a trigger or function that does). Rewrite ${name}; change existing data from the site's admin instead.`,
              };
            }
            const applied = /already applied with different contents/.test(errText(e));
            const catalog = /zavi catalog check failed: (.*)/s.exec(errText(e));
            const reason = catalog
              ? `Database migration ${name} broke a database safety rule: ${clip(catalog[1], 800)}`
              : `Database migration ${name} failed: ${clip(errText(e), 800)}`;
            await recordError(tenant_id, site_id, reason);
            return {
              kind: "repair",
              signal: catalog
                ? `${reason}\nThe whole migration was rolled back (nothing in it was applied). Rewrite ${name} so every ` +
                  `new table enables row level security, views use security_invoker, and nothing touches the ` +
                  `starter's profiles, is_admin() or handle_new_user().`
                : applied
                  ? `${reason}\n${name} already ran on the live database: restore its original contents and put the change in a NEW migration file.`
                  : `${reason}\nFix ${name} itself: it failed, so nothing in it was applied. Never edit a migration that already ran; add a new one instead.`,
            };
          }
        }
      } catch (e) {
        if (e instanceof SiteCredentialsMissing) return { kind: "failed", reason: "Site hosting is not configured." };
        if (!(e instanceof SiteMigrationCandidateInvalid)) throw e;
        const reason = `Reading the database migrations failed: ${clip(errText(e), 800)}`;
        await recordError(tenant_id, site_id, reason);
        return { kind: "repair", signal: reason };
      }
      migrations_ms = skipMigrations ? null : now() - migrations_started;

      let problems: string[];
      try {
        problems = await deps.supabase.verifyCatalog({ tenant_id, site_id });
      } catch (e) {
        if (e instanceof SiteCredentialsMissing) return { kind: "failed", reason: "Site hosting is not configured." };
        throw e;
      }
      if (problems.length > 0) {
        const reason = `The site's database failed its security check, so it was not published: ${clip(problems.join("; "), 600)}`;
        await recordError(tenant_id, site_id, reason);
        return { kind: "failed", reason };
      }
    }

    gate_started = now();

    const begun = cp;
    let testSiteLeft: string | null = null;
    const commit: DeployCheckpoint["commit"] = pooledActive ? "pooled" : "none";
    const recordGated = async (gate: "light" | "full"): Promise<DeployCheckpoint> => {
      const gated: DeployCheckpoint = {
        ...begun,
        deploy_id: staged.deploy_id,
        phase: "gated",
        commit,
        notes: deployNotes,
        ...(testSiteLeft ? { test_site_id: testSiteLeft } : {}),
        gate_timing: { started_at, migrations_ms, stage_ms, gate, gate_ms: now() - gate_started },
      };
      await checkpoints.set(key, gated);
      return gated;
    };
    const passed = async (gate: "light" | "full"): Promise<SiteDeployOutcome> =>
      commitAndActivate(tenant_id, site_id, conductor_run_id, key, await recordGated(gate), manifestRaw);

    const keptToRerun = (input.kept_journeys?.must_pass.length ?? 0) > 0;
    let light = lightOn && databaseUnchanged && change?.light.ok === true && !keptToRerun ? change.light : null;
    if (light?.styles && !(light.colors_only === true && (await flag(deps.lightGateColorEdits, tenant_id)))) {
      console.warn(`[site-deploy] ${STYLE_EDIT_NOT_LIGHT} for site ${site_id}; running the full check`);
      light = null;
    }
    if (light) {
      const lightGate = await runLightGate({ preview_url: staged.preview_url, tokens: light.tokens });
      if (lightGate.ok) return passed("light");
      if (!lightGate.missing_text && !lightGate.infra) {
        await recordError(tenant_id, site_id, `gate: ${lightGate.reason}`);
        return {
          kind: "repair",
          signal: clip(`The site's check failed: ${lightGate.reason}${lightGate.evidence ? `\nEvidence: ${lightGate.evidence}` : ""}`),
        };
      }
      console.warn(
        lightGate.infra
          ? `[site-deploy] light check could not reach the preview for site ${site_id}; running the full check`
          : `[site-deploy] light check did not find the new text for site ${site_id}; running the full check`,
      );
    }

    let ownerRequired = false;
    if (site.owner_email && testSiteGate) {
      try {
        ownerRequired = deps.ownerAdminEnabled ? (await deps.ownerAdminEnabled(tenant_id)) === true : true;
      } catch {
        ownerRequired = true;
      }
    }

    const [booking_required, brand_checks] = firstBuild
      ? await Promise.all([flag(deps.bookingJourneyRequired, tenant_id), flag(deps.brandCheckEnabled, tenant_id).then((on) => on && seedMetaOn)])
      : [false, false];
    const images_check = await flag(deps.imagesCheckEnabled, tenant_id);
    const design = firstBuild ? await loadDesign(tenant_id, site_id) : null;
    const visionMode: SiteVisionMode = visionReviewEnabled(deps.env ?? process.env) ? await readVisionMode(tenant_id) : "off";
    const visionDesign = visionMode !== "off" ? (design ?? (await loadDesign(tenant_id, site_id))) : null;
    const vision: SiteGateInput["vision"] | undefined = visionReviewEnabled(deps.env ?? process.env)
      ? { mode: visionMode, brief: visionMode !== "off" ? compactVisionBrief(visionDesign, site.name ?? null) : null }
      : undefined;
    const wantsPageText = design !== null || visionMode !== "off";
    const thumbnail = !!deps.thumbnails;
    const shotAt = new Date(now());
    let gate: SiteGateResult;
    let suppliedLink: boolean;
    if (testSiteGate) {
      const r = await gateOnTestSite({ tenant_id, site, sandbox, sha, key, cp: begun, deploy_id: staged.deploy_id, manifestRaw, ownerRequired, brief: input.brief, booking_required, brand_checks, images_check, first_build: firstBuild, kept_journeys: input.kept_journeys, page_text: wantsPageText, ...(vision ? { vision } : {}), ...(thumbnail ? { thumbnail } : {}) });
      gate = r.gate;
      suppliedLink = r.owner_supplied;
      testSiteLeft = r.left();
    } else {
      const owner_link: string | null = null;
      suppliedLink = owner_link !== null;
      gate = await runGate({
        sandbox,
        preview_url: staged.preview_url,
        owner_link,
        allow_writes: false,
        sha,
        tenant_id,
        site_id,
        backend_mode: site.backend_mode ?? null,
        brief: input.brief, booking_required, brand_checks,
        images_check, first_build: firstBuild,
        kept_journeys: input.kept_journeys,
        site_name: site.name ?? null,
        page_text: wantsPageText,
        ...(vision ? { vision } : {}),
        ...(thumbnail ? { thumbnail } : {}),
      });
    }
    const fidelity = design ? await recordDesignCheck({ tenant_id, site, sandbox, sha, design, gate }) : null;
    const plan = fidelityAddendum(fidelity);
    const visionFixUsed = input.kept_journeys?.must_pass.includes(VISION_FIX_MARK) === true;
    const copy = visionMode !== "off" && gate.page_text?.length ? checkSiteCopy(gate.page_text) : null;
    const reviewFindings = mergeReviewFindings(copy?.findings ?? [], gate.vision?.status === "reviewed" ? gate.vision.findings : []);
    const visualFindings = visionMode === "correct" ? qualifyingFindings(reviewFindings) : [];
    const repairMax = visualFindings.length > 0 && !visionFixUsed ? await readRepairMax(tenant_id) : null;
    const rideAlong = repairMax !== null && input.attempt - 1 < repairMax;
    const held = (reason: SiteVisionAction): SiteVisionAction => (visualFindings.length === 0 ? "none" : visionFixUsed ? "skipped_used" : reason);
    const repairSignal = (base: string): { signal: string; rode: boolean } => {
      const body = plan ? `${clip(base, SIGNAL_MAX - plan.length)}${plan}` : clip(base);
      const ride = rideAlong ? visionAddendum(visualFindings, SIGNAL_MAX - body.length) : "";
      return { signal: `${body}${ride}`, rode: ride !== "" };
    };
    const vNote = (action: SiteVisionAction) =>
      noteVision({ tenant_id, site_id, sha, attempt: input.attempt, mode: visionMode, gate, copy, action });
    const mustPass = [...(gate.failed_journeys ?? []), ...(gate.error_text ? [ERROR_TEXT_JOURNEY] : [])];
    const journeys = gate.journeys
      ? { names: gate.journeys, must_pass: mustPass, fingerprints: gate.fingerprints ?? {} }
      : undefined;
    if (gate.ok && suppliedLink && gate.owner_journey !== "passed") {
      const reason = "the owner sign-in journey did not pass";
      await recordError(tenant_id, site_id, `gate: ${reason}`);
      const r = repairSignal(`The site's smoke check failed: ${reason}${gate.evidence ? `\nEvidence: ${gate.evidence}` : ""}`);
      await vNote(r.rode ? "rode_along" : held(rideAlong ? "skipped_no_room" : "skipped_no_attempts"));
      return { kind: "repair", signal: r.signal, journeys };
    }
    const errorTextFixedOnce = input.kept_journeys?.must_pass.includes(ERROR_TEXT_JOURNEY) === true;
    if (!gate.ok && gate.error_text === "only" && errorTextFixedOnce && !(suppliedLink && gate.owner_journey !== "passed")) {
      console.warn(`[site-gate] error-text still present after one fix pass site=${site_id}: ${clip(gate.reason, 300)}`);
      await vNote(held("skipped_error_text"));
      return passed("full");
    }
    if (!gate.ok) {
      await recordError(tenant_id, site_id, `gate: ${gate.reason}`);
      const r = repairSignal(`The site's smoke check failed: ${gate.reason}${gate.evidence ? `\nEvidence: ${gate.evidence}` : ""}`);
      await vNote(r.rode ? "rode_along" : held(rideAlong ? "skipped_no_room" : "skipped_no_attempts"));
      return { kind: "repair", signal: r.signal, journeys };
    }

    const deadEnd = journeyDeadEnd(fidelity);
    if (deadEnd) {
      const usedElsewhere =
        !!design?.journey_fix_claimed_at && design.journey_fix_conductor_run_id !== input.conductor_run_id;
      if (input.kept_journeys?.must_pass.includes(JOURNEY_FIX_MARK) !== true && !usedElsewhere) {
        await recordError(tenant_id, site_id, `check: the main action dead-ends on an empty site (${clip(deadEnd.evidence ?? "", 200)})`);
        await vNote(held("deferred_free_fix"));
        return {
          kind: "repair",
          signal: clip(journeyRepairSignal(deadEnd)),
          journeys: { names: gate.journeys ?? [], must_pass: [JOURNEY_FIX_MARK], fingerprints: gate.all_fingerprints ?? {} },
          free_fix: "brief_journey",
        };
      }
      console.warn(`[site-deploy] main action still dead-ends after one fix pass site=${site_id}: ${clip(deadEnd.evidence ?? "", 200)}`);
    }

    if (visualFindings.length > 0) {
      if (visionFixUsed) {
        await vNote("skipped_used");
      } else if (repairMax === null || repairMax === 0) {
        await vNote("skipped_no_attempts");
      } else {
        await vNote("repair");
        await recordGated("full");
        const preferences = reviewFindings.filter((f) => f.class === "preference" && f.confidence >= 0.5);
        return {
          kind: "repair",
          signal: visionRepairSignal(visualFindings, preferences, SIGNAL_MAX),
          journeys: { names: gate.journeys ?? [], must_pass: [VISION_FIX_MARK], fingerprints: gate.all_fingerprints ?? {} },
        };
      }
    } else {
      await vNote("none");
    }

    if (gate.ok && gate.thumbnail && deps.thumbnails) {
      void deps.thumbnails.save({ tenant_id, site_id, jpeg_b64: gate.thumbnail, taken_at: shotAt }).catch(() => false);
    }

    return passed("full");
  }

  return {
    async step(input) {
      const { tenant_id, conductor_run_id, site_id, sha } = input;
      if (!tenant_id || !conductor_run_id || !site_id) {
        return { kind: "failed", reason: "The deploy step is missing its site." };
      }
      if (!SHA_RE.test(sha ?? "")) return { kind: "failed", reason: "The deploy step has no valid commit to publish." };
      const key = checkpointKey(input);
      const out = await run(input, key);
      if (out.kind === "repair" || out.kind === "failed") {
        const left = await checkpoints.get(key);
        const hadTestSite = !!left?.test_site_id;
        if (left?.test_site_id && (await destroyTestSite(tenant_id, site_id, left.test_site_id))) left.test_site_id = undefined;
        const keepGated = out.kind === "repair" && left?.phase === "gated" && out.journeys?.must_pass.includes(VISION_FIX_MARK) === true;
        if (left && keepGated) {
          if (hadTestSite && !left.test_site_id) await checkpoints.set(key, left);
        } else if (left && !left.test_site_id) await checkpoints.set(key, null);
      }
      return out;
    },
  };
}
