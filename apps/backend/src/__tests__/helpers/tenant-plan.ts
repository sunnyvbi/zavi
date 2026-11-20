
import { tierAgentMinFromBlob, tierAlwaysProFromBlob, type Tier } from "@/services/billing/tiers";

export const tenantPlan: { tier: Tier; unreadable: boolean } = { tier: "pro", unreadable: false };

export function resetTenantPlan(): void {
  tenantPlan.tier = "pro";
  tenantPlan.unreadable = false;
}

type PreviewPlan = typeof import("@/services/growth/preview-plan");

export async function previewPlanOn(orig: () => Promise<unknown>): Promise<PreviewPlan> {
  const real = (await orig()) as PreviewPlan;
  const reads = () => ({
    loadConfig: async () => ({
      enforced: false,
      agentMin: tierAgentMinFromBlob(null),
      proTenants: [],
      alwaysPro: tierAlwaysProFromBlob(null),
      ...(tenantPlan.unreadable ? { deferred: true } : {}),
    }),
    resolveTier: async () => tenantPlan.tier,
  });
  return {
    ...real,
    refuseIfChannelPlanLocked: (tenant_id, slug, deps = {}) =>
      real.refuseIfChannelPlanLocked(tenant_id, slug, { ...reads(), ...deps }),
    channelPlanLock: (tenant_id, slug, deps = {}) => real.channelPlanLock(tenant_id, slug, { ...reads(), ...deps }),
    planLockedChannels: (tenant_id, slugs, deps = {}) =>
      real.planLockedChannels(tenant_id, slugs, { ...reads(), ...deps }),
  };
}
