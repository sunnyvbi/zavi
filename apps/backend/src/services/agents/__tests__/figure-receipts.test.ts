
import { describe, it, expect, beforeEach } from "vitest";
import { clearFigures, recordFiguresFromPull } from "@/services/agents/engine/figure-ledger";
import { buildAnswerSources } from "@/services/agents/answer-sources";
import { buildFigureReceipts } from "@/services/agents/figure-receipts";
import { _clearResults, putResult } from "@/services/analytics/metric-results";
import { _clearExploratory, putExploratory } from "@/services/analytics/exploratory-results";

const RUN = "22222222-2222-4222-8222-222222222222";
const TENANT = "tenant-a";

beforeEach(() => {
  clearFigures(RUN);
  _clearResults();
  _clearExploratory();
});

function metricResult() {
  const receipt = {
    source: "stripe",
    metric_id: "net_revenue",
    definition: "Charges minus refunds and fees, from Stripe balance transactions.",
    window: { since: "2026-09-01", until: "2026-09-27" },
    tz: "America/Los_Angeles",
    currency: "USD",
    fetched_at: "2026-09-28T16:12:00.000Z",
    params: { grain: "day", window: { preset: "month_to_date" } },
    caveats: ["Today is excluded."],
  };
  putResult(TENANT, RUN, { result_id: "m_0123456789", kind: "metric", value: 41380, compare_value: 38950, receipt, label: "Net revenue", unit: "currency", delta_pct: 6.24 });
  recordFiguresFromPull(RUN, JSON.stringify({ result_id: "m_0123456789", total: 41380, compare_total: 38950, delta_pct: 6.24, receipt }), "growth__get_metric");
}

