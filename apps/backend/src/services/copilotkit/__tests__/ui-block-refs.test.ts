import { beforeEach, describe, expect, it } from "vitest";
import { UiBlockSchema, parseUiBlock } from "@zavi/shared";
import { _clearResults, putResult } from "@/services/analytics/metric-results";
import { resolveChartInput, resolveKpiInput } from "../ui-block-refs";
import { ChartInputSchema, KpiInputSchema } from "../ui-tools";

const CTX = { tenant_id: "t-1", run_id: "run-1" };
const METRIC_ID = "m_0123456789";
const PRIOR_ID = "m_aaaaaaaaaa";
const COMPUTE_ID = "c_bbbbbbbbbb";

const receipt = {
  source: "stripe",
  metric_id: "net_revenue",
  definition: "Stripe balance transactions, net of fees and refunds",
  window: { since: "2026-09-01", until: "2026-09-03" },
  tz: "America/Los_Angeles",
  fetched_at: "2026-09-04T10:00:00.000Z",
  currency: "USD",
  params: { grain: "day" },
  row_count: 42,
  truncated: false,
  caveats: ["Refunds post on the day they are issued."],
};

beforeEach(() => {
  _clearResults();
  putResult(CTX.tenant_id, CTX.run_id, {
    result_id: METRIC_ID,
    kind: "metric",
    value: 3150.5,
    compare_value: 2800,
    receipt,
    label: "Net revenue",
    unit: "currency",
    series: [
      { start: "2026-09-01", end: "2026-09-01", value: 1000.25, partial: false },
      { start: "2026-09-02", end: "2026-09-02", value: null, partial: false },
      { start: "2026-09-03", end: "2026-09-03", value: 2150.25, partial: false },
    ],
    delta_pct: 12.52,
  });
  putResult(CTX.tenant_id, CTX.run_id, {
    result_id: PRIOR_ID,
    kind: "metric",
    value: 2800,
    receipt: { ...receipt, window: { since: "2026-08-29", until: "2026-08-31" } },
    unit: "currency",
    series: [
      { start: "2026-08-29", end: "2026-08-29", value: 1400, partial: false },
      { start: "2026-08-31", end: "2026-08-31", value: 1400, partial: false },
    ],
  });
  putResult(CTX.tenant_id, CTX.run_id, {
    result_id: COMPUTE_ID,
    kind: "compute",
    value: 12.52,
    receipt: { source: "compute", formula: "pct_change(2800, 3150.5) = 12.52", inputs: {} },
    verified: true,
  });
});

