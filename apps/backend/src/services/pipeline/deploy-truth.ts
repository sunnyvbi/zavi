
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";

const RENDER = "https://api.render.com";

const PROBE_TIMEOUT_MS = 5000;

export const MAX_DEPLOY_ATTEMPTS = 15;

const LIVE_STATUSES = new Set<string>(["live"]);
const FAILED_STATUSES = new Set<string>([
  "build_failed",
  "update_failed",
  "pre_deploy_failed",
  "canceled",
  "deactivated",
]);

export type RenderDeploy = { status: string; commit_sha: string | null };

export function shaMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = (a ?? "").trim().toLowerCase();
  const nb = (b ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(na) || !/^[0-9a-f]{7,40}$/.test(nb)) return false;
  return na.startsWith(nb) || nb.startsWith(na);
}

export type TruthDecision =
  | { kind: "healthy"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "wait"; reason: string };

export function decideDeployTruth(args: {
  deploy: RenderDeploy | null;
  mergedSha: string;
  healthOk: boolean;
}): TruthDecision {
  const { deploy, mergedSha, healthOk } = args;
  if (!deploy) return { kind: "wait", reason: "no render deploy observed yet" };

  const matched = shaMatches(deploy.commit_sha, mergedSha);

  if (FAILED_STATUSES.has(deploy.status)) {
    if (matched) {
      return { kind: "failed", reason: `render build failed for the merged commit (${deploy.status})` };
    }
    return { kind: "wait", reason: "an earlier deploy failed; still watching for the merged commit" };
  }

  if (LIVE_STATUSES.has(deploy.status)) {
    if (!matched) {
      return { kind: "wait", reason: "render is still serving a different commit" };
    }
    if (healthOk) {
      return { kind: "healthy", reason: "merged SHA is the served SHA and the app health-probed 2xx" };
    }
    return { kind: "wait", reason: "merged SHA is live on render but the app is not serving 2xx yet" };
  }

  return { kind: "wait", reason: "render deploy still in progress" };
}

export type DeployWatchRow = {
  id: number;
  tenant_id: string;
  pr_url: string;
  merged_sha: string;
  render_service_id: string | null;
  attempt_count: number;
};

export type DeployTruthPollDeps = {
  loadWatching: () => Promise<DeployWatchRow[]>;
  fetchLatestDeploy: (serviceId: string) => Promise<RenderDeploy | null>;
  fetchServiceUrl: (serviceId: string) => Promise<string | null>;
  probeHealth: (url: string) => Promise<boolean>;
  setState: (
    id: number,
    state: "deploy_healthy" | "deploy_failed",
    served_sha: string | null,
    health_url: string | null,
    reason: string,
  ) => Promise<boolean>;
  bumpAttempt: (id: number, served_sha: string | null, reason: string) => Promise<void>;
};

export type DeployTruthResult = {
  checked: number;
  healthy: number;
  failed: number;
  watching: number;
  errored: number;
};

export async function reconcileDeployRow(
  deps: DeployTruthPollDeps,
  row: DeployWatchRow,
  serviceId: string,
): Promise<"healthy" | "failed" | "watching"> {
  const deploy = await deps.fetchLatestDeploy(serviceId);
  const served_sha = deploy?.commit_sha ?? null;

  let healthOk = false;
  let health_url: string | null = null;
  if (deploy && LIVE_STATUSES.has(deploy.status) && shaMatches(deploy.commit_sha, row.merged_sha)) {
    health_url = await deps.fetchServiceUrl(serviceId);
    healthOk = health_url ? await deps.probeHealth(health_url) : false;
  }

  const decision = decideDeployTruth({ deploy, mergedSha: row.merged_sha, healthOk });

  if (decision.kind === "healthy") {
    await deps.setState(row.id, "deploy_healthy", served_sha, health_url, decision.reason);
    return "healthy";
  }
  if (decision.kind === "failed") {
    await deps.setState(row.id, "deploy_failed", served_sha, health_url, decision.reason);
    return "failed";
  }

  const attempts = row.attempt_count + 1;
  if (attempts >= MAX_DEPLOY_ATTEMPTS) {
    await deps.setState(
      row.id,
      "deploy_failed",
      served_sha,
      health_url,
      `deploy window elapsed without a healthy match: ${decision.reason}`,
    );
    return "failed";
  }
  await deps.bumpAttempt(row.id, served_sha, decision.reason);
  return "watching";
}

