
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  stripe: {
    balanceTransactions: { list: vi.fn() },
    customers: { list: vi.fn() },
  },
  stripeClient: vi.fn(),
  readTenantStripeMrr: vi.fn(),
  metaAdsCreds: vi.fn(),
  fbGet: vi.fn(),
  fbGetAllPages: vi.fn(),
  gadsSearch: vi.fn(),
  runReport: vi.fn(),
  searchAnalyticsQuery: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/tools/stripe/_client", () => ({ stripeClient: m.stripeClient }));
vi.mock("@/services/analytics/stripe-mrr", () => ({ readTenantStripeMrr: m.readTenantStripeMrr }));
vi.mock("@/services/tools/meta-ads/_client", () => ({
  metaAdsCreds: m.metaAdsCreds,
  fbGet: m.fbGet,
  fbGetAllPages: m.fbGetAllPages,
  metaDateRange: vi.fn(),
  metaActionValue: (actions: Array<{ action_type?: string; value?: string }> | undefined, type: string) =>
    Number(actions?.find((a) => a.action_type === type)?.value ?? 0),
}));
vi.mock("@/services/tools/google-ads/_client", () => ({ gadsSearch: m.gadsSearch }));
vi.mock("@/services/tools/google-analytics/_client", () => ({ runReport: m.runReport }));
vi.mock("@/services/tools/google-search-console/_client", () => ({ searchAnalyticsQuery: m.searchAnalyticsQuery }));

import { ExpectedToolError } from "@/services/tools/types";
import { METRIC_CATALOG, CATALOG_METRIC_IDS } from "../metric-registry";
import { METRIC_IMPLS, aggregate, catalogEntry } from "../metric-catalog";
import { fetchAdSpendTotal } from "../metric-catalog/ads";
import { fetchRatioOf } from "../metric-catalog/derived";
import { fetchOperatorCount } from "../metric-catalog/operator-db";
import type { FetchOk, FetchResult, MetricFetchCtx } from "../metric-catalog/types";
import type { ResolvedWindow } from "../metric-time";

const W: ResolvedWindow = { since: "2026-09-01", until: "2026-09-07", tz: "UTC", notes: [] };
const CTX: MetricFetchCtx = {
  tenant_id: "tenant-a",
  tz: "UTC",
  now: new Date("2026-09-10T12:00:00Z"),
  grain: "day",
  gateway: { tenant_id: "tenant-a", caller: { kind: "background", feature: "test" } },
};

async function run(id: string, ctx: MetricFetchCtx = CTX, w: ResolvedWindow = W) {
  const e = catalogEntry(id)!;
  const r = await e.impl.fetch(ctx, w);
  return { r, agg: r.ok ? aggregate(e.meta, e.impl, r, w, ctx.grain) : null };
}

const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);

beforeEach(() => {
  vi.clearAllMocks();
  m.stripeClient.mockResolvedValue(m.stripe);
  m.metaAdsCreds.mockResolvedValue({ access_token: "x", ad_account_id: "act_1" });
});

describe("catalog shape", () => {
  it("has ~25+ metrics, and every definition has an implementation and vice versa", () => {
    expect(CATALOG_METRIC_IDS.length).toBeGreaterThanOrEqual(25);
    expect(Object.keys(METRIC_IMPLS).sort()).toEqual([...CATALOG_METRIC_IDS].sort());
  });

  it("every entry is fully typed: unit, source, needs, grains, definition", () => {
    for (const meta of Object.values(METRIC_CATALOG)) {
      expect(["currency", "count", "ratio", "seconds", "position"]).toContain(meta.unit);
      expect(meta.definition.length).toBeGreaterThan(10);
      expect(meta.grains.length).toBeGreaterThan(0);
      expect(meta.needs.length + (meta.needs_any?.length ?? 0)).toBeGreaterThan(0);
    }
  });

  it("platform conversions are labelled platform-reported", () => {
    for (const id of ["meta_conversions", "google_conversions", "meta_cpa", "meta_roas", "google_roas"]) {
      expect(METRIC_CATALOG[id].label).toMatch(/platform-reported/);
    }
  });
});

