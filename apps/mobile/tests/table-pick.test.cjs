const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/channelTables.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Set, Map, Object, Array });
const t = mod.exports;

const SEO_KEYS = ["seo_issues", "seo_speed", "seo_vitals_passing", "seo_google", "seo_ai", "seo_schema"];
const SEO_TABLES = ["seo_issues", "seo_opportunities", "seo_vitals", "seo_google", "seo_ai", "seo_pages"];
const GEO_KEYS = ["geo_score", "geo_checks", "geo_mention_rate", "geo_crawlers", "geo_prompts"];
const GEO_TABLES = ["geo_bands", "geo_checks", "geo_mentions", "geo_sources", "geo_crawlers", "geo_hits", "geo_prompts"];

test("SEO starts on its first number's table (Issues), and only that table shows", () => {
  const p = t.pickTables("seo", SEO_KEYS, SEO_TABLES, undefined);
  assert.equal(p.picking, true);
  assert.equal(p.selectedKey, "seo_issues");
  assert.equal(p.visible("seo_issues"), true);
  assert.equal(p.visible("seo_opportunities"), false);
  assert.equal(p.visible("seo_pages"), false);
});

test("tapping Speed swaps to the page-test table", () => {
  const p = t.pickTables("seo", SEO_KEYS, SEO_TABLES, "seo_speed");
  assert.equal(p.selectedKey, "seo_speed");
  assert.equal(p.visible("seo_opportunities"), true);
  assert.equal(p.visible("seo_issues"), false);
  assert.equal(t.nextPick("seo", "seo_speed", "seo_speed"), "seo_speed");
});

test("GEO starts on Readiness, so its bands table is open; a tab row always keeps one open", () => {
  const p = t.pickTables("geo", GEO_KEYS, GEO_TABLES, undefined);
  assert.equal(p.selectedKey, "geo_score");
  assert.equal(p.selectedTable, "geo_bands");
  assert.equal(p.visible("geo_bands"), true);
  assert.equal(p.visible("geo_checks"), false);
  const open = t.pickTables("geo", GEO_KEYS, GEO_TABLES, "geo_checks");
  assert.equal(open.visible("geo_checks"), true);
  assert.equal(open.visible("geo_bands"), false);
  assert.equal(t.nextPick("geo", "geo_checks", "geo_checks"), "geo_checks");
  assert.equal(t.nextPick("geo", "geo_prompts", "geo_checks"), "geo_prompts");
});

test("a table no shown number heads is always visible: nothing is hidden behind a choice it was never part of", () => {
  const p = t.pickTables("geo", GEO_KEYS, GEO_TABLES, undefined);
  assert.equal(p.visible("geo_sources"), true);
  assert.equal(p.visible("geo_hits"), true);
});

test("a claim only counts when its table exists, and one claim is not a choice", () => {
  const one = t.pickTables("seo", SEO_KEYS, ["seo_issues"], undefined);
  assert.equal(one.picking, false);
  assert.equal(one.selectedKey, undefined);
  assert.equal(one.visible("seo_issues"), true);
  assert.equal(one.claimable.size, 0);
  const none = t.pickTables("blog", ["x"], ["y"], undefined);
  assert.equal(none.picking, false);
  assert.equal(none.visible("y"), true);
});

test("a picked number that stopped being a real choice falls back to the default, not a closed panel", () => {
  assert.equal(t.pickTables("seo", SEO_KEYS, SEO_TABLES, "gone").selectedKey, "seo_issues");
  assert.equal(t.pickTables("geo", GEO_KEYS, GEO_TABLES, "gone").selectedKey, "geo_score");
  const p = t.pickTables("seo", SEO_KEYS, SEO_TABLES, "seo_ai");
  assert.deepEqual([...p.claimable].sort(), [...SEO_KEYS].sort());
});

test("the open number's table is named, so the page can draw it first and the unclaimed ones after", () => {
  assert.equal(t.pickTables("geo", GEO_KEYS, GEO_TABLES, "geo_mention_rate").selectedTable, "geo_mentions");
  assert.equal(t.pickTables("geo", GEO_KEYS, GEO_TABLES, undefined).selectedTable, "geo_bands");
  assert.equal(t.pickTables("seo", SEO_KEYS, SEO_TABLES, undefined).selectedTable, "seo_issues");
  assert.equal(t.pickTables("blog", ["x"], ["y"], undefined).selectedTable, undefined);
});
