import { z } from "zod";
import { listXCampaignRows, xAdsTenantToken, xCampaignStats, xCampaignsUrl } from "@/services/connectors/x-ads/client";
import { adWindow, costPer, round2, ZERO_AD_SUMS } from "@/services/connectors/core/ad-metrics";
import type { ToolSpec } from "@/services/tools/types";
import { accountIdField } from "./_shared";

const inputSchema = z.object({
  account_id: accountIdField,
  days: z.number().int().min(1).max(90).optional().default(30).describe("Spend window ending yesterday (UTC)."),
  include_deleted: z.boolean().optional().default(false),
});

export const xAdsListCampaignsTool: ToolSpec = {
  name: "x_ads_list_campaigns",
  effect: "read",
  description:
    "List campaigns in one X Ads ad account with status (ACTIVE / PAUSED / DRAFT), whether X is serving it " +
    "and why not, daily and total budget, and spend, impressions, link clicks, conversions and cost per " +
    "conversion over the last `days` days. Read-only — never edits or spends. Get account_id from " +
    "x_ads_list_accounts first.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, days, include_deleted } = inputSchema.parse(input);
    const { period } = adWindow(days);
    const token = await xAdsTenantToken(ctx.tenant_id);
    const rows = await listXCampaignRows(token, account_id, { withDeleted: include_deleted });
    const ids = rows.filter((r) => r.status !== "DRAFT").map((r) => r.campaign_id);
    const report = await xCampaignStats(token, account_id, ids, period.from, period.to);
    const conv = report.conversionsRead;
    const campaigns = rows.map((c) => {
      const s = report.get(c.campaign_id) ?? ZERO_AD_SUMS;
      return {
        ...c,
        ...s,
        spend: round2(s.spend),
        conversions: conv ? s.conversions : null,
        cost_per_conversion: conv ? costPer(s.spend, s.conversions) : null,
      };
    });
    return {
      account_id,
      window: period,
      count: campaigns.length,
      campaigns,
      ...(conv ? {} : { conversions_note: "X would not report conversions for this account, so conversions and cost per conversion are unknown, not zero." }),
      ads_manager_url: xCampaignsUrl(account_id),
    };
  },
};
