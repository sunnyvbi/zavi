
import { fbGet, fbGetAllPages, metaAdsCreds, metaDateRange, metaActionValue } from "./_client";
import { metaJudgedOn, type MetaJudgedOn } from "./_objective";

export type MetaDailyRow = {
  date: string;
  campaign_id: string;
  campaign_name: string;
  ad_set_id: string | null;
  ad_set_name: string | null;
  spend_usd: number;
  impressions: number;
  clicks: number;
  ctr_percent: number;
  cpm_usd: number;
  conversions: number;
  purchases: number;
  sign_ups: number;
  leads: number;
  purchase_value_usd: number;
  objective?: string | null;
  judged_on?: MetaJudgedOn;
};

type InsightRow = {
  date_start?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  objective?: string;
  optimization_goal?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpm?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
  action_values?: Array<{ action_type?: string; value?: string }>;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function mapMetaDailyRow(r: InsightRow): MetaDailyRow {
  const spend = Number(r.spend ?? 0);
  const purchases = metaActionValue(r.actions, "purchase");
  const checkouts = metaActionValue(r.actions, "initiate_checkout");
  const regs =
    metaActionValue(r.actions, "complete_registration") ||
    metaActionValue(r.actions, "offsite_conversion.fb_pixel_complete_registration");
  const leads =
    metaActionValue(r.actions, "lead") ||
    metaActionValue(r.actions, "offsite_conversion.fb_pixel_lead");
  const conv = purchases + checkouts + regs;
  const purchaseValue = metaActionValue(r.action_values, "purchase");
  return {
    date: r.date_start ?? "",
    campaign_id: r.campaign_id ?? "",
    campaign_name: r.campaign_name ?? "",
    ad_set_id: r.adset_id ?? null,
    ad_set_name: r.adset_name ?? null,
    spend_usd: round2(spend),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    ctr_percent: round2(Number(r.ctr ?? 0)),
    cpm_usd: round2(Number(r.cpm ?? 0)),
    conversions: round2(conv),
    purchases: round2(purchases),
    sign_ups: round2(regs),
    leads: round2(leads),
    purchase_value_usd: round2(purchaseValue),
    objective: r.objective ?? null,
    judged_on: metaJudgedOn(r.objective, r.optimization_goal),
  };
}

export type MetaDailyLevel = "campaign" | "adset";

const DATE_PRESETS = [
  "last_7d",
  "last_14d",
  "last_28d",
  "last_30d",
  "this_month",
  "last_month",
] as const;
export type MetaDailyPreset = (typeof DATE_PRESETS)[number];

export async function fetchMetaDailySeries(
  tenant_id: string,
  opts: {
    level: MetaDailyLevel;
    date_preset?: MetaDailyPreset;
    time_range?: { since: string; until: string };
    filter?: { campaign_id?: string; ad_set_id?: string };
    all_pages?: boolean;
  },
): Promise<{ rows: MetaDailyRow[]; time_range: { since: string; until: string }; truncated: boolean }> {
  const preset = opts.date_preset ?? "last_30d";
  const { since, until } = opts.time_range ?? metaDateRange(preset);
  const creds = await metaAdsCreds(tenant_id);

  const LIMIT = 500;
  const fields =
    opts.level === "adset"
      ? "date_start,campaign_id,campaign_name,adset_id,adset_name,objective,optimization_goal,spend,impressions,clicks,ctr,cpm,actions,action_values"
      : "date_start,campaign_id,campaign_name,objective,spend,impressions,clicks,ctr,cpm,actions,action_values";

  const params: Record<string, string | number | undefined> = {
    level: opts.level,
    time_range: JSON.stringify({ since, until }),
    time_increment: 1,
    limit: LIMIT,
    fields,
  };
  if (opts.filter?.ad_set_id) {
    params.filtering = JSON.stringify([
      { field: "adset.id", operator: "IN", value: [opts.filter.ad_set_id] },
    ]);
  } else if (opts.filter?.campaign_id) {
    params.filtering = JSON.stringify([
      { field: "campaign.id", operator: "IN", value: [opts.filter.campaign_id] },
    ]);
  }

  const path = `${creds.ad_account_id}/insights`;
  const raw = opts.all_pages
    ? await fbGetAllPages<InsightRow>(tenant_id, path, params)
    : (((await fbGet(tenant_id, path, params)) as { data?: InsightRow[] }).data ?? []);
  const rows = raw
    .map(mapMetaDailyRow)
    .sort((a, b) => {
      const ka = `${a.campaign_id}:${a.ad_set_id ?? ""}`;
      const kb = `${b.campaign_id}:${b.ad_set_id ?? ""}`;
      return ka === kb ? a.date.localeCompare(b.date) : ka.localeCompare(kb);
    });
  return { rows, time_range: { since, until }, truncated: !opts.all_pages && raw.length >= LIMIT };
}
