const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/geoKpis.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const tablesSrc = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/features/channels/channelTables.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const tablesMod = { exports: {} };
vm.runInNewContext(tablesSrc, { module: tablesMod, exports: tablesMod.exports });
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: (n) => (n === "./channelTables" ? tablesMod.exports : {}), Number, Math, Array, Object, String, RegExp, Date });
const g = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

const readiness = (over = {}) => ({
  status: "ok",
  pages_analyzed: 12,
  score: { total: 58, bands: [] },
  crawlers: [
    { recommended: true, state: "blocked" },
    { recommended: true, state: "blocked" },
    { recommended: false, state: "allowed" },
  ],
  findings: [
    { code: "ai_crawler_blocked", summary: "ai_crawler_blocked." },
    { code: "no_lead_passage", summary: "no_lead_passage." },
    { code: "headings_not_questions", summary: "headings_not_questions." },
    { code: "no_specific_figures", summary: "no_specific_figures." },
    { code: "no_author_signal", summary: "no_author_signal." },
  ],
  ...over,
});
const visibility = (over = {}) => ({
  state: "ok",
  metrics: { mention_rate: { rate: 0.125 }, citation_rate: { rate: 0 } },
  deltas: { mention_rate: { significant: true, delta_pp: 2.5 }, citation_rate: { unavailable: "no base" } },
  config: { prompts_active: 5 },
  ...over,
});

test("the readiness number, checks passed, rates, crawlers and questions, in web's order", () => {
  const out = plain(g.geoKpis({ readiness: readiness(), visibility: visibility(), crawler_hits: { state: "awaiting_logs" } }));
  assert.deepEqual(out.map((m) => m.key), ["geo_score", "geo_checks", "geo_mention_rate", "geo_citation_rate", "geo_crawlers", "geo_prompts"]);
  const by = Object.fromEntries(out.map((m) => [m.key, m]));
  assert.equal(by.geo_score.value, 58);
  assert.equal(by.geo_checks.value, 4);
  assert.equal(by.geo_mention_rate.value, 12.5);
  assert.equal(by.geo_mention_rate.unit, "pct");
  assert.equal(by.geo_mention_rate.prev_value, 10);
  assert.equal(by.geo_citation_rate.value, 0);
  assert.equal(by.geo_citation_rate.prev_value, null);
  assert.equal(by.geo_crawlers.value, 1);
  assert.equal(by.geo_prompts.value, 5);
});

test("crawler hits show only once logs are flowing", () => {
  const out = plain(g.geoKpis({ readiness: readiness(), crawler_hits: { state: "ok", totals: { hits: 42 } } }));
  assert.equal(out.find((m) => m.key === "geo_hits").value, 42);
});

test("an insignificant change is no previous value, and an unmeasured rate draws no tile", () => {
  const out = plain(g.geoKpis({ visibility: visibility({ deltas: { mention_rate: { significant: false, delta_pp: 9 } } }) }));
  assert.equal(out.find((m) => m.key === "geo_mention_rate").prev_value, null);
  const none = plain(g.geoKpis({ visibility: { state: "never_run", metrics: null, config: { prompts_active: 5 } } }));
  assert.deepEqual(none.map((m) => m.key), ["geo_prompts"]);
});

test("a failed lane or an unread site answers without inventing numbers", () => {
  assert.deepEqual(plain(g.geoKpis({ readiness: { error: true }, visibility: { error: true } })), []);
  assert.deepEqual(plain(g.geoKpis(null)), []);
  const checks = g.geoChecks({ status: "ok", pages_analyzed: 0, crawlers: [], findings: [] });
  assert.deepEqual(plain(checks), { checked: 0, passed: 0 });
});

test("the checklist is the one source for the number and the table: owners, details, and not-checked", () => {
  const list = plain(g.geoChecklist(readiness()));
  assert.equal(list.length, 9);
  assert.equal(list[0].label, "AI search bots allowed");
  assert.equal(list[0].status, "fix");
  assert.equal(list[0].detail, "ai_crawler_blocked.");
  assert.equal(list.find((c) => c.key === "lead_passage").owner, "founder");
  assert.equal(list.find((c) => c.key === "schema").status, "pass");
  assert.ok(plain(g.geoChecklist(null)).every((c) => c.status === "not_checked"));
});

