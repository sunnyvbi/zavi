const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/artifacts/csv.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Math });
const c = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

test("quotes, doubled quotes, commas and CRLF", () => {
  assert.deepEqual(plain(c.parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')), [["a", "b"], ["x, y", 'say "hi"']]);
  assert.deepEqual(plain(c.parseCsv("a,b\n\n1,2")), [["a", "b"], ["1", "2"]]);
});

test("a preview slice keeps the header, N rows and says when there are more", () => {
  const text = "h1,h2\n1,a\n2,b\n3,c\n4,d\n5,e\n";
  const p = plain(c.csvPreview(text, 3));
  assert.deepEqual(p.header, ["h1", "h2"]);
  assert.equal(p.body.length, 3);
  assert.equal(p.more, true);
  assert.equal(plain(c.csvPreview("h\n1\n", 3)).more, false);
});

test("a CSV is told by mime or file name", () => {
  assert.equal(c.isCsv({ mime: "text/csv", filename: "x" }), true);
  assert.equal(c.isCsv({ mime: "application/octet-stream", filename: "Report.CSV" }), true);
  assert.equal(c.isCsv({ mime: "application/vnd.ms-excel", filename: "x.xlsx" }), false);
});
