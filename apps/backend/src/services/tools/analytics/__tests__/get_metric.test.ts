
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  stripe: { balanceTransactions: { list: vi.fn() }, customers: { list: vi.fn() } },
  stripeClient: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/tools/stripe/_client", () => ({ stripeClient: m.stripeClient }));

import { runGetMetric, getMetricInputSchema, GET_METRIC_LEDGER_NAME } from "../get_metric";
import { runCompute } from "../compute";
import { _clearResults } from "@/services/analytics/metric-results";
import {
  clearFigures,
  figureWasRead,
  moneyRoundingWasRead,
  recordFiguresFromPull,
  pullsForFigure,
  recordInputFigures,
  withholdFigures,
} from "@/services/agents/engine/figure-ledger";
import type { ToolContext } from "@/services/tools/types";
import type { DataNote } from "@/services/analytics/data-notes";

const NOW = new Date("2026-09-28T15:00:00Z");
const deps = {
  now: () => NOW,
  resolveTz: vi.fn(async () => ({ tz: "UTC", source: "stored" as const })),
  readDataNotes: vi.fn(async (): Promise<DataNote[]> => []),
};
const ctx = (tenant_id = "tenant-a", run_id = "run-1"): ToolContext => ({ tenant_id, run_id, log: () => undefined });
const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function charges(rows: Array<[string, number]>) {
  return {
    data: rows.map(([iso, cents], i) => ({
      id: `t${i}`,
      created: ts(iso),
      reporting_category: "charge",
      currency: "usd",
      amount: cents,
      net: cents,
    })),
    has_more: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _clearResults();
  m.stripeClient.mockResolvedValue(m.stripe);
});

describe("get_metric input", () => {
  it("is strict: a tenant_id in the arguments is rejected, not used", () => {
    expect(() => getMetricInputSchema.parse({ metric_id: "net_revenue", tenant_id: "tenant-b" })).toThrow();
  });

  it("only catalog ids are accepted", () => {
    expect(() => getMetricInputSchema.parse({ metric_id: "anything_you_like" })).toThrow();
  });
});