describe("Stripe", () => {
  const txns = [
    { id: "t1", created: ts("2026-09-01T10:00:00Z"), reporting_category: "charge", currency: "usd", amount: 10000, net: 9680 },
    { id: "t2", created: ts("2026-09-02T10:00:00Z"), reporting_category: "charge", currency: "usd", amount: 5000, net: 4825 },
    { id: "t3", created: ts("2026-09-02T11:00:00Z"), reporting_category: "refund", currency: "usd", amount: -2000, net: -2000 },
    { id: "t4", created: ts("2026-09-03T11:00:00Z"), reporting_category: "payout", currency: "usd", amount: -50000, net: -50000 },
    { id: "t5", created: ts("2026-09-03T12:00:00Z"), reporting_category: "fee", currency: "usd", amount: -1500, net: -1500 },
  ];

  it("net / gross / refunds come from one ledger read; payouts and billing fees are not revenue", async () => {
    m.stripe.balanceTransactions.list.mockResolvedValue({ data: txns, has_more: false });
    expect((await run("gross_revenue")).agg!.total).toBe(150);
    expect((await run("refunds")).agg!.total).toBe(20);
    const net = await run("net_revenue");
    expect(net.agg!.total).toBe(125.05);
    expect((net.r as FetchOk).currency).toBe("USD");
    expect(m.stripe.balanceTransactions.list.mock.calls[0][0].created).toEqual({
      gte: ts("2026-09-01T00:00:00Z"),
      lt: ts("2026-09-08T00:00:00Z"),
    });
  });

  it("buckets by the tenant's local day, not UTC", async () => {
    m.stripe.balanceTransactions.list.mockResolvedValue({
      data: [{ id: "t", created: ts("2026-09-02T03:00:00Z"), reporting_category: "charge", currency: "usd", amount: 1000, net: 1000 }],
      has_more: false,
    });
    const la = { ...CTX, tz: "America/Los_Angeles" };
    const { agg } = await run("gross_revenue", la, { ...W, tz: "America/Los_Angeles" });
    expect(agg!.series.find((p) => p.value)?.start).toBe("2026-09-01");
  });

  it("refuses a mixed-currency balance instead of adding dollars to euros", async () => {
    m.stripe.balanceTransactions.list.mockResolvedValue({
      data: [txns[0], { ...txns[1], currency: "eur" }],
      has_more: false,
    });
    const { r } = await run("net_revenue");
    expect(r).toMatchObject({ ok: false, reason: "currency_mismatch" });
  });

  it("refuses rather than undercount past the page cap", async () => {
    m.stripe.balanceTransactions.list.mockResolvedValue({ data: [txns[0]], has_more: true });
    const { r } = await run("net_revenue");
    expect(r).toMatchObject({ ok: false, reason: "too_many_rows" });
  });

  it("not connected is not_connected; an expired key is read_failed", async () => {
    m.stripeClient.mockRejectedValueOnce(new ExpectedToolError("stripe_not_connected"));
    expect((await run("net_revenue")).r).toMatchObject({ ok: false, reason: "not_connected" });
    m.stripeClient.mockResolvedValueOnce(m.stripe);
    m.stripe.balanceTransactions.list.mockRejectedValueOnce(new ExpectedToolError("stripe_auth_failed"));
    expect((await run("net_revenue")).r).toMatchObject({ ok: false, reason: "read_failed" });
  });

  it("new_customers counts customers created per local day", async () => {
    m.stripe.customers.list.mockResolvedValue({
      data: [
        { id: "c1", created: ts("2026-09-01T01:00:00Z") },
        { id: "c2", created: ts("2026-09-01T02:00:00Z") },
        { id: "c3", created: ts("2026-09-05T02:00:00Z") },
      ],
      has_more: false,
    });
    const { agg } = await run("new_customers");
    expect(agg!.total).toBe(3);
    expect(agg!.series[0]).toMatchObject({ start: "2026-09-01", value: 2 });
  });

  it("mrr reads stripe-mrr as a point in time", async () => {
    m.readTenantStripeMrr.mockResolvedValue({ available: true, mrr_usd: 4321.5, meta: { sub_count: 12, currency: "usd" } });
    const { r, agg } = await run("mrr");
    expect(agg!.total).toBe(4321.5);
    expect((r as FetchOk).currency).toBe("USD");
    m.readTenantStripeMrr.mockResolvedValue({ available: false, reason: "multi_currency" });
    expect((await run("mrr")).r).toMatchObject({ ok: false, reason: "currency_mismatch" });
  });
});

