const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/inlineLinks.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports });
const { splitLinks } = mod.exports;
const plain = (segs) => JSON.parse(JSON.stringify(segs));

test("a markdown link shows its label and keeps the text around it", () => {
  assert.deepEqual(
    plain(splitLinks("See [Open preview](https://preview.zaviagent.com/1Yoz) (anyone can open it)")),
    [
      { text: "See " },
      { text: "Open preview", href: "https://preview.zaviagent.com/1Yoz" },
      { text: " (anyone can open it)" },
    ],
  );
});

test("a bare URL is tappable and leaves sentence punctuation outside the link", () => {
  assert.deepEqual(plain(splitLinks("Go to https://zaviagent.com/x.")), [
    { text: "Go to " },
    { text: "https://zaviagent.com/x", href: "https://zaviagent.com/x" },
    { text: "." },
  ]);
});

test("a parenthesis inside the URL stays part of the link", () => {
  assert.deepEqual(plain(splitLinks("[a](https://x.com/y_(z)) and https://en.wikipedia.org/wiki/Foo_(bar).")), [
    { text: "a", href: "https://x.com/y_(z)" },
    { text: " and " },
    { text: "https://en.wikipedia.org/wiki/Foo_(bar)", href: "https://en.wikipedia.org/wiki/Foo_(bar)" },
    { text: "." },
  ]);
});

test("a URL wrapped in parentheses leaves the closing one outside", () => {
  assert.deepEqual(plain(splitLinks("(see https://zaviagent.com/x)")), [
    { text: "(see " },
    { text: "https://zaviagent.com/x", href: "https://zaviagent.com/x" },
    { text: ")" },
  ]);
});

test("a URL in backticks or bold leaves the wrapper outside the link", () => {
  assert.deepEqual(plain(splitLinks("`https://preview.zaviagent.com/1Yoz` **https://zaviagent.com/x**")), [
    { text: "`" },
    { text: "https://preview.zaviagent.com/1Yoz", href: "https://preview.zaviagent.com/1Yoz" },
    { text: "` **" },
    { text: "https://zaviagent.com/x", href: "https://zaviagent.com/x" },
    { text: "**" },
  ]);
});

test("image syntax stays as written", () => {
  const text = "![chart](https://zaviagent.com/c.png)";
  assert.deepEqual(plain(splitLinks(text)), [{ text }]);
});

test("non-http links stay as the literal text", () => {
  const text = "[tap](javascript:alert(1)) or [call](tel:5551234)";
  assert.deepEqual(plain(splitLinks(text)), [{ text }]);
});

test("text with no link comes back whole", () => {
  assert.deepEqual(plain(splitLinks("nothing here")), [{ text: "nothing here" }]);
});
