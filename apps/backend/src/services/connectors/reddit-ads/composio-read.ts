
import { composioExecuteTool, type OwnedComposioAccount } from "@/services/connectors/composio/api";
import { ExpectedToolError } from "@/services/tools/types";
import { listAdAccounts, listObjects, redditAdsAccount, type RedditAdAccount } from "./adapter";

export { listAdAccounts, redditAdsAccount, type RedditAdAccount };

const MICROS = 1_000_000;
const CONVERSION_FIELDS = ["CONVERSION_PURCHASE_CLICKS", "CONVERSION_SIGN_UP_CLICKS", "CONVERSION_LEAD_CLICKS"] as const;
const REPORT_FIELDS = ["SPEND", "IMPRESSIONS", "CLICKS", ...CONVERSION_FIELDS] as const;

export type RedditSums = { spend: number; impressions: number; clicks: number; conversions: number };
export const ZERO_SUMS: RedditSums = { spend: 0, impressions: 0, clicks: 0, conversions: 0 };

export type RedditCampaignRow = {
  campaign_id: string;
  ad_account_id: string;
  name: string;
  status: string;
  effective_status: string | null;
  objective: string | null;
  spend_cap: number | null;
  daily_budget: number | null;
};

export type RedditAdGroupRow = {
  ad_group_id: string;
  campaign_id: string | null;
  status: string;
  daily_budget: number | null;
  campaign_budget: boolean;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function addSums(a: RedditSums, b: RedditSums): RedditSums {
  return {
    spend: a.spend + b.spend,
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    conversions: a.conversions + b.conversions,
  };
}

function failure(status: number, error: unknown): ExpectedToolError {
  const text = typeof error === "string" ? error : JSON.stringify(error ?? "");
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid_token|expired/i.test(text)) {
    return new ExpectedToolError("reddit_ads_token_revoked", "Reddit Ads stopped accepting Zavi's access. Reconnect it.");
  }
  if (status === 429 || /rate.?limit/i.test(text)) {
    return new ExpectedToolError("reddit_ads_rate_limited", "Reddit Ads is limiting requests. Try again in a minute.");
  }
  return new ExpectedToolError("reddit_ads_read_failed", `Reddit Ads read failed: ${text.slice(0, 300) || `HTTP ${status}`}`);
}

function unwrap(data: unknown): unknown {
  let d = data;
  for (let i = 0; i < 2 && isRecord(d) && "data" in d; i++) d = d.data;
  return d;
}

async function call(account: OwnedComposioAccount, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await composioExecuteTool({
    tool_slug: tool,
    user_id: account.tenant_id,
    connected_account_id: account.connected_account_id,
    arguments: args,
  });
  if (!r.ok) throw failure(r.status, r.error);
  return unwrap(r.data);
}

function rows(payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) throw new ExpectedToolError("reddit_ads_bad_response", "Reddit Ads returned an unexpected response.");
  return payload.filter(isRecord);
}

export async function listCampaigns(account: OwnedComposioAccount, adAccountId: string): Promise<RedditCampaignRow[]> {
  return rows(await call(account, "REDDIT_ADS_LIST_CAMPAIGNS", { ad_account_id: adAccountId, page_size: 1000 })).flatMap(
    (r) => {
      const id = str(r.id);
      if (!id) return [];
      const cap = r.spend_cap == null ? null : num(r.spend_cap) / MICROS;
      return [
        {
          campaign_id: id,
          ad_account_id: str(r.ad_account_id) ?? adAccountId,
          name: str(r.name) ?? id,
          status: str(r.configured_status) ?? "UNKNOWN",
          effective_status: str(r.effective_status),
          objective: str(r.objective),
          spend_cap: cap,
          daily_budget: dailySpend(r),
        },
      ];
    },
  );
}

const dailySpend = (r: Record<string, unknown>): number | null =>
  r.goal_type === "DAILY_SPEND" && num(r.goal_value) > 0 ? num(r.goal_value) / MICROS : null;

export async function listAdGroups(account: OwnedComposioAccount, adAccountId: string): Promise<RedditAdGroupRow[]> {
  return (await listObjects(account, adAccountId, "ad_group")).map((r) => ({
    ad_group_id: r.id,
    campaign_id: r.campaign_id ?? null,
    status: r.configured_status ?? "UNKNOWN",
    daily_budget: dailySpend(r),
    campaign_budget: r.is_campaign_budget_optimization === true,
  }));
}

const RETIRED = new Set(["DELETED", "ARCHIVED"]);

export function campaignDailyBudget(campaign: RedditCampaignRow, adGroups: readonly RedditAdGroupRow[] | null): number | null {
  if (campaign.daily_budget !== null) return campaign.daily_budget;
  if (!adGroups) return null;
  const own = adGroups.filter((g) => g.campaign_id === campaign.campaign_id && !g.campaign_budget && !RETIRED.has(g.status));
  if (own.length === 0 || own.some((g) => g.daily_budget === null)) return null;
  return Math.round(own.reduce((sum, g) => sum + (g.daily_budget ?? 0), 0) * 100) / 100;
}

export async function campaignReport(
  account: OwnedComposioAccount,
  adAccountId: string,
  from: string,
  to: string,
  level: "campaign" | "ad_group" | "ad" = "campaign",
): Promise<Map<string, RedditSums>> {
  const end = new Date(`${to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const payload = await call(account, "REDDIT_ADS_GET_A_REPORT", {
    ad_account_id: adAccountId,
    data: {
      starts_at: `${from}T00:00:00Z`,
      ends_at: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
      fields: [...REPORT_FIELDS],
      breakdowns: [`${level.toUpperCase()}_ID`],
    },
  });
  const metrics = isRecord(payload) ? payload.metrics : payload;
  const out = new Map<string, RedditSums>();
  for (const row of rows(metrics)) {
    const m = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
    const id = str(m[`${level}_id`]);
    if (!id) continue;
    const prev = out.get(id) ?? ZERO_SUMS;
    out.set(
      id,
      addSums(prev, {
        spend: num(m.spend) / MICROS,
        impressions: num(m.impressions),
        clicks: num(m.clicks),
        conversions: CONVERSION_FIELDS.reduce((s, f) => s + num(m[f.toLowerCase()]), 0),
      }),
    );
  }
  return out;
}

export async function getCampaign(account: OwnedComposioAccount, campaignId: string): Promise<RedditCampaignRow | null> {
  const r = await call(account, "REDDIT_ADS_GET_CAMPAIGN", { campaign_id: campaignId });
  if (!isRecord(r) || !str(r.id)) return null;
  return {
    campaign_id: str(r.id) as string,
    ad_account_id: str(r.ad_account_id) ?? "",
    name: str(r.name) ?? campaignId,
    status: str(r.configured_status) ?? "UNKNOWN",
    effective_status: str(r.effective_status),
    objective: str(r.objective),
    spend_cap: r.spend_cap == null ? null : num(r.spend_cap) / MICROS,
    daily_budget: dailySpend(r),
  };
}

export function redditCampaignsUrl(adAccountId: string): string {
  return `https://ads.reddit.com/account/${encodeURIComponent(adAccountId)}/campaigns`;
}
