import { z } from "zod";
import { listLinkedInCampaigns, readLinkedInAdAnalytics, readLinkedInAdAnalyticsWithToken, readLinkedInCreatives, readLinkedInCreativesWithToken, type AdAnalyticsRow, type LinkedInAdCampaign, type LinkedInCreative } from "@/services/connectors/linkedin-ads/client";
import type { ToolSpec } from "@/services/tools/types";
import { LINKEDIN_CAMPAIGN_URN, linkedinAccountCurrency, linkedinDailyWindow } from "./daily_series";
import { linkedinAccountAccess } from "./_wallet";
import { walletCampaigns } from "./list_campaigns";

export const LINKEDIN_CREATIVE_URN = "urn:li:sponsoredCreative:";
const CAMPAIGN_LIST_LIMIT = 500;

export const LINKEDIN_FATIGUE_THRESHOLDS = {
  min_impressions_per_window: 1000,
  ctr_drop_percent: 20,
  impressions_floor_percent: -10,
  frequency_rise_percent: 10,
} as const;

export type LinkedInAdWindow = {
  since: string;
  until: string;
  spend: number | null;
  impressions: number | null;
  reach: number | null;
  frequency: number | null;
  clicks: number | null;
  ctr_percent: number | null;
  conversions: number | null;
  leads: number | null;
  missing_metrics: string[];
};

export type LinkedInAdFatigue = {
  verdict: "fatigued" | "not_fatigued" | "insufficient";
  ctr_change_percent: number | null;
  impressions_change_percent: number | null;
  frequency_change_percent: number | null;
  reason: string;
};

export type LinkedInAdRow = {
  ad_id: string;
  ad_name: string;
  campaign_id: string;
  campaign_name: string;
  intended_status: string | null;
  is_serving: boolean | null;
  review_status: string | null;
  created_at: string | null;
  last_modified_at: string | null;
  windows: { recent: LinkedInAdWindow | null; prior: LinkedInAdWindow | null };
  fatigue: LinkedInAdFatigue;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number | null, b: number | null, scale = 1): number | null => (a === null || b === null || b <= 0 ? null : round2((a / b) * scale));
const change = (now: number | null, before: number | null): number | null => (now === null || before === null || before <= 0 ? null : round2(((now - before) / before) * 100));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const parts = (s: string) => {
  const [year, month, day] = s.split("-").map(Number);
  return { year, month, day };
};

export function linkedinAdWindows(recent_days: number, now = new Date()): { recent: { since: string; until: string }; prior: { since: string; until: string } } {
  const recent = linkedinDailyWindow(recent_days, now);
  const priorEnd = new Date(Date.parse(`${recent.since}T00:00:00Z`) - 86_400_000);
  return { recent, prior: { since: ymd(new Date(priorEnd.getTime() - (recent_days - 1) * 86_400_000)), until: ymd(priorEnd) } };
}

const measured = (row: AdAnalyticsRow, metric: string, value: number | null | undefined): number | null => (row.missing_metrics?.includes(metric) || value === undefined || value === null ? null : value);

export function toAdWindow(range: { since: string; until: string }, row: AdAnalyticsRow | undefined): LinkedInAdWindow | null {
  if (!row) return null;
  const impressions = measured(row, "impressions", row.impressions);
  const reach = measured(row, "reach", row.reach);
  const clicks = measured(row, "clicks", row.clicks);
  const values = {
    spend: measured(row, "spend", row.spend),
    impressions,
    reach,
    clicks,
    conversions: measured(row, "conversions", row.conversions),
    leads: measured(row, "leads", row.leads),
  };
  return {
    ...range,
    ...values,
    frequency: ratio(impressions, reach),
    ctr_percent: ratio(clicks, impressions, 100),
    missing_metrics: Object.entries(values)
      .filter(([, v]) => v === null)
      .map(([k]) => k),
  };
}

