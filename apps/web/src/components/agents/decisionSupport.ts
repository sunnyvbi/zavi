
import { adCurrencySymbol } from "@/lib/adCurrency";
import { isMetaBudgetHandler } from "./proposalView";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function usd(n: number, currency?: unknown): string {
  const sym = adCurrencySymbol(currency);
  return `${sym}${Math.abs(Math.round(n)).toLocaleString(sym === "₹" ? "en-IN" : undefined)}`;
}

const DAYS_PER_MONTH = 30;

export type BudgetDelta = {
  kind: "raise" | "lower" | "pause" | null;
  dailyDeltaUsd: number | null;
  dailyLabel: string | null;
  monthlyLabel: string | null;
  impactLine: string | null;
};

const EMPTY_DELTA: BudgetDelta = {
  kind: null,
  dailyDeltaUsd: null,
  dailyLabel: null,
  monthlyLabel: null,
  impactLine: null,
};

export function budgetDelta(
  handler: string | null,
  body: Record<string, unknown> | null | undefined,
): BudgetDelta {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};

  if (isMetaBudgetHandler(handler)) {
    const to = num(b.daily_budget_usd);
    const from = num(b.expected_current_daily_budget_usd);
    if (to === null || from === null) return EMPTY_DELTA;
    const delta = to - from;
    if (delta === 0) return EMPTY_DELTA;
    const kind = delta > 0 ? "raise" : "lower";
    const sign = delta > 0 ? "+" : "−";
    const dailyLabel = `${sign}${usd(delta, b.currency)}/day`;
    const monthlyLabel = `${sign}${usd(delta * DAYS_PER_MONTH, b.currency)}/mo`;
    const impactLine =
      delta > 0
        ? `Approve → up to ${monthlyLabel} more spend`
        : `Approve → cuts ~${usd(delta * DAYS_PER_MONTH, b.currency)}/mo of spend`;
    return { kind, dailyDeltaUsd: delta, dailyLabel, monthlyLabel, impactLine };
  }

  if (handler === "meta_ads.set_status" || handler === "meta_ads.set_status_review") {
    const isPause = String(b.status ?? "").toUpperCase() === "PAUSED";
    if (!isPause) return EMPTY_DELTA;
    const freedDaily = num(b.expected_current_daily_budget_usd) ?? num(b.daily_budget_usd);
    if (freedDaily === null || freedDaily <= 0) {
      return { ...EMPTY_DELTA, kind: "pause" };
    }
    const dailyLabel = `−${usd(freedDaily)}/day`;
    const monthlyLabel = `−${usd(freedDaily * DAYS_PER_MONTH)}/mo`;
    return {
      kind: "pause",
      dailyDeltaUsd: -freedDaily,
      dailyLabel,
      monthlyLabel,
      impactLine: `Frees ~${usd(freedDaily)}/day (~${usd(freedDaily * DAYS_PER_MONTH)}/mo)`,
    };
  }

  return EMPTY_DELTA;
}

export type CampaignContextRow = {
  campaign_id: string;
  campaign_name?: string | null;
  spend_usd?: number | null;
  roas?: number | null;
  frequency?: number | null;
};

export const HIGH_FREQUENCY_THRESHOLD = 3.5;

export type ActiveWindowContext = {
  campaignId: string;
  campaignName: string | null;
  windowLabel: string;
  spendUsd: number | null;
  roas: number | null;
  roasTone: "good" | "bad" | null;
  frequency: number | null;
  frequencyHigh: boolean;
};

export function activeWindowContext(
  body: Record<string, unknown> | null | undefined,
  campaigns: CampaignContextRow[] | null | undefined,
  windowLabel: string | null | undefined,
): ActiveWindowContext | null {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const campaignId = str(b.campaign_id);
  if (!campaignId) return null;
  const rows = Array.isArray(campaigns) ? campaigns : [];
  const row = rows.find((c) => c && c.campaign_id === campaignId);
  if (!row) return null;
  const spendUsd = num(row.spend_usd);
  const roas = num(row.roas);
  const roasTone: "good" | "bad" | null = roas === null ? null : roas >= 1 ? "good" : "bad";
  const frequency = num(row.frequency);
  return {
    campaignId,
    campaignName: str(row.campaign_name),
    windowLabel: str(windowLabel) ?? "current window",
    spendUsd,
    roas,
    roasTone,
    frequency,
    frequencyHigh: frequency !== null && frequency >= HIGH_FREQUENCY_THRESHOLD,
  };
}

export type BriefTrackRecord = { action_class: string; n: number; right: number; label: string };
export type BriefTrendPoint = { window: string; label: string; spend: number | null; roas: number | null };
export type BriefConfidence = { value: number | null; band: "high" | "medium" | "low"; source: string };
export type DecisionBrief = {
  track_record: BriefTrackRecord | null;
  trend: BriefTrendPoint[] | null;
  confidence: BriefConfidence | null;
};

export type Reversibility = { reversible: boolean; line: string };

export function reversibility(handler: string | null): Reversibility {
  const h = handler ?? "";
  if (h.startsWith("meta_ads.set_status")) {
    return {
      reversible: true,
      line: "Reversible: re-activate in 1 click, instant; learning preserved.",
    };
  }
  if (isMetaBudgetHandler(h)) {
    return {
      reversible: true,
      line: "Reversible: set the budget back any time; takes effect immediately.",
    };
  }
  if (h === "meta_ads.create_ad_set" || h === "meta_ads.create_campaign") {
    return {
      reversible: true,
      line: "Reversible: ships PAUSED, $0 until you flip it on.",
    };
  }
  if (h === "meta_ads.launch_campaign") {
    return { reversible: true, line: "Goes live on approval. Pause the campaign any time to stop spend." };
  }
  if (h === "meta_ads.delete_campaign") {
    return { reversible: false, line: "Cannot be undone: the campaign, its ad sets and ads are deleted." };
  }
  return { reversible: false, line: "Review carefully. This is not a one-click undo." };
}
