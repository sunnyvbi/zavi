const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/ugcBrief.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Date, Math, Number, String, RegExp });
const b = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

const row = (o) => ({
  id: "b1", status: "draft", title: "Spring", angle: "Show the app", hook: "Rent a car in 2 taps", format: "9:16, 30s",
  deliverables: 2, budget_usd: "150.00", lane: "ugc_video", filters: { niches: ["Apps"], platforms: ["TikTok"], locations: ["Austin", "Dallas"] },
  delivery_days: 7, posted_at: null, answer_by: "2026-10-12T23:59:59.000Z", applicant_cap: 20, decline_note: "Thanks", closed_at: null,
  rationale: null, product_needed: false, ad_rights_days: 30, ...o,
});

test("a saved draft fills the fields; placeholder words show empty", () => {
  const d = b.draftFrom(row({}));
  assert.equal(d.budget, "150");
  assert.equal(d.locations, "Austin, Dallas");
  assert.equal(d.answerBy, "2026-10-12");
  assert.equal(d.rights, "30");
  const p = b.draftFrom(row({ title: "Untitled brief", hook: "Write the hook" }));
  assert.equal(p.title, "");
  assert.equal(p.hook, "");
});

test("no brief starts on one video and 90 days of ad rights", () => {
  const d = b.draftFrom(null);
  assert.equal(d.deliverables, "1");
  assert.equal(d.rights, "90");
});

test("every brief is a UGC video brief: no lane to pick, and an old audience-post row still saves as a video brief", () => {
  assert.equal(b.LANES, undefined);
  assert.equal("lane" in b.draftFrom(null), false);
  const old = plain(b.toInput(b.draftFrom(row({ lane: "audience_post" }))));
  assert.equal(old.lane, "ugc_video");
  assert.equal(old.ad_rights_days, 30);
  assert.equal(plain(b.toInput({ ...b.draftFrom(row({})), lane: "audience_post" })).lane, "ugc_video");
});

test("the body matches web: trimmed text, numbers, answer-by at end of day, the rights window", () => {
  const input = plain(b.toInput({ ...b.draftFrom(row({})), title: "  Spring  ", locations: "Austin, , Dallas " }));
  assert.equal(input.title, "Spring");
  assert.equal(input.budget_usd, 150);
  assert.equal(input.answer_by, "2026-10-12T23:59:59.000Z");
  assert.deepEqual(input.filters.locations, ["Austin", "Dallas"]);
  assert.equal(input.ad_rights_days, 30);
  assert.equal(plain(b.toInput({ ...b.draftFrom(row({})), rights: "" })).ad_rights_days, null);
  assert.equal(plain(b.toInput({ ...b.draftFrom(row({})), budget: "", answerBy: "" })).budget_usd, null);
});

test("publish needs title, angle, hook and format, and sane numbers", () => {
  const ok = b.draftFrom(row({}));
  assert.equal(b.check(ok).ready, true);
  assert.equal(b.check({ ...ok, hook: " " }).ready, false);
  assert.equal(b.check({ ...ok, days: "91" }).ready, false);
  assert.equal(b.check({ ...ok, cap: "501" }).ready, false);
  assert.equal(b.check({ ...ok, deliverables: "21" }).ready, false);
  assert.equal(b.check({ ...ok, answerBy: "2026-13-45" }).ready, false);
  assert.equal(b.check({ ...ok, days: "", cap: "", answerBy: "" }).ready, true);
});

test("quick answer-by days count from now", () => {
  assert.equal(b.dayFromNow(7, new Date("2026-10-05T10:00:00Z")), "2026-10-12");
  assert.equal(b.digits("1a2-3"), "123");
});