export async function pollDeployTruth(deps: DeployTruthPollDeps): Promise<DeployTruthResult> {
  const rows = await deps.loadWatching();
  const result: DeployTruthResult = { checked: 0, healthy: 0, failed: 0, watching: 0, errored: 0 };
  for (const row of rows) {
    const serviceId = (row.render_service_id ?? "").trim();
    if (!serviceId) continue;
    result.checked++;
    try {
      const outcome = await reconcileDeployRow(deps, row, serviceId);
      if (outcome === "healthy") result.healthy++;
      else if (outcome === "failed") result.failed++;
      else result.watching++;
    } catch {
      result.errored++;
    }
  }
  return result;
}

export type EnqueueDeployTruthDeps = {
  resolveProvisionedRepoTenant: (githubFullName: string) => Promise<string | null>;
  resolveHostingServiceId: (tenant_id: string) => Promise<string | null>;
  deployTruthEnabled: () => Promise<boolean>;
  upsertWatch: (args: {
    tenant_id: string;
    pr_url: string;
    github_full_name: string;
    merged_sha: string;
    render_service_id: string;
    merged_at: string;
  }) => Promise<number | null>;
};

export type EnqueueDeployTruthResult = {
  enqueued: boolean;
  reason:
    | "watching"
    | "no_merge_commit_sha"
    | "no_repo"
    | "not_a_provisioned_app"
    | "kill_switch_off"
    | "no_hosting_service";
  deploy_id?: number;
};

export async function enqueueDeployTruthWatch(args: {
  repoFullName: string;
  prUrl: string;
  mergeCommitSha: string | null;
  mergedAt: string;
  deps: EnqueueDeployTruthDeps;
}): Promise<EnqueueDeployTruthResult> {
  const { repoFullName, prUrl, mergeCommitSha, mergedAt, deps } = args;

  const merged_sha = (mergeCommitSha ?? "").trim();
  if (!merged_sha) return { enqueued: false, reason: "no_merge_commit_sha" };
  const full = (repoFullName ?? "").trim();
  if (!full || !prUrl) return { enqueued: false, reason: "no_repo" };

  const tenant_id = await deps.resolveProvisionedRepoTenant(full);
  if (!tenant_id) return { enqueued: false, reason: "not_a_provisioned_app" };

  if (!(await deps.deployTruthEnabled())) return { enqueued: false, reason: "kill_switch_off" };

  const render_service_id = await deps.resolveHostingServiceId(tenant_id);
  if (!render_service_id) return { enqueued: false, reason: "no_hosting_service" };

  const deploy_id = await deps.upsertWatch({
    tenant_id,
    pr_url: prUrl,
    github_full_name: full,
    merged_sha,
    render_service_id,
    merged_at: mergedAt,
  });
  return { enqueued: true, reason: "watching", deploy_id: deploy_id ?? undefined };
}

