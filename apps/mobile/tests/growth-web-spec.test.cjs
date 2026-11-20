const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { loadTs } = require("./helpers/load-ts.cjs");
const shim = require("./helpers/vitest-shim.cjs");

const src = (rel) => path.join(__dirname, "../src", rel);
const plan = loadTs(src("features/growth/plan.ts"));
const story = loadTs(src("features/growth/story.ts"));
const steps = loadTs(src("features/growth/actionSteps.ts"));
const { CHANNELS } = require("../../../packages/shared/dist/index.js");
const REGISTRY = new Set(CHANNELS.map((c) => c.slug));

const goals = { ...plan, ...story };
const MAP = {
  "growthHeadline.test.ts": { "./growthHeadline": plan },
  "actionSteps.test.ts": { "./actionSteps": steps },
  "goalBar.test.ts": { "./GrowthGoals": goals },
  "goalCountLabel.test.ts": { "./GrowthGoals": goals },
  "goalTitle.test.ts": { "./GrowthGoals": goals, "./growthPresentation": goals },
  "growthReviewScope.test.ts": { "./growthReviewScope": { isGrowthDecision: (d) => plan.isGrowthDecision(d, REGISTRY) } },
};

const dir = path.join(__dirname, "web-spec");
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".test.ts.txt"))) {
  const map = MAP[file.replace(/\.txt$/, "")];
  if (!map) throw new Error(`web-spec/${file} has no module mapping in growth-web-spec.test.cjs`);
  const compiled = ts.transpileModule(fs.readFileSync(path.join(dir, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const req = (spec) => {
    if (spec === "vitest") return shim;
    if (map[spec]) return map[spec];
    throw new Error(`web-spec/${file}: no mapping for "${spec}"`);
  };
  shim.describe(`web spec ${file}`, () => {
    vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: req, Intl, Date, Math, JSON, Object, Array, Number, String, Set, Map });
  });
}
