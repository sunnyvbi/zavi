const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");
const { describe, it, expect } = require("./helpers/vitest-shim.cjs");

const src = (rel) => path.join(__dirname, "../src", rel);
const P = loadTs(src("features/growth/plan.ts"));
const S = loadTs(src("features/growth/story.ts"));
const N = loadTs(src("features/growth/needs.ts"));
const NOTE = loadTs(src("features/growth/note.ts"));
const K = loadTs(src("features/growth/knowledge.ts"));
const A = loadTs(src("features/growth/access.ts"));
const R = loadTs(src("lib/apiRetry.ts"));
const AP = loadTs(src("features/growth/autopilot.ts"));
const MV = loadTs(src("features/growth/moves.ts"));

const goal = {
  id: "goal-1",
  objective: "Activate more hosts",
  target_metric: "host_activation",
  target_value: 40,
  baseline_value: 20,
  current_value: 30,
  due_date: "2026-12-31",
  status: "active",
  priority: 1,
  source: "founder",
};
const move = (over = {}) => ({
  decision_id: "d1",
  agent: "reddit_organic",
  intent: "Post the launch story in r/smallbusiness",
  why: "Buyers ask for this there",
  aims_to_move: null,
  hypothesis_id: null,
  state: "waiting",
  run_id: null,
  emitted_at: "2026-09-26T10:00:00Z",
  ...over,
});

describe("payload readers", () => {
  it("keeps only well-formed moves and hypotheses", () => {
    const w = P.goalWorkOf({
      g1: {
        status_line: "On it",
        moves: [move(), { decision_id: "x", agent: "a", intent: "i", state: "weird" }, { agent: "a" }],
        hypotheses: [
          { id: "h1", claim: "c", status: "testing", evidence: [{ at: "2026-09-01", quote: " ", why: "w" }] },
          { id: "h2", claim: "c", status: "maybe" },
        ],
        hypotheses_unavailable: true,
      },
      g2: null,
    });
    expect(Object.keys(w)).toEqual(["g1"]);
    expect(w.g1.moves).toHaveLength(1);
    expect(w.g1.hypotheses.map((h) => h.id)).toEqual(["h1"]);
    expect(w.g1.hypotheses[0].evidence[0]).toEqual({ at: "2026-09-01", verdict: null, quote: null, why: "w" });
    expect(w.g1.hypotheses_unavailable).toBe(true);
    expect(P.goalWorkOf([])).toEqual({});
  });

  it("reads the note's sections and drops links that leave the site", () => {
    const hog = P.headOfGrowthOf({
      autopilot: true,
      note: {
        saw: ["a", 3],
        sections: [
          {
            key: "needs_you",
            title: "Needs you",
            rows: [
              { line: "Approve the ad", url: "/workspace?tab=channels&channel=meta_ads&action=a1" },
              { line: "Evil", url: "//evil.com" },
              { line: "Q", url: null, question_ordinal: 1 },
              { line: " " },
            ],
            more: { count: 3, url: "https://evil.com", line: "3 more" },
          },
          { key: "changed", title: "What I changed", rows: [{ line: "Paused X.", undo: { kind: "channel", channel_slug: "x_organic" } }] },
          { key: "bogus", title: "t", rows: [{ line: "l" }] },
          { key: "blocked", title: "Blocked", rows: [] },
        ],
      },
      undoable: [{ goal_id: "g1", why: "w", at: "2026-09-30", prev_objective: "Old" }, { why: "no id" }],
    });
    expect(hog.autopilot).toBe(true);
    expect(hog.note.saw).toEqual(["a"]);
    expect(hog.note.sections.map((s) => s.key)).toEqual(["needs_you", "changed"]);
    const rows = hog.note.sections[0].rows;
    expect(rows.map((r) => r.url)).toEqual(["/workspace?tab=channels&channel=meta_ads&action=a1", null, null]);
    expect(rows[2].question_ordinal).toBe(1);
    expect(hog.note.sections[0].more).toBeNull();
    expect(hog.note.sections[1].rows[0].undo).toEqual({ kind: "channel", channel_slug: "x_organic" });
    expect(hog.undoable).toHaveLength(1);
    expect(P.headOfGrowthOf(undefined)).toEqual({ autopilot: false, note: null, undoable: [] });
  });

  it("reads constraint conflicts tolerantly", () => {
    expect(P.constraintConflictsOf([{ goal_id: "g", hypothesis_id: "h", claim: "c" }, { goal_id: "g" }, null])).toEqual([
      { goal_id: "g", hypothesis_id: "h", claim: "c", kept_at: null },
    ]);
    expect(P.constraintConflictsOf("nope")).toEqual([]);
    expect(P.constraintConflictsOf([{ goal_id: "g", hypothesis_id: "h", claim: "c", kept_at: "2026-10-14T17:00:00Z" }])[0].kept_at).toBe("2026-10-14T17:00:00Z");
    expect(P.constraintConflictsOf([{ goal_id: "g", hypothesis_id: "h", claim: "c", kept_at: "garbage" }])[0].kept_at).toBeNull();
  });
});

