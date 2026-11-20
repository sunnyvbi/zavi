const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/channelAccount.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, {
  module: mod,
  exports: mod.exports,
  Number, Array, String,
  require: () => ({ seoAccount: (p) => (p && p.site_health ? { name: "upcar.ai", sub: "24 pages read" } : null) }),
});
const a = mod.exports.channelAccount;
const plain = (v) => JSON.parse(JSON.stringify(v));

test("X: the handle and the read allowance (a refresh bills X)", () => {
  assert.deepEqual(plain(a("x_organic", { handle: "@upcar", read_budget: { used: 2, cap: 10, remaining: 8 } })), { name: "@upcar", sub: "8 of 10 reads left today" });
  assert.equal(a("x_organic", { handle: "@upcar", read_budget: { used: 10, cap: 10, remaining: 0 } }).sub, "No reads left today");
  assert.equal(a("x_organic", { account_name: "Upcar" }).name, "Upcar");
  assert.equal(a("x_organic", { connected: false }), null);
});

test("LinkedIn, Instagram and TikTok: name, followers and the refresh allowance", () => {
  assert.deepEqual(plain(a("linkedin_organic", { account: { name: "Upcar", followers: 10800 }, refresh: { used: 1, cap: 3, remaining: 2 } })), { name: "Upcar", sub: "10,800 followers · 2 of 3 refreshes left today" });
  assert.equal(a("instagram_organic", { account: { username: "upcar", followers: 5 } }).name, "@upcar");
  assert.equal(a("tiktok_organic", { account: { name: "Upcar TT" } }).name, "Upcar TT");
  assert.equal(a("instagram_organic", { account: { name: "no handle" } }), null);
});

test("ads channels: the account and how many campaigns are running", () => {
  assert.deepEqual(plain(a("reddit_ads", { connected: true, account: { name: "Upcar Reddit", active_count: 1 } })), { name: "Upcar Reddit", sub: "1 active campaign" });
  assert.equal(a("tiktok_ads", { connected: true, account: { name: "TT", campaign_count: 3 } }).sub, "3 campaigns");
  assert.deepEqual(plain(a("meta_ads", { channels: [{ channel: "meta" }], campaigns: [{ channel: "meta", status: "ACTIVE" }, { channel: "meta", status: "PAUSED" }] })), { name: null, sub: "1 active campaign" });
  assert.equal(a("meta_ads", { channels: [] }), null);
});

test("GEO and SEO name the site that was read", () => {
  assert.deepEqual(plain(a("geo", { readiness: { status: "ok", site: "https://upcar.ai/", pages_analyzed: 1 } })), { name: "upcar.ai", sub: "1 page read" });
  assert.equal(a("geo", { readiness: { error: true } }), null);
  assert.equal(a("seo", { site_health: {} }).name, "upcar.ai");
});

test("other channels and unreadable payloads say nothing", () => {
  assert.equal(a("blog", { account: { name: "x" } }), null);
  assert.equal(a("x_organic", null), null);
});
