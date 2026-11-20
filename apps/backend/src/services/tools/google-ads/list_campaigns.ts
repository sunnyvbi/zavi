
import { z } from "zod";
import { gadsSearch } from "./_client";
import type { ToolSpec } from "@/services/tools/types";
import { buildTotals } from "@/services/tools/_shared/totals";
import { buildWaste } from "@/services/tools/_shared/waste";
import {
  CONVERSION_COLUMNS_NOTE,
  GOOGLE_CONVERSION_FIELDS,
  GOOGLE_OUTCOME_LABEL,
  GOOGLE_SECONDARY_OUTCOME,
} from "./_shared";

const GAQL_ROW_LIMIT = 200;

const inputSchema = z.object({
  date_range: z
    .enum([
      "LAST_7_DAYS",
      "LAST_14_DAYS",
      "LAST_30_DAYS",
      "THIS_MONTH",
      "LAST_MONTH",
    ])
    .default("LAST_7_DAYS"),
  custom_range: z
    .object({
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
  status: z.enum(["ENABLED", "PAUSED", "REMOVED", "ALL"]).default("ENABLED"),
});

type CampaignRow = {
  campaign?: {
    id?: string;
    name?: string;
    status?: string;
    advertisingChannelType?: string;
    resourceName?: string;
    campaignBudget?: string;
    startDateTime?: string;
    endDateTime?: string;
  };
  campaignBudget?: { amountMicros?: string };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: string;
    allConversions?: string;
    conversionsValue?: string;
    averageCpc?: string;
    ctr?: string;
    averageCpm?: string;
  };
};

export const listCampaignsTool: ToolSpec = {
  name: "google_ads_list_campaigns",
  effect: "read",
  description:
    "List Google Ads campaigns with spend + clicks + conversions + ROAS for the given date range. Each row carries `channel_type` (SEARCH / VIDEO / DEMAND_GEN / PERFORMANCE_MAX / ...), which is the only reliable way to tell which campaigns run on a given surface — never infer that from a campaign name. Pulls live data from the operator's Google Ads account via GAQL. Throws google_ads_not_connected if OAuth + developer-token not yet wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { date_range, custom_range, status } = inputSchema.parse(input);
    const statusFilter =
      status === "ALL" ? "" : `AND campaign.status = '${status}'`;
    const dateClause = custom_range
      ? `segments.date BETWEEN '${custom_range.since}' AND '${custom_range.until}'`
      : `segments.date DURING ${date_range}`;
    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        campaign.start_date_time,
        campaign.end_date_time,
        campaign.campaign_budget,
        campaign_budget.amount_micros,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.all_conversions,
        metrics.conversions_value,
        metrics.average_cpc,
        metrics.ctr,
        metrics.average_cpm
      FROM campaign
      WHERE ${dateClause}
      ${statusFilter}
      ORDER BY metrics.cost_micros DESC
      LIMIT ${GAQL_ROW_LIMIT}
    `;
    const rows = (await gadsSearch(ctx.tenant_id, query)) as CampaignRow[];
    const campaigns = rows.map((r) => {
        const cost = Number(r.metrics?.costMicros ?? 0) / 1_000_000;
        const conv = Number(r.metrics?.conversions ?? 0);
        const convValue = Number(r.metrics?.conversionsValue ?? 0);
        const budgetMicros = r.campaignBudget?.amountMicros;
        return {
          campaign_id: r.campaign?.id ?? "",
          campaign_name: r.campaign?.name ?? "",
          status: r.campaign?.status ?? "",
          channel_type: r.campaign?.advertisingChannelType ?? null,
          start_time: r.campaign?.startDateTime ?? null,
          end_time:
            r.campaign?.endDateTime && r.campaign.endDateTime < "2037-01-01"
              ? r.campaign.endDateTime
              : null,
          daily_budget_usd:
            budgetMicros == null
              ? null
              : round2(Number(budgetMicros) / 1_000_000),
          spend_usd: round2(cost),
          impressions: Number(r.metrics?.impressions ?? 0),
          clicks: Number(r.metrics?.clicks ?? 0),
          ctr: Number(r.metrics?.ctr ?? 0),
          avg_cpc_usd: round2(Number(r.metrics?.averageCpc ?? 0) / 1_000_000),
          cpm_usd: round2(Number(r.metrics?.averageCpm ?? 0) / 1_000_000),
          conversions: round2(conv),
          all_conversions: round2(Number(r.metrics?.allConversions ?? 0)),
          conversions_value_usd: round2(convValue),
          roas: cost > 0 ? round2(convValue / cost) : null,
          cpa_usd: conv > 0 ? round2(cost / conv) : null,
        };
    });
    const complete = campaigns.length < GAQL_ROW_LIMIT;
    return {
      waste: buildWaste(campaigns, {
        labelFields: ["campaign_name"],
        spendField: "spend_usd",
        conversionFields: GOOGLE_CONVERSION_FIELDS,
        secondaryField: GOOGLE_SECONDARY_OUTCOME,
        outcomeLabel: GOOGLE_OUTCOME_LABEL,
        window: custom_range ? `${custom_range.since}..${custom_range.until}` : date_range,
        entity: "campaigns",
        complete: complete,
        currency: "account currency",
      }),
      totals: buildTotals(campaigns, {
        sum: ["spend_usd", "impressions", "clicks", "conversions", "all_conversions", "conversions_value_usd"],
        ratios: {
          roas: ["conversions_value_usd", "spend_usd"],
          cpa_usd: ["spend_usd", "conversions"],
        },
        scope: `${campaigns.length} campaigns · ${date_range}`,
        complete,
        note: complete ? undefined : `Row cap of ${GAQL_ROW_LIMIT} hit; more campaigns exist. PAGE totals, not account totals.`,
      }),
      conversion_columns: CONVERSION_COLUMNS_NOTE,
      campaigns,
      date_range,
    };
  },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