async function realFetchLatestDeploy(serviceId: string, token: string): Promise<RenderDeploy | null> {
  const res = await fetch(`${RENDER}/v1/services/${serviceId}/deploys?limit=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (res.status !== 200) {
    throw new Error(`render deploys list failed (${res.status})`);
  }
  const arr = (await res.json()) as Array<
    { deploy?: { status?: string; commit?: { id?: string } } } | { status?: string; commit?: { id?: string } }
  >;
  const first = arr?.[0];
  if (!first) return null;
  const d = "deploy" in first ? first.deploy : (first as { status?: string; commit?: { id?: string } });
  const status = d?.status ?? "";
  const commit_sha = d?.commit?.id ?? null;
  if (!status) return null;
  return { status, commit_sha };
}

async function realFetchServiceUrl(serviceId: string, token: string): Promise<string | null> {
  const res = await fetch(`${RENDER}/v1/services/${serviceId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (res.status !== 200) throw new Error(`render service get failed (${res.status})`);
  const body = (await res.json()) as {
    serviceDetails?: { url?: string };
    service?: { serviceDetails?: { url?: string } };
  };
  const url = body.serviceDetails?.url ?? body.service?.serviceDetails?.url ?? null;
  return typeof url === "string" && url.length > 0 ? url : null;
}

async function realProbeHealth(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function realDeployTruthPollDeps(token: string): DeployTruthPollDeps {
  return {
    async loadWatching() {
      const { data, error } = await serviceClient()
        .from("app_deploys")
        .select("id, tenant_id, pr_url, merged_sha, render_service_id, attempt_count")
        .eq("state", "deploy_watching")
        .limit(200);
      if (error) throw new Error(`app_deploys watching select failed: ${error.message}`);
      return (data ?? []) as DeployWatchRow[];
    },
    fetchLatestDeploy: (serviceId) => realFetchLatestDeploy(serviceId, token),
    fetchServiceUrl: (serviceId) => realFetchServiceUrl(serviceId, token),
    probeHealth: (url) => realProbeHealth(url),
    async setState(id, state, served_sha, health_url, reason) {
      const { data, error } = await serviceClient().rpc("set_app_deploy_state", {
        p_id: id,
        p_state: state,
        p_served_sha: served_sha,
        p_health_url: health_url,
        p_reason: reason,
      });
      if (error) throw new Error(`set_app_deploy_state failed: ${error.message}`);
      return data === true;
    },
    async bumpAttempt(id, served_sha, reason) {
      const { error } = await serviceClient().rpc("bump_app_deploy_attempt", {
        p_id: id,
        p_served_sha: served_sha,
        p_reason: reason,
      });
      if (error) throw new Error(`bump_app_deploy_attempt failed: ${error.message}`);
    },
  };
}

export const realEnqueueDeployTruthDeps: EnqueueDeployTruthDeps = {
  async resolveProvisionedRepoTenant(githubFullName) {
    const { data, error } = await serviceClient()
      .from("tenant_resources")
      .select("tenant_id, external_ref")
      .eq("resource_kind", "repo")
      .eq("mode", "provisioned")
      .eq("external_ref->>github_full_name", githubFullName)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { tenant_id?: string }).tenant_id ?? null;
  },
  async resolveHostingServiceId(tenant_id) {
    const { data, error } = await serviceClient()
      .from("tenant_resources")
      .select("external_ref")
      .eq("tenant_id", tenant_id)
      .eq("resource_kind", "hosting")
      .eq("mode", "provisioned")
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const ref = (data as { external_ref?: { render_service_id?: string } }).external_ref;
    const id = ref?.render_service_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  },
  deployTruthEnabled: () => getBoolSetting("deploy_truth_enabled"),
  async upsertWatch(a) {
    const { data, error } = await serviceClient().rpc("upsert_app_deploy_watch", {
      p_tenant_id: a.tenant_id,
      p_pr_url: a.pr_url,
      p_github_full_name: a.github_full_name,
      p_merged_sha: a.merged_sha,
      p_render_service_id: a.render_service_id,
      p_merged_at: a.merged_at,
    });
    if (error) return null;
    return typeof data === "number" ? data : null;
  },
};

export type DeployStatusView = {
  state: "deploy_watching" | "deploy_healthy" | "deploy_failed";
  pr_url: string;
  merged_sha: string;
  served_sha: string | null;
  health_url: string | null;
  reason: string | null;
  merged_at: string | null;
  updated_at: string | null;
  rollback_available: boolean;
};

export async function getLatestDeployStatus(tenant_id: string): Promise<DeployStatusView | null> {
  const { data, error } = await serviceClient()
    .from("app_deploys")
    .select("state, pr_url, merged_sha, served_sha, health_url, reason, merged_at, updated_at")
    .eq("tenant_id", tenant_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as Omit<DeployStatusView, "rollback_available">;
  return {
    ...r,
    rollback_available: r.state === "deploy_healthy" || r.state === "deploy_failed",
  };
}
