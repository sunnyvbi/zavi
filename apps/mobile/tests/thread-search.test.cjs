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
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports });
  return mod.exports;
}

const { searchThreads } = load("../src/features/agents/threadSearch.ts");
const plain = (v) => JSON.parse(JSON.stringify(v));

const row = (id, title) => ({
  id,
  title,
  last_message_at: null,
  last_message: null,
  run_status: null,
  pending: false,
});

test("undefined rows returns an empty list", () => {
  assert.deepEqual(plain(searchThreads(undefined, "anything")), []);
});

test("empty query returns all rows in order", () => {
  const rows = [row("a", "Alpha"), row("b", "Beta"), row("c", null)];
  assert.deepEqual(plain(searchThreads(rows, "").map((r) => r.id)), ["a", "b", "c"]);
});

test("whitespace-only query returns all rows in order", () => {
  const rows = [row("a", "Alpha"), row("b", null), row("c", "Gamma")];
  assert.deepEqual(plain(searchThreads(rows, "   \n\t ").map((r) => r.id)), ["a", "b", "c"]);
});

test("matching is case-insensitive against trimmed query text", () => {
  const rows = [row("a", "Quarterly Plan"), row("b", "sales follow-up"), row("c", "Hiring PLAN")];
  assert.deepEqual(plain(searchThreads(rows, "  plan ").map((r) => r.id)), ["a", "c"]);
});

test("null title never matches a non-empty query", () => {
  const rows = [row("a", null), row("b", "Notes")];
  assert.deepEqual(plain(searchThreads(rows, "note").map((r) => r.id)), ["b"]);
});

test("no match returns an empty list", () => {
  const rows = [row("a", "Alpha"), row("b", "Beta")];
  assert.deepEqual(plain(searchThreads(rows, "delta")), []);
});

test("order is preserved from the input rows", () => {
  const rows = [row("first", "Launch"), row("second", "Prelaunch"), row("third", "Launch recap")];
  assert.deepEqual(plain(searchThreads(rows, "launch").map((r) => r.id)), ["first", "second", "third"]);
});

test("searchThreads does not mutate the input rows", () => {
  const rows = [row("a", "Alpha"), row("b", "Beta"), row("c", null)];
  const before = JSON.parse(JSON.stringify(rows));
  const result = searchThreads(rows, "a");
  assert.deepEqual(rows, before);
  assert.deepEqual(plain(result.map((r) => r.id)), ["a", "b"]);
  assert.notEqual(result, rows);
});
