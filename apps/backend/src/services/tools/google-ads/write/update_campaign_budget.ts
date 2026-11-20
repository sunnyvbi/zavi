
import { gadsMutate } from "../_client";

const MICROS_PER_USD = 1_000_000;

export async function googleUpdateCampaignBudget(
  tenant_id: string,
  input: { budget_resource: string; daily_budget_usd: number },
): Promise<{ resource_name: string; amount_micros: number }> {
  const amount_micros = Math.round(input.daily_budget_usd * MICROS_PER_USD);
  const resourceNames = await gadsMutate(tenant_id, "campaignBudgets", [
    {
      updateMask: "amount_micros",
      update: {
        resourceName: input.budget_resource,
        amountMicros: String(amount_micros),
      },
    },
  ]);
  return {
    resource_name: resourceNames[0] ?? input.budget_resource,
    amount_micros,
  };
}
