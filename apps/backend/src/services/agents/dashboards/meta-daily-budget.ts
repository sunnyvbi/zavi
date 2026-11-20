
import type { MetaDailyRow } from "@/services/tools/meta-ads/daily_series";
import { fbGet, metaAdsCreds } from "@/services/tools/meta-ads/_client";

export type MetaTodaySpend = { date: string | null; spend_usd: number; by_campaign: Record<string, number> };

export type MetaDailyBudgetCampaign = {
  campaign_id: string;
  campaign_name: string;
  status: string | null;
  daily_budget_usd: number | null;
};

export type MetaDailyBudgetDay = {
  date: string;
  spend_usd: number;
  by_campaign: Record<string, number>;
};

export type MetaDailyBudget = {
  total_daily_budget_usd: number | null;
  active_campaigns: number;
  known_daily_budget_usd: number | null;
  known_campaigns: number;
  today: MetaTodaySpend | null;
  days: MetaDailyBudgetDay[];
  campaigns: MetaDailyBudgetCampaign[];
  truncated: boolean;
  history_unreadable: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

type CampaignIn = {
  channel?: string;
  campaign_id: string;
  campaign_name: string;
  status?: string | null;
  active_daily_budget_usd: number | null;
};

export function buildMetaDailyBudget(input: {
  campaigns: CampaignIn[];
  daily: { rows: MetaDailyRow[]; truncated: boolean } | null;
  today: MetaTodaySpend | null;
}): MetaDailyBudget {
  const meta = input.campaigns.filter((c) => (c.channel ?? "meta") === "meta");
  const active = meta.filter((c) => c.status === "ACTIVE");

  const byDate = new Map<string, MetaDailyBudgetDay>();
  const spentIds = new Set<string>();
  const nameById = new Map<string, string>();
  for (const r of input.daily?.rows ?? []) {
    if (!r.date || !r.campaign_id) continue;
    if (input.today?.date && r.date >= input.today.date) continue;
    const day = byDate.get(r.date) ?? { date: r.date, spend_usd: 0, by_campaign: {} };
    day.spend_usd += r.spend_usd;
    day.by_campaign[r.campaign_id] = round2((day.by_campaign[r.campaign_id] ?? 0) + r.spend_usd);
    byDate.set(r.date, day);
    if (r.spend_usd > 0) spentIds.add(r.campaign_id);
    if (r.campaign_name) nameById.set(r.campaign_id, r.campaign_name);
  }
  for (const [id, v] of Object.entries(input.today?.by_campaign ?? {})) if (v > 0) spentIds.add(id);
  const days = [...byDate.values()]
    .map((d) => ({ ...d, spend_usd: round2(d.spend_usd) }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const known = new Map(meta.map((c) => [c.campaign_id, c]));
  const listed: MetaDailyBudgetCampaign[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const c = known.get(id);
    listed.push({
      campaign_id: id,
      campaign_name: (c?.campaign_name ?? nameById.get(id) ?? id).split("\n")[0],
      status: c?.status ?? null,
      daily_budget_usd: c && c.status === "ACTIVE" ? c.active_daily_budget_usd : null,
    });
  };
  for (const c of active) add(c.campaign_id);
  for (const id of spentIds) add(id);
  listed.sort((a, b) => (b.daily_budget_usd ?? -1) - (a.daily_budget_usd ?? -1));

  const budgets = active.map((c) => c.active_daily_budget_usd);
  const total =
    active.length === 0
      ? 0
      : budgets.every((b): b is number => typeof b === "number" && Number.isFinite(b))
        ? round2(budgets.reduce((a, b) => a + b, 0))
        : null;
  const knownBudgets = budgets.filter((b): b is number => typeof b === "number" && Number.isFinite(b));

  return {
    total_daily_budget_usd: total,
    active_campaigns: active.length,
    known_daily_budget_usd: knownBudgets.length ? round2(knownBudgets.reduce((a, b) => a + b, 0)) : null,
    known_campaigns: knownBudgets.length,
    today: input.today,
    days,
    campaigns: listed,
    truncated: input.daily?.truncated ?? false,
    history_unreadable: input.daily === null,
  };
}

export async function fetchMetaTodaySpend(tenant_id: string): Promise<MetaTodaySpend | null> {
  try {
    const creds = await metaAdsCreds(tenant_id);
    const j = (await fbGet(tenant_id, `${creds.ad_account_id}/insights`, {
      level: "campaign",
      date_preset: "today",
      fields: "campaign_id,spend",
      limit: 500,
    })) as { data?: Array<{ campaign_id?: string; spend?: string; date_start?: string }> };
    const rows = j.data ?? [];
    let total = 0;
    const by_campaign: Record<string, number> = {};
    for (const r of rows) {
      const spend = Number(r.spend ?? 0);
      if (!Number.isFinite(spend)) return null;
      total += spend;
      if (r.campaign_id) by_campaign[r.campaign_id] = round2((by_campaign[r.campaign_id] ?? 0) + spend);
    }
    return { date: rows[0]?.date_start ?? null, spend_usd: round2(total), by_campaign };
  } catch {
    return null;
  }
}
