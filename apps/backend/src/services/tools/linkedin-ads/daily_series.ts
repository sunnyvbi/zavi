import { z } from "zod";
import { adsFx, adsUsd, type AdsFx } from "@/services/ads-wallet/fx";
import { listLinkedInAdAccounts, listLinkedInCampaigns, type LinkedInAdCampaign } from "@/services/connectors/linkedin-ads/client";
import {
  LINKEDIN_DAILY_METRICS,
  readLinkedInDailyAnalytics,
  readLinkedInDailyAnalyticsWithToken,
  type LinkedInDailyAnalyticsRow,
  type LinkedInDailyMetric,
  type LinkedInDailyPartialReason,
} from "@/services/connectors/linkedin-ads/daily";
import { splitSettled, type BriefDailyRow } from "@/services/growth/perf-brief/brief";
import type { MetaJudgedOn } from "@/services/tools/meta-ads/_objective";
import type { ToolSpec } from "@/services/tools/types";
import { groupNamesOf, linkedinCampaignGroups } from "./_groups";
import { linkedinGroupJudgedOn, linkedinJudgedOn } from "./_objective";
import { linkedinAccountAccess } from "./_wallet";
import { walletCampaigns } from "./list_campaigns";

export type LinkedInDailyLevel = "campaign_group" | "campaign";

export type LinkedInDailyRow = BriefDailyRow & {
  level: LinkedInDailyLevel;
  currency: string | null;
  spend: number | null;
  reach: number | null;
  frequency: number | null;
  cpc: number | null;
  cpm: number | null;
  cvr_percent: number | null;
  cost_per_result: number | null;
  website_conversions: number | null;
  conversion_value: number | null;
  objective: string | null;
  judged_on: MetaJudgedOn;
  missing_metrics: string[];
};

export type LinkedInDailySeries = {
  rows: LinkedInDailyRow[];
  currency: string | null;
  fx_unavailable: boolean;
  time_range: { since: string; until: string };
  truncated: boolean;
  read_through: string | null;
  partial_reason: LinkedInDailyPartialReason | null;
};

export type LinkedInDailySeriesOpts = {
  account_id: string;
  level: LinkedInDailyLevel;
  lookback_days?: number;
  time_range?: { since: string; until: string };
  campaign_id?: string;
  campaign_group_id?: string;
};

export const LINKEDIN_CAMPAIGN_URN = "urn:li:sponsoredCampaign:";
export const LINKEDIN_CAMPAIGN_GROUP_URN = "urn:li:sponsoredCampaignGroup:";

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;
const CAMPAIGN_LIST_LIMIT = 500;

export function linkedinDailyWindow(lookback_days: number, now = new Date()): { since: string; until: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - (lookback_days - 1) * 86_400_000);
  return { since: ymd(start), until: ymd(end) };
}

const usd = (amount: number | null, fx: AdsFx | null): number | null => (amount === null || fx === null ? null : adsUsd(amount, fx));
const ratio = (a: number | null, b: number | null, scale = 1): number | null => (a === null || b === null || b <= 0 ? null : round2((a / b) * scale));

type Entity = { campaign_id: string; campaign_name: string; ad_set_id: string | null; ad_set_name: string | null; objective: string | null; judged_on: MetaJudgedOn };

function entityOf(level: LinkedInDailyLevel, pivot: string, campaigns: LinkedInAdCampaign[], groupNames: Map<string, string>): Entity {
  if (level === "campaign") {
    const id = pivot.startsWith(LINKEDIN_CAMPAIGN_URN) ? pivot.slice(LINKEDIN_CAMPAIGN_URN.length) : pivot;
    const c = campaigns.find((x) => x.id === id);
    const group = c?.campaign_group_id ?? "";
    return {
      campaign_id: group,
      campaign_name: groupNames.get(group) ?? group,
      ad_set_id: id,
      ad_set_name: c?.name ?? id,
      objective: c?.objective ?? null,
      judged_on: linkedinJudgedOn(c?.objective),
    };
  }
  const id = pivot.startsWith(LINKEDIN_CAMPAIGN_GROUP_URN) ? pivot.slice(LINKEDIN_CAMPAIGN_GROUP_URN.length) : pivot;
  const own = campaigns.filter((x) => x.campaign_group_id === id);
  const { objective, judged_on } = linkedinGroupJudgedOn(own.map((x) => x.objective));
  return { campaign_id: id, campaign_name: groupNames.get(id) ?? id, ad_set_id: null, ad_set_name: null, objective, judged_on };
}

