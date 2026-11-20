import { getBoolSetting } from "@/services/settings";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import {
  commitFilesToBranch,
  compareBranches,
  deleteBranch,
  fastForwardBranch,
  fetchWithTransientRetry,
  readBranchSha,
  AUTOPILOT_PAT_SENTINEL,
} from "@/services/mcp/internal/github";
import { ghInstallationHeaders, mintInstallationToken } from "@/services/connectors/github/oauth";
import { findProtectedPathHits } from "@/services/agents/pipeline-policy";
import { loadTenantProtectedGlobs } from "@/services/agents/pipeline-policy-store";
import { realLoadProvisionedTarget, resolveInstallationForRepo } from "@/services/agents/refine-undo";
import { assertProvisionedRepoTarget } from "@/services/provisioning/provisioned-repo-gate";
import { execCommand, getSandboxHost, refreshOriginUrlStep, revokeSandboxGithubToken } from "@/services/sandbox/e2b-client";
import { PREVIEW_DEFAULT_PORT, previewEnabled, startPreviewServer } from "@/services/sandbox/preview";
import {
  bootstrapRepoIfNeeded,
  injectSandboxSecrets,
  pauseAndMarkPaused,
  resolveSandboxForRun,
  type SandboxHandle,
} from "@/services/sandbox/lifecycle";
import { resolveRepoCredsForRun } from "@/services/sandbox/repo-creds";
import {
  clearLiveEditPreview,
  countOtherLiveEditPreviews,
  loadLiveEditPreviewRow,
  setLiveEditPreview,
  touchLiveEditPreview,
} from "@/services/sandbox/engineer-preview";

export const LIVE_EDIT_BRANCH = "zavi/draft";
export const LIVE_EDIT_REPO_DIR = "/home/user/repo";
const STATE_CACHE_MS = 8_000;

export class LiveEditError extends Error {
  constructor(
    public readonly code:
      | "not_enabled"
      | "not_provisioned"
      | "build_in_progress"
      | "nothing_to_publish"
      | "draft_behind"
      | "no_sandbox"
      | "capacity"
      | "protected_paths"
      | "draft_has_new_edits",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "LiveEditError";
  }
}

export type LiveEditTarget = { github_full_name: string; default_branch: string };

export type LiveEditPreview = { status: "live" | "starting" | "none"; url: string | null };

export type LiveEditState = {
  enabled: boolean;
  draft: {
    exists: boolean;
    ahead_by: number;
    behind_by: number;
    head_sha: string | null;
    changes: Array<{ sha: string; message: string }>;
  };
  preview: LiveEditPreview;
  refine_active: boolean;
};

type Compare = { ahead_by: number; behind_by: number; commits: Array<{ sha: string; message: string }> } | null;

type RepoAuth = { tenant_id: string; installation_id: number; owner: string; repo: string };

type PreviewRow = {
  id: string;
  e2b_sandbox_id: string | null;
  preview_status: string | null;
  preview_url: string | null;
  preview_port: number | null;
  preview_run_id?: string | null;
};

const COMPARE_FILES_CAP = 300;

export type LiveEditDeps = {
  enabled: (tenant_id: string) => Promise<boolean>;
  loadTarget: (tenant_id: string) => Promise<LiveEditTarget | null>;
  assertProvisioned: (tenant_id: string, full_name: string) => Promise<boolean>;
  installation: (tenant_id: string, full_name: string) => Promise<number>;
  compare: (a: RepoAuth & { base: string; head: string }) => Promise<Compare>;
  branchSha: (a: RepoAuth & { branch: string }) => Promise<string | null>;
  changedFiles: (a: RepoAuth & { base: string; head: string }) => Promise<string[]>;
  protectedGlobs: (tenant_id: string) => Promise<string[]>;
  fastForward: (a: RepoAuth & { branch: string; to_sha: string }) => Promise<void>;
  deleteBranch: (a: RepoAuth & { branch: string }) => Promise<boolean>;
  hasActiveBuild: (tenant_id: string) => Promise<boolean>;
  loadPreviewRow: (tenant_id: string, full_name: string) => Promise<PreviewRow | null>;
  clearPreview: (row_id: string) => Promise<void>;
  touchPreview: (row_id: string) => Promise<void>;
  requestStaticPublish?: (input: { tenant_id: string; sha: string }) => Promise<unknown>;
  clearInlineEditsOnPublish?: (tenant_id: string) => Promise<void>;
  now: () => number;
};

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

async function realLoadPreviewRow(tenant_id: string, full_name: string): Promise<PreviewRow | null> {
  return loadLiveEditPreviewRow(tenant_id, full_name);
}

