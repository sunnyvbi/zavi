import { callGoogleAdsTool } from "@/services/mcp/internal/google-ads";
import { callMetaAdsTool } from "@/services/mcp/internal/meta-ads";
import { runReport as gaRunReport } from "@/services/tools/google-analytics/_client";
import { getSecret } from "@/services/secrets/vault";
import { GOOGLE_ANALYTICS_VAULT_KEYS } from "@/services/tools/google-analytics/keys";
import type {
  ChannelRow,
  ChannelsSection,
  PaidChannelRow,
  Section,
} from "./types";

function ratio(
  numerator: number | null,
  denominator: number | null,
): number | null {
  if (numerator === null || denominator === null) return null;
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  )
    return null;
  return numerator / denominator;
}

function sum(values: Array<number | null>): number | null {
  const present = values.filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parse(content: string): Record<string, unknown> {
  try {
    const v = JSON.parse(content);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function campaignList(
  payload: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const raw = payload.campaigns;
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
}

function recordList(
  payload: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const raw = payload[key];
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await mapper(values[index]);
      }
    }),
  );
  return results;
}

function metaPaidRow(
  row: Record<string, unknown>,
  campaignName: string | null,
): PaidChannelRow {
  const spend = num(row.spend_usd);
  const clicks = num(row.clicks);
  const purchases = num(row.purchases);
  const conversions = num(row.conversions);
  const revenue = num(row.purchase_value_usd);
  const dailyBudget = num(row.daily_budget_usd);
  const lifetimeBudget = num(row.lifetime_budget_usd);
  return {
    id: textValue(row.ad_set_id) ?? "",
    campaign_id: textValue(row.campaign_id) ?? "",
    campaign_name: campaignName,
    channel: textValue(row.ad_set_name) ?? "Unnamed ad set",
    kind: "paid",
    source: "meta_ads",
    spend_usd: spend,
    impressions: num(row.impressions),
    clicks,
    leads: num(row.leads),
    customers: purchases,
    revenue_usd: revenue,
    cac_usd: ratio(spend, purchases),
    roas: ratio(revenue, spend),
    conversion_rate: ratio(purchases, clicks),
    ads_count: num(row.ads_count),
    status: textValue(row.effective_status) ?? textValue(row.status),
    reach: num(row.reach),
    result: conversions,
    cost_result_usd: ratio(spend, conversions),
    budget_usd: dailyBudget ?? lifetimeBudget,
    budget_period:
      dailyBudget !== null
        ? "daily"
        : lifetimeBudget !== null
          ? "lifetime"
          : null,
    website_purchases: purchases,
    website_registrations: num(row.sign_ups),
    ctr: num(row.ctr_percent) === null ? null : num(row.ctr_percent)! / 100,
    cpc_usd: num(row.cpc_usd),
    cpm_usd: num(row.cpm_usd),
    schedule_at: textValue(row.start_time),
    ends_at: textValue(row.end_time),
  };
}

function googlePaidRow(
  row: Record<string, unknown>,
  campaign: Record<string, unknown>,
): PaidChannelRow {
  const spend = num(row.spend_usd);
  const clicks = num(row.clicks);
  const conversions = num(row.conversions);
  const purchases = num(row.purchases);
  const revenue = num(row.conversions_value_usd);
  return {
    id: textValue(row.ad_group_id) ?? "",
    campaign_id: textValue(campaign.campaign_id) ?? "",
    campaign_name: textValue(campaign.campaign_name),
    channel: textValue(row.ad_group_name) ?? "Unnamed ad group",
    kind: "paid",
    source: "google_ads",
    spend_usd: spend,
    impressions: num(row.impressions),
    clicks,
    leads: null,
    customers: purchases ?? conversions,
    revenue_usd: revenue,
    cac_usd: ratio(spend, purchases ?? conversions),
    roas: ratio(revenue, spend),
    conversion_rate: ratio(purchases ?? conversions, clicks),
    ads_count: num(row.ads_count),
    status: textValue(row.status),
    reach: null,
    result: conversions,
    cost_result_usd: ratio(spend, conversions),
    budget_usd: num(campaign.daily_budget_usd),
    budget_period: num(campaign.daily_budget_usd) !== null ? "daily" : null,
    website_purchases: purchases,
    website_registrations: num(row.sign_ups),
    ctr: num(row.ctr),
    cpc_usd: num(row.avg_cpc_usd),
    cpm_usd: num(row.cpm_usd),
    schedule_at: textValue(campaign.start_time),
    ends_at: /^2037-12-30/.test(textValue(campaign.end_time) ?? "")
      ? null
      : textValue(campaign.end_time),
  };
}

