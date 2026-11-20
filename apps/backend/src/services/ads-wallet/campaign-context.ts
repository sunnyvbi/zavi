import { AsyncLocalStorage } from "node:async_hooks";
import type { CampaignBinding } from "./bindings";
const scope = new AsyncLocalStorage<CampaignBinding>();
export const withBoundCampaign = <T>(
  binding: CampaignBinding,
  work: () => Promise<T>,
): Promise<T> => scope.run(binding, work);
export const currentBoundCampaign = () => scope.getStore();
export function scopedCampaignBinding(
  tenantId: string,
  platform: string,
  campaignId: string,
): string | undefined {
  const binding = scope.getStore();
  if (!binding) return undefined;
  if (
    binding.tenant_id !== tenantId ||
    binding.platform !== platform ||
    binding.provider_campaign_id !== campaignId
  )
    throw new Error("Campaign context mismatch");
  return binding.id;
}