export function toLinkedInDailyRow(level: LinkedInDailyLevel, r: LinkedInDailyAnalyticsRow, entity: Entity, currency: string | null, fx: AdsFx | null): LinkedInDailyRow {
  const spendUsd = usd(r.spend, fx);
  const valueUsd = usd(r.conversion_value, fx);
  const conversions = r.conversions === null || r.leads === null ? null : r.conversions + r.leads;
  return {
    date: r.date,
    level,
    ...entity,
    currency,
    spend: r.spend,
    spend_usd: spendUsd,
    impressions: r.impressions,
    reach: r.reach,
    frequency: ratio(r.impressions, r.reach),
    clicks: r.clicks,
    ctr_percent: ratio(r.clicks, r.impressions, 100),
    cpc: ratio(r.spend, r.clicks),
    cpm: ratio(r.spend, r.impressions, 1000),
    cpm_usd: ratio(spendUsd, r.impressions, 1000),
    cvr_percent: ratio(conversions, r.clicks, 100),
    cost_per_result: ratio(r.spend, conversions),
    conversions,
    website_conversions: r.conversions,
    purchases: 0,
    sign_ups: 0,
    leads: r.leads,
    conversion_value: r.conversion_value,
    purchase_value_usd: valueUsd,
    missing_metrics: [...r.missing_metrics],
  };
}

export function rollUpByGroup(rows: LinkedInDailyAnalyticsRow[], campaigns: LinkedInAdCampaign[]): LinkedInDailyAnalyticsRow[] {
  const groupOf = new Map(campaigns.map((c) => [`${LINKEDIN_CAMPAIGN_URN}${c.id}`, c.campaign_group_id ?? ""]));
  const out = new Map<string, LinkedInDailyAnalyticsRow>();
  const sources = new Map<string, Set<string>>();
  for (const r of rows) {
    const pivot = `${LINKEDIN_CAMPAIGN_GROUP_URN}${groupOf.get(r.pivot) ?? ""}`;
    const key = `${pivot}:${r.date}`;
    const acc = out.get(key) ?? { date: r.date, pivot, spend: 0, impressions: 0, reach: 0, clicks: 0, conversions: 0, leads: 0, conversion_value: 0, missing_metrics: [] };
    for (const m of LINKEDIN_DAILY_METRICS) {
      if (r[m] === null || acc[m] === null) acc[m] = null;
      else acc[m] = (acc[m] as number) + (r[m] as number);
    }
    const seen = sources.get(key) ?? new Set<string>();
    seen.add(r.pivot);
    sources.set(key, seen);
    acc.missing_metrics = LINKEDIN_DAILY_METRICS.filter((m) => acc[m] === null) as LinkedInDailyMetric[];
    if (seen.size > 1) acc.reach = null;
    out.set(key, acc);
  }
  return [...out.values()];
}

export type LinkedInCostDriver = "reach_price" | "click_rate" | "conversion_rate";

export type LinkedInCostWindow = {
  from: string;
  to: string;
  days: number;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  cpm: number | null;
  ctr_percent: number | null;
  cvr_percent: number | null;
  cost_per_result: number | null;
};

export type LinkedInCostSplit = {
  campaign_id: string;
  campaign_name: string;
  ad_set_id: string | null;
  ad_set_name: string | null;
  settled_through: string;
  settled: LinkedInCostWindow | null;
  prior: LinkedInCostWindow | null;
  ratios: { cpm: number | null; ctr: number | null; cvr: number | null; cost_per_result: number | null };
  driver: LinkedInCostDriver | null;
  reason: string;
};

export const LINKEDIN_COST_SPLIT = { window_days: 7, min_days: 3, moved_percent: 10 } as const;

const DRIVER_WORDS: Record<LinkedInCostDriver, string> = {
  reach_price: "the price of reach (CPM)",
  click_rate: "the rate people click (CTR)",
  conversion_rate: "the rate clickers convert (CVR)",
};