describe("goal pills and the header line (web: GrowthStory.test)", () => {
  const NOW = Date.parse("2026-10-01T00:00:00Z");
  const measured = { kind: "none" };

  it("waits for the number, then says Not counted yet for a goal without one", () => {
    expect(S.goalPill(goal, P.LOADING, undefined, NOW)).toBe(P.LOADING);
    expect(S.goalPill({ ...goal, current_value: null }, { kind: "manual", goalId: "goal-1" }, undefined, NOW)).toEqual({ label: "Not counted yet", tone: "wait" });
  });

  it("says Met from the baseline, in either direction", () => {
    expect(S.goalPill({ ...goal, current_value: 40 }, measured, [], NOW)).toEqual({ label: "Met", tone: "good" });
    const down = { ...goal, baseline_value: 50, target_value: 20, current_value: 18 };
    expect(S.goalPill(down, measured, [], NOW)).toEqual({ label: "Met", tone: "good" });
  });

  it("paces from the goal's own history, and says nothing without one", () => {
    const points = [{ at: "2026-07-01T00:00:00Z", value: 20 }];
    expect(S.goalPill({ ...goal, current_value: 35 }, measured, points, NOW)).toEqual({ label: "On pace", tone: "good" });
    expect(S.goalPill({ ...goal, current_value: 21 }, measured, points, NOW)).toEqual({ label: "Behind", tone: "bad" });
    expect(S.goalPill(goal, measured, "loading", NOW)).toBe(P.LOADING);
    expect(S.goalPill(goal, measured, "failed", NOW)).toBeNull();
    expect(S.goalPill(goal, measured, [], NOW)).toBeNull();
    expect(S.goalPill({ ...goal, due_date: null }, measured, points, NOW)).toBeNull();
    expect(S.goalPill(goal, null, points, NOW)).toBeNull();
  });

  it("says Past due once the date has gone", () => {
    expect(S.goalPill({ ...goal, due_date: "2026-09-01" }, measured, [], NOW)).toEqual({ label: "Past due", tone: "quiet" });
  });

  it("builds the header line only from the pills", () => {
    const onPace = { label: "On pace", tone: "good" };
    const none = { label: "Not counted yet", tone: "wait" };
    expect(S.goalStatusLine([onPace, none, none])).toBe("1 goal on pace. 2 are not counted yet.");
    expect(S.goalStatusLine([none])).toBe("1 goal is not counted yet.");
    expect(S.goalStatusLine([onPace, onPace])).toBe("2 goals on pace.");
    expect(S.goalStatusLine([null])).toBeNull();
    expect(S.goalStatusLine([])).toBeNull();
  });
});

describe("history pace (web: GoalHistory.test goalPace)", () => {
  const NOW = Date.parse("2026-09-28T12:00:00Z");
  const g = { target_value: 3000, due_date: "2026-12-31" };
  const points = [
    { at: "2026-09-01T00:00:00Z", value: 1000 },
    { at: "2026-09-28T00:00:00Z", value: 1290 },
  ];
  it("compares today's number to the straight line to the target", () => {
    const p = S.historyPace(points, g, NOW, 1290);
    expect(Math.round(p.expected)).toBeGreaterThan(1400);
    expect(p.onPace).toBe(false);
    expect(p.daysLeft).toBe(95);
  });
  it("handles a goal where lower is better", () => {
    const p = S.historyPace(
      [
        { at: "2026-09-01T00:00:00Z", value: 10 },
        { at: "2026-09-28T00:00:00Z", value: 6 },
      ],
      { target_value: 5, due_date: "2026-10-31" },
      NOW,
      6,
    );
    expect(p.onPace).toBe(true);
  });
  it("is null without a target, a due date or a reading", () => {
    expect(S.historyPace(points, { target_value: null, due_date: "2026-12-31" }, NOW, 1)).toBeNull();
    expect(S.historyPace(points, { target_value: 1, due_date: null }, NOW, 1)).toBeNull();
    expect(S.historyPace([], g, NOW, 1)).toBeNull();
  });
  it("re-reads a goal only when its number, target or date changes", () => {
    expect(S.historyKey(goal)).toBe("goal-1:30:40:2026-12-31");
    expect(S.historyPointsOf({ points: [{ at: "a", value: 1 }] })).toHaveLength(1);
    expect(S.historyPointsOf(null)).toEqual([]);
  });
});

describe("goal rows", () => {
  const NOW = new Date("2026-09-28T12:00:00Z");
  const g = (over) => ({ ...goal, current_value: 612, measurement_mode: "manual_reported", ...over });

  it("says where the number came from (web: goalNumberSource.test)", () => {
    expect(S.goalNumberSource(g({ current_value_at: "2026-09-08T20:11:00Z" }), NOW)).toBe("entered 20 days ago by you");
    expect(S.goalNumberSource(g({ current_value_at: "2026-09-27T08:00:00Z" }), NOW)).toBe("entered 1 day ago by you");
    expect(S.goalNumberSource(g({ current_value_at: "2026-09-28T08:00:00Z" }), NOW)).toBe("entered today by you");
    expect(S.goalNumberSource(g({ current_value_at: null }), NOW)).toBe("entered by you");
    const counted = { counted_as: "hosts who ever listed a car, any listing status", current_value_at: "2026-09-28T13:30:00Z" };
    expect(S.goalNumberSource(g(counted), NOW)).toBe("counted daily: hosts who ever listed a car, any listing status");
    expect(S.goalNumberSource(g({ ...counted, count_failing: true }), NOW)).toBe(
      "counted daily: hosts who ever listed a car, any listing status (last count failed)",
    );
    expect(S.goalNumberSource(g({ measurement_mode: "auto" }), NOW)).toBeNull();
    expect(S.goalNumberSource(g({ current_value: null }), NOW)).toBeNull();
  });

  it("joins the source and the days left", () => {
    expect(S.goalMeta(g({ current_value_at: "2026-09-28T08:00:00Z", due_date: "2026-10-08" }), NOW.getTime())).toBe(
      "entered today by you · 11 days left",
    );
    expect(S.daysLeftLabel(g({ due_date: "2026-09-01" }), NOW.getTime())).toBeNull();
    expect(S.daysLeftLabel(g({ due_date: "2026-09-29" }), NOW.getTime())).toBe("2 days left");
  });

  it("offers Improve chips only from what the plan stores", () => {
    expect(S.goalSuggestions(null)).toEqual([]);
    expect(S.goalSuggestions({ north_star_metric: "mrr", constraint_lever_family: "activation" })).toEqual([
      "Improve monthly recurring revenue",
      "Improve activation",
    ]);
    expect(S.goalSuggestions({ north_star_metric: "gmv", constraint_lever_family: "gmv" })).toEqual(["Improve GMV"]);
    expect(S.goalSuggestions({ north_star_metric: "  ", constraint_lever_family: null })).toEqual([]);
  });

  it("finds cgo's suggested goal", () => {
    expect(S.suggestedGoal([goal, { ...goal, id: "s", status: "proposed", source: "agent_proposed" }]).id).toBe("s");
    expect(S.suggestedGoal([{ ...goal, status: "proposed", source: "founder" }])).toBeNull();
  });
});

