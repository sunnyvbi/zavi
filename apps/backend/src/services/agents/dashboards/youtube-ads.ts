import { z } from "zod";
import { listVideoCampaignsTool } from "@/services/tools/google-ads/list_video_campaigns";
import { gadsSearch, googleAdsCreds } from "@/services/tools/google-ads/_client";
import { googleCampaignUrl } from "@/routes/agents/dashboards/_google-campaigns";
import type { DashboardBuilder } from "@/routes/agents/dashboards/_contract";
import { readBudgets, todayIn, type CampaignBudget } from "@/routes/agents/dashboards/google-ads";
import { buildGoogleDailyBudget, readGoogleTodaySpend, type GoogleDailyBudget } from "./google-daily-budget";
import { fetchGoogleDailySeries } from "@/services/tools/google-ads/daily_series";

const campaign = z.object({
  campaign_id: z.string(), campaign_name: z.string(), status: z.string(),
  channel_type: z.string().nullable().optional(),
  spend_usd: z.number(), conversions: z.number(), conversions_value_usd: z.number(), cpa_usd: z.number().nullable(),
  impressions: z.number().optional(), video_views: z.number().optional(), clicks: z.number().optional(),
  view_rate: z.number().nullable().optional(), avg_cpv_usd: z.number().nullable().optional(),
  bidding_strategy_type: z.string().nullable().optional(),
});
const GOALS: Record<string, string> = {
  TARGET_CPV: "Video views", MANUAL_CPV: "Video views", TARGET_CPM: "Video reach", MANUAL_CPM: "Video reach",
  MAXIMIZE_CONVERSIONS: "Conversions", TARGET_CPA: "Conversions", MAXIMIZE_CONVERSION_VALUE: "Conversion value", TARGET_ROAS: "Conversion value",
  MAXIMIZE_CLICKS: "Website visits", TARGET_SPEND: "Website visits",
};
function campaignGoal(channelType: string | null | undefined, bidding: string | null | undefined): string | null {
  const goal = GOALS[bidding ?? ""];
  if (channelType === "DEMAND_GEN") return goal ? `Demand Gen, ${goal.toLowerCase()}` : "Demand Gen";
  return goal ?? null;
}
function reportPeriod(today: string, days: number): { from: string; to: string } {
  const at = (back: number) => new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
  return { from: at(days), to: at(1) };
}
const totals = z.object({
  spend_usd: z.number(), conversions: z.number(), conversions_value_usd: z.number(),
  video_views: z.number().optional(), impressions: z.number().optional(),
  view_rate: z.number().nullable().optional(), avg_cpv_usd: z.number().nullable().optional(), cpa_usd: z.number().nullable().optional(),
}).passthrough();
const payload = z.object({ campaigns: z.array(campaign), totals: totals.optional(), surfaces_note: z.string().optional() });
const customer = z.object({ customer: z.object({ currencyCode: z.string(), timeZone: z.string().optional(), descriptiveName: z.string().optional() }) });
const cache = new Map<string, { value: Record<string, unknown>; expires: number }>();

async function readBudgetLane(
  tenantId: string,
  videoIds: Set<string>,
  names: Map<string, string>,
  days: number,
  timeZone: string | null,
  custom: { since: string; until: string } | null,
): Promise<{ budgets: Map<string, CampaignBudget & { shared: boolean }>; breakdown: GoogleDailyBudget } | null> {
  const search = (q: string) => gadsSearch(tenantId, q) as Promise<unknown[]>;
  const [all, daily, today] = await Promise.all([
    readBudgets(search),
    fetchGoogleDailySeries(tenantId, custom ? { custom_range: custom } : { date_range: `LAST_${days}_DAYS` as "LAST_7_DAYS" | "LAST_14_DAYS" | "LAST_30_DAYS" }).catch(() => null),
    readGoogleTodaySpend(search, todayIn(timeZone)),
  ]);
  if (!all) return null;
  const mine = all.filter((b) => videoIds.has(b.campaign_id));
  const sharedCount = new Map<string, number>();
  for (const b of all) if (b.budget_resource) sharedCount.set(b.budget_resource, (sharedCount.get(b.budget_resource) ?? 0) + 1);
  const ours = (by: Record<string, number>) => Object.fromEntries(Object.entries(by).filter(([id]) => videoIds.has(id)));
  const todayOurs = today
    ? { ...today, by_campaign: ours(today.by_campaign), spend_usd: Math.round(Object.values(ours(today.by_campaign)).reduce((a, v) => a + v, 0) * 100) / 100 }
    : null;
  return {
    budgets: new Map(mine.map((b) => [b.campaign_id, { ...b, shared: (sharedCount.get(b.budget_resource ?? "") ?? 0) > 1 }])),
    breakdown: buildGoogleDailyBudget({
      budgets: mine,
      allBudgets: all,
      names,
      daily: daily ? daily.rows.filter((r) => videoIds.has(r.campaign_id)) : null,
      today: todayOurs,
    }),
  };
}

