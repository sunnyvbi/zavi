const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const kpi = loadTs(path.join(__dirname, "../src/features/agents/kpiReceipt.ts"));
const fmt = loadTs(path.join(__dirname, "../src/features/agents/receiptFormat.ts"));
const web = loadTs(path.join(__dirname, "../../web/src/components/workspace/receipts/receiptData.ts"));
const plain = (v) => JSON.parse(JSON.stringify(v));

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

test("neutral metrics: the same answer as web for ids and labels", () => {
  const cases = [
    "ad_spend", "Ad spend", "ad spend", "Ads spend", "Spend", "spend_total", "meta_spend", "google-spend",
    "Total Spend", "Daily ad spend", "ROAS", "Revenue", "spendy", "Spent", "overspend", "Net revenue", "", null, undefined,
  ];
  for (const c of cases) {
    assert.equal(kpi.isNeutralMetric(c), web.isNeutralMetric(c), `isNeutralMetric(${JSON.stringify(c)})`);
  }
  assert.equal(kpi.isNeutralMetric("Ad spend"), true);
  assert.equal(kpi.isNeutralMetric("Revenue"), false);
});

test("source names: the same as web, LinkedIn Ads included", () => {
  const slugs = [
    "stripe", "stripe_mrr", "meta_ads", "google_ads", "linkedin_ads", "google_analytics", "ga4", "gsc", "operator_db",
    "posthog", "derived", "compute", "metric", "founder_reported", "some_new_source", "reddit-ads", "", null, undefined,
  ];
  for (const s of slugs) assert.equal(fmt.sourceName(s), web.sourceName(s), `sourceName(${JSON.stringify(s)})`);
  assert.equal(fmt.sourceName("linkedin_ads"), "LinkedIn Ads");
});

test("windows: the same wording as web", () => {
  const windows = [
    { since: "2026-09-01", until: "2026-09-27" },
    { since: "2026-09-27", until: "2026-09-27" },
    { since: "2026-08-30", until: "2026-09-02" },
    { since: "2025-12-28", until: "2026-01-03" },
    { since: "2025-12-28", until: "2026-01-03T00:00:00Z" },
    { since: "nope", until: "2026-09-02" },
    null,
    undefined,
  ];
  for (const w of windows) assert.equal(fmt.formatWindow(w), web.formatWindow(w), JSON.stringify(w));
  assert.equal(fmt.formatWindow({ since: "2026-09-01", until: "2026-09-27" }), "Sep 1-27");
});

test("the chip reads like web's: source, window, how long ago", () => {
  const receipts = [
    { source: "stripe", window: { since: "2026-09-01", until: "2026-09-27" }, fetched_at: ago(2 * HOUR) },
    { source: "meta_ads", fetched_at: ago(30_000) },
    { source: "google_ads", window: { since: "2026-08-30", until: "2026-09-02" } },
    { source: "compute", fetched_at: ago(5 * 24 * HOUR) },
    { source: "linkedin_ads", fetched_at: ago(12 * 60_000) },
    { source: "brand_new_source", window: { since: "2025-12-28", until: "2026-01-03" } },
    { source: "stripe", fetched_at: "not a time" },
    { source: "stripe", fetched_at: new Date(NOW + 10 * HOUR).toISOString() },
  ];
  for (const r of receipts) {
    const mobile = kpi.kpiChip({ label: "Revenue", verified: true, receipt: r }, NOW);
    assert.equal(mobile.label, web.chipLabel(web.fromBlockReceipt(r), new Date(NOW)), JSON.stringify(r));
  }
  assert.equal(
    kpi.kpiChip({ label: "Revenue", verified: true, receipt: receipts[0] }, NOW).label,
    "Stripe · Sep 1-27 · 2h ago",
  );
});

test("a source-checked number gets its source chip; an unchecked one says Unverified", () => {
  const r = { source: "stripe", fetched_at: ago(HOUR) };
  assert.deepEqual(plain(kpi.kpiChip({ label: "MRR", verified: true, receipt: r }, NOW)), {
    kind: "verified",
    label: "Stripe · 1h ago",
  });
  assert.deepEqual(plain(kpi.kpiChip({ label: "MRR", verified: false }, NOW)), { kind: "unverified", label: "Unverified" });
  assert.equal(kpi.kpiChip({ label: "MRR", verified: false, receipt: r }, NOW).kind, "unverified");
});

test("no chip for a block with no provenance, or a verified number with no receipt", () => {
  assert.equal(kpi.kpiChip({ label: "MRR" }, NOW), null);
  assert.equal(kpi.kpiChip({ label: "MRR", verified: true }, NOW), null);
});

test("a change is green or red, except for ad spend, which stays grey", () => {
  assert.equal(kpi.deltaTone({ label: "Revenue", tone: "up" }), "up");
  assert.equal(kpi.deltaTone({ label: "Churn", tone: "down" }), "down");
  assert.equal(kpi.deltaTone({ label: "Revenue", tone: "flat" }), "neutral");
  assert.equal(kpi.deltaTone({ label: "Revenue" }), "neutral");
  assert.equal(kpi.deltaTone({ label: "Ad spend", tone: "up" }), "neutral");
  assert.equal(kpi.deltaTone({ label: "Ad spend", tone: "down" }), "neutral");
  assert.equal(kpi.deltaTone({ label: "Total", tone: "up", receipt: { source: "meta_ads", metric_id: "ad_spend" } }), "neutral");
  assert.equal(kpi.deltaTone({ label: "Total", tone: "up", receipt: { source: "stripe", metric_id: "net_revenue" } }), "up");
});

test("a card of eight numbers, one of each kind, reads item by item", () => {
  const items = [
    { label: "Revenue", tone: "up", verified: true, receipt: { source: "stripe", fetched_at: ago(HOUR) } },
    { label: "Ad spend", tone: "up", verified: true, receipt: { source: "meta_ads", metric_id: "ad_spend" } },
    { label: "Signups", tone: "down", verified: false },
    { label: "CAC", tone: "flat" },
    { label: "Churn", tone: "down", verified: true },
    { label: "Visits", verified: true, receipt: { source: "ga4", window: { since: "2026-09-01", until: "2026-09-07" } } },
    { label: "Orders", tone: "up", verified: false },
    { label: "Refunds" },
  ];
  assert.deepEqual(
    plain(items.map((i) => [kpi.deltaTone(i), kpi.kpiChip(i, NOW)?.label ?? null])),
    [
      ["up", "Stripe · 1h ago"],
      ["neutral", "Meta Ads"],
      ["down", "Unverified"],
      ["neutral", null],
      ["down", null],
      ["neutral", "Google Analytics · Sep 1-7"],
      ["up", "Unverified"],
      ["neutral", null],
    ],
  );
});
