
import { fbPost, getAdAccountCurrency } from "../_client";
import { shapeUpdateCampaignBudgetRequest } from "./_request-shapers";
import { assertGraphWriteSucceeded } from "./_helpers";

export async function metaUpdateCampaignBudget(
  tenant_id: string,
  input: { campaign_id: string; daily_budget_usd: number },
): Promise<{ id: string; daily_budget: string }> {
  const currency = await getAdAccountCurrency(tenant_id);
  const { path, params } = shapeUpdateCampaignBudgetRequest(input, currency);
  const r = (await fbPost(tenant_id, path, params)) as { success?: boolean; id?: string };
  assertGraphWriteSucceeded(r, "campaign budget update");
  return { id: r.id ?? input.campaign_id, daily_budget: params.daily_budget };
}
