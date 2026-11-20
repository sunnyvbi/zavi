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

const G = load("../src/features/growth/plan.ts");
const plain = (v) => JSON.parse(JSON.stringify(v));
const NOW = new Date("2026-09-26T12:00:00Z");
const noLive = { values: new Map(), states: new Map() };

const goal = (over = {}) => ({
  id: "g1",
  objective: "Grow signups",
  target_metric: "weekly_widgets",
  target_value: 200,
  baseline_value: 100,
  current_value: 150,
  due_date: "2026-12-23",
  status: "active",
  priority: 50,
  measurement_mode: "manual_reported",
  ...over,
});

const ready = {
  pending: 0,
  activeGoals: 1,
  measurement: { kind: "none" },
  channels: [{ slug: "seo", name: "SEO", ranAt: "2026-09-20", running: false }],
  rivals: 2,
  brandVoiceSet: true,
};

test("normalizePlan: an empty body is an empty plan, not a crash", () => {
  const p = G.normalizePlan(undefined);
  assert.equal(p.plan, null);
  assert.deepEqual(plain(p.goals), { max_active: null, active_count: 0, over_cap: false, items: [] });
  assert.deepEqual(plain(p.channels), []);
  assert.equal(p.head_of_growth.autopilot, false);
  assert.equal(p.head_of_growth.note, null);
  assert.deepEqual(plain(p.goal_work), {});
  assert.deepEqual(plain(p.constraint_conflicts), []);
  assert.deepEqual(plain(p.unreadable), []);
});

test("normalizePlan keeps the server's fields and defaults the missing ones", () => {
  const p = G.normalizePlan({
    plan: { id: "p1", constraint_statement: "Few visitors" },
    goals: { items: [goal(), goal({ id: "g2", status: "paused" })] },
    head_of_growth: { autopilot: true },
    detail: { also_fix: "Pricing page", summary: 3 },
    unreadable: ["metrics"],
  });
  assert.deepEqual(plain(p.plan.basis_evidence), []);
  assert.equal(p.goals.active_count, 1, "counted from items when the server sends no count");
  assert.equal(p.head_of_growth.autopilot, true);
  assert.equal(p.detail.also_fix, "Pricing page");
  assert.deepEqual(plain(p.unreadable), ["metrics"]);
});

test("goalProgress runs baseline to target, clamps, and works for goals that go down", () => {
  assert.equal(G.goalProgress(goal()), 50);
  assert.equal(G.goalProgress(goal({ current_value: 400 })), 100);
  assert.equal(G.goalProgress(goal({ current_value: 10 })), 0);
  assert.equal(G.goalProgress(goal({ baseline_value: 80, target_value: 50, current_value: 65 })), 50);
  assert.equal(G.goalProgress(goal({ baseline_value: null })), null);
  assert.equal(G.goalProgress(goal({ current_value: null })), null);
  assert.equal(G.goalProgress(goal({ baseline_value: 200 })), null, "target equal to baseline has no bar");
});

test("liveReadOf reads the current-value body", () => {
  assert.deepEqual(plain(G.liveReadOf({ measured: true, value: 12 })), { state: "measured", value: 12 });
  assert.deepEqual(plain(G.liveReadOf({ measured: false })), { state: "unmeasured", value: null });
  assert.deepEqual(plain(G.liveReadOf(null)), { state: "failed", value: null });
  assert.deepEqual(plain(G.liveReadOf({ measured: true, value: "12" })), { state: "failed", value: null });
});

test("rankGoals: highest priority first, no priority last, ties keep order", () => {
  const ranked = G.rankGoals([
    goal({ id: "a", priority: null }),
    goal({ id: "b", priority: 10 }),
    goal({ id: "c", priority: 90 }),
    goal({ id: "d", priority: 10 }),
  ]);
  assert.deepEqual(ranked.map((g) => g.id), ["c", "b", "d", "a"]);
});

test("measurementNeed: manual, connect, other, and unknown", () => {
  assert.deepEqual(plain(G.measurementNeed([goal({ current_value: null })], noLive, [])), { kind: "manual", goalId: "g1" });
  const mrr = goal({ target_metric: "mrr", measurement_mode: "auto" });
  const unmeasured = { values: new Map(), states: new Map([["mrr", "unmeasured"]]) };
  assert.deepEqual(plain(G.measurementNeed([mrr], unmeasured, ["slack"])), { kind: "connect", slug: "stripe", name: "Stripe" });
  assert.deepEqual(plain(G.measurementNeed([mrr], unmeasured, ["composio.stripe"])), { kind: "other" });
  assert.equal(G.measurementNeed([mrr], unmeasured, undefined), "loading");
  assert.equal(G.measurementNeed([mrr], unmeasured, null), null);
  assert.equal(G.measurementNeed([mrr], noLive, []), "loading");
  assert.deepEqual(plain(G.measurementNeed([goal()], noLive, [])), { kind: "none" });
});

