import { describe, it, expect } from "vitest";
import {
  CGO_REPLY_INSTRUCTION,
  attachCgoReply,
  buildCgoBrief,
  parseCgoReply,
  renderCgoBrief,
  repeatsRejected,
  withCgoBrief,
  type RejectedOrder,
} from "../cgo-brief";
import {
  answerKeysFrom,
  composeGoalOwnerContext,
  goalRev,
  parseGoalMoves,
  planGoalCards,
  rejectedOrdersFrom,
  repeatKey,
  STEP_REPORT_CHARS,
  rejectionCitesCard,
  withFounderClosedCited,
  type GoalMoves,
  type GoalRow,
} from "../goal-owner";

const G = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TODAY = "2026-09-28";
const goal = (over: Partial<GoalRow> = {}): GoalRow => ({
  id: G,
  objective: "Grow active hosts to 2,000",
  target_metric: "active_hosts",
  target_value: 2000,
  current_value: 1522,
  current_value_at: `${TODAY}T08:00:00.000Z`,
  current_value_source: "operator_db",
  due_date: "2026-12-31",
  status: "active",
  priority: 50,
  measurement_mode: "auto",
  created_at: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("the brief down", () => {
  const brief = buildCgoBrief({
    goal: goal(),
    number_trusted: true,
    body: {
      problem: "traffic",
      moves_metric: "host signups",
      boundaries: "No discounts or bonus offers.",
      expected_output: "Three drafts and the one you would post first.",
      context_summary: "Host signups flat for two weeks.",
    },
    kind: "organic",
  });

  it("carries every field: goal, number, trust, judged metric, problem, boundaries, hand-back, why", () => {
    expect(brief).toEqual({
      goal: { objective: "Grow active hosts to 2,000", target_metric: "active_hosts", target_value: 2000, current_value: 1522, number_trusted: true, due_date: "2026-12-31" },
      judged_on: "host signups",
      problem: "traffic",
      boundaries: [
        "No discounts or bonus offers.",
        "Drafts only: nothing is posted, sent or published without the founder's click.",
        "If this order goes against one of your own open cards, do not do it: reply rejected.",
      ],
      expected_output: "Three drafts and the one you would post first.",
      why: "Host signups flat for two weeks.",
      test: null,
    });
  });

  it("a move's test reaches the specialist: one variable, budget, baseline, lines and readout in the brief (Top 10 #7)", () => {
    const test = { variable: "the opening hook", budget_usd: 140, baseline: "$52 per booking", success_if: "under $40 per booking", stop_if: "over $80 after 5 days", readout_on: "2026-10-14" };
    const b = buildCgoBrief({ goal: goal(), number_trusted: true, body: { test }, kind: "ad", adLeftUsd: 400 });
    expect(b.test).toEqual(test);
    const r = renderCgoBrief(b);
    expect(r).toContain("Change ONLY: the opening hook.");
    expect(r).toContain("Test budget: $140 in total.");
    expect(r).toContain("It worked if: under $40 per booking.");
    expect(r).toContain("Stop if: over $80 after 5 days.");
    expect(r).toContain("Read out on 2026-10-14.");
    expect(buildCgoBrief({ goal: goal(), number_trusted: true, body: { test: { variable: "" } }, kind: "ad" }).test).toBeNull();
    expect(renderCgoBrief(buildCgoBrief({ goal: goal(), number_trusted: true, body: {}, kind: "ad" }))).not.toContain("This order is a test");
  });

  it("a raise test promises the daily it goes back to: the model's on a legacy test, the pre-change daily on a server-envelope test", () => {
    const test = { variable: "the daily budget", baseline: "$110 a day", baseline_daily_usd: 110, success_if: "more leads", readout_on: "2026-10-14" };
    expect(renderCgoBrief(buildCgoBrief({ goal: goal(), number_trusted: true, body: { test }, kind: "ad" }))).toContain("puts it back to $110 a day when it ends");
    const server = renderCgoBrief(buildCgoBrief({ goal: goal(), number_trusted: true, body: { test: { ...test, envelope: "server" } }, kind: "ad" }));
    expect(server).toContain("puts it back to the daily it had just before your change when it ends");
    expect(server).not.toContain("$110 a day when it ends");
    const planned = renderCgoBrief(buildCgoBrief({ goal: goal(), number_trusted: true, body: { test: { ...test, budget_usd: 50, envelope: "server" } }, kind: "ad" }));
    expect(planned).toContain("Planned test spend: about $50; Zavi sets the stop from what runs.");
    expect(planned).not.toContain("Test budget:");
  });

  it("a test's stop rule is named, never called enforced (a raise test only files a founder card)", () => {
    const test = { variable: "daily budget", budget_usd: 50, baseline: "3/day", baseline_daily_usd: 110, success_if: "5/day", stop_rule: "budget_or_deadline", readout_on: "2026-10-05" };
    const r = renderCgoBrief(buildCgoBrief({ goal: goal(), number_trusted: true, body: { test }, kind: "ad" }));
    expect(r).toContain("Stop rule: budget_or_deadline.");
    expect(r).not.toContain("Enforced");
  });

  it("an ad channel's limits carry the budget left; judged_on falls back to the goal metric", () => {
    const b = buildCgoBrief({ goal: goal({ current_value: null }), number_trusted: false, body: {}, kind: "ad", adLeftUsd: 412.7 });
    expect(b.judged_on).toBe("active_hosts");
    expect(b.problem).toBe("unspecified");
    expect(b.boundaries[0]).toBe("Spend only inside the founder's ad budget: $412 left this month.");
    expect(b.boundaries[1]).toMatch(/saved owner controls decide unattended authority/);
    const r = renderCgoBrief(b);
    expect(r).toContain("active_hosts now unknown (not a trusted number), target 2000 by 2026-12-31.");
  });

  it("renders a labelled block first and the reply contract last; a run without a brief is unchanged", () => {
    const turn = "Run context (JSON):\n{}";
    const out = withCgoBrief({ intent: "x", cgo_brief: brief }, turn);
    expect(out.startsWith("## Brief from cgo (head of growth)\nGoal: Grow active hosts to 2,000. active_hosts now 1522, target 2000 by 2026-12-31.")).toBe(true);
    for (const line of ["Judged on: host signups", "Problem: traffic", "Boundaries: No discounts", "Hand back: Three drafts", "Why: Host signups flat"]) {
      expect(out).toContain(line);
    }
    expect(out.endsWith(CGO_REPLY_INSTRUCTION)).toBe(true);
    expect(withCgoBrief({ intent: "x" }, turn)).toBe(turn);
    expect(withCgoBrief(null, turn)).toBe(turn);
  });
});

describe("the typed reply up", () => {
  it("completed, from the parsed envelope", () => {
    expect(parseCgoReply({ rendered_markdown: "", cgo_reply: { status: "completed", summary: "Three drafts made." } }, [])).toEqual({ status: "completed", summary: "Three drafts made." });
  });

  it("rejected, from the raw JSON when the envelope schema dropped the key", () => {
    const raw = `{"rendered_markdown":"# x","steps":[],"cgo_reply":{"status":"rejected","reason":"It goes against my open card \\"Rebuild Turo\\".","summary":"Did not pause it."}}`;
    expect(parseCgoReply({ rendered_markdown: "# x", steps: [] }, ["# x", raw])).toEqual({
      status: "rejected",
      reason: 'It goes against my open card "Rebuild Turo".',
      summary: "Did not pause it.",
    });
  });

  it("input_required, from a prose tag; a missing question falls back to the summary", () => {
    const t = 'Done reading.\n<cgo_reply>{"status":"input_required","question":"Which city first?","summary":"Need a city."}</cgo_reply>';
    expect(parseCgoReply(null, [t])).toEqual({ status: "input_required", question: "Which city first?", summary: "Need a city." });
    expect(parseCgoReply({ cgo_reply: { status: "input_required", summary: "Need a city." } }, [])).toMatchObject({ question: "Need a city." });
  });

  it("garbled or missing = completed with a warning, never a blocked run", () => {
    expect(parseCgoReply({ cgo_reply: { status: "maybe" } }, [], "the output")).toEqual({ status: "completed", summary: "the output", warning: "garbled" });
    expect(parseCgoReply(null, ['"cgo_reply": {"status": "rejected", '], "out")).toMatchObject({ status: "completed", warning: "garbled" });
    expect(parseCgoReply(null, ["plain prose"], "plain prose")).toEqual({ status: "completed", summary: "plain prose", warning: "missing" });
    expect(parseCgoReply({ cgo_reply: { status: "rejected" } }, [])).toMatchObject({ status: "rejected", reason: "no reason given" });
  });

  it("attachCgoReply stores the reply on parsed and strips a prose tag, only on a briefed run", () => {
    const withBrief = { cgo_brief: { goal: {}, judged_on: "x" } };
    const r = attachCgoReply(withBrief, {
      parsed: { steps: [] },
      output_text: 'Wrote it.\n<cgo_reply>{"status":"completed","summary":"Wrote it."}</cgo_reply>',
      raw_response_text: "",
    });
    expect(r.parsed).toEqual({ steps: [], cgo_reply: { status: "completed", summary: "Wrote it." } });
    expect(r.output_text).toBe("Wrote it.");
    const other = { parsed: { a: 1 }, output_text: "t", raw_response_text: "" };
    expect(attachCgoReply({ intent: "x" }, other)).toEqual({ parsed: { a: 1 }, output_text: "t", raw_response_text: "" });
  });
});

describe("cgo sees it", () => {
  const compose = (steps: Parameters<typeof composeGoalOwnerContext>[0]["steps"], cards: Parameters<typeof composeGoalOwnerContext>[0]["cards"] = []) =>
    composeGoalOwnerContext({
      today: TODAY,
      goals: [],
      channels: [],
      founder: { last_active_at: null, days_since_active: null, approved_14d: 0, rejected_14d: 0 },
      lastNote: null,
      cards,
      steps,
      agents: [],
      wake: { kind: "scheduled", reason: "daily_check", check_reasons: [], autopilot: true },
    }).finished_steps;

  it("a research run reaches the review as a report with its run id and problem (hypothesis tracker)", () => {
    const report = "Visitors leave at the insurance step. ".repeat(80);
    const [step] = compose([{ id: "run-9", agent_slug: "research", status: "success", payload: { goal_id: G, problem: "conversion" }, output_text: report, parsed: null }]);
    expect(step).toMatchObject({ run_id: "run-9", problem: "conversion", agent: "research" });
    expect(step.summary.length).toBeLessThanOrEqual(300);
    expect(step.report?.length).toBeGreaterThan(300);
    expect(step.report?.length).toBeLessThanOrEqual(STEP_REPORT_CHARS);
    const [ch] = compose([{ id: "run-8", agent_slug: "seo", status: "success", payload: { goal_id: G, cgo_brief: { problem: "traffic" } }, output_text: "x".repeat(900), parsed: null }]);
    expect(ch).toMatchObject({ run_id: "run-8", problem: "traffic" });
    expect(ch.report).toBeUndefined();
  });

  it("finished_steps shows the status, reason or question and the summary, not raw output", () => {
    const steps = compose([
      { agent_slug: "linkedin_organic", status: "success", payload: { goal_id: G }, output_text: "x".repeat(900), parsed: { cgo_reply: { status: "rejected", reason: "No such bonus exists.", summary: "Did not write it." } } },
      { agent_slug: "meta_ads", status: "success", payload: { goal_id: G }, output_text: "long", parsed: { cgo_reply: { status: "input_required", question: "Which city?", summary: "Need a city." } } },
      { agent_slug: "seo", status: "success", payload: { goal_id: G }, output_text: "Fixed titles", parsed: null },
    ]);
    expect(steps).toEqual([
      { goal_id: G, agent: "linkedin_organic", ordered_by: "cgo", status: "success", summary: "Did not write it.", reply: "rejected", reason: "No such bonus exists." },
      { goal_id: G, agent: "meta_ads", ordered_by: "cgo", status: "success", summary: "Need a city.", reply: "input_required", question: "Which city?" },
      { goal_id: G, agent: "seo", ordered_by: "cgo", status: "success", summary: "Fixed titles" },
    ]);
  });

  it("a gate refusal at dispatch surfaces as a rejected step with the gate's reason", () => {
    const steps = compose(
      [],
      [
        { status: "dispatch_failed", dispatch_error: "cgo_not_authorized: open_advice_conflict", body: { goal_id: G, target_agent_slug: "meta_ads", intent: "pause Turo" } },
        { status: "acted", body: { goal_id: G, target_agent_slug: "research", intent: "x" } },
        { status: "dispatch_failed", dispatch_error: "fleet check failed: timeout", body: { goal_id: G, target_agent_slug: "seo", intent: "fix titles" } },
      ],
    );
    expect(steps).toEqual([
      { goal_id: G, agent: "meta_ads", ordered_by: "cgo", status: "not_started", summary: "pause Turo", reply: "rejected", reason: "open_advice_conflict" },
      { goal_id: G, agent: "seo", ordered_by: "cgo", status: "not_started", summary: "fix titles", reason: "fleet check failed: timeout" },
    ]);
  });
});

describe("a rejected order is not re-issued without new evidence", () => {
  const ORDER = "Write three LinkedIn posts offering new hosts a $500 signup bonus";
  const rejectedRun = (over: Record<string, unknown> = {}) => ({
    agent_slug: "linkedin_organic",
    payload: { goal_id: G, goal_rev: goalRev(goal()), intent: ORDER, cgo_brief: { goal: { current_value: 1522 } }, ...over },
    parsed: { cgo_reply: { status: "rejected", reason: "No such bonus exists.", summary: "Did not write it." } },
  });
  const plan = (intent: string, g: GoalRow, rejected: RejectedOrder[]) =>
    planGoalCards({
      liveGoals: [g],
      moves: { goals: [{ goal_id: G, moves: [{ target_agent_slug: "linkedin_organic", intent, why: "" }] }], goal_changes: [], channel_changes: [] } as GoalMoves,
      changedGoals: new Set(),
      acts: true,
      allowed: new Set(["linkedin_organic"]),
      openKeys: new Set(),
      recentKeys: new Set(),
      rejectedOrders: rejected,
      repo: null,
      today: TODAY,
    });

  it("reads the rejections off cgo's finished runs", () => {
    const r = rejectedOrdersFrom([rejectedRun(), { agent_slug: "seo", payload: { goal_id: G }, parsed: { cgo_reply: { status: "completed", summary: "ok" } } }]);
    expect(r).toEqual([{ target: "linkedin_organic", goal_id: G, intent: ORDER, reason: "No such bonus exists.", briefed_value: 1522, briefed_rev: goalRev(goal()), rejected_at: null }]);
  });

  it("the same order again is refused; a reworded copy too; a different order is not", () => {
    const rejected = rejectedOrdersFrom([rejectedRun()]);
    const same = plan(ORDER, goal(), rejected);
    expect(!same.needsRepo && same.goals[0].cards).toEqual([]);
    expect(!same.needsRepo && same.refused[0]).toMatch(/linkedin_organic rejected this order \(No such bonus exists\.\) and nothing has changed since/);
    const reworded = plan("Write three LinkedIn posts offering new hosts a $500 bonus for signing up", goal(), rejected);
    expect(!reworded.needsRepo && reworded.goals[0].cards).toEqual([]);
    const other = plan("Draft three posts from real host earnings stories in San Jose", goal(), rejected);
    expect(!other.needsRepo && other.goals[0].cards.map((c) => c.target)).toEqual(["linkedin_organic"]);
  });

  it("new evidence (the goal's number or the goal itself changed) lets it through", () => {
    const rejected = rejectedOrdersFrom([rejectedRun()]);
    const moved = plan(ORDER, goal({ current_value: 1530 }), rejected);
    expect(!moved.needsRepo && moved.goals[0].cards).toHaveLength(1);
    expect(repeatsRejected({ target: "linkedin_organic", goal_id: G, intent: ORDER }, { current_value: 1522, rev: "other-rev" }, rejected)).toBeNull();
  });

  it("the same words for another goal are not held by this goal's rejection", () => {
    const rejected = rejectedOrdersFrom([rejectedRun()]);
    expect(repeatsRejected({ target: "linkedin_organic", goal_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", intent: ORDER }, { current_value: 1522, rev: goalRev(goal()) }, rejected)).toBeNull();
  });

  it("inside the week: a rejection is the run's result, so new evidence gets through; the identical order does not", () => {
    const runs = [{ ...rejectedRun(), finished_at: "2026-09-27T10:00:00Z" }];
    const answerKeys = answerKeysFrom(runs, [{ key: `${G}:linkedin_organic`, approved_at: "2026-09-27T09:00:00Z" }]);
    const plan2 = (g: GoalRow) =>
      planGoalCards({
        liveGoals: [g],
        moves: { goals: [{ goal_id: G, moves: [{ target_agent_slug: "linkedin_organic", intent: ORDER, why: "" }] }], goal_changes: [], channel_changes: [] } as GoalMoves,
        changedGoals: new Set(),
        acts: true,
        allowed: new Set(["linkedin_organic"]),
        openKeys: new Set(),
        recentKeys: new Set([`${G}:linkedin_organic:unspecified`]),
        answerKeys,
        rejectedOrders: rejectedOrdersFrom(runs),
        repo: null,
        today: TODAY,
      });
    const same = plan2(goal());
    expect(!same.needsRepo && same.goals[0].cards).toEqual([]);
    const moved = plan2(goal({ current_value: 1530 }));
    expect(!moved.needsRepo && moved.goals[0].cards).toHaveLength(1);
  });

  it("input_required: the answering move is not held as 'already ran this week' until work starts again", () => {
    const runs = [
      { agent_slug: "meta_ads", payload: { goal_id: G }, parsed: { cgo_reply: { status: "input_required", question: "Which city?", summary: "x" } }, finished_at: "2026-09-26T10:00:00Z" },
      { agent_slug: "seo", payload: { goal_id: G }, parsed: { cgo_reply: { status: "input_required", question: "?", summary: "x" } }, finished_at: "2026-09-25T10:00:00Z" },
    ];
    const keys = answerKeysFrom(runs, [
      { key: `${G}:meta_ads`, approved_at: "2026-09-25T09:00:00Z" },
      { key: `${G}:seo`, approved_at: "2026-09-26T09:00:00Z" },
    ]);
    expect([...keys]).toEqual([`${G}:meta_ads`]);
    const planned = planGoalCards({
      liveGoals: [goal()],
      moves: { goals: [{ goal_id: G, moves: [{ target_agent_slug: "meta_ads", intent: "Start with Phoenix", why: "" }] }], goal_changes: [], channel_changes: [] } as GoalMoves,
      changedGoals: new Set(),
      acts: true,
      allowed: new Set(["meta_ads"]),
      openKeys: new Set(),
      recentKeys: new Set([`${G}:meta_ads:unspecified`]),
      answerKeys: keys,
      repo: null,
      today: TODAY,
    });
    expect(!planned.needsRepo && planned.goals[0].cards).toHaveLength(1);
  });
});

describe("the move carries boundaries and expected_output onto the card", () => {
  it("parses them, drops a bad value, and planGoalCards writes them on the card body", () => {
    const r = parseGoalMoves(
      `<goal_moves>${JSON.stringify({ goals: [{ goal_id: G, moves: [{ target_agent_slug: "linkedin_organic", intent: "three posts", boundaries: "No discounts.", expected_output: "Three drafts.", problem: "traffic", moves_metric: "host signups" }, { target_agent_slug: "seo", intent: "fix titles", boundaries: 7 }] }] })}</goal_moves>`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.goals[0].moves[1].boundaries).toBeUndefined();
    const planned = planGoalCards({
      liveGoals: [goal()],
      moves: r.value,
      changedGoals: new Set(),
      acts: true,
      allowed: new Set(["linkedin_organic"]),
      openKeys: new Set(),
      repo: null,
      today: TODAY,
    });
    expect(!planned.needsRepo && planned.goals[0].cards[0].body).toMatchObject({
      boundaries: "No discounts.",
      expected_output: "Three drafts.",
      problem: "traffic",
      moves_metric: "host signups",
    });
  });
});

describe("the repeat window is per problem (hypothesis tracker)", () => {
  const plan = (problem: string) =>
    planGoalCards({
      liveGoals: [goal({ current_value: 100 })],
      moves: { goals: [{ goal_id: G, moves: [{ target_agent_slug: "research", intent: "Look at the booking page", why: "", problem }] }], goal_changes: [], channel_changes: [] } as GoalMoves,
      changedGoals: new Set(),
      acts: true,
      allowed: new Set(["research"]),
      openKeys: new Set(),
      recentKeys: new Set([repeatKey(G, "research", "traffic")]),
      repo: null,
      today: TODAY,
    });

  it("research on a second suspect is not blocked by research on the first", () => {
    const other = plan("conversion");
    expect(!other.needsRepo && other.goals[0].cards).toHaveLength(1);
    const same = plan("traffic");
    expect(!same.needsRepo && same.goals[0].cards).toEqual([]);
  });
});

describe("R10: a rejection whose cited card the founder closed is released", () => {
  const ORDER = 'Pause "40% to Turo": no bookings in 7 days';
  const rejection = (over: Partial<RejectedOrder> = {}): RejectedOrder => ({
    target: "meta_ads",
    goal_id: G,
    intent: ORDER,
    reason: 'It contradicts my open card "Rebuild “40% to Turo” as a conversion campaign"; decide that first.',
    briefed_value: 1522,
    briefed_rev: goalRev(goal()),
    rejected_at: "2026-09-27T10:00:00.000Z",
    ...over,
  });
  const card = { channel_slug: "meta_ads", title: "Rebuild “40% to Turo” as a conversion campaign", at: "2026-09-27T12:00:00.000+00:00" };
  const move = { target: "meta_ads", goal_id: G, intent: ORDER };
  const now = { current_value: 1522, rev: goalRev(goal()) };

  it("the founder closed the cited card after the rejection: the order is not held", () => {
    const [r] = withFounderClosedCited([rejection()], [card]);
    expect(r.founder_closed_cited).toBe(true);
    expect(repeatsRejected(move, now, [r])).toBeNull();
  });

  it("a reply that names the card by its quoted object plus 'card' matches too", () => {
    expect(rejectionCitesCard("There is an open card to rebuild 40% to Turo; I will not pause it.", card.title)).toBe(true);
    expect(rejectionCitesCard('My open card "Pause Campaign 10 today" says otherwise.', "Pause Campaign 1 today")).toBe(false);
    expect(rejectionCitesCard('See my open card about "Campaign 10".', 'Rebuild "Campaign 1"')).toBe(false);
    expect(rejectionCitesCard("Campaign 1's card conflicts with this.", 'Rebuild "Campaign 1"')).toBe(true);
    expect(rejectionCitesCard("My open card: Review McDonald campaign first.", "Review McDonald's campaign")).toBe(false);
    expect(rejectionCitesCard("My open card: Review McDonald's campaign first.", "Review McDonald's campaign")).toBe(true);
    expect(rejectionCitesCard("See Review McDonald's card, it conflicts.", "Review McDonald's card")).toBe(true);
  });

  it("unknown stays held: closed before the rejection, another channel, an uncited card, or no rejection time", () => {
    for (const [orders, closed] of [
      [[rejection()], [{ ...card, at: "2026-09-27T09:00:00.000Z" }]],
      [[rejection()], [{ ...card, channel_slug: "google_ads" }]],
      [[rejection()], [{ ...card, title: "Raise SF budget to $80/day" }]],
      [[rejection({ rejected_at: null })], [card]],
      [[rejection({ reason: "Pausing it would lose the learning." })], [card]],
    ] as Array<[RejectedOrder[], typeof card[]]>) {
      const marked = withFounderClosedCited(orders, closed);
      expect(repeatsRejected(move, now, marked)).not.toBeNull();
    }
  });
});
