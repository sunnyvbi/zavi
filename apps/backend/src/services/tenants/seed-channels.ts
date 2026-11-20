
import { CHANNELS } from "@zavi/shared";
import { asTenantId, tenantRpc } from "@/services/tenant-client";

export type SeedTenantChannelsResult = {
  channels_inserted: number;
  error: string | null;
};

export async function seedTenantChannels(
  tenant_id: string,
): Promise<SeedTenantChannelsResult> {
  const slugs = CHANNELS.map((c) => c.slug);
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "seed_tenant_channels", {
    p_slugs: slugs,
  });
  if (error) {
    return { channels_inserted: 0, error: error.message };
  }
  return { channels_inserted: typeof data === "number" ? data : 0, error: null };
}