export function fatigueOf(recent: LinkedInAdWindow | null, prior: LinkedInAdWindow | null, t = LINKEDIN_FATIGUE_THRESHOLDS): LinkedInAdFatigue {
  const none = { ctr_change_percent: null, impressions_change_percent: null, frequency_change_percent: null };
  if (!recent || !prior) return { verdict: "insufficient", ...none, reason: "LinkedIn returned no delivery for one of the two windows, so this ad has no earlier week of its own to compare against." };
  const ctr = change(recent.ctr_percent, prior.ctr_percent);
  const impressions = change(recent.impressions, prior.impressions);
  const frequency = change(recent.frequency, prior.frequency);
  const changes = { ctr_change_percent: ctr, impressions_change_percent: impressions, frequency_change_percent: frequency };
  if ((recent.impressions ?? 0) < t.min_impressions_per_window || (prior.impressions ?? 0) < t.min_impressions_per_window)
    return { verdict: "insufficient", ...changes, reason: `Fewer than ${t.min_impressions_per_window} impressions in one of the two windows; too little delivery to read a trend.` };
  if (ctr === null || frequency === null || impressions === null)
    return { verdict: "insufficient", ...changes, reason: "LinkedIn left click-through, reach or impressions out of one window, so the two signals cannot both be read." };
  const ctrDown = ctr <= -t.ctr_drop_percent;
  const impressionsHeld = impressions >= t.impressions_floor_percent;
  const frequencyUp = frequency >= t.frequency_rise_percent;
  if (ctrDown && impressionsHeld && frequencyUp)
    return { verdict: "fatigued", ...changes, reason: `Click-through fell ${Math.abs(ctr)}% against this ad's own prior window on held impressions (${impressions}%), and frequency rose ${frequency}%: the same people are seeing it more and clicking less.` };
  const held: string[] = [];
  if (!ctrDown) held.push("click-through did not fall materially");
  if (!impressionsHeld) held.push("impressions fell, so the lower click-through may be delivery, not the creative");
  if (!frequencyUp) held.push("frequency did not rise");
  return { verdict: "not_fatigued", ...changes, reason: `Not fatigue: ${held.join("; ")}.` };
}

const inputSchema = z
  .object({
    account_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[1-9]\d*$/, "account_id must be a numeric LinkedIn ad-account id")
      .describe("LinkedIn Ads account id, from linkedin_ads_list_accounts."),
    campaign_id: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe("Read the ads of this LinkedIn campaign (Meta's ad set), from linkedin_ads_list_campaigns."),
    campaign_group_id: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe("Read the ads of every campaign in this campaign group, from linkedin_ads_list_campaign_groups."),
    recent_days: z.number().int().min(3).max(14).default(7).describe("Length of each window in days. The recent window ends today (UTC); the prior window is the same length immediately before it."),
  })
  .strict()
  .refine((v) => Boolean(v.campaign_id || v.campaign_group_id), { message: "Pass campaign_id or campaign_group_id; list_ads never reads every ad in the account unscoped." });

export const LINKEDIN_LIST_ADS_METHOD =
  "Each window is one whole-window LinkedIn read at the ad (creative) level with approximateMemberReach, so frequency = that window's impressions / that window's reach; reach is never added across days or windows. Fatigue is judged per ad against ITS OWN prior window, never a benchmark: fatigued only when click-through fell at least thresholds.ctr_drop_percent on impressions that held (not below thresholds.impressions_floor_percent) AND frequency rose at least thresholds.frequency_rise_percent, with at least thresholds.min_impressions_per_window impressions in both windows; one signal alone is not_fatigued, and a null is unknown, not zero. Rising CPM alone is never fatigue. A missing window means LinkedIn recorded no delivery for that ad in it. campaigns gives each campaign's own two windows so a tired ad can be set against its healthy campaign. Spend is in the account currency.";

