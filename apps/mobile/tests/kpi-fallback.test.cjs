const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, deps) {
  const source = fs.readFileSync(path.join(__dirname, "../src/features/channels", file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: (n) => deps[n], Number, Math, Intl, Array, Object, Set, String, JSON });
  return mod.exports;
}
const page = load("channelPage.ts", {});
const tables = load("channelTables.ts", {});
const seo = load("seoKpis.ts", { "./channelPage": page, "./channelTables": tables, "./seoIssueCopy": {} });
const geo = load("geoKpis.ts", { "./channelPage": page, "./channelTables": tables });
const k = load("kpiFallback.ts", { "./channelPage": page, "./seoKpis": seo, "./geoKpis": geo });
const plain = (v) => JSON.parse(JSON.stringify(v));

const ads = (platform, extra = {}) => ({
  platform,
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-09-06", to: "2026-10-05" },
  account: { currency: "USD" },
  totals: { spend: 100, cpa: 10, conversions: 10, clicks: 50, ctr: 2, cpc: 2, conv_value: 300, roas: 3 },
  prev_totals: { spend: 80, cpa: 8, conversions: 10, clicks: 40, ctr: 1, cpc: 2, conv_value: 100, roas: 1.2 },
  ...extra,
});

test("which channels read a dashboard", () => {
  assert.equal(k.KPI_FALLBACK.meta_ads, "meta");
  assert.equal(k.KPI_FALLBACK.seo, "seo");
  assert.equal(k.KPI_FALLBACK.blog, undefined);
});

test("reddit ads: six numbers in web's order with the previous window", () => {
  const out = plain(k.fallbackMetrics("reddit_ads", ads("reddit_ads")));
  assert.deepEqual(out.map((m) => m.key), ["spend", "cpa", "conversions", "clicks", "ctr", "cpc"]);
  assert.equal(out[0].unit, "usd");
  assert.equal(out[0].prev_value, 80);
});

test("tiktok ads carry conversion value and a ROAS verdict", () => {
  const out = plain(k.fallbackMetrics("tiktok_ads", ads("tiktok_ads")));
  assert.deepEqual(out.map((m) => m.key), ["spend", "cpa", "conversions", "conv_value", "roas", "ctr"]);
  const roas = out.find((m) => m.key === "roas");
  assert.equal(roas.tone, "good");
  assert.equal(roas.note, "$3.00 back per $1 spent");
});

test("a ratio with no denominator says why instead of showing zero", () => {
  const out = plain(k.fallbackMetrics("reddit_ads", ads("reddit_ads", { totals: { spend: 5, cpa: null, conversions: 0, clicks: 0, ctr: null, cpc: null } })));
  const cpa = out.find((m) => m.key === "cpa");
  assert.equal(cpa.unmeasured, "No conversions in this period");
  assert.equal(cpa.grounded, false);
});

test("another currency keeps its own unit; no currency blocks the money tiles", () => {
  const eur = plain(k.fallbackMetrics("reddit_ads", ads("reddit_ads", { account: { currency: "EUR" } })));
  assert.equal(eur[0].unit, "currency:EUR");
  const none = plain(k.fallbackMetrics("reddit_ads", ads("reddit_ads", { account: { currency: null } })));
  assert.equal(none[0].unmeasured, "Totals need a single currency");
});

test("not connected, errored or the wrong platform answers nothing", () => {
  assert.deepEqual(plain(k.fallbackMetrics("reddit_ads", ads("reddit_ads", { connected: false }))), []);
  assert.deepEqual(plain(k.fallbackMetrics("reddit_ads", ads("reddit_ads", { error_code: "x" }))), []);
  assert.deepEqual(plain(k.fallbackMetrics("reddit_ads", ads("x_ads"))), []);
  assert.deepEqual(plain(k.fallbackMetrics("reddit_ads", null)), []);
});

test("meta reads its USD totals", () => {
  const out = plain(k.fallbackMetrics("meta_ads", { window: "last_30d", channels: [{ channel: "meta", spend_usd: 50, conversions: 5, revenue_usd: 40, roas: 0.8, cpa_usd: 10, ctr_percent: 1.2 }] }));
  assert.equal(out.find((m) => m.key === "spend").value, 50);
  assert.equal(out.find((m) => m.key === "roas").tone, "bad");
});

test("x derives the previous value from the move and flags a thin engagement rate", () => {
  const out = plain(k.fallbackMetrics("x_organic", { period: { to: "2026-10-05" }, metrics: [
    { key: "impressions", value: 40, unit: "count", delta: 100, delta_unit: "pct", basis: "period" },
    { key: "engagement_rate", value: 5, unit: "pct", delta: 1, delta_unit: "pp", basis: "period" },
  ] }));
  assert.equal(out[0].key, "impressions");
  assert.equal(out[0].prev_value, 20);
  assert.equal(out[1].prev_value, 4);
  assert.equal(out[1].note, "From only 40 views");
});

test("linkedin, instagram and tiktok pass their ready rows through", () => {
  const rows = [{ key: "followers", value: 5, unit: "count", grounded: true, prev_value: null, day: "" }];
  assert.equal(k.fallbackMetrics("instagram_organic", { metrics: rows }).length, 1);
  assert.deepEqual(plain(k.fallbackMetrics("blog", { metrics: rows })), []);
});

test("tiles show an outOf, a tone and an unmeasured reason", () => {
  const tiles = plain(page.metricTiles("seo", [
    { key: "seo_speed", value: 56, unit: "count", grounded: true, prev_value: null, day: "", outOf: { max: 100 }, tone: "warn", note: "Needs work" },
    { key: "seo_vitals_passing", value: 0, unit: "count", grounded: true, prev_value: null, day: "", outOf: { max: 3, of: true, tail: "pass" } },
    { key: "seo_google", value: Number.NaN, unit: "count", grounded: true, prev_value: null, day: "", unmeasured: "Lab did not run" },
  ]));
  const by = Object.fromEntries(tiles.map((t) => [t.key, t]));
  assert.equal(by.seo_speed.suffix, "/100");
  assert.equal(by.seo_speed.tone, "warn");
  assert.equal(by.seo_vitals_passing.suffix, " of 3 pass");
  assert.equal(by.seo_google.value, "-");
  assert.equal(by.seo_google.unmeasured, "Lab did not run");
});
