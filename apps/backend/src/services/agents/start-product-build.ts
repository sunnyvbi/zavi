
import type { SiteTemplate } from "@/services/sites/site-templates";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { buildProductGoalGraph } from "@/services/agents/product-pipeline";
import {
  assertBuildCreditsAvailable,
  makeBalanceReader,
} from "@/services/agents/build-credit-preflight";
import type { ResolveSummary } from "@/services/provisioning/resolve-resources";
import {
  validateCompanyName,
  type CompanyNameRejection,
} from "@/services/provisioning/tenant-slug";
import { resolveDailyCapUsd } from "@/services/agents/budget";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import type { ConductorNode } from "@/services/agents/conductor";
import type {
  BuildProductInput,
  ProvisionedTarget,
} from "@/services/agents/autopilot-pipeline-contract";
import type { FastBuildContext } from "@/services/sites/contract";
import { checkSiteBuildPrereqs, type SiteBuildPrereqs } from "@/services/sites/build-flow";
import { fastBuildEstimateUsd, startFastBuild as realStartFastBuild } from "@/services/agents/fast-build";
import { referenceImageUrls } from "@/services/agents/fast-build-prompt";
import { resolveSiteName } from "@/services/sites/site-name";
import { addSiteRepoToUmbrellaConnector } from "@/services/sites/register-site-repo";
import { siteIdFromGraph } from "@/services/sites/site-run";
import { SITE_SETUP_MARKER_KEY, siteSetupMarker, type SiteSetupMarker } from "@/services/agents/site-setup-marker";
import { stampConductorOwner } from "@/services/agents/conductor-owner";

export const DEFAULT_PRODUCT_BUILD_MAX_USD = 50;

export const MAX_PRODUCT_BUILD_MAX_USD = 50;

export const MAX_PRODUCT_BUILDS_PER_DAY = 10;

export const MAX_PRODUCT_REFINES_PER_DAY = 50;

export const PRODUCT_BUILD_PROVISION_ESTIMATE_USD = 3;

export class ProvisionBudgetExceeded extends Error {
  constructor(public readonly estimate_usd: number) {
    super(
      `provision rejected: the infra estimate ($${estimate_usd}) exceeds this tenant's remaining daily budget`,
    );
    this.name = "ProvisionBudgetExceeded";
  }
}

export class DoubleBuildInFlight extends Error {
  constructor(public readonly tenant_id: string) {
    super("a build is already in progress for this tenant");
    this.name = "DoubleBuildInFlight";
  }
}

export class TooManyBuildsToday extends Error {
  constructor(
    public readonly tenant_id: string,
    public readonly count: number,
    public readonly cap: number,
  ) {
    super(`daily build limit reached (${count}/${cap} builds today) — try again tomorrow`);
    this.name = "TooManyBuildsToday";
  }
}

export class InvalidCompanyName extends Error {
  constructor(public readonly reason: CompanyNameRejection) {
    super(InvalidCompanyName.messageFor(reason));
    this.name = "InvalidCompanyName";
  }
  static messageFor(reason: CompanyNameRejection): string {
    switch (reason) {
      case "empty":
        return "company_name is required";
      case "control_chars":
        return "company_name contains invalid control characters";
      case "path_traversal":
        return "company_name may not contain path separators or '..'";
      case "slug_empty":
        return "company_name must contain at least one letter or number";
      case "reserved":
        return "that company name is reserved — please choose a different name";
    }
  }
}

export const BUILD_REPO_NOT_PROVISIONED_COPY =
  "Couldn't set up your site's code project, so this build couldn't start. Start a new build in a few minutes. If it keeps happening, contact support.";

export class BuildRepoNotProvisioned extends Error {
  public readonly cause_detail: string;
  constructor(cause_detail: string) {
    super(BUILD_REPO_NOT_PROVISIONED_COPY);
    this.name = "BuildRepoNotProvisioned";
    this.cause_detail = sanitizeDetail(cause_detail);
  }
}

export const SITE_SETUP_UNAVAILABLE_COPY =
  "We couldn't set up your new site just now, so this build didn't start and none of your other sites were changed. Try again in a few minutes.";