async function realChangedFiles(a: RepoAuth & { base: string; head: string }): Promise<string[]> {
  const url = `https://api.github.com/repos/${a.owner}/${a.repo}/compare/${encodeURIComponent(a.base)}...${encodeURIComponent(a.head)}?per_page=1`;
  const pat = a.installation_id === AUTOPILOT_PAT_SENTINEL;
  const tokenFor = async (forceRefresh: boolean) =>
    pat
      ? process.env.GITHUB_PROVISION_TOKEN ?? ""
      : await mintInstallationToken({ tenant_id: a.tenant_id, installation_id: a.installation_id, forceRefresh });
  const get = async (forceRefresh: boolean) => {
    const token = await tokenFor(forceRefresh);
    if (!token) throw new Error("changed files: no GitHub token");
    return fetchWithTransientRetry(() =>
      fetch(url, { method: "GET", headers: ghInstallationHeaders(token), signal: AbortSignal.timeout(30_000) }),
    );
  };
  let res = await get(false);
  if (res.status === 401 && !pat) res = await get(true);
  if (!res.ok) throw new Error(`changed files: compare HTTP ${res.status}`);
  const j = (await res.json()) as { files?: Array<{ filename?: unknown; previous_filename?: unknown }> };
  if (!Array.isArray(j.files)) throw new Error("changed files: compare returned no file list");
  if (j.files.length >= COMPARE_FILES_CAP) throw new Error("changed files: file list truncated");
  const out: string[] = [];
  for (const f of j.files) {
    if (typeof f?.filename === "string") out.push(f.filename);
    if (typeof f?.previous_filename === "string") out.push(f.previous_filename);
  }
  return out;
}

export const realLiveEditDeps: LiveEditDeps = {
  enabled: liveEditEnabled,
  loadTarget: realLoadProvisionedTarget,
  assertProvisioned: async (tenant_id, full_name) => (await assertProvisionedRepoTarget(tenant_id, full_name)).ok,
  installation: resolveInstallationForRepo,
  compare: compareBranches,
  changedFiles: realChangedFiles,
  protectedGlobs: loadTenantProtectedGlobs,
  branchSha: readBranchSha,
  fastForward: fastForwardBranch,
  deleteBranch,
  hasActiveBuild: realHasActiveBuild,
  loadPreviewRow: realLoadPreviewRow,
  clearPreview: async (row_id) => {
    await clearLiveEditPreview(row_id);
  },
  touchPreview: async (row_id) => {
    await touchLiveEditPreview(row_id);
  },
  requestStaticPublish: async ({ tenant_id, sha }) => {
    const { requestTenantStaticPublish } = await import("@/../workers/functions/build-static-publish");
    return requestTenantStaticPublish({ tenant_id, sha, reason: "live_edit_publish" });
  },
  clearInlineEditsOnPublish: async (tenant_id) => {
    const on = await getBoolSetting("live_edit_publish_clears_inline_edits", tenant_id).catch(() => false);
    if (!on) return;
    const { clearWebsiteEditsForTenant } = await import("@/routes/workspace/website-edits");
    const out = await clearWebsiteEditsForTenant(tenant_id);
    if (out.error) throw new Error(out.error);
  },
  now: () => Date.now(),
};

export async function liveEditEnabled(tenant_id: string | null | undefined): Promise<boolean> {
  if (!tenant_id) return false;
  try {
    return await getBoolSetting("build_live_edit_enabled", tenant_id);
  } catch {
    return false;
  }
}

export function isLiveEditPayload(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    (payload as { live_edit_branch?: unknown }).live_edit_branch === LIVE_EDIT_BRANCH
  );
}

const compareCache = new Map<string, { at: number; value: Compare; head_sha: string | null }>();

export function invalidateLiveEditState(tenant_id: string): void {
  compareCache.delete(tenant_id);
}

function repoAuth(tenant_id: string, installation_id: number, full_name: string): RepoAuth {
  const [owner, repo] = full_name.split("/");
  return { tenant_id, installation_id, owner, repo };
}

async function resolveRepo(
  tenant_id: string,
  deps: LiveEditDeps,
): Promise<{ target: LiveEditTarget; auth: RepoAuth }> {
  if (!(await deps.enabled(tenant_id))) {
    throw new LiveEditError("not_enabled", "Live edit is not turned on for this workspace.", 404);
  }
  const target = await deps.loadTarget(tenant_id);
  if (!target || !(await deps.assertProvisioned(tenant_id, target.github_full_name))) {
    throw new LiveEditError("not_provisioned", "This workspace has no built app to publish.", 409);
  }
  const installation_id = await deps.installation(tenant_id, target.github_full_name);
  return { target, auth: repoAuth(tenant_id, installation_id, target.github_full_name) };
}

