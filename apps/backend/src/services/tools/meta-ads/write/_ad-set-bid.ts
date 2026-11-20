
import { ExpectedToolError } from "@/services/tools/types";
import { getBoolSetting } from "@/services/settings";
import { fbGetAllPages, getAdAccountCurrency } from "../_client";
import { readOwnCampaign } from "./campaign_writes";
import { ROAS_FLOOR_SCALE } from "./_request-shapers";
import { minorToMajor, minorUnitsPerMajor } from "./_currency";
import { BID_AMOUNT_STRATEGIES, metaBidStrategySchema, type CreateAdSetBody, type MetaBidStrategy } from "./_decision-bodies";
import type { PromotedObject } from "./_targeting-validate";

export const MIN_ROAS_STRATEGY: MetaBidStrategy = "LOWEST_COST_WITH_MIN_ROAS";

export type SiblingBidRow = {
  status?: string | null;
  effective_status?: string | null;
  optimization_goal?: string | null;
  promoted_object?: Record<string, unknown> | null;
  bid_amount?: string | number | null;
  bid_constraints?: { roas_average_floor?: string | number | null } | null;
};

export type CampaignStrategy = MetaBidStrategy | null;

export function parseCampaignStrategy(raw: unknown): CampaignStrategy {
  if (raw == null || raw === "") return null;
  const p = metaBidStrategySchema.safeParse(raw);
  if (!p.success) {
    throw new ExpectedToolError(
      "meta_ads_bid_unknown_strategy",
      `the campaign uses bid strategy ${String(raw)}, which Zavi cannot create ad sets under yet; nothing was sent`,
    );
  }
  return p.data;
}

export function campaignNeedsAdSetBid(s: CampaignStrategy): boolean {
  return s !== null && (BID_AMOUNT_STRATEGIES.has(s) || s === MIN_ROAS_STRATEGY);
}

const GONE = new Set(["DELETED", "ARCHIVED"]);

const RESULT_FIELDS = ["pixel_id", "custom_event_type", "custom_event_str", "custom_conversion_id", "application_id", "object_store_url", "page_id"] as const;

function resultKey(goal: string | null | undefined, po: Record<string, unknown> | null | undefined): string {
  const parts = RESULT_FIELDS.map((k) => {
    const v = po?.[k];
    return v == null || v === "" ? "" : String(v).trim().toUpperCase();
  });
  return [String(goal ?? "").toUpperCase(), ...parts].join("|");
}

