
import { describe, expect, it } from "vitest";
import {
  gadsActionType,
  gadsActionsToViews,
  gadsKpisToMetrics,
  xDraftToView,
  xMetricsToMetrics,
} from "./legacyChannelActions";
import type { GadsAction, GadsPayload } from "./google-ads/types";
import { metricDelta } from "../metrics/format";
import type { XDraft, XMetric } from "./XAgentDashboard";

const gads = (over: Partial<GadsAction> = {}): GadsAction => ({
  key: "gads:1",
  decision_id: "d1",
  decision_class: "google_ads.update_campaign_budget_review",
  bucket: "needs_approval",
  title: "Raise the capped campaign's budget",
  is_new: false,
  effort_label: "1 min",
  change_sentence: "Zavi raises the daily budget from $40 to $55.",
  evidence: { window_label: "30 days", tiles: [{ value: "26 of 30", caption: "days the budget ran out" }], reasoning: "It is the cheapest result you buy." },
  exact_change: { rows: [{ item: "Daily budget", before: "$40", after: "$55" }] },
  estimate: { tiles: [{ value: "≈ 14", caption: "more results a month" }] },
  link: "https://ads.google.com/aw/campaigns",
  applied_at: null,
  ...over,
});

describe("gadsActionType", () => {
  it("reads the change out of the old decision class", () => {
    expect(gadsActionType("google_ads.update_campaign_budget_review")).toBe("update_ad");
    expect(gadsActionType("google_ads.pause_keywords")).toBe("pause_ad");
    expect(gadsActionType("google_ads.add_negative_keywords")).toBe("pause_ad");
    expect(gadsActionType("google_ads.create_campaign")).toBe("create_ad");
    expect(gadsActionType("channel.recipe_step")).toBe("other");
    expect(gadsActionType("something.else")).toBe("other");
  });
});

describe("gadsActionsToViews", () => {
  it("carries the evidence, the exact change and the estimate onto the card", () => {
    const [v] = gadsActionsToViews([gads()]);
    expect(v.id).toBe("d1");
    expect(v.channel_slug).toBe("google_ads");
    expect(v.action_type).toBe("update_ad");
    expect(v.executable).toBe(true);
    expect(v.body.exact_change?.rows[0]).toEqual({ item: "Daily budget", before: "$40", after: "$55" });
    expect(v.body.decision_evidence?.stats?.[0].value).toBe("26 of 30");
    expect(v.body.decision_evidence?.estimate?.[0].value).toBe("≈ 14");
    expect(v.body.decision_evidence?.reason_text).toBe("It is the cheapest result you buy.");
  });

  it("invents no ranking the old payload never carried", () => {
    const [v] = gadsActionsToViews([gads()]);
    expect(v.score).toBe(0);
    expect(v.impact).toBeNull();
    expect(v.score_inputs).toEqual({});
  });

  it("only a needs_approval platform change is executable", () => {
    expect(gadsActionsToViews([gads({ bucket: "needs_you", decision_class: "channel.recipe_step" })])[0].executable).toBe(false);
    expect(gadsActionsToViews([gads({ bucket: "autonomous" })])[0].executable).toBe(false);
  });

  it("drops an applied change: it is history, not something to approve", () => {
    expect(gadsActionsToViews([gads({ applied_at: "2026-09-15T10:00:00Z" })])).toEqual([]);
  });
});

