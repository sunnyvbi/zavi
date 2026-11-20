const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/adLocations.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Set, Array });
const a = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

const place = (id, kind = "City", extra = {}) => ({ id, name: id, kind, ...extra });
const status = (over = {}) => ({
  state: "needs_you",
  channel: "google_ads",
  campaign: { id: "c1", name: "Brand" },
  country: { code: "US", name: "United States" },
  places: [place("US", "Country")],
  targeting: "single",
  ad_groups: 1,
  pending: false,
  last_error: null,
  order_cities: [],
  fingerprint: "f",
  ...over,
});

test("which channels get the card", () => {
  assert.deepEqual([...a.AD_LOCATION_SLUGS].sort(), ["google_ads", "meta_ads", "youtube_ads"]);
});

test("words", () => {
  assert.equal(a.joinAnd(["A"]), "A");
  assert.equal(a.joinAnd(["A", "B", "C"]), "A, B and C");
  assert.equal(a.countryText({ code: "US", name: "United States" }), "the United States");
  assert.equal(a.countryText({ code: "CA", name: "Canada" }), "Canada");
  assert.equal(a.countryText(null), "your country");
  assert.equal(
    a.needsYouLine(status(), "Google Ads"),
    "Zavi started your new Google Ads campaign across the United States so it can learn today. If you don't pick places, it stays on the whole country.",
  );
  assert.equal(a.unsupportedLine("Meta Ads", "meta_ads"), "Zavi can't change where this Meta Ads campaign shows. Change it in Meta Ads Manager.");
  assert.equal(a.ordersHint([]), null);
  assert.match(a.ordersHint(["Austin"]), /Narrowing to it usually/);
  assert.match(a.ordersHint(["Austin", "Dallas"]), /Austin and Dallas.*Narrowing to them/);
  assert.equal(a.savedLine(status({ state: "saved", places: [place("Austin"), place("Dallas")], pending: true })), "Austin, Dallas. Zavi is updating your campaign now.");
});

test("subtitle and save label", () => {
  assert.equal(a.pickedSubtitle([], false), "Loading suggestions…");
  assert.equal(a.pickedSubtitle([place("x", "City", { source: "orders" })], true), "Zavi suggested these from your orders.");
  assert.equal(a.pickedSubtitle([place("x", "City", { source: "orders" }), place("y", "City", { source: "address" })], true), "Zavi suggested these from your orders and address.");
  assert.equal(a.pickedSubtitle([], true), "Search for the places your customers are in.");
  assert.equal(a.saveLabel(0, false), "Save whole country");
  assert.equal(a.saveLabel(1, false), "Save 1 place");
  assert.equal(a.saveLabel(3, false), "Save 3 places");
  assert.equal(a.saveLabel(3, true), "Saving…");
});

test("the picker starts from today's places, or the orders picks when the campaign is country-wide", () => {
  const sugg = { orders: "confirmed", country: null, places: [place("Austin"), place("Dallas")], picked: ["Dallas"] };
  assert.deepEqual(plain(a.initialPicked(status(), sugg)).map((p) => p.id), ["Dallas"]);
  assert.deepEqual(plain(a.initialPicked(status({ places: [place("Austin")] }), sugg)).map((p) => p.id), ["Austin"]);
});

test("toggle adds, removes and stops at the cap", () => {
  const one = [place("a")];
  assert.deepEqual(plain(a.togglePlace(one, place("b"))).map((p) => p.id), ["a", "b"]);
  assert.deepEqual(plain(a.togglePlace(one, place("a"))), []);
  const full = Array.from({ length: a.MAX_PLACES }, (_, i) => place(`p${i}`));
  assert.equal(a.togglePlace(full, place("extra")).length, a.MAX_PLACES);
});

test("server messages", () => {
  assert.equal(a.messageOf({ error: { message: "Stale." } }, "x"), "Stale.");
  assert.equal(a.messageOf(null, "x"), "x");
  assert.equal(a.messageOf({ error: { message: " " } }, "x"), "x");
});
