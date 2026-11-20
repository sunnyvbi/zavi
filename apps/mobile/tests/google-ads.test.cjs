const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/googleAds.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const pageSrc = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/features/channels/channelPage.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const pageMod = { exports: {} };
vm.runInNewContext(pageSrc, { module: pageMod, exports: pageMod.exports, Date, Math, Number, Intl, Set, String, Array, Object });
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Date, Math, Number, require: () => pageMod.exports });
const g = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

test("numbers format like web", () => {
  assert.equal(g.money(18420), "$18,420");
  assert.equal(g.money(54.5, true), "$54.50");
  assert.equal(g.money(null), "-");
  assert.equal(g.roas(2.345), "2.35×");
  assert.equal(g.count(1234.6), "1,235");
});

test("period label names the dates and the year", () => {
  assert.equal(g.periodLabel(g.rangeFor("30d"), { from: "2026-09-07", to: "2026-10-06" }), "Last 30 days: Sep 7 – Oct 6, 2026");
  assert.equal(g.periodLabel(g.rangeFor("7d")), "Last 7 days");
  assert.equal(g.rangeFor("nope").days, 30);
});

test("campaign status chip", () => {
  assert.deepEqual(plain(g.statusChip({ status: "ENABLED", limited_by_budget: true })), { label: "Limited", tone: "warn" });
  assert.deepEqual(plain(g.statusChip({ status: "ENABLED", limited_by_budget: false })), { label: "Enabled", tone: "good" });
  assert.deepEqual(plain(g.statusChip({ status: "PAUSED", limited_by_budget: false })), { label: "Paused", tone: "muted" });
  assert.equal(g.statusChip({ status: "", limited_by_budget: false }).label, "Unknown");
});

test("read errors", () => {
  assert.equal(g.errorBanner({ connected: true, error_code: null }), null);
  assert.equal(g.errorBanner({ connected: false, error_code: "x" }), null);
  assert.equal(g.errorBanner({ connected: true, error_code: "google_ads_token_revoked" }).kind, "reconnect");
  assert.equal(g.errorBanner({ connected: true, error_code: "boom" }).kind, "unreadable");
});

test("plan line and edit label", () => {
  const p = { spend: 410, plan: 1500, plan_basis: "founder", pct: 90, capped_campaigns: 1, campaigns: 3, days_elapsed: 10, days_in_month: 30 };
  assert.equal(g.planLine(p), "$410 of $1,500 this month · 1 of 3 campaigns spent their full daily budget on most days");
  assert.equal(g.planLine({ ...p, plan: null }), "No plan yet: set one or add daily budgets");
  assert.equal(g.planEditLabel(p), "Your plan · Edit plan");
  assert.equal(g.planEditLabel({ plan_basis: "auto" }), "Plan from your daily budgets · Edit plan");
});

test("plan input", () => {
  assert.equal(g.parseBudget("$1,500"), 1500);
  assert.equal(g.parseBudget("0"), 0);
  assert.equal(g.parseBudget(""), null);
  assert.equal(g.parseBudget("abc"), null);
  assert.equal(g.parseBudget("-5"), null);
});

test("kpis become metrics; an unread number stays as a dash, a ROAS floor has no delta", () => {
  const out = g.kpisToMetrics({
    period: { from: "a", to: "2026-10-06" },
    kpis: [
      { key: "spend", value: 100, prev: 80, unit: "usd" },
      { key: "cpa", value: null, prev: 5, unit: "usd" },
      { key: "roas", value: 2, prev: 3, unit: "ratio", floor: true },
    ],
  });
  assert.equal(out[0].prev_value, 80);
  assert.equal(out[1].grounded, false);
  assert.equal(out[2].prev_value, null);
});

test("pace carries its own arithmetic and a verdict; ROAS says what comes back", () => {
  const out = plain(g.kpisToMetrics({
    period: { from: "a", to: "2026-10-06" },
    kpis: [
      { key: "pacing", value: 130, prev: null, unit: "pct", pacing: { spend: 1267, plan: 1500, plan_basis: "founder", pct: 130, capped_campaigns: 0, campaigns: 2, days_elapsed: 25, days_in_month: 30 } },
      { key: "roas", value: 1.49, prev: 1, unit: "ratio" },
      { key: "roas", value: 0.8, prev: 1, unit: "ratio", floor: true },
    ],
  }));
  assert.equal(out[0].tone, "bad");
  assert.equal(out[0].note, "$1,267 of $1,500 · day 25 of 30");
  assert.equal(out[1].tone, "good");
  assert.equal(out[1].note, "$1.49 back per $1 spent");
  assert.equal(out[2].tone, "warn");
  assert.equal(out[2].note, "at least $0.80 back per $1 spent");
  assert.equal(out[2].prev_value, null);
});

test("pace bands: on pace is good, over 105 warns, over 125 is bad", () => {
  assert.equal(pageMod.exports.paceTone(100), "good");
  assert.equal(pageMod.exports.paceTone(110), "warn");
  assert.equal(pageMod.exports.paceTone(130), "bad");
  assert.equal(pageMod.exports.paceTone(null), undefined);
});
