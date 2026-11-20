import type { MetaMetricSnapshot } from "@/services/growth/action-outcomes";
import { withLinkedInAdsToken } from "./client";
import { linkedinAdsGet, type LinkedInPage } from "./http";

type Row = { costInLocalCurrency?: string; impressions?: number; externalWebsiteConversions?: number; oneClickLeads?: number; conversionValueInLocalCurrency?: string };

const ymdParts = (s: string) => {
  const [year, month, day] = s.split("-").map(Number);
  return { year, month, day };
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function readLinkedInCampaignSnapshotWithToken(token: string, campaignId: string, since: string, until: string): Promise<MetaMetricSnapshot | null> {
  if (!/^\d{1,20}$/.test(campaignId) || !/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return null;
  const page = await linkedinAdsGet<LinkedInPage<Row>>(
    token,
    "adAnalytics",
    { q: "analytics", pivot: "CAMPAIGN", timeGranularity: "ALL", dateRange: { start: ymdParts(since), end: ymdParts(until) }, campaigns: [`urn:li:sponsoredCampaign:${campaignId}`] },
    { fields: "costInLocalCurrency,impressions,externalWebsiteConversions,oneClickLeads,conversionValueInLocalCurrency,pivotValues" },
    { fresh: true },
  );
  const row = Array.isArray(page.elements) ? page.elements[0] : undefined;
  if (!row) return null;
  const spend = Number(row.costInLocalCurrency ?? 0);
  const value = Number(row.conversionValueInLocalCurrency ?? 0);
  const conversions = (row.externalWebsiteConversions ?? 0) + (row.oneClickLeads ?? 0);
  return {
    spend: round2(Number.isFinite(spend) ? spend : 0),
    roas: spend > 0 && Number.isFinite(value) ? round2(value / spend) : null,
    conversions,
    purchase_value: Number.isFinite(value) ? round2(value) : null,
    impressions: row.impressions ?? 0,
  };
}

export async function readLinkedInSnapshot(tenantId: string, subjectId: string, since: string, until: string): Promise<MetaMetricSnapshot | null> {
  if (!/^\d{1,20}$/.test(subjectId)) return null;
  const { findCampaignBinding } = await import("@/services/ads-wallet/bindings");
  const bound = await findCampaignBinding(tenantId, "linkedin", subjectId);
  if (bound?.funding_source === "wallet") {
    const { linkedinCampaign } = await import("@/services/ads-wallet/adapters/linkedin");
    const { token } = await linkedinCampaign(tenantId, bound.id);
    return readLinkedInCampaignSnapshotWithToken(token, subjectId, since, until);
  }
  return withLinkedInAdsToken(tenantId, (token) => readLinkedInCampaignSnapshotWithToken(token, subjectId, since, until));
}
