
import { serviceClient } from "@/services/supabase";
import { mintInstallationToken } from "@/services/connectors/github/oauth";
import { assertProvisionedRepoTarget } from "@/services/provisioning/provisioned-repo-gate";
import { resolveScopedRepos } from "@/services/connectors/github/scoped-repos";
import {
  UMBRELLA_CONNECTOR_ACCOUNT_LOGIN,
  hasRealGithubInstall,
} from "@/services/sandbox/repo-access-gate";

export type RepoCredsResolved = {
  kind: "resolved";
  owner: string;
  repo: string;
  repo_full_name: string;
  installation_token: string;
  provisioned: boolean;
};

export type RepoCredsNeedsPick = {
  kind: "needs_pick";
  repos: string[];
};

export type RepoCredsResult = RepoCredsResolved | RepoCredsNeedsPick;

export async function resolveRepoCredsForRun(
  tenant_id: string,
  payload: unknown,
): Promise<RepoCredsResult> {
  const svc = serviceClient;
  const p = (payload ?? {}) as {
    repo_hint?: string;
    stage?: string;
    target?: { github_full_name?: string; github_target_mode?: string };
    site_id?: string;
  };

  const autopilotTarget =
    typeof p.target?.github_full_name === "string"
      ? p.target.github_full_name.trim()
      : "";
  const targetMode =
    typeof p.target?.github_target_mode === "string"
      ? p.target.github_target_mode
      : "umbrella";
  const isProductBuildNode = p.stage === "scaffold" || p.stage === "build";

  const isUserRepoTarget = targetMode === "user_repo";

  const isBareCustomerEdit =
    !p.stage && !autopilotTarget && !p.repo_hint;

  const hintedRepo = typeof p.repo_hint === "string" ? p.repo_hint.trim() : "";
  const isHintedUmbrellaEdit =
    !p.stage && !autopilotTarget && hintedRepo.length > 0;

  type ConnectorMeta = {
    installation_id?: number;
    repo_full_names?: string[];
    default_repo_full_name?: string | null;
    account_login?: string | null;
  } | null;
  let metaRead: { meta: ConnectorMeta } | null = null;
  const readConnectorMeta = async (): Promise<ConnectorMeta> => {
    if (metaRead) return metaRead.meta;
    const { data, error } = await svc()
      .from("connector_metadata")
      .select("installation_id, repo_full_names, default_repo_full_name, account_login")
      .eq("tenant_id", tenant_id)
      .eq("slug", "github")
      .maybeSingle();
    if (error) throw new Error(`resolve-repo-creds: connector_metadata read failed: ${error.message}`);
    metaRead = { meta: data as ConnectorMeta };
    return metaRead.meta;
  };

  const siteHintedEdit = isHintedUmbrellaEdit && typeof p.site_id === "string" && p.site_id.length > 0;
  let chatEditOnRealInstall = false;
  if ((isBareCustomerEdit || isHintedUmbrellaEdit) && !isProductBuildNode && !isUserRepoTarget && !siteHintedEdit) {
    chatEditOnRealInstall = hasRealGithubInstall(await readConnectorMeta());
  }

  if (
    (isProductBuildNode ||
      ((isBareCustomerEdit || isHintedUmbrellaEdit) && !chatEditOnRealInstall)) &&
    !isUserRepoTarget
  ) {
    let resolvedTarget = autopilotTarget;
    if (!resolvedTarget) {
      const { data: trRow, error: trErr } = await svc()
        .from("tenant_resources")
        .select("mode, external_ref")
        .eq("tenant_id", tenant_id)
        .eq("resource_kind", "repo")
        .maybeSingle();
      if (trErr) {
        throw new Error(
          `resolve-repo-creds: tenant_resources(repo) read failed for tenant ${tenant_id}: ${trErr.message}. ` +
            `Refusing to fall through to the connected-repo gate — doing so would report a misleading ` +
            `connector error for what is a server-side fault or an ambiguous multi-repo row set.`,
        );
      }
      if (trRow) {
        const row = trRow as { mode?: string; external_ref?: Record<string, unknown> };
        if (
          row.mode === "provisioned" &&
          typeof row.external_ref?.github_full_name === "string"
        ) {
          const provisioned = (row.external_ref.github_full_name as string).trim();
          if (!(isHintedUmbrellaEdit && hintedRepo !== provisioned)) {
            resolvedTarget = provisioned;
          }
        }
      }
      if (!resolvedTarget && siteHintedEdit) resolvedTarget = hintedRepo;
    }

    if (resolvedTarget) {
      const gate = await assertProvisionedRepoTarget(tenant_id, resolvedTarget);
      if (!gate.ok) {
        throw new Error(
          `resolve-repo-creds: refusing autopilot target "${resolvedTarget}" — provisioned-repo gate failed (${gate.reason}). ` +
            `A scaffold/build node may only target a tenant_resources repo with mode='provisioned' and a matching github_full_name.`,
        );
      }
      if (gate.site_id !== undefined && (typeof p.site_id !== "string" || p.site_id !== gate.site_id)) {
        throw new Error(
          `resolve-repo-creds: refusing site repo "${resolvedTarget}" — the run's site_id does not match the site that owns it.`,
        );
      }
      const m = resolvedTarget.match(/^([\w.-]+)\/([\w.-]+)$/);
      if (!m) {
        throw new Error(
          `resolve-repo-creds: autopilot target "${resolvedTarget}" must be 'owner/name'`,
        );
      }
      const [, owner, repo] = m;
      const umbrellaToken = process.env.GITHUB_PROVISION_TOKEN ?? "";
      if (!umbrellaToken) {
        throw new Error(
          "resolve-repo-creds: GITHUB_PROVISION_TOKEN not configured — cannot clone/push the provisioned autopilot repo.",
        );
      }
      return {
        kind: "resolved",
        owner,
        repo,
        repo_full_name: gate.github_full_name,
        installation_token: umbrellaToken,
        provisioned: true,
      };
    }
  }

  const meta = await readConnectorMeta();
  const installation_id = meta?.installation_id;
  if (!installation_id) {
    if (meta?.account_login === UMBRELLA_CONNECTOR_ACCOUNT_LOGIN) {
      throw new Error(
        `resolve-repo-creds: tenant ${tenant_id} is an umbrella-provisioned app ` +
          `(connector sentinel present) but has no tenant_resources repo row with ` +
          `mode='provisioned'. This is a server-side provisioning gap — the customer ` +
          `has no GitHub to connect and must not be asked to connect one.`,
      );
    }
    throw new Error(
      "resolve-repo-creds: GitHub App not connected for this tenant. Install via /connectors before running sandbox agents.",
    );
  }
  const rawConnected = (meta?.repo_full_names ?? []).filter(
    (r): r is string => typeof r === "string" && r.length > 0,
  );
  let connectedRepos: string[];
  try {
    const resolved = await resolveScopedRepos(tenant_id, svc());
    connectedRepos = resolved.mode === "deny" ? [] : resolved.repos;
  } catch {
    connectedRepos = [];
  }
  if (connectedRepos.length === 0) {
    if (rawConnected.length > 0) {
      throw new Error(
        "resolve-repo-creds: GitHub is connected but no repositories are selected for Zavi to reach. Pick the repos this agent may work in under Settings → Connectors → GitHub, then re-run.",
      );
    }
    throw new Error(
      "resolve-repo-creds: payload.repo_hint missing and no repos are accessible to the GitHub installation. Re-install via /connectors and grant repo access.",
    );
  }

  let hint = p.repo_hint;
  if (!hint || typeof hint !== "string" || hint.trim().length === 0) {
    const tenantDefault = meta?.default_repo_full_name ?? null;
    if (connectedRepos.length === 1) {
      hint = connectedRepos[0];
    } else if (tenantDefault && connectedRepos.includes(tenantDefault)) {
      hint = tenantDefault;
    } else {
      return { kind: "needs_pick", repos: connectedRepos };
    }
  }
  const m = hint.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) {
    throw new Error(`resolve-repo-creds: repo_hint "${hint}" must be 'owner/name'`);
  }
  const [, owner, repo] = m;
  if (!connectedRepos.includes(`${owner}/${repo}`)) {
    return { kind: "needs_pick", repos: connectedRepos };
  }

  const token = await mintInstallationToken({
    tenant_id,
    installation_id,
    repo_full_name: `${owner}/${repo}`,
  });
  return {
    kind: "resolved",
    owner,
    repo,
    repo_full_name: `${owner}/${repo}`,
    installation_token: token,
    provisioned: false,
  };
}

