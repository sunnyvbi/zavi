import { beforeEach, describe, expect, it } from "vitest";
import {
  clearFigures,
  recordFiguresFromPull,
  recordInputFigures,
  recordTrustedMoneyValue,
  withholdFigures,
} from "@/services/agents/engine/figure-ledger";
import { REPULL_HINT, TYPED_MEASURED_BY, figureIsSourced, gateMovesOnLedger, moneyCitations, withheldGoalFigures } from "../number-gate";
import { NUMBER_GATE_ITEM_REASON, refusedMoveItems, type GoalMoves } from "../goal-owner";

const RUN = "run-number-gate";
const GOAL = "11111111-1111-4111-8111-111111111111";

function movesWithWhy(why: string): GoalMoves {
  return {
    goals: [{ goal_id: GOAL, moves: [{ target_agent_slug: "meta_ads", intent: "Test a $30/day ad set on the best creative", why }] }],
    goal_changes: [],
    channel_changes: [],
  } as unknown as GoalMoves;
}

beforeEach(() => {
  clearFigures(RUN);
  recordInputFigures(RUN, "Goal: reach 400 paying customers by 2026-12-31.");
});

describe("gateMovesOnLedger", () => {
  it("BLOCKS a move whose reason cites a figure nothing in the run read", () => {
    const { moves, refused } = gateMovesOnLedger(RUN, movesWithWhy("Signups fell to 1,284 last week, so paid has to carry it."));
    expect(moves.goals?.[0].moves).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused[0]).not.toContain("1,284");
    expect(refused[0]).not.toContain("1284");
    expect(refused[0]).toContain(REPULL_HINT);
    expect(refused[0]).toContain("growth__get_metric");
  });

  it("PASSES a move whose figure came from a get_metric result", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ result_id: "m_0123456789", total: 1284, delta_pct: -12.5 }), "growth__get_metric");
    const { moves, refused } = gateMovesOnLedger(RUN, movesWithWhy("Signups fell 12.5% to 1,284 last week."));
    expect(moves.goals?.[0].moves).toHaveLength(1);
    expect(refused).toEqual([]);
  });

  it("PASSES a figure the founder typed in their own message", () => {
    recordInputFigures(RUN, "We spent $2,750 on Meta last month and got nothing.");
    const { moves, refused } = gateMovesOnLedger(RUN, movesWithWhy("The founder spent $2,750 on Meta with no bookings."));
    expect(moves.goals?.[0].moves).toHaveLength(1);
    expect(refused).toEqual([]);
  });

  it("does not judge the intent: a proposed budget is not a claim", () => {
    const { refused } = gateMovesOnLedger(RUN, movesWithWhy("Paid has never been tried here."));
    expect(refused).toEqual([]);
  });

  it("gates goal changes and channel pauses the same way", () => {
    const input = {
      goals: [],
      goal_changes: [{ goal_id: GOAL, target_value: 500, why: "Pace is 3,900 a week, far above target." }],
      channel_changes: [{ channel_slug: "x_organic", action: "pause", why: "Clicks dropped 37% in two weeks." }],
    } as unknown as GoalMoves;
    const { moves, refused } = gateMovesOnLedger(RUN, input);
    expect(moves.goal_changes).toEqual([]);
    expect(moves.channel_changes).toEqual([]);
    expect(refused).toHaveLength(2);
  });

  it("gates a card APPROVAL on its reason; a reject or leave is never gated", () => {
    const input = {
      goals: [],
      channel_cards: [
        { action_id: "act-1", decision: "approve", why: "Sales hit $1,284 this week, raise it." },
        { action_id: "act-2", decision: "reject", why: "Sales hit $1,284, but not now." },
        { action_id: "act-3", decision: "approve", why: "On track for the 400 goal." },
      ],
    } as unknown as GoalMoves;
    const { moves, refused } = gateMovesOnLedger(RUN, input);
    expect(moves.channel_cards?.map((c) => c.action_id)).toEqual(["act-2", "act-3"]);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("act-1");
    expect(refused[0]).not.toContain("1,284");
  });

  it("does not judge a run whose ledger is empty (another process)", () => {
    clearFigures(RUN);
    const { moves, refused } = gateMovesOnLedger(RUN, movesWithWhy("Signups fell to 1,284."));
    expect(moves.goals?.[0].moves).toHaveLength(1);
    expect(refused).toEqual([]);
  });
});