describe("get_metric", () => {
  it("returns series, total and a complete receipt", async () => {
    m.stripe.balanceTransactions.list.mockResolvedValue(charges([["2026-09-21T10:00:00Z", 12345], ["2026-09-25T10:00:00Z", 5000]]));
    const out = await runGetMetric(ctx(), { metric_id: "gross_revenue", window: { preset: "last_7d" } }, deps);
    expect(out).toMatchObject({ status: "ok", metric_id: "gross_revenue", unit: "currency", total: 173.45 });
    const ok = out as Extract<typeof out, { status: "ok" }>;
    expect(ok.result_id).toMatch(/^m_[0-9a-f]{10}$/);
    expect(ok.series).toHaveLength(7);
    expect(ok.series[0]).toMatchObject({ start: "2026-09-21", value: 123.45, partial: false });
    expect(Object.keys(ok.receipt).sort()).toEqual(
      ["caveats", "currency", "definition", "fetched_at", "metric_id", "params", "row_count", "source", "truncated", "tz", "window"].sort(),
    );
    expect(ok.receipt).toMatchObject({
      source: "stripe",
      metric_id: "gross_revenue",
      window: { since: "2026-09-21", until: "2026-09-27" },
      tz: "UTC",
      currency: "USD",
      fetched_at: NOW.toISOString(),
      row_count: 2,
      truncated: false,
    });
    expect(ok.receipt.params).toMatchObject({ grain: "day", window: { preset: "last_7d" } });
  });

  it("reads the tenant from ctx, and resolves ITS time zone", async () => {
    m.stripe.balanceTransactions.list.mockResolvedValue(charges([]));
    await runGetMetric(ctx("tenant-z"), { metric_id: "net_revenue" }, deps);
    expect(m.stripeClient).toHaveBeenCalledWith("tenant-z");
    expect(deps.resolveTz).toHaveBeenCalledWith("tenant-z");
  });

  it("founder data notes for this metric land in the receipt caveats, read for the ctx tenant", async () => {
    m.stripe.balanceTransactions.list.mockResolvedValue(charges([["2026-09-22T10:00:00Z", 15000]]));
    deps.readDataNotes.mockResolvedValueOnce([
      { id: "n1", metric_id: "net_revenue", note_text: "Revenue excludes test orders", created_by: null, created_at: "2026-09-28T10:00:00Z" },
    ]);
    const out = (await runGetMetric(ctx("tenant-z"), { metric_id: "net_revenue", window: { preset: "last_7d" } }, deps)) as {
      receipt: { caveats: string[] };
    };
    expect(deps.readDataNotes).toHaveBeenCalledWith("tenant-z", "net_revenue");
    expect(out.receipt.caveats.some((c) => c.includes('"Revenue excludes test orders"') && c.includes("2026-09-28"))).toBe(true);
  });

  it("a failed data-note read does not fail the metric, and says so", async () => {
    m.stripe.balanceTransactions.list.mockResolvedValue(charges([["2026-09-22T10:00:00Z", 15000]]));
    deps.readDataNotes.mockRejectedValueOnce(new Error("db down"));
    const out = (await runGetMetric(ctx(), { metric_id: "net_revenue", window: { preset: "last_7d" } }, deps)) as {
      status: string;
      receipt: { caveats: string[] };
    };
    expect(out.status).toBe("ok");
    expect(out.receipt.caveats.some((c) => c.includes("data notes could not be read"))).toBe(true);
  });

  it("compare adds compare_total and deltas from a second read of the prior window", async () => {
    m.stripe.balanceTransactions.list
      .mockResolvedValueOnce(charges([["2026-09-22T10:00:00Z", 15000]]))
      .mockResolvedValueOnce(charges([["2026-09-15T10:00:00Z", 10000]]));
    const out = await runGetMetric(ctx(), { metric_id: "gross_revenue", window: { preset: "last_7d" }, compare: "previous_period" }, deps);
    expect(out).toMatchObject({ total: 150, compare_total: 100, delta_abs: 50, delta_pct: 50 });
    expect(m.stripe.balanceTransactions.list.mock.calls[1][0].created.gte).toBe(ts("2026-09-14T00:00:00Z"));
  });

  it("no data source -> a status and a message, never a number", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    m.stripeClient.mockRejectedValue(new ExpectedToolError("stripe_not_connected"));
    const out = await runGetMetric(ctx(), { metric_id: "net_revenue" }, deps);
    expect(out).toMatchObject({ result_id: null, status: "not_connected" });
    expect(out).not.toHaveProperty("total");
  });

  it("an unsupported breakdown is refused with the supported list", async () => {
    const out = await runGetMetric(ctx(), { metric_id: "net_revenue", breakdown: "campaign" }, deps);
    expect(out).toMatchObject({ status: "unsupported" });
  });

  it("include_today marks today's day bucket partial (the day is not over)", async () => {
    m.stripe.balanceTransactions.list.mockResolvedValue(charges([["2026-09-28T10:00:00Z", 5000]]));
    const out = await runGetMetric(ctx(), { metric_id: "gross_revenue", window: { preset: "last_7d", include_today: true } }, deps);
    const ok = out as Extract<typeof out, { status: "ok" }>;
    expect(ok.series.at(-1)).toMatchObject({ start: "2026-09-28", partial: true });
    expect(ok.series[0].partial).toBe(false);
  });

  it("writes its figures to the run's ledger under its own name", async () => {
    m.stripe.balanceTransactions.list.mockResolvedValue(charges([["2026-09-21T10:00:00Z", 987654]]));
    await runGetMetric(ctx("tenant-a", "run-ledger"), { metric_id: "gross_revenue", window: { preset: "last_7d" } }, deps);
    expect(figureWasRead("run-ledger", "9,876.54")).toBe(true);
    expect(pullsForFigure("run-ledger", "9876.54")[0]).toEqual({ tool: GET_METRIC_LEDGER_NAME, nth: 1 });
  });
});