export class SiteSetupUnavailable extends BuildRepoNotProvisioned {
  public readonly retryable: boolean;
  public readonly site_id: string | null;
  public conductor_run_id: string | null = null;
  constructor(
    public readonly reason: string,
    opts: { retryable?: boolean; site_id?: string | null; detail?: string | null } = {},
  ) {
    super(opts.detail ? `${reason}: ${opts.detail}` : reason);
    this.message = SITE_SETUP_UNAVAILABLE_COPY;
    this.name = "SiteSetupUnavailable";
    this.retryable = opts.retryable !== false;
    this.site_id = opts.site_id ?? null;
  }
}

export const SITE_BACKEND_UNAVAILABLE_CODE = "SITE_BACKEND_UNAVAILABLE";

export class SiteBackendUnavailable extends SiteSetupUnavailable {
  public readonly code = SITE_BACKEND_UNAVAILABLE_CODE;
  constructor(public readonly missing: string[]) {
    super(`build prerequisites missing: ${missing.join(", ")}`, { retryable: true });
    this.name = "SiteBackendUnavailable";
  }
}

export function buildSetupFailedBody(e: BuildRepoNotProvisioned): {
  code: "build_setup_failed";
  message: string;
  retryable: boolean;
  reason_code?: typeof SITE_BACKEND_UNAVAILABLE_CODE;
  run_id?: string;
} {
  const retryable = e instanceof SiteSetupUnavailable ? e.retryable : true;
  const run_id = e instanceof SiteSetupUnavailable && retryable ? e.conductor_run_id : null;
  return {
    code: "build_setup_failed",
    message: e.message,
    retryable,
    ...(e instanceof SiteBackendUnavailable ? { reason_code: e.code } : {}),
    ...(run_id ? { run_id } : {}),
  };
}

function sanitizeDetail(detail: string): string {
  return detail
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\bbearer\s+\S+/gi, "<redacted>")
    .replace(/\b(?:key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "<redacted>")
    .slice(0, 500);
}

export type StartProductBuildInput = {
  tenant_id: string;
  company_name: string;
  idea: string;
  reference_images?: string[];
  max_usd?: number | null;
  started_by_user_id?: string | null;
  site_name?: string | null;
  onRunCreated?: (conductor_run_id: string) => Promise<void>;
  await_look_pick?: boolean;
  site_template?: SiteTemplate | null;
};

export type StartProductBuildResult = {
  conductor_run_id: string;
  provision: ResolveSummary;
  target: ProvisionedTarget;
  first_build_free?: boolean;
};

export type FastBuildTiming = { brief_ms: number | null; repo_ms: number | null; seed_ms: number | null };

export type FastBuildOutcome =
  | { kind: "started"; result: StartProductBuildResult; timing?: FastBuildTiming }
  | { kind: "setup_failed"; reason: string; retryable: boolean;  site_id?: string; detail?: string };

export type SiteSetupRetryClaim = "resumed" | "not_found" | "not_resumable" | "changed_concurrently" | "another_build_running" | "site_gone";

export type StartProductBuildDeps = {
  tryAcquireBuildSlot: (params: {
    tenant_id: string;
    objective: string;
    max_usd: number;
    provision_estimate: number;
    max_per_day: number;
    daily_cap_usd: number;
  }) => Promise<string>;
  updateConductorRunStatus: (params: {
    conductor_run_id: string;
    status: "active" | "failed";
    goal_graph?: ConductorNode[];
    failure_class?: string;
    failure_reason?: string;
    objective?: string;
  }) => Promise<void>;
  cancelConductorRun?: (tenant_id: string, conductor_run_id: string) => Promise<void>;
  resolveDailyCap: (tenant_id: string) => Promise<number>;
  assertBuildCredits: (tenant_id: string) => Promise<void>;
  isFirstBuildFree?: (tenant_id: string) => Promise<boolean>;
  claimFirstFreeBuild?: (tenant_id: string, conductor_run_id: string) => Promise<boolean>;
  checkSitePrereqs: () => Promise<SiteBuildPrereqs>;
  startFastBuild: (ctx: FastBuildContext) => Promise<FastBuildOutcome>;
  resolveOwnerEmail?: (tenant_id: string, started_by_user_id: string | null) => Promise<string | null>;
  resolveWorkspaceName?: (tenant_id: string) => Promise<string | null>;
  resolveSiteName?: (input: {
    tenant_id: string;
    idea: string;
    company_name: string;
    workspace_name: string | null;
    site_name: string | null;
  }) => Promise<string | null>;
  claimSiteSetupRetry?: (params: {
    tenant_id: string;
    conductor_run_id: string;
    expected_updated_at: string;
    site_id: string | null;
  }) => Promise<SiteSetupRetryClaim>;
};