describe("what's in the way", () => {
  const plan = { id: "plan-1", version: 3, constraint_statement: "renter demand is binding", constraint_lever_family: "demand" };
  const conflicts = [{ goal_id: "goal-1", hypothesis_id: "h2", claim: "Not enough renter demand is arriving" }];

  it("picks the best guess: testing, else listed, else confirmed", () => {
    expect(S.bestGuess([{ status: "confirmed" }, { status: "listed" }, { status: "testing", id: "t" }]).id).toBe("t");
    expect(S.bestGuess([{ status: "confirmed", id: "c" }, { status: "ruled_out" }]).id).toBe("c");
    expect(S.bestGuess([{ status: "ruled_out" }])).toBeNull();
    expect(S.ideasLine([{ status: "testing", research_running: true }, { status: "ruled_out" }])).toBe("1 idea, 1 with a check open · ruled out 1");
    expect(S.ideasLine([{ status: "testing" }, { status: "listed" }])).toBe("2 ideas, 0 with a check open");
  });

  it("flags the conflict until the server (or a save from this phone) says it was kept (web: GrowthStory.test)", () => {
    expect(S.conflictFor("goal-1", plan, conflicts, new Set())).toEqual(conflicts[0]);
    expect(S.keptConflictFor("goal-1", plan, conflicts, new Set())).toBeNull();
    expect(S.conflictFor("goal-1", plan, conflicts, new Set(["h2"]))).toBeNull();
    expect(S.keptConflictFor("goal-1", plan, conflicts, new Set(["h2"])).hypothesis_id).toBe("h2");
    const serverKept = [{ ...conflicts[0], kept_at: "2026-10-14T17:00:00Z" }];
    expect(S.conflictFor("goal-1", plan, serverKept, new Set())).toBeNull();
    expect(S.keptConflictFor("goal-1", plan, serverKept, new Set()).kept_at).toBe("2026-10-14T17:00:00Z");
    expect(S.keptDay("2026-10-14T17:00:00Z")).toBe("Oct 14");
    expect(S.conflictFor("goal-1", { ...plan, constraint_statement: " " }, conflicts, new Set())).toBeNull();
    expect(S.updatePlanMessage(plan.constraint_statement, conflicts[0], goal)).toBe(
      `Your plan's blocker is "renter demand is binding", but you ruled out "Not enough renter demand is arriving" for Activate more hosts. Update the plan's blocker to what the evidence shows.`,
    );
    expect(S.updatePlanMessage("Demand is binding.", conflicts[0], goal, { claim: "Hosts cancel." })).toBe(
      `Your plan's blocker is "Demand is binding", but you ruled out "Not enough renter demand is arriving" for Activate more hosts. Your best guess now is "Hosts cancel". Update the plan's blocker to what the evidence shows.`,
    );
    expect(S.updatePlanMessage("Is demand binding?", conflicts[0], goal)).toMatch(/"Is demand binding\?"/);
    expect(S.replacementGuess([{ id: "h2", status: "testing", claim: "Other" }], conflicts[0])).toBeNull();
    expect(S.replacementGuess([{ id: "h8", status: "testing", claim: "not enough renter demand is arriving." }], conflicts[0])).toBeNull();
    expect(S.replacementGuess([{ id: "h9", status: "listed", claim: "Hosts cancel" }], conflicts[0]).id).toBe("h9");
  });
});

describe("what happened (web: GoalWork.test, StoryHappened)", () => {
  it("folds an agent's repeated failures into one row with a count", () => {
    const moves = [
      move({ decision_id: "a", agent: "research", state: "failed" }),
      move({ decision_id: "b", agent: "meta_ads", state: "done" }),
      move({ decision_id: "c", agent: "research", state: "failed" }),
    ];
    expect(S.foldFailedRetries(moves).map((r) => [r.move.decision_id, r.tries])).toEqual([["a", 2], ["b", 1]]);
  });

  it("counts the last 7 days of moves once each, across goals", () => {
    const now = new Date("2026-09-28T00:00:00Z");
    const recent = "2026-09-26T00:00:00Z";
    const work = {
      g1: { status_line: null, status_at: null, moves: [move({ decision_id: "1", state: "done", emitted_at: recent }), move({ decision_id: "2", state: "waiting", emitted_at: recent })] },
      g2: { status_line: null, status_at: null, moves: [move({ decision_id: "1", state: "done", emitted_at: recent }), move({ decision_id: "3", state: "failed", emitted_at: "2026-09-01T00:00:00Z" })] },
    };
    expect(S.weekMomentum(work, now).map((m) => m.label)).toEqual(["1 done", "1 waiting for you"]);
    expect(S.weekMomentum(undefined, now)).toEqual([]);
  });

  it("lists moves once each, newest first, without the ones waiting for you", () => {
    const work = {
      g1: { moves: [move({ decision_id: "1", state: "done", emitted_at: "2026-09-20T00:00:00Z" }), move({ decision_id: "2" })] },
      g2: { moves: [move({ decision_id: "1", state: "done" }), move({ decision_id: "3", state: "running", emitted_at: "2026-09-27T00:00:00Z" })] },
    };
    expect(S.happenedMoves(work).map((r) => r.move.decision_id)).toEqual(["3", "1"]);
  });

  it("reads You asked, hiding an empty question", () => {
    expect(S.youAskedOf({ asked: { question: "Why?", at: "t", answer: "Because.\nPart 2" } })).toEqual({ question: "Why?", at: "t", answer: "Because.\nPart 2" });
    expect(S.youAskedOf({ asked: { question: " " } })).toBeNull();
    expect(S.youAskedOf({ asked: null })).toBeNull();
    expect(S.answerLines("Because.\n\n Part 2 ")).toEqual(["Because.", "Part 2"]);
  });
});

