
import type { MetaDailyRow } from "@/services/tools/meta-ads/daily_series";
import type { MetaJudgedOn } from "@/services/tools/meta-ads/_objective";

export const DEFAULT_LAG_HOURS = 72;

export type WindowAgg = {
  days: number;
  spend_usd: number;
  impressions: number;
  clicks: number;
  conversions: number;
  purchases: number;
  sign_ups: number;
  leads: number;
  purchase_value_usd: number;
  ctr_percent: number | null;
  cvr_percent: number | null;
  signup_cvr_percent: number | null;
  cpa_usd: number | null;
  cost_per_signup_usd: number | null;
  cost_per_purchase_usd: number | null;
  roas: number | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function safeDiv(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

type BriefMetric = "spend_usd" | "impressions" | "clicks" | "ctr_percent" | "cpm_usd" | "conversions" | "purchases" | "sign_ups" | "leads" | "purchase_value_usd";
export type BriefDailyRow = Omit<MetaDailyRow, BriefMetric> & { [K in BriefMetric]: number | null };

export function aggregateWindow(rows: BriefDailyRow[]): WindowAgg {
  const sum = (k: keyof BriefDailyRow) =>
    rows.reduce((s, r) => s + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
  const spend = sum("spend_usd");
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  const conversions = sum("conversions");
  const purchases = sum("purchases");
  const sign_ups = sum("sign_ups");
  const leads = sum("leads");
  const pv = sum("purchase_value_usd");
  const ctr = safeDiv(clicks, impressions);
  const cvr = safeDiv(conversions, clicks);
  const scvr = safeDiv(sign_ups, clicks);
  return {
    days: new Set(rows.map((r) => r.date)).size,
    spend_usd: round2(spend),
    impressions,
    clicks,
    conversions: round2(conversions),
    purchases: round2(purchases),
    sign_ups: round2(sign_ups),
    leads: round2(leads),
    purchase_value_usd: round2(pv),
    ctr_percent: ctr === null ? null : round2(ctr * 100),
    cvr_percent: cvr === null ? null : round2(cvr * 100),
    signup_cvr_percent: scvr === null ? null : round2(scvr * 100),
    cpa_usd: safeDiv(spend, conversions) === null ? null : round2(spend / conversions),
    cost_per_signup_usd: safeDiv(spend, sign_ups) === null ? null : round2(spend / sign_ups),
    cost_per_purchase_usd: safeDiv(spend, purchases) === null ? null : round2(spend / purchases),
    roas: safeDiv(pv, spend) === null ? null : round2(pv / spend),
  };
}

export function splitSettled(
  rows: BriefDailyRow[],
  asOf: Date,
  lagHours: number = DEFAULT_LAG_HOURS,
): { settled: BriefDailyRow[]; maturing: BriefDailyRow[]; cutoff: string } {
  const cutoffMs = asOf.getTime() - lagHours * 3600_000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  const settled: BriefDailyRow[] = [];
  const maturing: BriefDailyRow[] = [];
  for (const r of rows) {
    if (r.date && r.date < cutoff) settled.push(r);
    else maturing.push(r);
  }
  return { settled, maturing, cutoff };
}

export const MIN_CLICKS = 30;
export const MIN_SPEND_USD = 50;
export const MIN_PURCHASES_FOR_ROAS_CALL = 10;

export type BriefThresholds = {
  min_clicks: number;
  min_spend_usd: number;
  min_results_for_call: number;
  results: "purchases" | "conversions";
};

export const META_BRIEF_THRESHOLDS: BriefThresholds = {
  min_clicks: MIN_CLICKS,
  min_spend_usd: MIN_SPEND_USD,
  min_results_for_call: MIN_PURCHASES_FOR_ROAS_CALL,
  results: "purchases",
};

const resultsOf = (a: WindowAgg, t: BriefThresholds) => (t.results === "conversions" ? a.conversions : a.purchases);

export type Confidence = "adequate" | "thin" | "inadequate";

export function windowConfidence(a: WindowAgg, t: BriefThresholds = META_BRIEF_THRESHOLDS): Confidence {
  if (a.days < 7 || a.spend_usd < t.min_spend_usd || a.clicks < t.min_clicks) return "inadequate";
  if (resultsOf(a, t) < t.min_results_for_call) return "thin";
  return "adequate";
}

export type FunnelLabel =
  | "maturing_insufficient"
  | "top_funnel_working_bottleneck_below_click"
  | "weak_creative_low_ctr"
  | "click_no_convert"
  | "converting_healthy"
  | "underperforming_settled";

const LOW_CTR_PCT = 0.6;
const HEALTHY_SIGNUP_CVR_PCT = 5;
const WEAK_BOOKING_RATE_PCT = 2;
const WEAK_BOOKING_ABS_FLOOR = 3;

export function funnelLabel(settled: WindowAgg, conf: Confidence, t: BriefThresholds = META_BRIEF_THRESHOLDS): FunnelLabel {
  if (conf === "inadequate") return "maturing_insufficient";
  const ctr = settled.ctr_percent ?? 0;
  const signupCvr = settled.signup_cvr_percent ?? 0;
  const hasSignups = settled.sign_ups >= 10;
  const bookingRatePct =
    settled.sign_ups > 0 ? (settled.purchases / settled.sign_ups) * 100 : null;
  const weakBookings =
    settled.purchases < WEAK_BOOKING_ABS_FLOOR ||
    (bookingRatePct !== null && bookingRatePct < WEAK_BOOKING_RATE_PCT);
  const hasPurchases = resultsOf(settled, t) >= 1;

  if (hasSignups && signupCvr >= HEALTHY_SIGNUP_CVR_PCT && weakBookings) {
    return "top_funnel_working_bottleneck_below_click";
  }
  if (ctr < LOW_CTR_PCT) return "weak_creative_low_ctr";
  if (settled.clicks >= t.min_clicks && settled.conversions < 1 && !hasSignups) {
    return "click_no_convert";
  }
  if (hasPurchases || hasSignups) return "converting_healthy";
  return "underperforming_settled";
}

export type Posture = "SCALE" | "HOLD" | "INVESTIGATE_FUNNEL" | "CUT_CANDIDATE" | "NO_DECISION";

const ROAS_SCALE_FLOOR = 1.0;
export function recommendedPosture(label: FunnelLabel, conf: Confidence, settled: WindowAgg): Posture {
  if (conf === "inadequate") return "NO_DECISION";
  switch (label) {
    case "maturing_insufficient":
      return "HOLD";
    case "top_funnel_working_bottleneck_below_click":
      return "INVESTIGATE_FUNNEL";
    case "weak_creative_low_ctr":
      return "INVESTIGATE_FUNNEL";
    case "click_no_convert":
      return "INVESTIGATE_FUNNEL";
    case "converting_healthy":
      return conf === "adequate" && settled.roas !== null && settled.roas >= ROAS_SCALE_FLOOR
        ? "SCALE"
        : "HOLD";
    case "underperforming_settled":
      return "CUT_CANDIDATE";
  }
}

export type CampaignBrief = {
  campaign_id: string;
  campaign_name: string;
  ad_set_id: string | null;
  ad_set_name: string | null;
  window_days: number;
  settled_cutoff: string;
  settled: WindowAgg;
  prior: WindowAgg;
  maturing_days: number;
  confidence: Confidence;
  funnel_label: FunnelLabel;
  posture: Posture;
  judged_on: MetaJudgedOn;
  notes: string[];
};

export function buildCampaignBrief(
  rows: BriefDailyRow[],
  asOf: Date,
  lagHours: number = DEFAULT_LAG_HOURS,
  t: BriefThresholds = META_BRIEF_THRESHOLDS,
): CampaignBrief {
  const campaign_id = rows[0]?.campaign_id ?? "";
  const campaign_name = rows[0]?.campaign_name ?? "";
  const ad_set_id = rows[0]?.ad_set_id ?? null;
  const ad_set_name = rows[0]?.ad_set_name ?? null;
  const { settled, maturing, cutoff } = splitSettled(rows, asOf, lagHours);
  const settledSorted = [...settled].sort((a, b) => a.date.localeCompare(b.date));
  const uniqueDays = [...new Set(settledSorted.map((r) => r.date))].sort();
  const last7 = uniqueDays.slice(-7);
  const prior7 = uniqueDays.slice(-14, -7);
  const inSet = (s: string[], r: BriefDailyRow) => s.includes(r.date);
  const recentAgg = aggregateWindow(settledSorted.filter((r) => inSet(last7, r)));
  const priorAgg = aggregateWindow(settledSorted.filter((r) => inSet(prior7, r)));
  const conf = windowConfidence(recentAgg, t);
  const label = funnelLabel(recentAgg, conf, t);
  const judged_on: MetaJudgedOn = rows.find((r) => r.judged_on && r.judged_on !== "unknown")?.judged_on ?? "unknown";
  const posture = judged_on === "reach_and_clicks" ? "NO_DECISION" : recommendedPosture(label, conf, recentAgg);

  const notes: string[] = [];
  if (judged_on === "reach_and_clicks") {
    notes.push(
      `Its objective buys reach and clicks, not conversions: judge it on reach, CTR (${recentAgg.spend_usd} in the account currency for ${recentAgg.clicks} clicks) and cost per click. No conversion-based scale or cut.`,
    );
  }
  if (maturing.length > 0) {
    notes.push(
      `Last ${new Set(maturing.map((r) => r.date)).size}d excluded as still-maturing (conversion lag); judged on settled data through ${cutoff}.`,
    );
  }
  if (label === "top_funnel_working_bottleneck_below_click") {
    notes.push(
      `Top funnel is working (${recentAgg.sign_ups} signups @ $${recentAgg.cost_per_signup_usd}/signup) but bookings are weak — the leak is BELOW the click (landing/offer/booking flow). Do NOT cut this ad on ROAS; investigate the funnel.`,
    );
  }
  if (conf === "thin") {
    notes.push(
      `Thin sample (${resultsOf(recentAgg, t)} settled ${t.results} < ${t.min_results_for_call}) — ROAS is directional only, not a basis to scale/cut.`,
    );
  }
  if (conf === "inadequate") {
    notes.push(
      `Insufficient settled volume (days=${recentAgg.days}, spend=$${recentAgg.spend_usd}, clicks=${recentAgg.clicks}) — no budget recommendation.`,
    );
  }

  return {
    campaign_id,
    campaign_name,
    ad_set_id,
    ad_set_name,
    window_days: new Set(rows.map((r) => r.date)).size,
    settled_cutoff: cutoff,
    settled: recentAgg,
    prior: priorAgg,
    maturing_days: new Set(maturing.map((r) => r.date)).size,
    confidence: conf,
    funnel_label: label,
    posture,
    judged_on,
    notes,
  };
}

export function buildBriefs(rows: BriefDailyRow[], asOf: Date, lagHours?: number, t: BriefThresholds = META_BRIEF_THRESHOLDS): CampaignBrief[] {
  const byEntity = new Map<string, BriefDailyRow[]>();
  for (const r of rows) {
    const k = `${r.campaign_id}:${r.ad_set_id ?? ""}`;
    if (!byEntity.has(k)) byEntity.set(k, []);
    byEntity.get(k)!.push(r);
  }
  return [...byEntity.values()].map((rs) => buildCampaignBrief(rs, asOf, lagHours, t));
}
