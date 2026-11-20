
import {
  cloneRepo,
  createSandbox,
  destroySandbox,
  execCommand,
  isSandboxQuarantined,
  pauseSandbox,
  quarantineSandboxBox,
  resetToMain,
  resumeSandbox,
  setEnv,
  wipeEnv,
  type SecretEnvMap,
} from "./e2b-client";
import { serviceClient } from "@/services/supabase";
import { pickSandboxTemplate } from "@/services/sandbox/sandbox-tier";
import {
  diskHygieneMode,
  gcSandboxDisk,
  probeFreeKb,
  requiredFreeKb,
  templateReconcileEnabled,
} from "@/services/sandbox/disk-hygiene";
import { logEvent } from "@/services/logging/logEvent";
import { alert } from "@/services/logging/alert";
import { E2B_VITE_TEMPLATE_ALIAS, E2B_ZAVI_TEMPLATE_ALIAS, SITE_REPO_DIR } from "@/services/sites/contract";
import { requireSiteBackend } from "@/services/sites/site-backend";

const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;
function isSafeBranch(branch: string | null | undefined): branch is string {
  if (typeof branch !== "string" || branch.length === 0) return false;
  if (branch.startsWith("-")) return false;
  return SAFE_BRANCH.test(branch);
}

export async function resolveStoredDefaultBranch(
  tenant_id: string,
  repo_full_name: string,
): Promise<string> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("connector_metadata")
    .select("repo_default_branches")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (error) {
    console.warn(
      `resolveStoredDefaultBranch: select failed for tenant=${tenant_id} ` +
        `repo=${repo_full_name}: ${error.message}; falling back to 'main'`,
    );
    return "main";
  }
  const map =
    (data as { repo_default_branches?: Record<string, string> } | null)
      ?.repo_default_branches ?? {};
  const stored = map[repo_full_name];
  if (!isSafeBranch(stored)) {
    if (stored !== undefined) {
      console.warn(
        `resolveStoredDefaultBranch: unsafe/empty stored value ` +
          `${JSON.stringify(stored)} for tenant=${tenant_id} ` +
          `repo=${repo_full_name}; falling back to 'main'`,
      );
    }
    return "main";
  }
  return stored;
}

