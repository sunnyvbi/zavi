import { z } from "zod";
import { gadsSearch } from "./_client";
import type { ToolSpec } from "@/services/tools/types";
import { buildTotals } from "@/services/tools/_shared/totals";
import {
  VIDEO_METRIC_FIELDS,
  customRangeSchema,
  dateClause,
  dateRangeSchema,
  mapVideoMetrics,
  micros,
  type VideoMetricsRow,
} from "./_shared";

const GAQL_ROW_LIMIT = 200;

const inputSchema = z.object({
  date_range: dateRangeSchema.default("LAST_30_DAYS"),
  custom_range: customRangeSchema,
  status: z.enum(["ENABLED", "PAUSED", "REMOVED", "ALL"]).default("ALL"),
});

type Row = {
  campaign?: {
    id?: string;
    name?: string;
    status?: string;
    advertisingChannelType?: string;
    advertisingChannelSubType?: string;
    biddingStrategyType?: string;
  };
  campaignBudget?: { amountMicros?: string };
  metrics?: VideoMetricsRow;
};

export const listVideoCampaignsTool: ToolSpec = {
  name: "google_ads_list_video_campaigns",
  effect: "read",
  description:
    "List the VIDEO and DEMAND_GEN campaigns in the connected Google Ads account WITH video metrics: video views, view rate, average CPV, quartile completion (25/50/75/100%), engagements, view-through conversions, plus spend, impressions, clicks, conversions and ROAS. Filtered on channel_type, never on name. Demand Gen serves YouTube AND Discover/Gmail/Display from one campaign, so a Demand Gen row is not a pure YouTube number — say so. Throws google_ads_not_connected if OAuth is not wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { date_range, custom_range, status } = inputSchema.parse(input);
    const statusFilter = status === "ALL" ? "" : `AND campaign.status = '${status}'`;
    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        campaign.advertising_channel_sub_type,
        campaign.bidding_strategy_type,
        campaign_budget.amount_micros,
        ${VIDEO_METRIC_FIELDS.join(",\n        ")}
      FROM campaign
      WHERE campaign.advertising_channel_type IN ('VIDEO', 'DEMAND_GEN')
        AND ${dateClause(date_range, custom_range)}
        ${statusFilter}
      ORDER BY metrics.cost_micros DESC
      LIMIT ${GAQL_ROW_LIMIT}
    `;
    const rows = (await gadsSearch(ctx.tenant_id, query)) as Row[];
    const campaigns = rows.map((r) => ({
      campaign_id: r.campaign?.id ?? "",
      campaign_name: r.campaign?.name ?? "",
      status: r.campaign?.status ?? "",
      channel_type: r.campaign?.advertisingChannelType ?? null,
      channel_sub_type: r.campaign?.advertisingChannelSubType ?? null,
      bidding_strategy_type: r.campaign?.biddingStrategyType ?? null,
      daily_budget_usd: r.campaignBudget?.amountMicros == null ? null : micros(r.campaignBudget.amountMicros),
      ...mapVideoMetrics(r.metrics),
    }));
    const complete = campaigns.length < GAQL_ROW_LIMIT;
    return {
      totals: buildTotals(campaigns, {
        sum: ["spend_usd", "impressions", "video_views", "conversions", "conversions_value_usd"],
        ratios: {
          view_rate: ["video_views", "impressions"],
          avg_cpv_usd: ["spend_usd", "video_views"],
          cpa_usd: ["spend_usd", "conversions"],
        },
        scope: `${campaigns.length} video campaigns · ${date_range}`,
        complete,
        note: complete ? undefined : `Row cap of ${GAQL_ROW_LIMIT} hit; more campaigns exist.`,
      }),
      campaigns,
      date_range,
      surfaces_note:
        "VIDEO rows are YouTube inventory. DEMAND_GEN rows also serve Discover, Gmail and Display; the API does not split them here.",
    };
  },
};
