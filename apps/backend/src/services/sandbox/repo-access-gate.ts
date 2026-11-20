
import { serviceClient } from "@/services/supabase";
import { getScopedRepos } from "@/services/connectors/github/scoped-repos";

export const UMBRELLA_CONNECTOR_ACCOUNT_LOGIN = "Praxis-build";

export type RepoAccessStatus =
  | "ok"
  | "not_connected"
  | "zero_repos"
  | "selection_required"
  | "install_dead";

export class SandboxRepoAccessRequiredError extends Error {
  readonly status: Exclude<RepoAccessStatus, "ok">;
  constructor(agent_slug: string, status: Exclude<RepoAccessStatus, "ok">) {
    super(
      `Agent "${agent_slug}" rejected: ${
        status === "not_connected"
          ? "GitHub is not connected for this tenant"
          : status === "install_dead"
            ? "GitHub connection was removed or expired (reconnect required)"
            : status === "selection_required"
              ? "GitHub is connected but no repositories are selected for Zavi to reach"
              : "GitHub is connected but no repositories are shared with the installation"
      } (config_error_no_repo_access)`,
    );
    this.name = "SandboxRepoAccessRequiredError";
    this.status = status;
  }
}

export function repoAccessBlockedMessage(status: Exclude<RepoAccessStatus, "ok">): string {
  if (status === "not_connected") {
    return (
      "I need repository access before I can work on code. GitHub isn't connected yet — " +
      "connect it in **Settings → Connectors → GitHub**, pick the repositories I should reach, " +
      "then re-send this and I'll get started."
    );
  }
  if (status === "install_dead") {
    return (
      "I couldn't reach your GitHub repository — my GitHub connection was removed or has expired, " +
      "so I can't open or fix anything until it's reconnected. Reconnect it in " +
      "**Settings → Connectors → GitHub** (you may need to re-install the Zavi Engineer GitHub App " +
      "on the account that owns the repo), then re-send this and I'll get started."
    );
  }
  if (status === "selection_required") {
    return (
      "I need to know which repositories I'm allowed to work in. GitHub is connected, but no " +
      "repositories are selected for me to reach — open **Settings → Connectors → GitHub**, " +
      "check the repos I should work in, then re-send this and I'll get started."
    );
  }
  return (
    "I need repository access before I can work on code. GitHub is connected, but no " +
    "repositories are shared with Zavi — open **Settings → Connectors → GitHub**, choose " +
    "**Install / Configure**, grant access to the repos I should reach, then re-send this " +
    "and I'll get started."
  );
}

function isProvisionedBuildPayload(payload: unknown): boolean {
  if (payload == null || typeof payload !== "object") return false;
  const p = payload as {
    stage?: unknown;
    target?: { github_target_mode?: unknown } | null;
  };
  const isBuildNode = p.stage === "scaffold" || p.stage === "build";
  if (!isBuildNode) return false;
  const mode =
    typeof p.target?.github_target_mode === "string"
      ? p.target.github_target_mode
      : "umbrella";
  return mode !== "user_repo";
}

type Svc = ReturnType<typeof serviceClient>;

export async function checkSandboxRepoAccess(
  tenant_id: string,
  payload: unknown,
  svc: Svc = serviceClient(),
): Promise<RepoAccessStatus> {
  if (isProvisionedBuildPayload(payload)) return "ok";

  if (payload && typeof payload === "object") {
    const p = payload as { repo_hint?: unknown; site_id?: unknown };
    if (typeof p.repo_hint === "string" && p.repo_hint.trim() &&
        typeof p.site_id === "string" && p.site_id) {
      const { assertProvisionedRepoTarget } = await import("@/services/provisioning/provisioned-repo-gate");
      const target = await assertProvisionedRepoTarget(tenant_id, p.repo_hint.trim());
      if (target.ok && target.site_id === p.site_id) return "ok";
    }
  }

  const { data, error } = await svc
    .from("connector_metadata")
    .select("installation_id, repo_full_names, account_login")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (error) return "ok";
  const meta = data as {
    installation_id?: number | null;
    repo_full_names?: string[] | null;
    account_login?: string | null;
  } | null;

  const repos = (meta?.repo_full_names ?? []).filter(
    (r): r is string => typeof r === "string" && r.length > 0,
  );

  if (meta?.account_login === UMBRELLA_CONNECTOR_ACCOUNT_LOGIN && repos.length > 0) {
    return "ok";
  }

  if (!meta?.installation_id) return "not_connected";

  const { data: mcpRow, error: mcpErr } = await svc
    .from("tenant_mcp_servers")
    .select("enabled")
    .eq("tenant_id", tenant_id)
    .eq("server_id", "github")
    .maybeSingle();
  if (
    !mcpErr &&
    mcpRow &&
    (mcpRow as { enabled?: boolean | null }).enabled === false
  ) {
    return "install_dead";
  }

  if (repos.length === 0) return "zero_repos";

  try {
    const scoped = await getScopedRepos(tenant_id, svc);
    if (scoped.selectionRequired) return "selection_required";
  } catch {
    return "ok";
  }
  return "ok";
}

export function hasRealGithubInstall(
  row: { installation_id?: unknown; account_login?: unknown } | null | undefined,
): boolean {
  if (!row) return false;
  return (
    typeof row.installation_id === "number" &&
    row.installation_id > 0 &&
    row.account_login !== UMBRELLA_CONNECTOR_ACCOUNT_LOGIN
  );
}

export async function tenantHasRealGithubInstall(
  tenant_id: string,
  svc: Svc = serviceClient(),
): Promise<boolean> {
  if (typeof tenant_id !== "string" || tenant_id.length === 0) return false;
  try {
    const { data, error } = await svc
      .from("connector_metadata")
      .select("installation_id, account_login")
      .eq("tenant_id", tenant_id)
      .eq("slug", "github")
      .maybeSingle();
    if (error || !data) return false;
    return hasRealGithubInstall(data as { installation_id?: unknown; account_login?: unknown });
  } catch {
    return false;
  }
}

export function isBuildPipelinePayload(payload: unknown): boolean {
  if (payload == null || typeof payload !== "object") return false;
  const p = payload as { stage?: unknown; repair_mode?: unknown };
  return (typeof p.stage === "string" && p.stage.length > 0) || p.repair_mode === true;
}

export async function isUmbrellaProvisionedTenant(
  tenant_id: string,
  svc: Svc = serviceClient(),
): Promise<boolean> {
  if (typeof tenant_id !== "string" || tenant_id.length === 0) return false;
  const { data, error } = await svc
    .from("connector_metadata")
    .select("account_login, repo_full_names")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (error || !data) return false;
  const meta = data as {
    account_login?: string | null;
    repo_full_names?: string[] | null;
  };
  const repos = (meta.repo_full_names ?? []).filter(
    (r): r is string => typeof r === "string" && r.length > 0,
  );
  return (
    meta.account_login === UMBRELLA_CONNECTOR_ACCOUNT_LOGIN && repos.length > 0
  );
}