describe("what needs you: one model for the list and the count", () => {
  const base = {
    questions: { state: "ready", open: 1, listed: 1 },
    pending: { total: 3, capped: false, toApprove: 2, inChannels: {} },
    approvalsSettled: true,
    goalWorkUnreadable: false,
    hogUnreadable: false,
    left: 1,
    more: 2,
    waitingMoves: 1,
    countless: false,
  };

  it("counts every source once, and says how many are to approve and for you", () => {
    const n = N.needsModel(base);
    expect(n.state).toBe("ready");
    expect(n.total).toBe(8);
    expect(n.aside).toBe("8 waiting · 2 to approve · 1 for you");
    expect(n.footer).toBe("3 actions wait for your OK.");
    expect(n.reviewLabel).toBe("Review all 3");
    expect(n.showPill).toBe(true);
  });

  it("says N+ when the approvals count is a floor", () => {
    const n = N.needsModel({ ...base, pending: { total: 100, capped: true, toApprove: 100, inChannels: {} } });
    expect(n.count).toBe("105+");
    expect(n.footer).toBe("100+ actions wait for your OK.");
  });

  it("is loading, then failed, never nothing, while a source is unknown", () => {
    expect(N.needsModel({ ...base, approvalsSettled: false }).state).toBe("loading");
    expect(N.needsModel({ ...base, questions: { state: "loading", open: 0, listed: 0 } }).showPill).toBe(false);
    const failed = N.needsModel({ ...base, pending: null });
    expect(failed.state).toBe("failed");
    expect(failed.empty).toBe(false);
    expect(N.needsModel({ ...base, goalWorkUnreadable: true }).state).toBe("failed");
  });

  it("says nothing needs you only when every source is read and empty", () => {
    const n = N.needsModel({ ...base, questions: { state: "ready", open: 0, listed: 0 }, pending: { total: 0, capped: false, toApprove: 0, inChannels: {} }, left: 0, more: 0, waitingMoves: 0 });
    expect(n.empty).toBe(true);
    expect(n.aside).toBeNull();
  });

  it("first run (countless): no pill, and nothing runs until OK'd", () => {
    const n = N.needsModel({ ...base, countless: true });
    expect(n.showPill).toBe(false);
    expect(n.aside).toBe("Waiting for you");
    expect(n.footer).toBe("Nothing runs until you OK it.");
    expect(n.reviewLabel).toBe("Review");
  });

  it("left for you: section rows without questions, or an older note's need only when its questions are stored apart", () => {
    const plan = (note) => P.normalizePlan({ head_of_growth: { note } });
    const sectioned = N.leftForYou(
      plan({ sections: [{ key: "needs_you", title: "Needs you", rows: [{ line: "Do A", url: "/x" }, { line: "Q", question_ordinal: 1 }], more: { count: 2, url: "/m", line: "2 more" } }] }),
    );
    expect(sectioned).toEqual({ rows: [{ line: "Do A", url: "/x" }], label: "Needs you", more: { count: 2, url: "/m", line: "2 more" } });
    expect(N.leftForYou(plan({ need: ["Old"], questions: [] })).rows).toEqual([{ line: "Old", url: null }]);
    expect(N.leftForYou(plan({ need: ["Old"] })).rows).toEqual([]);
    expect(N.leftForYou(plan({ need: ["Old"] })).label).toBe("Left for you");
  });

  it("waiting moves, once each, with the idea they act on", () => {
    const plan = P.normalizePlan({
      goal_work: {
        g1: { moves: [move({ hypothesis_id: "h1" }), move({ decision_id: "d2", state: "done" })], hypotheses: [{ id: "h1", claim: "Few renters", status: "testing" }] },
        g2: { moves: [move({ hypothesis_id: "h1" })] },
      },
    });
    expect(N.waitingMoves(plan).map((w) => [w.move.decision_id, w.actsOn])).toEqual([["d1", "Few renters"]]);
  });

  it("reads the questions tolerantly", () => {
    const q = N.questionsOf({ can_answer: true, questions: [{ id: "q1", ordinal: 2, ask: "Pause X?", recommended: "no", why: "", yes_no: true }, { ask: "no id" }] });
    expect(q.canAnswer).toBe(true);
    expect(q.questions).toHaveLength(1);
    expect(N.questionText(q.questions[0])).toEqual({ ask: "2. Pause X?", recommend: " (I recommend: No)" });
    expect(N.questionsOf(null)).toEqual({ questions: [], canAnswer: false });
  });

  const ask = (over = {}) => N.questionsOf({ questions: [{ id: "q1", ask: "Is this true for your business: most hosts cancel?", yes_no: true, ...over }] }).questions[0];
  const solid = (q) => N.answerButtons(q).filter((b) => b.primary).map((b) => b.label);

  it("styles neither answer as the default on a fact check", () => {
    expect(ask().fact_check).toBe(false);
    expect(ask({ fact_check: true }).fact_check).toBe(true);
    expect(N.answerButtons(ask()).map((b) => b.label)).toEqual(["Yes", "No"]);
    expect(solid(ask())).toEqual(["Yes"]);
    expect(solid(ask({ fact_check: true }))).toEqual([]);
    expect(solid(ask({ recommended: "no" }))).toEqual(["No"]);
  });

  it("says what the answer did", () => {
    expect(N.answeredOf({ outcome: "answered", answer: "yes", applied: "Paused X." }, "yes")).toEqual({ label: "Answered: Yes", note: "Paused X." });
    expect(N.answeredOf({}, "no")).toEqual({ label: "Answered: No", note: null });
    expect(N.answeredOf({ outcome: "answered", answer: "no", note: "Nothing changed: that idea was already ruled out." }, "no")).toEqual({
      label: "Not applied: No",
      note: "Nothing changed: that idea was already ruled out.",
    });
    expect(N.answeredOf({ outcome: "closed" }, "yes")).toEqual({ label: "No longer open", note: "Nothing changed." });
    expect(N.answeredOf({ outcome: "already_answered", answer: "My words: later", via: "slack" }, "yes")).toEqual({
      label: 'Already answered: "later" via Slack',
      note: null,
    });
    expect(N.answeredOf({ outcome: "already_answered", answer: "not_now", via: "web" }, "yes")).toEqual({ label: "Already answered: Not now via the web", note: null });
  });
});

