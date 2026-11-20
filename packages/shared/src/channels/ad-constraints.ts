export type AdChannelConstraint = {
  channel_slug: string;
  platform: "meta" | "google" | "chatgpt" | "tiktok" | "reddit" | "linkedin" | "x";
  min_daily_usd: number;
  daily_must_exceed: boolean;
  min_campaign_total_usd: number | null;
  switch_min_total_usd?: number;
  lifetime: boolean;
  end_date: boolean;
  hold_factor: number;
  wallet: "none" | "zavi_prepaid";
  verified_on: string;
  source: string;
};

export const AD_CHANNEL_CONSTRAINTS: readonly AdChannelConstraint[] = [
  { channel_slug: "meta_ads", platform: "meta", min_daily_usd: 1, daily_must_exceed: false, min_campaign_total_usd: null, lifetime: false, end_date: true, hold_factor: 1.75, wallet: "none", verified_on: "2026-10-15", source: "ad-budget-brake.ts PLATFORM_MIN_DAILY_USD; a daily budget may spend up to 75% more on a day (Meta docs); launch ad set end_time accepted (validate_only, 2026-10-15)" },
  { channel_slug: "google_ads", platform: "google", min_daily_usd: 1, daily_must_exceed: false, min_campaign_total_usd: null, lifetime: false, end_date: true, hold_factor: 2, wallet: "none", verified_on: "2026-10-15", source: "ad-budget-brake.ts PLATFORM_MIN_DAILY_USD; up to 2x daily on a day (Google docs); campaign.end_date_time accepted by validateOnly create (live check 2026-10-15)" },
  { channel_slug: "youtube_ads", platform: "google", min_daily_usd: 1, daily_must_exceed: false, min_campaign_total_usd: null, lifetime: false, end_date: false, hold_factor: 2, wallet: "none", verified_on: "2026-10-15", source: "runs the Google classes" },
  { channel_slug: "chatgpt_ads", platform: "chatgpt", min_daily_usd: 25, daily_must_exceed: false, min_campaign_total_usd: null, lifetime: true, end_date: true, hold_factor: 2, wallet: "zavi_prepaid", verified_on: "2026-10-15", source: "help.openai.com/en/articles/20001210 (daily); a $58 lifetime total accepted on a paused campaign (live check 2026-10-15); automatic bidding needs a daily budget on Zavi's paused-create path" },
  { channel_slug: "tiktok_ads", platform: "tiktok", min_daily_usd: 20, daily_must_exceed: true, min_campaign_total_usd: 50, lifetime: false, end_date: true, hold_factor: 1, wallet: "none", verified_on: "2026-10-15", source: "ad group daily > $20 (launch-schema.ts); campaign minimum total $50 (ads.tiktok.com/help/article/budget, Ravi 2026-10-15); end date live-checked 2026-10-15" },
  { channel_slug: "reddit_ads", platform: "reddit", min_daily_usd: 5, daily_must_exceed: false, min_campaign_total_usd: 100, lifetime: false, end_date: false, hold_factor: 1, wallet: "none", verified_on: "2026-10-15", source: "ad-budget-brake.ts PLATFORM_MIN_DAILY_USD; reddit-ads/schema.ts lifetime cap >= $100" },
  { channel_slug: "linkedin_ads", platform: "linkedin", min_daily_usd: 10, daily_must_exceed: false, min_campaign_total_usd: 10, switch_min_total_usd: 100, lifetime: true, end_date: true, hold_factor: 1, wallet: "zavi_prepaid", verified_on: "2026-10-30", source: "linkedin-ads/action-review.ts ($10/day); a $10 lifetime total with an end date on a $10/day campaign was accepted and went ACTIVE (account 559148166, 2026-10-30), so spec v1's $100 lifetime minimum is not what LinkedIn enforces" },
  { channel_slug: "x_ads", platform: "x", min_daily_usd: 1, daily_must_exceed: false, min_campaign_total_usd: null, lifetime: true, end_date: true, hold_factor: 2, wallet: "none", verified_on: "unverified", source: "code minimum (propose_create_campaign.ts), externally unverified" },
];

export function adConstraint(slug: string): AdChannelConstraint | null {
  return AD_CHANNEL_CONSTRAINTS.find((c) => c.channel_slug === slug) ?? null;
}

export function adConstraintForPlatform(platform: string): AdChannelConstraint | null {
  return AD_CHANNEL_CONSTRAINTS.find((c) => c.platform === platform) ?? null;
}

export function smallestAcceptedDailyUsd(c: AdChannelConstraint): number {
  return c.daily_must_exceed ? Math.round((c.min_daily_usd + 0.01) * 100) / 100 : c.min_daily_usd;
}

export type LinkedinLaunchSpend = { remaining_cents: number; spendable_cents: number; days: number };

export function linkedinLaunchSpend(a: {
  total_cents: number;
  observed_cents: number;
  end_time: number;
  start_time: number;
  now: number;
}): LinkedinLaunchSpend {
  const remaining = Math.max(0, a.total_cents - a.observed_cents);
  const ms = a.end_time - Math.max(a.now, a.start_time);
  const days = ms > 0 ? Math.ceil(ms / 86_400_000) + 1 : 0;
  return { remaining_cents: remaining, spendable_cents: remaining, days };
}

export const LINKEDIN_MIN_RUNWAY_MS = 12 * 3600_000;

export type LinkedinEndTimeProblem = "passed" | "too_soon" | "too_far" | "before_start";

export function linkedinEndTimeProblem(endTime: number, startMs: number, now: number): LinkedinEndTimeProblem | null {
  if (endTime <= now) return "passed";
  if (endTime < now + LINKEDIN_MIN_RUNWAY_MS) return "too_soon";
  if (endTime > now + 366 * 86400_000) return "too_far";
  if (endTime <= startMs) return "before_start";
  return null;
}

export function linkedinMinTotalUsd(): number {
  const c = adConstraint("linkedin_ads");
  return c?.min_campaign_total_usd ?? c?.min_daily_usd ?? 10;
}

export function linkedinMinTotalCents(currency: string, unitsPerUsd?: number | null): number {
  const usdCents = Math.round(linkedinMinTotalUsd() * 100);
  return currency !== "USD" && unitsPerUsd ? Math.max(usdCents, Math.ceil(usdCents * unitsPerUsd)) : usdCents;
}

export function linkedinTotalBelowDailyWords(dailyCents: number, minTotalCents: number, currency: string): string {
  const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  return `LinkedIn does not accept a total budget below the campaign's daily budget. This campaign can spend up to ${money(dailyCents)} a day, so enter a total of at least ${money(Math.max(dailyCents, minTotalCents))}.`;
}