describe("compute over get_metric results", () => {
  it("references results by id, including #compare, and returns formula + receipts", async () => {
    m.stripe.balanceTransactions.list
      .mockResolvedValueOnce(charges([["2026-09-22T10:00:00Z", 15000]]))
      .mockResolvedValueOnce(charges([["2026-09-15T10:00:00Z", 12000]]));
    const g = (await runGetMetric(ctx(), { metric_id: "gross_revenue", window: { preset: "last_7d" }, compare: "previous_period" }, deps)) as {
      result_id: string;
    };
    const c = await runCompute(ctx(), {
      expression: "pct_change(prior, current)",
      inputs: { prior: `${g.result_id}#compare`, current: g.result_id },
    });
    expect(c).toMatchObject({ status: "ok", value: 25, verified: true, formula: "pct_change(120, 150) = 25" });
    expect((c as { inputs: Record<string, { receipt: { metric_id: string } }> }).inputs.current.receipt.metric_id).toBe("gross_revenue");
    expect(figureWasRead("run-1", "25")).toBe(true);
  });

  it("a result id from ANOTHER tenant or run does not resolve", async () => {
    m.stripe.balanceTransactions.list.mockResolvedValue(charges([["2026-09-22T10:00:00Z", 15000]]));
    const g = (await runGetMetric(ctx("tenant-a", "run-1"), { metric_id: "gross_revenue" }, deps)) as { result_id: string };
    expect(await runCompute(ctx("tenant-b", "run-1"), { expression: "x * 2", inputs: { x: g.result_id } })).toMatchObject({
      status: "unknown_result",
    });
    expect(await runCompute(ctx("tenant-a", "run-2"), { expression: "x * 2", inputs: { x: g.result_id } })).toMatchObject({
      status: "unknown_result",
    });
  });

  it("chains: a compute result is itself an input", async () => {
    const a = (await runCompute(ctx(), { expression: "a / b", inputs: { a: 900, b: 30 } })) as { result_id: string; value: number };
    expect(a.value).toBe(30);
    const b = await runCompute(ctx(), { expression: "cac * 2", inputs: { cac: a.result_id } });
    expect(b).toMatchObject({ status: "ok", value: 60 });
  });
});