export type SandboxRow = {
  id: string;
  tenant_id: string;
  repo_full_name: string;
  e2b_sandbox_id: string | null;
  status: "creating" | "active" | "paused" | "destroyed" | "failed";
  last_resumed_at: string | null;
  last_error: string | null;
  measured_tree_kb: number | null;
  e2b_template: string | null;
  needs_recreate_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type SandboxHandle = {
  row_id: string;
  e2b_sandbox_id: string;
  e2b_template?: string | null;
};

export type ResolveSandboxArgs = {
  tenant_id: string;
  repo_full_name: string;
  installation_token?: string;
  template?: string;
  run_id?: string;
  provisioned?: boolean;
};

export type HygieneOutcome =
  | "disabled"
  | "healthy"
  | "probe_failed"
  | "no_lease"
  | "live_sharer"
  | "gc_ok"
  | "gc_insufficient"
  | "provisioned_no_destroy"
  | "recreate";

async function hasLiveSharer(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  self_run_id: string,
): Promise<boolean> {
  try {
    const { data, error } = await sb
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("status", "running")
      .neq("id", self_run_id)
      .limit(1);
    if (error) return true;
    return (data ?? []).length > 0;
  } catch {
    return true;
  }
}

const SANDBOX_SHARER_SLUGS = ["engineer", "qa", "product-builder"] as const;

async function hasLiveRepoSharer(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  repo_full_name: string,
  self_run_id: string,
): Promise<boolean> {
  const repo = String(repo_full_name ?? "").trim();
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return true;
  try {
    const { data, error } = await sb
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("status", "running")
      .or(
        `payload->>repo_hint.eq.${repo},payload->target->>github_full_name.eq.${repo},` +
          `and(payload->>repo_hint.is.null,payload->target->>github_full_name.is.null,agent_slug.in.(${SANDBOX_SHARER_SLUGS.join(",")}))`,
      )
      .neq("id", self_run_id)
      .limit(1);
    if (error) return true;
    return (data ?? []).length > 0;
  } catch {
    return true;
  }
}

export async function enforceSandboxHygiene(
  sb: ReturnType<typeof serviceClient>,
  row: SandboxRow,
  args: ResolveSandboxArgs,
): Promise<HygieneOutcome> {
  const mode = diskHygieneMode();
  const run_id = args.run_id;
  const sandbox_id = row.e2b_sandbox_id;
  if (mode === "off" || !run_id || !sandbox_id) return "disabled";

  const free = await probeFreeKb(sandbox_id);
  const required = requiredFreeKb(row.measured_tree_kb);
  const wantsRecreate = row.needs_recreate_reason != null;

  if (free == null) {
    if (!wantsRecreate) {
      void logEvent({
        tenant_id: args.tenant_id,
        level: "warn",
        source: "sandbox-hygiene",
        code: "sandbox.hygiene",
        meta: { outcome: "probe_failed" },
      }).catch(() => {});
      return "probe_failed";
    }
  } else if (free >= required && !wantsRecreate) {
    return "healthy";
  }

  if (mode === "probe_only") return "healthy";

  const { data: leased, error: leaseErr } = await sb.rpc("try_lease_sandbox", {
    p_id: row.id,
    p_tenant_id: args.tenant_id,
    p_holder_run_id: run_id,
    p_ttl_seconds: 300,
  });
  if (leaseErr || leased !== true) return "no_lease";

  try {
    if (await hasLiveSharer(sb, args.tenant_id, run_id)) return "live_sharer";

    const { freedKb } = await gcSandboxDisk({
      sandbox_id,
      tenant_id: args.tenant_id,
      keepRunIds: [run_id],
    });
    const after = await probeFreeKb(sandbox_id);

    if (!wantsRecreate && after != null && after >= required) {
      void logEvent({
        tenant_id: args.tenant_id,
        level: "info",
        source: "sandbox-hygiene",
        code: "sandbox.hygiene",
        meta: { outcome: "gc_ok", freed_kb: freedKb },
      }).catch(() => {});
      return "gc_ok";
    }
    if (mode !== "recreate") return "gc_insufficient";

    if (args.provisioned) {
      void logEvent({
        tenant_id: args.tenant_id,
        level: "warn",
        source: "sandbox-hygiene",
        code: "sandbox.hygiene",
        meta: { outcome: "provisioned_no_destroy", freed_kb: freedKb },
      }).catch(() => {});
      return "provisioned_no_destroy";
    }

    const { data: affected, error: dErr } = await sb.rpc("destroy_sandbox_row_cas", {
      p_id: row.id,
      p_tenant_id: args.tenant_id,
      p_e2b_sandbox_id: sandbox_id,
    });
    if (dErr || Number(affected) !== 1) {
      console.error(
        `[lifecycle] hygiene destroy CAS aborted for ${row.id}: affected=${String(affected)} err=${dErr?.message ?? "none"}`,
      );
      return "gc_insufficient";
    }
    try {
      await destroySandbox(sandbox_id);
    } catch (e) {
      console.warn(`[lifecycle] e2b kill failed for ${sandbox_id}: ${(e as Error).message}`);
    }
    void logEvent({
      tenant_id: args.tenant_id,
      level: "warn",
      source: "sandbox-hygiene",
      code: "sandbox.hygiene",
      meta: { outcome: "recreate", freed_kb: freedKb },
    }).catch(() => {});
    return "recreate";
  } finally {
    try {
      await sb.rpc("release_sandbox_lease", {
        p_id: row.id,
        p_tenant_id: args.tenant_id,
        p_holder_run_id: run_id,
      });
    } catch {
    }
  }
}

export function templateDrifted(row: SandboxRow, args: ResolveSandboxArgs): boolean {
  if (!args.template) return false;
  if (isSiteSandboxTemplate(args.template)) return (row.e2b_template ?? null) !== args.template;
  if (!templateReconcileEnabled()) return false;
  if (args.provisioned) return false;
  return (row.e2b_template ?? null) !== args.template;
}

export function isSiteSandboxTemplate(template: string | null | undefined): boolean {
  return template === E2B_ZAVI_TEMPLATE_ALIAS || template === E2B_VITE_TEMPLATE_ALIAS;
}

export async function recycleDriftedTemplate(
  sb: ReturnType<typeof serviceClient>,
  row: SandboxRow,
  args: ResolveSandboxArgs,
): Promise<boolean> {
  const run_id = args.run_id;
  const sandbox_id = row.e2b_sandbox_id;
  if (!run_id || !sandbox_id) return false;

  const { data: leased, error: leaseErr } = await sb.rpc("try_lease_sandbox", {
    p_id: row.id,
    p_tenant_id: args.tenant_id,
    p_holder_run_id: run_id,
    p_ttl_seconds: 300,
  });
  if (leaseErr || leased !== true) return false;

  try {
    const shared = isSiteSandboxTemplate(args.template)
      ? await hasLiveRepoSharer(sb, args.tenant_id, args.repo_full_name, run_id)
      : await hasLiveSharer(sb, args.tenant_id, run_id);
    if (shared) return false;

    const { data: affected, error: dErr } = await sb.rpc("destroy_sandbox_row_cas", {
      p_id: row.id,
      p_tenant_id: args.tenant_id,
      p_e2b_sandbox_id: sandbox_id,
    });
    if (dErr || Number(affected) !== 1) {
      console.error(
        `[lifecycle] template-reconcile destroy CAS aborted for ${row.id}: affected=${String(affected)} err=${dErr?.message ?? "none"}`,
      );
      return false;
    }
    try {
      await destroySandbox(sandbox_id);
    } catch (e) {
      console.warn(`[lifecycle] e2b kill failed for ${sandbox_id}: ${(e as Error).message}`);
    }
    void logEvent({
      tenant_id: args.tenant_id,
      level: "warn",
      source: "sandbox-hygiene",
      code: "sandbox.template_reconcile",
      meta: { from: row.e2b_template ?? "null", to: args.template ?? "null" },
    }).catch(() => {});
    return true;
  } finally {
    try {
      await sb.rpc("release_sandbox_lease", {
        p_id: row.id,
        p_tenant_id: args.tenant_id,
        p_holder_run_id: run_id,
      });
    } catch {
    }
  }
}

async function refreshTokenBeforeReset(
  sb: ReturnType<typeof serviceClient>,
  row: SandboxRow,
  args: ResolveSandboxArgs,
  defaultBranch: string,
): Promise<void> {
  const sandboxId = row.e2b_sandbox_id as string;
  if (args.installation_token) {
    await setEnv(sandboxId, { GITHUB_TOKEN: args.installation_token });
    await resetToMain(sandboxId, defaultBranch, undefined, {
      refreshOriginUrl: true,
    });
    try {
      await sb.rpc("mark_sandbox_token_refreshed", { p_id: row.id });
    } catch (e) {
      console.warn(
        `[lifecycle] mark_sandbox_token_refreshed failed for ${row.id}: ${(e as Error).message}`,
      );
    }
  } else {
    await resetToMain(sandboxId, defaultBranch);
  }
}

const NOT_CONNECTED_REPO_RE = /not in tenant connected repos/;

const DEAD_SITE_STATUSES = new Set(["failed", "fell_back_old", "deleting", "deleted"]);

async function healSiteRepoRegistration(
  sb: ReturnType<typeof serviceClient>,
  args: Pick<ResolveSandboxArgs, "tenant_id" | "repo_full_name">,
): Promise<boolean> {
  try {
    const [{ siteStore }, { addSiteRepoToUmbrellaConnector }] = await Promise.all([
      import("@/services/sites/store"),
      import("@/services/sites/register-site-repo"),
    ]);
    const repo = (args.repo_full_name ?? "").trim();
    const site = await siteStore().getByRepo(args.tenant_id, repo);
    if (!site || site.tenant_id !== args.tenant_id) return false;
    if (DEAD_SITE_STATUSES.has(site.status) || (site.github_full_name ?? "").trim() !== repo) return false;
    const outcome = await addSiteRepoToUmbrellaConnector(sb, args.tenant_id, repo, "main");
    if (outcome === "added") {
      void logEvent({
        tenant_id: args.tenant_id,
        level: "warn",
        source: "sandbox-hygiene",
        code: "sandbox.site_repo_registered",
        meta: { code: "healed" },
      }).catch(() => {});
    }
    return outcome === "added" || outcome === "present";
  } catch (e) {
    console.warn(`[lifecycle] site repo self-heal failed for tenant=${args.tenant_id}: ${(e as Error).message}`);
    return false;
  }
}

export async function resolveSandboxForRun(
  args: ResolveSandboxArgs,
): Promise<SandboxHandle> {
  const sb = serviceClient();
  const getOrCreate = () =>
    sb.rpc("get_or_create_tenant_sandbox", {
      p_tenant_id: args.tenant_id,
      p_repo_full_name: args.repo_full_name,
    });
  let { data, error } = await getOrCreate();
  if (error && NOT_CONNECTED_REPO_RE.test(error.message) && (await healSiteRepoRegistration(sb, args))) {
    ({ data, error } = await getOrCreate());
  }
  if (error) {
    throw new Error(`resolveSandboxForRun: rpc failed: ${error.message}`);
  }
  const row = data as SandboxRow;

  if ((row.status === "active" || row.status === "paused") && row.e2b_sandbox_id && templateDrifted(row, args)) {
    if (await recycleDriftedTemplate(sb, row, args)) {
      row.status = "destroyed";
    } else if (isSiteSandboxTemplate(args.template)) {
      throw new Error(
        `resolveSandboxForRun: site sandbox is on ${row.e2b_template ?? "an unknown image"}, needs ${args.template}; could not recycle it yet (retryable)`,
      );
    }
  }

  if (row.status === "active" && row.e2b_sandbox_id) {
    try {
      await resumeSandbox(row.e2b_sandbox_id);
      const defaultBranch = await resolveStoredDefaultBranch(
        args.tenant_id,
        args.repo_full_name,
      );
      await refreshTokenBeforeReset(sb, row, args, defaultBranch);
      const outcome = await enforceSandboxHygiene(sb, row, args);
      if (outcome !== "recreate") {
        return { row_id: row.id, e2b_sandbox_id: row.e2b_sandbox_id, e2b_template: row.e2b_template };
      }
      row.status = "destroyed";
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      await sb.rpc("mark_sandbox_failed", { p_id: row.id, p_error: msg });
      throw new Error(`resolveSandboxForRun: stale-active recovery failed: ${msg}`);
    }
  }

  if (row.status === "paused" && row.e2b_sandbox_id) {
    try {
      await resumeSandbox(row.e2b_sandbox_id);
      const defaultBranch = await resolveStoredDefaultBranch(
        args.tenant_id,
        args.repo_full_name,
      );
      await refreshTokenBeforeReset(sb, row, args, defaultBranch);
      const { error: e } = await sb.rpc("mark_sandbox_active", {
        p_id: row.id,
        p_e2b_sandbox_id: row.e2b_sandbox_id,
      });
      if (e) throw new Error(`mark_sandbox_active: ${e.message}`);
      const outcome = await enforceSandboxHygiene(sb, row, args);
      if (outcome !== "recreate") {
        return { row_id: row.id, e2b_sandbox_id: row.e2b_sandbox_id, e2b_template: row.e2b_template };
      }
      row.status = "destroyed";
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      await sb.rpc("mark_sandbox_failed", { p_id: row.id, p_error: msg });
      throw new Error(`resolveSandboxForRun: resume failed: ${msg}`);
    }
  }

  try {
    const [owner, repo] = args.repo_full_name.split("/");
    if (!owner || !repo) {
      throw new Error(
        `repo_full_name must be 'owner/repo'; got '${args.repo_full_name}'`,
      );
    }
    const chosenTemplate = isSiteSandboxTemplate(args.template)
      ? args.template!
      : pickSandboxTemplate(row.measured_tree_kb) ?? args.template ?? null;
    const newId = await createSandbox({
      tenant_id: args.tenant_id,
      repo_full_name: args.repo_full_name,
      template: chosenTemplate ?? undefined,
    });
    await sb.rpc("mark_sandbox_active", {
      p_id: row.id,
      p_e2b_sandbox_id: newId,
    });
    if (row.needs_recreate_reason != null) {
      try {
        await sb.rpc("clear_sandbox_needs_recreate", {
          p_id: row.id,
          p_tenant_id: args.tenant_id,
        });
      } catch (e) {
        console.warn(
          `[lifecycle] clear_sandbox_needs_recreate failed for ${row.id}: ${(e as Error).message}`,
        );
      }
    }
    const stampAttempts = isSiteSandboxTemplate(chosenTemplate) ? 3 : 1;
    let stampError: string | null = null;
    for (let i = 0; i < stampAttempts; i++) {
      try {
        const { error: tErr } = await sb.rpc("set_sandbox_template", {
          p_id: row.id,
          p_template: chosenTemplate,
        });
        stampError = tErr ? `failed: ${tErr.message}` : null;
      } catch (e) {
        stampError = `threw: ${(e as Error).message}`;
      }
      if (!stampError) break;
    }
    if (stampError) {
      console.warn(`[lifecycle] set_sandbox_template ${stampError} for ${row.id}`);
      if (stampAttempts > 1) {
        void logEvent({
          tenant_id: args.tenant_id,
          level: "error",
          source: "sandbox-lifecycle",
          code: "sandbox.site_template_stamp_failed",
          meta: { template: chosenTemplate ?? "null" },
        }).catch(() => {});
      }
    }
    return { row_id: row.id, e2b_sandbox_id: newId, e2b_template: chosenTemplate };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    await sb.rpc("mark_sandbox_failed", { p_id: row.id, p_error: msg });
    throw new Error(`resolveSandboxForRun: create failed: ${msg}`);
  }
}

export async function bootstrapRepoIfNeeded(
  e2b_sandbox_id: string,
  repo_full_name: string,
  tenant_id?: string,
): Promise<void> {
  const [owner, repo] = repo_full_name.split("/");
  if (!owner || !repo) {
    throw new Error(
      `bootstrapRepoIfNeeded: bad repo_full_name '${repo_full_name}'`,
    );
  }
  const r = await cloneRepo(e2b_sandbox_id, owner, repo);
  if (r.exit_code !== 0 && !/already exists/i.test(r.stderr)) {
    throw new Error(
      `cloneRepo failed exit=${r.exit_code} stderr=${r.stderr.slice(0, 400)}`,
    );
  }

  if (!tenant_id) {
    return;
  }
  try {
    const detect = await execCommand(
      e2b_sandbox_id,
      `cd /home/user/repo && git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true`,
      15_000,
    );
    const raw = (detect.stdout ?? "").trim();
    const branch = raw.replace(/^origin\//, "");
    if (!isSafeBranch(branch)) {
      console.warn(
        `bootstrapRepoIfNeeded: default-branch detect returned unsafe/empty ` +
          `value ${JSON.stringify(raw)} for ${repo_full_name}; skipping cache`,
      );
      return;
    }
    const sb = serviceClient();
    const { error } = await sb.rpc("set_github_repo_default_branch_if_not_operator", {
      p_tenant_id: tenant_id,
      p_repo_full_name: repo_full_name,
      p_default_branch: branch,
    });
    if (error) {
      console.warn(
        `bootstrapRepoIfNeeded: set_github_repo_default_branch_if_not_operator failed for ` +
          `${repo_full_name}: ${error.message}`,
      );
    }
  } catch (e) {
    console.warn(
      `bootstrapRepoIfNeeded: default-branch detect threw for ${repo_full_name}: ${
        (e as Error).message ?? String(e)
      }`,
    );
  }
}

export async function markSandboxDestroyed(row_id: string): Promise<void> {
  const { error: e } = await serviceClient().rpc("mark_sandbox_destroyed", { p_id: row_id });
  if (e) throw new Error(`mark_sandbox_destroyed failed for ${row_id}: ${e.message}`);
}

export async function markSandboxFailed(row_id: string, error: string): Promise<void> {
  const { error: e } = await serviceClient().rpc("mark_sandbox_failed", { p_id: row_id, p_error: String(error ?? "").slice(0, 500) });
  if (e) throw new Error(`mark_sandbox_failed failed for ${row_id}: ${e.message}`);
}

export async function injectSandboxSecrets(
  e2b_sandbox_id: string,
  secrets: SecretEnvMap,
): Promise<void> {
  await setEnv(e2b_sandbox_id, secrets);
}

export async function wipeSandboxSecrets(
  handle: SandboxHandle | null,
): Promise<void> {
  if (!handle) return;
  try {
    await wipeEnv(handle.e2b_sandbox_id);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `wipeSandboxSecrets: failure for ${handle.e2b_sandbox_id}`,
      e,
    );
  }
}

export function shouldKeepWarm(
  row: { preview_status?: string | null; preview_run_id?: string | null } | null,
): boolean {
  if (row?.preview_status === "live") return true;
  return row?.preview_status === "starting" && (row.preview_run_id ?? "").startsWith("live-edit:");
}

export const TOKEN_SCRUB_FAILED_ERROR = "github_token_scrub_failed";

export type QuarantineOutcome = "paused" | "destroyed" | "already" | "failed";

export type QuarantineDeps = {
  box?: typeof quarantineSandboxBox;
  retireRow?: (e2b_sandbox_id: string, error: string) => Promise<number>;
  alert?: typeof alert;
  isQuarantined?: (e2b_sandbox_id: string) => boolean;
};

async function retireRowForBox(e2b_sandbox_id: string, error: string): Promise<number> {
  const { data, error: e } = await serviceClient().rpc("retire_sandbox_box", {
    p_e2b_sandbox_id: e2b_sandbox_id,
    p_error: error,
  });
  if (e) throw new Error(e.message);
  return typeof data === "number" ? data : Number(data ?? 0);
}

export async function quarantineSandbox(
  target: { e2b_sandbox_id: string; row_id?: string | null },
  info: { source: string; tenant_id?: string | null; reason?: string; alreadyRetired?: boolean },
  deps: QuarantineDeps = {},
): Promise<QuarantineOutcome> {
  const box = deps.box ?? quarantineSandboxBox;
  const retireRow = deps.retireRow ?? retireRowForBox;
  const page = deps.alert ?? alert;
  const id = target.e2b_sandbox_id;
  const repeat = (deps.isQuarantined ?? isSandboxQuarantined)(id);

  let outcome: QuarantineOutcome = "already";
  let boxError = "";
  if (!repeat) {
    try {
      outcome = await box(id, info.alreadyRetired ? { destroyOnly: true } : {});
    } catch (e) {
      outcome = "failed";
      boxError = String((e as Error)?.message ?? e).slice(0, 200);
    }
  }

  let rowNote = "row retired";
  try {
    const n = await retireRow(id, `${TOKEN_SCRUB_FAILED_ERROR}: ${info.source}`);
    if (n === 0) rowNote = "no row points at this box";
  } catch (e) {
    rowNote = `row not retired (${String((e as Error)?.message ?? e).slice(0, 120)})`;
    if (outcome === "paused" || outcome === "already") {
      try {
        outcome = await box(id, { destroyOnly: true });
      } catch (killErr) {
        outcome = "failed";
        boxError = String((killErr as Error)?.message ?? killErr).slice(0, 200);
      }
    }
  }

  if (repeat || info.alreadyRetired) return outcome;
  try {
    await page({
      source: "sandbox-token-scrub",
      code: outcome === "failed" ? "sandbox_token_scrub_quarantine_failed" : "sandbox_token_scrub_failed",
      tenant_id: info.tenant_id ?? null,
      msg:
        `GitHub-token scrub failed in sandbox ${id} (${info.source}); box ${outcome}` +
        (boxError ? ` [${boxError}]` : "") +
        `; ${rowNote}` +
        (info.reason ? `; cause: ${info.reason.slice(0, 200)}` : ""),
      ...(outcome === "failed" ? { email: { dedupeKey: `sandbox_token_scrub:${id}` } } : {}),
    });
  } catch {
  }
  return outcome;
}

export async function isSandboxRowQuarantined(handle: SandboxHandle): Promise<boolean> {
  try {
    const { data, error } = await serviceClient()
      .from("tenant_sandbox")
      .select("status, e2b_sandbox_id, last_error")
      .eq("id", handle.row_id)
      .maybeSingle();
    if (error) return true;
    const row = data as { status?: string; e2b_sandbox_id?: string | null; last_error?: string | null } | null;
    if (!row) return false;
    return (
      row.e2b_sandbox_id === handle.e2b_sandbox_id &&
      row.status === "failed" &&
      String(row.last_error ?? "").startsWith(TOKEN_SCRUB_FAILED_ERROR)
    );
  } catch {
    return true;
  }
}

export type ScrubFailure = {
  reason: string;
  retiredElsewhere: boolean;
};

export async function sandboxScrubFailureReason(
  handle: SandboxHandle,
  preModelRevokeFailed: boolean,
  deps: {
    isQuarantined?: (e2b_sandbox_id: string) => boolean;
    rowQuarantined?: (handle: SandboxHandle) => Promise<boolean>;
  } = {},
): Promise<ScrubFailure | null> {
  if (preModelRevokeFailed) return { reason: "pre-model revoke failed", retiredElsewhere: false };
  if ((deps.isQuarantined ?? isSandboxQuarantined)(handle.e2b_sandbox_id)) {
    return { reason: "scrub failed during the run", retiredElsewhere: false };
  }
  if (await (deps.rowQuarantined ?? isSandboxRowQuarantined)(handle)) {
    return { reason: "scrub failed during the run (row retired, or row unreadable)", retiredElsewhere: true };
  }
  return null;
}

export async function pauseAndMarkPaused(
  handle: SandboxHandle | null,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!handle) return;
  if (opts.force) {
    await quarantineSandbox(handle, { source: "forced-pause" });
    return;
  }
  const sb = serviceClient();
  try {
    const { data: row } = await sb
      .from("tenant_sandbox")
      .select("preview_status, preview_run_id")
      .eq("id", handle.row_id)
      .maybeSingle();
    if (shouldKeepWarm(row as { preview_status?: string | null; preview_run_id?: string | null } | null)) {
      return;
    }
  } catch {
  }
  try {
    await pauseSandbox(handle.e2b_sandbox_id);
    await sb.rpc("mark_sandbox_paused", { p_id: handle.row_id });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `pauseAndMarkPaused: failure for ${handle.e2b_sandbox_id}`,
      e,
    );
  }
}

