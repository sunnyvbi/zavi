const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/channelPage.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Date, Math, Number, Set });
const p = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));
const m = (key, value, unit, prev = null) => ({ key, value, unit, grounded: true, prev_value: prev, day: "2026-10-01" });

test("values format like web", () => {
  assert.equal(p.formatMetricValue(m("spend", 1234, "usd")), "$1,234");
  assert.equal(p.formatMetricValue(m("cpa", 18.2, "usd")), "$18.20");
  assert.equal(p.formatMetricValue(m("ctr", 0.142, "pct")), "0.14%");
  assert.equal(p.formatMetricValue(m("ctr", 2.35, "pct")), "2.4%");
  assert.equal(p.formatMetricValue(m("roas", 2.3456, "ratio")), "2.35×");
  assert.equal(p.formatMetricValue(m("impressions", 24800, null)), "24.8K");
  assert.equal(p.formatMetricValue(m("x", NaN, null)), "-");
});

test("deltas: points for rates, dollars for cost per result, else percent", () => {
  assert.deepEqual(plain(p.metricDelta(m("spend", 118, "usd", 100))), { text: "+18%", direction: "up", good: true });
  assert.deepEqual(plain(p.metricDelta(m("cpa", 16, "usd", 18.2))), { text: "-$2.20", direction: "down", good: true });
  assert.deepEqual(plain(p.metricDelta(m("ctr", 2.1, "pct", 2.4))), { text: "-0.3pp", direction: "down", good: false });
  assert.equal(p.metricDelta(m("spend", 5, "usd", 5)), null);
  assert.equal(p.metricDelta(m("spend", 5, "usd")), null);
});

test("tiles use the channel's labels and lead order", () => {
  const t = p.metricTiles("meta_ads", [m("roas", 2, "ratio"), m("conversions", 9, null), m("spend", 100, "usd"), m("cpa", 11, "usd")]);
  assert.deepEqual(plain(t.map((x) => x.label)), ["Spend", "Cost per conversion", "Conversions", "ROAS"]);
  assert.equal(p.metricTiles("blog", [m("words_written", 3, null)])[0].label, "Words written");
});

test("runs and past items: three lists in web's words, nothing cut", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const runs = Array.from({ length: 7 }, (_, i) => ({
    run_id: `r${i}`, trigger: "manual", status: "success", enqueued_at: null, started_at: null,
    finished_at: "2026-10-02T10:00:00Z", redo_of_action_id: null, executor: "x_organic",
  }));
  const d = p.runDrawer(
    {
      runs: [...runs, { run_id: "f", trigger: "cron", status: "dispatch_error", enqueued_at: "2026-10-02T11:00:00Z", started_at: null, finished_at: null, redo_of_action_id: "a", executor: "growth-lead" }],
      closed: [{ id: "c1", title: "Raise budget", status: "displaced", status_at: "2026-10-02T11:00:00Z", note: "Five better actions", proposed_at: "2026-10-01T00:00:00Z" }],
      pre_switch: [{ run_id: null, title: null, position: 2, of: 5, archived_at: null, emitted_at: "2026-10-01T12:00:00Z" }],
    },
    (s) => (s === "x_organic" ? "X" : s),
    now,
  );
  assert.equal(d.total, 10);
  assert.equal(d.runs.length, 8);
  assert.deepEqual(plain(d.runs[0]), { id: "run:r0", title: "X", line: "Finished · you ran it · 2 hours ago", note: null, failed: false });
  assert.equal(d.runs[7].title, "growth-lead · redo");
  assert.equal(d.runs[7].line, "Failed to start · on schedule · 1 hour ago");
  assert.equal(d.runs[7].failed, true);
  assert.deepEqual(plain(d.closed[0]), { id: "closed:c1", title: "Raise budget", line: "Outranked · 1 hour ago", note: "Five better actions" });
  assert.equal(d.preSwitch[0].title, "Untitled item");
  assert.equal(d.preSwitch[0].line, "Step 2 of 5 · 1 day ago");
  assert.equal(
    d.preSwitchNote,
    "1 older item from before this channel moved store, kept read-only. They were priced against an account that has moved on, so they cannot be approved from here.",
  );
  assert.equal(p.runDrawer(null, (s) => s).total, 0);
});

