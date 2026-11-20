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

const L = load("../src/features/connectors/logoSvg.ts");
const G = load("../src/components/connections/connectorLogos.generated.ts");

test("a transform on the outer svg falls back to the letter, inner transforms still draw", () => {
  assert.equal(L.drawableLogoSvg(`<svg viewBox="0 0 24 24" transform="matrix(1 0 0 1 0 0)"><path d="M0 0h24v24H0z"/></svg>`), null);
  assert.equal(L.drawableLogoSvg(`<svg viewBox="0 0 24 24" style="transform: translate(-50%,-50%)"><path d="M0 0h24v24H0z"/></svg>`), null);
  assert.ok(L.drawableLogoSvg(`<svg viewBox="0 0 24 24"><g transform="matrix(1 0 0 1 0 0)"><path d="M0 0h24v24H0z"/></g></svg>`));
});

test("the Composio logo that crashed release 1.6 is cleaned, not dropped", () => {
  const xml = `<svg viewBox="0 0 500 500"><path d="&#10;   M281.98,462.03 &#10;  C227.64,468.33 176.60,459.05 129.51,432.01 &#10;  z"/></svg>`;
  const out = L.drawableLogoSvg(xml);
  assert.ok(out);
  assert.ok(!out.includes("&#"));
});

test("whitespace references in every spelling are decoded", () => {
  for (const ref of ["&#10;", "&#9;", "&#13;", "&#32;", "&#xA;", "&#x0a;", "&#x9;", "&#x20;", "&#010;"]) {
    assert.ok(L.drawableLogoSvg(`<svg><path d="M0 0${ref}L1 1"/></svg>`), ref);
  }
});

test("paths the native reader would throw on fall back", () => {
  const bad = [
    "L1 1",
    "M1",
    "M1 2 z 3 4",
    "M1 2 X3 4",
    "M1 2 L&amp; 3",
    "M1 2 L. 3",
    "M1 2 L- 3",
    "M1 2 L1e+ 3",
    "M1 2 L1e39 3",
    "M0 0 A1 1 0 2 0 5 5",
    "M0 0 A1 1 0 1",
    "M1 2 NaN",
  ];
  for (const d of bad) {
    assert.equal(L.isDrawablePath(d), false, d);
    assert.equal(L.drawableLogoSvg(`<svg><path d="${d}"/></svg>`), null, d);
  }
});

test("valid path forms the native reader accepts stay drawable", () => {
  const good = [
    "M1 2L3 4z",
    "m1,2 3,4 5,6z",
    "M-1-2.5.5.5",
    "M0 0 A1 1 0 1 0 5 5",
    "M0 0a1 1 0 01 5 5",
    "M1e2 2E-1 H3 V4 C1 2 3 4 5 6 S1 2 3 4 Q1 2 3 4 T5 6 Z",
    "",
  ];
  for (const d of good) assert.equal(L.isDrawablePath(d), true, d);
});

test("polygon and polyline points are checked the way the library turns them into a path", () => {
  assert.ok(L.drawableLogoSvg(`<svg><polygon points="0,0 10,0 10,10"/></svg>`));
  assert.equal(L.drawableLogoSvg(`<svg><polyline points="0,0 10"/></svg>`), null);
  assert.equal(L.drawableLogoSvg(`<svg><polygon points="0,0 a,b"/></svg>`), null);
});

test("non-SVG responses (PNG, HTML error page, empty) fall back", () => {
  assert.equal(L.drawableLogoSvg(null), null);
  assert.equal(L.drawableLogoSvg(""), null);
  assert.equal(L.drawableLogoSvg("\u0089PNG\r\n"), null);
  assert.equal(L.drawableLogoSvg("<html><body>Not found</body></html>"), null);
});

test("every bundled connector logo stays drawable with only colors the library can read", () => {
  const all = Object.entries(G.CONNECTOR_LOGO_XML);
  assert.ok(all.length > 0);
  for (const [slug, xml] of all) {
    const out = L.drawableLogoSvg(xml);
    assert.ok(out, slug);
    assert.doesNotMatch(out, /var\(|rgb\([^)]*%/, slug);
  }
});

test("CSS variable and percent rgb colors are rewritten to plain colors", () => {
  assert.equal(
    L.drawableLogoSvg(`<svg><path fill="var(--fill-0, #2C3E5D)" d="M0 0"/></svg>`),
    `<svg><path fill="#2C3E5D" d="M0 0"/></svg>`,
  );
  assert.equal(
    L.drawableLogoSvg(`<svg><stop offset="0" stop-color="rgb(12.54902%,65.490196%,98.039216%)"/></svg>`),
    `<svg><stop offset="0" stop-color="rgb(32,167,250)"/></svg>`,
  );
});
