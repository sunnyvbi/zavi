import { asTenantId, tenantClient } from "@/services/tenant-client";
import { getBoolSetting } from "@/services/settings";
import { assertProvisionedRepoTarget } from "@/services/provisioning/provisioned-repo-gate";

export const ZAVI_REPO_COUNTS_AS_GITHUB_KEY = "build_zavi_repo_counts_as_github";

export async function zaviBuiltRepoForRun(
  tenant_id: string,
  repo_hint?: string | null,
): Promise<string | null> {
  try {
    if (!(await getBoolSetting(ZAVI_REPO_COUNTS_AS_GITHUB_KEY, tenant_id))) return null;
    let candidate = typeof repo_hint === "string" ? repo_hint.trim() : "";
    if (!candidate) {
      const { data, error } = await tenantClient(asTenantId(tenant_id))
        .from("connector_metadata")
        .select("default_repo_full_name")
        .eq("slug", "github")
        .maybeSingle();
      if (error) return null;
      const d = (data as { default_repo_full_name?: unknown } | null)?.default_repo_full_name;
      candidate = typeof d === "string" ? d.trim() : "";
    }
    if (!candidate) return null;
    const gate = await assertProvisionedRepoTarget(tenant_id, candidate);
    return gate.ok ? gate.github_full_name : null;
  } catch {
    return null;
  }
}

export function repoHintOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const h = (payload as { repo_hint?: unknown }).repo_hint;
  return typeof h === "string" && h.trim() ? h.trim() : null;
}
