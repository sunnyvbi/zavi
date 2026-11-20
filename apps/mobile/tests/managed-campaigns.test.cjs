const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const compile = (file) => ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const shared = { exports: {} };
vm.runInNewContext(compile(path.join(__dirname, "../../../packages/shared/src/channels/ad-approval.ts")), { module: shared, exports: shared.exports, RegExp });
const mod = { exports: {} };
vm.runInNewContext(compile(path.join(__dirname, "../src/features/channels/managedCampaigns.ts")), {
  module: mod, exports: mod.exports, require: () => shared.exports,
  Intl, Number, Math, Date, String, JSON, Array, Set, Object, URL, URLSearchParams, RegExp, encodeURIComponent,
});
const m = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

const camp = (over = {}) => ({ id: "c1", name: "Zavi: Spring", status: "paused", updated_at: 111, bidding_type: "clicks", budget: { lifetime_spend_limit_micros: 500_000_000 }, ...over });
const form = (over = {}) => ({ ...m.formFrom(null, undefined, ""), name: "Spring launch", budget: "500", ...over });

test("money, counts, percent and dates read like web", () => {
  assert.equal(m.money(1234.5, "USD"), "$1,234.50");
  assert.equal(m.money(null, "USD"), "—");
  assert.equal(m.money(5, null), "—");
  assert.equal(m.count(1234.567), "1,234.57");
  assert.equal(m.count(undefined), "—");
  assert.equal(m.percent(0.0312), "3.12%");
  assert.equal(m.statusLabel("paused"), "Paused");
  assert.equal(m.statusLabel(null), "Unknown");
  assert.deepEqual([m.statusTone("active"), m.statusTone("paused"), m.statusTone("archived")], ["green", "amber", "muted"]);
  assert.equal(m.shortName("Zavi: Spring", "Zavi: "), "Spring");
  assert.equal(m.budgetLine({ budget: { daily_spend_limit_micros: 25_000_000 } }, "USD"), "$25.00 / day");
  assert.equal(m.budgetLine({ budget: { lifetime_spend_limit_micros: 500_000_000 } }, "USD"), "$500.00 total");
});

test("the five headline numbers, with ROAS from purchase return", () => {
  const cards = plain(m.metricCards({ currency: "USD", totals_across_your_campaigns_only: { spend: 120, impressions: 4000, clicks: 90, conversions: 3 }, purchase_return: { roas: 2.5 } }));
  assert.deepEqual(cards.map((c) => [c.label, c.value]), [["Spend", "$120.00"], ["Impressions", "4,000"], ["Clicks", "90"], ["Conversions", "3"], ["ROAS", "2.50×"]]);
  assert.equal(m.metricCards(null)[4].value, "—");
});

test("the dashboard is recognised by its source", () => {
  assert.equal(m.asDashboard({ source: "other", campaigns: [] }), null);
  assert.equal(m.asDashboard(null), null);
  assert.ok(m.asDashboard({ source: "chatgpt_ads_api", campaigns: [] }));
});

test("only a paused campaign can be edited on the phone; active and archived say why", () => {
  assert.equal(m.canEditHere({ status: "paused" }), true);
  assert.equal(m.canEditHere({ status: "active" }), false);
  assert.equal(m.canEditHere({ status: "archived" }), false);
  assert.equal(m.editBlocked({ status: "paused" }), null);
  assert.match(m.editBlocked({ status: "active" }), /live delivery.*zaviagent\.com/);
  assert.equal(m.editBlocked({ status: "archived" }), "Archived campaigns cannot be edited.");
});

test("dates are written as 2026-10-12 09:00 and read back; nonsense is NaN, blank is null", () => {
  const t = m.fromLocalText("2026-10-12 09:30");
  assert.equal(m.toLocalText(t), "2026-10-12 09:30:00");
  assert.equal(m.fromLocalText(""), null);
  assert.ok(Number.isNaN(m.fromLocalText("12/10/2026")));
  assert.ok(Number.isNaN(m.fromLocalText("2026-02-31")));
  assert.equal(m.toLocalText(null), "");
  assert.ok(m.fromLocalText("2026-10-12") > 0);
  assert.deepEqual(plain(m.countryCodes("us, CA  ca")), ["US", "CA"]);
});

