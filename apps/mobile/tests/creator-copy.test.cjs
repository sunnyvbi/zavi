const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const MOBILE = path.join(__dirname, "..");
const APP = path.join(MOBILE, "src/app");

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

const CREATOR_SOURCE = [
  ...filesUnder(path.join(MOBILE, "src/features/creator")),
  ...filesUnder(path.join(MOBILE, "src/components/creator")),
  ...filesUnder(path.join(APP, "creator")),
];

const ROUTING_SOURCE = [...CREATOR_SOURCE, path.join(APP, "index.tsx"), path.join(APP, "_layout.tsx")];

const rel = (f) => path.relative(MOBILE, f);

function code(file) {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*");
    })
    .join("\n");
}

test("the scan has creator files to check", () => {
  assert.ok(CREATOR_SOURCE.length >= 12, `only found ${CREATOR_SOURCE.length} files`);
});

for (const file of CREATOR_SOURCE) {
  test(`${rel(file)} has no em dash, en dash or double hyphen`, () => {
    const offenders = [];
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/—|–/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
        if (/--/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
      });
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  test(`${rel(file)} computes no fee of its own`, () => {
    const src = code(file);
    const banned = [/\*\s*0?\.15\b/, /\*\s*0?\.85\b/, /\*\s*0?\.10?\b(?!0)/, /\bBPS\b/, /\/\s*10000\b/];
    const hits = banned.filter((re) => re.test(src)).map(String);
    assert.deepEqual(hits, [], `${rel(file)} looks like it computes a fee: ${hits.join(", ")}`);
  });

  test(`${rel(file)} computes no deadline of its own`, () => {
    const src = code(file);
    const banned = [
      /Date\.now\(\)\s*\+/,
      /getTime\(\)\s*\+/,
      /setDate\(/,
      /setHours\(/,
      /\*\s*60\s*\*\s*60/,
      /\b(?:72|86400000|3600000)\s*\*/,
      /72\s*h(?:ours?|rs?)\b/i,
      /\bauto[\s-]?accept/i,
      /10[\s-]?day buffer/i,
    ];
    const hits = banned.filter((re) => re.test(src)).map(String);
    assert.deepEqual(
      hits,
      [],
      `${rel(file)} looks like it words or computes a deadline: ${hits.join(", ")}. ` +
        "Render deadline.line from the backend instead.",
    );
  });
}

test("the only thing rendered for a deadline is the backend's own sentence", () => {
  for (const file of CREATOR_SOURCE) {
    const src = fs.readFileSync(file, "utf8");
    if (!/deadline/i.test(src)) continue;
    if (/features\/creator\/api\.ts$/.test(file)) continue;
    if (/tests\//.test(file)) continue;
    const rendersParts = /deadline\.(deadline_text|consequence_text|deadline_at|kind)/.test(
      code(file),
    );
    assert.equal(rendersParts, false, `${rel(file)} rebuilds a deadline from its parts`);
  }
});

test("money() formats exactly as the web's money() does", () => {
  const compiled = ts.transpileModule(
    fs.readFileSync(path.join(MOBILE, "src/features/creator/api.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    compiled,
    { module, exports: module.exports, require: () => ({ apiJson: null, ApiFetchError: Error }) },
    { filename: "api.js" },
  );
  const { money, statusWords } = module.exports;
  assert.equal(money(0), "$0");
  assert.equal(money(15000), "$150");
  assert.equal(money(12750), "$127.50");
  assert.equal(money(99), "$0.99");
  assert.equal(money(100000000), "$1,000,000");
  assert.equal(money(-12750), "-$127.50");
  assert.equal(money(1050), "$10.50");
  assert.equal(money(100000), "$1,000");
  assert.equal(money(15000), money(15000));
  assert.equal(statusWords("awaiting_acceptance"), "Waiting on you");
  assert.equal(statusWords("something_new"), "something new");
});

test("every creator route string the app navigates to is a real screen", () => {
  const screens = new Set();
  for (const file of filesUnder(path.join(APP, "creator"))) {
    const r = path
      .relative(APP, file)
      .replace(/\.tsx?$/, "")
      .replace(/\/index$/, "");
    screens.add(`/${r}`);
  }
  assert.ok(screens.has("/creator"), "the creator inbox screen must exist");

  const dynamic = [...screens].filter((s) => s.includes("["));
  const fixed = new Set([...screens].filter((s) => !s.includes("[")));

  const offenders = [];
  for (const file of ROUTING_SOURCE) {
    const src = code(file);
    for (const m of src.matchAll(/["'`](\/creator[^"'`\s]*)["'`]/g)) {
      const route = m[1];
      if (route.endsWith("/")) continue;
      if (fixed.has(route)) continue;
      const templated = route.replace(/\$\{[^}]*\}/g, "X");
      const matchesDynamic = dynamic.some((d) => {
        const re = new RegExp(`^${d.replace(/\[[^\]]+\]/g, "X")}$`);
        return re.test(templated);
      });
      if (!matchesDynamic) offenders.push(`${rel(file)}: ${route}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these route strings have no screen:\n${offenders.join("\n")}`,
  );
});

test("the root stack registers every creator screen on disk", () => {
  const layout = fs.readFileSync(path.join(APP, "_layout.tsx"), "utf8");
  for (const file of filesUnder(path.join(APP, "creator"))) {
    const name = path.relative(APP, file).replace(/\.tsx?$/, "");
    assert.ok(
      layout.includes(`name="${name}"`),
      `${name} exists but is not registered in the root Stack`,
    );
  }
});

test("the app never reaches a creator route through the tenant-scoped API", () => {
  const forbidden = [/features\/workspaces/, /useActiveTenant/, /tenants\/switch/];
  for (const file of CREATOR_SOURCE) {
    const src = fs.readFileSync(file, "utf8");
    for (const re of forbidden) {
      assert.equal(re.test(src), false, `${rel(file)} pulls in tenant-scoped code: ${re}`);
    }
  }
});

test("the creator area never streams a video through Zavi's backend", () => {
  const upload = fs.readFileSync(path.join(MOBILE, "src/features/creator/upload.ts"), "utf8");
  assert.ok(/slot\.signed_url/.test(upload), "the PUT must target the signed storage URL");
  assert.ok(/httpMethod:\s*"PUT"/.test(upload), "storage takes a PUT");
  assert.equal(
    /apiFetch|\/api\/chat\/upload|multipart/i.test(upload),
    false,
    "no multipart upload to our own backend",
  );
  for (const file of filesUnder(path.join(APP, "creator"))) {
    const src = fs.readFileSync(file, "utf8");
    assert.equal(
      /FormData|upload-image/.test(src),
      false,
      `${rel(file)} must not post file bytes to the backend`,
    );
  }
});