async function readDraft(
  tenant_id: string,
  target: LiveEditTarget,
  auth: RepoAuth,
  deps: LiveEditDeps,
  fresh: boolean,
): Promise<{ compare: Compare; head_sha: string | null }> {
  const cached = compareCache.get(tenant_id);
  if (!fresh && cached && deps.now() - cached.at < STATE_CACHE_MS) {
    return { compare: cached.value, head_sha: cached.head_sha };
  }
  const head_sha = await deps.branchSha({ ...auth, branch: LIVE_EDIT_BRANCH });
  const compare = head_sha
    ? await deps.compare({ ...auth, base: target.default_branch, head: LIVE_EDIT_BRANCH })
    : null;
  compareCache.set(tenant_id, { at: deps.now(), value: compare, head_sha });
  return { compare, head_sha };
}

export async function readLiveEditState(
  tenant_id: string,
  deps: LiveEditDeps = realLiveEditDeps,
  opts: { framed?: boolean } = {},
): Promise<LiveEditState> {
  const off: LiveEditState = {
    enabled: false,
    draft: { exists: false, ahead_by: 0, behind_by: 0, head_sha: null, changes: [] },
    preview: { status: "none", url: null },
    refine_active: false,
  };
  if (!(await deps.enabled(tenant_id))) return off;
  const target = await deps.loadTarget(tenant_id);
  if (!target) return { ...off, enabled: true };
  const installation_id = await deps.installation(tenant_id, target.github_full_name);
  const auth = repoAuth(tenant_id, installation_id, target.github_full_name);
  const [{ compare, head_sha }, row, refine_active] = await Promise.all([
    readDraft(tenant_id, target, auth, deps, false),
    deps.loadPreviewRow(tenant_id, target.github_full_name).catch(() => null),
    deps.hasActiveBuild(tenant_id),
  ]);
  let preview: LiveEditPreview = { status: "none", url: null };
  if (row?.preview_status === "live" && row.preview_url) {
    preview = { status: "live", url: row.preview_url };
    const ahead = compare?.ahead_by ?? 0;
    const behind = compare?.behind_by ?? 0;
    if (opts.framed === true && (ahead > 0 || refine_active) && behind === 0) {
      await deps.touchPreview(row.id).catch(() => undefined);
    }
  } else if (row?.preview_status === "starting") {
    preview = { status: "starting", url: null };
  }
  return {
    enabled: true,
    draft: {
      exists: head_sha !== null,
      ahead_by: compare?.ahead_by ?? 0,
      behind_by: compare?.behind_by ?? 0,
      head_sha,
      changes: (compare?.commits ?? []).slice(-100).reverse(),
    },
    preview,
    refine_active,
  };
}

export async function publishDraft(
  tenant_id: string,
  deps: LiveEditDeps = realLiveEditDeps,
): Promise<{ commit_sha: string; published: number }> {
  const { target, auth } = await resolveRepo(tenant_id, deps);
  if (await deps.hasActiveBuild(tenant_id)) {
    throw new LiveEditError("build_in_progress", "Wait for the current change to finish, then publish.", 409);
  }
  const { compare, head_sha } = await readDraft(tenant_id, target, auth, deps, true);
  if (!head_sha || !compare || compare.ahead_by === 0) {
    throw new LiveEditError("nothing_to_publish", "There are no unpublished changes.", 409);
  }
  if (compare.behind_by > 0) {
    throw new LiveEditError(
      "draft_behind",
      "Your live app changed since these edits were made. Discard the draft and make the change again.",
      409,
    );
  }
  await assertNoProtectedPaths(tenant_id, target, auth, head_sha, deps);
  await deps.fastForward({ ...auth, branch: target.default_branch, to_sha: head_sha });
  invalidateLiveEditState(tenant_id);
  if (deps.clearInlineEditsOnPublish) {
    await deps.clearInlineEditsOnPublish(tenant_id).catch((e: unknown) => {
      console.warn(`[live-edit] inline edit clear failed tenant=${tenant_id}: ${(e as Error)?.message ?? e}`);
    });
  }
  if (deps.requestStaticPublish) {
    await deps.requestStaticPublish({ tenant_id, sha: head_sha }).catch((e: unknown) => {
      console.warn(`[live-edit] static publish request failed tenant=${tenant_id}: ${(e as Error)?.message ?? e}`);
    });
  }
  return { commit_sha: head_sha, published: compare.ahead_by };
}