test("autonomyLine names who runs on their own", () => {
  assert.equal(G.autonomyLine([]), null);
  assert.equal(G.autonomyLine([{ name: "SEO", autorun: false }]), "Every channel asks you first.");
  assert.equal(G.autonomyLine([{ name: "SEO", autorun: true }]), "Every channel runs on its own.");
  assert.equal(
    G.autonomyLine([{ name: "SEO", autorun: true }, { name: "Email", autorun: false }]),
    "SEO runs on its own. The rest ask you first.",
  );
});

test("planChannels: plan order, Zavi picks only on a live plan, founder adds always", () => {
  const base = G.normalizePlan({
    plan: { id: "p1", pending_acceptance: false },
    bets: [
      { id: "b1", channel_slug: "google_ads", status: "accepted", sort_order: 2 },
      { id: "b2", channel_slug: "seo", status: "accepted", sort_order: 1 },
      { id: "b3", channel_slug: "tiktok", status: "rejected", sort_order: 0 },
    ],
    channels: [
      { slug: "google_ads", plan_selected: true, autorun: false },
      { slug: "zebra", plan_selected: true, plan_selected_set_by: "founder", autorun: true },
      { slug: "seo", plan_selected: true, autorun: false },
      { slug: "tiktok", plan_selected: true, autorun: false },
      { slug: "email", plan_selected: false, autorun: false },
    ],
  });
  const name = (s) => s;
  assert.deepEqual(G.planChannels(base, name).map((c) => c.slug), ["seo", "google_ads", "tiktok", "zebra"]);

  const draft = { ...base, plan: { ...base.plan, pending_acceptance: true } };
  assert.equal(G.hasLivePlan(draft), false);
  assert.deepEqual(G.planChannels(draft, name).map((c) => c.slug), ["zebra"]);

  assert.deepEqual(plain(G.planChannels({ ...base, unreadable: ["channels"] }, name)), []);
});

test("channelStatus: running, then a count, then the last run", () => {
  const ch = { slug: "seo", last_run_at: "2026-09-03T10:00:00Z", autorun: false, plan_selected: true };
  assert.equal(G.channelStatus(ch, { counts: {}, running: new Set(["seo"]) }, NOW), "Running now");
  assert.equal(G.channelStatus(ch, { counts: { seo: 2 }, running: new Set() }, NOW), "2 ready");
  assert.equal(G.channelStatus(ch, null, NOW), "Last ran Sep 3");
  assert.equal(G.channelStatus({ ...ch, last_run_at: null }, null, NOW), "Not run yet");
});

test("growthPending counts growth work only", () => {
  const slugs = new Set(["seo", "meta_ads"]);
  const body = {
    channel_pending_counts: { seo: 2, meta_ads: 0 },
    decisions: [
      { decision_class: "pm.spec", channel_slug: null },
      { decision_class: "meta_ads.budget_change", channel_slug: null },
      { decision_class: "channel.recipe_step", channel_slug: "seo" },
    ],
  };
  assert.deepEqual(plain(G.growthPending(body, slugs)), { total: 3, capped: false, toApprove: 2, inChannels: { seo: 1 } });
  const cut = { decisions: Array.from({ length: 100 }, () => ({ decision_class: "pm.spec" })) };
  assert.equal(G.growthPending(cut, slugs), null, "a capped list with no growth work is unknown, not zero");
});

test("splitCompetitors and connectedSources", () => {
  assert.deepEqual(plain(G.splitCompetitors(" Turo, getaround ,turo,, Hertz")), ["Turo", "getaround", "Hertz"]);
  assert.deepEqual(plain(G.splitCompetitors(undefined)), []);
  assert.deepEqual(
    plain(G.connectedSources([{ slug: "stripe" }, { slug: "whatsapp" }, { slug: "composio.telegram" }, { slug: "stripe" }, { slug: "slack" }])),
    ["stripe", "slack"],
  );
});
