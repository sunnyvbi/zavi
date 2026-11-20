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

const { goDeeperPrompts } = load("../src/features/agents/goDeeper.ts");
const plain = (v) => JSON.parse(JSON.stringify([...v]));

const ask = (id, run, body = "Who are our main competitors?") => ({ id, sender_role: "user", body, agent_run_id: run });
const answer = (id, run) => ({ id, sender_role: "assistant", body: "Quick read.", agent_run_id: run });
const thread = [ask("u1", "run1"), answer("a1", "run1"), ask("u2", "run2", "And pricing?"), answer("a2", "run2")];
const noChips = () => false;

test("a light Research reply offers Go deeper with its own question", () => {
  const depths = new Map([
    ["run1", "light"],
    ["run2", "deep"],
  ]);
  assert.deepEqual(plain(goDeeperPrompts(thread, depths, "research", noChips)), [
    ["a1", "Who are our main competitors?"],
  ]);
});

test("a deep reply, or one with no depth, offers nothing", () => {
  assert.equal(goDeeperPrompts(thread, new Map([["run1", "deep"]]), "research", noChips).size, 0);
  assert.equal(goDeeperPrompts(thread, new Map(), "research", noChips).size, 0);
  assert.equal(goDeeperPrompts(thread, undefined, "research", noChips).size, 0);
});

test("only Research replies offer Go deeper", () => {
  const depths = new Map([["run1", "light"]]);
  assert.equal(goDeeperPrompts(thread, depths, "operator", noChips).size, 0);
  assert.equal(goDeeperPrompts(thread, depths, "engineer", noChips).size, 0);
});

test("no known question, no button", () => {
  const depths = new Map([["run1", "light"]]);
  assert.equal(goDeeperPrompts([answer("a1", "run1")], depths, "research", noChips).size, 0);
  assert.equal(goDeeperPrompts([ask("u1", "run1", "  "), answer("a1", "run1")], depths, "research", noChips).size, 0);
});

test("a reply with quick-reply chips offers no Go deeper", () => {
  const depths = new Map([["run1", "light"]]);
  assert.equal(goDeeperPrompts(thread, depths, "research", (m) => m.id === "a1").size, 0);
});

const { loadTs } = require("./helpers/load-ts.cjs");

const env = { canManage: false, openBilling: null };
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
};
const button = loadTs(path.join(__dirname, "../src/components/GoDeeperButton.tsx"), {
  react: React,
  "react-native": {
    ActivityIndicator: "ActivityIndicator",
    Pressable: "Pressable",
    StyleSheet: { create: (s) => s },
    Text: "Text",
    View: "View",
  },
  "./UnderlinedText": { UnderlinedText: "UnderlinedText" },
  "../features/agents/billingLink": { useOpenBillingScreen: () => env.openBilling },
  "../features/settings/api": { useCanManage: () => env.canManage },
  "../theme/tokens": { font: { family: {}, size: {} }, radius: { sm: 8 }, space: {} },
  "../theme/theme": { useStyles: () => ({}), useTheme: () => ({ colors: {} }) },
});
const creditWall = loadTs(path.join(__dirname, "../src/features/agents/creditWall.ts"));

function render(props) {
  return button.GoDeeperButton({ failure: null, busy: false, onPress: () => {}, ...props });
}
function find(node, pred, out = []) {
  if (node && typeof node === "object") {
    if (pred(node)) out.push(node);
    for (const c of node.children ?? []) find(c, pred, out);
  }
  return out;
}
const text = (node) =>
  typeof node === "string" ? node : node && typeof node === "object" ? (node.children ?? []).map(text).join("") : "";
const chipOf = (tree) => find(tree, (n) => n.type === "Pressable" && /Go deeper/.test(n.props.accessibilityLabel ?? ""))[0];

test("button: idle, it offers Go deeper and says what it costs", () => {
  const tree = render({});
  const chip = chipOf(tree);
  assert.equal(chip.props.disabled, false);
  assert.equal(chip.props.accessibilityRole, "button");
  assert.equal(text(chip), "Quick answer · Go deeper");
  assert.match(text(tree), /This came from the fast model\. Going deeper takes longer and costs more credits\./);
  assert.equal(find(tree, (n) => n.type === "ActivityIndicator").length, 0);
});

test("button: a tap reaches the screen's handler, once per tap", () => {
  let taps = 0;
  const chip = chipOf(render({ onPress: () => taps++ }));
  chip.props.onPress();
  assert.equal(taps, 1);
});

test("button: while a deeper send is running the chip is disabled, so a second tap cannot start another", () => {
  const tree = render({ busy: true });
  const chip = chipOf(tree);
  assert.equal(chip.props.disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(chip.props.accessibilityState)), { disabled: true, busy: true });
  assert.equal(text(chip), "Quick answer · Going deeper…");
  assert.equal(find(tree, (n) => n.type === "ActivityIndicator").length, 1);
  assert.equal(chipOf(render({ busy: false, failure: new Error("Boom") })).props.disabled, false);
});

test("button: a failed try says why under the chip", () => {
  const alerts = (tree) => find(tree, (n) => n.props?.accessibilityRole === "alert").map(text);
  assert.deepEqual(alerts(render({ failure: new Error("Boom") })), ["Boom"]);
  assert.deepEqual(alerts(render({ failure: Object.assign(new Error("db down"), { status: 502 }) })), [
    "We couldn't reach Zavi right now. Please try again in a moment.",
  ]);
  assert.deepEqual(alerts(render({ failure: null })), []);
});

test("button: out of credits reads like the credit wall, with Buy credits only for someone who can", () => {
  const failure = Object.assign(new Error("Out of credits."), { status: 402, code: "insufficient_credits" });
  const wall = creditWall.creditWallFromError(failure);
  const alertsAndActions = (tree) => ({
    alert: find(tree, (n) => n.props?.accessibilityRole === "alert").map(text),
    action: find(tree, (n) => n.type === "UnderlinedText").map(text),
  });

  env.canManage = true;
  env.openBilling = () => {};
  const owner = creditWall.creditWallView(wall, { canManageBilling: true });
  assert.deepEqual(alertsAndActions(render({ failure })), { alert: [owner.text], action: [owner.action] });

  env.canManage = false;
  const member = creditWall.creditWallView(wall, { canManageBilling: false });
  assert.deepEqual(alertsAndActions(render({ failure })), { alert: [member.text], action: member.action ? [member.action] : [] });

  env.canManage = true;
  env.openBilling = null;
  assert.deepEqual(alertsAndActions(render({ failure })), { alert: [owner.text], action: [] });
});