function costWindow(rows: LinkedInDailyRow[]): LinkedInCostWindow | null {
  if (!rows.length) return null;
  const sum = (pick: (r: LinkedInDailyRow) => number | null) => (rows.some((r) => pick(r) === null) ? null : rows.reduce((t, r) => t + (pick(r) as number), 0));
  const spend = sum((r) => r.spend);
  const impressions = sum((r) => r.impressions);
  const clicks = sum((r) => r.clicks);
  const conversions = sum((r) => r.conversions);
  return {
    from: rows[0].date,
    to: rows[rows.length - 1].date,
    days: rows.length,
    spend,
    impressions,
    clicks,
    conversions,
    cpm: ratio(spend, impressions, 1000),
    ctr_percent: ratio(clicks, impressions, 100),
    cvr_percent: ratio(conversions, clicks, 100),
    cost_per_result: ratio(spend, conversions),
  };
}

export function linkedinCostSplit(rows: LinkedInDailyRow[], now = new Date()): LinkedInCostSplit[] {
  const { settled, cutoff } = splitSettled(rows, now);
  const settledRows = settled as LinkedInDailyRow[];
  const byEntity = new Map<string, LinkedInDailyRow[]>();
  for (const r of settledRows) {
    const k = `${r.campaign_id}:${r.ad_set_id ?? ""}`;
    if (!byEntity.has(k)) byEntity.set(k, []);
    byEntity.get(k)!.push(r);
  }
  const { window_days, min_days, moved_percent } = LINKEDIN_COST_SPLIT;
  return [...byEntity.values()].map((own) => {
    const sorted = [...own].sort((a, b) => a.date.localeCompare(b.date));
    const dayBefore = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
    const settledFrom = dayBefore(cutoff, window_days);
    const priorFrom = dayBefore(cutoff, 2 * window_days);
    const settled = costWindow(sorted.filter((r) => r.date >= settledFrom && r.date < cutoff));
    const prior = costWindow(sorted.filter((r) => r.date >= priorFrom && r.date < settledFrom));
    const head = { campaign_id: own[0].campaign_id, campaign_name: own[0].campaign_name, ad_set_id: own[0].ad_set_id, ad_set_name: own[0].ad_set_name, settled_through: cutoff, settled, prior };
    const ratios = {
      cpm: ratio(settled?.cpm ?? null, prior?.cpm ?? null),
      ctr: ratio(settled?.ctr_percent ?? null, prior?.ctr_percent ?? null),
      cvr: ratio(settled?.cvr_percent ?? null, prior?.cvr_percent ?? null),
      cost_per_result: ratio(settled?.cost_per_result ?? null, prior?.cost_per_result ?? null),
    };
    if (!settled || !prior || settled.days < min_days || prior.days < min_days)
      return { ...head, ratios, driver: null, reason: `Fewer than ${min_days} settled days in one of the two weeks, so the cost cannot be split yet.` };
    const parts: Array<[LinkedInCostDriver, number | null]> = [
      ["reach_price", ratios.cpm],
      ["click_rate", ratios.ctr],
      ["conversion_rate", ratios.cvr],
    ];
    const unread = parts.filter(([, v]) => v === null).map(([k]) => DRIVER_WORDS[k]);
    if (unread.length) return { ...head, ratios, driver: null, reason: `A number was unread or zero in one week, so ${unread.join(" and ")} cannot be compared; the split is unknown, not flat.` };
    const moved = parts.map(([k, v]) => [k, Math.abs(Math.log(v as number))] as const).sort((a, b) => b[1] - a[1]);
    if (moved[0][1] < Math.abs(Math.log(1 + moved_percent / 100)))
      return { ...head, ratios, driver: null, reason: `No part moved more than ${moved_percent}% between the two settled weeks.` };
    const driver = moved[0][0];
    const r = parts.find(([k]) => k === driver)![1] as number;
    return { ...head, ratios, driver, reason: `${DRIVER_WORDS[driver]} moved most: ${r}x the prior settled week (${prior.from} to ${prior.to} against ${settled.from} to ${settled.to}); the other parts moved less. Check linkedin_ads_recent_changes for an edit in that week before blaming the auction.` };
  });
}