const ORGANIC_BUCKETS: Array<{
  label: string;
  test: (source: string, medium: string) => boolean;
}> = [
  { label: "Organic Search", test: (_s, m) => m === "organic" },
  { label: "Referral", test: (_s, m) => m === "referral" },
  {
    label: "Organic Social",
    test: (_s, m) => m === "social" || m === "organic_social",
  },
  { label: "Email", test: (_s, m) => m === "email" },
  { label: "Direct", test: (s, m) => s === "(direct)" || m === "(none)" },
];

function bucketFor(source: string, medium: string): string {
  const s = source.toLowerCase();
  const m = medium.toLowerCase();
  for (const bucket of ORGANIC_BUCKETS)
    if (bucket.test(s, m)) return bucket.label;
  return "Other";
}

function isPaidMedium(medium: string): boolean {
  return /^(cpc|ppc|paid|paidsearch|paid_search|paid_social|display|cpm|retargeting)$/i.test(
    medium.trim(),
  );
}

function gaDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}
function gaEndDate(isoExclusive: string): string {
  return new Date(Date.parse(isoExclusive) - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function totalsRow(
  rows: ChannelRow[],
  kind: "paid" | "organic",
): ChannelRow | null {
  if (rows.length === 0) return null;
  const spend = sum(rows.map((r) => r.spend_usd));
  const clicks = sum(rows.map((r) => r.clicks));
  const customers = sum(rows.map((r) => r.customers));
  const revenue = sum(rows.map((r) => r.revenue_usd));
  return {
    channel: kind === "paid" ? "Paid total" : "Organic total",
    kind,
    source: [...new Set(rows.map((r) => r.source))].join(" + "),
    spend_usd: spend,
    impressions: sum(rows.map((r) => r.impressions)),
    clicks,
    leads: sum(rows.map((r) => r.leads)),
    customers,
    revenue_usd: revenue,
    cac_usd: ratio(spend, customers),
    roas: ratio(revenue, spend),
    conversion_rate: ratio(customers, clicks),
  };
}

export async function loadChannels(
  tenant_id: string,
  window: { since: string; until: string },
): Promise<Section<ChannelsSection>> {
  const reasons: string[] = [];
  const paid: PaidChannelRow[] = [];
  const organic: ChannelRow[] = [];
  let newest: string | null = null;

  const custom_range = {
    since: gaDate(window.since),
    until: gaEndDate(window.until),
  };

  const [meta, google, ga] = await Promise.all([
    callMetaAdsTool({ tenant_id }, "list_ad_sets", {
      time_range: custom_range,
    }).catch(() => null),
    callGoogleAdsTool({ tenant_id }, "list_campaigns", {
      status: "ALL",
      custom_range,
    }).catch(() => null),
    loadOrganic(tenant_id, window).catch((e) => ({
      rows: [] as ChannelRow[],
      error: (e as Error).message,
    })),
  ]);

  if (meta && meta.ok && !meta.is_error) {
    const adSets = recordList(parse(meta.content), "ad_sets");
    paid.push(...adSets.map((row) => metaPaidRow(row, null)));
    if (adSets.length === 0)
      reasons.push("Meta Ads reported no ad sets in this window.");
    newest = window.until;
  } else {
    const payload = meta ? parse(meta.content) : {};
    reasons.push(
      textValue(payload.message) ??
        "Meta Ads could not be loaded for this client.",
    );
  }

  if (google && google.ok && !google.is_error) {
    const campaigns = campaignList(parse(google.content));
    const groups = await mapConcurrent(campaigns, 5, async (campaign) => {
      const campaignId = textValue(campaign.campaign_id);
      if (!campaignId) return [];
      const response = await callGoogleAdsTool(
        { tenant_id },
        "list_ad_groups",
        { campaign_id: campaignId, custom_range },
      ).catch(() => null);
      if (!response?.ok || response.is_error) return [];
      return recordList(parse(response.content), "ad_groups").map((row) =>
        googlePaidRow(row, campaign),
      );
    });
    paid.push(...groups.flat());
    if (campaigns.length === 0)
      reasons.push(
        "Google Ads is connected but reported no campaigns in this window.",
      );
    else if (groups.every((rows) => rows.length === 0))
      reasons.push("Google Ads reported no ad groups in this window.");
    newest = window.until;
  } else {
    reasons.push("Google Ads is not connected for this client.");
  }

  if ("error" in ga && ga.error) reasons.push(ga.error);
  else organic.push(...ga.rows);
  if (ga.rows.length > 0) newest = window.until;

  const data: ChannelsSection = {
    paid,
    organic,
    totals: {
      paid: totalsRow(paid, "paid"),
      organic: totalsRow(organic, "organic"),
    },
    window,
  };

  const haveAny = paid.length > 0 || organic.length > 0;
  const status = haveAny
    ? reasons.length > 0
      ? "partial"
      : "ready"
    : "not_connected";
  return {
    status,
    detail: status === "ready" ? null : reasons.join(" "),
    data,
    source_updated_at: haveAny ? newest : null,
  };
}

async function loadOrganic(
  tenant_id: string,
  window: { since: string; until: string },
): Promise<{ rows: ChannelRow[]; error?: string }> {
  const property = await getSecret(tenant_id, GOOGLE_ANALYTICS_VAULT_KEYS.property_id);
  if (!property) {
    return {
      rows: [],
      error:
        "Google Analytics is not connected, so organic channels cannot be measured.",
    };
  }

  const report = await gaRunReport(tenant_id, {
    dateRanges: [
      { startDate: gaDate(window.since), endDate: gaEndDate(window.until) },
    ],
    dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }],
    metrics: [
      { name: "sessions" },
      { name: "totalUsers" },
      { name: "conversions" },
      { name: "purchaseRevenue" },
    ],
    limit: "250",
  });

  const acc = new Map<
    string,
    { sessions: number; users: number; conversions: number; revenue: number }
  >();
  for (const row of report.rows ?? []) {
    const source = row.dimensionValues?.[0]?.value ?? "(not set)";
    const medium = row.dimensionValues?.[1]?.value ?? "(not set)";
    if (isPaidMedium(medium)) continue;
    const bucket = bucketFor(source, medium);
    const prior = acc.get(bucket) ?? {
      sessions: 0,
      users: 0,
      conversions: 0,
      revenue: 0,
    };
    acc.set(bucket, {
      sessions: prior.sessions + (num(row.metricValues?.[0]?.value) ?? 0),
      users: prior.users + (num(row.metricValues?.[1]?.value) ?? 0),
      conversions: prior.conversions + (num(row.metricValues?.[2]?.value) ?? 0),
      revenue: prior.revenue + (num(row.metricValues?.[3]?.value) ?? 0),
    });
  }

  const rows: ChannelRow[] = [...acc.entries()]
    .map(([channel, v]) => ({
      channel,
      kind: "organic" as const,
      source: "ga4",
      spend_usd: null,
      impressions: null,
      clicks: Math.round(v.sessions),
      leads: Math.round(v.users),
      customers: Math.round(v.conversions),
      revenue_usd: v.revenue,
      cac_usd: null,
      roas: null,
      conversion_rate: ratio(v.conversions, v.sessions),
    }))
    .sort((a, b) => (b.revenue_usd ?? 0) - (a.revenue_usd ?? 0));

  return { rows };
}
