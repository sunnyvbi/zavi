
import { serviceClient } from "@/services/supabase";

export type UserRepoGateResult =
  | { ok: true; github_full_name: string }
  | { ok: false; reason: string };

export type UserRepoGateDeps = {
  loadRepoResource: (
    tenant_id: string,
  ) => Promise<{ mode: string; external_ref: Record<string, unknown> } | null>;
};

export const realUserRepoGateDeps: UserRepoGateDeps = {
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
};

export async function assertUserRepoTarget(
  tenant_id: string,
  expected_full_name: string,
  deps: UserRepoGateDeps = realUserRepoGateDeps,
): Promise<UserRepoGateResult> {
  const expected = (expected_full_name ?? "").trim();
  if (!expected) {
    return { ok: false, reason: "no expected github_full_name supplied" };
  }
  let row: { mode: string; external_ref: Record<string, unknown> } | null;
  try {
    row = await deps.loadRepoResource(tenant_id);
  } catch (e) {
    console.warn(
      `[user-repo-gate] tenant_resources read threw for tenant=${tenant_id} — failing closed: ${
        (e as Error).message
      }`,
    );
    return { ok: false, reason: "query_error" };
  }
  if (!row) {
    return { ok: false, reason: "no tenant_resources(repo) row" };
  }
  if (row.mode !== "connected") {
    return { ok: false, reason: `mode=${row.mode || "<empty>"} (not connected)` };
  }
  const grantedName =
    typeof row.external_ref?.github_full_name === "string"
      ? (row.external_ref.github_full_name as string).trim()
      : "";
  if (!grantedName) {
    return { ok: false, reason: "external_ref.github_full_name missing" };
  }
  if (grantedName !== expected) {
    return {
      ok: false,
      reason: `github_full_name mismatch (granted=${grantedName} expected=${expected})`,
    };
  }
  const grantFlag = row.external_ref?.user_repo_grant;
  if (grantFlag !== true) {
    return {
      ok: false,
      reason: "external_ref.user_repo_grant missing (tenant has not authorized push-to-main on this repo)",
    };
  }
  return { ok: true, github_full_name: grantedName };
}
