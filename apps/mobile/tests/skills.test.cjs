const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/skill/skillText.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Set });
const { previewOf, normalizeTags, matchesSkill } = mod.exports;

test("the preview drops frontmatter and headings", () => {
  const body = "\n---\nname: refunds\ndescription: x\n---\n# Refunds\nCheck the order first.\n## Steps\nThen refund.";
  assert.equal(previewOf(body), "Check the order first.\nThen refund.");
  assert.equal(previewOf("Plain text"), "Plain text");
});

test("tags are lowercase, deduped, stripped of # and quotes, and capped at 10", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeTags("Refunds, #support, refunds, 'Policy', "))), [
    "refunds",
    "support",
    "policy",
  ]);
  assert.equal(normalizeTags(Array.from({ length: 12 }, (_, i) => `t${i}`).join(",")).length, 10);
  assert.equal(normalizeTags("x".repeat(50))[0].length, 40);
});

test("search matches title, body or a tag", () => {
  const s = { title: "Refund request", body_markdown: "Check the order", tags: ["support"] };
  assert.ok(matchesSkill(s, "refund"));
  assert.ok(matchesSkill(s, "ORDER"));
  assert.ok(matchesSkill(s, "supp"));
  assert.ok(matchesSkill(s, "  "));
  assert.ok(!matchesSkill(s, "billing"));
});