export function resultLabel(goal: string, po: PromotedObject | undefined): string {
  const ev = po?.custom_event_type;
  const raw = ev && ev !== "OTHER" ? ev : po?.custom_conversion_id ? "custom conversion" : goal;
  const words = raw.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const positiveInt = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function pickSiblingBid(
  strategy: MetaBidStrategy,
  siblings: readonly SiblingBidRow[],
  goal: string,
  promoted_object: PromotedObject | undefined,
): { value: number; ad_sets: number } {
  const roas = strategy === MIN_ROAS_STRATEGY;
  const want = resultKey(goal, promoted_object);
  const same = siblings.filter(
    (r) => !GONE.has(String(r.status ?? "")) && !GONE.has(String(r.effective_status ?? "")) && resultKey(r.optimization_goal, r.promoted_object) === want,
  );
  const valueOf = (r: SiblingBidRow) => positiveInt(roas ? r.bid_constraints?.roas_average_floor : r.bid_amount);
  const on = same.filter((r) => r.status === "ACTIVE").map(valueOf).filter((n): n is number => n !== null);
  const pool = on.length > 0 ? on : same.map(valueOf).filter((n): n is number => n !== null);
  if (pool.length === 0) {
    throw new ExpectedToolError(
      "meta_ads_bid_unavailable",
      `this campaign uses ${strategy}, so every ad set in it needs ${roas ? "a minimum ROAS" : "a bid amount"}, and no ad set in it buying the same result (${resultLabel(goal, promoted_object)}) has one to copy. ${roas ? "Pick a campaign that is not on a minimum ROAS." : "Propose it again with bid_amount_usd, the cost per result to aim for."}`,
    );
  }
  const sorted = [...pool].sort((a, b) => a - b);
  return { value: sorted[Math.floor((sorted.length - 1) / 2)]!, ad_sets: pool.length };
}

type CreateDraft = Omit<CreateAdSetBody, "rationale"> & { rationale?: string };

function toMinorExact(amount: number, currency: string | undefined): number {
  let per = 100;
  try {
    if (currency) per = minorUnitsPerMajor(currency);
  } catch {
  }
  return Math.round(amount * per) / per;
}

export async function resolveCreateAdSetBid<T extends CreateDraft>(tenant_id: string, draft: T): Promise<T> {
  const { campaign_bid_strategy: _c, roas_floor: _r, bid_copied_from: _f, ...base } = draft;
  const clean = (base.bid_amount_usd === undefined ? base : { ...base, bid_amount_usd: toMinorExact(base.bid_amount_usd, base.currency) }) as T;
  if (clean.bid_amount_usd !== undefined && !(clean.bid_amount_usd > 0)) {
    throw new ExpectedToolError("meta_ads_invalid_bid", `a bid of ${base.bid_amount_usd} rounds to nothing in whole cents; give a bid of at least one cent`);
  }

  const campaign = await readOwnCampaign(tenant_id, clean.campaign_id);
  const s = parseCampaignStrategy(campaign.bid_strategy);
  if (s === null) return clean;

  if (clean.bid_strategy !== undefined && clean.bid_strategy !== s) {
    throw new ExpectedToolError(
      "meta_ads_bid_conflict",
      `this campaign uses ${s} for all its ad sets, so a new ad set in it cannot use ${clean.bid_strategy}. Propose it without bid_strategy${BID_AMOUNT_STRATEGIES.has(s) ? " (give bid_amount_usd to choose the amount, or leave it out to match the campaign's other ad sets)" : ""}, or pick another campaign.`,
    );
  }
  const { bid_strategy: _b, bid_amount_usd: ownAmount, ...rest } = clean;
  const stamped = { ...rest, campaign_bid_strategy: s } as T;

  if (!campaignNeedsAdSetBid(s)) {
    if (ownAmount !== undefined) {
      throw new ExpectedToolError("meta_ads_bid_conflict", `this campaign uses ${s}, which takes no bid amount on its ad sets; propose it without bid_amount_usd`);
    }
    return stamped;
  }
  if (s !== MIN_ROAS_STRATEGY && ownAmount !== undefined) {
    return { ...stamped, bid_amount_usd: ownAmount };
  }
  if (!(await getBoolSetting("meta_bid_by_strategy_enabled", tenant_id))) {
    throw new ExpectedToolError(
      "meta_ads_bid_unavailable",
      `this campaign uses ${s}, so the ad set needs ${s === MIN_ROAS_STRATEGY ? "a minimum ROAS" : "bid_amount_usd"}, and copying it from the campaign's ad sets is switched off`,
    );
  }
  if (s === MIN_ROAS_STRATEGY && clean.optimization_goal !== "VALUE") {
    throw new ExpectedToolError(
      "meta_ads_bid_unavailable",
      `this campaign uses a minimum ROAS, so its ad sets must optimise for VALUE; this one optimises for ${clean.optimization_goal}`,
    );
  }
  const siblings = await fbGetAllPages<SiblingBidRow>(tenant_id, `${clean.campaign_id}/adsets`, {
    fields: "status,effective_status,optimization_goal,promoted_object,bid_amount,bid_constraints",
    limit: 200,
  });
  const pick = pickSiblingBid(s, siblings, clean.optimization_goal, clean.promoted_object);
  const from = { ad_sets: pick.ad_sets, result: resultLabel(clean.optimization_goal, clean.promoted_object) };
  if (s === MIN_ROAS_STRATEGY) {
    return { ...stamped, roas_floor: pick.value / ROAS_FLOOR_SCALE, bid_copied_from: from };
  }
  const currency = await getAdAccountCurrency(tenant_id);
  const amount = minorToMajor(pick.value, currency);
  if (amount === null || amount <= 0) {
    throw new ExpectedToolError("meta_ads_bid_unavailable", `the campaign's ad sets carry a bid Zavi cannot read in ${currency}; nothing was proposed`);
  }
  return { ...stamped, bid_amount_usd: amount, bid_copied_from: from };
}

export function assertCampaignBidUnchanged(
  liveRaw: unknown,
  body: Pick<CreateAdSetBody, "campaign_bid_strategy" | "bid_strategy">,
): void {
  const refuse = (why: string): never => {
    throw new ExpectedToolError("meta_ads_bid_unavailable", `${why}; nothing was sent. Propose it again so the card shows the bid the campaign needs now.`);
  };
  let live: CampaignStrategy;
  try {
    live = parseCampaignStrategy(liveRaw);
  } catch {
    return refuse(`the campaign now uses bid strategy ${String(liveRaw)}, which Zavi cannot create ad sets under`);
  }
  const approved = body.campaign_bid_strategy;
  if (approved !== undefined) {
    if (live !== approved) refuse(`the campaign's bid strategy is now ${live ?? "set on each ad set"}, not ${approved} as on the approved card`);
    return;
  }
  if (live === null) return;
  if (campaignNeedsAdSetBid(live)) refuse(`the campaign uses ${live}, so the ad set needs a bid, and the approved card showed none`);
  if (body.bid_strategy !== undefined && body.bid_strategy !== live) {
    refuse(`the campaign uses ${live} for all its ad sets, not ${body.bid_strategy} as on the approved card`);
  }
}