describe("figureIsSourced", () => {
  it("matches a percentage against the fraction get_metric returned", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ total: 0.0342 }), "growth__get_metric");
    expect(figureIsSourced(RUN, "3.42%")).toBe(true);
    expect(figureIsSourced(RUN, "4.42%")).toBe(false);
  });

  it("accepts a percentage rounded from what was read, not one that was not", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ total: 0.0342, delta_pct: 12.46 }), "growth__get_metric");
    expect(figureIsSourced(RUN, "3.4%")).toBe(true);
    expect(figureIsSourced(RUN, "3%")).toBe(true);
    expect(figureIsSourced(RUN, "12.5%")).toBe(true);
    expect(figureIsSourced(RUN, "3.7%")).toBe(false);
    expect(figureIsSourced(RUN, "13.5%")).toBe(false);
  });

  it("a refusal replayed into the next prompt does not source its own figure", () => {
    const { refused } = gateMovesOnLedger(RUN, movesWithWhy("Signups fell to 1,284 last week."));
    clearFigures(RUN);
    recordInputFigures(RUN, `last_note.refused: ${JSON.stringify(refused)}`);
    expect(figureIsSourced(RUN, "1,284")).toBe(false);
  });
});

describe("typed goal numbers expire for the gate", () => {
  const goal = (over: Record<string, unknown>) => ({
    goal_id: GOAL,
    current_value: 612,
    measured_by: TYPED_MEASURED_BY,
    number_trusted: true,
    ...over,
  });
  const payload = (goals: unknown[], founder_reply?: { text: string }) => ({
    memory: { cgo_goals: { goals, ...(founder_reply ? { founder_reply: { via: "email", ...founder_reply } } : {}) } },
  });
  function seed(p: unknown) {
    recordInputFigures(RUN, JSON.stringify(p));
    withholdFigures(RUN, withheldGoalFigures(p));
  }
  const why = "Hosts are at 612, far behind the 900 target, so supply needs work.";

  it("a FRESH typed number is sourced", () => {
    seed(payload([goal({ number_trusted: true, target_value: 900 })]));
    const { moves, refused } = gateMovesOnLedger(RUN, movesWithWhy(why));
    expect(refused).toEqual([]);
    expect(moves.goals?.[0].moves).toHaveLength(1);
  });

  it("an EXPIRED typed number is refused, rounded or not", () => {
    seed(payload([goal({ number_trusted: false, target_value: 900 })]));
    expect(gateMovesOnLedger(RUN, movesWithWhy(why)).refused).toHaveLength(1);
    expect(figureIsSourced(RUN, "610")).toBe(false);
    expect(figureIsSourced(RUN, "900")).toBe(true);
    expect(figureIsSourced(RUN, "400")).toBe(true);
  });

  it("an expired typed number is sourced again once a live pull returns it", () => {
    seed(payload([goal({ number_trusted: false, target_value: 900 })]));
    recordFiguresFromPull(RUN, JSON.stringify({ result_id: "m_0123456789", total: 612 }), "growth__get_metric");
    expect(gateMovesOnLedger(RUN, movesWithWhy(why)).refused).toEqual([]);
  });

  it("the founder restating it in this review's reply makes it fresh", () => {
    seed(payload([goal({ number_trusted: false, target_value: 900 })], { text: "We are still at 612 hosts." }));
    expect(gateMovesOnLedger(RUN, movesWithWhy(why)).refused).toEqual([]);
  });

  it("withholds only untrusted TYPED numbers", () => {
    expect(
      withheldGoalFigures(
        payload([
          goal({ number_trusted: false }),
          goal({ number_trusted: false, current_value: 55, measured_by: "a connected source" }),
          goal({ number_trusted: true, current_value: 77 }),
          goal({ number_trusted: false, current_value: null }),
          goal({ number_trusted: false, current_value: "1250.5" }),
        ]),
      ),
    ).toEqual(["612", "1250.5"]);
    expect(withheldGoalFigures(null)).toEqual([]);
    expect(withheldGoalFigures({ memory: {} })).toEqual([]);
  });
});