function isNotConnected(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.endsWith("_not_connected") || code === "google_ads_not_configured");
}

export const build: DashboardBuilder = async (context) => {
  const days = context.rangeDays === 7 || context.rangeDays === 14 ? context.rangeDays : 30;
  const custom = context.customRange ?? null;
  const key = `${context.tenantId}:${custom ? `${custom.since}_${custom.until}` : days}`;
  const hit = cache.get(key);
  if (!context.refresh && hit && hit.expires > Date.now()) return hit.value;
  try {
    const [raw, credentials, customers] = await Promise.all([
      listVideoCampaignsTool.execute(context.ctx, { date_range: `LAST_${days}_DAYS`, ...(custom ? { custom_range: custom } : {}), status: "ALL" }),
      googleAdsCreds(context.tenantId),
      gadsSearch(context.tenantId, "SELECT customer.currency_code, customer.time_zone, customer.descriptive_name FROM customer LIMIT 1").catch(() => []),
    ]);
    const data = payload.parse(raw);
    const account = customer.safeParse(customers[0]);
    const lane = await readBudgetLane(
      context.tenantId,
      new Set(data.campaigns.map((c) => c.campaign_id)),
      new Map(data.campaigns.map((c) => [c.campaign_id, c.campaign_name])),
      days,
      account.success ? (account.data.customer.timeZone ?? null) : null,
      custom,
    ).catch(() => null);
    const t = data.totals;
    const clicks = data.campaigns.map((c) => c.clicks);
    const value = {
      platform: "youtube_ads", connected: true, error_code: null,
      period: custom ? { from: custom.since, to: custom.until } : reportPeriod(todayIn(account.success ? (account.data.customer.timeZone ?? null) : null), days),
      currency: account.success ? account.data.customer.currencyCode : null,
      account: { name: (account.success && account.data.customer.descriptiveName?.trim()) || null, customer_id: credentials.customer_id ?? null, campaign_count: data.campaigns.length },
      campaigns_note: data.surfaces_note ?? "Video and Demand Gen campaigns, as reported by Google Ads. Demand Gen can also run outside YouTube.",
      campaigns: data.campaigns.map((item) => ({
        id: item.campaign_id, name: item.campaign_name, status: item.status, limited_by_budget: false,
        spend: item.spend_usd, conversions: item.conversions, cpa: item.cpa_usd, conv_value: item.conversions_value_usd,
        views: item.video_views ?? null, view_rate: item.view_rate ?? null, cpv: item.avg_cpv_usd ?? null,
        impressions: item.impressions ?? null, clicks: item.clicks ?? null,
        goal: campaignGoal(item.channel_type, item.bidding_strategy_type),
        url: googleCampaignUrl(credentials.customer_id, item.campaign_id),
        channel_type: item.channel_type ?? null,
        ...(lane ? { daily_budget: lane.budgets.get(item.campaign_id)?.daily_budget ?? null, budget_shared: lane.budgets.get(item.campaign_id)?.shared ?? false } : {}),
      })),
      ...(lane ? { daily_budget: lane.breakdown } : {}),
      totals: t
        ? {
            campaigns: data.campaigns.length,
            spend: t.spend_usd,
            conversions: t.conversions,
            cpa: t.cpa_usd ?? null,
            conv_value: t.conversions_value_usd,
            roas: t.spend_usd > 0 ? Math.round((t.conversions_value_usd / t.spend_usd) * 100) / 100 : null,
            views: t.video_views ?? null,
            view_rate: t.video_views != null && t.impressions ? Math.round((t.video_views / t.impressions) * 10000) / 100 : null,
            cpv: t.avg_cpv_usd ?? null,
            impressions: t.impressions ?? null,
            clicks: clicks.every((n): n is number => typeof n === "number") ? clicks.reduce((a, n) => a + n, 0) : null,
          }
        : null,
    };
    if (cache.size >= 128) { const oldest = cache.keys().next().value; if (oldest) cache.delete(oldest); }
    cache.set(key, { value, expires: Date.now() + 5 * 60_000 });
    return value;
  } catch (e) {
    if (isNotConnected(e)) {
      return { platform: "youtube_ads", connected: false, error_code: "not_connected", campaigns: [], totals: null };
    }
    const code = (e as { code?: unknown } | null)?.code;
    return {
      platform: "youtube_ads", connected: true, error_code: typeof code === "string" ? code : "google_ads_read_failed",
      campaigns: [], totals: null,
      campaigns_note: "Video campaigns could not be read. Check the Google Ads connection and refresh.",
    };
  }
};
