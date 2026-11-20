
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
  campaign_id: z.string().min(1),
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
});

type AdGroupRow = {
  adGroup?: {
    id?: string;
    name?: string;
    status?: string;
    type?: string;
    cpcBidMicros?: string;
    cpvBidMicros?: string;
    cpmBidMicros?: string;
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
    averageCpm?: string;
  };
};

type ConversionActionRow = {
  adGroup?: { id?: string };
  segments?: { conversionActionName?: string };
  metrics?: { conversions?: string };
};

export const listAdGroupsTool: ToolSpec = {
  name: "google_ads_list_ad_groups",
  effect: "read",
  description:
    "List ad groups within a Google Ads campaign with type (SEARCH_STANDARD / VIDEO_* …), default bids, ads count, and spend + clicks + CTR + conversions. The `type` is what decides which ad kinds google_ads__propose_new_ad may add to the group.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { campaign_id, date_range, custom_range } = inputSchema.parse(input);
    const dateClause = custom_range
      ? `segments.date BETWEEN '${custom_range.since}' AND '${custom_range.until}'`
      : `segments.date DURING ${date_range}`;
    const query = `
      SELECT
        ad_group.id,
        ad_group.name,
        ad_group.status,
        ad_group.type,
        ad_group.cpc_bid_micros,
        ad_group.cpv_bid_micros,
        ad_group.cpm_bid_micros,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.all_conversions,
        metrics.conversions_value,
        metrics.ctr,
        metrics.average_cpc,
        metrics.average_cpm
      FROM ad_group
      WHERE campaign.id = ${escapeId(campaign_id)}
        AND ${dateClause}
      ORDER BY metrics.cost_micros DESC
      LIMIT ${GAQL_ROW_LIMIT}
    `;
    const rows = (await gadsSearch(ctx.tenant_id, query)) as AdGroupRow[];
    const adRows = (await gadsSearch(
      ctx.tenant_id,
      `
      SELECT ad_group.id, ad_group_ad.ad.id
      FROM ad_group_ad
      WHERE campaign.id = ${escapeId(campaign_id)}
        AND ad_group_ad.status != 'REMOVED'
      LIMIT 10000
    `,
    )) as Array<{ adGroup?: { id?: string } }>;
    const adCounts = new Map<string, number>();
    for (const row of adRows) {
      const id = row.adGroup?.id;
      if (id) adCounts.set(id, (adCounts.get(id) ?? 0) + 1);
    }
    const conversionRows = (await gadsSearch(
      ctx.tenant_id,
      `
      SELECT
        ad_group.id,
        segments.conversion_action_name,
        metrics.conversions
      FROM ad_group
      WHERE campaign.id = ${escapeId(campaign_id)}
        AND ${dateClause}
      LIMIT 10000
    `,
    )) as ConversionActionRow[];
    const conversionBreakdown = new Map<
      string,
      { purchases: number; registrations: number }
    >();
    for (const row of conversionRows) {
      const id = row.adGroup?.id;
      if (!id) continue;
      const name = row.segments?.conversionActionName?.toLowerCase() ?? "";
      const count = Number(row.metrics?.conversions ?? 0);
      const prior = conversionBreakdown.get(id) ?? {
        purchases: 0,
        registrations: 0,
      };
      if (/purchase|order|sale|transaction/.test(name))
        prior.purchases += count;
      if (/register|sign.?up|signup/.test(name)) prior.registrations += count;
      conversionBreakdown.set(id, prior);
    }
    const ad_groups = rows.map((r) => {
        const cost = Number(r.metrics?.costMicros ?? 0) / 1_000_000;
        const conv = Number(r.metrics?.conversions ?? 0);
        const convValue = Number(r.metrics?.conversionsValue ?? 0);
        const breakdown = conversionBreakdown.get(r.adGroup?.id ?? "");
        return {
          ad_group_id: r.adGroup?.id ?? "",
          ad_group_name: r.adGroup?.name ?? "",
          status: r.adGroup?.status ?? "",
          type: r.adGroup?.type ?? null,
          cpc_bid_usd: bidUsd(r.adGroup?.cpcBidMicros),
          cpv_bid_usd: bidUsd(r.adGroup?.cpvBidMicros),
          cpm_bid_usd: bidUsd(r.adGroup?.cpmBidMicros),
          ads_count: adCounts.get(r.adGroup?.id ?? "") ?? 0,
          spend_usd: round2(cost),
          impressions: Number(r.metrics?.impressions ?? 0),
          clicks: Number(r.metrics?.clicks ?? 0),
          ctr: Number(r.metrics?.ctr ?? 0),
          avg_cpc_usd: round2(Number(r.metrics?.averageCpc ?? 0) / 1_000_000),
          cpm_usd: round2(Number(r.metrics?.averageCpm ?? 0) / 1_000_000),
          conversions: round2(conv),
          all_conversions: round2(Number(r.metrics?.allConversions ?? 0)),
          purchases: breakdown ? round2(breakdown.purchases) : null,
          sign_ups: breakdown ? round2(breakdown.registrations) : null,
          conversions_value_usd: round2(convValue),
          roas: cost > 0 ? round2(convValue / cost) : null,
          cpa_usd: conv > 0 ? round2(cost / conv) : null,
        };
    });
    return {
      waste: buildWaste(ad_groups, {
        labelFields: ["ad_group_name"],
        spendField: "spend_usd",
        conversionFields: GOOGLE_CONVERSION_FIELDS,
        secondaryField: GOOGLE_SECONDARY_OUTCOME,
        outcomeLabel: GOOGLE_OUTCOME_LABEL,
        window: custom_range ? `${custom_range.since}..${custom_range.until}` : date_range,
        entity: "ad groups",
        complete: ad_groups.length < GAQL_ROW_LIMIT,
        currency: "account currency",
      }),
      totals: buildTotals(ad_groups, {
        sum: ["spend_usd", "impressions", "clicks", "conversions", "all_conversions", "conversions_value_usd"],
        ratios: {
          roas: ["conversions_value_usd", "spend_usd"],
          cpa_usd: ["spend_usd", "conversions"],
        },
        scope: `${ad_groups.length} ad groups · ${date_range}`,
        complete: ad_groups.length < GAQL_ROW_LIMIT,
        note:
          ad_groups.length < GAQL_ROW_LIMIT
            ? undefined
            : `Row cap of ${GAQL_ROW_LIMIT} hit; more ad groups exist. PAGE totals, not account totals.`,
      }),
      conversion_columns: CONVERSION_COLUMNS_NOTE,
      ad_groups,
      campaign_id,
      date_range,
    };
  },
};

function escapeId(id: string): string {
  if (!/^[0-9]+$/.test(id)) {
    throw new Error(`invalid campaign_id: ${id}`);
  }
  return id;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function bidUsd(micros: string | undefined): number | null {
  if (micros == null) return null;
  const n = Number(micros);
  return Number.isFinite(n) && n > 0 ? round2(n / 1_000_000) : null;
}
