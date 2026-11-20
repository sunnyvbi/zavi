
export const PULSE_PCT_THRESHOLD = 0.2;
export const MIN_PRIOR_SPEND_USD = 25;
export const DELIVERY_STOPPED_FLOOR_USD = 25;
export const DELIVERY_STOPPED_CURRENT_CEIL_USD = 1;

export type PulseWindowMetrics = {
  spend_usd: number;
  conversions: number;
  purchase_value_usd: number;
};

export type PulseInputs = {
  current: PulseWindowMetrics;
  prior: PulseWindowMetrics;
  pixel_overall_status: "healthy" | "degraded" | "web_only" | "no_pixel" | "unknown";
};

export type PulseBreach = {
  metric: "spend" | "cac" | "roas" | "delivery" | "pixel";
  direction: "up" | "down" | "stopped" | "degraded";
  detail: string;
  prior_value: number | null;
  current_value: number | null;
  pct_change: number | null;
};

export type PulseResult = {
  breached: boolean;
  breaches: PulseBreach[];
};

function cac(m: PulseWindowMetrics): number | null {
  return m.conversions > 0 ? m.spend_usd / m.conversions : null;
}

function roas(m: PulseWindowMetrics): number | null {
  return m.spend_usd > 0 ? m.purchase_value_usd / m.spend_usd : null;
}

function pct(prior: number, current: number): number | null {
  if (prior === 0) return null;
  return (current - prior) / prior;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function detectAdsAnomaly(input: PulseInputs): PulseResult {
  const { current, prior } = input;
  const breaches: PulseBreach[] = [];

  if (input.pixel_overall_status === "degraded" || input.pixel_overall_status === "no_pixel") {
    breaches.push({
      metric: "pixel",
      direction: "degraded",
      detail:
        input.pixel_overall_status === "no_pixel"
          ? "Conversion pixel missing — ROAS/CAC are blind."
          : "Conversion pixel degraded (no recent events / stale) — ROAS/CAC are now untrustworthy.",
      prior_value: null,
      current_value: null,
      pct_change: null,
    });
  }

  if (
    prior.spend_usd >= DELIVERY_STOPPED_FLOOR_USD &&
    current.spend_usd <= DELIVERY_STOPPED_CURRENT_CEIL_USD
  ) {
    breaches.push({
      metric: "delivery",
      direction: "stopped",
      detail: `Delivery stopped — spend fell from $${round2(prior.spend_usd)} (prior 7d) to $${round2(
        current.spend_usd,
      )} (last 7d).`,
      prior_value: round2(prior.spend_usd),
      current_value: round2(current.spend_usd),
      pct_change: pct(prior.spend_usd, current.spend_usd),
    });
  }

  const aboveFloor = prior.spend_usd >= MIN_PRIOR_SPEND_USD;

  if (aboveFloor) {
    const spendPct = pct(prior.spend_usd, current.spend_usd);
    if (spendPct != null && Math.abs(spendPct) >= PULSE_PCT_THRESHOLD) {
      const up = spendPct > 0;
      const alreadyStopped = breaches.some((b) => b.metric === "delivery");
      if (!(!up && alreadyStopped)) {
        breaches.push({
          metric: "spend",
          direction: up ? "up" : "down",
          detail: `Spend ${up ? "up" : "down"} ${Math.abs(Math.round(spendPct * 100))}% — $${round2(
            prior.spend_usd,
          )} → $${round2(current.spend_usd)} (prior 7d → last 7d).`,
          prior_value: round2(prior.spend_usd),
          current_value: round2(current.spend_usd),
          pct_change: spendPct,
        });
      }
    }

    const priorCac = cac(prior);
    const currentCac = cac(current);
    if (priorCac != null && currentCac != null) {
      const cacPct = pct(priorCac, currentCac);
      if (cacPct != null && cacPct >= PULSE_PCT_THRESHOLD) {
        breaches.push({
          metric: "cac",
          direction: "up",
          detail: `CAC up ${Math.round(cacPct * 100)}% — $${round2(priorCac)} → $${round2(
            currentCac,
          )} per conversion (prior 7d → last 7d).`,
          prior_value: round2(priorCac),
          current_value: round2(currentCac),
          pct_change: cacPct,
        });
      }
    }

    const priorRoas = roas(prior);
    const currentRoas = roas(current);
    if (priorRoas != null && currentRoas != null && priorRoas > 0) {
      const roasPct = pct(priorRoas, currentRoas);
      if (roasPct != null && roasPct <= -PULSE_PCT_THRESHOLD) {
        breaches.push({
          metric: "roas",
          direction: "down",
          detail: `ROAS down ${Math.abs(Math.round(roasPct * 100))}% — ${round2(
            priorRoas,
          )}x → ${round2(currentRoas)}x (prior 7d → last 7d).`,
          prior_value: round2(priorRoas),
          current_value: round2(currentRoas),
          pct_change: roasPct,
        });
      }
    }
  }

  return { breached: breaches.length > 0, breaches };
}

export function renderPulseIntent(breaches: PulseBreach[]): string {
  if (breaches.length === 0) return "";
  const lines = [
    "AUTOMATED DAILY ADS PULSE — a deterministic threshold pre-check detected the following Meta-ads anomaly(ies) in the last 7 days vs the prior 7 days. Re-pull the live figures with your meta_ads__* tools, confirm or refute each, diagnose the cause, and propose the corrective action (draft/approval-gated — do NOT assume any number below without re-confirming it this run):",
    "",
  ];
  for (const b of breaches) {
    lines.push(`- [${b.metric}/${b.direction}] ${b.detail}`);
  }
  return lines.join("\n");
}
