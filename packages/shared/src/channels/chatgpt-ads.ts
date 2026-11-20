import type { CampaignMetrics, ManagedCampaign, ManagedAdEntity, ManagedCampaignDashboard } from "./managed-campaigns";
export * from "./managed-campaigns";
export type ChatgptAdsMetrics = CampaignMetrics;
export type ChatgptCampaign = ManagedCampaign;
export type ChatgptAdEntity = ManagedAdEntity;
export type ChatgptAdsDashboard = ManagedCampaignDashboard & { source: "chatgpt_ads_api" };
