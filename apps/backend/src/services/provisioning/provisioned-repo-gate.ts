
import { serviceClient } from "@/services/supabase";
import { siteStore } from "@/services/sites/store";
import type { SiteRow, SiteStatus } from "@/services/sites/contract";

export type ProvisionedRepoGateResult =
  | { ok: true; github_full_name: string; site_id?: string }
  | { ok: false; reason: string };

export type ProvisionedRepoGateDeps = {
  loadRepoResource: (
    tenant_id: string,
  ) => Promise<{ mode: string; external_ref: Record<string, unknown> } | null>;
  loadSiteByRepo?: (tenant_id: string, github_full_name: string) => Promise<SiteRow | null>;
};

export const realProvisionedRepoGateDeps: ProvisionedRepoGateDeps = {
  async loadRepoResource(tenant_id) {
    const { data, error } = await serviceClient()
      .from("tenant_resources")
      .select("mode, external_ref")
      .eq("tenant_id", tenant_id)
      .eq("resource_kind", "repo")
      .maybeSingle();
    if (error) throw new Error(`tenant_resources(repo) read failed: ${error.message}`);
    if (!data) return null;
    const row = data as { mode?: string; external_ref?: Record<string, unknown> };
    return { mode: row.mode ?? "", external_ref: row.external_ref ?? {} };
  },
  loadSiteByRepo: (tenant_id, github_full_name) => siteStore().getByRepo(tenant_id, github_full_name),
};

const DEAD_SITE_STATUSES: ReadonlySet<SiteStatus> = new Set<SiteStatus>([
  "failed",
  "fell_back_old",
  "deleting",
  "deleted",
]);

export async function assertProvisionedRepoTarget(
  tenant_id: string,
  expected_full_name: string,
  deps: ProvisionedRepoGateDeps = realProvisionedRepoGateDeps,
): Promise<ProvisionedRepoGateResult> {
  const primary = await assertTenantResourcesRepoTarget(tenant_id, expected_full_name, deps);
  if (primary.ok || !deps.loadSiteByRepo) return primary;
  const site = await siteRepoTarget(tenant_id, expected_full_name, deps.loadSiteByRepo);
  return site ?? primary;
}

async function siteRepoTarget(
  tenant_id: string,
  expected_full_name: string,
  loadSiteByRepo: NonNullable<ProvisionedRepoGateDeps["loadSiteByRepo"]>,
): Promise<ProvisionedRepoGateResult | null> {
  const expected = (expected_full_name ?? "").trim();
  if (!expected || !tenant_id) return null;
  try {
    const site = await loadSiteByRepo(tenant_id, expected);
    if (!site || site.tenant_id !== tenant_id) return null;
    if (DEAD_SITE_STATUSES.has(site.status)) return null;
    const siteRepo = typeof site.github_full_name === "string" ? site.github_full_name.trim() : "";
    if (!siteRepo || siteRepo !== expected || !site.id) return null;
    return { ok: true, github_full_name: siteRepo, site_id: site.id };
  } catch (e) {
    console.warn(
      `[provisioned-repo-gate] sites read threw for tenant=${tenant_id} — failing closed: ${(e as Error).message}`,
    );
    return null;
  }
}

async function assertTenantResourcesRepoTarget(
  tenant_id: string,
  expected_full_name: string,
  deps: ProvisionedRepoGateDeps,
): Promise<ProvisionedRepoGateResult> {
  const expected = (expected_full_name ?? "").trim();
  if (!expected) {
    return { ok: false, reason: "no expected github_full_name supplied" };
  }
  let row: { mode: string; external_ref: Record<string, unknown> } | null;
  try {
    row = await deps.loadRepoResource(tenant_id);
  } catch (e) {
    console.warn(
      `[provisioned-repo-gate] tenant_resources read threw for tenant=${tenant_id} — failing closed: ${
        (e as Error).message
      }`,
    );
    return { ok: false, reason: "query_error" };
  }
  if (!row) {
    return { ok: false, reason: "no tenant_resources(repo) row" };
  }
  if (row.mode !== "provisioned") {
    return { ok: false, reason: `mode=${row.mode || "<empty>"} (not provisioned)` };
  }
  const provisionedName =
    typeof row.external_ref?.github_full_name === "string"
      ? (row.external_ref.github_full_name as string).trim()
      : "";
  if (!provisionedName) {
    return { ok: false, reason: "external_ref.github_full_name missing" };
  }
  if (provisionedName !== expected) {
    return {
      ok: false,
      reason: `github_full_name mismatch (provisioned=${provisionedName} expected=${expected})`,
    };
  }
  return { ok: true, github_full_name: provisionedName };
}
