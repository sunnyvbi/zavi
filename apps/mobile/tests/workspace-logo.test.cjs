const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/workspaces/logo.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports });
const { workspaceLogoUrl } = mod.exports;

test("a website becomes its own https favicon", () => {
  assert.equal(workspaceLogoUrl("shiksha.com"), "https://shiksha.com/favicon.ico");
  assert.equal(workspaceLogoUrl("http://www.upcar.ai/pricing"), "https://upcar.ai/favicon.ico");
  assert.equal(workspaceLogoUrl(" https://app.acme.co.uk "), "https://app.acme.co.uk/favicon.ico");
});

test("no usable site, no logo", () => {
  assert.equal(workspaceLogoUrl(null), null);
  assert.equal(workspaceLogoUrl(""), null);
  assert.equal(workspaceLogoUrl("localhost"), null);
  assert.equal(workspaceLogoUrl("my company"), null);
});