test("GEO tables: only lanes that read draw a table, and an unmeasured table says why", () => {
  const out = plain(g.geoTables({ readiness: readiness({ llms_txt: false, score: { total: 58, bands: [{ key: "a", label: "Authority", score: 21, weight: 20, note: "n" }] } }), visibility: visibility({ metrics: null }), crawler_hits: { state: "awaiting_logs", totals: { hits: 0 }, bots: [] } }));
  assert.deepEqual(out.map((t) => t.id), ["geo_bands", "geo_checks", "geo_crawlers", "geo_hits"]);
  assert.equal(out[0].rows[0].cells[2].text, "20%");
  const files = out[1].rows.filter((r) => r.id.startsWith("file-"));
  assert.equal(files[0].cells[1].text, "Found");
  assert.equal(files[1].cells[1].text, "Missing");
  assert.equal(out[3].rows.length, 0);
  assert.equal(out[3].empty, "Your log feed is connected but no log has arrived yet.");
  assert.deepEqual(plain(g.geoTables({ readiness: { error: true }, visibility: { error: true } })), []);
});

test("GEO crawler rule: the line, who it is for, and whether anything needs changing", () => {
  const out = plain(g.geoTables({ readiness: readiness({ crawlers: [
    { name: "GPTBot", recommended: true, state: "blocked", directive: "Disallow: /", from_wildcard: false },
    { name: "ClaudeBot", recommended: true, state: "partial", directive: "Disallow: /admin", disallowed_paths: ["/admin"] },
    { name: "Other", recommended: false, state: "allowed" },
  ] }) }));
  const t = out.find((x) => x.id === "geo_crawlers");
  assert.match(t.rows[0].detail.text, /The line: Disallow: \/\nA rule written for this bot\nTo change it:/);
  assert.match(t.rows[1].detail.text, /No change needed: only private areas are blocked/);
  assert.equal(t.rows[2].detail, undefined);
  assert.equal(t.rows[0].cells[1].chip, "bad");
});

test("GEO mentions, sources and prompts", () => {
  const v = visibility({
    config: { prompts_active: 1, brand: "Upcar", configured: true },
    metrics: {
      disclosure: "d",
      share_of_voice: { state: "ok", share: 0.5, brand_mentions: 2, rival_mentions: 2, rivals: [{ name: "Turo", mentions: 2, share: 0.5 }] },
      source_mix: { domains: [{ domain: "upcar.ai", kind: "owned", used: 0.4, citations: 3 }, { domain: "turo.com", kind: "rival", rival: "Turo", used: 0.2, citations: 1 }] },
    },
  });
  const out = plain(g.geoTables({ visibility: v, prompts: { active: [{ id: "p1", prompt_text: "best car rental", status: "active" }], suggested: [{ id: "p2", prompt_text: "p2q", rationale: "r", status: "suggested" }] } }));
  const by = Object.fromEntries(out.map((t) => [t.id, t]));
  assert.deepEqual(by.geo_mentions.rows.map((r) => [r.cells[0].text, r.cells[3].text]), [["Upcar", "50%"], ["Turo", "50%"]]);
  assert.equal(by.geo_sources.rows[0].cells[2].text, "40%");
  assert.equal(by.geo_sources.rows[1].cells[1].text, "Turo");
  const [tracked, suggested] = by.geo_prompts.rows;
  assert.deepEqual(tracked.actions.map((a) => a.label), ["Remove"]);
  assert.deepEqual(suggested.actions.map((a) => a.label), ["Track it", "Decline"]);
  assert.deepEqual(suggested.actions[0].call, { method: "POST", path: "/api/geo/prompts/accept", body: { ids: ["p2"] } });
  assert.deepEqual(tracked.actions[0].call, { method: "DELETE", path: "/api/geo/prompts/p1" });
  assert.equal(by.geo_prompts.caption, "1 tracked. Every rate above is measured against this set.");
  assert.equal(plain(g.geoTables({ visibility: v, prompts: { active: [], suggested: [] } })).find((t) => t.id === "geo_prompts").empty, "Zavi has not chosen any questions yet. It picks a starter set on its next read of this page.");
});