async function assertNoProtectedPaths(
  tenant_id: string,
  target: LiveEditTarget,
  auth: RepoAuth,
  head_sha: string,
  deps: LiveEditDeps,
): Promise<void> {
  let paths: string[];
  let globs: string[];
  try {
    [paths, globs] = await Promise.all([
      deps.changedFiles({ ...auth, base: target.default_branch, head: head_sha }),
      deps.protectedGlobs(tenant_id),
    ]);
  } catch (e) {
    console.warn(`[live-edit] publish refused, changed files unreadable tenant=${tenant_id}: ${(e as Error)?.message ?? e}`);
    throw new LiveEditError(
      "protected_paths",
      "We could not check which files this change touches, so it was not published. Try again.",
      409,
    );
  }
  const hits = findProtectedPathHits(paths, globs);
  if (hits.length === 0) return;
  const shown = hits.slice(0, 5).map((h) => h.path);
  const more = hits.length > shown.length ? ` and ${hits.length - shown.length} more` : "";
  console.warn(`[live-edit] publish refused, protected paths tenant=${tenant_id} paths=${hits.map((h) => h.path).join(",")}`);
  throw new LiveEditError(
    "protected_paths",
    `This change touches sensitive files (${shown.join(", ")}${more}). It needs a review before it can go live.`,
    409,
  );
}

export async function discardDraft(
  tenant_id: string,
  deps: LiveEditDeps = realLiveEditDeps,
): Promise<{ discarded: boolean }> {
  const { target, auth } = await resolveRepo(tenant_id, deps);
  if (await deps.hasActiveBuild(tenant_id)) {
    throw new LiveEditError("build_in_progress", "Wait for the current change to finish, then discard.", 409);
  }
  const discarded = await deps.deleteBranch({ ...auth, branch: LIVE_EDIT_BRANCH });
  invalidateLiveEditState(tenant_id);
  const row = await deps.loadPreviewRow(tenant_id, target.github_full_name).catch(() => null);
  if (row) await deps.clearPreview(row.id).catch(() => undefined);
  return { discarded };
}

export async function discardDraftForNewBuild(
  tenant_id: string,
  deps: LiveEditDeps = realLiveEditDeps,
): Promise<void> {
  if (!(await deps.enabled(tenant_id))) return;
  const target = await deps.loadTarget(tenant_id);
  if (!target || !(await deps.assertProvisioned(tenant_id, target.github_full_name))) return;
  const installation_id = await deps.installation(tenant_id, target.github_full_name);
  const deleted = await deps.deleteBranch({ ...repoAuth(tenant_id, installation_id, target.github_full_name), branch: LIVE_EDIT_BRANCH });
  invalidateLiveEditState(tenant_id);
  if (deleted) console.info(`[live-edit] discarded stale draft for new build tenant=${tenant_id}`);
}

export async function checkDraftBeforeUndo(
  tenant_id: string,
  deps: LiveEditDeps = realLiveEditDeps,
): Promise<"clear" | "unpublished"> {
  if (!(await deps.enabled(tenant_id))) return "clear";
  const target = await deps.loadTarget(tenant_id);
  if (!target || !(await deps.assertProvisioned(tenant_id, target.github_full_name))) return "clear";
  const installation_id = await deps.installation(tenant_id, target.github_full_name);
  const auth = repoAuth(tenant_id, installation_id, target.github_full_name);
  const head_sha = await deps.branchSha({ ...auth, branch: LIVE_EDIT_BRANCH });
  if (!head_sha) return "clear";
  const compare = await deps.compare({ ...auth, base: target.default_branch, head: LIVE_EDIT_BRANCH });
  if (!compare) throw new Error("live edit: draft compare unavailable");
  return compare.ahead_by > 0 ? "unpublished" : "clear";
}

export async function resetDraftAfterUndo(
  tenant_id: string,
  new_main_sha: string,
  deps: LiveEditDeps = realLiveEditDeps,
): Promise<"reset" | "deleted" | "skipped"> {
  if (!(await deps.enabled(tenant_id))) return "skipped";
  const target = await deps.loadTarget(tenant_id);
  if (!target || !(await deps.assertProvisioned(tenant_id, target.github_full_name))) return "skipped";
  const installation_id = await deps.installation(tenant_id, target.github_full_name);
  const auth = repoAuth(tenant_id, installation_id, target.github_full_name);
  const head_sha = await deps.branchSha({ ...auth, branch: LIVE_EDIT_BRANCH });
  let outcome: "reset" | "deleted" | "skipped" = "skipped";
  if (head_sha) {
    try {
      await deps.fastForward({ ...auth, branch: LIVE_EDIT_BRANCH, to_sha: new_main_sha });
      outcome = "reset";
    } catch (e) {
      const compare = await deps.compare({ ...auth, base: target.default_branch, head: LIVE_EDIT_BRANCH }).catch(() => null);
      if (!compare || compare.ahead_by > 0) {
        invalidateLiveEditState(tenant_id);
        throw new LiveEditError(
          "draft_has_new_edits",
          `the preview draft has edits made after the undo started, so it was kept: ${(e as Error)?.message ?? e}`,
          409,
        );
      }
      console.warn(`[live-edit] draft fast-forward after undo failed tenant=${tenant_id}, deleting it: ${(e as Error)?.message ?? e}`);
      await deps.deleteBranch({ ...auth, branch: LIVE_EDIT_BRANCH });
      outcome = "deleted";
    }
  }
  invalidateLiveEditState(tenant_id);
  const row = await deps.loadPreviewRow(tenant_id, target.github_full_name).catch(() => null);
  if (row) await deps.clearPreview(row.id).catch(() => undefined);
  return outcome;
}

