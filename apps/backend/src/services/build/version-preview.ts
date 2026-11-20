import {
  NoUndoableRefine,
  NotProvisioned,
  NothingToRestore,
  resolveVersionCommit,
  type VersionCommit,
} from "@/services/agents/refine-undo";
import { bootstrapRepoIfNeeded, injectSandboxSecrets, pauseAndMarkPaused, resolveSandboxForRun } from "@/services/sandbox/lifecycle";
import { revokeSandboxGithubToken } from "@/services/sandbox/e2b-client";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { redactGitCreds } from "@/services/sandbox/run-worktree";
import { execCommand } from "@/services/sandbox/e2b-client";
import { startEngineerPreview } from "@/services/sandbox/engineer-preview";
import { PreviewBootError } from "@/services/sandbox/preview";
import { resolveRepoCredsForRun } from "@/services/sandbox/repo-creds";
import { restoreDraftAfterReset } from "@/services/build/live-edit";

export type VersionPreviewStatus = "starting" | "live" | "dead";

export type VersionPreviewJob = {
  status: VersionPreviewStatus;
  url: string | null;
  port: number | null;
  commit_sha: string | null;
  error: string | null;
  started_at: number;
  updated_at: number;
};

export type VersionPreviewInput = {
  tenant_id: string;
  conductor_run_id: string;
};

export type VersionPreviewDeps = {
  resolveVersionCommit: (input: VersionPreviewInput) => Promise<VersionCommit>;
  mintInstallationToken: (tenant_id: string, github_full_name: string) => Promise<string | null>;
  injectSecrets?: (e2b_sandbox_id: string, secrets: Record<string, string>) => Promise<void>;
  hasActiveBuild?: (tenant_id: string) => Promise<boolean>;
  wipeSecrets?: (e2b_sandbox_id: string) => Promise<void>;
  pauseSandbox?: (handle: { row_id: string; e2b_sandbox_id: string }, opts: { force: true }) => Promise<void>;
  resolveSandbox: (args: {
    tenant_id: string;
    repo_full_name: string;
    provisioned: true;
    run_id: string;
    installation_token?: string;
  }) => Promise<{ row_id: string; e2b_sandbox_id: string }>;
  bootstrapRepo: (e2b_sandbox_id: string, repo_full_name: string, tenant_id: string) => Promise<void>;
  exec: (
    sandbox_id: string,
    script: string,
    timeoutMs: number,
  ) => Promise<{ stdout: string; stderr: string; exit_code: number }>;
  startPreview: (opts: {
    sandbox_id: string;
    worktree_dir: string;
    run_id: string;
    port: number;
    boot_timeout_seconds: number;
    start_cmd?: string;
  }) => Promise<{ url: string; port: number }>;
  probe: (url: string) => Promise<boolean>;
  restoreLiveDraft?: (sandbox_id: string, tenant_id: string, repo_full_name: string, default_branch: string) => Promise<void>;
  now: () => number;
};

export const VERSION_PREVIEW_TTL_MS = 45 * 60 * 1000;
export const VERSION_PREVIEW_PROBE_INTERVAL_MS = 2 * 60 * 1000;
export const VERSION_PREVIEW_PROBE_TIMEOUT_MS = 4_000;
export const VERSION_PREVIEW_BOOT_TIMEOUT_S = 90;
export const VERSION_PREVIEW_PORT = 3400;
export const VERSION_PREVIEW_MARKER = "ZAVI_VERSION_PREVIEW=1";
export const VERSION_PREVIEW_STOP_SCRIPT =
  "mypg=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' '); " +
  "victims=\"$(pgrep -f 'ZAVI_VERSION_PREVIE[W]=1' 2>/dev/null; pgrep -f '/home/user/preview-v[p]-' 2>/dev/null; pgrep -f -- 'dev -p 340[0]' 2>/dev/null)\"; " +
  "for p in $victims; do pg=$(ps -o pgid= -p \"$p\" 2>/dev/null | tr -d ' '); " +
  "if [ -n \"$pg\" ] && [ \"$pg\" != \"$mypg\" ] && [ \"$pg\" != \"1\" ]; then kill -TERM -- \"-$pg\" >/dev/null 2>&1 || kill -TERM \"$p\" >/dev/null 2>&1 || true; fi; done; " +
  "sleep 1; " +
  "for p in $(pgrep -f -- 'dev -p 340[0]' 2>/dev/null); do kill -KILL \"$p\" >/dev/null 2>&1 || true; done; " +
  "sleep 1";
