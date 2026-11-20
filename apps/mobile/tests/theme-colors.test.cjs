const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const SRC = path.join(__dirname, "../src");

const FIXED_FILES = new Set([
  "theme/tokens.ts",
  "components/connections/connectorLogos.generated.ts",
  "components/channels/ChannelGlyph.tsx",
  "components/MediaViewer.tsx",
  "components/VideoPoster.tsx",
  "app/(auth)/welcome.tsx",
]);

const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

function codeLines(source) {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n");
}

test("no colour literal outside theme/tokens.ts", () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    if (FIXED_FILES.has(rel)) continue;
    codeLines(fs.readFileSync(file, "utf8")).forEach((line, i) => {
      if (/theme-fixed/.test(line) || /shadowColor/.test(line)) return;
      const code = line.replace(/(^|[^:"'])\/\/.*$/, "$1");
      if (COLOR.test(code)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], "use a token from theme/tokens.ts, or mark a colour that must not change with `// theme-fixed: <why>`");
});

function loadTokens() {
  const source = fs.readFileSync(path.join(SRC, "theme/tokens.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const stubs = { "react-native": { Platform: { select: (o) => o.default } } };
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: (m) => stubs[m] });
  return mod.exports;
}

function flatten(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "string" ? [[prefix + k, v]] : flatten(v, `${prefix}${k}.`),
  );
}

const { palettes } = loadTokens();
const light = Object.fromEntries(flatten(palettes.light));
const dark = Object.fromEntries(flatten(palettes.dark));

test("light and dark palettes have the same keys", () => {
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
});

function luminance(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test("dark text colours read on the dark page and on raised surfaces", () => {
  const text = [
    "ink", "muted", "textSecondary", "green", "amber", "red", "blue", "danger",
    "wire.ink", "wire.text", "wire.body", "wire.sub", "wire.mute",
    "status.amberText", "status.greenText", "status.redText", "status.greenStrong", "status.redStrong", "status.redVivid",
    "form.soft", "form.error", "field.error", "run.stepText", "run.toolTag", "run.failed",
  ];
  const low = [];
  for (const key of text) {
    for (const ground of ["bg", "surfaceRaised"]) {
      const ratio = contrast(dark[key], dark[ground]);
      if (ratio < 4.5) low.push(`${key} on ${ground}: ${ratio.toFixed(2)}`);
    }
  }
  assert.deepEqual(low, []);
  assert.ok(contrast(dark.toastText, dark.toastBg) >= 4.5, "toast text on toast");
  assert.ok(contrast(dark.onInk, dark.ink) >= 4.5, "text on ink-filled buttons");
  for (const fill of ["greenFill", "amberFill", "redFill", "blueFill", "dangerFill"]) {
    assert.ok(contrast(dark.onAccent, dark[fill]) >= 4.5, `text on ${fill}`);
  }
});
