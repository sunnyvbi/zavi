
export type ServingStatus = { name: string; primary_status: string | null; reasons: string[] };

const REASON_WORDS: Readonly<Record<string, string>> = {
  CAMPAIGN_PAUSED: "the campaign is paused",
  CAMPAIGN_PENDING: "the campaign has not started yet",
  CAMPAIGN_ENDED: "the campaign has ended",
  CAMPAIGN_DRAFT: "the campaign is a draft",
  CAMPAIGN_REMOVED: "the campaign was removed",
  BIDDING_STRATEGY_MISCONFIGURED: "its bid strategy is set up wrong",
  BIDDING_STRATEGY_LIMITED: "its bid strategy is limited",
  BIDDING_STRATEGY_LEARNING: "its bid strategy is still learning",
  BIDDING_STRATEGY_CONSTRAINED: "its bid target is too strict to win auctions",
  BUDGET_CONSTRAINED: "its budget is too small",
  BUDGET_MISCONFIGURED: "its budget is set up wrong",
  SEARCH_VOLUME_LIMITED: "too few people search for its keywords",
  AD_GROUPS_PAUSED: "its ad groups are paused",
  NO_AD_GROUPS: "it has no ad groups",
  KEYWORDS_PAUSED: "its keywords are paused",
  NO_KEYWORDS: "it has no keywords",
  AD_GROUP_ADS_PAUSED: "its ads are paused",
  NO_AD_GROUP_ADS: "it has no ads",
  HAS_ADS_LIMITED_BY_POLICY: "some ads are limited by Google's policies",
  HAS_ADS_DISAPPROVED: "its ads were disapproved",
  MOST_ADS_UNDER_REVIEW: "its ads are still under review",
  HAS_ASSET_GROUPS_DISAPPROVED: "its asset groups were disapproved",
  HAS_ASSET_GROUPS_LIMITED_BY_POLICY: "some asset groups are limited by Google's policies",
  MOST_ASSET_GROUPS_UNDER_REVIEW: "its asset groups are still under review",
  MISSING_CALL_EXTENSION: "it needs a call asset",
  MISSING_LEAD_FORM_EXTENSION: "it needs a lead form",
  CAMPAIGN_GROUP_PAUSED: "its campaign group is paused",
};

export function servingReasonWords(reasons: readonly string[]): string[] {
  return [...new Set(reasons.filter((r) => r && r !== "UNSPECIFIED" && r !== "UNKNOWN").map((r) => REASON_WORDS[r] ?? r.toLowerCase().replace(/_/g, " ")))];
}

export function servingWhy(s: Pick<ServingStatus, "primary_status" | "reasons">): string {
  const words = servingReasonWords(s.reasons);
  if (words.length) return words.join("; ");
  return s.primary_status ? `Google lists it as ${s.primary_status.toLowerCase().replace(/_/g, " ")}, with no reason given` : "Google gave no reason";
}

export async function readEnabledServing(tenant_id: string): Promise<Map<string, ServingStatus>> {
  const { gadsSearch } = await import("./_client");
  const rows = (await gadsSearch(
    tenant_id,
    "SELECT campaign.id, campaign.name, campaign.primary_status, campaign.primary_status_reasons FROM campaign WHERE campaign.status = 'ENABLED'",
    { complete: true },
  )) as Array<{ campaign?: { id?: string | number; name?: string; primaryStatus?: string; primaryStatusReasons?: string[] } }>;
  const out = new Map<string, ServingStatus>();
  for (const r of rows) {
    const id = r.campaign?.id != null ? String(r.campaign.id) : "";
    if (!/^\d+$/.test(id)) continue;
    out.set(id, {
      name: r.campaign?.name ?? "",
      primary_status: r.campaign?.primaryStatus ?? null,
      reasons: Array.isArray(r.campaign?.primaryStatusReasons) ? r.campaign!.primaryStatusReasons!.map(String) : [],
    });
  }
  return out;
}