export async function linkedinAccountCurrency(tenant_id: string, account_id: string): Promise<string | null> {
  const accounts = await listLinkedInAdAccounts(tenant_id).catch(() => null);
  const c = accounts?.find((a) => a.id === account_id)?.currency;
  return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : null;
}

export async function fetchLinkedInDailySeries(tenant_id: string, opts: LinkedInDailySeriesOpts, names?: Map<string, string>): Promise<LinkedInDailySeries> {
  const time_range = opts.time_range ?? linkedinDailyWindow(opts.lookback_days ?? 30);
  const access = await linkedinAccountAccess(tenant_id, opts.account_id);
  const [campaigns, currency] =
    access.kind === "wallet"
      ? await Promise.all([walletCampaigns(tenant_id, access, CAMPAIGN_LIST_LIMIT), Promise.resolve(/^[A-Z]{3}$/.test(access.currency) ? access.currency : null)])
      : await Promise.all([listLinkedInCampaigns(tenant_id, opts.account_id, CAMPAIGN_LIST_LIMIT), linkedinAccountCurrency(tenant_id, opts.account_id)]);
  const [fx, groupNames] = await Promise.all([
    currency ? adsFx(currency).catch(() => null) : null,
    names ?? linkedinCampaignGroups(tenant_id, access, opts.account_id, campaigns).then(groupNamesOf).catch(() => new Map<string, string>()),
  ]);
  const read =
    access.kind === "wallet"
      ? await readLinkedInDailyAnalyticsWithToken(access.token, opts.account_id, { pivot: "CAMPAIGN", campaigns: access.campaignUrns, ...time_range }).then((r) => ({
          ...r,
          rows: r.rows.filter((row) => access.campaignUrns.includes(row.pivot)),
        }))
      : await readLinkedInDailyAnalytics(tenant_id, opts.account_id, { pivot: opts.level === "campaign_group" ? "CAMPAIGN_GROUP" : "CAMPAIGN", ...time_range });
  const raw = access.kind === "wallet" && opts.level === "campaign_group" ? rollUpByGroup(read.rows, campaigns) : read.rows;
  const rows = raw
    .map((r) => toLinkedInDailyRow(opts.level, r, entityOf(opts.level, r.pivot, campaigns, groupNames), currency, fx))
    .filter((r) => (opts.campaign_id ? r.ad_set_id === opts.campaign_id : true) && (opts.campaign_group_id ? r.campaign_id === opts.campaign_group_id : true))
    .sort((a, b) => {
      const ka = `${a.campaign_id}:${a.ad_set_id ?? ""}`;
      const kb = `${b.campaign_id}:${b.ad_set_id ?? ""}`;
      return ka === kb ? a.date.localeCompare(b.date) : ka.localeCompare(kb);
    });
  return {
    rows,
    currency,
    fx_unavailable: currency !== null && fx === null,
    time_range,
    truncated: read.truncated,
    read_through: read.read_through,
    partial_reason: read.partial_reason,
  };
}

export const LINKEDIN_PARTIAL_NOTE: Record<LinkedInDailyPartialReason, string> = {
  rate_limited: "LinkedIn asked Zavi to slow down part-way through this read, so the days after read_through are missing. The rows are PARTIAL; do not read a trend or a total from them. Try again in a few minutes or ask for a shorter window.",
  daily_limit: "LinkedIn's daily limit for reading this account was used up part-way through this read, so the days after read_through are missing. The rows are PARTIAL; do not read a trend or a total from them. The limit resets at 00:00 UTC; do not retry before then.",
  element_cap: "LinkedIn returned more rows than one read can hold, so the days after read_through are missing. The rows are PARTIAL; ask for a shorter window or one campaign.",
  read_failed: "LinkedIn stopped answering part-way through this read, so the days after read_through are missing. The rows are PARTIAL; do not read a trend or a total from them.",
};

export const LINKEDIN_UNREAD_NOTE =
  "LinkedIn left the metrics in unread_metrics out of at least one day (listed per row in missing_metrics). A null is unknown, not zero: never state it as zero, never sum over it, and never call a day with an unread result a day with no results.";

export const LINKEDIN_FX_NOTE =
  "No exchange rate was available for this account's currency, so spend_usd, cpm_usd and purchase_value_usd are null. Use spend, cpm and conversion_value, which are in the account currency.";