test("the form is checked the way web checks it", () => {
  assert.equal(m.formProblem(form(), "USD", null), null);
  assert.match(m.formProblem(form({ name: "ab" }), "USD", null), /name of at least 3/);
  assert.match(m.formProblem(form(), null, null), /currency/);
  assert.match(m.formProblem(form({ budget: "" }), "USD", null), /budget/);
  assert.match(m.formProblem(form({ budgetType: "daily", budget: "10", start: "2026-10-12 09:00", end: "2026-10-20 09:00" }), "USD", null), /starts at \$25/);
  assert.match(m.formProblem(form({ budgetType: "daily", budget: "30" }), "USD", null), /start and an end/);
  assert.match(m.formProblem(form({ start: "2026-10-12 09:00", end: "2026-10-11 09:00" }), "USD", null), /after the start/);
  assert.match(m.formProblem(form({ start: "tomorrow" }), "USD", null), /2026-10-12 09:00/);
  assert.match(m.formProblem(form({ platforms: [] }), "USD", null), /at least one platform/);
  assert.match(m.formProblem(form({ objective: "conversions", event: "" }), "USD", null), /conversion event/);
  assert.equal(m.formProblem(form({ objective: "conversions", event: "e1" }), "USD", null), null);
  assert.match(m.formProblem(form(), "USD", camp({ status: "active" })), /live delivery/);
});

test("creating sends the objective and the whole body; nothing says active", () => {
  const r = plain(m.saveRequest(form({ objective: "conversions", event: "e1", feed: "f1", start: "2026-10-12 09:00", end: "2026-10-20 09:00", budgetType: "daily", budget: "30", countries: "us" }), null));
  assert.equal(r.path, "/api/channels/chatgpt_ads/campaigns");
  assert.equal(r.body.name, "Spring launch");
  assert.equal(r.body.bidding_type, "conversions");
  assert.deepEqual(r.body.conversion_event_setting_ids, ["e1"]);
  assert.equal(r.body.mode, "product_feed");
  assert.equal(r.body.product_feed_id, "f1");
  assert.equal(r.body.daily_budget_micros, 30_000_000);
  assert.equal(r.body.targeting.locations.countries[0], "US");
  assert.equal("status" in r.body, false);
  assert.equal("expected_updated_at" in r.body, false);
});

test("editing sends only what changed, with the version it read", () => {
  const existing = camp({ targeting: { platforms: { included: ["web", "ios_app", "android_app"] }, locations: { countries: [], include: [] }, excluded_locations: { countries: [], include: [] }, custom_audiences: { ids: [] }, excluded_custom_audiences: { ids: [] } } });
  const same = m.saveRequest(m.formFrom(existing, undefined, "Zavi: "), existing);
  assert.equal(same.path, "/api/channels/chatgpt_ads/campaigns/c1");
  assert.deepEqual(plain(same.body), { name: "Spring", expected_updated_at: 111 });
  const bumped = m.saveRequest({ ...m.formFrom(existing, undefined, "Zavi: "), budget: "800" }, existing);
  assert.equal(bumped.body.lifetime_budget_micros, 800_000_000);
  assert.equal("bidding_type" in bumped.body, false);
  assert.equal("targeting" in bumped.body, false);
});

test("ad group form and request: a fixed bid in the objective's units, hints one per line", () => {
  const c = camp();
  const f = { name: "Buyers", hints: "a\n\n b ", strategy: "fixed_bid", bid: "1.5" };
  assert.equal(m.groupProblem(f, c), null);
  assert.match(m.groupProblem({ ...f, name: "x" }, c), /at least 3/);
  assert.match(m.groupProblem({ ...f, bid: "" }, c), /bid/);
  const r = plain(m.groupRequest("c1", c, f, null));
  assert.equal(r.path, "/api/channels/chatgpt_ads/campaigns/c1/ad-groups");
  assert.deepEqual(r.body.context_hints, ["a", "b"]);
  assert.equal(r.body.max_bid_micros, 1_500_000);
  assert.equal(m.groupRequest("c1", c, f, "g9").path, "/api/channels/chatgpt_ads/campaigns/c1/ad-groups/g9/edit");
  assert.equal("max_bid_micros" in m.groupRequest("c1", c, { ...f, strategy: "maximize_clicks" }, null).body, false);
  assert.equal(m.bidText({ bidding_config: { max_bid_micros: 2_000_000 } }, c), "2");
  assert.equal(m.groupRequest("c1", camp({ bidding_type: "impressions" }), f, null).body.max_bid_micros, 1500);
});

