
import { serviceClient } from "@/services/supabase";
import type { ResourceKind } from "./types";

export async function setResourceSecret(
  tenant_id: string,
  resource_kind: ResourceKind,
  key: string,
  value: string,
): Promise<string> {
  const { error } = await serviceClient().rpc("set_resource_secret", {
    p_tenant_id: tenant_id,
    p_resource_kind: resource_kind,
    p_key: key,
    p_value: value,
  });
  if (error) throw new Error(`set_resource_secret failed: ${error.message}`);
  return key;
}