describe("money quoted to the cent from a metric tool's longer value", () => {
  const WHY = "It spent $74.18 a day Oct 8 to 10 at $37.09 per Meta-counted purchase, and $25.46 a day of the target is unplaced.";
  const computed = () => {
    recordInputFigures(RUN, '"spare_daily_capacity_usd": 25.46');
    recordFiguresFromPull(RUN, '{"result_id":"c_1","status":"ok","value":37.0917}', "growth__compute");
    recordTrustedMoneyValue(RUN, 37.0917);
    recordFiguresFromPull(RUN, '{"result_id":"c_2","status":"ok","value":74.1833}', "growth__compute");
    recordTrustedMoneyValue(RUN, 74.1833);
  };
  it("the ae1b0e37 reason now passes", () => {
    computed();
    const { moves, refused } = gateMovesOnLedger(RUN, movesWithWhy(WHY));
    expect(refused).toEqual([]);
    expect(moves.goals?.[0].moves).toHaveLength(1);
  });
  it("review 2498d879's head arithmetic ($5.54, $62.77, read nowhere) is still refused", () => {
    computed();
    const { refused } = gateMovesOnLedger(RUN, movesWithWhy("Live budgets are $5.54 a day short of the cap, at $62.77 per Meta-counted purchase."));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("2 figures");
  });
  it("a scaled amount is never the rounding ($37.09K, $37.09 million, $37.09M)", () => {
    computed();
    for (const why of ["Budget it at $37.09K a month.", "Revenue reached $37.09 million.", "A $37.09M year."]) {
      expect(gateMovesOnLedger(RUN, movesWithWhy(why)).refused).toHaveLength(1);
    }
  });
  it("the sign must match: -$37.09 or ($37.09) needs a negative value", () => {
    computed();
    expect(gateMovesOnLedger(RUN, movesWithWhy("Margin was -$37.09 per order.")).refused).toHaveLength(1);
    expect(gateMovesOnLedger(RUN, movesWithWhy("Margin was ($37.09) per order.")).refused).toHaveLength(1);
    recordTrustedMoneyValue(RUN, -37.0917);
    expect(gateMovesOnLedger(RUN, movesWithWhy("Margin was -$37.09 per order.")).refused).toEqual([]);
  });
  it("a scale word after any spacing, or on another spelling of the same amount, refuses it", () => {
    computed();
    for (const why of ["Revenue reached $37.09  million.", "First $37.09 a day, then $37.09\tK."]) {
      expect(gateMovesOnLedger(RUN, movesWithWhy(why)).refused).toHaveLength(1);
    }
    recordTrustedMoneyValue(RUN, 1234.5678);
    expect(gateMovesOnLedger(RUN, movesWithWhy("Spend was $1,234.57 last week, a $1234.57M run rate.")).refused).toHaveLength(1);
  });
  it("each mention keeps its own sign: a positive claim beside a negative one needs a positive value too", () => {
    recordInputFigures(RUN, "x");
    recordTrustedMoneyValue(RUN, -37.0917);
    expect(gateMovesOnLedger(RUN, movesWithWhy("Revenue was $37.09; the adjustment was -$37.09.")).refused).toHaveLength(1);
    recordTrustedMoneyValue(RUN, 37.0917);
    expect(gateMovesOnLedger(RUN, movesWithWhy("Revenue was $37.09; the adjustment was -$37.09.")).refused).toEqual([]);
  });
  it("a range is not a minus, and a sentence may end right after the amount", () => {
    computed();
    expect(gateMovesOnLedger(RUN, movesWithWhy("Bids from $20-$37.09 per purchase.")).refused).toHaveLength(1);
    recordInputFigures(RUN, "bid floor 20");
    expect(gateMovesOnLedger(RUN, movesWithWhy("Bids from $20-$37.09 per purchase.")).refused).toEqual([]);
    expect(gateMovesOnLedger(RUN, movesWithWhy("It costs $37.09.")).refused).toEqual([]);
  });
  it("a scaled spelling inside a code span or a link target is not prose and does not refuse the prose figure", () => {
    computed();
    expect(gateMovesOnLedger(RUN, movesWithWhy("It costs $37.09 per purchase (see `$37.09M` in the log).")).refused).toEqual([]);
  });
  it("plural, parenthesised or attached scale words refuse it; ordinary words after it do not", () => {
    computed();
    for (const why of ["It is $37.09 millions.", "It is $37.09 (thousand).", "It is $37.09Kextra.", "It is $37.09 bn.", "It is $37.09-million."]) {
      expect(gateMovesOnLedger(RUN, movesWithWhy(why)).refused).toHaveLength(1);
    }
    for (const why of ["It costs $37.09 by Oct 31.", "It costs $37.09 a day.", "It costs $37.09 more than last week."]) {
      expect(gateMovesOnLedger(RUN, movesWithWhy(why)).refused).toEqual([]);
    }
  });
  it("every way of writing a negative amount needs a negative value", () => {
    computed();
    for (const why of ["Down –$37.09.", "Down — $37.09.", "Loss ( $37.09).", "Loss (CA$37.09).", "Loss (USD$37.09).", "Down −    $37.09.", "Loss (usd$37.09).", "Down −ca$37.09.", "Loss (C$37.09).", "Loss (A$37.09).", "Loss (S$37.09).", "Loss (EUR$37.09).", "Down −EUR$37.09.", "Down −USD $37.09.", "Loss (USD $37.09).", "Margin was minus $37.09.", "Margin was negative USD $37.09.", "Down −USD  $37.09.", "Loss (USD  $37.09).", "Margin was negative USD  $37.09.", "Down − USD  $37.09.", "Down −usd $37.09.", "Loss (usd $37.09).", "Down −ca $37.09.", "Down −C $37.09.", "Margin negative, at $37.09.", "Down −USD, $37.09.", "Down −U.S. $37.09.", "It was minus approximately $37.09.", "Down ‐$37.09.", "Day 3 −$37.09.", "Q3−$37.09 net.", "Loss ($20-$37.09).", "negative: $20-$37.09."]) {
      expect(gateMovesOnLedger(RUN, movesWithWhy(why)).refused).toHaveLength(1);
    }
  });
  it("a word before the amount is not a currency code, and every dash joins a scale word", () => {
    computed();
    for (const why of ["Charge (a $37.09 fee).", "Raise it — to $37.09 a purchase.", "Margin moved from negative to $37.09."]) {
      expect(gateMovesOnLedger(RUN, movesWithWhy(why)).refused).toHaveLength(1);
    }
    for (const why of [
      "It costs $37.09 a purchase.",
      "Spend $74.18 then $37.09.",
      "Bids from $20-$37.09 per purchase, floor 20.",
      "It fell week-over-week to $37.09.",
      "Cost-per-click is $37.09.",
      "The run-rate is $37.09 a day.",
      "The 7-day average CPA is $37.09.",
      "CPA for Oct 8-10 was $37.09.",
    ]) {
      if (why.includes("floor 20")) recordInputFigures(RUN, "bid floor 20");
      expect(gateMovesOnLedger(RUN, movesWithWhy(why)).refused).toEqual([]);
    }
    for (const why of ["It is $37.09−million.", "It is $37.09‐M.", "It is $37.09‑k."]) {
      expect(gateMovesOnLedger(RUN, movesWithWhy(why)).refused).toHaveLength(1);
    }
  });
  it("another figure with the same digits is never carried through by the rounding ($3,709, 37.09%, 3709)", () => {
    computed();
    for (const why of ["It costs $37.09 now, against $3,709 last month.", "It costs $37.09 at a 37.09% margin.", "It costs $37.09 across 3709 orders."]) {
      expect(gateMovesOnLedger(RUN, movesWithWhy(why)).refused).toHaveLength(1);
    }
  });
  it("the sign is read per mention: a money range's own dash is not a sign, what comes before it still is", () => {
    expect(moneyCitations("$37.09", "Bids from $20-$37.09 per purchase.")).toEqual([{ amount: "37.09", negative: false }]);
    expect(moneyCitations("$37.09", "Loss ($20-$37.09).")).toEqual([{ amount: "37.09", negative: true }]);
    expect(moneyCitations("$37.09", "negative: $20-$37.09.")).toEqual([{ amount: "37.09", negative: true }]);
    expect(moneyCitations("$37.09", "CPA for Oct 8-10 was $37.09.")).toEqual([{ amount: "37.09", negative: false }]);
    expect(moneyCitations("$37.09", "Day 3 −$37.09.")).toEqual([{ amount: "37.09", negative: true }]);
    expect(moneyCitations("$37.09", "Down −$20-$37.09.")).toEqual([{ amount: "37.09", negative: true }]);
    expect(moneyCitations("$37.09", "Q3−USD $37.09 net.")).toEqual([{ amount: "37.09", negative: true }]);
    for (const t of ["Q1-Q3 CPA was $37.09.", "Oct 8–10 was $37.09.", "Oct 8 - 10 was $37.09.", "CPA (last 7 days) is $37.09.", "Revenue (USD) is $37.09.", "The 7-day average CPA is $37.09."]) {
      expect(moneyCitations("$37.09", t)).toEqual([{ amount: "37.09", negative: false }]);
    }
    for (const t of ["Margin (negative) is $37.09.", "Margin (minus) is $37.09.", "Margin (−) $37.09.", "Q1—Q3 was negative; $37.09 now."]) {
      expect(moneyCitations("$37.09", t)?.[0].negative).toBe(true);
    }
    for (const t of ["Q1—Q3 CPA was $37.09.", "Oct 8 — 10 was $37.09.", "CPA was $20.24 in 2024."]) {
      const amount = t.includes("20.24") ? "20.24" : "37.09";
      expect(moneyCitations(`$${amount}`, t)).toEqual([{ amount, negative: false }]);
    }
    for (const t of [
      "Revenue (USD M) was $37.09.", "Revenue (USD K) was $37.09.", "Revenue (M) was $37.09.",
      "Revenue (£m) was $37.09.", "Revenue (€M) was $37.09.",
      "Revenue (NZDm) was $37.09.", "Revenue (£  m) was $37.09.", "Figures are USDm. CPA was $37.09.",
      "All figures in $M. CPA was $37.09.", "Revenue (USDm.) was $37.09.", "Revenue (M.) was $37.09.",
      "Revenue (000) was $37.09.", "Revenue (£000) was $37.09.", "Figures in 000. CPA $37.09.", "Revenue in 000's: $37.09.",
      "Revenue (’000) was $37.09.", "Revenue (USDmn) was $37.09.", "Revenue (USDmil) was $37.09.", "Revenue (₹m) was $37.09.",
      "CPA was $37.09 mln.", "Revenue (PHPm) was $37.09.", "Revenue (VND m) was $37.09.", "TAM was $37.09 tn.",
      "Revenue (usd m) was $37.09.", "Revenue £5m and CPA $37.09.", "Spend USD 5.2m. CPA $37.09.", "All figures in M€. CPA $37.09.",
      "Revenue (INR Cr) was $37.09.", "Revenue (₹ L) was $37.09.", "CPA was $37.09 cr.", "CPA was $37.09 lacs.", "Revenue (m.) was $37.09.",
       "CPA was $37.09 crore.", "Revenue (INR crore) was $37.09.", "Revenue $5 bln and CPA $37.09.",
      "Revenue (USD T) was $37.09.", "Revenue ($M) was $37.09.", "Revenue (USDm) was $37.09.", "$37.09 in 000s.", "Revenue ('000) was $37.09.",
    ]) {
      expect(moneyCitations("$37.09", t)).toBeNull();
    }
    for (const t of [
      "I'm holding CPA at $37.09.", "As of 9 a.m. the CPA is $37.09.", "k-factor is 1.4 and CPA is $37.09.",
      "Series B CPA was $37.09.", "M/M CPA is $37.09.",
      "We reached 1,000 users at $37.09.", "We reached 1000 users at $37.09.", "Spend in M&A was $37.09.", "Growth in K–12 at $37.09.",
      "(a) hold spend (b) CPA was $37.09.", "CPM is $37.09.", "CPA is $37.09 for the 3B creative.", "CPA is $37.09 for 1.2k clicks.", "CPM is $37.09 per 1k impressions.",
      "It was 5k clicks and CPA is $37.09.", "Got 12k installs at CPA $37.09.", "The 2.4m impressions at CPA $37.09.", "SMB CPA is $37.09.", "U.S. CPA was $37.09.",
      "In the 2000s CPA was $37.09.", "CPA $37.09 to $40.00.", "CPA in B was $37.09.", "Budget $10,000 and CPA was $37.09.", "2000 signups at $37.09.",
    ]) {
      expect(moneyCitations("$37.09", t)).toEqual([{ amount: "37.09", negative: false }]);
    }
    expect(moneyCitations("$137.09", "CPA is $137.09.")).toEqual([{ amount: "137.09", negative: false }]);
    expect(moneyCitations("$1,234.57", "Spend was $1,234.57.")).toEqual([{ amount: "1234.57", negative: false }]);
        expect(moneyCitations("$1,000.57", "Spend was $1,000.57.")).toEqual([{ amount: "1000.57", negative: false }]);
    for (const t of ["The value 37.09 is $37.09.", "See 3.709 then $37.09."]) {
      expect(moneyCitations("$37.09", t)).toEqual([{ amount: "37.09", negative: false }]);
    }
    expect(moneyCitations("$37.09", "CPA is $37.09 across ticket 12,3709.")).toBeNull();
    for (const t of ["It is $37.09 in millions.", "It is $37.09 (in millions).", "Revenue (USD millions) was $37.09."]) {
      expect(moneyCitations("$37.09", t)).toBeNull();
    }
    for (const t of ["Spent ($37.09).", "Fee (usd $37.09).", "(at $37.09 per purchase)"]) {
      expect(moneyCitations("$37.09", t)).toEqual([{ amount: "37.09", negative: true }]);
    }
  });
  it("money under a dollar rounds too ($0.99 from 0.994)", () => {
    recordInputFigures(RUN, "x");
    recordTrustedMoneyValue(RUN, 0.994);
    expect(gateMovesOnLedger(RUN, movesWithWhy("Each click costs $0.99 now.")).refused).toEqual([]);
  });
  it("a rate in some other field never becomes a dollar amount", () => {
    recordFiguresFromPull(RUN, '{"delta_pct":12.4612,"value":5}', "growth__get_metric");
    expect(gateMovesOnLedger(RUN, movesWithWhy("CPA is $12.46 now.")).refused).toHaveLength(1);
  });
});
describe("number-gate refusals in the founder's note", () => {
  it("a refused budget raise reads as 'Did not start', never names the unread figure", () => {
    const why = "Weekend promo bought purchases at $37.09 each; a 20% step adds $24 a day.";
    const { refused } = gateMovesOnLedger(RUN, movesWithWhy(why));
    expect(refused).toHaveLength(1);
    const items = refusedMoveItems(refused);
    expect(items).toEqual([
      { section: "blocked", text: "Did not start the Meta Ads change", reason: NUMBER_GATE_ITEM_REASON, channel_slug: "meta_ads" },
    ]);
    for (const i of items) expect(`${i.text} ${i.reason}`).not.toMatch(/\$|37\.09|24|meta_ads|growth__/);
  });

  it("every gated kind gets one plain line, and repeats collapse", () => {
    const moves = {
      goals: [
        { goal_id: GOAL, moves: [
          { target_agent_slug: "research", intent: "Pull the cohort", why: "Only 31 of 102 rebooked." },
          { target_agent_slug: "research", intent: "Pull it again", why: "Only 31 of 102 rebooked." },
        ] },
      ],
      goal_changes: [{ goal_id: GOAL, target_value: 500, why: "Pace is 4,412 a week." }],
      channel_changes: [{ channel_slug: "reddit_ads", action: "pause", why: "It spent $812 for nothing." }],
      channel_cards: [{ action_id: "00000000-0000-4000-8000-000000000001", decision: "approve", why: "CPA is $41.20." }],
    } as unknown as GoalMoves;
    const { refused } = gateMovesOnLedger(RUN, moves);
    expect(refusedMoveItems(refused).map((i) => i.text)).toEqual([
      "Did not start the Research work",
      "Did not change your goal",
      "Did not pause Reddit Ads",
      "Did not approve a card",
    ]);
  });
});