describe("gadsKpisToMetrics", () => {
  const payload = (): GadsPayload =>
    ({
      connected: true,
      error_code: null,
      window_days: 30,
      period: { from: "2026-08-17", to: "2026-09-15" },
      prev_period: { from: "2026-07-18", to: "2026-08-16" },
      account: null,
      kpis: [
        { key: "spend", label: "Spend", unit: "usd", value: 18420, prev: 16446, delta_pct: 12, delta_abs: 1974, delta_good: null },
        { key: "cpa", label: "Cost per conversion", unit: "usd", value: null, prev: null, delta_pct: null, delta_abs: null, delta_good: null },
      ],
      campaigns: [],
      totals: null,
      actions: [],
      counts: { all: 0, needs_you: 0, autonomous: 0 },
    }) as GadsPayload;

  it("keeps the unit, the previous value and the day the numbers cover", () => {
    const [spend] = gadsKpisToMetrics(payload());
    expect(spend).toMatchObject({ key: "spend", value: 18420, unit: "usd", prev_value: 16446, day: "2026-09-15", prev_day: "2026-08-16", grounded: true });
  });

  it("keeps a card for a number it could not read, and marks it ungrounded", () => {
    const cpa = gadsKpisToMetrics(payload())[1];
    expect(Number.isNaN(cpa.value)).toBe(true);
    expect(cpa.grounded).toBe(false);
  });

  const withKpis = (kpis: GadsPayload["kpis"]): GadsPayload => ({ ...payload(), kpis });
  const pacing = (value: number | null, spend: number | null = 1266.72, plan: number | null = 1500): GadsPayload["kpis"][number] => ({
    key: "pacing",
    label: "Spend vs plan",
    unit: "pct",
    value,
    prev: null,
    delta_pct: null,
    delta_abs: null,
    delta_good: null,
    pacing: { spend, plan, plan_basis: "founder", pct: value, capped_campaigns: 2, campaigns: 2, days_elapsed: 25, days_in_month: 30 },
  });

  it("gives the pacing tile its arithmetic and a verdict by pace, not by share of plan", () => {
    const [p] = gadsKpisToMetrics(withKpis([pacing(101)]));
    expect(p.note).toBe("$1,267 of $1,500 · day 25 of 30");
    expect(p.tone).toBe("good");
    expect(gadsKpisToMetrics(withKpis([pacing(105)]))[0].tone).toBe("good");
    expect(gadsKpisToMetrics(withKpis([pacing(112)]))[0].tone).toBe("warn");
    expect(gadsKpisToMetrics(withKpis([pacing(125)]))[0].tone).toBe("warn");
    expect(gadsKpisToMetrics(withKpis([pacing(140)]))[0].tone).toBe("bad");
  });

  it("claims no pace verdict or arithmetic it cannot read", () => {
    const [p] = gadsKpisToMetrics(withKpis([pacing(null, null, null)]));
    expect(p.tone).toBeUndefined();
    expect(p.note).toBeUndefined();
  });

  it("marks a ROAS under 1 as losing money, in dollars back per dollar", () => {
    const roasKpi = (value: number | null): GadsPayload["kpis"][number] => ({
      key: "roas", label: "ROAS", unit: "ratio", value, prev: null, delta_pct: null, delta_abs: null, delta_good: null,
    });
    const [low] = gadsKpisToMetrics(withKpis([roasKpi(0.76)]));
    expect(low).toMatchObject({ tone: "bad", note: "$0.76 back per $1 spent" });
    expect(gadsKpisToMetrics(withKpis([roasKpi(1)]))[0].tone).toBe("good");
    expect(gadsKpisToMetrics(withKpis([roasKpi(null)]))[0].tone).toBeUndefined();
  });

  it("a ROAS floor says 'at least' and is never red", () => {
    const floorKpi = (value: number): GadsPayload["kpis"][number] => ({
      key: "roas", label: "ROAS", unit: "ratio", value, prev: null, delta_pct: null, delta_abs: null, delta_good: null, floor: true,
    });
    expect(gadsKpisToMetrics(withKpis([floorKpi(0.9)]))[0]).toMatchObject({ tone: "warn", note: "at least $0.90 back per $1 spent" });
    expect(gadsKpisToMetrics(withKpis([floorKpi(1.4)]))[0]).toMatchObject({ tone: "good", note: "at least $1.40 back per $1 spent" });
  });

  it("a ROAS floor carries no previous value, so no directional change is drawn", () => {
    const [r] = gadsKpisToMetrics(withKpis([
      { key: "roas", label: "ROAS", unit: "ratio", value: 0.9, prev: 1.8, delta_pct: -50, delta_abs: -0.9, delta_good: true, floor: true },
    ]));
    expect(r.prev_value).toBeNull();
    expect(r.prev_day).toBeNull();
    expect(metricDelta(r)).toBeNull();
  });
});

