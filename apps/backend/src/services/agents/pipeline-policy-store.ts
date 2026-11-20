
import { serviceClient } from "@/services/supabase";
import {
  parseAppPipelinePolicy,
  resolveProtectedGlobs,
  DEFAULT_APP_PIPELINE_POLICY,
  type AppPipelinePolicy,
} from "@/services/agents/pipeline-policy";

export async function loadTenantAppPolicy(tenant_id: string): Promise<AppPipelinePolicy> {
  const { data, error } = await serviceClient()
    .from("tenant_resources")
    .select("external_ref")
    .eq("tenant_id", tenant_id)
    .eq("resource_kind", "repo")
    .maybeSingle();
  if (error) {
    throw new Error(`loadTenantAppPolicy read failed: ${error.message}`);
  }
  if (!data) return { ...DEFAULT_APP_PIPELINE_POLICY };
  return parseAppPipelinePolicy((data as { external_ref?: unknown }).external_ref);
}

export async function loadTenantProtectedGlobSet(
  tenant_id: string,
): Promise<{ globs: string[]; app_globs: string[] } | null> {
  try {
    const policy = await loadTenantAppPolicy(tenant_id);
    return { globs: resolveProtectedGlobs(policy), app_globs: [...policy.protected_globs] };
  } catch {
    return null;
  }
}

export async function loadTenantProtectedGlobs(tenant_id: string): Promise<string[]> {
  try {
    const policy = await loadTenantAppPolicy(tenant_id);
    return resolveProtectedGlobs(policy);
  } catch {
    return resolveProtectedGlobs(DEFAULT_APP_PIPELINE_POLICY);
  }
}