const FETCH_EXEC_TIMEOUT_MS = 180_000;
const BOOT_DEADLINE_MS = 15 * 60 * 1000;

export const ERR_COMMIT_NOT_FOUND = "That version's commit could not be found";
export const ERR_BOOT_TIMEOUT = "The preview didn't start in time";
export const ERR_BOOT_FAILED = "The preview couldn't start";
export const ERR_STOPPED = "The preview stopped; open it again";
export const ERR_BUILD_IN_PROGRESS = "Zavi is making a change to your app right now. Open this version once it finishes.";
export const ERR_REPLACED = "Another version was opened; open this one again to see it.";

const SHA_RE = /^[0-9a-f]{7,40}$/;

class VersionPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionPreviewError";
  }
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function versionWorktreeDir(sha: string): string {
  return `/home/user/version-${sha.slice(0, 12)}`;
}

export function versionPreviewPort(_sha: string): number {
  return VERSION_PREVIEW_PORT;
}

export function versionPreviewStartCmd(port: number): string {
  return `${VERSION_PREVIEW_MARKER} npm run dev -- -p ${port}`;
}

export function buildVersionWorktreeScript(sha: string, dir: string): string {
  return `cd /home/user/repo && git fetch origin ${sha} && ([ -d ${shq(dir)} ] || git worktree add --detach ${shq(dir)} ${sha})`;
}

