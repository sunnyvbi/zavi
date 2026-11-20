
export type ObjectBudgetStamp = { object_daily_budget?: number; object_status?: string; currency?: string };

export async function metaObjectDailyBudget(tenant_id: string, object_id: string): Promise<ObjectBudgetStamp> {
  try {
    const { fbGet, getAdAccountCurrency } = await import("@/services/tools/meta-ads/_client");
    const { minorUnitsPerMajor } = await import("@/services/tools/meta-ads/write/_currency");
    const r = (await fbGet(tenant_id, object_id, { fields: "status,daily_budget" })) as { status?: string; daily_budget?: string };
    if (typeof r?.status !== "string" || r.status === "") return {};
    const minor = typeof r.daily_budget === "string" && r.daily_budget !== "" ? Number(r.daily_budget) : NaN;
    if (!Number.isFinite(minor) || minor <= 0) return {};
    const currency = await getAdAccountCurrency(tenant_id);
    return { object_daily_budget: minor / minorUnitsPerMajor(currency), object_status: r.status, currency };
  } catch {
    return {};
  }
}

export async function googleCampaignDailyBudget(tenant_id: string, campaign_id: string): Promise<ObjectBudgetStamp> {
  try {
    const { gadsGetCampaignBudget } = await import("@/services/tools/google-ads/_client");
    const { readExclusiveCampaignDailyBudgetUsd } = await import("@/services/tools/google-ads/write/_stake-budget");
    const live = await gadsGetCampaignBudget(tenant_id, campaign_id);
    if (typeof live?.campaign_status !== "string" || live.campaign_status === "") return {};
    const daily = await readExclusiveCampaignDailyBudgetUsd(tenant_id, campaign_id, { getBudget: async () => live });
    return daily !== null && daily > 0 ? { object_daily_budget: daily, object_status: live.campaign_status } : {};
  } catch {
    return {};
  }
}