describe("the note", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const recent = "2026-09-28T00:00:00Z";
  const old = "2026-08-01T00:00:00Z";
  const hog = { autopilot: false, note: null, undoable: [{ goal_id: "g1", why: "", at: recent, prev_objective: "Grow signups" }] };
  const channels = [
    { slug: "x_organic", cgo_reason: "Idle", plan_selected: false, cgo_set_at: recent },
    { slug: "seo", cgo_reason: "Idle", plan_selected: false, cgo_set_at: old },
  ];

  it("says what a claim did (web: HeadOfGrowth.test claimOutcome)", () => {
    expect(NOTE.claimOutcome({ refund: { status: "refunded", credits: 1200 } })).toBe("Undone. We refunded 1,200 credits to your wallet.");
    expect(NOTE.claimOutcome({ refund: { status: "already_refunded", credits: 400 } })).toBe("Undone. The credits for that check-in were already refunded.");
    expect(NOTE.claimOutcome({ refund: { status: "nothing_charged", credits: 0 } })).toBe("Undone. That change didn't use any credits.");
    expect(NOTE.claimOutcome({ refund: { status: "failed", credits: 0 }, claim_sent: true })).toBe(
      "Undone. We'll refund the credits it used to your wallet within 1 business day.",
    );
    expect(NOTE.claimOutcome({ refund: { status: "no_run", credits: 0 }, claim_sent: false })).toMatch(/email support@zaviagent.com/);
    expect(NOTE.claimOutcome({ refund: { status: "refunded", credits: 300, forfeited: 100 } })).toBe(
      "Undone. We refunded 300 credits to your wallet. Credits from a daily or monthly allowance that has reset since don't come back.",
    );
    expect(NOTE.claimOutcome({ refund: { status: "expired", credits: 0, forfeited: 100 } })).toBe(
      "Undone. The credits it used came from a daily or monthly allowance that has reset since, so there is nothing to refund.",
    );
    expect(NOTE.claimOutcome({ refund: { status: "untracked", credits: 0 }, claim_sent: true })).toBe(
      "Undone. We're checking which credits it used and will refund what's owed within 1 business day.",
    );
    expect(NOTE.claimOutcome({ refund: { status: "untracked", credits: 0 }, claim_sent: false })).toMatch(/email support@zaviagent.com/);
    expect(NOTE.claimOutcome({ refund: { status: "refunded", credits: 70, untracked: 50 }, claim_sent: true })).toBe(
      "Undone. We refunded 70 credits to your wallet. We're checking the rest and will refund what's owed within 1 business day.",
    );
    expect(NOTE.claimOutcome({ refund: { status: "refunded", credits: 70, untracked: 50 }, claim_sent: false })).toMatch(/email support@zaviagent.com/);
    expect(NOTE.claimOutcome({ refund: { status: "already_claimed", credits: 0 } })).toBe(
      "Undone. That check-in's credits were already handled by an earlier claim.",
    );
  });

  it("offers an undo only inside the 30-day window", () => {
    expect(NOTE.undoLive({ kind: "goal", goal_id: "g1" }, hog, channels, now)).toEqual({ kind: "goal", goal_id: "g1" });
    expect(NOTE.undoLive({ kind: "goal", goal_id: "g9" }, hog, channels, now)).toBeNull();
    expect(NOTE.undoLive({ kind: "channel", channel_slug: "x_organic" }, hog, channels, now)).toEqual({ kind: "channel", channel_slug: "x_organic" });
    expect(NOTE.undoLive({ kind: "channel", channel_slug: "seo" }, hog, channels, now)).toBeNull();
  });

  it("matches an older note's change line to its claim by text, never on a tie", () => {
    const name = (s) => (s === "x_organic" ? "X" : s);
    expect(NOTE.claimForLine('Goal "Grow signups" now aims at 500.', hog, channels, name, now)).toEqual({ kind: "goal", goal_id: "g1" });
    expect(NOTE.claimForLine("Paused X. It was idle.", hog, channels, name, now)).toEqual({ kind: "channel", channel_slug: "x_organic" });
    const tie = { ...hog, undoable: [...hog.undoable, { goal_id: "g2", why: "", at: recent, prev_objective: "Grow signups" }] };
    expect(NOTE.claimForLine('Goal "Grow signups" now aims at 500.', tie, channels, name, now)).toBeNull();
  });

  it("names a claim, and says the server's own words only when it wrote them", () => {
    expect(NOTE.claimKey({ kind: "goal", goal_id: "g1" })).toBe("goal:g1");
    expect(NOTE.claimKey({ kind: "channel", channel_slug: "seo" })).toBe("channel:seo");
    expect(NOTE.claimError({ code: "outside_window", message: "That change is older than 30 days." })).toBe("That change is older than 30 days.");
    expect(NOTE.claimError({ code: "http_500", message: "Request failed (500)" })).toBe("Could not undo that. Try again.");
    expect(NOTE.claimError(new TypeError("Network request failed"))).toBe("Could not undo that. Try again.");
    expect(NOTE.claimError(null)).toBe("Could not undo that. Try again.");
    expect(NOTE.WRONG_CALL_LINE).toBe("Wrong call? Mark it “This was a mistake” within 30 days and we refund the credits it used.");
  });

  it("tracks a section row by its target, so the outcome stays on the row after the plan re-read", () => {
    const undo = { kind: "goal", goal_id: "g1" };
    const before = NOTE.rowKey(undo, "changed", 0);
    expect(NOTE.undoLive(undo, { undoable: [] }, [])).toBeNull();
    expect(NOTE.rowKey(undo, "changed", 0)).toBe(before);
    expect(before).toBe("goal:g1");
    expect(NOTE.rowKey({ kind: "channel", channel_slug: "seo" }, "changed", 2)).toBe("channel:seo");
    expect(NOTE.rowKey(undefined, "working_on", 3)).toBe("row:working_on:3");
  });

  it("drops question rows and empty sections", () => {
    const note = { sections: [{ key: "needs_you", title: "N", rows: [{ line: "Q", question_ordinal: 1 }], more: null }, { key: "changed", title: "C", rows: [{ line: "L" }], more: null }] };
    expect(NOTE.shownSections(note).map((s) => s.key)).toEqual(["changed"]);
    expect(NOTE.shownSections(null)).toEqual([]);
  });

  it("says when the next note or check-in comes, by the switch", () => {
    const at = "2026-10-04T15:00:00Z";
    expect(NOTE.nextLine({ autopilot: true, note: { next_review_at: at }, undoable: [] })).toMatch(/^Next check-in Oct \d$/);
    expect(NOTE.nextLine({ autopilot: false, note: { next_review_at: at }, undoable: [] })).toMatch(/^Next note Oct \d$/);
    expect(NOTE.nextLine({ autopilot: false, note: null, undoable: [] })).toBeNull();
    expect(NOTE.wouldChangeFooter(true)).toBe("Autopilot is on. I'll make these changes at my next check-in.");
  });

  it("opens a note link in the app: a channel or its action, else the web page", () => {
    expect(NOTE.noteLinkTarget("/workspace?tab=channels&channel=meta_ads&action=a1")).toEqual({ kind: "channel", slug: "meta_ads", action: "a1" });
    expect(NOTE.noteLinkTarget("/workspace?tab=channels&channel=seo")).toEqual({ kind: "channel", slug: "seo", action: null });
    expect(NOTE.noteLinkTarget("/workspace?tab=autopilot")).toEqual({ kind: "web", url: "https://www.zaviagent.com/workspace?tab=autopilot" });
  });
});

