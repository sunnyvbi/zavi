const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/cardCopy.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Set, Array, Object, RegExp });
const c = mod.exports;

test("an ad change: sentence is the lead, evidence the bullets, rows the steps, estimate the gain", () => {
  const out = c.cardCopy({
    change_sentence: "Raise the daily budget on Brand - Exact from $20 to $30.",
    decision_evidence: {
      stats: [{ value: "12", caption: "conversions in 30 days" }],
      estimate: [{ value: "+4", caption: "conversions a month" }],
      reason_text: "It spent its full budget on most days.",
    },
    exact_change: { rows: [{ item: "Brand - Exact", before: "$20/day", after: "$30/day" }] },
  });
  assert.equal(out.lead, "Raise the daily budget on Brand - Exact from $20 to $30.");
  assert.deepEqual(Array.from(out.why), ["12 conversions in 30 days", "It spent its full budget on most days."]);
  assert.deepEqual(Array.from(out.steps), ["Brand - Exact: $20/day → $30/day"]);
  assert.deepEqual(Array.from(out.gain), ["+4 conversions a month"]);
});

test("a task card: reasons split from step lines", () => {
  const out = c.cardCopy({ step: { body: "Your title is long. Open the page editor.\n- Shorten it to 60 characters" } });
  assert.equal(out.lead, "Your title is long.");
  assert.deepEqual(Array.from(out.steps), ["Open the page editor.", "Shorten it to 60 characters"]);
});

test("steps are capped and the rest counted; raw field names never show", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ item: `k${i}`, before: "a", after: "b" }));
  const out = c.cardCopy({ change_sentence: "Block terms.", exact_change: { rows } });
  assert.equal(out.steps.length, 6);
  assert.equal(out.moreSteps, 3);
  const raw = c.cardCopy({ decision_evidence: { stats: [{ value: "budget_micros=5", caption: "spent on most days" }] } });
  assert.equal(raw.lead, "Spent on most days");
});

test("nothing to say is null", () => {
  assert.equal(c.cardCopy({}), null);
});
