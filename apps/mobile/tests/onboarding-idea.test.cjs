const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/onboarding/idea.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Math, Number, String });
const i = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

test("an idea needs 8 characters; four examples as on web", () => {
  assert.equal(i.ideaValid("  short "), false);
  assert.equal(i.ideaValid("A bakery site"), true);
  assert.deepEqual(plain(i.IDEA_EXAMPLES.map((e) => e.label)), ["Bakery website", "Dog grooming bookings", "Photography portfolio", "Yoga studio timetable"]);
});

test("reference images: type, size, count and total are checked, up to three", () => {
  const tiny = "AAAA";
  const r = i.addIdeaImage([], tiny, "image/jpeg");
  assert.equal(r.images[0], "data:image/jpeg;base64,AAAA");
  assert.equal(i.addIdeaImage([], tiny, "image/gif").error, i.IDEA_IMAGE_TYPE_ERROR);
  assert.equal(i.addIdeaImage(["a", "b", "c"], tiny, "image/png").error, i.IDEA_IMAGE_COUNT_ERROR);
  const big = "A".repeat(8 * 1024 * 1024);
  assert.equal(i.addIdeaImage([], big, "image/png").error, i.IDEA_IMAGE_SIZE_ERROR);
  const heldBig = ["x".repeat(3_999_990)];
  assert.equal(i.addIdeaImage(heldBig, "A".repeat(100), "image/png").error, i.IDEA_IMAGE_TOTAL_ERROR);
  assert.equal(i.isIdeaImageDataUrl("data:image/webp;base64,AAA"), true);
  assert.equal(i.isIdeaImageDataUrl("data:image/gif;base64,AAA"), false);
});

test("brainstorm: the landscape echo is compact; Use this idea needs substance", () => {
  const l = { competitors: [{ name: "A", angle: "x" }], market: "m", gap: "g", sources: [{ title: "t", url: "u" }], grounded: true };
  assert.deepEqual(Object.keys(plain(i.landscapeForRequest(l))).sort(), ["competitors", "gap", "market", "pricing", "v1", "wedge"].filter((k) => k in plain(i.landscapeForRequest(l))).sort());
  assert.equal(i.landscapeForRequest(null), undefined);
  assert.equal(i.hasLandscape(l), true);
  assert.equal(i.hasLandscape({}), false);
  assert.equal(i.canUseIdea({ userTurns: 0, done: false, landscape: null, messages: 1 }), false);
  assert.equal(i.canUseIdea({ userTurns: 2, done: false, landscape: null, messages: 4 }), true);
  assert.equal(i.canUseIdea({ userTurns: 0, done: false, landscape: l, messages: 1 }), true);
  assert.equal(i.canUseIdea({ userTurns: 0, done: true, landscape: null, messages: 1 }), true);
});