describe("what Zavi knows", () => {
  it("reads the never-say rule and the tone the way the web stores them", () => {
    expect(K.ruleToNeverSay("Never use these words or phrases: synergy, Synergy, leverage.")).toEqual(["synergy", "leverage"]);
    expect(K.ruleToNeverSay("Always be kind.")).toEqual([]);
    expect(K.neverSayToRule(["a", " b "])).toBe("Never use these words or phrases: a, b.");
    expect(K.tonePills({ base_tone: "default", warm: true, enthusiastic: false })).toEqual(["Warm"]);
    expect(K.tonePills({ base_tone: "direct", warm: false, enthusiastic: true })).toEqual(["Direct", "Enthusiastic"]);
    expect(K.voiceInUse({ brand_voice: "Plain.", updated_by: null })).toBe("drafted from your site · in use");
    expect(K.voiceInUse({ brand_voice: "Plain.", updated_by: "u" })).toBe("used by every agent");
    expect(K.voiceInUse({ brand_voice: " " })).toBeNull();
  });

  it("names the colours and where they came from", () => {
    const kit = K.brandKitOf({ brand_kit: { primary: "#1A73FF", accent: null, bg: "red", text: "#000000", source: "scrape", source_url: "https://www.upcar.ai/x" } });
    expect(K.kitSwatches(kit)).toEqual([{ label: "Main", hex: "#1A73FF" }, { label: "Text", hex: "#000000" }]);
    expect(K.kitCaption(kit)).toBe("Read from www.upcar.ai");
    expect(K.kitCaption({ ...kit, source: "manual" })).toBe("Set by hand");
    expect(K.kitCaption({ ...kit, source: "default" })).toBe("We could not read your site’s colours, so these are ours");
    expect(K.brandKitOf({})).toBeNull();
  });

  it("counts sources and suggests connectors the web way", () => {
    expect(K.sourcesLine(1, 0, 0)).toBe("1 source connected");
    expect(K.sourcesLine(3, 1, 2)).toBe("3 sources connected · 1 need reconnecting · 2 not syncing");
    expect(K.suggestedConnectors(["posthog", "google_analytics", "stripe"], ["composio.stripe"])).toEqual(["google_analytics", "posthog"]);
    expect(K.suggestedConnectors(["a", "b", "c", "d", "e", "f", "g"], [])).toHaveLength(6);
    expect(K.suggestionsLabel(false, false)).toBe("Nothing is measured yet. Connect a source to start");
    expect(K.suggestionsLabel(true, false)).toBe("Worth connecting");
    expect(K.connectorLabel("pipedream.google_search_console")).toBe("Search Console");
    expect(K.connectorLabel("shopify_admin")).toBe("Shopify admin");
  });

  it("names the company and its empty line", () => {
    expect(K.companyName(" ", "Upcar")).toBe("Upcar");
    expect(K.companyName(null, null)).toBe("your company");
    expect(K.noDescriptionLine(false)).toBe("No description yet.");
    expect(K.foundLabel(false, 3)).toBe("What Zavi found (3)");
    expect(K.hostOf("https://www.upcar.ai/about")).toBe("upcar.ai");
  });
});

