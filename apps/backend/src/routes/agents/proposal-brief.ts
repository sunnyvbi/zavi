

export type MeasuredOutcome = {
  action_class: string;
  decision_outcome: "approved" | "rejected";
  delta_metrics: Record<string, unknown> | null;
};

export type TrackRecord = {
  action_class: string;
  n: number;
  right: number;
  label: string;
};

export const MIN_TRACK_RECORD_SAMPLE = 3;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function outcomeWasRight(o: MeasuredOutcome): boolean | null {
  const d = o.delta_metrics ?? {};
  if (o.action_class.startsWith("meta_ads.set_status")) {
    const avoided = num(d.spend_avoided_estimate);
    if (avoided !== null) return avoided > 0;
    const spendDelta = num(d.spend);
    if (spendDelta !== null) return spendDelta < 0;
    return null;
  }
  if (
    o.action_class.startsWith("meta_ads.update_ad_set_budget") ||
    o.action_class.startsWith("meta_ads.update_campaign_budget")
  ) {
    const roasDelta = num(d.roas);
    if (roasDelta !== null) return roasDelta >= 0;
    return null;
  }
  if (o.action_class === "meta_ads.create_ad_set") {
    const roasDelta = num(d.roas);
    if (roasDelta !== null) return roasDelta >= 0;
    return null;
  }
  return null;
}

function trackLabel(actionClass: string, right: number, n: number): string {
  const noun = actionClass.startsWith("meta_ads.set_status")
    ? "pause"
    : actionClass.startsWith("meta_ads.update_ad_set_budget") || actionClass.startsWith("meta_ads.update_campaign_budget")
      ? "budget"
      : actionClass === "meta_ads.create_ad_set"
        ? "launch"
        : "similar";
  return `${right} of ${n} ${noun} call${n === 1 ? "" : "s"} worked out`;
}

export function buildTrackRecord(
  actionClass: string,
  outcomes: MeasuredOutcome[],
): TrackRecord | null {
  let n = 0;
  let right = 0;
  for (const o of outcomes) {
    if (o.action_class !== actionClass) continue;
    const verdict = outcomeWasRight(o);
    if (verdict === null) continue;
    n += 1;
    if (verdict) right += 1;
  }
  if (n < MIN_TRACK_RECORD_SAMPLE) return null;
  return { action_class: actionClass, n, right, label: trackLabel(actionClass, right, n) };
}

export type TrendPoint = { window: string; label: string; spend: number | null; roas: number | null };

export const TREND_WINDOWS: { window: string; label: string }[] = [
  { window: "last_7d", label: "Last 7 days" },
  { window: "this_month", label: "Month to date" },
  { window: "last_month", label: "Last month" },
];

export type CampaignMetric = { campaign_id: string; spend: number | null; roas: number | null };

export function buildTrend(
  campaignId: string | null,
  metricsByWindow: Record<string, CampaignMetric[]>,
): TrendPoint[] | null {
  if (!campaignId) return null;
  const points: TrendPoint[] = [];
  for (const w of TREND_WINDOWS) {
    const rows = metricsByWindow[w.window] ?? [];
    const row = rows.find((r) => r.campaign_id === campaignId);
    points.push({
      window: w.window,
      label: w.label,
      spend: row ? num(row.spend) : null,
      roas: row ? num(row.roas) : null,
    });
  }
  const anyData = points.some((p) => p.spend !== null || p.roas !== null);
  return anyData ? points : null;
}

export type Confidence = { value: number | null; band: "high" | "medium" | "low"; source: string };

function extractPurchaseN(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(/\bn\s*=\s*(\d+)\b|\b(\d+)\s+purchases?\b/i);
  if (!m) return null;
  const val = parseInt(m[1] ?? m[2], 10);
  if (Number.isFinite(val) && val >= 0 && val <= 100000) return val;
  return null;
}

export function buildConfidence(
  evidenceConfidence: unknown,
  reasoningText: string | null,
): Confidence | null {
  const explicit = num(evidenceConfidence);
  if (explicit !== null && explicit >= 0 && explicit <= 1) {
    const band = explicit >= 0.66 ? "high" : explicit >= 0.33 ? "medium" : "low";
    return { value: Math.round(explicit * 100) / 100, band, source: "evidence" };
  }
  const sampleN = extractPurchaseN(reasoningText);
  if (sampleN === null) return null;
  const band = sampleN >= 10 ? "high" : sampleN >= 3 ? "medium" : "low";
  return { value: null, band, source: "sample_size" };
}

export type DecisionBrief = {
  track_record: TrackRecord | null;
  trend: TrendPoint[] | null;
  confidence: Confidence | null;
};

export function assembleBrief(args: {
  actionClass: string;
  campaignId: string | null;
  measuredOutcomes: MeasuredOutcome[];
  metricsByWindow: Record<string, CampaignMetric[]>;
  evidenceConfidence: unknown;
  reasoningText: string | null;
}): DecisionBrief | null {
  const track_record = buildTrackRecord(args.actionClass, args.measuredOutcomes);
  const trend = buildTrend(args.campaignId, args.metricsByWindow);
  const confidence = buildConfidence(args.evidenceConfidence, args.reasoningText);
  if (!track_record && !trend && !confidence) return null;
  return { track_record, trend, confidence };
}
