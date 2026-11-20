
import { asTenantId, tenantClient } from "@/services/tenant-client";

export type StaleResolution = { status: number; body: unknown } | "not_found";
export type StaleResolver = (scope: { tenant_id: string; user_id: string; key: string }) => Promise<StaleResolution>;

export const resolveStaleBuildStart: StaleResolver = async ({ tenant_id, key }) => {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("conductor_runs")
    .select("id")
    .eq("request_key", key)
    .maybeSingle();
  if (error) throw new Error(`build start lookup failed: ${error.message}`);
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id) return "not_found";
  return { status: 200, body: { ok: true, conductor_run_id: id, replayed_after_stale: true } };
};

export const STALE_RESOLVERS: Readonly<Record<string, StaleResolver>> = {
  "/api/workspace/autopilot/build-product": resolveStaleBuildStart,
};
