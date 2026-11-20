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
  customRangeSchema,
  dateClause,
  dateRangeSchema,
  micros,
  numericIdOrThrow,
  round2,
} from "./_shared";

const GAQL_ROW_LIMIT = 500;

const inputSchema = z.object({
  campaign_id: z.string().regex(/^[0-9]+$/).optional(),
  ad_group_id: z.string().regex(/^[0-9]+$/).optional(),
  date_range: dateRangeSchema.default("LAST_30_DAYS"),
  custom_range: customRangeSchema,
  include_negatives: z.boolean().default(false),
});

type Row = {
  campaign?: { id?: string; name?: string };
  adGroup?: { id?: string; name?: string };
  adGroupCriterion?: {
    criterionId?: string;
    status?: string;
    negative?: boolean;
    keyword?: { text?: string; matchType?: string };
    qualityInfo?: { qualityScore?: number };
    cpcBidMicros?: string;
  };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: string;
    allConversions?: string;
    conversionsValue?: string;
    ctr?: string;
    averageCpc?: string;
  };
};

export const listKeywordsTool: ToolSpec = {
  name: "google_ads_list_keywords",
  effect: "read",
  description:
    "List the keywords in a Google Ads campaign or ad group with criterion id, match type, status, Quality Score, bid, and spend / impressions / clicks / CTR / avg CPC / conversions for the window. Search ad groups only (Performance Max has no keywords). Pass campaign_id or ad_group_id. The criterion_id is what google_ads__propose_removal needs to remove a keyword. Throws google_ads_not_connected if OAuth is not wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { campaign_id, ad_group_id, date_range, custom_range, include_negatives } = inputSchema.parse(input);
    if (!campaign_id && !ad_group_id) {
      throw new Error("pass campaign_id or ad_group_id");
    }
    const filters = [
      dateClause(date_range, custom_range),
      "ad_group_criterion.type = 'KEYWORD'",
      "ad_group_criterion.status != 'REMOVED'",
      ...(include_negatives ? [] : ["ad_group_criterion.negative = FALSE"]),
      ...(campaign_id ? [`campaign.id = ${numericIdOrThrow("campaign_id", campaign_id)}`] : []),
      ...(ad_group_id ? [`ad_group.id = ${numericIdOrThrow("ad_group_id", ad_group_id)}`] : []),
    ];
    const query = `
      SELECT
        campaign.id,
        campaign.name,
        ad_group.id,
        ad_group.name,
        ad_group_criterion.criterion_id,
        ad_group_criterion.status,
        ad_group_criterion.negative,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        ad_group_criterion.quality_info.quality_score,
        ad_group_criterion.cpc_bid_micros,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.all_conversions,
        metrics.conversions_value,
        metrics.ctr,
        metrics.average_cpc
      FROM keyword_view
      WHERE ${filters.join("\n        AND ")}
      ORDER BY metrics.cost_micros DESC
      LIMIT ${GAQL_ROW_LIMIT}
    `;
    const rows = (await gadsSearch(ctx.tenant_id, query)) as Row[];
    const keywords = rows.map((r) => {
      const c = r.adGroupCriterion;
      const cost = Number(r.metrics?.costMicros ?? 0) / 1_000_000;
      const conv = Number(r.metrics?.conversions ?? 0);
      return {
        criterion_id: c?.criterionId ?? "",
        text: c?.keyword?.text ?? "",
        match_type: c?.keyword?.matchType ?? "",
        status: c?.status ?? "",
        negative: c?.negative === true,
        quality_score: c?.qualityInfo?.qualityScore ?? null,
        cpc_bid_usd: c?.cpcBidMicros == null ? null : micros(c.cpcBidMicros),
        campaign_id: r.campaign?.id ?? "",
        campaign_name: r.campaign?.name ?? "",
        ad_group_id: r.adGroup?.id ?? "",
        ad_group_name: r.adGroup?.name ?? "",
        spend_usd: round2(cost),
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
        ctr: Number(r.metrics?.ctr ?? 0),
        avg_cpc_usd: micros(r.metrics?.averageCpc),
        conversions: round2(conv),
        all_conversions: round2(Number(r.metrics?.allConversions ?? 0)),
        conversions_value_usd: round2(Number(r.metrics?.conversionsValue ?? 0)),
        cpa_usd: conv > 0 ? round2(cost / conv) : null,
      };
    });
    const complete = keywords.length < GAQL_ROW_LIMIT;
    return {
      waste: buildWaste(keywords, {
        labelFields: ["text"],
        spendField: "spend_usd",
        conversionFields: GOOGLE_CONVERSION_FIELDS,
        secondaryField: GOOGLE_SECONDARY_OUTCOME,
        outcomeLabel: GOOGLE_OUTCOME_LABEL,
        window: custom_range ? `${custom_range.since}..${custom_range.until}` : date_range,
        entity: "keywords",
        complete: complete,
        currency: "account currency",
      }),
      totals: buildTotals(keywords, {
        sum: ["spend_usd", "impressions", "clicks", "conversions", "all_conversions"],
        ratios: { cpa_usd: ["spend_usd", "conversions"] },
        scope: `${keywords.length} keywords · ${date_range}`,
        complete,
        note: complete ? undefined : `Row cap of ${GAQL_ROW_LIMIT} hit; more keywords exist.`,
      }),
      conversion_columns: CONVERSION_COLUMNS_NOTE,
      keywords,
      date_range,
    };
  },
};
