
import { fbGet, fbPost, getAdAccountCurrency, metaAdsCreds } from "../_client";
import { beforeSend } from "@/services/decisions/ad-budget";
import { shapeCreateAdSetRequest } from "./_request-shapers";
import { assertCampaignBidUnchanged } from "./_ad-set-bid";
import { readOwnCampaign } from "./campaign_writes";
import { assertNoNameCollision } from "./_helpers";
import type { PromotedObject } from "./_targeting-validate";
import type { MetaBidStrategy } from "./_decision-bodies";

export async function metaCreateAdSet(
  tenant_id: string,
  input: {
    campaign_id: string;
    name: string;
    daily_budget_usd: number;
    optimization_goal: string;
    billing_event: string;
    targeting: Record<string, unknown>;
    promoted_object?: PromotedObject;
    bid_strategy?: MetaBidStrategy;
    bid_amount_usd?: number;
    campaign_bid_strategy?: MetaBidStrategy;
    roas_floor?: number;
    status?: "ACTIVE" | "PAUSED";
  },
): Promise<{ id: string; status: "ACTIVE" | "PAUSED" }> {
  const creds = await metaAdsCreds(tenant_id);

  const currency = await beforeSend(async () => {
    const listed = (await fbGet(tenant_id, `${creds.ad_account_id}/adsets`, {
      fields: "name",
      limit: 200,
    })) as { data?: Array<{ name?: string }> };
    const existing = (listed.data ?? [])
      .map((r) => r.name)
      .filter((n): n is string => typeof n === "string");
    assertNoNameCollision(existing, input.name);

    const campaign = await readOwnCampaign(tenant_id, input.campaign_id);
    assertCampaignBidUnchanged(campaign.bid_strategy, input);

    return getAdAccountCurrency(tenant_id);
  });

  const { path, params } = shapeCreateAdSetRequest(input, currency, creds.ad_account_id);
  const r = (await fbPost(tenant_id, path, params)) as { id?: string };
  if (!r.id) {
    throw new Error(`Meta create_ad_set returned no id: ${JSON.stringify(r)}`);
  }
  return {
    id: r.id,
    status: (input.status ?? "PAUSED") as "ACTIVE" | "PAUSED",
  };
}