test("status line, run label and cost", () => {
  assert.equal(p.statusLine({ working: true, waiting: 3 }).text, "Zavi is working on it");
  assert.equal(p.statusLine({ working: false, waiting: 1 }).text, "1 action needs you");
  assert.equal(p.statusLine({ working: false, waiting: 0 }).text, "Nothing waiting for you");
  assert.equal(p.runLabel({ name: "Meta Ads", runnable: true, starting: false, working: false, ranBefore: false }), "Run Meta Ads now");
  assert.equal(p.runLabel({ name: "Meta Ads", runnable: true, starting: false, working: false, ranBefore: true }), "Run it again");
  assert.equal(p.runLabel({ name: "Meta Ads", runnable: false, starting: false, working: false, ranBefore: false }), "Coming soon");
  assert.equal(p.runCost(340), "About 340 credits");
  assert.equal(p.runCost(undefined), "Uses credits from your plan");
});

test("empty line, plan and dismiss reasons match web", () => {
  assert.match(p.emptyLine({ workState: "delivered", lastRunFailed: false }), /^Zavi worked this channel/);
  assert.match(p.emptyLine({ workState: "idle", lastRunFailed: true }), /^The last run didn't finish/);
  assert.match(p.emptyLine({ workState: "idle", lastRunFailed: false }), /^Nothing yet/);
  assert.equal(p.planEditable({ status: "pending" }), true);
  assert.equal(p.planEditable({ status: "acted" }), false);
  assert.equal(p.planWritten("2026-10-02T12:00:00Z"), "Written Oct 2");
  assert.deepEqual(plain(p.dismissOptions(new Date("2026-10-02T00:00:00Z")).map((o) => o.action)), ["snoozed", "rejected", "rejected"]);
});

test("next steps: a card's kind reads off its type, grouped in rank order", () => {
  assert.equal(p.cardKindLabel("text_post"), "Post");
  assert.equal(p.cardKindLabel("video_post"), "Post");
  assert.equal(p.cardKindLabel("update_ad"), "Ad change");
  assert.equal(p.cardKindLabel(undefined), "To do");
  assert.equal(p.kindPlural("Reply"), "Replies");
  assert.equal(p.kindPlural("Ad"), "New ads");
  const buckets = p.kindBuckets([{ k: "Post" }, { k: "Reply" }, { k: "Post" }], (e) => e.k);
  assert.deepEqual(plain(buckets.map((b) => [b.kind, b.entries.length])), [["Post", 2], ["Reply", 1]]);
});

test("one card per kind shows; the rest wait behind Show N more", () => {
  const { shown, rest } = p.onePerKind([{ kind: "Brief", id: 1 }, { kind: "Book", id: 2 }, { kind: "Brief", id: 3 }]);
  assert.deepEqual(plain(shown.map((c) => c.id)), [1, 2]);
  assert.deepEqual(plain(rest.map((c) => c.id)), [3]);
});

test("card tag: the intent's word wins over the type's (web cardTag)", () => {
  assert.equal(p.cardTag("fix", "fix_setup"), "Fix setup");
  assert.equal(p.cardTag("text_post", "improve"), "Improve results");
  assert.equal(p.cardTag("setup", null), "Setup");
  assert.equal(p.cardTag(undefined, "unknown"), "To do");
});

test("card kind: a setup-fixing card groups as a Setup fix whatever its type", () => {
  assert.equal(p.cardKind("page", "fix_setup"), "Setup fix");
  assert.equal(p.kindPlural(p.cardKind("page", "fix_setup")), "Setup fixes");
  assert.equal(p.cardKind("page", "create"), "Page");
});

test("deliverable caption: the label, else the type's word, else What to use", () => {
  assert.equal(p.deliverableCaption("setup", null), "Details to enter");
  assert.equal(p.deliverableCaption("fix", "Paste this"), "Paste this");
  assert.equal(p.deliverableCaption("reply", null), "Your comment");
  assert.equal(p.deliverableCaption("other", null), "What to use");
});

test("exec line: Zavi's change status in web's words", () => {
  assert.equal(p.execLine("queued", "Meta Ads").text, "Zavi is working · waiting to start");
  assert.equal(p.execLine("dispatching", "Meta Ads").text, "Zavi is working · making the change");
  assert.equal(p.execLine("executed", "Meta Ads").text, "Zavi made this change in Meta Ads");
  assert.equal(p.execLine("failed", "Meta Ads", "reconnect Meta").fix, "This needs you: reconnect Meta.");
  assert.equal(p.execLine(null, "Meta Ads"), null);
});

test("section title and the Zavi setup notice", () => {
  assert.equal(p.nextStepsTitle("meta_ads"), "What Zavi wants to do");
  assert.equal(p.nextStepsTitle("x_organic"), "Next steps");
  assert.equal(p.zaviSetupNotice(0), null);
  assert.equal(
    p.zaviSetupNotice(2),
    "Zavi needs to complete 2 setup checks. Your next steps are listed below; no confirmation is needed for Zavi’s setup work.",
  );
});

test("dismiss: Remind me next week says the day it comes back", () => {
  assert.equal(p.dismissOptions(new Date("2026-10-06T12:00:00Z"))[0].label, "Remind me next week (back Oct 13)");
});

test("empty tiles name every number the channel declares and why each is blank (web emptyTiles)", () => {
  const connected = plain(p.emptyTiles("google_ads", true));
  assert.deepEqual(connected.map((t) => t.key), ["spend", "cpa", "pacing", "conversions", "conv_value", "roas"]);
  assert.equal(connected[0].label, "Spend");
  assert.ok(connected.every((t) => t.unmeasured === "Not measured yet"));
  assert.ok(plain(p.emptyTiles("google_ads", false)).every((t) => t.unmeasured === "Fills in once connected"));
  assert.deepEqual(plain(p.emptyTiles("blog", true)), []);
});

test("list card main button: the stored words first, never a verb the phone cannot do", () => {
  const card = (over) => ({ cardKind: "task", primaryLabel: "Show steps", executable: false, approveOnPhone: false, approveNeedsAdmin: false, emailCard: false, execStatus: null, ...over });
  assert.deepEqual(plain(p.cardMainButton(card({}))), { label: "Show steps", does: "open" });
  assert.equal(p.cardMainButton(card({ cardKind: null, primaryLabel: null })), null);
  assert.deepEqual(plain(p.cardMainButton(card({ cardKind: "executes", primaryLabel: "Open pull request", executable: true, approveOnPhone: true }), "member")), { label: "Open pull request", does: "open" });
  assert.deepEqual(plain(p.cardMainButton(card({ cardKind: "executes", primaryLabel: "Pause", executable: true }), "owner")), { label: "Approve on the web", does: "web_only" });
  assert.deepEqual(plain(p.cardMainButton(card({ cardKind: "executes", primaryLabel: "Send to 40 people", executable: true, emailCard: true }), "owner")), { label: "Review and send", does: "email" });
  assert.equal(p.cardMainButton(card({ cardKind: "executes", primaryLabel: "Open pull request", executable: true, approveOnPhone: true, execStatus: "executed" }), "owner"), null);
  assert.deepEqual(plain(p.cardMainButton(card({ cardKind: "executes", primaryLabel: "Approve", executable: true, approveOnPhone: true, execStatus: "failed" }), "owner")), { label: "Approve", does: "open" });
});

test("phone approval of ad changes: a member never sees Approve on a raise or launch", () => {
  const ad = (over) => ({ cardKind: "executes", primaryLabel: "Adjust budget", executable: true, approveOnPhone: true, approveNeedsAdmin: true, emailCard: false, execStatus: null, ...over });
  for (const role of ["member", "viewer", null]) assert.equal(p.mayApproveOnPhone(ad({}), role), false);
  assert.deepEqual(plain(p.cardMainButton(ad({}), "member")), { label: "Only an owner or admin can approve this", does: "web_only" });
  assert.deepEqual(plain(p.cardMainButton(ad({}), "viewer")), { label: "Viewers can't approve changes", does: "web_only" });
  assert.equal(p.cardMainButton(ad({}), null), null);
  for (const role of ["owner", "admin"]) {
    assert.deepEqual(plain(p.cardMainButton(ad({}), role)), { label: "Adjust budget", does: "open" });
    assert.equal(p.mayApproveOnPhone(ad({}), role), true);
  }
  assert.equal(p.mayApproveOnPhone(ad({ approveNeedsAdmin: false }), "member"), true);
  assert.equal(p.mayApproveOnPhone(ad({ approveNeedsAdmin: false }), "viewer"), false);
  assert.equal(p.mayApproveOnPhone(ad({ approveNeedsAdmin: false }), null), false);
  assert.deepEqual(plain(p.cardMainButton(ad({ approveNeedsAdmin: false, primaryLabel: "Pause" }), "member")), { label: "Pause", does: "open" });
});

test("the ad confirm lists every exact-change row, the dollars, the platform, and holds a raise", () => {
  const rows = [{ item: "Set A daily budget", before: "$20/day", after: "$40/day" }, { item: "Bid cap", before: "$2", after: "$3" }];
  const c = p.adApproveConfirm({ title: "Raise the Set A budget to $40 a day", channelName: "Meta Ads", primaryLabel: "Adjust budget", approveNeedsAdmin: true, approveMoney: { daily_usd: 20, monthly_usd: 608 }, changeRows: rows });
  assert.deepEqual(plain(c.rows), rows);
  assert.equal(c.money, "$20 a day, about $608 a month");
  assert.equal(c.platform, "Meta Ads");
  assert.equal(c.hold, true);
  assert.equal(c.confirmLabel, "Hold to adjust budget");
  assert.equal(p.HOLD_TO_CONFIRM_MS, 1000);
  const pause = p.adApproveConfirm({ title: "Pause Set A", channelName: "Meta Ads", primaryLabel: "Pause", approveNeedsAdmin: false, approveMoney: null, changeRows: [] });
  assert.equal(pause.hold, false);
  assert.equal(pause.money, null);
  assert.equal(pause.confirmLabel, "Pause");
  assert.equal(p.adApproveConfirm({ title: "t", channelName: "LinkedIn Ads", primaryLabel: null, approveMoney: { total_usd: 1500.5 }, changeRows: [] }).money, "$1,500.50 in total");
});

test("the note in place of a phone Approve says the true reason", () => {
  const ad = (over) => ({ approveOnPhone: true, approveNeedsAdmin: true, ...over });
  assert.equal(p.phoneApproveNote(ad({}), "member"), "Only an owner or admin can approve this");
  assert.equal(p.phoneApproveNote(ad({ approveNeedsAdmin: false }), "viewer"), "Viewers can't approve changes");
  assert.equal(p.phoneApproveNote(ad({}), "owner"), null);
  assert.equal(p.phoneApproveNote(ad({}), null), null);
  assert.equal(p.phoneApproveNote(ad({ approveNeedsAdmin: false }), "member"), null);
});

test("the detail page never invites an unknown role or a viewer to approve", () => {
  const card = (over) => ({ status: "pending", approveOnPhone: false, approveNeedsAdmin: true, ...over });
  assert.equal(p.detailExecNote(card({}), null), "Checking your role…");
  assert.equal(p.detailExecNote(card({ approveOnPhone: true }), null), "Checking your role…");
  assert.equal(p.detailExecNote(card({}), "viewer"), "Viewers can't approve changes.");
  assert.equal(p.detailExecNote(card({ approveOnPhone: true }), "member"), "Only an owner or admin can approve this.");
  assert.equal(p.detailExecNote(card({}), "owner"), "Approve this change on the web: Zavi makes it on your ad account.");
  assert.equal(p.detailExecNote(card({ status: "done" }), null), "Review this action’s current status on the web.");
});

test("second Grok pass: role first, an unknown admin flag fails closed, money never crashes", () => {
  const exec = (over) => ({ cardKind: "executes", primaryLabel: "Pause", executable: true, approveOnPhone: false, emailCard: false, execStatus: null, ...over });
  assert.equal(p.cardMainButton(exec({}), null), null);
  assert.deepEqual(plain(p.cardMainButton(exec({}), "viewer")), { label: "Viewers can't approve changes", does: "web_only" });
  assert.equal(p.phoneApproveNote({ approveOnPhone: false }, "viewer"), "Viewers can't approve changes");
  assert.equal(p.mayApproveOnPhone({ approveOnPhone: true, approveNeedsAdmin: null }, "member"), false);
  assert.equal(p.mayApproveOnPhone({ approveOnPhone: true, approveNeedsAdmin: null }, "owner"), true);
  assert.equal(p.adApproveConfirm({ title: "t", channelName: "Meta Ads", primaryLabel: "Pause", approveNeedsAdmin: null, approveMoney: null, changeRows: [] }).hold, true);
  assert.equal(p.adApproveConfirm({ title: "t", channelName: "Meta Ads", primaryLabel: "Pause", approveNeedsAdmin: false, approveMoney: { daily_usd: NaN, monthly_usd: 3 }, changeRows: [] }).money, "an unknown amount a day, about $3 a month");
});