describe("xDraftToView", () => {
  const draft = (over: Partial<XDraft> = {}): XDraft => ({
    decision_id: "d1",
    channel: "x",
    text: "Three steps, in order.",
    thread: null,
    image_path: null,
    video_path: null,
    scheduled_at: "2026-09-17T09:30:00Z",
    rationale: "Numbered posts are what this audience replies to.",
    emitted_at: null,
    ...over,
  });

  it("a plain draft is a text post whose deliverable is the post itself", () => {
    const v = xDraftToView(draft());
    expect(v.action_type).toBe("text_post");
    expect(v.body.step?.deliverable?.content).toBe("Three steps, in order.");
    expect(v.body.step?.body).toBe("Numbered posts are what this audience replies to.");
    expect(v.proposed_at).toBe("2026-09-17T09:30:00Z");
  });

  it("media decides the type, and the thread rides along", () => {
    expect(xDraftToView(draft({ image_path: "https://cdn.example.com/a.png" })).action_type).toBe("image_post");
    expect(xDraftToView(draft({ video_path: "https://cdn.example.com/a.mp4" })).action_type).toBe("video_post");
    expect(xDraftToView(draft({ thread: ["Part two.", "Part three."] })).body.thread).toEqual(["Part two.", "Part three."]);
  });
});

describe("xMetricsToMetrics", () => {
  const m = (over: Partial<XMetric> = {}): XMetric => ({
    key: "impressions",
    label: "Impressions",
    value: 24800,
    unit: "count",
    delta: 18.2,
    delta_unit: "pct",
    basis: "period",
    ...over,
  });

  it("derives a previous value that reproduces the move the payload reported", () => {
    const [v] = xMetricsToMetrics([m()]);
    expect(v.prev_value).not.toBeNull();
    const move = ((v.value - (v.prev_value as number)) / (v.prev_value as number)) * 100;
    expect(Math.round(move * 10) / 10).toBe(18.2);
  });

  it("a move in points is a straight subtraction", () => {
    const [v] = xMetricsToMetrics([m({ key: "engagement_rate", unit: "pct", value: 2.8, delta: 0.4, delta_unit: "pp" })]);
    expect(v.prev_value).toBeCloseTo(2.4, 5);
    expect(v.unit).toBe("pct");
  });

  it("no move reported means no comparison, not a zero", () => {
    expect(xMetricsToMetrics([m({ delta: null })])[0].prev_value).toBeNull();
  });

  it("a number the run could not read stays on the card, ungrounded", () => {
    const [v] = xMetricsToMetrics([m({ value: null, delta: null, basis: "none" })]);
    expect(Number.isNaN(v.value)).toBe(true);
    expect(v.grounded).toBe(false);
  });

  it("puts the counts before the rates", () => {
    const out = xMetricsToMetrics([
      m({ key: "engagement_rate", unit: "pct", value: 2.5 }),
      m({ key: "impressions", value: 4200 }),
      m({ key: "replies", value: 3 }),
    ]);
    expect(out.map((x) => x.key)).toEqual(["impressions", "replies", "engagement_rate"]);
  });

  it("says a rate from fewer than 100 views is a small sample, and only then", () => {
    const thin = xMetricsToMetrics([m({ value: 40 }), m({ key: "engagement_rate", unit: "pct", value: 2.5 })]);
    expect(thin.find((x) => x.key === "engagement_rate")?.note).toBe("From only 40 views");
    expect(thin.find((x) => x.key === "impressions")?.note).toBeUndefined();
    const enough = xMetricsToMetrics([m({ value: 100 }), m({ key: "engagement_rate", unit: "pct", value: 2.5 })]);
    expect(enough.find((x) => x.key === "engagement_rate")?.note).toBeUndefined();
  });
});