describe("buildFigureReceipts", () => {
  it("puts the catalog receipt on a figure get_metric returned", () => {
    metricResult();
    const answer = "**Green** Up 6.24% vs August. Net revenue is $41,380 for Sep 1-27, up from $38,950.";
    const sources = buildAnswerSources(RUN, answer);
    const receipts = buildFigureReceipts(TENANT, RUN, sources.checked);
    const r = receipts.find((x) => x.figure === "$41,380");
    expect(r).toMatchObject({
      kind: "catalog",
      source_slug: "stripe",
      metric_id: "net_revenue",
      window: { since: "2026-09-01", until: "2026-09-27" },
      tz: "America/Los_Angeles",
      currency: "USD",
      fetched_at: "2026-09-28T16:12:00.000Z",
    });
    expect(r?.params).toContainEqual(["grain", "day"]);
    expect(receipts.find((x) => x.figure === "$38,950")?.kind).toBe("catalog");
  });

  it("never gives a receipt to a figure no read returned", () => {
    metricResult();
    const answer = "Net revenue is $41,380. Returning customers drove $17,900 of it.";
    const sources = buildAnswerSources(RUN, answer);
    expect(sources.meta.unverified).toContain("$17,900");
    const receipts = buildFigureReceipts(TENANT, RUN, sources.checked);
    expect(receipts.map((r) => r.figure)).not.toContain("$17,900");
  });

  it("does not resolve another tenant's result", () => {
    metricResult();
    const sources = buildAnswerSources(RUN, "Net revenue is $41,380.");
    const receipts = buildFigureReceipts("tenant-b", RUN, sources.checked);
    expect(receipts[0]).toMatchObject({ figure: "$41,380", kind: "pulled" });
    expect(receipts[0].metric_id).toBeUndefined();
  });

  it("carries the SQL for a figure an exploratory read returned", () => {
    putExploratory(TENANT, RUN, {
      sql_reads: ["select count(*) from bookings where created_at >= now() - interval '7 days'"],
      purpose: "bookings in the last 7 days",
      session_tz: "America/Los_Angeles",
      result: { bookings_7d: 1587 },
    });
    recordFiguresFromPull(RUN, JSON.stringify({ exploratory: true, compute: { result: { bookings_7d: 1587 } } }), "operator_db__codeact");
    const sources = buildAnswerSources(RUN, "You had 1,587 bookings last week.");
    const [r] = buildFigureReceipts(TENANT, RUN, sources.checked);
    expect(r).toMatchObject({ figure: "1,587", kind: "exploratory", tz: "America/Los_Angeles", purpose: "bookings in the last 7 days" });
    expect(r.sql?.[0]).toMatch(/from bookings/);
  });

  it("a plain pull still gets a chip naming its source", () => {
    recordFiguresFromPull(RUN, '{"hosts": 3512}', "operator_db__query");
    const sources = buildAnswerSources(RUN, "You have 3,512 hosts.");
    const [r] = buildFigureReceipts(TENANT, RUN, sources.checked);
    expect(r).toMatchObject({ figure: "3,512", kind: "pulled" });
    expect(r.source.length).toBeGreaterThan(0);
  });

  it("a compute the tool marked unverified (typed-in input, even through a chain) gets no receipt chip", () => {
    metricResult();
    putResult(TENANT, RUN, { result_id: "c_aaaaaaaaaa", kind: "compute", verified: false, value: 37.93, receipt: { source: "compute", formula: "pct_change(30000, 41380) = 37.93", inputs: { prior: { value: 30000 }, current: { value: 41380, result_id: "m_0123456789" } } } });
    putResult(TENANT, RUN, { result_id: "c_bbbbbbbbbb", kind: "compute", verified: false, value: 75.86, receipt: { source: "compute", formula: "x * 2 = 75.86", inputs: { x: { value: 37.93, result_id: "c_aaaaaaaaaa" } } } });
    putResult(TENANT, RUN, { result_id: "c_cccccccccc", kind: "compute", verified: true, value: 6.24, receipt: { source: "compute", formula: "pct_change(38950, 41380) = 6.24", inputs: { prior: { value: 38950, result_id: "m_0123456789", which: "compare" }, current: { value: 41380, result_id: "m_0123456789" } } } });
    recordFiguresFromPull(RUN, JSON.stringify({ value: 37.93 }), "growth__compute");
    recordFiguresFromPull(RUN, JSON.stringify({ value: 75.86 }), "growth__compute");
    const sources = buildAnswerSources(RUN, "That is 37.93% above plan, 75.86% on the doubled view, and 6.24% vs August.");
    const receipts = buildFigureReceipts(TENANT, RUN, sources.checked);
    expect(receipts.find((r) => r.figure === "37.93%")).toMatchObject({ kind: "compute", verified: false });
    expect(receipts.find((r) => r.figure === "75.86%")).toMatchObject({ kind: "compute", verified: false });
    const ok = receipts.find((r) => r.figure === "6.24%");
    expect(ok?.verified).toBeUndefined();
  });

  it("a single-digit money or percent figure gets a receipt when a stored result produced it", () => {
    const receipt = { source: "meta_ads", metric_id: "meta_ad_spend", window: { since: "2026-09-27", until: "2026-09-27" }, currency: "USD" };
    putResult(TENANT, RUN, { result_id: "m_1111111111", kind: "metric", value: 0, receipt, label: "Meta Ads spend", unit: "currency", delta_pct: 4.2 });
    recordFiguresFromPull(RUN, JSON.stringify({ total: 0, delta_pct: 4.2 }), "growth__get_metric");
    const answer = "Prospecting spent $0 on Sunday, 4% more than usual. Also $7 you typed and 9% from nowhere.";
    const receipts = buildFigureReceipts(TENANT, RUN, buildAnswerSources(RUN, answer).checked, answer);
    expect(receipts.find((r) => r.figure === "$0")).toMatchObject({ kind: "catalog", source_slug: "meta_ads", metric_id: "meta_ad_spend" });
    expect(receipts.find((r) => r.figure === "4%")).toMatchObject({ kind: "catalog" });
    expect(receipts.find((r) => r.figure === "$7")).toBeUndefined();
    expect(receipts.find((r) => r.figure === "9%")).toBeUndefined();
  });

  it("a bare 1-2 digit count gets a chip only on an exact, unambiguous stored match", () => {
    putResult(TENANT, RUN, {
      result_id: "m_3333333333",
      kind: "metric",
      value: 91,
      compare_value: 99,
      receipt: { source: "stripe", metric_id: "new_customers" },
      label: "New customers",
      unit: "count",
      series: [{ start: "2026-09-27", end: "2026-09-27", value: 27, partial: false }],
    });
    putResult(TENANT, RUN, { result_id: "m_4444444444", kind: "metric", value: 42, receipt: { source: "stripe" }, unit: "count" });
    putResult(TENANT, RUN, { result_id: "m_5555555555", kind: "metric", value: 8, compare_value: 42, receipt: { source: "ga4" }, unit: "count" });
    const answer = [
      "New customers fell to 91 last week, down from 99. On Sep 27 there were few.",
      "Orders were 42 and returns 14.",
      "",
      "1. **Raise the limit.** Moves: new customers (91).",
    ].join("\n");
    const receipts = buildFigureReceipts(TENANT, RUN, buildAnswerSources(RUN, answer).checked, answer);
    const figs = receipts.map((r) => r.figure);
    expect(receipts.find((r) => r.figure === "91")).toMatchObject({ kind: "catalog", metric_id: "new_customers" });
    expect(figs).toContain("99");
    expect(figs).not.toContain("27");
    expect(figs).not.toContain("42");
    expect(figs).not.toContain("14");
    expect(figs).not.toContain("1");
  });

  it("a bare count skips ranges, dotted times, other currencies, ids and non-count metrics", () => {
    putResult(TENANT, RUN, {
      result_id: "m_6666666666",
      kind: "metric",
      value: 91,
      receipt: { source: "stripe" },
      unit: "count",
      series: [
        { start: "2026-09-26", end: "2026-09-26", value: 8, partial: false },
        { start: "2026-09-27", end: "2026-09-27", value: 14, partial: false },
        { start: "2026-09-28", end: "2026-09-28", value: 9, partial: false },
      ],
    });
    putResult(TENANT, RUN, { result_id: "m_7777777777", kind: "metric", value: 55, receipt: { source: "stripe" }, unit: "currency" });
    const answer = "Delivery takes 8–14 days. Send at 9 a.m. The budget is £91. Campaign ID 91 failed. We gained 55 customers.";
    const figs = buildFigureReceipts(TENANT, RUN, buildAnswerSources(RUN, answer).checked, answer).map((r) => r.figure);
    expect(figs).toEqual([]);
  });

  it("a bare digit no stored result holds gets nothing; one that matches exactly gets its receipt", () => {
    putResult(TENANT, RUN, { result_id: "m_2222222222", kind: "metric", value: 3, receipt: { source: "stripe" }, label: "Refunds", unit: "count" });
    const miss = "You had 5 refunds across 2 options.";
    expect(buildFigureReceipts(TENANT, RUN, buildAnswerSources(RUN, miss).checked, miss)).toEqual([]);
    const hit = "You had 3 refunds.";
    expect(buildFigureReceipts(TENANT, RUN, buildAnswerSources(RUN, hit).checked, hit)[0]).toMatchObject({ figure: "3", label: "Refunds" });
  });
});