export async function fetchLinkedInAds(tenant_id: string, opts: { account_id: string; campaign_id?: string; campaign_group_id?: string; recent_days: number }, now = new Date()) {
  const access = await linkedinAccountAccess(tenant_id, opts.account_id);
  const [all, currency] =
    access.kind === "wallet"
      ? [await walletCampaigns(tenant_id, access, CAMPAIGN_LIST_LIMIT), /^[A-Z]{3}$/.test(access.currency) ? access.currency : null]
      : await Promise.all([listLinkedInCampaigns(tenant_id, opts.account_id, CAMPAIGN_LIST_LIMIT), linkedinAccountCurrency(tenant_id, opts.account_id)]);
  const campaigns: LinkedInAdCampaign[] = all.filter((c) => (opts.campaign_id ? c.id === opts.campaign_id : true) && (opts.campaign_group_id ? c.campaign_group_id === opts.campaign_group_id : true));
  const windows = linkedinAdWindows(opts.recent_days, now);
  if (!campaigns.length) return { currency, windows, campaigns: [], ads: [] as LinkedInAdRow[] };
  const ids = campaigns.map((c) => c.id);
  const urns = ids.map((id) => `${LINKEDIN_CAMPAIGN_URN}${id}`);
  const readWindow = (range: { since: string; until: string }) => {
    const o = { pivot: "CREATIVE" as const, start: parts(range.since), end: parts(range.until), campaigns: urns, reach: true };
    return access.kind === "wallet" ? readLinkedInAdAnalyticsWithToken(access.token, opts.account_id, o) : readLinkedInAdAnalytics(tenant_id, opts.account_id, o);
  };
  const [creatives, recentRows, priorRows] = await Promise.all([
    access.kind === "wallet" ? readLinkedInCreativesWithToken(access.token, opts.account_id, ids) : readLinkedInCreatives(tenant_id, opts.account_id, ids),
    readWindow(windows.recent),
    readWindow(windows.prior),
  ]);
  const own = new Set(ids);
  const byId = (rows: AdAnalyticsRow[]) => new Map(rows.flatMap((r) => (r.pivot?.startsWith(LINKEDIN_CREATIVE_URN) ? [[r.pivot.slice(LINKEDIN_CREATIVE_URN.length), r] as const] : [])));
  const recentById = byId(recentRows);
  const priorById = byId(priorRows);
  const names = new Map(campaigns.map((c) => [c.id, c.name]));
  const ads: LinkedInAdRow[] = creatives
    .filter((c): c is LinkedInCreative & { id: string } => c.id !== null && own.has(c.campaign_id))
    .map((c) => {
      const recent = toAdWindow(windows.recent, recentById.get(c.id));
      const prior = toAdWindow(windows.prior, priorById.get(c.id));
      return {
        ad_id: c.id,
        ad_name: c.name ?? c.id,
        campaign_id: c.campaign_id,
        campaign_name: names.get(c.campaign_id) ?? c.campaign_id,
        intended_status: c.intended_status,
        is_serving: c.is_serving,
        review_status: c.review_status,
        created_at: c.created_at,
        last_modified_at: c.last_modified_at,
        windows: { recent, prior },
        fatigue: fatigueOf(recent, prior),
      };
    })
    .sort((a, b) => (a.campaign_id === b.campaign_id ? a.ad_id.localeCompare(b.ad_id) : a.campaign_id.localeCompare(b.campaign_id)));
  const campaignWindow = (campaign_id: string, key: "recent" | "prior") => {
    const ws = ads.filter((a) => a.campaign_id === campaign_id).map((a) => a.windows[key]);
    const sum = (pick: (w: LinkedInAdWindow) => number | null) => {
      const present = ws.filter((w): w is LinkedInAdWindow => w !== null);
      if (!present.length) return null;
      return present.some((w) => pick(w) === null) ? null : present.reduce((t, w) => t + (pick(w) as number), 0);
    };
    const impressions = sum((w) => w.impressions);
    const clicks = sum((w) => w.clicks);
    return { ...windows[key], spend: sum((w) => w.spend), impressions, clicks, ctr_percent: ratio(clicks, impressions, 100), conversions: sum((w) => w.conversions), leads: sum((w) => w.leads) };
  };
  return {
    currency,
    windows,
    campaigns: campaigns.map((c) => {
      const recent = campaignWindow(c.id, "recent");
      const prior = campaignWindow(c.id, "prior");
      return { campaign_id: c.id, campaign_name: c.name, status: c.status, ads: ads.filter((a) => a.campaign_id === c.id).length, windows: { recent, prior }, ctr_change_percent: change(recent.ctr_percent, prior.ctr_percent) };
    }),
    ads,
  };
}

export const linkedinAdsListAdsTool: ToolSpec = {
  name: "linkedin_ads_list_ads",
  effect: "read",
  description:
    "Per-AD (creative) numbers for one LinkedIn campaign (Meta's ad set) or campaign group, in two equal windows: the recent window and this ad's own prior window, each with spend, impressions, reach, frequency (that window's impressions / reach), clicks, ctr_percent, conversions and leads, plus the ad's name, status and dates. fatigue is computed per ad against its own prior window and says fatigued / not_fatigued / insufficient with the reason: a tired ad hides inside a healthy campaign because campaign rows aggregate over its ads. campaigns carries each campaign's own two windows for the comparison. Use it for the creative_fatigue step; pair with linkedin_ads_daily_series for the day the numbers moved. A null is unknown, never zero. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, campaign_id, campaign_group_id, recent_days } = inputSchema.parse(input);
    const out = await fetchLinkedInAds(ctx.tenant_id, { account_id, campaign_id, campaign_group_id, recent_days });
    return {
      account_id,
      currency: out.currency,
      scope: campaign_id ? { campaign_id } : { campaign_group_id },
      windows: out.windows,
      count: out.ads.length,
      fatigued: out.ads.filter((a) => a.fatigue.verdict === "fatigued").map((a) => ({ ad_id: a.ad_id, ad_name: a.ad_name, campaign_id: a.campaign_id })),
      campaigns: out.campaigns,
      ads: out.ads,
      thresholds: LINKEDIN_FATIGUE_THRESHOLDS,
      method: LINKEDIN_LIST_ADS_METHOD,
    };
  },
};