describe("compute cannot launder a number", () => {
  const RUN = "run-launder";
  beforeEach(() => clearFigures(RUN));

  it("an invented literal: unverified, and the result never enters the ledger", async () => {
    recordInputFigures(RUN, "Goal: reach 400 paying customers.");
    const a = (await runCompute(ctx("tenant-a", RUN), { expression: "a / b", inputs: { a: 7314, b: 53 } })) as { result_id: string };
    expect(a).toMatchObject({ status: "ok", value: 138, verified: false });
    expect(figureWasRead(RUN, "138")).toBe(false);
    expect(figureWasRead(RUN, "7314")).toBe(false);
    const b = await runCompute(ctx("tenant-a", RUN), { expression: "x * 2", inputs: { x: a.result_id } });
    expect(b).toMatchObject({ status: "ok", value: 276, verified: false });
  });

  it("a second compute over an unledgered one stays out of the ledger", async () => {
    recordInputFigures(RUN, "Goal: reach 400 paying customers.");
    const a = (await runCompute(ctx("tenant-a", RUN), { expression: "x", inputs: { x: 7314 } })) as { result_id: string };
    const b = await runCompute(ctx("tenant-a", RUN), { expression: "y", inputs: { y: a.result_id } });
    expect(b).toMatchObject({ status: "ok", value: 7314, verified: false });
    expect(pullsForFigure(RUN, "7314")).toEqual([]);
    expect(figureWasRead(RUN, "7314")).toBe(false);
  });

  it("a number written into the expression is a literal too", async () => {
    recordInputFigures(RUN, "Goal: reach 400 paying customers.");
    const a = await runCompute(ctx("tenant-a", RUN), { expression: "7314", inputs: {} });
    expect(a).toMatchObject({ status: "ok", value: 7314, verified: false });
    expect(figureWasRead(RUN, "7314")).toBe(false);
    recordInputFigures(RUN, "in 20 weeks");
    const b = await runCompute(ctx("tenant-a", RUN), { expression: "400 / 20", inputs: {} });
    expect(b).toMatchObject({ value: 20, verified: false });
    expect(pullsForFigure(RUN, "20")).toHaveLength(1);
  });

  it("a literal the run read: still unverified, but the result is sourced", async () => {
    recordInputFigures(RUN, "We spent $2,750 on Meta last month and got 25 bookings.");
    const c = await runCompute(ctx("tenant-a", RUN), { expression: "spend / bookings", inputs: { spend: 2750, bookings: 25 } });
    expect(c).toMatchObject({ status: "ok", value: 110, verified: false });
    expect(figureWasRead(RUN, "110")).toBe(true);
  });

  it("an expired typed goal number in the prompt does not count as read", async () => {
    recordInputFigures(RUN, "Goal: 612 hosts, entered 20 days ago. Target 900.");
    withholdFigures(RUN, ["612"]);
    const c = await runCompute(ctx("tenant-a", RUN), { expression: "target - now", inputs: { target: 900, now: 612 } });
    expect(c).toMatchObject({ status: "ok", value: 288, verified: false });
    expect(pullsForFigure(RUN, "288")).toEqual([]);
    expect(figureWasRead(RUN, "288")).toBe(false);
  });

  it("rejects injection and division by zero with a status, never throws to the model", async () => {
    expect(await runCompute(ctx(), { expression: "process.exit()", inputs: {} })).toMatchObject({ status: "parse_error" });
    expect(await runCompute(ctx(), { expression: "a / b", inputs: { a: 1, b: 0 } })).toMatchObject({ status: "division_by_zero" });
  });

  it("input names and refs are validated by the schema", async () => {
    await expect(runCompute(ctx(), { expression: "x", inputs: { "x.y": 1 } })).rejects.toThrow();
    await expect(runCompute(ctx(), { expression: "x", inputs: { x: "not-a-result" } })).rejects.toThrow();
    await expect(runCompute(ctx(), { expression: "ratio(a, b)", inputs: { a: 10, b: 2, ratio: 7 } })).rejects.toThrow();
  });
});

describe("compute registers its value as money to the cent, for the decision gate only", () => {
  const RUN = "run-money-cents";
  beforeEach(() => clearFigures(RUN));

  it("dividing a read spend by a read count of 6 is sourced, and is read as $37.09 by the gate only (review ae1b0e37)", async () => {
    recordFiguresFromPull(RUN, JSON.stringify([{ type: "text", text: JSON.stringify({ spend: "222.55", purchases: 6 }) }]), "meta_ads__list_ad_sets");
    const r = await runCompute(ctx("tenant-a", RUN), { expression: "ratio(spend, purchases)", inputs: { spend: 222.55, purchases: 6 } });
    expect(r).toMatchObject({ status: "ok", value: 37.0917 });
    expect(moneyRoundingWasRead(RUN, "37.09", false)).toBe(true);
    expect(figureWasRead(RUN, "$37.09")).toBe(false);
  });
  it("an unsourced compute and a percent change register nothing", async () => {
    recordInputFigures(RUN, "Goal: reach 400 paying customers.");
    await runCompute(ctx("tenant-a", RUN), { expression: "a / b", inputs: { a: 7314, b: 53.3 } });
    expect(moneyRoundingWasRead(RUN, "137.22", false)).toBe(false);
    recordInputFigures(RUN, "now 112.4612 before 100");
    await runCompute(ctx("tenant-a", RUN), { expression: "pct_change(now, before)", inputs: { now: 112.4612, before: 100 } });
    expect(moneyRoundingWasRead(RUN, "12.46", false)).toBe(false);
  });
});

