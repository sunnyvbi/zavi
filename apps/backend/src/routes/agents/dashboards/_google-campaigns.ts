
import { listCampaignsTool } from "@/services/tools/google-ads/list_campaigns";
import { googleAdsCreds } from "@/services/tools/google-ads/_client";
import {
  fetchGoogleDailySeries,
  type GoogleDailyRange,
  type GoogleDailyRow,
} from "@/services/tools/google-ads/daily_series";

export type GoogleCampaignsWindow = {
  date_range: GoogleDailyRange;
  custom_range?: { since: string; until: string };
};

export type GoogleCampaignRow = Record<string, unknown>;

export type GoogleCampaignsRead = {
  campaigns: GoogleCampaignRow[];
  customer_id: string | null;
  daily: { rows: GoogleDailyRow[] } | null;
};

const DAILY_TREND_TIMEOUT_MS = 6000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((res) => {
    t = setTimeout(() => res(null), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
}

export function googleCampaignUrl(customerId: string | null, campaignId: string): string | null {
  if (!customerId || !campaignId) return null;
  return `https://ads.google.com/aw/campaigns?__c=${customerId}&campaignId=${campaignId}`;
}

export async function readGoogleCampaigns(
  tenantId: string,
  win: GoogleCampaignsWindow,
  agentSlug?: string,
): Promise<GoogleCampaignsRead> {
  const google = (await listCampaignsTool.execute(
    { tenant_id: tenantId, log: () => {}, agent_slug: agentSlug },
    { date_range: win.date_range, custom_range: win.custom_range, status: "ALL" },
  )) as { campaigns?: GoogleCampaignRow[] };
  const dailyPromise = withTimeout(
    fetchGoogleDailySeries(tenantId, {
      date_range: win.date_range,
      custom_range: win.custom_range,
    }).catch(() => null),
    DAILY_TREND_TIMEOUT_MS,
  );
  let customerId: string | null = null;
  try {
    customerId = (await googleAdsCreds(tenantId)).customer_id;
  } catch {
    customerId = null;
  }
  const daily = await dailyPromise;
  return {
    campaigns: google.campaigns ?? [],
    customer_id: customerId,
    daily: daily ? { rows: daily.rows } : null,
  };
}
