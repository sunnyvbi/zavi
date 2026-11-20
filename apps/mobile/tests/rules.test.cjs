const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/settings/rulesModel.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Date, Set });
const r = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

const names = { channel: (s) => ({ meta_ads: "Meta Ads" })[s], agent: (s) => ({ engineer: "Engineer" })[s] ?? s };

test("scope keys round-trip like web", () => {
  assert.equal(r.scopeKey("all", null), "all");
  assert.equal(r.scopeKey("agent", "engineer"), "agent:engineer");
  assert.deepEqual(plain(r.parseScope("channel:meta_ads")), { scope_kind: "channel", scope_slug: "meta_ads" });
  assert.deepEqual(plain(r.parseScope("all")), { scope_kind: "all", scope_slug: null });
});

test("scope labels", () => {
  assert.equal(r.scopeLabel("all", names), "All agents");
  assert.equal(r.scopeLabel("channel:meta_ads", names), "Meta Ads");
  assert.equal(r.scopeLabel("channel:unknown", names), "unknown");
  assert.equal(r.scopeLabel("agent:engineer", names), "Engineer");
});

test("meta line: scope, origin, day", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const base = { id: "1", text: "x", scope_kind: "all", scope_slug: null, created_by: null, excerpt: null };
  const active = { ...base, status: "active", origin: "chat_typed", approved_at: "2026-09-30T12:00:00Z", created_at: "2026-09-01T12:00:00Z" };
  assert.equal(r.ruleMeta(active, "All agents", now), "All agents · From a chat · September 30");
  const pending = { ...base, status: "suggested", origin: "mystery", approved_at: null, created_at: "2025-05-03T12:00:00Z" };
  assert.equal(r.ruleMeta(pending, "Engineer", now), "Engineer · Suggested · May 3, 2025");
});

test("roles: owners and admins manage, members suggest, viewers read", () => {
  assert.deepEqual(plain(r.ruleRights("owner")), { canManage: true, canSuggest: true });
  assert.deepEqual(plain(r.ruleRights("admin")), { canManage: true, canSuggest: true });
  assert.deepEqual(plain(r.ruleRights("member")), { canManage: false, canSuggest: true });
  assert.deepEqual(plain(r.ruleRights("viewer")), { canManage: false, canSuggest: false });
  assert.deepEqual(plain(r.ruleRights(null)), { canManage: false, canSuggest: false });
});

test("split and scope options", () => {
  const list = { role: "owner", suggestions_paused: false, rules: [{ id: "a", status: "active" }, { id: "b", status: "suggested" }] };
  const s = r.splitRules(list);
  assert.equal(s.active.length, 1);
  assert.equal(s.pending.length, 1);
  assert.deepEqual(plain(r.splitRules(undefined)), { active: [], pending: [] });
  const o = r.scopeOptions(["pm", "engineer", "meta_ads", "engineer"], [{ slug: "meta_ads", name: "Meta Ads" }], (s) =>
    s === "pm" ? "Product Manager" : "Engineer",
  );
  assert.deepEqual(plain(o.agents.map((a) => a.key)), ["agent:engineer", "agent:pm"]);
  assert.deepEqual(plain(o.channels), [{ key: "channel:meta_ads", label: "Meta Ads" }]);
});