export async function pauseSandboxAfterRun(
  handle: SandboxHandle | null,
): Promise<void> {
  await wipeSandboxSecrets(handle);
  await pauseAndMarkPaused(handle);
}

export async function destroySandboxRow(row_id: string): Promise<void> {
  const sb = serviceClient();
  const { data } = await sb
    .from("tenant_sandbox")
    .select("e2b_sandbox_id")
    .eq("id", row_id)
    .maybeSingle();
  const e2bId = (data as { e2b_sandbox_id: string | null } | null)
    ?.e2b_sandbox_id;
  if (e2bId) {
    try {
      await destroySandbox(e2bId);
    } catch (e) {
      console.error(`destroySandboxRow: e2b kill failed for ${e2bId}`, e);
    }
  }
  await sb.rpc("mark_sandbox_destroyed", { p_id: row_id });
}

export async function getSandboxIdForRun(
  tenant_id: string,
  repo_full_name: string,
): Promise<string | null> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("tenant_sandbox")
    .select("e2b_sandbox_id, status")
    .eq("tenant_id", tenant_id)
    .eq("repo_full_name", repo_full_name)
    .maybeSingle();
  if (error) {
    throw new Error(`getSandboxIdForRun: ${error.message}`);
  }
  if (!data) return null;
  const row = data as { e2b_sandbox_id: string | null; status: string };
  if (row.status !== "active") return null;
  return row.e2b_sandbox_id;
}