describe("Meta + Google Ads", () => {
  function metaDay(date: string, spend: number, clicks: number, purchases: number, value: number) {
    return {
      date_start: date,
      spend: String(spend),
      clicks: String(clicks),
      impressions: "1000",
      actions: [{ action_type: "purchase", value: String(purchases) }],
      action_values: [{ action_type: "purchase", value: String(value) }],
    };
  }

  beforeEach(() => {
    m.fbGet.mockResolvedValue({ currency: "USD", timezone_name: "UTC" });
    m.fbGetAllPages.mockImplementation(async (_t: string, _p: string, params: { level: string }) =>
      params.level === "account"
        ? [metaDay("2026-09-01", 100, 50, 2, 300), metaDay("2026-09-02", 50, 50, 3, 200)]
        : [
            { ...metaDay("2026-09-01", 100, 50, 2, 300), campaign_id: "c1", campaign_name: "Brand" },
            { ...metaDay("2026-09-02", 50, 50, 3, 200), campaign_id: "c2", campaign_name: "Prospecting" },
          ],
    );
  });

  it("reads the ACCOUNT level (paused campaigns' spend counts) over the explicit window", async () => {
    const { agg } = await run("meta_ad_spend");
    expect(agg!.total).toBe(150);
    const params = m.fbGetAllPages.mock.calls[0][2];
    expect(params.level).toBe("account");
    expect(JSON.parse(params.time_range)).toEqual({ since: "2026-09-01", until: "2026-09-07" });
  });

  it("ratios are ratios of sums, not averages of daily ratios", async () => {
    expect((await run("meta_cpc")).agg!.total).toBe(1.5);
    expect((await run("meta_cpa")).agg!.total).toBe(30);
    expect((await run("meta_roas")).agg!.total).toBeCloseTo(3.3333, 4);
    const weekly = await run("meta_cpc", { ...CTX, grain: "week" });
    expect(weekly.agg!.series.map((p) => p.value)).toEqual([1.5, null]);
  });

  it("a day with zero clicks gives a null CPC, not 0 or Infinity", async () => {
    const { agg } = await run("meta_cpc");
    expect(agg!.series.find((p) => p.start === "2026-09-05")!.value).toBeNull();
  });

  it("campaign breakdown only when asked", async () => {
    const { r } = await run("meta_ad_spend", { ...CTX, breakdown: "campaign" });
    expect((r as FetchOk).breakdown!.map((b) => b.key)).toEqual(["Brand", "Prospecting"]);
    await run("meta_ad_spend");
    expect(m.fbGetAllPages.mock.calls.filter((c) => c[2].level === "campaign")).toHaveLength(1);
  });

  it("flags an ad account in another time zone", async () => {
    m.fbGet.mockResolvedValue({ currency: "USD", timezone_name: "America/Los_Angeles" });
    const { r } = await run("meta_ad_spend");
    expect((r as FetchOk).caveats.join(" ")).toMatch(/America\/Los_Angeles/);
  });

  it("an expired Meta token is read_failed, not not_connected", async () => {
    m.fbGetAllPages.mockRejectedValue(new ExpectedToolError("meta_ads_token_expired"));
    expect((await run("meta_ad_spend")).r).toMatchObject({ ok: false, reason: "read_failed" });
  });

  it("Google reads the customer level with the same BETWEEN window", async () => {
    m.gadsSearch.mockImplementation(async (_t: string, q: string) =>
      q.includes("customer.currency_code")
        ? [{ customer: { currencyCode: "USD", timeZone: "UTC" } }]
        : [
            { segments: { date: "2026-09-01" }, metrics: { costMicros: "20000000", clicks: "10", conversions: "2", conversionsValue: "90" } },
            { segments: { date: "2026-09-03" }, metrics: { costMicros: "10000000", clicks: "5", conversions: "1", conversionsValue: "0" } },
          ],
    );
    expect((await run("google_ad_spend")).agg!.total).toBe(30);
    expect((await run("google_cpa")).agg!.total).toBe(10);
    const q = m.gadsSearch.mock.calls.map((c) => c[1]).find((s: string) => s.includes("segments.date"));
    expect(q).toContain("FROM customer");
    expect(q).toContain("BETWEEN '2026-09-01' AND '2026-09-07'");
  });
});

