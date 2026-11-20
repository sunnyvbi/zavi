import { z } from "zod";
import { listLinkedInCampaigns, type LinkedInAdCampaign, type LinkedInCampaignGroup } from "@/services/connectors/linkedin-ads/client";
import type { ToolSpec } from "@/services/tools/types";
import { linkedinCampaignGroups } from "./_groups";
import { linkedinAccountAccess } from "./_wallet";
import { fetchLinkedInDailySeries, LINKEDIN_FX_NOTE, LINKEDIN_PARTIAL_NOTE, LINKEDIN_UNREAD_NOTE, type LinkedInDailyRow } from "./daily_series";
import { walletCampaigns } from "./list_campaigns";

const CAMPAIGN_LIST_LIMIT = 500;
const WINDOW_METRICS = ["spend", "spend_usd", "impressions", "clicks", "conversions", "website_conversions", "leads", "conversion_value"] as const;
type WindowMetric = (typeof WINDOW_METRICS)[number];
type Window = Record<WindowMetric, number | null> & { days: number; missing_metrics: string[] };

const round2 = (n: number) => Math.round(n * 100) / 100;

export function sumGroupWindow(rows: LinkedInDailyRow[]): Window {
  const sum = (pick: (r: LinkedInDailyRow) => number | null) => (!rows.length || rows.some((r) => pick(r) === null) ? null : round2(rows.reduce((t, r) => t + (pick(r) as number), 0)));
  const values: Record<WindowMetric, number | null> = {
    spend: sum((r) => r.spend),
    spend_usd: sum((r) => r.spend_usd),
    impressions: sum((r) => r.impressions),
    clicks: sum((r) => r.clicks),
    conversions: sum((r) => r.conversions),
    website_conversions: sum((r) => r.website_conversions),
    leads: sum((r) => r.leads),
    conversion_value: sum((r) => r.conversion_value),
  };
  return { ...values, days: new Set(rows.map((r) => r.date)).size, missing_metrics: WINDOW_METRICS.filter((m) => values[m] === null) };
}

export type LinkedInCampaignGroupRow = LinkedInCampaignGroup & {
  ad_set_count: number;
  ad_set_ids: string[];
  window: Window;
};

export function campaignGroupRows(groups: LinkedInCampaignGroup[], campaigns: LinkedInAdCampaign[], rows: LinkedInDailyRow[]): LinkedInCampaignGroupRow[] {
  const known = new Set(groups.map((g) => g.id));
  const seen = [...campaigns.flatMap((c) => (c.campaign_group_id === null ? [] : [c.campaign_group_id])), ...rows.map((r) => r.campaign_id)];
  const orphanIds = [...new Set(seen.filter((id) => id !== "" && !known.has(id)))];
  const all: LinkedInCampaignGroup[] = [...groups, ...orphanIds.map((id) => ({ id, name: id, status: null, total_budget: null, run_start_at: null, run_end_at: null, last_modified_at: null, is_default: false }))];
  return all
    .map((g) => {
      const own = campaigns.filter((c) => c.campaign_group_id === g.id);
      return { ...g, ad_set_count: own.length, ad_set_ids: own.map((c) => c.id), window: sumGroupWindow(rows.filter((r) => r.campaign_id === g.id)) };
    })
    .sort((a, b) => (b.window.spend ?? -1) - (a.window.spend ?? -1) || a.name.localeCompare(b.name));
}

const inputSchema = z
  .object({
    account_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[1-9]\d*$/, "account_id must be a numeric LinkedIn ad-account id")
      .describe("LinkedIn Ads account id, from linkedin_ads_list_accounts."),
    lookback_days: z.number().int().min(1).max(90).default(30),
  })
  .strict();

export const linkedinAdsListCampaignGroupsTool: ToolSpec = {
  name: "linkedin_ads_list_campaign_groups",
  effect: "read",
  description:
    "List the campaign groups in one LinkedIn Ads ad account, the level Meta calls a campaign: name, status, total budget, run schedule, how many campaigns (ad sets) each holds, and the window's spend, impressions, clicks, conversions (website + lead-form), leads and conversion value summed from daily rows. Read this first to see every campaign in one place; then linkedin_ads_list_campaigns or linkedin_ads_daily_series for the ad sets inside one. A null is a number LinkedIn left out of at least one day, not a zero; truncated means the window was only partly read. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, lookback_days } = inputSchema.parse(input);
    const access = await linkedinAccountAccess(ctx.tenant_id, account_id);
    const campaigns = access.kind === "wallet" ? await walletCampaigns(ctx.tenant_id, access, CAMPAIGN_LIST_LIMIT) : await listLinkedInCampaigns(ctx.tenant_id, account_id, CAMPAIGN_LIST_LIMIT);
    const groups = await linkedinCampaignGroups(ctx.tenant_id, access, account_id, campaigns);
    const series = await fetchLinkedInDailySeries(ctx.tenant_id, { account_id, level: "campaign_group", lookback_days }, new Map(groups.map((g) => [g.id, g.name])));
    const rows = campaignGroupRows(groups, campaigns, series.rows);
    const unread = [...new Set(rows.flatMap((r) => r.window.missing_metrics))].filter((m) => !(series.fx_unavailable && m === "spend_usd"));
    return {
      account_id,
      currency: series.currency,
      time_range: series.time_range,
      count: rows.length,
      truncated: series.truncated,
      read_through: series.read_through,
      ...(series.truncated && series.partial_reason ? { partial_reason: series.partial_reason, warning: LINKEDIN_PARTIAL_NOTE[series.partial_reason] } : {}),
      ...(unread.length ? { unread_metrics: unread, unread_note: LINKEDIN_UNREAD_NOTE } : {}),
      ...(series.fx_unavailable ? { fx_note: LINKEDIN_FX_NOTE } : {}),
      campaign_groups: rows,
      method:
        "Groups come from LinkedIn's adCampaignGroups; window numbers are the sum of linkedin_ads_daily_series rows at campaign_group level over time_range, in the account currency (spend_usd at Zavi's daily rate). A group with no daily row has null numbers, not zeros. LinkedIn privacy-noises day rows, so these sums can differ a little from the whole-window total in linkedin_ads_read_analytics.",
    };
  },
};