export function sandboxTemplateForRun(agent_slug: string, payload: unknown): string | undefined {
  const backend = requireSiteBackend(payload);
  if (backend) return backend === "pooled" ? E2B_ZAVI_TEMPLATE_ALIAS : E2B_VITE_TEMPLATE_ALIAS;
  return agent_slug === "engineer" ? process.env.E2B_ENGINEER_TEMPLATE?.trim() || "praxis-xl" : undefined;
}

const SITE_REMOTE_RE = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

export function bestEffortStep(cmd: string): string {
  return `{ ( ${cmd}
) >/dev/null 2>&1 || true; }`;
}

export async function resetSiteRepo(sandbox_id: string, remoteUrl: string, sha: string, token?: string | null, opts: { before?: string } = {}): Promise<void> {
  const m = String(remoteUrl ?? "").match(SITE_REMOTE_RE);
  if (!m) throw new Error("resetSiteRepo: invalid site remote");
  const expectedSha = String(sha ?? "").trim().toLowerCase();
  if (!SHA_RE.test(expectedSha)) throw new Error("resetSiteRepo: invalid sha");
  const [, owner, repo] = m;
  const bare = `https://github.com/${owner}/${repo}.git`;
  const credential = token ? "$SITE_GIT_TOKEN" : "$GITHUB_TOKEN";
  const authed = `"https://x-access-token:${credential}@github.com/${owner}/${repo}.git"`;
  const cmd = [
    `trap 'cd ${SITE_REPO_DIR} 2>/dev/null && git remote set-url origin ${bare} >/dev/null 2>&1 || true' EXIT`,
    ...(opts.before ? [bestEffortStep(opts.before)] : []),
    `mkdir -p ${SITE_REPO_DIR}`,
    `cd ${SITE_REPO_DIR}`,
    `{ [ -d .git ] || git init -q; }`,
    `{ git remote get-url origin >/dev/null 2>&1 && git remote set-url origin ${authed} || git remote add origin ${authed}; }`,
    `git fetch -q origin main`,
    `git checkout -q -f -B main origin/main`,
    `git reset -q --hard origin/main`,
    `git clean -fdq`,
    `echo "__origin=$(git remote get-url origin | sed -E 's#https://[^@]*@#https://#')"`,
    `echo "__head=$(git rev-parse HEAD)"`,
  ].join(" && ");
  const r = token
    ? await execCommand(sandbox_id, cmd, 120_000, { env: { SITE_GIT_TOKEN: token }, redact: [token] })
    : await execCommand(sandbox_id, cmd, 120_000);
  if (r.exit_code !== 0) {
    throw new Error(`resetSiteRepo: git failed (exit ${r.exit_code}): ${(r.stderr ?? "").slice(0, 400)}`);
  }
  const origin = (r.stdout.match(/^__origin=(.*)$/m)?.[1] ?? "").trim();
  const head = (r.stdout.match(/^__head=([0-9a-f]+)$/m)?.[1] ?? "").trim().toLowerCase();
  if (origin.toLowerCase() !== bare.toLowerCase()) {
    throw new Error(`resetSiteRepo: origin mismatch (expected ${bare}, got ${origin || "<none>"})`);
  }
  if (!head || !head.startsWith(expectedSha)) {
    throw new Error(`resetSiteRepo: HEAD mismatch (expected ${expectedSha}, got ${head || "<none>"})`);
  }
}
