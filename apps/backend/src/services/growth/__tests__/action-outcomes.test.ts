
import { describe, it, expect, vi } from "vitest";
import {
  reconcileOutcomeBatch,
  computeDelta,
  type PendingOutcomeRow,
  type OutcomeReadResult,
  type MetaMetricSnapshot,
} from "../action-outcomes";

const row = (id: number, overrides: Partial<PendingOutcomeRow> = {}): PendingOutcomeRow => ({
  id,
  tenant_id: `t-${id}`,
  decision_id: `d-${id}`,
  outcome_tier: "business",
  subject_type: "campaign",
  subject_id: `c-${id}`,
  target_metric: "spend",
  baseline_metrics: { spend: 100, roas: 2 },
  measurement_window_days: 14,
  reconcile_after: new Date().toISOString(),
  attempt_count: 0,
  action_class: "meta_ads.set_status",
  decision_outcome: "approved",
  ...overrides,
});

const snap = (s: Partial<MetaMetricSnapshot> = {}): MetaMetricSnapshot => ({
  spend: 0,
  roas: null,
  conversions: 0,
  purchase_value: 0,
  impressions: 0,
  ...s,
});

const measured = (s: Partial<MetaMetricSnapshot> = {}): OutcomeReadResult => ({
  kind: "measured",
  snapshot: snap(s),
  window_start: "2026-01-01T00:00:00.000Z",
  window_end: "2026-01-15T00:00:00.000Z",
});

describe("reconcileOutcomeBatch", () => {
  it("tallies measured / no_data / error by the metric read result", async () => {
    const rows = [row(1), row(2), row(3)];
    const reads: Record<number, OutcomeReadResult> = {
      1: measured({ spend: 50 }),
      2: { kind: "no_data" },
      3: { kind: "error", message: "boom" },
    };
    const writeOutcome = vi.fn(async () => ({ applied: true }));

    const res = await reconcileOutcomeBatch(rows, async (r) => reads[r.id], writeOutcome);

    expect(res).toEqual({ scanned: 3, measured: 1, no_data: 1, errors: 1, noop: 0 });
    expect(writeOutcome).toHaveBeenCalledTimes(3);
  });

  it("counts a not-applied write as noop and does NOT count it toward measured", async () => {
    const res = await reconcileOutcomeBatch(
      [row(1)],
      async () => measured({ spend: 5 }),
      async () => ({ applied: false }),
    );
    expect(res).toEqual({ scanned: 1, measured: 0, no_data: 0, errors: 0, noop: 1 });
  });

  it("reads the metric for the row's OWN tenant/subject (C8 — derived from the row)", async () => {
    const rows = [
      row(1, { tenant_id: "tenant-A", subject_id: "s-A" }),
      row(2, { tenant_id: "tenant-B", subject_id: "s-B" }),
    ];
    const seen: string[] = [];
    await reconcileOutcomeBatch(
      rows,
      async (r) => {
        seen.push(`${r.tenant_id}:${r.subject_id}`);
        return measured();
      },
      async () => ({ applied: true }),
    );
    expect(seen).toEqual(["tenant-A:s-A", "tenant-B:s-B"]);
  });

  it("handles an empty batch without calling the IO fns", async () => {
    const readMetric = vi.fn();
    const writeOutcome = vi.fn();
    const res = await reconcileOutcomeBatch([], readMetric as never, writeOutcome as never);
    expect(res).toEqual({ scanned: 0, measured: 0, no_data: 0, errors: 0, noop: 0 });
    expect(readMetric).not.toHaveBeenCalled();
    expect(writeOutcome).not.toHaveBeenCalled();
  });
});

describe("computeDelta", () => {
  it("computes spend / roas / conversions deltas from shared numeric fields", () => {
    const d = computeDelta(
      { spend: 100, roas: 2, conversions: 10 },
      snap({ spend: 120, roas: 2.5, conversions: 14 }),
      { decisionOutcome: "rejected", actionClass: "meta_ads.set_status", windowDays: 14 },
    );
    expect(d.spend).toBe(20);
    expect(d.roas).toBe(0.5);
    expect(d.conversions).toBe(4);
    expect(d.spend_avoided_estimate).toBeUndefined();
  });

  it("adds a LABELLED spend_avoided estimate + stored inputs for an approved PAUSE", () => {
    const d = computeDelta(
      { spend: 200 },
      snap({ spend: 0 }),
      { decisionOutcome: "approved", actionClass: "meta_ads.set_status", windowDays: 14 },
    );
    expect(d.spend_avoided_estimate).toBe(200);
    expect(d.spend_avoided_inputs).toMatchObject({
      baseline_window_spend: 200,
      observed_window_spend: 0,
      window_days: 14,
      method: "baseline_window_spend_minus_observed",
    });
  });

  it("never emits a negative avoided estimate (clamps at 0)", () => {
    const d = computeDelta(
      { spend: 50 },
      snap({ spend: 80 }),
      { decisionOutcome: "approved", actionClass: "meta_ads.set_status", windowDays: 14 },
    );
    expect(d.spend_avoided_estimate).toBe(0);
  });

  it("skips a metric when either side is missing (no fabricated delta)", () => {
    const d = computeDelta(
      { roas: 2 },
      snap({ spend: 10, roas: null }),
      { decisionOutcome: "rejected", actionClass: "meta_ads.update_ad_set_budget", windowDays: 14 },
    );
    expect(d.spend).toBeUndefined();
    expect(d.roas).toBeUndefined();
  });
});