test("ad form and request: title and copy limits, a link, an image; a product ad needs no link or image", () => {
  const c = camp();
  const f = { group: "g1", name: "Spring ad", title: "Book now", body: "A short line", url: "https://example.com/book", image: "https://example.com/i.png", tracking: "utm_source=chatgpt" };
  assert.equal(m.adProblem(f, c, null), null);
  assert.match(m.adProblem({ ...f, title: "x".repeat(51) }, c, null), /title/);
  assert.match(m.adProblem({ ...f, body: "x".repeat(101) }, c, null), /copy/);
  assert.match(m.adProblem({ ...f, url: "example.com" }, c, null), /https/);
  assert.match(m.adProblem({ ...f, image: null }, c, null), /image/);
  assert.equal(m.adProblem({ ...f, image: null }, c, { id: "a1" }), null);
  assert.equal(m.adProblem({ ...f, url: "", image: null }, camp({ mode: "product_feed" }), null), null);
  const r = plain(m.adRequest(c, "c1", f, null));
  assert.equal(r.path, "/api/channels/chatgpt_ads/campaigns/c1/creatives");
  assert.equal(r.body.image_url, "https://example.com/i.png");
  assert.equal(r.body.target_url, "https://example.com/book");
  const priv = "0a1b2c3d-1111-2222-3333-444455556666/0a1b2c3d-aaaa-bbbb-cccc-ddddeeeeffff.jpg";
  assert.equal(m.adRequest(c, "c1", { ...f, image: priv }, null).body.image_path, priv);
  assert.equal(m.adRequest(c, "c1", f, { id: "a1", ad_group_id: "g7" }).body.ad_group_id, "g7");
  assert.equal(m.adRequest(c, "c1", f, { id: "a1", ad_group_id: "g7" }).path, "/api/channels/chatgpt_ads/campaigns/c1/creatives/a1");
  assert.equal(m.adRequest(camp({ mode: "product_feed" }), "c1", f, null).body.creative_type, "product_ad_template");
  assert.equal(m.adEditable({ creative: { type: "chat_card" } }), true);
  assert.equal(m.adEditable({ creative: { type: "other" } }), false);
});

test("tracking defaults keep only the UTM parameters of the link", () => {
  assert.equal(m.trackingFor("utm_source=x", undefined), "utm_source=x");
  assert.equal(m.trackingFor("d", "https://a.com/p?utm_source=chatgpt&x=1&utm_medium=paid"), "utm_source=chatgpt&utm_medium=paid");
  assert.equal(m.trackingFor("d", "not a url"), "");
});

test("a retry of the same save keeps its request id; a changed save gets a new one", () => {
  let n = 0;
  const id = () => `id${++n}`;
  const a = m.requestKey(null, "/p", { x: 1 }, id);
  assert.equal(m.requestKey(a, "/p", { x: 1 }, id).id, a.id);
  assert.notEqual(m.requestKey(a, "/p", { x: 2 }, id).id, a.id);
});

test("name-only paused edits retain exact seconds even during a repeated DST hour", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const start = Date.parse("2025-11-02T06:30:57Z") / 1000;
    const existing = camp({ start_time: start, end_time: start + 3600, budget: { daily_spend_limit_micros: 25_000_000 } });
    const f = { ...m.formFrom(existing, undefined, ""), name: "Renamed campaign" };
    assert.equal(m.formProblem(f, "USD", existing), null);
    const request = m.saveRequest(f, existing);
    assert.equal("start_time" in request.body, false);
    assert.equal("end_time" in request.body, false);
    assert.match(m.formProblem({ ...f, budget: "30" }, "USD", existing), /future/);
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test("invalid clock components and rolled dates are refused instead of silently shifted", () => {
  for (const value of ["2027-01-01 24:00", "2027-01-01 09:60", "2027-01-01 09:00:60", "2027-02-30 10:00"]) assert.ok(Number.isNaN(m.fromLocalText(value)), value);
  assert.equal(m.toLocalText(m.fromLocalText("2027-01-01 09:00:57")), "2027-01-01 09:00:57");
});

test("new schedules check future end, maximum daily duration, and budget precision", () => {
  const start = Math.floor(Date.now() / 1000) + 86400;
  assert.match(m.formProblem(form({ budget: "25.001" }), "USD", null), /decimal/);
  assert.match(m.formProblem(form({ end: "2020-01-01 12:00" }), "USD", null), /future/);
  const f = form({ budgetType: "daily", budget: "25", start: m.toLocalText(start), end: m.toLocalText(start + 91 * 86400) });
  assert.match(m.formProblem(f, "USD", null), /90 days/);
  assert.equal(m.formProblem({ ...f, end: m.toLocalText(start + 90 * 86400) }, "USD", null), null);
});
