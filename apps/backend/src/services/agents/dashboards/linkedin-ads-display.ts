import { linkedinCampaignChangeStamp } from "@/services/connectors/linkedin-ads/display-stamp";
import { withLinkedInDisplayReads } from "@/services/connectors/linkedin-ads/http";
import type { DashboardBuilder } from "@/routes/agents/dashboards/_contract";
import { build as buildDashboard } from "@/routes/agents/dashboards/linkedin-ads";

export const build: DashboardBuilder = async (c) => {
  const stamp = await linkedinCampaignChangeStamp(c.tenantId);
  return withLinkedInDisplayReads({ refresh: Boolean(c.refresh || c.meteredRefresh), stamp }, () => buildDashboard(c));
};
