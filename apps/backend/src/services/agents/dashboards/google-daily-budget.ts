
import type { GoogleDailyRow } from "@/services/tools/google-ads/daily_series";
import type { GoogleAdsSearch } from "@/services/tools/google-ads/_client";
import { sumDailyBudgets, type CampaignBudget } from "@/routes/agents/dashboards/google-ads";

export type GoogleTodaySpend = { date: string; spend_usd: number; by_campaign: Record<string, number> };

export type GoogleDailyBudget = {
  total_daily_budget_usd: number | null;
  active_campaigns: number;
  known_daily_budget_usd: number | null;
  known_campaigns: number;
  today: GoogleTodaySpend | null;
  days: Array<{ date: string; spend_usd: number; by_campaign: Record<string, number> }>;
  campaigns: Array<{ campaign_id: string; campaign_name: string; status: string | null; daily_budget_usd: number | null; shared: boolean }>;
  history_unreadable: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildGoogleDailyBudget(input: {
  budgets: CampaignBudget[];
  names: Map<string, string>;
  daily: GoogleDailyRow[] | null;
  today: GoogleTodaySpend | null;
  allBudgets?: CampaignBudget[];
}): GoogleDailyBudget {
  const enabled = input.budgets.filter((b) => b.status === "ENABLED");
  const sharedCount = new Map<string, number>();
  for (const b of input.allBudgets ?? input.budgets) if (b.budget_resource) sharedCount.set(b.budget_resource, (sharedCount.get(b.budget_resource) ?? 0) + 1);

  const byDate = new Map<string, { date: string; spend_usd: number; by_campaign: Record<string, number> }>();
  const spent = new Set<string>();
  const names = new Map(input.names);
  for (const r of input.daily ?? []) {
    if (!r.date || !r.campaign_id) continue;
    if (input.today && r.date >= input.today.date) continue;
    const day = byDate.get(r.date) ?? { date: r.date, spend_usd: 0, by_campaign: {} };
    day.spend_usd += r.spend_usd;
    day.by_campaign[r.campaign_id] = round2((day.by_campaign[r.campaign_id] ?? 0) + r.spend_usd);
    byDate.set(r.date, day);
    if (r.spend_usd > 0) spent.add(r.campaign_id);
    if (r.campaign_name && !names.has(r.campaign_id)) names.set(r.campaign_id, r.campaign_name);
  }
  for (const [id, v] of Object.entries(input.today?.by_campaign ?? {})) if (v > 0) spent.add(id);

  const budgetOf = new Map(input.budgets.map((b) => [b.campaign_id, b]));
  const ids = [...new Set([...enabled.map((b) => b.campaign_id), ...spent])];
  const campaigns = ids
    .map((id) => {
      const b = budgetOf.get(id);
      const on = b?.status === "ENABLED";
      return {
        campaign_id: id,
        campaign_name: names.get(id) ?? id,
        status: b?.status ?? null,
        daily_budget_usd: on ? b!.daily_budget : null,
        shared: !!b?.budget_resource && (sharedCount.get(b.budget_resource) ?? 0) > 1,
      };
    })
    .sort((a, b) => (b.daily_budget_usd ?? -1) - (a.daily_budget_usd ?? -1));

  const total = enabled.length === 0 ? 0 : enabled.every((b) => b.daily_budget !== null) ? sumDailyBudgets(enabled) : null;
  return {
    total_daily_budget_usd: total,
    active_campaigns: enabled.length,
    known_daily_budget_usd: sumDailyBudgets(enabled),
    known_campaigns: enabled.filter((b) => b.daily_budget !== null).length,
    today: input.today,
    days: [...byDate.values()].map((d) => ({ ...d, spend_usd: round2(d.spend_usd) })).sort((a, b) => b.date.localeCompare(a.date)),
    campaigns,
    history_unreadable: input.daily === null,
  };
}

export async function readGoogleTodaySpend(search: GoogleAdsSearch, today: string): Promise<GoogleTodaySpend | null> {
  try {
    const rows = (await search("SELECT campaign.id, metrics.cost_micros FROM campaign WHERE segments.date DURING TODAY")) as Array<{
      campaign?: { id?: string };
      metrics?: { costMicros?: string | number };
    }>;
    let total = 0;
    const by_campaign: Record<string, number> = {};
    for (const r of rows) {
      const spend = Number(r.metrics?.costMicros ?? 0) / 1_000_000;
      if (!Number.isFinite(spend)) return null;
      total += spend;
      if (r.campaign?.id) by_campaign[r.campaign.id] = round2((by_campaign[r.campaign.id] ?? 0) + spend);
    }
    return { date: today, spend_usd: round2(total), by_campaign };
  } catch {
    return null;
  }
}
