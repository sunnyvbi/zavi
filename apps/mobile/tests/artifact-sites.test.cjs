const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(rel) {
  const source = fs.readFileSync(path.join(__dirname, rel), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Date });
  return mod.exports;
}

const S = load("../src/features/artifacts/sites.ts");
const plain = (v) => JSON.parse(JSON.stringify(v));

const site = (over) => ({
  id: "s1",
  title: "Shop",
  hostname: "shop.zavi.site",
  status: "live",
  live_url: "https://shop.zavi.site",
  build_session_id: "run-1",
  created_at: "2026-10-10T10:00:00Z",
  updated_at: "2026-10-10T10:00:00Z",
  ...over,
});
const file = (id, created_at) => ({ id, created_at, type: "document", title: id, filename: `${id}.pdf` });

test("isFinishedSite: live, paused and built-unpublished show; building, publishing and failed stay in Build", () => {
  assert.equal(S.isFinishedSite(site()), true);
  assert.equal(S.isFinishedSite(site({ status: "paused" })), true);
  assert.equal(S.isFinishedSite(site({ status: "building" })), false);
  assert.equal(S.isFinishedSite(site({ status: "building", built: true })), true);
  assert.equal(S.isFinishedSite(site({ status: "publishing", built: true })), false);
  assert.equal(S.isFinishedSite(site({ status: "failed" })), false);
});

test("visibleSites: only under All and Websites", () => {
  const sites = [site(), site({ id: "s2", status: "failed" })];
  assert.deepEqual(plain(S.visibleSites(sites, "all").map((s) => s.id)), ["s1"]);
  assert.deepEqual(plain(S.visibleSites(sites, "website").map((s) => s.id)), ["s1"]);
  assert.deepEqual(plain(S.visibleSites(sites, "document")), []);
});

test("siteBadge: built-but-unpublished reads Not published, never Building", () => {
  assert.equal(S.siteBadge(site()).label, "Live");
  assert.equal(S.siteBadge(site({ status: "building", built: true, live_url: null })).label, "Not published");
  assert.equal(S.siteBadge(site({ status: "waking" })).label, "Paused");
  assert.equal(S.siteBadge(site({ status: "odd" })), null);
});

test("siteHref: https only", () => {
  assert.equal(S.siteHref(site()), "https://shop.zavi.site");
  assert.equal(S.siteHref(site({ live_url: "http://shop.zavi.site" })), null);
  assert.equal(S.siteHref(site({ live_url: "javascript:alert(1)" })), null);
  assert.equal(S.siteHref(site({ live_url: null })), null);
});

test("mergeArtifactEntries: newest first, ties keep sites then server order", () => {
  const entries = S.mergeArtifactEntries(
    [site({ created_at: "2026-10-11T00:00:00Z" })],
    [file("deck", "2026-10-12T00:00:00Z"), file("a", "2026-10-11T00:00:00Z"), file("old", "2026-10-01T00:00:00Z")],
  );
  assert.deepEqual(plain(entries.map((e) => e.key)), ["deck", "site:s1", "a", "old"]);
});
