
import { describe, it, expect } from "vitest";
import {
  detectAdsAnomaly,
  renderPulseIntent,
  PULSE_PCT_THRESHOLD,
  type PulseInputs,
} from "../perfmkt-pulse-detect";

function inputs(over: Partial<PulseInputs> = {}): PulseInputs {
  return {
    current: { spend_usd: 100, conversions: 10, purchase_value_usd: 300 },
    prior: { spend_usd: 100, conversions: 10, purchase_value_usd: 300 },
    pixel_overall_status: "healthy",
    ...over,
  };
}

describe("detectAdsAnomaly — quiet day", () => {
  it("identical windows + healthy pixel → no breach (no enqueue)", () => {
    const r = detectAdsAnomaly(inputs());
    expect(r.breached).toBe(false);
    expect(r.breaches).toHaveLength(0);
  });

  it("small sub-20% drift → no breach", () => {
    const r = detectAdsAnomaly(
      inputs({ current: { spend_usd: 110, conversions: 11, purchase_value_usd: 330 } }),
    );
    expect(r.breached).toBe(false);
  });

  it("web_only pixel alone is NOT a breach (standing hygiene note, not an overnight break)", () => {
    const r = detectAdsAnomaly(inputs({ pixel_overall_status: "web_only" }));
    expect(r.breached).toBe(false);
  });

  it("unknown pixel status (read failed) → not a breach", () => {
    const r = detectAdsAnomaly(inputs({ pixel_overall_status: "unknown" }));
    expect(r.breached).toBe(false);
  });
});

describe("detectAdsAnomaly — spend breach (the bleed sentinel)", () => {
  it("spend up ≥20% → breach with metric=spend direction=up", () => {
    const r = detectAdsAnomaly(
      inputs({ current: { spend_usd: 150, conversions: 10, purchase_value_usd: 300 } }),
    );
    expect(r.breached).toBe(true);
    const spend = r.breaches.find((b) => b.metric === "spend");
    expect(spend?.direction).toBe("up");
    expect(spend?.pct_change).toBeCloseTo(0.5, 5);
  });

  it("exactly at the ±20% threshold → breach (boundary inclusive)", () => {
    const r = detectAdsAnomaly(
      inputs({
        prior: { spend_usd: 100, conversions: 10, purchase_value_usd: 300 },
        current: { spend_usd: 120, conversions: 12, purchase_value_usd: 360 },
      }),
    );
    expect(r.breached).toBe(true);
    expect(Math.abs(r.breaches.find((b) => b.metric === "spend")!.pct_change!)).toBeCloseTo(
      PULSE_PCT_THRESHOLD,
      5,
    );
  });
});

describe("detectAdsAnomaly — delivery stopped", () => {
  it("prior spent materially, current ~zero → delivery/stopped breach", () => {
    const r = detectAdsAnomaly(
      inputs({
        prior: { spend_usd: 200, conversions: 20, purchase_value_usd: 600 },
        current: { spend_usd: 0, conversions: 0, purchase_value_usd: 0 },
      }),
    );
    expect(r.breached).toBe(true);
    const delivery = r.breaches.find((b) => b.metric === "delivery");
    expect(delivery?.direction).toBe("stopped");
    const spendDown = r.breaches.find((b) => b.metric === "spend" && b.direction === "down");
    expect(spendDown).toBeUndefined();
  });
});

describe("detectAdsAnomaly — CAC + ROAS degradation", () => {
  it("CAC up ≥20% (same spend, fewer conversions) → cac/up breach", () => {
    const r = detectAdsAnomaly(
      inputs({
        prior: { spend_usd: 100, conversions: 10, purchase_value_usd: 300 },
        current: { spend_usd: 100, conversions: 7, purchase_value_usd: 300 },
      }),
    );
    expect(r.breached).toBe(true);
    expect(r.breaches.some((b) => b.metric === "cac" && b.direction === "up")).toBe(true);
  });

  it("ROAS down ≥20% (same spend, lower purchase value) → roas/down breach", () => {
    const r = detectAdsAnomaly(
      inputs({
        prior: { spend_usd: 100, conversions: 10, purchase_value_usd: 400 },
        current: { spend_usd: 100, conversions: 10, purchase_value_usd: 280 },
      }),
    );
    expect(r.breached).toBe(true);
    expect(r.breaches.some((b) => b.metric === "roas" && b.direction === "down")).toBe(true);
  });
});

describe("detectAdsAnomaly — pixel degraded", () => {
  it("degraded pixel → pixel/degraded breach even when spend/CAC/ROAS are flat", () => {
    const r = detectAdsAnomaly(inputs({ pixel_overall_status: "degraded" }));
    expect(r.breached).toBe(true);
    expect(r.breaches[0].metric).toBe("pixel");
  });

  it("no_pixel → pixel breach", () => {
    const r = detectAdsAnomaly(inputs({ pixel_overall_status: "no_pixel" }));
    expect(r.breached).toBe(true);
    expect(r.breaches.some((b) => b.metric === "pixel")).toBe(true);
  });
});

describe("detectAdsAnomaly — noise floor suppression", () => {
  it("tiny account ($3 → $6 = +100%) below MIN_PRIOR_SPEND_USD → no percentage breach", () => {
    const r = detectAdsAnomaly(
      inputs({
        prior: { spend_usd: 3, conversions: 0, purchase_value_usd: 0 },
        current: { spend_usd: 6, conversions: 0, purchase_value_usd: 0 },
        pixel_overall_status: "healthy",
      }),
    );
    expect(r.breached).toBe(false);
  });
});

describe("renderPulseIntent", () => {
  it("empty breaches → empty string", () => {
    expect(renderPulseIntent([])).toBe("");
  });

  it("breaches → scoped intent naming each [metric/direction]", () => {
    const r = detectAdsAnomaly(
      inputs({ current: { spend_usd: 150, conversions: 10, purchase_value_usd: 300 } }),
    );
    const intent = renderPulseIntent(r.breaches);
    expect(intent).toContain("AUTOMATED DAILY ADS PULSE");
    expect(intent).toContain("[spend/up]");
  });
});
