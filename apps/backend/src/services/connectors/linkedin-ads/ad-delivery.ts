import type { LinkedInAdState } from "./client";

export type AdDelivery = "serving" | "rejected" | "in_review" | "out_of_budget" | "held" | "no_ads" | "unread";

const adVerdict = (ad: LinkedInAdState): AdDelivery => {
  const review = ad.review_status ?? "";
  if (/REJECT/i.test(review) || ad.hold_reasons.some((r) => /REJECT/i.test(r))) return "rejected";
  if (/PENDING|NEEDS_REVIEW/i.test(review) || ad.hold_reasons.some((r) => /REVIEW/i.test(r))) return "in_review";
  if (ad.hold_reasons.some((r) => /BUDGET/i.test(r))) return "out_of_budget";
  if (ad.is_serving === false || ad.hold_reasons.length) return "held";
  return ad.is_serving === true || /APPROVED/i.test(review) ? "serving" : "unread";
};

export function adDelivery(ads: LinkedInAdState[] | null): { ad_delivery: AdDelivery; ads_not_running: number } {
  if (!ads) return { ad_delivery: "unread", ads_not_running: 0 };
  const verdicts = ads.filter((a) => a.intended_status === "ACTIVE").map(adVerdict);
  if (!verdicts.length) return { ad_delivery: "no_ads", ads_not_running: 0 };
  const running = verdicts.filter((v) => v === "serving").length;
  const worst = (["unread", "out_of_budget", "rejected", "in_review", "held"] as const).find((v) => verdicts.includes(v));
  return { ad_delivery: running ? "serving" : (worst as AdDelivery), ads_not_running: verdicts.filter((v) => v !== "serving" && v !== "unread").length };
}

export async function adStatesByCampaign(rows: ReadonlyArray<{ id: string; status: string | null }>, read: (ids: string[]) => Promise<LinkedInAdState[]>): Promise<Map<string, LinkedInAdState[]> | null> {
  const ids = rows.filter((r) => r.status === "ACTIVE").map((r) => r.id);
  const byCampaign = new Map<string, LinkedInAdState[]>(ids.map((id) => [id, []]));
  if (!ids.length) return byCampaign;
  try {
    for (const ad of await read(ids)) byCampaign.get(ad.campaign_id)?.push(ad);
    return byCampaign;
  } catch {
    return null;
  }
}

export type CampaignDelivery = { delivery: AdDelivery | "not_on"; delivery_note: string };

const DELIVERY_NOTE: Record<CampaignDelivery["delivery"], string> = {
  serving: "An ad is serving, so this campaign can be called spending. Take any amount from linkedin_ads_read_analytics.",
  in_review: "LinkedIn is still reviewing its ads, so it is not delivering. Say it is waiting on ad review, never that it is spending.",
  rejected: "LinkedIn rejected its ads, so it is not delivering. Never say it is spending.",
  out_of_budget: "LinkedIn stopped its ads for budget, so it is not delivering now. Never say it is spending.",
  held: "LinkedIn is holding its ads, so it is not delivering now. Never say it is spending.",
  no_ads: "It has no ad switched on, so it cannot deliver. Never say it is spending.",
  unread: "Its ad state could not be read. Say it is spending only if linkedin_ads_read_analytics shows spend.",
  not_on: "This campaign is not on, so it is not spending now.",
};

export function campaignDelivery(status: string | null, ads: LinkedInAdState[] | null): CampaignDelivery {
  const delivery = status === null ? "unread" : status === "ACTIVE" ? adDelivery(ads).ad_delivery : "not_on";
  return { delivery, delivery_note: DELIVERY_NOTE[delivery] };
}
