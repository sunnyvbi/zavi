
export const CREDIT_USD = 0.0025;

export function costToCredits(costUsd: number | null | undefined): number {
  if (costUsd == null || !Number.isFinite(costUsd) || costUsd <= 0) return 0;
  return Math.ceil(costUsd / CREDIT_USD);
}

export function creditsToUsd(credits: number): number {
  return Math.max(0, credits) * CREDIT_USD;
}

const RESERVE_ESTIMATE_CREDITS: Record<string, number> = {
  engineer: 2000,
  "product-builder": 2400,
  fundraising: 500,
  "growth-lead": 320,
  "cgo": 320,
  research: 320,
  advisor: 320,
  "browser-operator": 240,
  google_ads: 340,
  seo: 340,
  geo: 340,
  meta_ads: 340,
  linkedin_organic: 340,
  reddit_organic: 340,
  blog: 340,
  x_organic: 340,
  instagram_organic: 340,
  pinterest_organic: 340,
  tiktok_organic: 340,
  youtube_organic: 340,
  ugc: 340,
  generated_video: 340,
  tiktok_ads: 340,
  reddit_ads: 340,
  linkedin_ads: 340,
  x_ads: 340,
  chatgpt_ads: 340,
  "performance-marketer": 160,
  operator: 160,
  pm: 160,
  "support-lead": 160,
  "dispute-response": 160,
  "chief-of-staff": 160,
  qa: 160,
};

export const DEFAULT_RESERVE_ESTIMATE_CREDITS = 340;

export function reserveEstimateFor(slug: string): number {
  const est = RESERVE_ESTIMATE_CREDITS[slug] ?? DEFAULT_RESERVE_ESTIMATE_CREDITS;
  return Math.max(1, est);
}

export const HEAVY_DISPATCH_THRESHOLD_CREDITS = 1000;

export function isHeavyDispatch(slug: string): boolean {
  return reserveEstimateFor(slug) >= HEAVY_DISPATCH_THRESHOLD_CREDITS;
}

const PLAN_CREDIT_ALLOWANCE: Record<string, number> = {
  free: 40000,
  solo: 20000,
  team: 80000,
  full: 300000,
  enterprise: 20000000,
};
export const FREE_CREDIT_ALLOWANCE = PLAN_CREDIT_ALLOWANCE.free;

export function creditAllowanceFor(plan: string): number {
  return PLAN_CREDIT_ALLOWANCE[plan] ?? FREE_CREDIT_ALLOWANCE;
}

export function isInsufficientCreditsError(
  err: { message?: string | null } | null | undefined,
): boolean {
  return !!err?.message && err.message.includes("insufficient_credits");
}

export const CREDIT_SOFT_WARN_THRESHOLD = 0.8;

export function creditUsagePctUsed(allowance: number, used: number): number {
  if (!Number.isFinite(allowance) || allowance <= 0) return 0;
  return Math.max(0, used) / allowance;
}

export function shouldSoftWarnCredits(opts: {
  allowance: number;
  used: number;
  effectiveAvailable: number;
  enforced: boolean;
  flagEnabled: boolean;
}): { pct_used: number; warn: boolean } {
  const pct_used = creditUsagePctUsed(opts.allowance, opts.used);
  const warn =
    opts.enforced &&
    opts.flagEnabled &&
    opts.allowance > 0 &&
    opts.allowance - opts.effectiveAvailable >= opts.allowance * CREDIT_SOFT_WARN_THRESHOLD;
  return { pct_used, warn };
}

export const FREE_DAILY_CREDITS_SQL_FALLBACK = 2000;

export function freeDailyCreditsFromBlob(
  blob: { free_daily_credits?: unknown } | null | undefined,
): number | null {
  const raw = blob?.free_daily_credits;
  const n =
    typeof raw === "number" ? raw : typeof raw === "string" && /^[0-9]{1,10}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_FREE_DAILY_CREDITS ? n : null;
}

const MAX_FREE_DAILY_CREDITS = 2_000_000_000;

export function freeDailyCreditsRejection(raw: unknown): string | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_FREE_DAILY_CREDITS) {
    return `free_daily_credits must be a whole number between 1 and ${MAX_FREE_DAILY_CREDITS}, e.g. 1000`;
  }
  return null;
}

export function creditsEnforcedFromBlob(
  blob:
    | { credits_enforced?: boolean; credits_enforced_allowlist?: unknown }
    | null
    | undefined,
  tenantId: string,
): boolean {
  if (blob?.credits_enforced === true) return true;
  const allow = blob?.credits_enforced_allowlist;
  return Array.isArray(allow) && allow.includes(tenantId);
}
