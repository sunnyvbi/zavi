import { assertProvisionedRepoTarget } from "@/services/provisioning/provisioned-repo-gate";
import type { ProvisionedRepoGateResult } from "@/services/provisioning/provisioned-repo-gate";

export type SiteRepoHintDeps = {
  gate: (tenant_id: string, repo_full_name: string) => Promise<ProvisionedRepoGateResult>;
};

const realDeps: SiteRepoHintDeps = { gate: (tenant_id, repo) => assertProvisionedRepoTarget(tenant_id, repo) };

export async function siteIdForRepo(
  tenant_id: string,
  repo_full_name: string | null | undefined,
  deps: SiteRepoHintDeps = realDeps,
): Promise<string | null> {
  const repo = typeof repo_full_name === "string" ? repo_full_name.trim() : "";
  if (!tenant_id || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const result = await deps.gate(tenant_id, repo).catch(() => null);
  return result && result.ok && typeof result.site_id === "string" && result.site_id ? result.site_id : null;
}
