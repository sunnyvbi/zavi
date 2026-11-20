import {managedLinkedinEnabled} from "./managed-linkedin";
import { checkAgentTier } from "@/services/agents/entitlement";
import { isChannelLockedStrict } from "@/services/channels/lock";
import { getCampaignBinding } from "./bindings";
import { sharedWalletConsent } from "./consent";

export type RefillEligibility = "allowed" | "denied" | "paused" | "below_plan" | "unknown";
const providers = {
  chatgpt: {
    channel: "chatgpt_ads" as const,
    refillEligible:async(_tenantId:string)=>true,
    globallyOff:async()=>false,
    settle: async (tenantId: string, campaignId: string, bindingId: string) =>
      (await import("./adapters/chatgpt")).settleCampaign(tenantId, campaignId, bindingId),
  },
  linkedin: {
    channel: "linkedin_ads" as const,
    refillEligible:async(tenantId:string)=>await sharedWalletConsent(tenantId),
    globallyOff:async()=>!managedLinkedinEnabled(),
    settle: async (tenantId: string, _campaignId: string, bindingId: string) =>
      (await import("./adapters/linkedin")).settleLinkedinBoundCampaign(tenantId, bindingId),
  },
};
export async function refillEligibility(tenantId: string): Promise<RefillEligibility> {
  let unknown = false;
  let paused = false;
  let belowPlan = false;
  for (const provider of Object.values(providers)) {
    try {
      if(!await provider.refillEligible(tenantId))continue;
      const tier = await checkAgentTier(tenantId, provider.channel);
      if (!tier.enforced) { unknown = true; continue; }
      if (!tier.allowed) { if (provider.channel === "linkedin_ads") belowPlan = true; continue; }
      if (await provider.globallyOff() || await isChannelLockedStrict(provider.channel)) { paused = true; continue; }
      return "allowed";
    } catch { unknown = true; }
  }
  return unknown ? "unknown" : paused ? "paused" : belowPlan ? "below_plan" : "denied";
}
export async function settleBoundCampaign(tenantId: string, bindingId: string) {
  const binding = await getCampaignBinding(tenantId, bindingId);
  if (binding.funding_source !== "wallet") throw new Error("Campaign is not wallet-funded");
  const provider = providers[binding.platform as keyof typeof providers];
  if (!provider) throw new Error("Wallet settlement provider is not enabled");
  await provider.settle(tenantId, binding.provider_campaign_id, binding.id);
}