describe("show_chart with result_id", () => {
  it("draws the result's values, not the model's, and carries the receipt", () => {
    const input = ChartInputSchema.parse({
      title: "Net revenue",
      variant: "line",
      unit: "%",
      result_id: METRIC_ID,
      compare_result_id: PRIOR_ID,
      series: [{ label: "made up", value: 999999 }],
      goal: 1500,
    });
    const r = resolveChartInput(CTX, input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.block;
    expect(b.series).toEqual([
      { label: "2026-09-01", value: 1000.25 },
      { label: "2026-09-03", value: 2150.25 },
    ]);
    expect(b.compare).toEqual([
      { label: "2026-08-29", value: 1400 },
      { label: "2026-08-31", value: 1400 },
    ]);
    expect(b.verified).toBe(true);
    expect(b.result_id).toBe(METRIC_ID);
    expect(b.unit).toBe("$");
    expect(b.goal).toBe(1500);
    expect(b.as_of).toBe("2026-09-04T10:00:00.000Z");
    expect(b.window).toEqual({ since: "2026-09-01", until: "2026-09-03" });
    expect(b.receipt).toMatchObject({ source: "stripe", metric_id: "net_revenue", tz: "America/Los_Angeles", currency: "USD" });
    expect(UiBlockSchema.safeParse(b).success).toBe(true);
    expect(parseUiBlock(JSON.parse(JSON.stringify(b)))).not.toBeNull();
  });

  it("refuses a comparison that is a different metric", () => {
    putResult(CTX.tenant_id, CTX.run_id, {
      result_id: "m_cccccccccc",
      kind: "metric",
      value: 40,
      receipt: { ...receipt, metric_id: "signups" },
      unit: "count",
      series: [{ start: "2026-08-29", end: "2026-08-29", value: 40, partial: false }],
    });
    const r = resolveChartInput(CTX, ChartInputSchema.parse({ title: "Net revenue", variant: "line", result_id: METRIC_ID, compare_result_id: "m_cccccccccc" }));
    expect(r.ok).toBe(false);
  });

  it("keeps typed numbers working, marked unverified", () => {
    const r = resolveChartInput(CTX, ChartInputSchema.parse({ title: "Typed", series: [{ label: "a", value: 1 }] }));
    expect(r.ok && r.block.verified).toBe(false);
    if (r.ok) expect(r.block.receipt).toBeUndefined();
  });

  it("refuses a result id that is not from this run, or this tenant", () => {
    expect(resolveChartInput({ ...CTX, run_id: "other-run" }, { title: "x", variant: "bar", result_id: METRIC_ID }).ok).toBe(false);
    const r = resolveChartInput({ ...CTX, tenant_id: "t-2" }, { title: "x", variant: "bar", result_id: METRIC_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/growth__get_metric/);
  });

  it("refuses to chart a compute result (one number, not a series)", () => {
    const r = resolveChartInput(CTX, { title: "x", variant: "bar", result_id: COMPUTE_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/show_kpis/);
  });

  it("does not accept provenance fields from the model", () => {
    expect(ChartInputSchema.safeParse({ title: "x", series: [{ label: "a", value: 1 }], verified: true }).success).toBe(false);
    expect(ChartInputSchema.safeParse({ title: "x", variant: "bar", result_id: "not-an-id" }).success).toBe(false);
  });
});

describe("show_kpis with result_id", () => {
  it("fills value and delta from the results; the typed item is unverified", () => {
    const input = KpiInputSchema.parse({
      title: "September",
      items: [
        { label: "Net revenue", result_id: METRIC_ID, value: 1, delta: "+99% vs last week" },
        { label: "Change", result_id: COMPUTE_ID },
        { label: "Typed", value: "$5K" },
      ],
    });
    const r = resolveKpiInput(CTX, input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [rev, change, typed] = r.block.items;
    expect(rev).toMatchObject({ value: 3150.5, delta: "+12.52% vs prior period", tone: "up", verified: true, result_id: METRIC_ID });
    expect(rev.receipt?.source).toBe("stripe");
    expect(change).toMatchObject({ value: 12.52, verified: true });
    expect(change.receipt).toMatchObject({ source: "compute", formula: "pct_change(2800, 3150.5) = 12.52" });
    expect(typed).toMatchObject({ value: "$5K", verified: false });
    expect(r.block.verified).toBe(false);
    expect(UiBlockSchema.safeParse(r.block).success).toBe(true);
  });

  it("refuses an item with neither a value nor a result", () => {
    expect(resolveKpiInput(CTX, { title: "x", items: [{ label: "empty" }] }).ok).toBe(false);
  });
  it("a compute over a plain number makes an unverified card", () => {
    putResult(CTX.tenant_id, CTX.run_id, {
      result_id: "c_cccccccccc",
      kind: "compute",
      value: 3.15,
      receipt: { source: "compute", formula: "3150.5 / 1000 = 3.15", inputs: {} },
      verified: false,
    });
    const r = resolveKpiInput(CTX, { title: "x", items: [{ label: "Per order", result_id: "c_cccccccccc" }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.block.items[0]).toMatchObject({ value: 3.15, verified: false, result_id: "c_cccccccccc" });
    expect(r.block.verified).toBe(false);
  });

  it("a compute result with no verdict recorded is not verified", () => {
    putResult(CTX.tenant_id, CTX.run_id, { result_id: "c_dddddddddd", kind: "compute", value: 1, receipt: { source: "compute" } });
    const r = resolveKpiInput(CTX, { title: "x", items: [{ label: "Old", result_id: "c_dddddddddd" }] });
    expect(r.ok && r.block.items[0].verified).toBe(false);
  });
});

describe("stored blocks from before the refs", () => {
  it("still parse, with no provenance fields", () => {
    expect(parseUiBlock({ kind: "chart", title: "Old", variant: "bar", series: [{ label: "a", value: 1 }] })).not.toBeNull();
    expect(parseUiBlock({ kind: "kpi", title: "Old", items: [{ label: "a", value: 1, delta: "+1%" }] })).not.toBeNull();
  });
});
