
const RESERVE_ESTIMATE_CREDITS: Record<string, number> = {
  engineer: 2000,
  "product-builder": 2400,
  fundraising: 500,
  "growth-lead": 320,
  research: 320,
  advisor: 320,
  "browser-operator": 240,
  "performance-marketer": 160,
  operator: 160,
  pm: 160,
  "support-lead": 160,
  "dispute-response": 160,
  "chief-of-staff": 160,
  qa: 160,
};

const DEFAULT_RESERVE_ESTIMATE_CREDITS = 340;

export const MIN_RESERVE_ESTIMATE_CREDITS = Math.min(
  DEFAULT_RESERVE_ESTIMATE_CREDITS,
  ...Object.values(RESERVE_ESTIMATE_CREDITS),
);

export function reserveEstimateFor(slug: string): number {
  const est = RESERVE_ESTIMATE_CREDITS[slug] ?? DEFAULT_RESERVE_ESTIMATE_CREDITS;
  return Math.max(1, est);
}

export function creditBannerState(
  remaining: number,
  allowance: number,
  lowThreshold: number,
): "depleted" | "low" | "none" {
  if (remaining < MIN_RESERVE_ESTIMATE_CREDITS) return "depleted";
  if (allowance > 0 && remaining <= allowance * lowThreshold) return "low";
  return "none";
}

export function creditPercentLeft(
  remaining: number,
  allowance: number,
): number | null {
  if (!Number.isFinite(allowance) || allowance <= 0) return null;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  const pct = Math.round((remaining / allowance) * 100);
  return Math.min(100, Math.max(1, pct));
}

export const STATUS_LOW_CREDIT_THRESHOLD = 0.1;

export function creditMeterModel(
  remaining: number,
  allowance: number,
  purchased: number,
  state: "depleted" | "low" | "none",
): { total: number; fillPct: number; pctLabel: number | null } {
  const total = Math.max(0, allowance) + Math.max(0, purchased);
  if (total <= 0) return { total: 0, fillPct: 0, pctLabel: null };
  if (state === "depleted") return { total, fillPct: 0, pctLabel: 0 };
  const share = Math.max(0, Math.min(1, remaining / total));
  const pct = Math.round(share * 100);
  return { total, fillPct: share * 100, pctLabel: remaining > 0 ? Math.max(1, pct) : pct };
}

export function creditCellClass(
  remaining: number,
  allowance: number | null | undefined,
): string {
  const denom = typeof allowance === "number" && allowance > 0 ? allowance : 0;
  const state = creditBannerState(remaining, denom, STATUS_LOW_CREDIT_THRESHOLD);
  if (state === "depleted") return "text-coral";
  if (state === "low") return "text-marigoldDeep";
  return "";
}

export type DismissibleBannerState = "low" | "approaching";

export function isCreditBannerDismissible(state: string): state is DismissibleBannerState {
  return state === "low" || state === "approaching";
}

export const CREDIT_BANNER_DISMISS_KEY = "zavi_credit_banner_dismissed_v1";

export function creditBannerDismissSignature(
  state: string,
  tenantId: string | null | undefined,
  periodEnd: string | null,
): string | null {
  if (!isCreditBannerDismissible(state)) return null;
  if (typeof tenantId !== "string" || !tenantId) return null;
  if (!periodEnd) return null;
  return `${tenantId}|${periodEnd}|${state}`;
}

export function creditResetLine(resetLabel: string): string {
  return `Your credits reset on ${resetLabel}.`;
}