async function verifiedMemberEmail(tenant_id: string, user_id: string): Promise<string | null> {
  const sb = serviceClient();
  const { data: member, error: mErr } = await sb
    .from("tenant_users")
    .select("user_id")
    .eq("tenant_id", tenant_id)
    .eq("user_id", user_id)
    .maybeSingle();
  if (mErr) throw new Error(`tenant_users read failed: ${mErr.message}`);
  if (!member) return null;
  const { data, error } = await sb.auth.admin.getUserById(user_id);
  if (error) throw new Error(`auth user read failed: ${error.message}`);
  const u = data?.user;
  const email = typeof u?.email === "string" ? u.email.trim().toLowerCase() : "";
  return email && u?.email_confirmed_at ? email : null;
}

export async function realResolveWorkspaceName(tenant_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("tenants").select("display_name").maybeSingle();
  if (error) throw new Error(`tenants display_name read failed: ${error.message}`);
  const name = (data as { display_name?: unknown } | null)?.display_name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

export async function realResolveOwnerEmail(tenant_id: string, started_by_user_id: string | null): Promise<string | null> {
  if (started_by_user_id) {
    const mine = await verifiedMemberEmail(tenant_id, started_by_user_id);
    if (mine) return mine;
  }
  const { data, error } = await serviceClient()
    .from("tenant_users")
    .select("user_id")
    .eq("tenant_id", tenant_id)
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`tenant owner read failed: ${error.message}`);
  const owner = (data as { user_id?: string } | null)?.user_id;
  return owner ? verifiedMemberEmail(tenant_id, owner) : null;
}

async function realTryAcquireBuildSlot(params: {
  tenant_id: string;
  objective: string;
  max_usd: number;
  provision_estimate: number;
  max_per_day: number;
  daily_cap_usd: number;
}): Promise<string> {
  const { data, error } = await serviceClient().rpc("try_acquire_build_slot", {
    p_tenant_id: params.tenant_id,
    p_objective: params.objective,
    p_max_usd: params.max_usd,
    p_provision_estimate: params.provision_estimate,
    p_max_per_day: params.max_per_day,
    p_daily_cap_usd: params.daily_cap_usd,
  });
  if (error) {
    const msg = error.message || "";
    if (msg.includes("double_build")) throw new DoubleBuildInFlight(params.tenant_id);
    if (msg.includes("daily_limit")) {
      throw new TooManyBuildsToday(params.tenant_id, params.max_per_day, params.max_per_day);
    }
    if (msg.includes("over_cap")) throw new ProvisionBudgetExceeded(params.provision_estimate);
    throw new Error(`try_acquire_build_slot failed: ${error.message}`);
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("try_acquire_build_slot returned no id");
  }
  return data;
}

