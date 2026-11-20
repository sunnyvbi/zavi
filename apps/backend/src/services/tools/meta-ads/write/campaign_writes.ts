
import { fbGet, fbPost, getAdAccountCurrency, metaAdsCreds } from "../_client";
import { ExpectedToolError } from "@/services/tools/types";
import { assertGraphWriteSucceeded, detectCbo } from "./_helpers";
import { nameHasTag, taggedName } from "./_launch-shapers";
import { minorToMajor } from "./_currency";
import {
  META_REMOVE_SPEND_CAP,
  shapeCreateCampaignRequest,
  shapeDeleteCampaignRequest,
  shapeUpdateCampaignRequest,
} from "./_request-shapers";
import type { CreateCampaignBody, UpdateCampaignBody } from "./_decision-bodies";

type LiveCampaign = {
  id?: string;
  account_id?: string;
  name?: string;
  status?: string;
  daily_budget?: string | null;
  lifetime_budget?: string | null;
  spend_cap?: string | null;
  bid_strategy?: string | null;
};

function sameAccount(a: unknown, ours: string): boolean {
  return typeof a === "string" && a.replace(/^act_/, "") === ours.replace(/^act_/, "");
}

export async function readOwnCampaign(tenant_id: string, campaign_id: string): Promise<LiveCampaign> {
  const [creds, c] = await Promise.all([
    metaAdsCreds(tenant_id),
    fbGet(tenant_id, campaign_id, {
      fields: "id,account_id,name,status,daily_budget,lifetime_budget,spend_cap,bid_strategy",
    }) as Promise<LiveCampaign>,
  ]);
  if (!c?.id || !sameAccount(c.account_id, creds.ad_account_id)) {
    throw new ExpectedToolError(
      "meta_ads_invalid_target",
      `campaign ${campaign_id} is not in this workspace's connected ad account; nothing was sent.`,
    );
  }
  return c;
}

export function liveSpendCap(c: Pick<LiveCampaign, "spend_cap">, currency: string): number | null {
  if (c.spend_cap == null || c.spend_cap === META_REMOVE_SPEND_CAP) return null;
  const v = minorToMajor(c.spend_cap, currency);
  return v != null && v > 0 ? v : null;
}

export async function metaCreateCampaign(
  tenant_id: string,
  input: Pick<CreateCampaignBody, "objective" | "special_ad_categories" | "special_ad_category_country" | "daily_budget_usd" | "bid_strategy"> & {
    name: string;
    tag: string;
  },
): Promise<{ id: string; name: string; reused: boolean }> {
  const creds = await metaAdsCreds(tenant_id);
  const name = taggedName(input.name, input.tag);
  const found = (await fbGet(tenant_id, `${creds.ad_account_id}/campaigns`, {
    fields: "id,name",
    filtering: JSON.stringify([{ field: "name", operator: "CONTAIN", value: input.tag }]),
    limit: 10,
  })) as { data?: Array<{ id?: string; name?: string }> };
  const existing = (found.data ?? []).find((c) => c.id && nameHasTag(c.name, input.tag));
  if (existing?.id) return { id: existing.id, name: existing.name ?? name, reused: true };

  const currency = await getAdAccountCurrency(tenant_id);
  const req = shapeCreateCampaignRequest(
    {
      ad_account_id: creds.ad_account_id,
      name,
      objective: input.objective,
      special_ad_categories: input.special_ad_categories,
      special_ad_category_country: input.special_ad_category_country,
      daily_budget_usd: input.daily_budget_usd,
      bid_strategy: input.bid_strategy,
    },
    currency,
  );
  const r = (await fbPost(tenant_id, req.path, req.params)) as { id?: string };
  if (!r?.id) throw new ExpectedToolError("meta_ads_write_failed", "Meta created no campaign id");
  return { id: r.id, name, reused: false };
}

export async function metaUpdateCampaign(
  tenant_id: string,
  p: UpdateCampaignBody,
): Promise<{ updated_fields: string[]; live: LiveCampaign }> {
  const live = await readOwnCampaign(tenant_id, p.campaign_id);
  const currency = await getAdAccountCurrency(tenant_id);

  if (p.spend_cap_usd !== undefined) {
    const now = liveSpendCap(live, currency);
    const expected = p.expected_current_spend_cap_usd ?? null;
    if (Math.round((now ?? 0) * 100) !== Math.round((expected ?? 0) * 100)) {
      throw new ExpectedToolError(
        "meta_ads_spend_cap_drift",
        `campaign ${p.campaign_id} spend cap is ${now ?? "none"} now, not ${expected ?? "none"} as proposed; nothing was changed.`,
      );
    }
  }
  if (p.bid_strategy !== undefined) {
    if (!detectCbo(live)) {
      throw new ExpectedToolError(
        "meta_ads_bid_strategy_needs_campaign_budget",
        `campaign ${p.campaign_id} has no campaign budget, so its bid strategy lives on its ad sets; nothing was changed.`,
      );
    }
    if ((live.bid_strategy ?? null) !== (p.expected_current_bid_strategy ?? null)) {
      throw new ExpectedToolError(
        "meta_ads_bid_strategy_drift",
        `campaign ${p.campaign_id} bid strategy is ${live.bid_strategy ?? "none"} now, not ${p.expected_current_bid_strategy ?? "none"}; nothing was changed.`,
      );
    }
  }

  const req = shapeUpdateCampaignRequest(p, currency);
  assertGraphWriteSucceeded(await fbPost(tenant_id, req.path, req.params), "campaign update");
  const updated_fields = Object.keys(req.params).filter((k) => k !== "special_ad_category_country");
  return { updated_fields, live };
}

export async function metaDeleteCampaign(
  tenant_id: string,
  campaign_id: string,
): Promise<{ before_status: string | null; name: string | null }> {
  const live = await readOwnCampaign(tenant_id, campaign_id);
  const req = shapeDeleteCampaignRequest({ campaign_id });
  assertGraphWriteSucceeded(await fbPost(tenant_id, req.path, req.params), "campaign delete");
  return { before_status: live.status ?? null, name: live.name ?? null };
}
