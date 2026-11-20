const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/connectors/githubRepos.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: () => ({}) });
const { githubReposFrom, repoErrorText, branchSaveErrorText } = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

test("not connected: no repos", () => {
  assert.deepEqual(plain(githubReposFrom(null)), { connected: false, repos: [], default: null, hiddenByScope: 0 });
});

test("repos are sorted and the default kept", () => {
  const r = githubReposFrom({
    repo_full_names: ["b/two", "a/one"],
    default_repo_full_name: "b/two",
    repo_ids: null,
    selected_repo_ids: null,
  });
  assert.deepEqual(plain(r), { connected: true, repos: ["a/one", "b/two"], default: "b/two", hiddenByScope: 0 });
});

test("a repo scope hides the repos outside it", () => {
  const r = githubReposFrom({
    repo_full_names: ["a/one", "b/two", "c/three"],
    default_repo_full_name: null,
    repo_ids: [1, 2, 3],
    selected_repo_ids: [3],
  });
  assert.deepEqual(plain(r.repos), ["c/three"]);
  assert.equal(r.hiddenByScope, 2);
});

test("a scope whose ids don't line up with names is ignored", () => {
  const r = githubReposFrom({ repo_full_names: ["a/one"], default_repo_full_name: null, repo_ids: [1, 2], selected_repo_ids: [] });
  assert.deepEqual(plain(r.repos), ["a/one"]);
});

test("error wording matches web", () => {
  assert.match(repoErrorText("not in selected repositories"), /outside your repo scope/);
  assert.equal(repoErrorText("bad_request: repo missing"), "repo missing");
});

test("a known base-branch error code gets web's sentence", () => {
  assert.equal(branchSaveErrorText("unsafe_branch", 400), "That branch name isn't valid.");
  assert.equal(branchSaveErrorText("repo_not_connected", 422), "That repo isn't connected anymore.");
  assert.equal(branchSaveErrorText("not_admin", 403), "Only admins can change the base branch.");
});

test("any other base-branch failure never shows the server's words", () => {
  assert.equal(branchSaveErrorText("missing_field", 400), "Couldn't save.");
  assert.equal(branchSaveErrorText(undefined, 404), "Couldn't save.");
  assert.equal(branchSaveErrorText("rpc_failed", 500), "Couldn't save, please try again.");
  assert.equal(branchSaveErrorText("http_502", 502), "Couldn't save, please try again.");
});

test("the chip shows the repo's own name, like web", () => {
  assert.equal(mod.exports.repoChipLabel("rravi149/praxis"), "praxis");
  assert.equal(mod.exports.repoChipLabel(null), null);
});

test("the chip is the saved default, so it is there before anything is picked", () => {
  const { savedRepoChip } = mod.exports;
  assert.equal(savedRepoChip({ connected: true, default: "rravi149/praxis" }), "rravi149/praxis");
});

test("no chip when GitHub is not connected, nothing is saved, or the data is not loaded", () => {
  const { savedRepoChip } = mod.exports;
  assert.equal(savedRepoChip({ connected: false, default: "a/b" }), null);
  assert.equal(savedRepoChip({ connected: true, default: null }), null);
  assert.equal(savedRepoChip(undefined), null);
  assert.equal(savedRepoChip(null), null);
});

test("no chip for a repo in Zavi's own build org, like web", () => {
  const { savedRepoChip } = mod.exports;
  assert.equal(savedRepoChip({ connected: true, default: "Praxis-build/site-123" }), null);
  assert.equal(savedRepoChip({ connected: true, default: "praxis-built/site-9" }), null);
  assert.equal(savedRepoChip({ connected: true, default: "acme/praxis-build" }), "acme/praxis-build");
});