export async function commitRefineToDraft(input: {
  tenant_id: string;
  repo_full_name: string;
  default_branch: string;
  message: string;
  files: Array<{ path: string; action: "create" | "modify" | "delete"; content?: string; encoding?: "base64" }>;
}): Promise<{ commit_sha: string; created: boolean }> {
  if (!(await assertProvisionedRepoTarget(input.tenant_id, input.repo_full_name)).ok) {
    throw new LiveEditError("not_provisioned", "Draft commits only go to the workspace's own built app.", 409);
  }
  const installation_id = await resolveInstallationForRepo(input.tenant_id, input.repo_full_name);
  const res = await commitFilesToBranch({
    ...repoAuth(input.tenant_id, installation_id, input.repo_full_name),
    branch: LIVE_EDIT_BRANCH,
    fallback_base: input.default_branch,
    message: input.message,
    files: input.files,
  });
  invalidateLiveEditState(input.tenant_id);
  return { commit_sha: res.commit_sha, created: res.created };
}

function shq(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

export function buildDraftCheckoutScript(default_branch: string, repo_dir = LIVE_EDIT_REPO_DIR): string {
  const draft = shq(LIVE_EDIT_BRANCH);
  const base = shq(`origin/${default_branch}`);
  return [
    `cd ${shq(repo_dir)} || { echo __DRAFT__NOREPO; exit 0; }`,
    `exec 9>/tmp/_praxis_wt.lock && flock -w 60 9 || { echo __DRAFT__LOCK; exit 0; }`,
    `${refreshOriginUrlStep()}git fetch --prune origin >/dev/null 2>&1 || { echo __DRAFT__FETCH; exit 0; }`,
    `if git rev-parse --verify -q ${shq(`refs/remotes/origin/${LIVE_EDIT_BRANCH}`)} >/dev/null; then git checkout -q -f -B ${draft} ${shq(`origin/${LIVE_EDIT_BRANCH}`)}; else git checkout -q -f -B ${draft} ${base}; fi || { echo __DRAFT__CHECKOUT; exit 0; }`,
    `git reset -q --hard HEAD && git clean -fdq`,
    `echo "__DRAFT__OK:$(git rev-parse HEAD)"`,
  ].join("\n");
}

export function parseDraftCheckout(stdout: string): { ok: true; sha: string } | { ok: false; reason: string } {
  const m = stdout.match(/__DRAFT__OK:([0-9a-f]{40})/);
  if (m) return { ok: true, sha: m[1] };
  const r = stdout.match(/__DRAFT__([A-Z]+)/);
  return { ok: false, reason: r ? r[1].toLowerCase() : "unknown" };
}

export async function checkoutDraftInSandbox(
  sandbox_id: string,
  default_branch: string,
  exec: typeof execCommand = execCommand,
): Promise<{ ok: true; sha: string } | { ok: false; reason: string }> {
  const res = await exec(sandbox_id, buildDraftCheckoutScript(default_branch), 90_000);
  return parseDraftCheckout(res.stdout);
}

export async function checkoutDraftOrThrow(
  sandbox_id: string,
  default_branch: string,
  checkout: (sandbox_id: string, default_branch: string) => Promise<{ ok: true; sha: string } | { ok: false; reason: string }> = checkoutDraftInSandbox,
): Promise<{ ok: true; sha: string }> {
  const co = await checkout(sandbox_id, default_branch);
  if (!co.ok) throw new Error(`live edit: draft checkout failed (${co.reason})`);
  return co;
}

export type RestoreDraftDeps = {
  enabled: (tenant_id: string) => Promise<boolean>;
  checkout: (sandbox_id: string, default_branch: string) => Promise<{ ok: true; sha: string } | { ok: false; reason: string }>;
  loadPreviewRow: LiveEditDeps["loadPreviewRow"];
  clearPreview: (row_id: string) => Promise<void>;
};

export async function restoreDraftAfterReset(
  input: { sandbox_id: string; tenant_id: string; repo_full_name: string; default_branch: string },
  deps: RestoreDraftDeps = {
    enabled: liveEditEnabled,
    checkout: (sandbox_id, default_branch) => checkoutDraftInSandbox(sandbox_id, default_branch),
    loadPreviewRow: realLoadPreviewRow,
    clearPreview: realLiveEditDeps.clearPreview,
  },
): Promise<void> {
  if (!(await deps.enabled(input.tenant_id))) return;
  const co = await deps
    .checkout(input.sandbox_id, input.default_branch || "main")
    .catch((): { ok: false; reason: string } => ({ ok: false, reason: "exec" }));
  if (co.ok) return;
  const row = await deps.loadPreviewRow(input.tenant_id, input.repo_full_name).catch(() => null);
  if (row) await deps.clearPreview(row.id).catch(() => undefined);
}

export const LIVE_EDIT_RUN_PREFIX = "live-edit:";

export function liveEditPreviewCap(): number {
  const n = Number(process.env.LIVE_EDIT_PREVIEW_CAP ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

export type EnsurePreviewDeps = {
  loadPreviewRow: LiveEditDeps["loadPreviewRow"];
  exec: typeof execCommand;
  setPreview: (row_id: string, url: string | null, port: number, status: "starting" | "live", run_marker: string) => Promise<void>;
  clearPreview: (row_id: string) => Promise<void>;
  startServer: (sandbox_id: string, install: boolean) => Promise<{ url: string; port: number }>;
  hostFor: (sandbox_id: string, port: number) => Promise<string>;
  countFleetPreviews: (exclude_row_id: string) => Promise<number>;
};

async function realCountFleetPreviews(exclude_row_id: string): Promise<number> {
  return countOtherLiveEditPreviews(exclude_row_id, LIVE_EDIT_RUN_PREFIX);
}

export const realEnsurePreviewDeps: EnsurePreviewDeps = {
  loadPreviewRow: realLoadPreviewRow,
  exec: (...args: Parameters<typeof execCommand>) => execCommand(...args),
  setPreview: async (row_id, url, port, status, run_marker) => {
    await setLiveEditPreview({ row_id, url, port, status, run_marker });
  },
  clearPreview: realLiveEditDeps.clearPreview,
  startServer: (sandbox_id, install) =>
    startPreviewServer(sandbox_id, PREVIEW_DEFAULT_PORT, {
      repo_dir: LIVE_EDIT_REPO_DIR,
      sanitize_secret_env: true,
      ...(install ? { shared_root: LIVE_EDIT_REPO_DIR, install_timeout_s: 600 } : {}),
    }),
  hostFor: (sandbox_id, port) => getSandboxHost(sandbox_id, port),
  countFleetPreviews: realCountFleetPreviews,
};

export type EnsurePreviewResult = {
  url: string | null;
  reused: boolean;
  reason: "reused" | "booted" | "boot_failed" | "no_row" | "disabled" | "capacity";
};

const inFlight = new Map<string, Promise<EnsurePreviewResult>>();

export function ensureLiveEditPreview(
  input: { tenant_id: string; repo_full_name: string; sandbox_id: string; run_id?: string; install?: boolean },
  deps: EnsurePreviewDeps = realEnsurePreviewDeps,
): Promise<EnsurePreviewResult> {
  const key = `${input.tenant_id}:${input.repo_full_name}:${input.sandbox_id}`;
  const running = inFlight.get(key);
  const p = (
    running
      ? running.then((r) => (r.url || input.install !== true || r.reason === "capacity" ? r : ensureOnce(input, deps)))
      : ensureOnce(input, deps)
  ).finally(() => {
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

async function ensureOnce(
  input: { tenant_id: string; repo_full_name: string; sandbox_id: string; run_id?: string; install?: boolean },
  deps: EnsurePreviewDeps,
): Promise<EnsurePreviewResult> {
  const t0 = Date.now();
  if (!previewEnabled()) return { url: null, reused: false, reason: "disabled" };
  const row = await deps.loadPreviewRow(input.tenant_id, input.repo_full_name);
  if (!row) return { url: null, reused: false, reason: "no_row" };
  const marker = `${LIVE_EDIT_RUN_PREFIX}${input.run_id ?? "wake"}`;
  if (row.e2b_sandbox_id === input.sandbox_id) {
    const port = row.preview_port ?? PREVIEW_DEFAULT_PORT;
    const probe = await deps
      .exec(input.sandbox_id, `curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${port}/`, 10_000)
      .catch(() => null);
    const code = Number((probe?.stdout ?? "").trim().slice(-3));
    if (code >= 200 && code < 400) {
      if (row.preview_status === "live" && row.preview_url) {
        if (!(row.preview_run_id ?? "").startsWith(LIVE_EDIT_RUN_PREFIX)) {
          await deps.setPreview(row.id, row.preview_url, port, "live", marker);
        }
        return { url: row.preview_url, reused: true, reason: "reused" };
      }
      const url = await deps.hostFor(input.sandbox_id, port);
      await deps.setPreview(row.id, null, port, "starting", marker);
      await deps.setPreview(row.id, url, port, "live", marker);
      console.info(`[live-edit] preview resumed tenant=${input.tenant_id} ms=${Date.now() - t0}`);
      return { url, reused: true, reason: "reused" };
    }
  }
  const fleet = await deps.countFleetPreviews(row.id).catch(() => Number.POSITIVE_INFINITY);
  if (fleet >= liveEditPreviewCap()) {
    console.warn(`[live-edit] admission_refused tenant=${input.tenant_id} fleet=${fleet} cap=${liveEditPreviewCap()}`);
    if (row.preview_status === "starting" && row.preview_run_id === marker) {
      await deps.clearPreview(row.id).catch(() => undefined);
    }
    return { url: null, reused: false, reason: "capacity" };
  }
  await deps.setPreview(row.id, null, PREVIEW_DEFAULT_PORT, "starting", marker).catch(() => undefined);
  try {
    const { url, port } = await deps.startServer(input.sandbox_id, input.install === true);
    await deps.setPreview(row.id, url, port, "live", marker);
    console.info(
      `[live-edit] preview booted tenant=${input.tenant_id} install=${input.install === true} fleet=${fleet} ms=${Date.now() - t0}`,
    );
    return { url, reused: false, reason: "booted" };
  } catch (e) {
    console.warn(`[live-edit] preview boot failed for ${input.repo_full_name} ms=${Date.now() - t0}: ${(e as Error).message ?? e}`);
    await deps.clearPreview(row.id).catch(() => undefined);
    return { url: null, reused: false, reason: "boot_failed" };
  }
}

export async function claimLiveEditPreview(
  input: { tenant_id: string; repo_full_name: string; sandbox_id: string; run_id?: string },
  deps: Pick<EnsurePreviewDeps, "loadPreviewRow" | "setPreview"> = realEnsurePreviewDeps,
): Promise<boolean> {
  if (!previewEnabled()) return false;
  const row = await deps.loadPreviewRow(input.tenant_id, input.repo_full_name).catch(() => null);
  if (!row || row.e2b_sandbox_id !== input.sandbox_id || row.preview_status === "live") return false;
  const marker = `${LIVE_EDIT_RUN_PREFIX}${input.run_id ?? "wake"}`;
  await deps.setPreview(row.id, null, row.preview_port ?? PREVIEW_DEFAULT_PORT, "starting", marker);
  return true;
}

export async function releaseLiveEditPreviewClaim(
  input: { tenant_id: string; repo_full_name: string; sandbox_id: string; run_id?: string },
  deps: Pick<EnsurePreviewDeps, "loadPreviewRow" | "clearPreview"> = realEnsurePreviewDeps,
): Promise<boolean> {
  const row = await deps.loadPreviewRow(input.tenant_id, input.repo_full_name);
  const marker = `${LIVE_EDIT_RUN_PREFIX}${input.run_id ?? "wake"}`;
  if (!row || row.e2b_sandbox_id !== input.sandbox_id || row.preview_status !== "starting" || row.preview_run_id !== marker) {
    return false;
  }
  await deps.clearPreview(row.id);
  return true;
}

export async function kickLiveEditPreview(
  input: {
    tenant_id: string;
    repo_full_name: string;
    sandbox_id: string;
    run_id?: string;
    install?: boolean;
  },
  deps: {
    claim: typeof claimLiveEditPreview;
    ensure: (i: typeof input) => Promise<EnsurePreviewResult>;
    release?: (i: typeof input) => Promise<boolean>;
  } = { claim: claimLiveEditPreview, ensure: (i) => ensureLiveEditPreview(i) },
): Promise<void> {
  const claimed = await deps.claim(input).catch((e: unknown) => {
    console.warn(`[live-edit] preview claim failed: ${(e as Error)?.message ?? e}`);
    return false;
  });
  const release = deps.release ?? ((i: typeof input) => releaseLiveEditPreviewClaim(i));
  void deps
    .ensure(input)
    .then(
      (r) => r.url,
      (e: unknown) => {
        console.warn(`[live-edit] preview kick failed: ${(e as Error)?.message ?? e}`);
        return null;
      },
    )
    .then(async (url) => {
      if (claimed && !url) await release(input);
    })
    .catch((e: unknown) => {
      console.warn(`[live-edit] preview claim release failed: ${(e as Error)?.message ?? e}`);
    });
}

export type WakeDeps = {
  installationToken: (tenant_id: string, full_name: string) => Promise<string | null>;
  resolveSandbox: (a: { tenant_id: string; repo_full_name: string; run_id: string; installation_token?: string }) => Promise<SandboxHandle>;
  injectToken: (sandbox_id: string, token: string) => Promise<void>;
  bootstrap: (sandbox_id: string, full_name: string, tenant_id: string) => Promise<void>;
  checkout: (sandbox_id: string, default_branch: string) => Promise<{ ok: true; sha: string } | { ok: false; reason: string }>;
  wipe: (sandbox_id: string) => Promise<void>;
  ensurePreview: (input: { tenant_id: string; repo_full_name: string; sandbox_id: string; install: boolean }) => Promise<EnsurePreviewResult>;
  pause: (handle: SandboxHandle, opts?: { force?: boolean }) => Promise<void>;
};

export const realWakeDeps: WakeDeps = {
  installationToken: async (tenant_id, full_name) => {
    const creds = await resolveRepoCredsForRun(tenant_id, {
      stage: "build",
      target: { github_full_name: full_name, github_target_mode: "umbrella" },
    });
    return creds.kind === "resolved" ? creds.installation_token : null;
  },
  resolveSandbox: (a) => resolveSandboxForRun({ ...a, provisioned: true }),
  injectToken: (sandbox_id, token) => injectSandboxSecrets(sandbox_id, { GITHUB_TOKEN: token }),
  bootstrap: (sandbox_id, full_name, tenant_id) => bootstrapRepoIfNeeded(sandbox_id, full_name, tenant_id),
  checkout: (sandbox_id, default_branch) => checkoutDraftInSandbox(sandbox_id, default_branch),
  wipe: (sandbox_id) => revokeSandboxGithubToken(sandbox_id),
  ensurePreview: (input) => ensureLiveEditPreview(input),
  pause: (handle, opts) => pauseAndMarkPaused(handle, opts),
};

const WAKE_BUSY = "A change is running; the preview wakes when it finishes.";

async function releaseWokenSandbox(
  tenant_id: string,
  handle: SandboxHandle,
  cause: unknown,
  deps: LiveEditDeps,
  wake: WakeDeps,
  tokenLeft = false,
): Promise<void> {
  const warn = (e: unknown) =>
    console.warn(`[live-edit] wake cleanup pause failed tenant=${tenant_id}: ${(e as Error)?.message ?? e}`);
  if (tokenLeft) {
    await wake.pause(handle, { force: true }).catch(warn);
    return;
  }
  if (cause instanceof LiveEditError && cause.code === "build_in_progress") return;
  if (await deps.hasActiveBuild(tenant_id).catch(() => true)) return;
  await wake.pause(handle).catch(warn);
}

export async function wakeLiveEditPreview(
  tenant_id: string,
  deps: LiveEditDeps = realLiveEditDeps,
  wake: WakeDeps = realWakeDeps,
): Promise<{ url: string | null }> {
  const { target, auth } = await resolveRepo(tenant_id, deps);
  if (await deps.hasActiveBuild(tenant_id)) {
    throw new LiveEditError("build_in_progress", WAKE_BUSY, 409);
  }
  const { compare } = await readDraft(tenant_id, target, auth, deps, true);
  if ((compare?.behind_by ?? 0) > 0) {
    throw new LiveEditError(
      "draft_behind",
      "Your live app changed, so the preview changes are out of date. Discard them and make the change again.",
      409,
    );
  }
  const token = await wake.installationToken(tenant_id, target.github_full_name);
  if (await deps.hasActiveBuild(tenant_id)) {
    throw new LiveEditError("build_in_progress", WAKE_BUSY, 409);
  }
  const sandbox = await wake.resolveSandbox({
    tenant_id,
    repo_full_name: target.github_full_name,
    run_id: `le-${tenant_id.slice(0, 8)}`,
    ...(token ? { installation_token: token } : {}),
  });
  let wiped = true;
  try {
    try {
      if (token) await wake.injectToken(sandbox.e2b_sandbox_id, token);
      await wake.bootstrap(sandbox.e2b_sandbox_id, target.github_full_name, tenant_id);
      if (await deps.hasActiveBuild(tenant_id)) {
        throw new LiveEditError("build_in_progress", WAKE_BUSY, 409);
      }
      const co = await wake.checkout(sandbox.e2b_sandbox_id, target.default_branch);
      if (!co.ok) {
        console.warn(`[live-edit] wake draft checkout failed tenant=${tenant_id} reason=${co.reason}`);
        throw new LiveEditError("no_sandbox", "The preview could not load your draft. Try again.", 502);
      }
    } finally {
      wiped = await wake.wipe(sandbox.e2b_sandbox_id).then(
        () => true,
        () => false,
      );
    }
    if (!wiped) throw new LiveEditError("no_sandbox", "The preview didn't start. Try again.", 502);
    const res = await wake.ensurePreview({
      tenant_id,
      repo_full_name: target.github_full_name,
      sandbox_id: sandbox.e2b_sandbox_id,
      install: true,
    });
    if (res.url) return { url: res.url };
    if (res.reason === "capacity") {
      throw new LiveEditError("capacity", "Previews are busy right now. Your changes are saved; try again in a few minutes.", 503);
    }
    throw new LiveEditError("no_sandbox", "The preview didn't start. Try again.", 502);
  } catch (e) {
    await releaseWokenSandbox(tenant_id, sandbox, e, deps, wake, !wiped);
    throw e;
  }
}
