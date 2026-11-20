const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const src = (p) => path.join(__dirname, "../src", p);
const { appPhase, gatePhase, PHASE_ROUTE } = loadTs(src("features/creator/phase.ts"));
const { setupGateOf, staysDuringSetup, isSetupLocked } = loadTs(src("features/setup/state.ts"));

const PHASES = ["wait", "auth", "onboarding", "creator", "chat"];
const CONSENT = ["loading", "agreed", "needed", "declined"];
const SETUP = ["loading", "active", "inactive"];

test("auth, creator and wait pass straight through, whatever consent and setup say", () => {
  for (const phase of ["wait", "auth", "creator"]) {
    for (const consent of CONSENT) {
      for (const setup of SETUP) {
        assert.equal(gatePhase({ phase, consent, setup }), phase, `${phase}/${consent}/${setup}`);
      }
    }
  }
});

test("a founder with no answer on file gets the consent page first, with or without a workspace", () => {
  for (const phase of ["onboarding", "chat"]) {
    for (const setup of SETUP) {
      assert.equal(gatePhase({ phase, consent: "needed", setup }), "consent");
      assert.equal(gatePhase({ phase, consent: "loading", setup }), "wait");
    }
  }
});

test("after agreeing, a founder with no workspace goes to onboarding, exactly as before", () => {
  for (const setup of SETUP) {
    assert.equal(gatePhase({ phase: "onboarding", consent: "agreed", setup }), "onboarding");
  }
});

test("Not now with no workspace keeps the consent page: onboarding reads the site with AI", () => {
  for (const setup of SETUP) {
    assert.equal(gatePhase({ phase: "onboarding", consent: "declined", setup }), "consent");
  }
});

test("after agreeing, a founder with a workspace gets the setup while it runs, else the chat", () => {
  assert.equal(gatePhase({ phase: "chat", consent: "agreed", setup: "active" }), "setup");
  assert.equal(gatePhase({ phase: "chat", consent: "agreed", setup: "inactive" }), "chat");
  assert.equal(gatePhase({ phase: "chat", consent: "agreed", setup: "loading" }), "wait");
});

test("Not now with a workspace goes to the chat and never to the setup", () => {
  for (const setup of SETUP) {
    assert.equal(gatePhase({ phase: "chat", consent: "declined", setup }), "chat");
  }
});

test("every phase the gate can answer has a route, and the setup route is not onboarding's /setup", () => {
  for (const phase of PHASES) {
    for (const consent of CONSENT) {
      for (const setup of SETUP) {
        const out = gatePhase({ phase, consent, setup });
        if (out !== "wait") assert.equal(typeof PHASE_ROUTE[out], "string", out);
      }
    }
  }
  assert.notEqual(PHASE_ROUTE.setup, "/setup");
  assert.equal(PHASE_ROUTE.setup, "/growth-setup");
  assert.equal(PHASE_ROUTE.consent, "/consent");
});

test("appPhase itself is unchanged", () => {
  assert.equal(appPhase({ signedIn: false, onboarding: "done", creator: "loading" }), "auth");
  assert.equal(appPhase({ signedIn: true, onboarding: "done", creator: "loading" }), "chat");
  assert.equal(appPhase({ signedIn: true, onboarding: "needed", creator: "not_creator" }), "onboarding");
  assert.equal(appPhase({ signedIn: true, onboarding: "needed", creator: "creator" }), "creator");
});

const ON = (over = {}) => ({
  enabled: true,
  docs: { status: "pending", files: 0, facts: 0 },
  connectors: { status: "pending" },
  done: false,
  home_seen: false,
  draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: true },
  ...over,
});

test("the setup runs for owners and admins only, while it is on and not finished", () => {
  assert.equal(setupGateOf({ role: "owner", data: ON(), pending: false }), "active");
  assert.equal(setupGateOf({ role: "admin", data: ON(), pending: false }), "active");
  assert.equal(setupGateOf({ role: "member", data: ON(), pending: false }), "inactive");
  assert.equal(setupGateOf({ role: "viewer", data: ON(), pending: false }), "inactive");
  assert.equal(setupGateOf({ role: null, data: ON(), pending: false }), "inactive");
  assert.equal(setupGateOf({ role: "owner", data: ON({ done: true }), pending: false }), "inactive");
  assert.equal(setupGateOf({ role: "owner", data: { enabled: false }, pending: false }), "inactive");
});

test("the memberships not read yet is loading, never inactive (no chat flash for a returning owner)", () => {
  assert.equal(setupGateOf({ role: undefined, data: undefined, pending: false }), "loading");
  assert.equal(setupGateOf({ role: undefined, data: ON(), pending: false }), "loading");
});

test("a read on the wire holds the gate; a failed or offline read does not trap the founder", () => {
  assert.equal(setupGateOf({ role: "owner", data: undefined, pending: true }), "loading");
  assert.equal(setupGateOf({ role: "owner", data: undefined, pending: false }), "inactive");
  assert.equal(setupGateOf({ role: "member", data: undefined, pending: true }), "inactive");
  assert.equal(setupGateOf({ role: "owner", data: ON(), pending: true }), "active");
});

test("isSetupLocked matches the web rule", () => {
  assert.equal(isSetupLocked(ON(), "owner"), true);
  assert.equal(isSetupLocked(ON(), "member"), false);
  assert.equal(isSetupLocked(ON(), undefined), false);
  assert.equal(isSetupLocked(null, "owner"), false);
});

test("the lock keeps the setup itself, invite, reset-password, and the build only while it is open", () => {
  for (const seg of ["growth-setup", "invite", "reset-password"]) {
    assert.equal(staysDuringSetup(seg, false), true, seg);
  }
  assert.equal(staysDuringSetup("build", true), true);
  assert.equal(staysDuringSetup("build", false), false);
  for (const seg of ["chat", "growth", "settings", "channels", "consent", "(onboarding)", undefined]) {
    assert.equal(staysDuringSetup(seg, true), false, String(seg));
  }
});

const navWith = () => {
  const calls = [];
  const router = {
    canDismiss: () => false,
    dismissAll: () => calls.push("dismissAll"),
    replace: (href) => calls.push(`replace ${href}`),
    dismissTo: (href) => calls.push(`dismissTo ${href}`),
  };
  return { calls, nav: loadTs(src("lib/nav.ts"), { "expo-router": { router } }) };
};

test("a repeat reset to the same page is swallowed; alternating targets go through", () => {
  const { calls, nav } = navWith();
  nav.resetTo("/growth-setup");
  nav.resetTo("/growth-setup");
  assert.deepEqual(calls, ["replace /growth-setup"]);
  nav.resetTo("/chat");
  nav.resetTo("/growth-setup");
  assert.deepEqual(calls, ["replace /growth-setup", "replace /chat", "replace /growth-setup"]);
});

test("popping back to a gate page latches it like a reset", () => {
  const { calls, nav } = navWith();
  nav.resetTo("/chat");
  nav.popBackTo("/growth-setup");
  nav.resetTo("/growth-setup");
  nav.resetTo("/chat");
  assert.deepEqual(calls, ["replace /chat", "dismissTo /growth-setup", "replace /chat"]);
});
