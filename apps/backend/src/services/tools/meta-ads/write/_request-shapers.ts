
import { ExpectedToolError } from "@/services/tools/types";
import { toBudgetMinorUnits } from "./_helpers";
import {
  assertTargetingInterestIds,
  assertTargetingGeo,
  assertTargetingPlacements,
  checkPromotedObjectForGoal,
  type PromotedObject,
  withAudienceMode,
} from "./_targeting-validate";
import { BID_AMOUNT_STRATEGIES, checkCampaignAdSetBid, checkNewAdSetBid, type MetaBidStrategy } from "./_decision-bodies";

type ShapedRequest = { path: string; params: Record<string, string> };

export function shapeUpdateAdSetBudgetRequest(
  input: { ad_set_id: string; daily_budget_usd: number },
  currency: string,
): ShapedRequest {
  if (!input.ad_set_id || !input.ad_set_id.trim()) {
    throw new ExpectedToolError(
      "meta_ads_invalid_target",
      "ad_set_id is required",
    );
  }
  const minor = toBudgetMinorUnits(input.daily_budget_usd, currency);
  return {
    path: input.ad_set_id,
    params: { daily_budget: String(minor) },
  };
}

export function shapeUpdateCampaignBudgetRequest(
  input: { campaign_id: string; daily_budget_usd: number },
  currency: string,
): ShapedRequest {
  if (!input.campaign_id || !input.campaign_id.trim()) {
    throw new ExpectedToolError("meta_ads_invalid_target", "campaign_id is required");
  }
  const minor = toBudgetMinorUnits(input.daily_budget_usd, currency);
  return {
    path: input.campaign_id,
    params: { daily_budget: String(minor) },
  };
}

const VALID_STATUSES = new Set(["ACTIVE", "PAUSED"]);
const VALID_LEVELS = new Set(["campaign", "adset", "ad"]);

export function shapeSetStatusRequest(input: {
  object_id: string;
  level: "campaign" | "adset" | "ad";
  status: "ACTIVE" | "PAUSED";
}): ShapedRequest {
  if (!input.object_id || !input.object_id.trim()) {
    throw new ExpectedToolError(
      "meta_ads_invalid_target",
      "object_id is required",
    );
  }
  if (!VALID_LEVELS.has(input.level)) {
    throw new ExpectedToolError(
      "meta_ads_invalid_level",
      `level must be one of campaign|adset|ad; got ${input.level}`,
    );
  }
  if (!VALID_STATUSES.has(input.status)) {
    throw new ExpectedToolError(
      "meta_ads_invalid_status",
      `status must be one of ACTIVE|PAUSED; got ${input.status}`,
    );
  }
  return {
    path: input.object_id,
    params: { status: input.status },
  };
}

export const ROAS_FLOOR_SCALE = 10000;

export function shapeCreateAdSetRequest(
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
  currency: string,
  ad_account_id: string,
): ShapedRequest {
  if (!input.campaign_id || !input.campaign_id.trim()) {
    throw new ExpectedToolError(
      "meta_ads_invalid_target",
      "campaign_id is required",
    );
  }
  if (!input.name || !input.name.trim()) {
    throw new ExpectedToolError(
      "meta_ads_invalid_name",
      "ad set name is required",
    );
  }
  const goalErr = checkPromotedObjectForGoal(input.optimization_goal, input.promoted_object);
  if (goalErr) {
    throw new ExpectedToolError("meta_ads_missing_promoted_object", goalErr);
  }
  assertTargetingInterestIds(input.targeting);
  assertTargetingGeo(input.targeting);
  assertTargetingPlacements(input.targeting);
  const bidErr = input.campaign_bid_strategy !== undefined
    ? checkCampaignAdSetBid({ ...input, campaign_bid_strategy: input.campaign_bid_strategy })
    : input.roas_floor !== undefined
      ? "a ROAS floor comes only with the campaign's minimum-ROAS strategy"
      : checkNewAdSetBid(input.bid_strategy, input.bid_amount_usd);
  if (bidErr) throw new ExpectedToolError("meta_ads_invalid_bid", bidErr);

  const minor = toBudgetMinorUnits(input.daily_budget_usd, currency);
  const status = input.status ?? "PAUSED";
  if (!VALID_STATUSES.has(status)) {
    throw new ExpectedToolError(
      "meta_ads_invalid_status",
      `status must be one of ACTIVE|PAUSED; got ${status}`,
    );
  }
  return {
    path: `${ad_account_id}/adsets`,
    params: {
      campaign_id: input.campaign_id,
      name: input.name,
      daily_budget: String(minor),
      optimization_goal: input.optimization_goal,
      billing_event: input.billing_event,
      targeting: JSON.stringify(withAudienceMode(input.targeting)),
      ...(input.promoted_object
        ? { promoted_object: JSON.stringify(input.promoted_object) }
        : {}),
      ...(input.campaign_bid_strategy !== undefined ? campaignAdSetBidParams(input, currency) : bidParams(input, currency)),
      status,
    },
  };
}

