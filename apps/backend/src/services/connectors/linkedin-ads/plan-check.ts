import { checkAgentTier } from "@/services/agents/entitlement";

export const LINKEDIN_PLAN_UNREAD = "Zavi could not check your plan just now, so nothing was sent to LinkedIn. Try again in a minute.";

export async function linkedinPlanState(tenantId: string): Promise<"allowed" | "not_on_plan" | "unread"> {
  try {
    const tier = await checkAgentTier(tenantId, "linkedin_ads");
    if (!tier.enforced || tier.unverified) return "unread";
    return tier.allowed ? "allowed" : "not_on_plan";
  } catch {
    return "unread";
  }
}
