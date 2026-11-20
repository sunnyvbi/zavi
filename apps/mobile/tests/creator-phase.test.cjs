const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(relative) {
  const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    compiled,
    {
      module,
      exports: module.exports,
      require() {
        throw new Error("phase.ts must stay dependency free");
      },
    },
    { filename: path.basename(relative) },
  );
  return module.exports;
}

const { appPhase, PHASE_ROUTE, CREATOR_TABS, isCreatorPath, activeCreatorTab, creatorLinkTarget } =
  load("src/features/creator/phase.ts");

const ALL_ONBOARDING = ["loading", "needed", "done"];
const ALL_PROBE = ["loading", "creator", "not_creator"];

test("signed out always goes to the auth screens, whatever else is known", () => {
  for (const onboarding of ALL_ONBOARDING) {
    for (const creator of ALL_PROBE) {
      assert.equal(appPhase({ signedIn: false, onboarding, creator }), "auth");
    }
  }
});

test("a creator with no workspace lands in creator mode", () => {
  assert.equal(appPhase({ signedIn: true, onboarding: "needed", creator: "creator" }), "creator");
});

test("a founder with no workspace still lands in onboarding, exactly as today", () => {
  assert.equal(
    appPhase({ signedIn: true, onboarding: "needed", creator: "not_creator" }),
    "onboarding",
  );
});

test("a founder with a workspace still lands in the chat, and the probe cannot change that", () => {
  for (const creator of ALL_PROBE) {
    assert.equal(appPhase({ signedIn: true, onboarding: "done", creator }), "chat");
  }
});

test("nobody is moved while something is still being read", () => {
  for (const creator of ALL_PROBE) {
    assert.equal(appPhase({ signedIn: true, onboarding: "loading", creator }), "wait");
  }
  assert.equal(appPhase({ signedIn: true, onboarding: "needed", creator: "loading" }), "wait");
});

test("every phase has a route and no two phases share one", () => {
  const phases = ["auth", "onboarding", "creator", "chat"];
  const routes = phases.map((p) => PHASE_ROUTE[p]);
  for (const r of routes) assert.equal(typeof r, "string");
  assert.equal(new Set(routes).size, phases.length);
  assert.equal(PHASE_ROUTE.creator, "/creator");
  assert.equal(PHASE_ROUTE.chat, "/chat");
  assert.equal(PHASE_ROUTE.onboarding, "/(onboarding)/website");
});

test("the five creator tabs are the five the spec names, in order", () => {
  assert.equal(
    CREATOR_TABS.map((t) => t.label).join(","),
    "Inbox,Briefs,Jobs,Earnings,Storefront",
  );
  assert.equal(
    CREATOR_TABS.map((t) => t.path).join(","),
    "/creator,/creator/briefs,/creator/jobs,/creator/earnings,/creator/storefront",
  );
});

test("creator paths are recognised and founder paths are not", () => {
  assert.equal(isCreatorPath("/creator"), true);
  assert.equal(isCreatorPath("/creator/jobs/abc"), true);
  assert.equal(isCreatorPath("/chat"), false);
  assert.equal(isCreatorPath("/creatorsomething"), false);
  assert.equal(isCreatorPath("/(onboarding)/website"), false);
});

test("a job screen highlights the Jobs tab, and an unknown path falls back to Inbox", () => {
  assert.equal(activeCreatorTab("/creator"), "/creator");
  assert.equal(activeCreatorTab("/creator/jobs"), "/creator/jobs");
  assert.equal(activeCreatorTab("/creator/jobs/abc-123"), "/creator/jobs");
  assert.equal(activeCreatorTab("/creator/earnings"), "/creator/earnings");
  assert.equal(activeCreatorTab("/creator/whatever"), "/creator");
});

test("an alert's link_path is only followed when this app has that screen", () => {
  assert.equal(creatorLinkTarget("/creator"), "/creator");
  assert.equal(creatorLinkTarget("/creator/earnings"), "/creator/earnings");
  assert.equal(creatorLinkTarget("/creator/jobs/abc-123"), "/creator/jobs/abc-123");
  assert.equal(creatorLinkTarget(null), null);
  assert.equal(creatorLinkTarget("/chat"), null);
  assert.equal(creatorLinkTarget("/workspace/settings"), null);
  assert.equal(creatorLinkTarget("/creator/library"), null);
  assert.equal(creatorLinkTarget("/creator/jobs/abc?x=1"), null);
  assert.equal(creatorLinkTarget("https://evil.example/creator"), null);
  assert.equal(creatorLinkTarget("/creator/jobs/../../chat"), null);
});