async function realProbe(url: string): Promise<boolean> {
  const attempt = async (method: "HEAD" | "GET"): Promise<Response> =>
    fetch(url, { method, redirect: "manual", signal: AbortSignal.timeout(VERSION_PREVIEW_PROBE_TIMEOUT_MS) });
  try {
    let res = await attempt("HEAD");
    if (res.status === 405 || res.status === 501) res = await attempt("GET");
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

async function realMintInstallationToken(tenant_id: string, github_full_name: string): Promise<string | null> {
  const creds = await resolveRepoCredsForRun(tenant_id, {
    stage: "build",
    target: { github_full_name, github_target_mode: "umbrella" },
  });
  return creds.kind === "resolved" ? creds.installation_token : null;
}

export const realVersionPreviewDeps: VersionPreviewDeps = {
  resolveVersionCommit: (input) => resolveVersionCommit({ ...input, purpose: "preview" }),
  mintInstallationToken: realMintInstallationToken,
  injectSecrets: (id, secrets) => injectSandboxSecrets(id, secrets),
  hasActiveBuild: realHasActiveBuild,
  wipeSecrets: (id) => revokeSandboxGithubToken(id),
  pauseSandbox: (handle, opts) => pauseAndMarkPaused(handle, opts),
  resolveSandbox: (args) => resolveSandboxForRun(args),
  bootstrapRepo: (sandbox_id, repo, tenant_id) => bootstrapRepoIfNeeded(sandbox_id, repo, tenant_id),
  exec: (sandbox_id, script, timeoutMs) => execCommand(sandbox_id, script, timeoutMs),
  startPreview: (opts) => startEngineerPreview(opts),
  probe: realProbe,
  now: () => Date.now(),
  restoreLiveDraft: (sandbox_id, tenant_id, repo_full_name, default_branch) =>
    restoreDraftAfterReset({ sandbox_id, tenant_id, repo_full_name, default_branch }),
};

type JobRecord = VersionPreviewJob & { checked_at: number };

const jobs = new Map<string, JobRecord>();
const latestByTenant = new Map<string, JobRecord>();

async function realHasActiveBuild(tenant_id: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("conductor_runs")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .in("status", ["active", "provisioning"])
    .limit(1);
  if (error) return true;
  return ((data as unknown[] | null)?.length ?? 0) > 0;
}

function keyFor(input: VersionPreviewInput): string {
  return `${input.tenant_id}:${input.conductor_run_id}`;
}

function snapshot(job: JobRecord): VersionPreviewJob {
  return {
    status: job.status,
    url: job.url,
    port: job.port,
    commit_sha: job.commit_sha,
    error: job.error,
    started_at: job.started_at,
    updated_at: job.updated_at,
  };
}

function humanError(e: unknown): string {
  if (e instanceof VersionPreviewError) return e.message;
  if (e instanceof NotProvisioned || e instanceof NothingToRestore || e instanceof NoUndoableRefine) {
    return e.message;
  }
  if (e instanceof PreviewBootError) {
    return /did not serve|timeout|timed out/i.test(`${e.deadReason} ${e.message}`) ? ERR_BOOT_TIMEOUT : ERR_BOOT_FAILED;
  }
  const msg = String((e as Error)?.message ?? "");
  if (/timeout|timed out/i.test(msg)) return ERR_BOOT_TIMEOUT;
  return ERR_BOOT_FAILED;
}

async function bootVersionPreview(
  key: string,
  input: VersionPreviewInput,
  job: JobRecord,
  deps: VersionPreviewDeps,
): Promise<void> {
  const touch = () => {
    job.updated_at = deps.now();
  };
  const owned = () => jobs.get(key) === job;
  const newest = () => latestByTenant.get(input.tenant_id) === job;
  try {
    if (deps.hasActiveBuild && (await deps.hasActiveBuild(input.tenant_id))) {
      throw new VersionPreviewError(ERR_BUILD_IN_PROGRESS);
    }
    const version = await deps.resolveVersionCommit(input);
    const sha = (version.commit_sha ?? "").trim().toLowerCase();
    if (!SHA_RE.test(sha)) throw new VersionPreviewError(ERR_COMMIT_NOT_FOUND);
    job.commit_sha = sha;
    touch();

    const repo_full_name = version.target.github_full_name;
    let installation_token: string | null = null;
    try {
      installation_token = await deps.mintInstallationToken(input.tenant_id, repo_full_name);
    } catch (e) {
      console.warn(`[version-preview] token mint failed for ${repo_full_name}: ${(e as Error).message ?? e}`);
    }
    if (deps.hasActiveBuild && (await deps.hasActiveBuild(input.tenant_id))) {
      throw new VersionPreviewError(ERR_BUILD_IN_PROGRESS);
    }
    const sandbox = await deps.resolveSandbox({
      tenant_id: input.tenant_id,
      repo_full_name,
      provisioned: true,
      run_id: `vp-${input.conductor_run_id.slice(0, 8)}`,
      ...(installation_token ? { installation_token } : {}),
    });
    if (installation_token && deps.injectSecrets) {
      await deps.injectSecrets(sandbox.e2b_sandbox_id, { GITHUB_TOKEN: installation_token });
    }
    let tokenLeft = false;
    let wiped = false;
    try {
      await deps.bootstrapRepo(sandbox.e2b_sandbox_id, repo_full_name, input.tenant_id);
      if (deps.restoreLiveDraft) {
        if (deps.hasActiveBuild && (await deps.hasActiveBuild(input.tenant_id))) {
          throw new VersionPreviewError(ERR_BUILD_IN_PROGRESS);
        }
        await deps
          .restoreLiveDraft(sandbox.e2b_sandbox_id, input.tenant_id, repo_full_name, version.target.default_branch)
          .catch(() => undefined);
      }

      const dir = versionWorktreeDir(sha);
      const fetched = await deps.exec(sandbox.e2b_sandbox_id, buildVersionWorktreeScript(sha, dir), FETCH_EXEC_TIMEOUT_MS);
      if (fetched.exit_code !== 0) {
        console.warn(`[version-preview] fetch/worktree failed for ${key} (${sha.slice(0, 7)}): exit=${fetched.exit_code} ${redactGitCreds(String(fetched.stderr ?? "")).slice(0, 300)}`);
        throw new VersionPreviewError(ERR_COMMIT_NOT_FOUND);
      }
      touch();

      if (installation_token && deps.wipeSecrets) {
        wiped = await deps.wipeSecrets(sandbox.e2b_sandbox_id).then(
          () => true,
          () => false,
        );
        if (!wiped) {
          tokenLeft = true;
          throw new VersionPreviewError(ERR_BOOT_FAILED);
        }
      }

      if (!newest()) throw new VersionPreviewError(ERR_REPLACED);
      await deps.exec(sandbox.e2b_sandbox_id, VERSION_PREVIEW_STOP_SCRIPT, 15_000).catch(() => undefined);
      if (!newest()) throw new VersionPreviewError(ERR_REPLACED);
      const wantPort = versionPreviewPort(sha);
      const { url, port } = await deps.startPreview({
        sandbox_id: sandbox.e2b_sandbox_id,
        worktree_dir: dir,
        run_id: `vp-${sha.slice(0, 12)}`,
        port: wantPort,
        boot_timeout_seconds: VERSION_PREVIEW_BOOT_TIMEOUT_S,
        start_cmd: versionPreviewStartCmd(wantPort),
      });
      for (const other of jobs.values()) {
        if (other !== job && other.status === "live" && other.url && other.url.startsWith(url.split("/")[0] + "//" + new URL(url).host)) {
          other.status = "dead";
          other.error = ERR_STOPPED;
          other.url = null;
          other.port = null;
          other.updated_at = deps.now();
        }
      }
      if (!owned()) return;
      if (!newest()) throw new VersionPreviewError(ERR_REPLACED);
      job.status = "live";
      job.url = url;
      job.port = port;
      job.error = null;
      job.checked_at = deps.now();
      touch();
    } finally {
      if (tokenLeft) {
        if (deps.pauseSandbox) await deps.pauseSandbox(sandbox, { force: true }).catch(() => undefined);
      } else if (!wiped && installation_token && deps.wipeSecrets) {
        const cleaned = await deps.wipeSecrets(sandbox.e2b_sandbox_id).then(
          () => true,
          () => false,
        );
        if (!cleaned && deps.pauseSandbox) await deps.pauseSandbox(sandbox, { force: true }).catch(() => undefined);
      }
    }
  } catch (e) {
    if (!owned()) return;
    console.warn(`[version-preview] boot failed for ${key}: ${redactGitCreds(String((e as Error)?.message ?? e)).slice(0, 400)}`);
    job.status = "dead";
    job.url = null;
    job.port = null;
    job.error = humanError(e);
    touch();
  }
}

export function evictStaleVersionPreviews(now: number): number {
  let evicted = 0;
  for (const [k, j] of jobs) {
    const stale = now - j.started_at > VERSION_PREVIEW_TTL_MS;
    if ((j.status === "dead" && now - j.updated_at > VERSION_PREVIEW_TTL_MS) || (j.status !== "starting" && stale)) {
      jobs.delete(k);
      evicted += 1;
    }
  }
  return evicted;
}

export function startVersionPreview(
  input: VersionPreviewInput,
  deps: VersionPreviewDeps = realVersionPreviewDeps,
): VersionPreviewJob {
  const key = keyFor(input);
  const now = deps.now();
  evictStaleVersionPreviews(now);
  const existing = jobs.get(key);
  if (
    existing &&
    (existing.status === "starting" || existing.status === "live") &&
    now - existing.started_at < VERSION_PREVIEW_TTL_MS
  ) {
    return snapshot(existing);
  }
  const job: JobRecord = {
    status: "starting",
    url: null,
    port: null,
    commit_sha: null,
    error: null,
    started_at: now,
    updated_at: now,
    checked_at: now,
  };
  jobs.set(key, job);
  latestByTenant.set(input.tenant_id, job);
  const deadline = setTimeout(() => {
    if (jobs.get(key) === job && job.status === "starting") {
      job.status = "dead";
      job.error = ERR_BOOT_TIMEOUT;
      job.updated_at = deps.now();
    }
  }, BOOT_DEADLINE_MS);
  deadline.unref?.();
  void bootVersionPreview(key, input, job, deps)
    .catch((e) => {
      console.warn(`[version-preview] boot crashed for ${key}: ${(e as Error).message ?? e}`);
    })
    .finally(() => clearTimeout(deadline));
  return snapshot(job);
}

export async function getVersionPreview(
  input: VersionPreviewInput,
  deps: VersionPreviewDeps = realVersionPreviewDeps,
): Promise<VersionPreviewJob | null> {
  const key = keyFor(input);
  const job = jobs.get(key);
  if (!job) return null;
  const now = deps.now();
  if (job.status === "live" && job.url && now - job.checked_at >= VERSION_PREVIEW_PROBE_INTERVAL_MS) {
    job.checked_at = now;
    const alive = await deps.probe(job.url).catch(() => false);
    if (!alive && jobs.get(key) === job && job.status === "live") {
      job.status = "dead";
      job.error = ERR_STOPPED;
      job.updated_at = deps.now();
    }
  }
  return snapshot(job);
}

export function __resetVersionPreviewJobs(): void {
  jobs.clear();
  latestByTenant.clear();
}