describe("ad_spend_total", () => {
  const ok = (currency: string, spend: number): FetchResult => ({
    ok: true,
    daily: [{ date: "2026-09-01", parts: { spend } }],
    currency,
    row_count: 1,
    truncated: false,
    caveats: [],
    params: {},
  });
  const notConnected: FetchResult = { ok: false, reason: "not_connected", message: "x" };

  it("sums both platforms in one currency, with a platform breakdown", async () => {
    const r = await fetchAdSpendTotal({ ...CTX, breakdown: "platform" }, W, {
      meta: async () => ok("USD", 100),
      google: async () => ok("USD", 40),
    });
    expect(r.ok && r.daily![0].parts.spend).toBe(140);
    expect(r.ok && r.breakdown).toEqual([
      { key: "Meta", parts: { spend: 100 } },
      { key: "Google Ads", parts: { spend: 40 } },
    ]);
  });

  it("refuses two currencies", async () => {
    const r = await fetchAdSpendTotal(CTX, W, { meta: async () => ok("USD", 100), google: async () => ok("EUR", 40) });
    expect(r).toMatchObject({ ok: false, reason: "currency_mismatch" });
  });

  it("a platform that is not connected is left out and named", async () => {
    const r = await fetchAdSpendTotal(CTX, W, { meta: async () => ok("USD", 100), google: async () => notConnected });
    expect(r.ok && r.daily![0].parts.spend).toBe(100);
    expect(r.ok && r.caveats.join(" ")).toMatch(/Google Ads is not connected/);
  });

  it("a CONNECTED platform whose read failed blocks the total", async () => {
    const r = await fetchAdSpendTotal(CTX, W, {
      meta: async () => ok("USD", 100),
      google: async () => ({ ok: false, reason: "read_failed", message: "Google Ads read failed (rate limit)." }),
    });
    expect(r).toMatchObject({ ok: false, reason: "read_failed" });
  });

  it("neither connected -> not_connected", async () => {
    const r = await fetchAdSpendTotal(CTX, W, { meta: async () => notConnected, google: async () => notConnected });
    expect(r).toMatchObject({ ok: false, reason: "not_connected" });
  });
});

describe("derived", () => {
  const side = (label: string, part: string, r: FetchResult) => ({ label, part, fetch: async () => r });
  const series = (currency: string | null, part: string, rows: Array<[string, number]>): FetchResult => ({
    ok: true,
    daily: rows.map(([date, v]) => ({ date, parts: { [part]: v } })),
    currency,
    row_count: rows.length,
    truncated: false,
    caveats: [],
    params: {},
  });

  it("cac = spend / new customers over the same days", async () => {
    const r = await fetchRatioOf(
      CTX,
      W,
      side("Total ad spend", "spend", series("USD", "spend", [["2026-09-01", 300], ["2026-09-02", 300]])),
      side("New customers", "customers", series(null, "customers", [["2026-09-01", 10], ["2026-09-02", 5]])),
      { sameCurrency: false },
    );
    const e = catalogEntry("cac")!;
    expect(aggregate(e.meta, e.impl, r as FetchOk, W, "day").total).toBe(40);
    expect((r as FetchOk).currency).toBe("USD");
  });

  it("blended_roas refuses when revenue and spend are in different currencies", async () => {
    const r = await fetchRatioOf(
      CTX,
      W,
      side("Net revenue", "net", series("EUR", "net", [["2026-09-01", 1000]])),
      side("Total ad spend", "spend", series("USD", "spend", [["2026-09-01", 100]])),
      { sameCurrency: true },
    );
    expect(r).toMatchObject({ ok: false, reason: "currency_mismatch" });
  });

  it("either side failing is a refusal that names the side", async () => {
    const r = await fetchRatioOf(
      CTX,
      W,
      side("Total ad spend", "spend", { ok: false, reason: "not_connected", message: "No ad account is connected." }),
      side("New customers", "customers", series(null, "customers", [])),
      { sameCurrency: false },
    );
    expect(r).toMatchObject({ ok: false, reason: "not_connected" });
    expect((r as { message: string }).message).toMatch(/^Total ad spend:/);
  });
});

describe("GA4", () => {
  it("sessions / key events / conversion rate from one daily report", async () => {
    m.runReport.mockResolvedValue({
      rows: [
        { dimensionValues: [{ value: "20260901" }], metricValues: [{ value: "100" }, { value: "5" }] },
        { dimensionValues: [{ value: "20260902" }], metricValues: [{ value: "300" }, { value: "7" }] },
      ],
      rowCount: 2,
    });
    expect((await run("sessions")).agg!.total).toBe(400);
    expect((await run("key_events")).agg!.total).toBe(12);
    expect((await run("conversion_rate")).agg!.total).toBe(0.03);
    expect(m.runReport.mock.calls[0][1].metrics).toEqual([{ name: "sessions" }, { name: "keyEvents" }]);
  });

  it("refuses when GA4 says there are more rows than it returned", async () => {
    m.runReport.mockResolvedValue({ rows: [{ dimensionValues: [{ value: "20260901" }], metricValues: [{ value: "1" }, { value: "0" }] }], rowCount: 5 });
    expect((await run("sessions")).r).toMatchObject({ ok: false, reason: "too_many_rows" });
  });

  it("users are NOT summed across days: the total is its own request", async () => {
    m.runReport.mockImplementation(async (_t: string, body: { dimensions: unknown[] }) =>
      body.dimensions.length === 0
        ? { rows: [{ dimensionValues: [], metricValues: [{ value: "150" }] }], rowCount: 1 }
        : {
            rows: [
              { dimensionValues: [{ value: "202636" }], metricValues: [{ value: "120" }] },
              { dimensionValues: [{ value: "202637" }], metricValues: [{ value: "90" }] },
            ],
            rowCount: 2,
          },
    );
    const w: ResolvedWindow = { since: "2026-08-31", until: "2026-09-13", tz: "UTC", notes: [] };
    const { agg } = await run("users", { ...CTX, grain: "week" }, w);
    expect(agg!.total).toBe(150);
    expect(agg!.series.map((p) => [p.start, p.value])).toEqual([
      ["2026-08-31", 120],
      ["2026-09-07", 90],
    ]);
    expect(m.runReport.mock.calls.map((c) => c[1].dimensions)).toContainEqual([{ name: "isoYearIsoWeek" }]);
  });
});

