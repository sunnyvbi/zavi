
import { asTenantId, tenantClient } from "@/services/tenant-client";

export async function findEnabledIMessageBinding(args: {
  line: string;
  handle: string;
  tenant_id: string;
}): Promise<{ id: string } | null> {
  const { data, error } = await tenantClient(asTenantId(args.tenant_id))
    .from("imessage_threads")
    .select("id")
    .eq("line", args.line)
    .eq("handle", args.handle)
    .eq("status", "enabled")
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`imessage binding lookup failed: ${error.message}`);
  return data ?? null;
}
