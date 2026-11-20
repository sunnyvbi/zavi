const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/growth/review.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Array, Object, String });
const r = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

const act = (id, effort, o = {}) => ({ id, channel_slug: "meta_ads", title: id, status: "pending", body: { step: { effort } }, ...o });

test("the one thing first, then quick wins, then the rest", () => {
  const byId = (a, b) => a.id.localeCompare(b.id);
  const out = r.arrangeReview([act("c", "minutes"), act("a", "days"), act("b", "minutes"), act("d", undefined)], byId);
  assert.equal(out.top.id, "a");
  assert.deepEqual(plain(out.quick.map((x) => x.id)), ["b", "c"]);
  assert.deepEqual(plain(out.longer.map((x) => x.id)), ["d"]);
  assert.equal(r.arrangeReview([], byId).top, null);
});

test("the first sentence is the one-line why", () => {
  assert.equal(r.firstSentence("Fix the title. Then post it."), "Fix the title.");
  assert.equal(r.firstSentence("No full stop here"), "No full stop here");
  assert.equal(r.firstSentence(null), "");
});

test("before you do it reads risk, undo and what skipping does", () => {
  const rows = plain(r.beforeYouDoIt({ findings: [{ risk: " Small ", undo: "Pause it", do_nothing: "" }] }));
  assert.deepEqual(rows, [["Risk", "Small"], ["Undo", "Pause it"]]);
  assert.deepEqual(plain(r.beforeYouDoIt({})), []);
});

test("effort words", () => {
  assert.equal(r.EFFORT_LABEL.minutes, "Minutes");
});