describe("Search Console", () => {
  it("ctr and impression-weighted position", async () => {
    m.searchAnalyticsQuery.mockResolvedValue({
      rows: [
        { keys: ["2026-09-01"], clicks: 10, impressions: 100, position: 2 },
        { keys: ["2026-09-02"], clicks: 30, impressions: 300, position: 6 },
      ],
    });
    expect((await run("search_clicks")).agg!.total).toBe(40);
    expect((await run("search_ctr")).agg!.total).toBe(0.1);
    expect((await run("search_avg_position")).agg!.total).toBe(5);
  });
});

describe("operator DB: founder-confirmed mapping only", () => {
  const driver = {
    query_new_users_in_range: vi.fn(async () => ({ ok: true, data: { available: true, count: 4, since: "", until: "" } })),
    query_new_bookings_in_range: vi.fn(async () => ({ ok: true, data: { available: true, count: 2, since: "", until: "" } })),
  };
  const deps = (confirmed: unknown) => ({
    getCatalog: vi.fn(async () => ({ catalog_hash: "h1" })),
    getConfirmedMapping: vi.fn(async () => confirmed),
    resolveAttachedDb: vi.fn(async () => ({ driver, cfg: {}, close: vi.fn(async () => undefined) })),
  });

  it("unconfirmed -> needs_confirmation, and the database is never queried", async () => {
    const d = deps(null);
    const r = await fetchOperatorCount(CTX, W, "bookings", d as never);
    expect(r).toMatchObject({ ok: false, reason: "needs_confirmation" });
    expect(d.resolveAttachedDb).not.toHaveBeenCalled();
    expect(driver.query_new_bookings_in_range).not.toHaveBeenCalled();
  });

  it("bookings confirmed WITHOUT its created-at field is still unconfirmed", async () => {
    const d = deps({ catalog_hash: "h1", confirmed_at: "2026-09-01T00:00:00Z", confirmed_map: { bookings: { table: "orders" } } });
    expect(await fetchOperatorCount(CTX, W, "bookings", d as never)).toMatchObject({ ok: false, reason: "needs_confirmation" });
  });

  it("confirmed -> one range count per local bucket, summed", async () => {
    const d = deps({
      catalog_hash: "h1",
      confirmed_at: "2026-09-01T00:00:00Z",
      confirmed_map: { bookings: { table: "orders", created_at_field: "createdAt", label: "x" } },
    });
    const r = await fetchOperatorCount({ ...CTX, tz: "America/New_York" }, { ...W, tz: "America/New_York" }, "bookings", d as never);
    expect(r.ok).toBe(true);
    expect((r as FetchOk).total_parts).toEqual({ count: 14 });
    expect(driver.query_new_bookings_in_range).toHaveBeenCalledTimes(7);
    expect((driver.query_new_bookings_in_range.mock.calls[0] as unknown[])[0]).toEqual({
      since: "2026-09-01T04:00:00.000Z",
      until: "2026-09-02T04:00:00.000Z",
    });
    expect((r as FetchOk).params).toMatchObject({ table: "orders", created_at_field: "createdAt" });
  });

  it("an unreadable confirmed field is read_failed, never a false zero", async () => {
    driver.query_new_users_in_range.mockResolvedValueOnce({ ok: true, data: { available: false, count: 0, since: "", until: "" } });
    const d = deps({ catalog_hash: "h1", confirmed_at: "2026-09-01T00:00:00Z", confirmed_map: { users: { table: "users", label: "u" } } });
    expect(await fetchOperatorCount(CTX, W, "users", d as never)).toMatchObject({ ok: false, reason: "read_failed" });
  });
});
