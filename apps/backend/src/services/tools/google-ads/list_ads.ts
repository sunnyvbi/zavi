import { z } from "zod";
import { gadsSearch } from "./_client";
import type { ToolSpec } from "@/services/tools/types";
import { buildTotals } from "@/services/tools/_shared/totals";
import { customRangeSchema, dateClause, dateRangeSchema, numericIdOrThrow, round2 } from "./_shared";

const GAQL_ROW_LIMIT = 200;

const inputSchema = z.object({
  campaign_id: z.string().regex(/^[0-9]+$/).optional(),
  ad_group_id: z.string().regex(/^[0-9]+$/).optional(),
  date_range: dateRangeSchema.default("LAST_30_DAYS"),
  custom_range: customRangeSchema,
  include_removed: z.boolean().default(false),
});

type Row = {
  campaign?: { id?: string; name?: string };
  adGroup?: { id?: string; name?: string; type?: string };
  adGroupAd?: {
    status?: string;
    adStrength?: string;
    policySummary?: { approvalStatus?: string };
    ad?: {
      id?: string;
      name?: string;
      type?: string;
      finalUrls?: string[];
      responsiveSearchAd?: { headlines?: Array<{ text?: string }>; descriptions?: Array<{ text?: string }> };
      videoResponsiveAd?: { headlines?: Array<{ text?: string }>; videos?: Array<{ asset?: string }> };
      videoAd?: { video?: { asset?: string } };
    };
  };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: string;
    conversionsValue?: string;
    ctr?: string;
  };
};

export const listAdsTool: ToolSpec = {
  name: "google_ads_list_ads",
  effect: "read",
  description:
    "List the ads in a Google Ads campaign or ad group: id, type (RESPONSIVE_SEARCH_AD, VIDEO_RESPONSIVE_AD, VIDEO_TRUEVIEW_IN_STREAM_AD, …), status, policy approval, ad strength, final URLs, the headline/description copy for responsive search ads, the video asset for video ads, and spend / impressions / clicks / CTR / conversions for the window. Pass at least one of campaign_id or ad_group_id (from a fresh google_ads__list_campaigns / list_ad_groups this turn). Throws google_ads_not_connected if OAuth is not wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { campaign_id, ad_group_id, date_range, custom_range, include_removed } = inputSchema.parse(input);
    if (!campaign_id && !ad_group_id) {
      throw new Error("pass campaign_id or ad_group_id");
    }
    const filters = [
      dateClause(date_range, custom_range),
      ...(campaign_id ? [`campaign.id = ${numericIdOrThrow("campaign_id", campaign_id)}`] : []),
      ...(ad_group_id ? [`ad_group.id = ${numericIdOrThrow("ad_group_id", ad_group_id)}`] : []),
      ...(include_removed ? [] : ["ad_group_ad.status != 'REMOVED'"]),
    ];
    const query = `
      SELECT
        campaign.id,
        campaign.name,
        ad_group.id,
        ad_group.name,
        ad_group.type,
        ad_group_ad.status,
        ad_group_ad.ad_strength,
        ad_group_ad.policy_summary.approval_status,
        ad_group_ad.ad.id,
        ad_group_ad.ad.name,
        ad_group_ad.ad.type,
        ad_group_ad.ad.final_urls,
        ad_group_ad.ad.responsive_search_ad.headlines,
        ad_group_ad.ad.responsive_search_ad.descriptions,
        ad_group_ad.ad.video_responsive_ad.headlines,
        ad_group_ad.ad.video_responsive_ad.videos,
        ad_group_ad.ad.video_ad.video.asset,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.conversions_value,
        metrics.ctr
      FROM ad_group_ad
      WHERE ${filters.join("\n        AND ")}
      ORDER BY metrics.cost_micros DESC
      LIMIT ${GAQL_ROW_LIMIT}
    `;
    const rows = (await gadsSearch(ctx.tenant_id, query)) as Row[];
    const ads = rows.map((r) => {
      const ad = r.adGroupAd?.ad;
      const cost = Number(r.metrics?.costMicros ?? 0) / 1_000_000;
      const conv = Number(r.metrics?.conversions ?? 0);
      const convValue = Number(r.metrics?.conversionsValue ?? 0);
      return {
        ad_id: ad?.id ?? "",
        ad_name: ad?.name ?? null,
        ad_type: ad?.type ?? null,
        status: r.adGroupAd?.status ?? "",
        approval_status: r.adGroupAd?.policySummary?.approvalStatus ?? null,
        ad_strength: r.adGroupAd?.adStrength ?? null,
        campaign_id: r.campaign?.id ?? "",
        campaign_name: r.campaign?.name ?? "",
        ad_group_id: r.adGroup?.id ?? "",
        ad_group_name: r.adGroup?.name ?? "",
        ad_group_type: r.adGroup?.type ?? null,
        final_urls: ad?.finalUrls ?? [],
        headlines: texts(ad?.responsiveSearchAd?.headlines ?? ad?.videoResponsiveAd?.headlines),
        descriptions: texts(ad?.responsiveSearchAd?.descriptions),
        video_assets: [
          ...(ad?.videoResponsiveAd?.videos ?? []).map((v) => v.asset ?? ""),
          ...(ad?.videoAd?.video?.asset ? [ad.videoAd.video.asset] : []),
        ].filter(Boolean),
        spend_usd: round2(cost),
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
        ctr: Number(r.metrics?.ctr ?? 0),
        conversions: round2(conv),
        conversions_value_usd: round2(convValue),
        cpa_usd: conv > 0 ? round2(cost / conv) : null,
        roas: cost > 0 ? round2(convValue / cost) : null,
      };
    });
    const complete = ads.length < GAQL_ROW_LIMIT;
    return {
      totals: buildTotals(ads, {
        sum: ["spend_usd", "impressions", "clicks", "conversions", "conversions_value_usd"],
        ratios: { cpa_usd: ["spend_usd", "conversions"], roas: ["conversions_value_usd", "spend_usd"] },
        scope: `${ads.length} ads · ${date_range}`,
        complete,
        note: complete ? undefined : `Row cap of ${GAQL_ROW_LIMIT} hit; more ads exist.`,
      }),
      ads,
      date_range,
    };
  },
};

function texts(items: Array<{ text?: string }> | undefined): string[] {
  return (items ?? []).map((i) => i.text ?? "").filter(Boolean);
}
