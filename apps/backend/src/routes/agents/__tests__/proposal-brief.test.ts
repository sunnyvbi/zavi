
import { describe, it, expect } from "vitest";
import {
  outcomeWasRight,
  buildTrackRecord,
  buildTrend,
  buildConfidence,
  assembleBrief,
  MIN_TRACK_RECORD_SAMPLE,
  type MeasuredOutcome,
  type CampaignMetric,
} from "../proposal-brief";

function pause(delta: Record<string, unknown>): MeasuredOutcome {
  return { action_class: "meta_ads.set_status", decision_outcome: "approved", delta_metrics: delta };
}
function budget(delta: Record<string, unknown>): MeasuredOutcome {
  return { action_class: "meta_ads.update_ad_set_budget", decision_outcome: "approved", delta_metrics: delta };
}

describe("outcomeWasRight — per action class, from the measured delta", () => {
  it("pause with positive spend_avoided_estimate → right", () => {
    expect(outcomeWasRight(pause({ spend_avoided_estimate: 120 }))).toBe(true);
  });
  it("pause with zero avoided → wrong", () => {
    expect(outcomeWasRight(pause({ spend_avoided_estimate: 0 }))).toBe(false);
  });
  it("pause without avoided but negative spend delta → right (fallback)", () => {
    expect(outcomeWasRight(pause({ spend: -50 }))).toBe(true);
  });
  it("pause with no judgeable signal → null (not counted)", () => {
    expect(outcomeWasRight(pause({}))).toBeNull();
  });
  it("budget change: roas held/improved → right; tanked → wrong", () => {
    expect(outcomeWasRight(budget({ roas: 0.2 }))).toBe(true);
    expect(outcomeWasRight(budget({ roas: 0 }))).toBe(true);
    expect(outcomeWasRight(budget({ roas: -0.4 }))).toBe(false);
  });
  it("unknown class → null", () => {
    expect(
      outcomeWasRight({ action_class: "meta_ads.weird", decision_outcome: "approved", delta_metrics: { roas: 1 } }),
    ).toBeNull();
  });
});

describe("buildTrackRecord — sample floor + judgeable-only counting", () => {
  it("first-time / empty → null (no chip, no 0-of-0)", () => {
    expect(buildTrackRecord("meta_ads.set_status", [])).toBeNull();
  });

  it("below the minimum sample → null (hidden)", () => {
    const outcomes = [pause({ spend_avoided_estimate: 10 }), pause({ spend_avoided_estimate: 20 })];
    expect(outcomes.length).toBeLessThan(MIN_TRACK_RECORD_SAMPLE);
    expect(buildTrackRecord("meta_ads.set_status", outcomes)).toBeNull();
  });

  it("at/above the floor → counts right out of n (judgeable only)", () => {
    const outcomes = [
      pause({ spend_avoided_estimate: 10 }),
      pause({ spend_avoided_estimate: 0 }),
      pause({ spend_avoided_estimate: 30 }),
      pause({}),
    ];
    const tr = buildTrackRecord("meta_ads.set_status", outcomes);
    expect(tr).not.toBeNull();
    expect(tr!.n).toBe(3);
    expect(tr!.right).toBe(2);
    expect(tr!.label).toContain("2 of 3");
    expect(tr!.label).toContain("pause");
  });

  it("only counts the requested class (no cross-class bleed)", () => {
    const outcomes = [
      pause({ spend_avoided_estimate: 10 }),
      pause({ spend_avoided_estimate: 10 }),
      pause({ spend_avoided_estimate: 10 }),
      budget({ roas: 0.5 }),
      budget({ roas: 0.5 }),
    ];
    const tr = buildTrackRecord("meta_ads.set_status", outcomes);
    expect(tr!.n).toBe(3);
  });

  it("never divides by zero (all unjudgeable → null, not NaN)", () => {
    const outcomes = [pause({}), pause({}), pause({}), pause({})];
    expect(buildTrackRecord("meta_ads.set_status", outcomes)).toBeNull();
  });
});

describe("buildTrend — bounded multi-window, null-safe", () => {
  const byWindow: Record<string, CampaignMetric[]> = {
    last_7d: [{ campaign_id: "c1", spend: 100, roas: 2.1 }],
    this_month: [{ campaign_id: "c1", spend: 400, roas: 1.8 }],
    last_month: [{ campaign_id: "c2", spend: 50, roas: 0.4 }],
  };

  it("joins the campaign across windows; absent window → null point (not 0)", () => {
    const t = buildTrend("c1", byWindow);
    expect(t).not.toBeNull();
    expect(t!.length).toBe(3);
    expect(t![0]).toMatchObject({ window: "last_7d", spend: 100, roas: 2.1 });
    expect(t![2]).toMatchObject({ window: "last_month", spend: null, roas: null });
  });

  it("no campaign_id → null", () => {
    expect(buildTrend(null, byWindow)).toBeNull();
  });

  it("campaign in no window → null (all points null)", () => {
    expect(buildTrend("c9", byWindow)).toBeNull();
  });
});

describe("buildConfidence", () => {
  it("explicit evidence confidence → banded value", () => {
    expect(buildConfidence(0.8, null)).toMatchObject({ band: "high", value: 0.8, source: "evidence" });
    expect(buildConfidence(0.4, null)).toMatchObject({ band: "medium", source: "evidence" });
    expect(buildConfidence(0.1, null)).toMatchObject({ band: "low", source: "evidence" });
  });
  it("no evidence → sample-size band from prose", () => {
    expect(buildConfidence(undefined, "scaled on n=21 purchases")).toMatchObject({ band: "high", source: "sample_size" });
    expect(buildConfidence(undefined, "5 purchases so far")).toMatchObject({ band: "medium" });
    expect(buildConfidence(undefined, "1 purchase")).toMatchObject({ band: "low" });
  });
  it("nothing to base a band on → null", () => {
    expect(buildConfidence(undefined, null)).toBeNull();
    expect(buildConfidence(undefined, "no numbers here")).toBeNull();
  });
});

describe("assembleBrief", () => {
  it("returns null when every field is null (route omits the brief)", () => {
    const b = assembleBrief({
      actionClass: "meta_ads.set_status",
      campaignId: null,
      measuredOutcomes: [],
      metricsByWindow: {},
      evidenceConfidence: undefined,
      reasoningText: null,
    });
    expect(b).toBeNull();
  });

  it("assembles present fields", () => {
    const b = assembleBrief({
      actionClass: "meta_ads.set_status",
      campaignId: "c1",
      measuredOutcomes: [
        pause({ spend_avoided_estimate: 10 }),
        pause({ spend_avoided_estimate: 10 }),
        pause({ spend_avoided_estimate: 0 }),
      ],
      metricsByWindow: { last_7d: [{ campaign_id: "c1", spend: 100, roas: 2 }] },
      evidenceConfidence: 0.9,
      reasoningText: null,
    });
    expect(b).not.toBeNull();
    expect(b!.track_record!.n).toBe(3);
    expect(b!.trend).not.toBeNull();
    expect(b!.confidence!.band).toBe("high");
  });
});