describe("who may do what", () => {
  it("owners and admins edit; an unknown role is shown the controls and the server judges", () => {
    expect(A.growthAccess("owner")).toEqual({ canEdit: true, canAutopilot: true, canDecide: true, readOnly: false });
    expect(A.growthAccess("admin").canEdit).toBe(true);
    expect(A.growthAccess(null).canEdit).toBe(true);
  });
  it("a member reads and cannot flip Autopilot (decision D3); a viewer writes nothing", () => {
    expect(A.growthAccess("member")).toEqual({ canEdit: false, canAutopilot: false, canDecide: true, readOnly: false });
    expect(A.growthAccess("viewer")).toEqual({ canEdit: false, canAutopilot: false, canDecide: false, readOnly: true });
  });
});

describe("api retry rules (web lib/api.ts, channelRead.ts)", () => {
  it("retries a network failure on reads and keyed requests only", () => {
    expect(R.retriesNetwork("GET", false)).toBe(true);
    expect(R.retriesNetwork("post", false)).toBe(false);
    expect(R.retriesNetwork("POST", true)).toBe(true);
    expect(R.isTransientNetworkError(new TypeError("Network request failed"))).toBe(true);
    const abort = new Error("x");
    abort.name = "AbortError";
    expect(R.isTransientNetworkError(abort)).toBe(false);
  });

  it("tries three times on a network throw, returns any HTTP answer at once", async () => {
    let n = 0;
    const res = await R.fetchWithTransientRetry(async () => {
      n += 1;
      if (n < 3) throw new TypeError("Network request failed");
      return { status: 503 };
    }, async () => {});
    expect(n).toBe(3);
    expect(res.status).toBe(503);
    let m = 0;
    let threw = false;
    try {
      await R.fetchWithTransientRetry(async () => {
        m += 1;
        throw new Error("bug");
      }, async () => {});
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(m).toBe(1);
  });

  it("reads retry a 5xx, 408 or 429 twice at 500 ms then 1.5 s, never a 404", () => {
    expect(R.readRetry(0, { status: 503 })).toBe(true);
    expect(R.readRetry(1, { status: 429 })).toBe(true);
    expect(R.readRetry(2, { status: 500 })).toBe(false);
    expect(R.readRetry(0, { status: 404 })).toBe(false);
    expect(R.readRetry(0, { status: 403 })).toBe(false);
    expect(R.readRetryDelay(0)).toBe(500);
    expect(R.readRetryDelay(1)).toBe(1500);
  });

  it("mints a fresh key per call", () => {
    const a = R.newIdempotencyKey();
    expect(a.length).toBeGreaterThan(16);
    expect(R.newIdempotencyKey()).not.toBe(a);
  });
});

describe("step 5 questions fold after the first two", () => {
  const qs = ["a", "b", "c", "d", "e", "f", "g", "h"];
  it("shows two and says how many are folded", () => {
    const r = N.foldQuestions(qs, false);
    expect(r.shown).toEqual(["a", "b"]);
    expect(r.hidden).toBe(6);
  });
  it("shows all of them when opened, and still reports the count to label the toggle", () => {
    const r = N.foldQuestions(qs, true);
    expect(r.shown).toEqual(qs);
    expect(r.hidden).toBe(6);
  });
  it("folds nothing when there are two or fewer", () => {
    expect(N.foldQuestions(["a", "b"], false)).toEqual({ shown: ["a", "b"], hidden: 0 });
    expect(N.foldQuestions([], false)).toEqual({ shown: [], hidden: 0 });
  });
});

describe("Autopilot confirm sheet (decision D4)", () => {
  it("lists what starts when turning on, and what still asks first", () => {
    const c = AP.autopilotCopy(true);
    expect(c.title).toBe("Turn on Autopilot?");
    expect(c.confirmLabel).toBe("Turn on");
    expect(c.lists[0].items).toContain("Adjust your goals");
    expect(c.lists[0].items).toContain("Run your Meta and Google ads inside your ad budget");
    expect(c.lists[1]).toEqual({ title: "Still asks you first", items: ["Spending", "Posts", "Code changes"] });
    expect(c.note).toMatch(/30 days/);
  });
  it("lists what stops when turning off, and that spending still asks first", () => {
    const c = AP.autopilotCopy(false);
    expect(c.title).toBe("Turn off Autopilot?");
    expect(c.lists.map((l) => l.title)).toEqual(["What stops", "What keeps going", "Still asks you first"]);
    expect(c.lists[0].items).toContain("Early check-ins");
    expect(c.lists[0].items).toContain("Organic-channel moves you approve after this end as \"Didn't finish\"");
    expect(c.note).toBeNull();
  });
  it("says who can change it, and the web's error line", () => {
    expect(AP.AUTOPILOT_OWNER_ONLY).toBe("Only owners and admins can change Autopilot.");
    expect(AP.AUTOPILOT_ERROR).toBe("Could not save that. Try again.");
  });
});

describe("approving a waiting move (web: GoalWork WaitingMove, approveDecision)", () => {
  it("says what web says on failure and asks before shipping a broken test", () => {
    expect(MV.MOVE_ERROR.approve).toBe("Could not approve that. Try again.");
    expect(MV.MOVE_ERROR.reject).toBe("Could not save that. Try again.");
    expect(MV.SHIP_RED_CONFIRM).toBe(
      "This change broke a test that was passing on the base branch.\n\nApproving opens the PR anyway, with the test still broken.\n\nOpen the PR anyway?",
    );
  });
  it("only the ship-red 409 asks; any other conflict or error is a plain error", () => {
    expect(MV.isShipRedRefusal({ status: 409, code: "requires_ship_red_override" })).toBe(true);
    expect(MV.isShipRedRefusal({ status: 409, code: "stale_card" })).toBe(false);
    expect(MV.isShipRedRefusal({ status: 500, code: "requires_ship_red_override" })).toBe(false);
    expect(MV.isShipRedRefusal(new TypeError("Network request failed"))).toBe(false);
    expect(MV.isShipRedRefusal(null)).toBe(false);
  });
  it("sends no body unless the founder confirmed shipping anyway", () => {
    expect(MV.moveRequest("d1", "approve", false)).toEqual({ path: "/api/approvals/d1/approve" });
    expect(MV.moveRequest("d1", "approve", true)).toEqual({ path: "/api/approvals/d1/approve", body: '{"ship_anyway":true}' });
    expect(MV.moveRequest("d1", "reject", true)).toEqual({ path: "/api/approvals/d1/reject" });
  });
  it("a viewer is not shown the buttons, a member is", () => {
    expect(A.growthAccess("member").canDecide).toBe(true);
    expect(A.growthAccess("viewer").canDecide).toBe(false);
  });
});

describe("editing the brand voice (web: GrowthBrandVoice.test)", () => {
  const saved = {
    base_tone: "friendly",
    warm: true,
    enthusiastic: false,
    brand_voice: "Warm and plain-spoken. Short sentences.",
    response_rules: "Never use these words or phrases: artisanal, curated.",
  };
  it("round-trips the never-say list through the rule sentence the agents read", () => {
    const rule = K.neverSayToRule(["artisanal", "curated"]);
    expect(rule).toBe("Never use these words or phrases: artisanal, curated.");
    expect(K.ruleToNeverSay(rule)).toEqual(["artisanal", "curated"]);
  });
  it("leaves unrelated rules alone rather than reading them as words", () => {
    expect(K.ruleToNeverSay("Always answer in under 100 words.")).toEqual([]);
  });
  it("drops blanks and duplicates, and writes nothing for an empty list", () => {
    expect(K.splitWords("artisanal, , Artisanal, curated")).toEqual(["artisanal", "curated"]);
    expect(K.neverSayToRule([" ", ""])).toBe("");
  });
  it("starts the editor from what is saved", () => {
    expect(K.voiceDraftOf(saved)).toEqual({ brand_voice: saved.brand_voice, base_tone: "friendly", warm: true, enthusiastic: false, never_say: "artisanal, curated" });
    expect(K.voiceDraftOf(saved, "Drafted.").brand_voice).toBe("Drafted.");
    expect(K.voiceDraftOf({ base_tone: "odd" }).base_tone).toBe("default");
  });
  it("saves the voice, the tone and the never-say list together", () => {
    const draft = { brand_voice: "Plain and direct.", base_tone: "direct", warm: true, enthusiastic: false, never_say: "synergy, unlock" };
    expect(K.voicePatch(draft, saved.response_rules)).toEqual({
      brand_voice: "Plain and direct.",
      base_tone: "direct",
      warm: true,
      enthusiastic: false,
      response_rules: "Never use these words or phrases: synergy, unlock.",
    });
  });
  it("keeps an unrelated rule when the never-say list is saved", () => {
    const draft = { brand_voice: "x", base_tone: "default", warm: false, enthusiastic: false, never_say: "synergy" };
    expect(K.voicePatch(draft, "Always answer in under 100 words.").response_rules).toBe(
      "Always answer in under 100 words. Never use these words or phrases: synergy.",
    );
  });
  it("saving again does not write the never-say sentence twice (the web does: it only reads it at the start)", () => {
    const once = "Always answer in under 100 words. Never use these words or phrases: synergy.";
    expect(K.ruleToNeverSay(once)).toEqual(["synergy"]);
    const draft = K.voiceDraftOf({ response_rules: once });
    expect(draft.never_say).toBe("synergy");
    expect(K.voicePatch({ ...draft, never_say: "synergy, unlock" }, once).response_rules).toBe(
      "Always answer in under 100 words. Never use these words or phrases: synergy, unlock.",
    );
    expect(K.voicePatch({ ...draft, never_say: "" }, once).response_rules).toBe("Always answer in under 100 words.");
  });
  it("caps the voice at 2000 characters and the words at 25", () => {
    const long = { brand_voice: "a".repeat(2100), base_tone: "default", warm: false, enthusiastic: false, never_say: Array.from({ length: 30 }, (_, i) => `w${i}`).join(",") };
    const p = K.voicePatch(long, "");
    expect(p.brand_voice.length).toBe(2000);
    expect(K.ruleToNeverSay(p.response_rules)).toHaveLength(25);
  });
  it("requires a main colour and accepts blanks for the rest (web: colour validation)", () => {
    expect(K.invalidColour({ primary: "#1a73ff", accent: "", bg: "", text: "" })).toBeNull();
    expect(K.invalidColour({ primary: "1a73ff", accent: "", bg: "", text: "" })).toBe("Main colour must be a hex value like #1A73FF.");
    expect(K.colourPlaceholder("accent")).toBe("optional");
    expect(K.invalidColour({ primary: "#1a73ff", accent: "blue", bg: "", text: "" })).toMatch(/Accent colour/);
  });
  it("sends the colours as the kit expects, blanks as null, only when they changed", () => {
    const kit = { primary: "#1a73ff", accent: null, bg: null, text: null, source: "scrape", source_url: null };
    const same = K.toColourDraft(kit);
    expect(K.coloursChanged(same, K.toColourDraft(kit))).toBe(false);
    expect(K.coloursChanged({ ...same, accent: "#000000" }, same)).toBe(true);
    expect(K.kitBody({ primary: "#1a73ff", accent: " #000000 ", bg: "", text: "" })).toEqual({ primary: "#1a73ff", accent: "#000000", bg: null, text: null });
    expect(K.COLOURS_NOTE_MANUAL).toBe("Set by hand, so your site is no longer read for these.");
    expect(K.COLOURS_NOTE_SITE).toBe("Editing these stops the weekly read of your site, so your choice stays.");
  });
  it("reads the drafted voice, or none", () => {
    expect(K.voiceDraftBodyOf({ draft: { value: "Warm.", from: "your homepage" } })).toEqual({ value: "Warm.", from: "your homepage" });
    expect(K.voiceDraftBodyOf({ draft: { value: " " } })).toBeNull();
    expect(K.voiceDraftBodyOf({ draft: null })).toBeNull();
    expect(K.VOICE_DISMISS_ERROR).toBe("Could not dismiss that. Try again.");
  });
});