describe("a one-digit literal in compute", () => {
  const RUN = "run-small-int";
  beforeEach(() => clearFigures(RUN));
  it("is unread when only the prompt (dates, counts) carries it, or only inside a longer number", async () => {
    recordInputFigures(RUN, "spend 222.55; Oct 6 to 10");
    recordFiguresFromPull(RUN, '{"spend":222.55,"day":"2026-10-06","rate":1.6}', "meta_ads__list_ad_sets");
    const r = await runCompute(ctx("tenant-a", RUN), { expression: "ratio(spend, purchases)", inputs: { spend: 222.55, purchases: 6 } });
    expect(r).toMatchObject({ status: "ok", value: 37.0917 });
    expect(moneyRoundingWasRead(RUN, "37.09", false)).toBe(false);
  });
  it("is unread when the digit is only in text (an id, a rate, a range, a date, a grouped number, a URL) or the result is not JSON", async () => {
    recordFiguresFromPull(RUN, '{"spend":222.55,"version":"v6","tiny":6e-7,"delta":"−6","count":"6,000","ctr":"6%","dates":"Oct 6-10","rank":"#6","url":"https://x/items/6?q=1","purchases":"6"}', "meta_ads__list_ad_sets");
    recordFiguresFromPull(RUN, "purchases: 6 (plain text)", "meta_ads__list_ad_sets");
    recordFiguresFromPull(RUN, JSON.stringify({ note: JSON.stringify({ rank: 6 }) }), "meta_ads__list_ad_sets");
    recordFiguresFromPull(RUN, JSON.stringify([{ type: "text", text: JSON.stringify({ note: JSON.stringify({ rank: 6 }) }) }]), "meta_ads__list_ad_sets");
    await runCompute(ctx("tenant-a", RUN), { expression: "ratio(spend, purchases)", inputs: { spend: 222.55, purchases: 6 } });
    expect(moneyRoundingWasRead(RUN, "37.09", false)).toBe(false);
  });
});

describe("get_metric: finished-outcome metrics", () => {
  it("a per-channel breakdown is unsupported_definition before anything is read", async () => {
    const { catalogEntry } = await import("@/services/analytics/metric-catalog");
    const fetch = vi.spyOn(catalogEntry("first_completed_cac")!.impl, "fetch");
    const out = await runGetMetric(ctx(), { metric_id: "first_completed_cac", window: { preset: "last_7d" }, breakdown: "platform" }, deps);
    expect(out.status).toBe("unsupported_definition");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("a withheld value comes back as null with bounds, why, coverage; compare is not run", async () => {
    const { catalogEntry } = await import("@/services/analytics/metric-catalog");
    const impl = catalogEntry("first_completed_cac")!.impl;
    const fetch = vi.spyOn(impl, "fetch").mockResolvedValue({
      ok: true,
      daily: [
        { date: "2026-09-22", parts: { spend: 600 } },
        { date: "2026-09-23", parts: { customers: 3 } },
      ],
      currency: "USD",
      row_count: 2,
      truncated: false,
      caveats: [],
      params: {},
      estimate: { exact: false, assumptions: ["1 finished order has no finish date."], inputs: { unplaced: 1 }, coverage: { unplaced_finished_orders: 1 } },
    });
    const out = (await runGetMetric(ctx(), { metric_id: "first_completed_cac", window: { preset: "last_7d" }, compare: "previous_period" }, deps)) as {
      total: number | null;
      bounds: { low: number | null; high: number | null };
      estimate: { exact: boolean; why_not_exact: string[] };
      receipt: { caveats: string[] };
    };
    expect(out.total).toBeNull();
    expect(out.bounds).toEqual({ low: 150, high: 300 });
    expect(out.estimate.exact).toBe(false);
    expect(out.estimate.why_not_exact).toEqual(["1 finished order has no finish date."]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out.receipt.caveats.join(" ")).toMatch(/compare is not run/);
    fetch.mockRestore();
  });
});
