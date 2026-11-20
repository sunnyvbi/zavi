
import type { ManagedCampaign } from "@zavi/shared";
import { chatgptAdsGet, chatgptAdsPost } from "./http";

const MAX_PAGES = 10;
const PAGE_SIZE = 500;

export type ChatgptAdsCampaign = ManagedCampaign;

type CampaignsResource = {
  data?: Array<Record<string, unknown>>;
  last_id?: string | null;
  has_more?: boolean;
};

export type ChatgptAdsInsightRow = {
  start_time?: number;
  end_time?: number;
  readable_time?: string;
  timezone?: string;
  impressions?: number;
  clicks?: number;
  spend?: number;
  ctr?: number;
  cpc?: number;
  cpm?: number;
  conversions?: number;
  campaign_id?: string;
};

type InsightsResource = CampaignsResource;

export type ChatgptAdsConversionRow = {
  entity_id: string;
  conversions?: number;
  click_through_conversions?: number;
  view_through_conversions?: number;
};

type ConversionRowsResource = { data?: Array<Record<string, unknown>>; has_more?: boolean };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export function timeRangeParam(days: number, now: Date = new Date()): string {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Invalid Ads reporting window");
  const end = Math.floor(now.getTime() / 3_600_000) * 3600;
  return JSON.stringify({ type: "unix_range", start: end - days * 86400, end });
}

export async function listChatgptAdsCampaigns(
  apiKey: string,
): Promise<{ campaigns: ChatgptAdsCampaign[]; pages_exhausted: boolean; unreadable_campaigns: number }> {
  const out: ChatgptAdsCampaign[] = [];
  let after: string | undefined;
  let pages_exhausted = false;
  let unreadable_campaigns = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await chatgptAdsGet<CampaignsResource>(apiKey, "/campaigns", {
      limit: PAGE_SIZE,
      after,
    });
    if (!Array.isArray(body?.data)) throw new Error("Unreadable Ads campaign response");
    const rows = body.data;
    for (const r of rows) {
      const id = str(r.id);
      if (!id || typeof r.name !== "string") { unreadable_campaigns += 1; continue; }
      out.push(
        compact({
          id,
          name: str(r.name) ?? "",
          status: str(r.status) ?? null,
          updated_at: num(r.updated_at),
          bidding_type: str(r.bidding_type),
          budget: campaignBudget(r.budget),
          created_at: num(r.created_at),
          start_time: num(r.start_time) ?? null,
          end_time: num(r.end_time) ?? null,
        }),
      );
    }
    if (!body?.has_more) break;
    if (!body.last_id || body.last_id === after) { pages_exhausted = true; break; }
    after = body.last_id;
    if (page === MAX_PAGES - 1) pages_exhausted = true;
  }
  return { campaigns: out, pages_exhausted, unreadable_campaigns };
}

function toInsightRow(r: Record<string, unknown>): ChatgptAdsInsightRow {
  return compact({
    start_time: num(r.start_time),
    end_time: num(r.end_time),
    readable_time: str(r.readable_time),
    timezone: str(r.timezone),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    spend: num(r.spend),
    ctr: num(r.ctr),
    cpc: num(r.cpc),
    cpm: num(r.cpm),
    conversions: num(r.conversions),
    campaign_id: str(r.campaign_id),
  });
}

export async function getChatgptAdsCampaignInsights(
  apiKey: string,
  campaignId: string,
  timeRange: string,
): Promise<ChatgptAdsInsightRow[]> {
  const body = await chatgptAdsGet<InsightsResource>(
    apiKey,
    `/campaigns/${encodeURIComponent(campaignId)}/insights`,
    {
      time_granularity: "none",
      aggregation_level: "campaign",
      time_ranges: [timeRange],
      includes: ["zero_impression_items"],
      fields: ["campaign.id", "campaign.impressions", "campaign.clicks", "campaign.spend", "campaign.ctr", "campaign.cpc", "campaign.cpm"],
      limit: 2000,
    },
  );
  if (!Array.isArray(body?.data) || body.has_more) throw new Error("Incomplete Ads insights response");
  return body.data.map(toInsightRow);
}

export async function getChatgptAdsConversionInsights(
  apiKey: string,
  campaignIds: string[],
  timeRange: string,
): Promise<ChatgptAdsConversionRow[]> {
  if (campaignIds.length === 0) return [];
  const body = await chatgptAdsPost<ConversionRowsResource>(apiKey, "/conversions/insights", {
    aggregation_level: "campaign",
    time_granularity: "none",
    time_ranges: [timeRange],
    entity_ids: campaignIds,
    group_by_entity: true,
    include_zero_rows: true,
  });
  if (!Array.isArray(body?.data) || body.has_more) throw new Error("Incomplete Ads conversion response");
  const rows = body.data;
  const out: ChatgptAdsConversionRow[] = [];
  for (const r of rows) {
    const entity_id = str(r.entity_id);
    if (!entity_id) continue;
    out.push(
      compact({
        entity_id,
        conversions: num(r.conversions),
        click_through_conversions: num(r.click_through_conversions),
        view_through_conversions: num(r.view_through_conversions),
      }),
    );
  }
  return out;
}

export function campaignBudget(value: unknown): ChatgptAdsCampaign["budget"] {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const result: NonNullable<ChatgptAdsCampaign["budget"]> = {};
  for (const key of ["lifetime_spend_limit_micros", "daily_spend_limit_micros"] as const) {
    if (typeof v[key] === "number" && Number.isSafeInteger(v[key]) && v[key] >= 0) result[key] = v[key];
  }
  return Object.keys(result).length ? result : undefined;
}
