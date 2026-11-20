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

const { creditWallFromError, creditWallView, BILLING_URL } = load(
  "../src/features/agents/creditWall.ts",
);
const { isTerminal, isInFlight, isSettled } = load("../src/lib/status.ts");
const plain = (v) => JSON.parse(JSON.stringify(v));
const err = (status, code, message) => ({ status, code, message });

const owner = { canManageBilling: true };
const member = { canManageBilling: false };

test("402 insufficient_credits raises the credits wall with the server's sentence", () => {
  assert.deepEqual(plain(creditWallFromError(err(402, "insufficient_credits", "You're out of credits."))), {
    kind: "credits",
    message: "You're out of credits.",
  });
});

test("403 plan_upgrade_required raises the plan wall", () => {
  assert.equal(creditWallFromError(err(403, "plan_upgrade_required", "Needs Pro.")).kind, "plan");
});

test("429 channel_budget_exhausted raises the budget wall", () => {
  assert.equal(creditWallFromError(err(429, "channel_budget_exhausted", "Cap hit.")).kind, "budget");
});

test("anything else is not a credit wall", () => {
  assert.equal(creditWallFromError(err(500, "rpc_failed", "boom")), null);
  assert.equal(creditWallFromError(err(429, "extension_daily_cap", "later")), null);
  assert.equal(creditWallFromError(err(403, "insufficient_credits", "x")), null);
  assert.equal(creditWallFromError(new Error("network")), null);
  assert.equal(creditWallFromError(null), null);
});

test("an empty server message falls back to a real sentence", () => {
  assert.match(creditWallFromError(err(402, "insufficient_credits", "")).message, /out of credits/);
});

test("owner/admin get Buy credits on 402 and See plans on 403", () => {
  const credits = creditWallFromError(err(402, "insufficient_credits", "Out."));
  const plan = creditWallFromError(err(403, "plan_upgrade_required", "Upgrade."));
  assert.deepEqual(plain(creditWallView(credits, owner)), { text: "Out.", action: "Buy credits" });
  assert.deepEqual(plain(creditWallView(plan, owner)), { text: "Upgrade.", action: "See plans" });
});

test("a member gets a pointer to the owner and no button", () => {
  const credits = creditWallFromError(err(402, "insufficient_credits", "Out."));
  const plan = creditWallFromError(err(403, "plan_upgrade_required", "Upgrade."));
  assert.deepEqual(plain(creditWallView(credits, member)), {
    text: "Out. Ask your workspace owner to add credits.",
    action: null,
  });
  assert.deepEqual(plain(creditWallView(plan, member)), {
    text: "Upgrade. Ask your workspace owner to upgrade the plan.",
    action: null,
  });
});

test("a channel budget cap never offers a button", () => {
  const budget = creditWallFromError(err(429, "channel_budget_exhausted", "Cap hit."));
  assert.deepEqual(plain(creditWallView(budget, owner)), { text: "Cap hit.", action: null });
  assert.deepEqual(plain(creditWallView(budget, member)), { text: "Cap hit.", action: null });
});

test("billing links go to web pricing", () => {
  assert.equal(BILLING_URL, "https://www.zaviagent.com/pricing");
});

test("no em dashes in anything the wall can say", () => {
  const walls = [
    creditWallFromError(err(402, "insufficient_credits", "")),
    creditWallFromError(err(403, "plan_upgrade_required", "")),
    creditWallFromError(err(429, "channel_budget_exhausted", "")),
  ];
  for (const w of walls) {
    for (const who of [owner, member]) {
      const v = creditWallView(w, who);
      assert.ok(!v.text.includes("—") && !(v.action ?? "").includes("—"));
    }
  }
});

test("a stopped or failed run is terminal, so polling ends", () => {
  for (const s of ["success", "parse_failed", "dispatch_error", "failed", "cancelled"]) {
    assert.equal(isTerminal(s), true, s);
  }
  for (const s of ["queued", "running", null, undefined, ""]) {
    assert.equal(isTerminal(s), false, String(s));
  }
  assert.equal(isInFlight("cancelled"), false);
});

test("settled: an approval pause frees the composer", () => {
  assert.equal(isSettled({ status: "paused_awaiting_approval" }), true);
  assert.equal(isSettled({ status: "running" }), false);
  assert.equal(isSettled({ status: "queued" }), false);
  assert.equal(isSettled({ status: "cancelled" }), true);
  assert.equal(isSettled({ status: "failed" }), true);
  assert.equal(isSettled(null), false);
});
