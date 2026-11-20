
import { fbPost, getAdAccountCurrency } from "../_client";
import { shapeUpdateAdSetBudgetRequest } from "./_request-shapers";
import { assertGraphWriteSucceeded } from "./_helpers";

export async function metaUpdateAdSetBudget(
  tenant_id: string,
  input: { ad_set_id: string; daily_budget_usd: number },
): Promise<{ id: string; daily_budget: string }> {
  const currency = await getAdAccountCurrency(tenant_id);
  const { path, params } = shapeUpdateAdSetBudgetRequest(input, currency);
  const r = (await fbPost(tenant_id, path, params)) as {
    success?: boolean;
    id?: string;
  };
  assertGraphWriteSucceeded(r, "budget update");
  return {
    id: r.id ?? input.ad_set_id,
    daily_budget: params.daily_budget,
  };
}
