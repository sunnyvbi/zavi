const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/dashboardRanges.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, encodeURIComponent, Array });
const r = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

test("paid and X channels offer 7/14/30 and start on the longest", () => {
  const c = r.rangeControls("meta_ads", null);
  assert.deepEqual(plain(c.ranges).map((x) => x.id), ["7d", "14d", "30d"]);
  assert.equal(c.initial.days, 30);
  assert.equal(c.pickable, true);
});

test("a payload that names its own windows wins", () => {
  const c = r.rangeControls("x_organic", { ranges: [{ id: "28d", label: "Last 28 days", days: 28 }, { id: "bad" }] });
  assert.deepEqual(plain(c.ranges), [{ id: "28d", label: "Last 28 days", days: 28 }]);
  assert.equal(c.pickable, false);
});

test("GEO measures over 7/30/90", () => {
  assert.deepEqual(plain(r.rangeControls("geo", null).ranges).map((x) => x.days), [7, 30, 90]);
});

test("LinkedIn, Instagram and TikTok are one 'Latest read' window", () => {
  for (const slug of ["linkedin_organic", "instagram_organic", "tiktok_organic"]) {
    const c = r.rangeControls(slug, { ranges: [{ id: "7d", label: "x", days: 7 }] });
    assert.deepEqual(plain(c.ranges), [{ id: "now", label: "Latest read", days: 30 }]);
    assert.equal(c.pickable, false);
  }
});

test("SEO offers the same 7/14/30 picker web shows", () => {
  const c = r.rangeControls("seo", null);
  assert.deepEqual(plain(c.ranges).map((x) => x.days), [7, 14, 30]);
  assert.equal(c.pickable, true);
});

test("pickRange falls back to the longest window", () => {
  const c = r.rangeControls("geo", null);
  assert.equal(r.pickRange(c, "7d").days, 7);
  assert.equal(r.pickRange(c, "gone").days, 90);
});

test("the dashboard path carries the window; a manual refresh adds web's two flags", () => {
  assert.equal(r.dashboardPath("x_organic", 7), "/api/agents/x_organic/dashboard?days=7&window=last_7d");
  assert.equal(r.dashboardPath("x_organic", 7, true), "/api/agents/x_organic/dashboard?refresh=1&meter=1&days=7&window=last_7d");
});