async function realUpdateConductorRunStatus(params: {
  conductor_run_id: string;
  status: "active" | "failed";
  goal_graph?: ConductorNode[];
  failure_class?: string;
  failure_reason?: string;
  objective?: string;
}): Promise<void> {
  const patch: Record<string, unknown> = { status: params.status, updated_at: new Date().toISOString() };
  if (params.goal_graph !== undefined) patch.goal_graph = params.status === "active" ? stampConductorOwner(params.goal_graph) : params.goal_graph;
  if (params.objective !== undefined && params.objective.trim()) patch.objective = params.objective.trim().slice(0, 500);
  if (params.failure_class !== undefined) patch.failure_class = params.failure_class;
  if (params.failure_reason !== undefined) {
    patch.failure_reason = params.failure_reason.trim().slice(0, 4000) || "Provisioning failed.";
  }
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .update(patch)
    .eq("id", params.conductor_run_id)
    .eq("status", "provisioning")
    .select("id");
  if (error) throw new Error(`conductor_runs update failed: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) {
    if (params.status === "active") throw new RunNoLongerProvisioning(params.conductor_run_id);
    console.warn(`[start-product-build] run=${params.conductor_run_id} already ended; its ${params.status} write was skipped`);
  }
}

export class RunNoLongerProvisioning extends Error {
  constructor(public readonly conductor_run_id: string) {
    super("The build was stopped while its site was being set up.");
    this.name = "RunNoLongerProvisioning";
  }
}

async function realCancelConductorRun(tenant_id: string, conductor_run_id: string): Promise<void> {
  const { error } = await serviceClient().rpc("cancel_conductor_run", {
    p_tenant_id: tenant_id,
    p_conductor_run_id: conductor_run_id,
    p_reason: "provision_failed",
    p_require_updated_before: null,
  });
  if (error) throw new Error(`cancel_conductor_run failed: ${error.message}`);
}

const RETRY_CLAIMS: ReadonlySet<string> = new Set<SiteSetupRetryClaim>([
  "resumed",
  "not_found",
  "not_resumable",
  "changed_concurrently",
  "another_build_running",
  "site_gone",
]);

async function realClaimSiteSetupRetry(params: {
  tenant_id: string;
  conductor_run_id: string;
  expected_updated_at: string;
  site_id: string | null;
}): Promise<SiteSetupRetryClaim> {
  const { data, error } = await tenantRpc(asTenantId(params.tenant_id), "claim_site_setup_retry", {
    p_run_id: params.conductor_run_id,
    p_expected_updated_at: params.expected_updated_at,
    p_site_id: params.site_id,
  });
  if (error) throw new Error(`claim_site_setup_retry failed: ${error.message}`);
  if (typeof data !== "string" || !RETRY_CLAIMS.has(data)) throw new Error(`claim_site_setup_retry returned ${String(data)}`);
  return data as SiteSetupRetryClaim;
}

export const realStartProductBuildDeps: StartProductBuildDeps = {
  tryAcquireBuildSlot: realTryAcquireBuildSlot,
  updateConductorRunStatus: realUpdateConductorRunStatus,
  cancelConductorRun: realCancelConductorRun,
  resolveDailyCap: (tenant_id) => resolveDailyCapUsd(tenant_id),
  checkSitePrereqs: () => checkSiteBuildPrereqs(),
  startFastBuild: (ctx) =>
    realStartFastBuild(ctx, {
      updateConductorRunStatus: realUpdateConductorRunStatus,
      ensureGithubConnector: (tenant_id, repo_full_name, default_branch) =>
        ensureProvisionedGithubConnector(tenant_id, repo_full_name, default_branch, { siteRepo: true }),
      autoSiteOwner: (tenant_id) => getBoolSetting("build_auto_site_owner", tenant_id),
      requestTick: async (conductor_run_id) => {
        const [{ inngest }, { requestConductorTick }] = await Promise.all([
          import("@/../workers/client"),
          import("@/services/agents/conductor-kick"),
        ]);
        return requestConductorTick(inngest, conductor_run_id);
      },
    }),
  resolveOwnerEmail: realResolveOwnerEmail,
  resolveWorkspaceName: realResolveWorkspaceName,
  resolveSiteName: async ({ tenant_id, idea, company_name, workspace_name, site_name }) => {
    if (!(await getBoolSetting("build_site_own_name", tenant_id).catch(() => true))) return null;
    return resolveSiteName(
      { idea, company_name, workspace_name, site_name },
      {
        extract: async (text) => {
          const { extractIdeaIntake } = await import("@/services/onboarding/idea-intake");
          return (await extractIdeaIntake(text)).company_name;
        },
      },
    );
  },
  assertBuildCredits: (tenant_id) =>
    assertBuildCreditsAvailable(tenant_id, {
      readBalance: makeBalanceReader(serviceClient() as never),
    }),
  isFirstBuildFree: async (tenant_id) => {
    const { data, error } = await serviceClient().rpc("first_build_free_eligible", {
      p_tenant_id: tenant_id,
    });
    if (error) throw new Error(`first_build_free_eligible failed: ${error.message}`);
    return data === true;
  },
  claimFirstFreeBuild: async (tenant_id, conductor_run_id) => {
    const { data, error } = await serviceClient().rpc("claim_first_free_build", {
      p_tenant_id: tenant_id,
      p_conductor_run_id: conductor_run_id,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.warn(`[start-product-build] claim_first_free_build failed for tenant=${tenant_id}: ${error.message}`);
      return false;
    }
    return data === true;
  },
  claimSiteSetupRetry: realClaimSiteSetupRetry,
};

export async function ensureProvisionedGithubConnector(
  tenant_id: string,
  repo_full_name: string,
  default_branch: string,
  opts: { siteRepo?: boolean } = {},
): Promise<void> {
  const sb = serviceClient();
  const { data: existing, error: readErr } = await sb
    .from("connector_metadata")
    .select("slug, account_login, repo_full_names, default_repo_full_name")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (readErr) throw new Error(`connector_metadata read failed: ${readErr.message}`);
  if (existing) {
    const row = existing as {
      account_login?: string | null;
      repo_full_names?: string[] | null;
      default_repo_full_name?: string | null;
    };
    if (row.account_login !== "Praxis-build") return;
    if (opts.siteRepo && (await getBoolSetting("build_site_keeps_own_repo", tenant_id).catch(() => true))) {
      await addSiteRepoToUmbrellaConnector(sb, tenant_id, repo_full_name, default_branch);
      return;
    }
    const names = row.repo_full_names ?? [];
    if (row.default_repo_full_name === repo_full_name && names.length === 1 && names[0] === repo_full_name) return;
    if (!(await getBoolSetting("build_repo_follows_app", tenant_id).catch(() => false))) return;
    const { error: updateErr } = await sb
      .from("connector_metadata")
      .update({
        repo_full_names: [repo_full_name],
        default_repo_full_name: repo_full_name,
        repo_default_branches: { [repo_full_name]: default_branch },
      })
      .eq("tenant_id", tenant_id)
      .eq("slug", "github")
      .eq("account_login", "Praxis-build");
    if (updateErr) throw new Error(`connector_metadata update failed: ${updateErr.message}`);
    return;
  }
  const { error: writeErr } = await sb.from("connector_metadata").upsert(
    {
      tenant_id,
      slug: "github",
      repo_full_names: [repo_full_name],
      default_repo_full_name: repo_full_name,
      repo_default_branches: { [repo_full_name]: default_branch },
      account_login: "Praxis-build",
      account_type: "Organization",
      scopes: [],
      scopes_version: 1,
      connected_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,slug" },
  );
  if (writeErr) throw new Error(`connector_metadata upsert failed: ${writeErr.message}`);
}

function setupMaxUsd(setup: SiteSetupMarker): number {
  return Math.min(setup.max_usd ?? DEFAULT_PRODUCT_BUILD_MAX_USD, MAX_PRODUCT_BUILD_MAX_USD);
}

function lookUpOwnerEmail(deps: StartProductBuildDeps, tenant_id: string, started_by_user_id: string | null): Promise<string | null> {
  if (!deps.resolveOwnerEmail) return Promise.resolve(null);
  const resolve = deps.resolveOwnerEmail;
  return Promise.resolve()
    .then(() => resolve(tenant_id, started_by_user_id))
    .catch((err: unknown) => {
      console.warn(`[start-product-build] owner email lookup failed for tenant=${tenant_id}: ${(err as Error).message ?? err}`);
      return null;
    });
}

type SetupClock = { started_at: number; slot_ms: number | null; intake_ms: number | null };

function ms(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? String(Math.max(0, Math.round(v))) : "na";
}

function logSetupTiming(tenant_id: string, r: Extract<FastBuildOutcome, { kind: "started" }>, clock: SetupClock): void {
  const site = r.result.provision.context?.site_id ?? "none";
  const t = r.timing;
  console.info(
    `[fast-build] timing tenant=${tenant_id} site=${site} slot_ms=${ms(clock.slot_ms)} intake_ms=${ms(clock.intake_ms)} brief_ms=${ms(t?.brief_ms)} repo_ms=${ms(t?.repo_ms)} seed_ms=${ms(t?.seed_ms)} total_ms=${ms(Date.now() - clock.started_at)}`,
  );
}

async function setUpSite(
  tenant_id: string,
  conductor_run_id: string,
  setup: SiteSetupMarker,
  deps: StartProductBuildDeps,
  pre: { ownerEmail?: Promise<string | null>; clock?: SetupClock } = {},
): Promise<StartProductBuildResult> {
  const clock = pre.clock ?? { started_at: Date.now(), slot_ms: null, intake_ms: null };
  const owner_email = await (pre.ownerEmail ?? lookUpOwnerEmail(deps, tenant_id, setup.started_by_user_id));
  const r = await deps.startFastBuild({
    tenant_id,
    conductor_run_id,
    company_name: setup.company_name,
    workspace_name: setup.workspace_name,
    ...(setup.site_name ? { site_name: setup.site_name } : {}),
    idea: setup.idea,
    max_usd: setupMaxUsd(setup),
    started_by_user_id: setup.started_by_user_id,
    owner_email,
    first_build_free: setup.first_build_free,
    ...(setup.first_site ? { first_site: true } : {}),
    reference_images: setup.reference_images,
    ...(setup.await_look_pick === true ? { await_look_pick: true } : {}),
    ...(setup.site_template ? { site_template: setup.site_template } : {}),
  });
  if (r.kind === "started") {
    logSetupTiming(tenant_id, r, clock);
    return r.result;
  }
  console.warn(
    `[start-product-build] site setup failed for tenant=${tenant_id} run=${conductor_run_id} site=${r.site_id ?? "none"} retryable=${r.retryable}: ${r.reason}`,
  );
  throw new SiteSetupUnavailable(r.reason, { retryable: r.retryable, site_id: r.site_id ?? null, detail: r.detail ?? null });
}

async function recordSetupFailure(params: {
  tenant_id: string;
  conductor_run_id: string;
  setup: SiteSetupMarker | null;
  buildInput: BuildProductInput;
  provisionStartedAt: string;
  error: unknown;
  deps: StartProductBuildDeps;
}): Promise<void> {
  const { tenant_id, conductor_run_id, setup, error, deps } = params;
  const siteFailure = error instanceof SiteSetupUnavailable ? error : null;
  const site_id = siteFailure?.site_id ?? null;
  const title = setup?.site_name ?? null;
  try {
    const goal_graph = buildProductGoalGraph(title ? { ...params.buildInput, company_name: title } : params.buildInput);
    const provisionNode = goal_graph.find((node) => node.payload?.stage === "provision");
    const message = (error instanceof Error ? error.message : String(error)).trim();
    const reason = (siteFailure ? `${message}\n${siteFailure.cause_detail}` : message).slice(0, 4000) || "Provisioning failed.";
    if (provisionNode) {
      provisionNode.status = "failed";
      provisionNode.started_at = params.provisionStartedAt;
      provisionNode.finished_at = new Date().toISOString();
      provisionNode.error = reason;
      provisionNode.last_failure_signal = reason;
      provisionNode.failure_class = "stage_failed";
      provisionNode.payload = {
        ...provisionNode.payload,
        ...(site_id ? { site_id } : {}),
        ...(setup ? { [SITE_SETUP_MARKER_KEY]: { ...setup, retryable: siteFailure?.retryable === true } } : {}),
      };
    }
    await deps.updateConductorRunStatus({
      conductor_run_id,
      status: "failed",
      goal_graph,
      failure_class: "provision_failed",
      failure_reason: reason,
      ...(title ? { objective: `Build product: ${title} — ${params.buildInput.idea}`.slice(0, 500) } : {}),
    });
  } catch (releaseErr) {
    console.warn(
      `[start-product-build] slot-release UPDATE failed for run=${conductor_run_id} tenant=${tenant_id}: ${(releaseErr as Error).message}`,
    );
    try {
      await deps.cancelConductorRun?.(tenant_id, conductor_run_id);
    } catch (cancelErr) {
      console.warn(
        `[start-product-build] slot-release RPC failed for run=${conductor_run_id} tenant=${tenant_id}: ${(cancelErr as Error).message}`,
      );
    }
  }
}

type BegunProductBuild = {
  conductor_run_id: string;
  finishSetup: () => Promise<StartProductBuildResult>;
};

export async function startProductBuild(
  input: StartProductBuildInput,
  deps: StartProductBuildDeps = realStartProductBuildDeps,
): Promise<StartProductBuildResult> {
  const begun = await beginProductBuild(input, deps);
  return begun.finishSetup();
}

export async function startProductBuildDetached(
  input: StartProductBuildInput,
  deps: StartProductBuildDeps = realStartProductBuildDeps,
): Promise<{ conductor_run_id: string; setup: Promise<StartProductBuildResult> }> {
  const begun = await beginProductBuild(input, deps);
  return { conductor_run_id: begun.conductor_run_id, setup: begun.finishSetup() };
}

async function beginProductBuild(
  input: StartProductBuildInput,
  deps: StartProductBuildDeps,
): Promise<BegunProductBuild> {
  const tenant_id = (input.tenant_id ?? "").trim();
  const company_name = (input.company_name ?? "").trim();
  const idea = (input.idea ?? "").trim();
  if (!tenant_id) throw new Error("startProductBuild: tenant_id is required");
  if (!company_name) throw new Error("startProductBuild: company_name is required");
  if (!idea) throw new Error("startProductBuild: idea is required");

  const rejection = validateCompanyName(input.company_name ?? "");
  if (rejection) throw new InvalidCompanyName(rejection);
  const startedAt = Date.now();
  const started_by_user_id = (input.started_by_user_id ?? "").trim() || null;
  const readWorkspaceName = deps.resolveWorkspaceName;
  const workspaceNameP: Promise<string | null> = readWorkspaceName
    ? Promise.resolve()
        .then(() => readWorkspaceName(tenant_id))
        .catch(() => null)
    : Promise.resolve(null);
  const ownerEmailP = lookUpOwnerEmail(deps, tenant_id, started_by_user_id);

  const prereqCheck = Promise.resolve()
    .then(() => deps.checkSitePrereqs())
    .catch((): SiteBuildPrereqs => ({ ok: false, missing: ["prerequisite check failed"] }));
  const creditCheck = (async (): Promise<boolean> => {
    const free = deps.isFirstBuildFree
      ? await deps.isFirstBuildFree(tenant_id).catch(() => true)
      : false;
    if (!free) await deps.assertBuildCredits(tenant_id);
    return free;
  })();
  const dailyCapCheck = Promise.resolve().then(() => deps.resolveDailyCap(tenant_id));
  const [prereqOutcome, creditOutcome, dailyCapOutcome] = await Promise.allSettled([
    prereqCheck,
    creditCheck,
    dailyCapCheck,
  ]);
  const prereqs = prereqOutcome.status === "fulfilled" ? prereqOutcome.value : { ok: false as const, missing: ["prerequisite check failed"] };
  if (!prereqs.ok) {
    console.warn(`[start-product-build] build refused for tenant=${tenant_id}: ${SITE_BACKEND_UNAVAILABLE_CODE} missing ${prereqs.missing.join(", ")}`);
    throw new SiteBackendUnavailable(prereqs.missing);
  }
  if (creditOutcome.status === "rejected") throw creditOutcome.reason;
  if (dailyCapOutcome.status === "rejected") throw dailyCapOutcome.reason;
  const firstBuildFree = creditOutcome.value;
  const daily_cap_usd = dailyCapOutcome.value;

  const candidate =
    typeof input.max_usd === "number" && Number.isFinite(input.max_usd) && input.max_usd >= 0
      ? input.max_usd
      : DEFAULT_PRODUCT_BUILD_MAX_USD;
  const max_usd = Math.min(candidate, MAX_PRODUCT_BUILD_MAX_USD);

  const objective = `Build product: ${company_name} — ${idea}`.slice(0, 500);
  let intake_ms: number | null = null;
  const siteNameP: Promise<string | null> = workspaceNameP.then(async (workspace_name) => {
    if (!deps.resolveSiteName) return null;
    const intakeStartedAt = Date.now();
    const name = await deps
      .resolveSiteName({ tenant_id, idea, company_name, workspace_name, site_name: (input.site_name ?? "").trim() || null })
      .catch(() => null);
    intake_ms = Date.now() - intakeStartedAt;
    return name;
  }).catch(() => null);
  const conductor_run_id = await deps.tryAcquireBuildSlot({
    tenant_id,
    objective,
    max_usd,
    provision_estimate: fastBuildEstimateUsd(),
    max_per_day: MAX_PRODUCT_BUILDS_PER_DAY,
    daily_cap_usd,
  });
  const slot_ms = Date.now() - startedAt;
  const reference_images = referenceImageUrls(input.reference_images);
  const buildInput: BuildProductInput = {
    tenant_id,
    company_name,
    idea,
    max_usd,
    ...(reference_images.length ? { reference_images } : {}),
  };
  const provisionStartedAt = new Date().toISOString();

  let first_build_free = false;
  let first_site = false;
  try {
    if (input.onRunCreated) await input.onRunCreated(conductor_run_id);
    if (firstBuildFree) {
      const claim = deps.claimFirstFreeBuild
        ? await deps.claimFirstFreeBuild(tenant_id, conductor_run_id).catch(() => null)
        : false;
      first_build_free = claim === true;
      first_site = claim !== false;
      if (!first_build_free) await deps.assertBuildCredits(tenant_id);
    }
  } catch (e) {
    await recordSetupFailure({ tenant_id, conductor_run_id, setup: null, buildInput, provisionStartedAt, error: e, deps });
    if (e instanceof SiteSetupUnavailable) e.conductor_run_id = conductor_run_id;
    throw e;
  }

  const finishSetup = async (): Promise<StartProductBuildResult> => {
    let setup: SiteSetupMarker | null = null;
    try {
      const workspace_name = await workspaceNameP;
      const site_name = await siteNameP;
      setup = {
        v: 1,
        retryable: true,
        company_name,
        idea,
        max_usd,
        site_name,
        workspace_name,
        started_by_user_id,
        first_build_free,
        ...(first_site ? { first_site: true } : {}),
        reference_images,
        ...(input.await_look_pick === true ? { await_look_pick: true } : {}),
        ...(input.site_template ? { site_template: { ...input.site_template } as unknown as Record<string, unknown> } : {}),
      };
      return await setUpSite(tenant_id, conductor_run_id, setup, deps, {
        ownerEmail: ownerEmailP,
        clock: { started_at: startedAt, slot_ms, intake_ms },
      });
    } catch (e) {
      await recordSetupFailure({ tenant_id, conductor_run_id, setup, buildInput, provisionStartedAt, error: e, deps });
      if (e instanceof SiteSetupUnavailable) e.conductor_run_id = conductor_run_id;
      throw e;
    }
  };

  return { conductor_run_id, finishSetup };
}

export type RetrySiteSetupResult =
  | { ok: true; run_id: string }
  | {
      ok: false;
      code: "not_found" | "not_resumable" | "changed_concurrently" | "another_build_running" | "site_setup_failed";
      message: string;
      retryable?: boolean;
      reason_code?: string;
    };

export const SITE_SETUP_RETRY_GONE_COPY =
  "This build's site was cleaned up after it failed, so it can't be retried. Start a new build.";

export async function retrySiteSetup(
  tenant_id: string,
  row: { id: string; updated_at: string; goal_graph: unknown },
  deps: StartProductBuildDeps = realStartProductBuildDeps,
): Promise<RetrySiteSetupResult> {
  const setup = siteSetupMarker(row.goal_graph);
  if (!setup?.retryable) {
    return { ok: false, code: "not_resumable", message: "This build can't be retried from where it stopped. Start a new build." };
  }
  if (!deps.claimSiteSetupRetry) throw new Error("retrySiteSetup: claimSiteSetupRetry is not wired");
  const prereqs = await Promise.resolve()
    .then(() => deps.checkSitePrereqs())
    .catch((): SiteBuildPrereqs => ({ ok: false, missing: ["prerequisite check failed"] }));
  if (!prereqs.ok) {
    console.warn(`[start-product-build] retry refused for tenant=${tenant_id} run=${row.id}: ${SITE_BACKEND_UNAVAILABLE_CODE} missing ${prereqs.missing.join(", ")}`);
    return { ok: false, code: "site_setup_failed", message: SITE_SETUP_UNAVAILABLE_COPY, retryable: true, reason_code: SITE_BACKEND_UNAVAILABLE_CODE };
  }
  const claim = await deps.claimSiteSetupRetry({
    tenant_id,
    conductor_run_id: row.id,
    expected_updated_at: row.updated_at,
    site_id: siteIdFromGraph(row.goal_graph),
  });
  if (claim === "another_build_running") {
    return { ok: false, code: "another_build_running", message: "Another build is running. Wait for it to finish, then try again." };
  }
  if (claim === "changed_concurrently") {
    return { ok: false, code: "changed_concurrently", message: "This build changed while retrying. Refresh and try again." };
  }
  if (claim === "not_found") return { ok: false, code: "not_found", message: "Build not found." };
  if (claim === "site_gone") return { ok: false, code: "not_resumable", message: SITE_SETUP_RETRY_GONE_COPY };
  if (claim !== "resumed") {
    return { ok: false, code: "not_resumable", message: "This build can't be retried from where it stopped. Start a new build." };
  }

  const provisionStartedAt = new Date().toISOString();
  const buildInput: BuildProductInput = {
    tenant_id,
    company_name: setup.company_name,
    idea: setup.idea,
    max_usd: setupMaxUsd(setup),
    ...(setup.reference_images.length ? { reference_images: setup.reference_images } : {}),
  };
  try {
    await setUpSite(tenant_id, row.id, setup, deps);
    return { ok: true, run_id: row.id };
  } catch (e) {
    await recordSetupFailure({ tenant_id, conductor_run_id: row.id, setup, buildInput, provisionStartedAt, error: e, deps });
    if (e instanceof SiteSetupUnavailable) return { ok: false, code: "site_setup_failed", message: e.message, retryable: e.retryable };
    throw e;
  }
}