export const LINKEDIN_COST_SPLIT_METHOD =
  "cost_split compares, per line, the last 7 settled days against the 7 before (the last ~72h are excluded as still accruing conversions). Cost per result = CPM / CTR / CVR, so the driver is whichever of the price of reach (cpm), the click rate (ctr) or the conversion rate (cvr) moved most, as a ratio settled / prior; null when a part was unread, fewer than 3 days settled on either side, or nothing moved 10%. On LinkedIn the sign-up rate is the conversion rate: conversions are website conversions plus lead-form leads, and purchases and sign_ups are always 0. A driver names what moved, not why: check linkedin_ads_recent_changes for an edit that week first.";

const inputSchema = z
  .object({
    account_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[1-9]\d*$/, "account_id must be a numeric LinkedIn ad-account id")
      .describe("LinkedIn Ads account id, from linkedin_ads_list_accounts."),
    level: z
      .enum(["campaign_group", "campaign"])
      .default("campaign")
      .describe("campaign_group = one row per LinkedIn campaign group (Meta's campaign) per day; campaign = one row per LinkedIn campaign (Meta's ad set) per day."),
    lookback_days: z.number().int().min(1).max(90).default(30),
    campaign_id: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe("Only this LinkedIn campaign (ad set), from linkedin_ads_list_campaigns."),
    campaign_group_id: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe("Only this LinkedIn campaign group, from linkedin_ads_list_campaign_groups."),
  })
  .strict();

export const linkedinAdsDailySeriesTool: ToolSpec = {
  name: "linkedin_ads_daily_series",
  effect: "read",
  description:
    "Per-DAY rows for one LinkedIn Ads account: spend (account currency) and spend_usd, impressions, reach, frequency, clicks, ctr_percent, cpc, cpm, cvr_percent (conversions per click; LinkedIn's sign-up rate), cost_per_result, conversions (website conversions + lead-form leads), leads, conversion_value and purchase_value_usd, with judged_on from the objective. One row per campaign group or per campaign (LinkedIn's ad set) per day; scope with campaign_id or campaign_group_id. cost_split answers WHY the cost changed per line: which of the price of reach, the click rate or the conversion rate moved between the last settled week and the one before, with the ratios. Call linkedin_ads_analyst_brief FIRST to learn which line matters, then read its days here. LinkedIn privacy-noises day rows (small values may be left out), so a null is unknown, never zero, and days never add up to the whole-window total from linkedin_ads_read_analytics. The last ~3 days are still accruing conversions. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, level, lookback_days, campaign_id, campaign_group_id } = inputSchema.parse(input);
    const series = await fetchLinkedInDailySeries(ctx.tenant_id, { account_id, level, lookback_days, campaign_id, campaign_group_id });
    const unread = [...new Set(series.rows.flatMap((r) => r.missing_metrics))];
    return {
      account_id,
      currency: series.currency,
      level,
      time_range: series.time_range,
      days_returned: new Set(series.rows.map((r) => r.date)).size,
      count: series.rows.length,
      truncated: series.truncated,
      read_through: series.read_through,
      ...(series.truncated && series.partial_reason ? { partial_reason: series.partial_reason, warning: LINKEDIN_PARTIAL_NOTE[series.partial_reason] } : {}),
      ...(unread.length ? { unread_metrics: unread, unread_note: LINKEDIN_UNREAD_NOTE } : {}),
      ...(series.fx_unavailable ? { fx_note: LINKEDIN_FX_NOTE } : {}),
      rows: series.rows,
      cost_split: series.truncated ? [] : linkedinCostSplit(series.rows),
      method:
        `One row per entity per day. spend, cpc, cpm, cost_per_result and conversion_value are in the account currency; spend_usd, cpm_usd and purchase_value_usd use Zavi's daily exchange rate. conversions = externalWebsiteConversions + oneClickLeads; purchases and sign_ups are always 0 on LinkedIn. frequency = impressions / reach; on a wallet account at campaign_group level reach is null on a day more than one campaign rolls up, because reach does not add across campaigns. A null is a number LinkedIn did not report, not a zero. ${LINKEDIN_COST_SPLIT_METHOD}`,
    };
  },
};
