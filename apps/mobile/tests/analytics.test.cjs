const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(rel) {
  const source = fs.readFileSync(path.join(__dirname, rel), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports });
  return mod.exports;
}

const M = load("../src/features/analytics/model.ts");
const C = load("../src/features/analytics/chart.ts");
const plain = (v) => JSON.parse(JSON.stringify(v));
const NOW = new Date(2026, 9, 1, 15, 0);

test("ads query is the one web's picker sends for the same range", () => {
  assert.equal(M.adsQuery("7d", NOW), "window=last_7d");
  assert.equal(M.adsQuery("30d", NOW), "window=last_30d");
  assert.equal(M.adsQuery("90d", NOW), "window=last_month&since=2026-07-04&until=2026-10-01");
  assert.equal(M.adsQuery("30d", NOW, true), "window=last_30d&refresh=1");
});

const day = (date, over = {}) => ({ date, spend_usd: 10, impressions: 1000, clicks: 50, bookings: 2, revenue_usd: 40, maturing: false, ...over });

const payload = {
  window_label: "last 30 days",
  connected: { meta: true, google: true },
  kpis: { spend_usd: 6588.4, conversions: 170, revenue_usd: 9000, roas: 1.37, cpa_usd: 38.76, impressions: 412345, clicks: 3910, ctr_percent: 0.95, cpc_usd: 1.68, cpm_usd: 15.98 },
  channels: [
    { channel: "meta", connected: true, spend_usd: 5000, conversions: 120, revenue_usd: 7000, roas: 1.4, cpa_usd: 41.67, impressions: 300000, clicks: 3000, ctr_percent: 1, cpc_usd: 1.67, cpm_usd: 16.67 },
    { channel: "google", connected: true, spend_usd: 1588.4, conversions: 50, revenue_usd: 2000, roas: 1.26, cpa_usd: 31.77, impressions: 112345, clicks: 910, ctr_percent: 0.81, cpc_usd: 1.75, cpm_usd: 14.14 },
  ],
  daily_series: { points: [day("2026-09-27"), day("2026-09-28"), day("2026-09-29", { bookings: 4 }), day("2026-09-30", { bookings: 4 })] },
  daily_series_by_channel: { meta: { points: [day("2026-09-30")] }, google: null },
  channel_errors: { google: { code: "x", message: "y" } },
  stale: false,
};

test("ads totals: Both uses kpis, each account uses its own channel row (web's tabs)", () => {
  const v = M.normalizeAds(payload);
  assert.equal(v.totals.all.conversions, 170);
  assert.equal(v.totals.meta.spend_usd, 5000);
  assert.equal(v.totals.google.cpa_usd, 31.77);
  assert.equal(v.series.meta.length, 1);
  assert.deepEqual(plain(v.series.google), []);
  assert.deepEqual(plain(M.adScopes(v).map((s) => s.value)), ["all", "meta", "google"]);
  assert.equal(M.defaultScope(v), "all");
  assert.equal(v.errors.length, 1);
});

test("KPI cards print exactly like web's ChannelKpiCards", () => {
  const v = M.normalizeAds(payload);
  const d = M.computeHalfDeltas(v.series.all);
  const meta = M.adKpiCards("meta", v.totals.all, d);
  assert.deepEqual(plain(meta.map((c) => [c.label, c.value])), [
    ["Amount spent", "$6,588"],
    ["Bookings", "170"],
    ["CAC", "$39"],
    ["ROAS (all)", "1.37×"],
    ["Clicks", "3.9K"],
    ["Impressions", "412K"],
    ["CTR", "0.95%"],
    ["CPM", "$15.98"],
  ]);
  const google = M.adKpiCards("google", v.totals.google, d);
  assert.deepEqual(plain(google.slice(4).map((c) => c.label)), ["Clicks", "Avg. CPC", "Impressions", "Conv. rate"]);
  assert.equal(google[7].value, "5.49%");
});

test("deltas are second half vs first half, with web's signs and colours", () => {
  const d = M.computeHalfDeltas(M.normalizeAds(payload).series.all);
  assert.deepEqual(plain(d.bookings), { text: "+100.0%", good: true });
  assert.deepEqual(plain(d.cac), { text: "−50.0%", good: true });
  assert.deepEqual(plain(d.spend), { text: "±0%", good: true });
  assert.deepEqual(plain(d.roas), { text: "±0.00", good: true });
  assert.equal(M.computeHalfDeltas([day("2026-09-30")]).bookings, null);
});

