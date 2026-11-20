
import { serviceClient } from "@/services/supabase";
import { assertProvisionedRepoTarget } from "@/services/provisioning/provisioned-repo-gate";
import { getScopedRepoFullNames } from "@/services/connectors/github/scoped-repos";
import { GONE_SITE_STATUSES, siteForRepo } from "@/services/sites/app-identity";
import { sitePublicResolver } from "@/services/sites/public-resolver";
import type { SiteRow, SiteStatus } from "@/services/sites/contract";

export class RepoResolutionError extends Error {
  constructor(
    public readonly code:
      | "no_github_connection"
      | "repo_hint_not_connected"
      | "no_default_set"
      | "supabase_read_failed",
    message: string,
  ) {
    super(message);
    this.name = "RepoResolutionError";
  }
}

export interface ResolveInput {
  tenant_id: string;
  repo_hint?: string | null;
}

export interface ResolveDeps {
  throwOnReadError?: boolean;
  assertProvisionedRepoTarget?: typeof assertProvisionedRepoTarget;
  siteOwnerOfRepo?: (full_name: string) => Promise<{ tenant_id: string; site_id: string; status: SiteStatus } | null>;
  siteForRepo?: (tenant_id: string, full_name: string) => Promise<SiteRow | null>;
}

async function siteRepoHint(
  tenant_id: string,
  hint: string,
  deps: Required<Pick<ResolveDeps, "siteOwnerOfRepo" | "siteForRepo">>,
): Promise<string | null> {
  let owner: { tenant_id: string; site_id: string; status: SiteStatus } | null;
  try {
    owner = await deps.siteOwnerOfRepo(hint);
  } catch (e) {
    throw new RepoResolutionError("supabase_read_failed", `failed to resolve the repo's site: ${(e as Error).message}`);
  }
  if (!owner) return null;
  if (owner.tenant_id !== tenant_id) {
    throw new RepoResolutionError("repo_hint_not_connected", `repo_hint "${hint}" is another workspace's site.`);
  }
  if (GONE_SITE_STATUSES.has(owner.status)) {
    throw new RepoResolutionError("repo_hint_not_connected", `repo_hint "${hint}" is a deleted site's repo.`);
  }
  let site: SiteRow | null;
  try {
    site = await deps.siteForRepo(tenant_id, hint);
  } catch (e) {
    throw new RepoResolutionError("supabase_read_failed", `failed to read the site: ${(e as Error).message}`);
  }
  const name = typeof site?.github_full_name === "string" ? site.github_full_name.trim() : "";
  if (!site || site.id !== owner.site_id || site.tenant_id !== tenant_id || !name) {
    throw new RepoResolutionError("repo_hint_not_connected", `repo_hint "${hint}" could not be matched to this workspace's site.`);
  }
  if (GONE_SITE_STATUSES.has(site.status)) {
    throw new RepoResolutionError("repo_hint_not_connected", `repo_hint "${hint}" is a deleted site's repo.`);
  }
  return name;
}

export async function resolveRepoFullName(
  input: ResolveInput,
  deps: ResolveDeps = {},
): Promise<string> {
  const assertProvisioned =
    deps.assertProvisionedRepoTarget ?? assertProvisionedRepoTarget;

  const sb = serviceClient();
  const { data, error } = await sb
    .from("connector_metadata")
    .select("repo_full_names, default_repo_full_name")
    .eq("tenant_id", input.tenant_id)
    .eq("slug", "github")
    .maybeSingle();

  if (error) {
    throw new RepoResolutionError(
      "supabase_read_failed",
      `failed to read connector_metadata: ${error.message}`,
    );
  }

  const row = (data ?? null) as {
    repo_full_names: string[] | null;
    default_repo_full_name: string | null;
  } | null;
  let connected: string[];
  try {
    connected = await getScopedRepoFullNames(input.tenant_id, sb, { throwOnReadError: deps.throwOnReadError });
  } catch (e) {
    if (!deps.throwOnReadError) throw e;
    throw new RepoResolutionError("supabase_read_failed", `failed to read scoped repositories: ${(e as Error).message}`);
  }

  const siteDeps = {
    siteOwnerOfRepo: deps.siteOwnerOfRepo ?? ((name: string) => sitePublicResolver().byRepo(name)),
    siteForRepo: deps.siteForRepo ?? ((tid: string, name: string) => siteForRepo(tid, name)),
  };
  const hintTrim = (input.repo_hint ?? "").trim();
  if (hintTrim.length > 0) {
    const siteRepo = await siteRepoHint(input.tenant_id, hintTrim, siteDeps);
    if (siteRepo) return siteRepo;
    if (connected.includes(hintTrim)) {
      return hintTrim;
    }
    const gate = await assertProvisioned(input.tenant_id, hintTrim);
    if (gate.ok) {
      return hintTrim;
    }
    if (deps.throwOnReadError && gate.reason === "query_error") {
      throw new RepoResolutionError("supabase_read_failed", "failed to read the provisioned repository");
    }
    throw new RepoResolutionError(
      "repo_hint_not_connected",
      `repo_hint "${hintTrim}" is neither in the tenant's connected repos [${
        connected.join(", ") || "none"
      }] nor the tenant's provisioned repo (gate: ${gate.reason}).`,
    );
  }

  if (!row) {
    throw new RepoResolutionError(
      "no_github_connection",
      "GitHub is not connected for this tenant. Connect a repo in Settings → Connectors.",
    );
  }

  if (row.default_repo_full_name && connected.includes(row.default_repo_full_name)) {
    return (await siteRepoHint(input.tenant_id, row.default_repo_full_name, siteDeps)) ?? row.default_repo_full_name;
  }

  if (connected.length === 1) {
    return (await siteRepoHint(input.tenant_id, connected[0], siteDeps)) ?? connected[0];
  }

  throw new RepoResolutionError(
    "no_default_set",
    "No repo_hint provided, no default repo is set, and the tenant has multiple connected repos. Set a default in Settings → Connectors → GitHub, or pass repo_hint in the agent payload.",
  );
}
