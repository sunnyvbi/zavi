const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const compile = (file) => ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const feesMod = { exports: {} };
vm.runInNewContext(compile(path.join(__dirname, "../../../packages/shared/src/creators/fees.ts")), { module: feesMod, exports: feesMod.exports, Math, Number, String, Object, Intl, Error, RegExp, Array });
const mod = { exports: {} };
vm.runInNewContext(compile(path.join(__dirname, "../src/features/channels/ugcOffers.ts")), {
  module: mod,
  exports: mod.exports,
  require: () => feesMod.exports,
  Number, Math, Date, String, RegExp, Object,
});
const o = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));
const draft = (over = {}) => ({ ...o.EMPTY_DRAFT, price: "150", days: "7", ...over });

test("a complete offer builds web's request body", () => {
  const c = o.checkOffer(draft({ count: "3", product: true }));
  assert.equal(c.ready, true);
  assert.deepEqual(plain(c.body), {
    kind: "ugc_video",
    terms: { title: "3 UGC videos", content_type: "UGC video", count: 3 },
    price_cents: 15000,
    delivery_days: 7,
    product_needed: true,
  });
});

test("every offer is a UGC video: no content-type choice, a stray type is ignored, and one item is singular", () => {
  assert.equal("type" in o.EMPTY_DRAFT, false);
  assert.equal(o.CONTENT_TYPES, undefined);
  assert.equal(o.offerKind, undefined);
  const c = o.checkOffer(draft({ type: "Instagram Reel" }));
  assert.equal(c.body.kind, "ugc_video");
  assert.deepEqual(plain(c.body.terms), { title: "1 UGC video", content_type: "UGC video", count: 1 });
  assert.equal(o.offerTitleOf(2), "2 UGC videos");
});

test("the form is not ready without a price, days, or with values out of web's range", () => {
  assert.equal(o.checkOffer(draft({ price: "" })).ready, false);
  assert.equal(o.checkOffer(draft({ price: "0" })).ready, false);
  assert.equal(o.checkOffer(draft({ days: "" })).ready, false);
  assert.equal(o.checkOffer(draft({ days: "91" })).ready, false);
  assert.equal(o.checkOffer(draft({ days: "90" })).ready, true);
  assert.equal(o.checkOffer(draft({ count: "0" })).ready, false);
  assert.equal(o.checkOffer(draft({ count: "21" })).ready, false);
  assert.equal(o.checkOffer(draft({ price: "999999999" })).ready, false);
  assert.equal(o.checkOffer(draft({ price: "12.345" })).ready, false);
  assert.equal(o.checkOffer(draft({ price: "" })).body, null);
});

test("the fee line comes from the shared fee function: what you pay with Zavi's 10% fee", () => {
  const line = o.checkOffer(draft()).feeLine("Maya");
  assert.equal(line, "If Maya accepts, you are asked to pay $165 with Zavi's 10% fee.");
  assert.equal(o.checkOffer(draft({ price: "" })).feeLine("Maya"), "");
  assert.equal(o.checkOffer(draft({ price: "19.99" })).feeLine("Maya"), "If Maya accepts, you are asked to pay $21.99 with Zavi's 10% fee.");
});

test("field filters keep digits, and the price keeps a decimal point", () => {
  assert.equal(o.digits("1a2-3"), "123");
  assert.equal(o.priceText("$1,50.5x"), "150.5");
});

const offer = (over = {}) => ({ proposed_by: "tenant", status: "open", expired: false, delivery_days: 7, ...over });

test("status chips use web's words, and the row's own answer beats the clock", () => {
  assert.deepEqual(plain(o.offerChip(offer(), "Maya")), { label: "Waiting for Maya", tone: "amber" });
  assert.equal(o.offerChip(offer({ proposed_by: "creator" }), "Maya").label, "Waiting for you");
  assert.equal(o.offerChip(offer({ status: "declined", expired: true }), "Maya").label, "Maya declined");
  assert.equal(o.offerChip(offer({ status: "withdrawn" }), "Maya").label, "Withdrawn");
  assert.equal(o.offerChip(offer({ expired: true }), "Maya").label, "Expired");
  assert.equal(o.offerChip(offer({ status: "accepted", awaiting_payment: true }), "Maya").label, "Maya accepted");
  assert.equal(o.offerChip(offer({ status: "accepted", awaiting_payment: false }), "Maya").label, "Paid, job started");
  assert.equal(o.offerChip(offer({ status: "accepted", closed_unpaid: true }), "Maya").label, "Closed, not paid");
});

test("you can withdraw only your own open offer; accepting and paying are not done here", () => {
  assert.equal(o.canWithdraw(offer()), true);
  assert.equal(o.canWithdraw(offer({ proposed_by: "creator" })), false);
  assert.equal(o.canWithdraw(offer({ status: "accepted" })), false);
  assert.equal(o.canWithdraw(offer({ expired: true })), false);
  assert.equal(o.canWithdraw(offer({ status: "withdrawn" })), false);
});

test("what, when and the hint under an offer", () => {
  assert.equal(o.offerWhat({ kind: "ugc_video", terms: { title: " 3 UGC videos " } }), "3 UGC videos");
  assert.equal(o.offerWhat({ kind: "audience_post", terms: null }), "Custom offer");
  assert.equal(o.offerWhat({ kind: "ugc_video" }), "Custom video");
  assert.equal(o.offerDue({ delivery_days: 7, terms: null }), "7 days after it starts");
  assert.equal(o.offerDue({ delivery_days: 7, terms: { due_date: "2026-10-11" } }), "Oct 11");
  assert.equal(o.offerHint(offer(), "Maya"), "If Maya accepts, you are asked to pay and the job starts.");
  assert.match(o.offerHint(offer({ status: "accepted", awaiting_payment: true }), "Maya"), /^Maya accepted\. Pay to start/);
  assert.match(o.offerHint(offer({ status: "accepted", closed_unpaid: true }), "Maya"), /Nothing was charged/);
  assert.equal(o.offerHint(offer({ status: "withdrawn" }), "Maya"), null);
});