test("compactCount matches web", () => {
  assert.equal(M.compactCount(999), "999");
  assert.equal(M.compactCount(1000), "1K");
  assert.equal(M.compactCount(12345), "12.3K");
  assert.equal(M.compactCount(123456), "123K");
  assert.equal(M.compactCount(2500000), "2.5M");
  assert.equal(M.compactCount(null), "—");
});

test("chart keeps only days inside the local range; 90 days groups into weeks", () => {
  const pts = Array.from({ length: 95 }, (_, i) => {
    const d = new Date(2026, 6, 1 + i);
    return day(M.localYmd(d));
  });
  const in7 = M.pointsInRange(pts, "7d", NOW);
  assert.equal(in7[0].date, "2026-09-25");
  assert.equal(in7.length, 7);
  const weeks = M.bucketAds(M.pointsInRange(pts, "90d", NOW), "90d");
  assert.equal(weeks.length, 13);
  assert.equal(weeks[weeks.length - 1].bookings, 14);
  assert.equal(weeks[weeks.length - 1].label, "Sep 25");
  assert.equal(M.costPerBooking({ spend: 10, bookings: 0 }), null);
});

test("search: ctr is a fraction, position blank when 0", () => {
  const s = M.normalizeSearch({
    connected: true,
    totals: { clicks: 3579, impressions: 90000, ctr: 0.03977, position: 14.24 },
    series: [{ date: "2026-09-30", clicks: 120, impressions: 3000 }],
    top_queries: [{ key: "car rental", clicks: 40, impressions: 900, ctr: 0.04, position: 3.2 }],
  });
  assert.ok(M.searchHasNumbers(s));
  assert.equal(M.ctrPct(s.totals.ctr), "4.0%");
  assert.equal(M.position(s.totals.position), "14.2");
  assert.equal(M.position(0), "—");
  assert.equal(M.searchHasNumbers(M.normalizeSearch({ connected: false })), false);
});

test("geo: web's KPI strip and the not-measured case", () => {
  const g = M.normalizeGeo({
    geo: {
      status: "ok",
      fetched_at: "2026-09-25T10:00:00Z",
      pages_analyzed: 14,
      score: { total: 62, bands: [{ key: "a", label: "Answers", weight: 30, score: 40 }] },
      crawlers: [
        { recommended: true, state: "blocked" },
        { recommended: true, state: "allowed" },
        { recommended: false, state: "blocked" },
      ],
      pages: [{ server_rendered: true }, { server_rendered: false }],
      findings: [{}, {}, {}],
      not_checked: ["Whether ChatGPT cites you"],
    },
  });
  assert.equal(g.measured, true);
  assert.equal(g.crawlersBlocked, 1);
  assert.equal(g.crawlersRecommended, 2);
  assert.equal(g.readableWithoutJs, 1);
  assert.equal(g.issues, 3);
  assert.equal(M.crawlDate(g.fetchedAt), "Sep 25");
  assert.equal(M.scoreTone(62), "fair");
  assert.equal(M.normalizeGeo({ geo: { pages_analyzed: 0, score: { total: 0, bands: [] } } }).measured, false);
  assert.equal(M.normalizeGeo({}), null);
});

test("summary line and plan locks", () => {
  const ads = M.normalizeAds(payload);
  const search = M.normalizeSearch({ connected: true, totals: { clicks: 3579, impressions: 1, ctr: 0, position: 0 } });
  assert.equal(M.summaryLine(ads, search), "Ads brought 170 bookings for $6,588. Google sent 3,579 search clicks in the last 28 days.");
  assert.equal(M.summaryLine(null, search), "Ads aren't connected yet. Google sent 3,579 search clicks in the last 28 days.");
  assert.match(M.summaryLine(null, null), /^No numbers yet/);
  assert.equal(M.lockOf({ meta_ads: "pro", seo: "free", geo: null }, "meta_ads"), "pro");
  assert.equal(M.lockOf({ seo: "free" }, "seo"), null);
  assert.equal(M.lockOf(null, "geo"), null);
});

test("chart scale and labels", () => {
  assert.deepEqual(plain(C.niceScale([170])), { step: 50, top: 200, bottom: 0 });
  assert.deepEqual(plain(C.niceScale([0])), { step: 1, top: 4, bottom: 0 });
  assert.deepEqual(plain(C.niceScale([-30, 70])), { step: 25, top: 75, bottom: -50 });
  assert.equal(C.axisLabel(2500, "$"), "$2.5k");
  assert.equal(C.tipValue(1234.5, "$"), "$1,234.5");
  assert.equal(C.tipValue(null, "$"), "—");
  assert.equal(C.monotonePath([]), "");
  assert.match(C.monotonePath([{ x: 0, y: 10 }, { x: 10, y: 5 }, { x: 20, y: 8 }]), /^M 0 10 C /);
});
