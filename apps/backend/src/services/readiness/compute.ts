
import { serviceClient } from "@/services/supabase";

export interface ReadinessSnapshot {
  tenant_id: string;
  score: number;
  dimensions: Record<string, unknown>;
  computed_at: string;
  last_discovery_at: string | null;
}

export async function computeReadiness(tenant_id: string): Promise<number> {
  const { data, error } = await serviceClient().rpc("compute_tenant_readiness", {
    p_tenant_id: tenant_id,
  });
  if (error) {
    throw new Error(`compute_tenant_readiness failed for ${tenant_id}: ${error.message}`);
  }
  return typeof data === "number" ? data : Number(data ?? 0);
}

export async function readReadiness(tenant_id: string): Promise<ReadinessSnapshot | null> {
  const { data, error } = await serviceClient()
    .from("tenant_readiness")
    .select("tenant_id, score, dimensions, computed_at, last_discovery_at")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) {
    throw new Error(`tenant_readiness read failed for ${tenant_id}: ${error.message}`);
  }
  return (data as ReadinessSnapshot | null) ?? null;
}
