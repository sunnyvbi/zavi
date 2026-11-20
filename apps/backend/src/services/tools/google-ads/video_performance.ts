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
  numericIdOrThrow,
  type VideoMetricsRow,
} from "./_shared";

const GAQL_ROW_LIMIT = 300;

const inputSchema = z.object({
  date_range: dateRangeSchema.default("LAST_30_DAYS"),
  custom_range: customRangeSchema,
  campaign_id: z.string().regex(/^[0-9]+$/).optional().describe("Restrict to one campaign."),
  ad_group_id: z.string().regex(/^[0-9]+$/).optional().describe("Restrict to one ad group."),
});

type Row = {
  video?: { id?: string; title?: string; durationMillis?: string; channelId?: string };
  campaign?: { id?: string; name?: string; advertisingChannelType?: string };
  adGroup?: { id?: string; name?: string; type?: string };
  adGroupAd?: { ad?: { id?: string }; status?: string };
  metrics?: VideoMetricsRow;
};

export const videoPerformanceTool: ToolSpec = {
  name: "google_ads_video_performance",
  effect: "read",
  description:
    "Per-VIDEO paid performance from the Google Ads `video` report: each YouTube video that ran as an ad, with its title, length, the campaign / ad group / ad it ran in, and video views, view rate, average CPV, quartile completion, engagements, view-through conversions, spend and conversions. This is the read that says which CREATIVE is working. Throws google_ads_not_connected if OAuth is not wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { date_range, custom_range, campaign_id, ad_group_id } = inputSchema.parse(input);
    const filters = [
      dateClause(date_range, custom_range),
      ...(campaign_id ? [`campaign.id = ${numericIdOrThrow("campaign_id", campaign_id)}`] : []),
      ...(ad_group_id ? [`ad_group.id = ${numericIdOrThrow("ad_group_id", ad_group_id)}`] : []),
    ];
    const query = `
      SELECT
        video.id,
        video.title,
        video.duration_millis,
        video.channel_id,
        campaign.id,
        campaign.name,
        campaign.advertising_channel_type,
        ad_group.id,
        ad_group.name,
        ad_group.type,
        ad_group_ad.ad.id,
        ad_group_ad.status,
        ${VIDEO_METRIC_FIELDS.join(",\n        ")}
      FROM video
      WHERE ${filters.join("\n        AND ")}
      ORDER BY metrics.cost_micros DESC
      LIMIT ${GAQL_ROW_LIMIT}
    `;
    const rows = (await gadsSearch(ctx.tenant_id, query)) as Row[];
    const videos = rows.map((r) => ({
      video_id: r.video?.id ?? "",
      title: r.video?.title ?? "",
      duration_seconds: r.video?.durationMillis == null ? null : Math.round(Number(r.video.durationMillis) / 1000),
      channel_id: r.video?.channelId ?? null,
      campaign_id: r.campaign?.id ?? "",
      campaign_name: r.campaign?.name ?? "",
      channel_type: r.campaign?.advertisingChannelType ?? null,
      ad_group_id: r.adGroup?.id ?? "",
      ad_group_name: r.adGroup?.name ?? "",
      ad_group_type: r.adGroup?.type ?? null,
      ad_id: r.adGroupAd?.ad?.id ?? null,
      ad_status: r.adGroupAd?.status ?? null,
      ...mapVideoMetrics(r.metrics),
    }));
    const complete = videos.length < GAQL_ROW_LIMIT;
    return {
      totals: buildTotals(videos, {
        sum: ["spend_usd", "impressions", "video_views", "conversions"],
        ratios: {
          view_rate: ["video_views", "impressions"],
          avg_cpv_usd: ["spend_usd", "video_views"],
          cpa_usd: ["spend_usd", "conversions"],
        },
        scope: `${videos.length} video rows · ${date_range}`,
        complete,
        note: complete ? undefined : `Row cap of ${GAQL_ROW_LIMIT} hit; more rows exist.`,
      }),
      videos,
      date_range,
    };
  },
};