export function bidParams(
  input: { bid_strategy?: MetaBidStrategy; bid_amount_usd?: number },
  currency: string,
): Record<string, string> {
  return {
    ...(input.bid_strategy ? { bid_strategy: input.bid_strategy } : {}),
    ...(input.bid_amount_usd !== undefined ? { bid_amount: String(toBudgetMinorUnits(input.bid_amount_usd, currency)) } : {}),
  };
}

function campaignAdSetBidParams(
  input: { campaign_bid_strategy?: MetaBidStrategy; bid_amount_usd?: number; roas_floor?: number },
  currency: string,
): Record<string, string> {
  if (input.campaign_bid_strategy === "LOWEST_COST_WITH_MIN_ROAS" && input.roas_floor !== undefined) {
    return { bid_constraints: JSON.stringify({ roas_average_floor: Math.round(input.roas_floor * ROAS_FLOOR_SCALE) }) };
  }
  if (input.campaign_bid_strategy && BID_AMOUNT_STRATEGIES.has(input.campaign_bid_strategy) && input.bid_amount_usd !== undefined) {
    return { bid_amount: String(toBudgetMinorUnits(input.bid_amount_usd, currency)) };
  }
  return {};
}

export const META_REMOVE_SPEND_CAP = "922337203685478";

export function shapeCreateCampaignRequest(
  input: {
    ad_account_id: string;
    name: string;
    objective: string;
    special_ad_categories: string[];
    special_ad_category_country?: string[];
    daily_budget_usd?: number;
    bid_strategy?: string;
  },
  currency: string,
): ShapedRequest {
  if (!/^act_\d+$/.test(input.ad_account_id)) {
    throw new ExpectedToolError("meta_ads_invalid_target", "ad_account_id must look like act_<digits>");
  }
  const params: Record<string, string> = {
    name: input.name,
    objective: input.objective,
    status: "PAUSED",
    special_ad_categories: JSON.stringify(input.special_ad_categories),
  };
  if (input.special_ad_categories.length > 0 && input.special_ad_category_country?.length) {
    params.special_ad_category_country = JSON.stringify(input.special_ad_category_country);
  }
  if (input.daily_budget_usd !== undefined) {
    params.daily_budget = String(toBudgetMinorUnits(input.daily_budget_usd, currency));
    params.bid_strategy = input.bid_strategy ?? "LOWEST_COST_WITHOUT_CAP";
  } else {
    if (input.bid_strategy) {
      throw new ExpectedToolError("meta_ads_invalid_target", "a campaign bid strategy needs a campaign daily budget");
    }
    params.is_adset_budget_sharing_enabled = "false";
  }
  return { path: `${input.ad_account_id}/campaigns`, params };
}

export function shapeUpdateCampaignRequest(
  input: {
    campaign_id: string;
    new_name?: string;
    spend_cap_usd?: number | null;
    bid_strategy?: string;
    special_ad_categories?: string[];
    special_ad_category_country?: string[];
  },
  currency: string,
): ShapedRequest {
  if (!/^\d{5,25}$/.test(input.campaign_id)) {
    throw new ExpectedToolError("meta_ads_invalid_target", "campaign_id must be a Meta object id");
  }
  const params: Record<string, string> = {};
  if (input.new_name !== undefined) params.name = input.new_name;
  if (input.spend_cap_usd === null) params.spend_cap = META_REMOVE_SPEND_CAP;
  else if (input.spend_cap_usd !== undefined) params.spend_cap = String(toBudgetMinorUnits(input.spend_cap_usd, currency));
  if (input.bid_strategy !== undefined) params.bid_strategy = input.bid_strategy;
  if (input.special_ad_categories !== undefined) {
    params.special_ad_categories = JSON.stringify(input.special_ad_categories);
    if (input.special_ad_categories.length > 0 && input.special_ad_category_country?.length) {
      params.special_ad_category_country = JSON.stringify(input.special_ad_category_country);
    }
  }
  if (Object.keys(params).length === 0) {
    throw new ExpectedToolError("meta_ads_invalid_target", "nothing to change on the campaign");
  }
  return { path: input.campaign_id, params };
}

export function shapeDeleteCampaignRequest(input: { campaign_id: string }): ShapedRequest {
  if (!/^\d{5,25}$/.test(input.campaign_id)) {
    throw new ExpectedToolError("meta_ads_invalid_target", "campaign_id must be a Meta object id");
  }
  return { path: input.campaign_id, params: { status: "DELETED" } };
}
