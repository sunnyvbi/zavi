const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/xChecklist.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Array, Object, RegExp });
const x = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

const payload = {
  checklist: {
    passed: 2,
    total: 5,
    signals: [
      { key: "bio", label: "Bio names the product", status: "pass", note: "Bio mentions Upcar." },
      { key: "cadence", label: "Posting cadence ≥ 3 / week", status: "fix", note: "1 post in the last 7 days" },
      { key: "banner", label: "Header image", status: "fix", note: "No header image", link: "https://x.com/settings/profile" },
      { key: "pinned", label: "Pinned post", status: "unknown", note: "Could not read pinned post" },
      { key: "avatar", label: "Profile photo", status: "pass", note: "Has a photo." },
    ],
  },
};

test("failing first, then no data, then passing; stable inside each group", () => {
  const out = plain(x.xChecklist(payload));
  assert.deepEqual(out.rows.map((r) => r.key), ["cadence", "banner", "pinned", "bio", "avatar"]);
  assert.deepEqual(out.rows.map((r) => r.statusLabel), ["To do", "To do", "No data yet", "Passing", "Passing"]);
  assert.equal(out.caption, "2 of 5 checks passing.");
});

test("a threshold label reads as the job; a rule keeps its own", () => {
  const out = plain(x.xChecklist(payload));
  assert.equal(out.rows[0].label, "Post at least 3 times a week");
  assert.equal(out.rows[1].label, "Header image");
});

test("the fix is Fix on X where X has a place to do it, else Fix with Zavi", () => {
  const [cadence, banner, pinned] = plain(x.xChecklist(payload)).rows;
  assert.equal(banner.fix.kind, "link");
  assert.equal(banner.fix.label, "Fix on X");
  assert.equal(cadence.fix.kind, "chat");
  assert.equal(cadence.fix.label, "Fix with Zavi");
  assert.equal(cadence.fix.draft, "Help me fix this on my X profile: Post at least 3 times a week. Right now: 1 post in the last 7 days. Tell me exactly what to do, and draft it for me.");
  assert.equal(pinned.fix, null);
});

test("a non-https link is never opened", () => {
  const out = plain(x.xChecklist({ checklist: { signals: [{ key: "a", label: "A", status: "fix", note: "n", link: "javascript:alert(1)" }] } }));
  assert.equal(out.rows[0].fix.kind, "chat");
  assert.equal(out.caption, null);
});

test("no checklist in the payload is no card; an empty one says so", () => {
  assert.equal(x.xChecklist({ top_posts: [] }), null);
  assert.equal(x.xChecklist(null), null);
  const empty = plain(x.xChecklist({ checklist: { signals: [] } }));
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.empty, "Zavi has not checked this profile yet.");
});
