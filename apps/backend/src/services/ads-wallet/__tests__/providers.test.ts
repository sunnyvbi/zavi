vi.mock("../consent",()=>({sharedWalletConsent:async()=>true}));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ tier:vi.fn(),lock:vi.fn(),binding:vi.fn(),settle:vi.fn() }));
vi.mock("@/services/agents/entitlement",()=>({checkAgentTier:m.tier}));
vi.mock("@/services/channels/lock",()=>({isChannelLockedStrict:m.lock}));
vi.mock("../bindings",()=>({getCampaignBinding:m.binding}));
vi.mock("../adapters/chatgpt",()=>({settleCampaign:m.settle}));
import { refillEligibility,settleBoundCampaign } from "../providers";
beforeEach(()=>{vi.resetAllMocks();m.tier.mockResolvedValue({allowed:true,enforced:true});m.lock.mockResolvedValue(false);m.binding.mockResolvedValue({id:"bound-id",platform:"chatgpt",provider_campaign_id:"raw-id",funding_source:"wallet"});});
it("dispatches a verified campaign binding to its provider using the original identity",async()=>{
 await settleBoundCampaign("t","bound-id");
 expect(m.binding).toHaveBeenCalledWith("t","bound-id");
 expect(m.settle).toHaveBeenCalledWith("t","raw-id","bound-id");
});
it.each([{platform:"reddit",funding_source:"wallet"},{platform:"chatgpt",funding_source:"provider"}])("never settles an unsupported or externally billed binding %o",async binding=>{
 m.binding.mockResolvedValue(binding);
 await expect(settleBoundCampaign("t","b")).rejects.toThrow();expect(m.settle).not.toHaveBeenCalled();
});
it("checks the enabled funding adapter's entitlement",async()=>{
 expect(await refillEligibility("t")).toBe("allowed");expect(m.tier).toHaveBeenCalledWith("t","chatgpt_ads");
 m.lock.mockResolvedValue(true);expect(await refillEligibility("t")).toBe("paused");
});
it("distinguishes unverified entitlement from a definite denial",async()=>{
 m.tier.mockResolvedValue({allowed:true,enforced:false});expect(await refillEligibility("t")).toBe("unknown");
 m.tier.mockResolvedValue({allowed:false,enforced:true});expect(await refillEligibility("t")).toBe("below_plan");
 m.tier.mockRejectedValue(new Error("unavailable"));expect(await refillEligibility("t")).toBe("unknown");
});

afterEach(()=>{vi.unstubAllEnvs();});
it("does not enable LinkedIn refills from the funding flag without the rollout acknowledgment",async()=>{
 m.tier.mockImplementation(async(_tenant,channel)=>({allowed:channel==="linkedin_ads",enforced:true}));
 vi.stubEnv("ADS_LINKEDIN_MANAGED_ENABLED","true");vi.stubEnv("ADS_LINKEDIN_ROLLOUT_ACK","");expect(await refillEligibility("t")).toBe("paused");
 vi.stubEnv("ADS_LINKEDIN_ROLLOUT_ACK","campaign-bindings-forward-only");expect(await refillEligibility("t")).toBe("allowed");
});
