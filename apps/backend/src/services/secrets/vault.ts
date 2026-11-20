
import { serviceClient } from "@/services/supabase";

export async function getSecret(
  tenant_id: string,
  key: string,
): Promise<string | null> {
  const { data, error } = await serviceClient().rpc("get_secret", {
    p_tenant_id: tenant_id,
    p_key: key,
  });
  if (error) {
    throw new Error(`get_secret failed for tenant ${tenant_id}: ${error.message}`);
  }
  return (data as string | null) ?? null;
}
