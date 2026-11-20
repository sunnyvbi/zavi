
import { describe, it, expect, beforeEach } from "vitest";
import {
  clearFigures,
  recordFiguresFromPull,
  recordFigures,
  pullsForFigure,
  pullIndexIsEmpty,
  figureWasRead,
  _pullCount,
} from "@/services/agents/engine/figure-ledger";
import {
  buildAnswerSources,
  answerFigures,
  figureTokens,
  workedOutFrom,
} from "@/services/agents/answer-sources";
import { recordShownRows, resetShownRows, shownRowsFor } from "@/services/agents/engine/figure-ledger";

const RUN = "11111111-1111-4111-8111-111111111111";

beforeEach(() => clearFigures(RUN));

describe("figure ledger — which pull returned a number", () => {
  it("attributes a figure to the pull that returned it", () => {
    recordFiguresFromPull(RUN, '{"total": 5344, "trips": 286}', "operator_db__query");
    expect(pullsForFigure(RUN, "5344")).toEqual([
      { tool: "operator_db__query", nth: 1 },
    ]);
    expect(pullsForFigure(RUN, "$5,344")).toEqual([
      { tool: "operator_db__query", nth: 1 },
    ]);
  });

  it("counts repeat calls of the same tool so a citation is joinable", () => {
    recordFiguresFromPull(RUN, '{"a": 111}', "operator_db__query");
    recordFiguresFromPull(RUN, '{"b": 222}', "operator_db__query");
    expect(pullsForFigure(RUN, "222")).toEqual([
      { tool: "operator_db__query", nth: 2 },
    ]);
  });

  it("returns nothing for a number no pull returned", () => {
    recordFiguresFromPull(RUN, '{"total": 5344}', "operator_db__query");
    expect(pullsForFigure(RUN, "448")).toEqual([]);
  });

  it("does NOT allow the rounding that figureWasRead allows", () => {
    recordFiguresFromPull(RUN, '{"total": 5344}', "operator_db__query");
    expect(figureWasRead(RUN, "5340")).toBe(true);
    expect(pullsForFigure(RUN, "5340")).toEqual([]);
  });

  it("still feeds the plain ledger the render gates read", () => {
    recordFiguresFromPull(RUN, '{"subs": 4832820}', "web_search__search");
    expect(figureWasRead(RUN, "4,832,820")).toBe(true);
  });

  it("recordFigures alone indexes no pull, so nothing can be miscited", () => {
    recordFigures(RUN, '{"total": 5344}');
    expect(figureWasRead(RUN, "5344")).toBe(true);
    expect(pullsForFigure(RUN, "5344")).toEqual([]);
    expect(pullIndexIsEmpty(RUN)).toBe(true);
  });

  it("does not let a fetch envelope's HTTP status back a business figure", () => {
    recordFiguresFromPull(
      RUN,
      JSON.stringify({
        final_url: "https://example.com/fleet",
        status: 200,
        content_type: "text/html",
        body_text: "We currently list 37 vehicles.",
        capture: "dom_text",
      }),
      "web_fetch__fetch",
    );
    expect(pullsForFigure(RUN, "37")).toEqual([{ tool: "web_fetch__fetch", nth: 1 }]);
    expect(pullsForFigure(RUN, "200")).toEqual([]);
    expect(figureWasRead(RUN, "200")).toBe(true);
  });

  it("indexes the whole result for a tool that declares no body", () => {
    recordFiguresFromPull(RUN, '{"match_count": 12, "rows": [{"trips": 286}]}', "operator_db__query");
    expect(pullsForFigure(RUN, "286")).toEqual([{ tool: "operator_db__query", nth: 1 }]);
    expect(pullsForFigure(RUN, "12")).toEqual([{ tool: "operator_db__query", nth: 1 }]);
  });

  it("clearFigures drops the pull index with the run", () => {
    recordFiguresFromPull(RUN, '{"a": 111}', "operator_db__query");
    expect(_pullCount(RUN)).toBe(1);
    clearFigures(RUN);
    expect(_pullCount(RUN)).toBe(0);
    expect(pullIndexIsEmpty(RUN)).toBe(true);
  });
});

describe("answerFigures — only figures a founder would act on", () => {
  it("takes money, percentages and real counts", () => {
    expect(answerFigures("You made $5,344 from 286 trips, a 12% lift.")).toEqual([
      "$5,344",
      "286",
      "12%",
    ]);
  });

  it("keeps a fragment whose digits differ from the money token around it", () => {
    expect(answerFigures("CPC was $0.125.")).toEqual(["$0.125", "125"]);
    expect(figureTokens("CPA is $137.09.")).toEqual(["$137.09"]);
    expect(figureTokens("CPC was $0.125.")).toEqual(["$0.125", "125"]);
  });

  it("leaves conversational quantities alone", () => {
    expect(answerFigures("Here are 3 options; give it 2 weeks.")).toEqual([]);
  });

  it("does not treat a year as a measurement", () => {
    expect(answerFigures("Revenue in August 2026 was flat.")).toEqual([]);
  });

  it("ignores numbers inside code, links and URLs", () => {
    const text = [
      "Run `SELECT 9999 FROM t` and see [the report](https://x.dev/r/8888).",
      "```",
      "port 7777",
      "```",
      "Your total was $5,344.",
    ].join("\n");
    expect(answerFigures(text)).toEqual(["$5,344"]);
  });
});

describe("buildAnswerSources — the block the founder reads", () => {
  it("names the pull behind each figure and flags the ones with none", () => {
    recordFiguresFromPull(
      RUN,
      '{"gross": 5344, "trips": 286, "cancelled": 251}',
      "operator_db__query",
    );
    recordFiguresFromPull(RUN, '{"messages": 448}', "slack__search");

    const out = buildAnswerSources(
      RUN,
      "August gross was $5,344 across 286 trips (251 completed). " +
        "Support handled 448 messages. Roughly 80% of hosts took no trip.",
    );

    expect(out.block).toContain("**Sources.** 4 numbers came straight from data pulled in this run.");
    expect(out.block).toContain("1. Your database: a query returned $5,344, 286, 251");
    expect(out.block).toContain("2. Slack: message search returned 448");
    expect(out.block).not.toContain("80%");
    expect(out.meta).toEqual({ figures: 5, sourced: 4, unsourced: 1, unverified: ["80%"] });
    expect(out.block).not.toContain("\u2014");
  });

  it("numbers repeat calls of one tool so the citation can be found", () => {
    recordFiguresFromPull(RUN, '{"a": 111}', "operator_db__query");
    recordFiguresFromPull(RUN, '{"b": 222}', "operator_db__query");
    const out = buildAnswerSources(RUN, "First 111, then 222.");
    expect(out.block).toContain("Your database: a query (call 1)");
    expect(out.block).toContain("Your database: a query (call 2)");
  });

  it("renders a figure that only matched a fetch envelope as unsourced", () => {
    recordFiguresFromPull(
      RUN,
      JSON.stringify({ final_url: "https://example.com", status: 200, body_text: "Fleet page." }),
      "web_fetch__fetch",
    );
    const out = buildAnswerSources(RUN, "They have 200 active cars.");
    expect(out.block).toBeNull();
    expect(out.meta).toEqual({ figures: 1, sourced: 0, unsourced: 1, unverified: ["200"] });
  });

  it("prints the call number off the RUN's call count, not the cited count", () => {
    recordFiguresFromPull(RUN, '{"rows": []}', "operator_db__query");
    recordFiguresFromPull(RUN, '{"gross": 5344}', "operator_db__query");
    const out = buildAnswerSources(RUN, "August gross was $5,344.");
    expect(out.block).toContain("Your database: a query (call 2)");
  });

  it("says nothing when the answer carries no actionable figure", () => {
    recordFiguresFromPull(RUN, '{"total": 5344}', "operator_db__query");
    expect(buildAnswerSources(RUN, "Here are 3 options to consider.").block).toBeNull();
  });

  it("says nothing when the run indexed no pulls — absence is not evidence", () => {
    expect(buildAnswerSources(RUN, "Your total was $5,344.").block).toBeNull();
  });

  it("never puts a tool input or output content in the block", () => {
    recordFiguresFromPull(
      RUN,
      '{"email":"host@example.com","gross":5344,"note":"secret narrative"}',
      "operator_db__query",
    );
    const out = buildAnswerSources(RUN, "Gross was $5,344.");
    expect(out.block).not.toContain("host@example.com");
    expect(out.block).not.toContain("secret narrative");
    expect(out.block).toContain("Your database: a query");
  });

  it("meta lists the unverified figures of the reply and no tool name", () => {
    recordFiguresFromPull(RUN, '{"gross": 5344}', "operator_db__query");
    const out = buildAnswerSources(RUN, "Gross was $5,344 and churn 80%.");
    expect(Object.keys(out.meta).sort()).toEqual(["figures", "sourced", "unsourced", "unverified"]);
    expect(out.meta.unverified).toEqual(["80%"]);
    expect(out.block).not.toBeNull();
    expect(JSON.stringify(out.meta)).not.toContain("operator_db");
  });

  it("ignores Zavi run-cost dollars while still sourcing business figures", () => {
    recordFiguresFromPull(RUN, '{"revenue": 4200}', "operator_db__query");
    const out = buildAnswerSources(
      RUN,
      "Each test run costs about $0.50 to $1.50. Revenue was $4,200.",
    );
    expect(out.block).not.toContain("Not in this run's data");
    expect(out.meta.unsourced).toBe(0);
    expect(out.meta.unverified).not.toContain("$0.50");
    expect(out.meta.unverified).not.toContain("$1.50");
  });

  it("returns no block when only run-cost amounts are figures", () => {
    recordFiguresFromPull(RUN, '{"marker": 999}', "operator_db__query");
    const out = buildAnswerSources(RUN, "Each test run costs about $0.50 to $1.50.");
    expect(out.block).toBeNull();
    expect(out.meta).toEqual({ figures: 0, sourced: 0, unsourced: 0, unverified: [] });
    expect(out.checked).toEqual([]);
  });

  it("still flags business dollars that are not in a run-cost sentence", () => {
    recordFiguresFromPull(RUN, '{"marker": 999}', "operator_db__query");
    const out = buildAnswerSources(RUN, "Revenue was $4,200 last week.");
    expect(out.block).toBeNull();
    expect(out.meta).toEqual({ figures: 1, sourced: 0, unsourced: 1, unverified: ["$4,200"] });
  });

  it("still flags ad spend in a sentence that also mentions credits", () => {
    recordFiguresFromPull(RUN, '{"marker": 999}', "operator_db__query");
    const out = buildAnswerSources(RUN, "Meta spent $340 this week, about 1,360 credits.");
    expect(out.meta.unverified).toContain("$340");
  });

  it("still flags a business cost per day, which is not a run price", () => {
    recordFiguresFromPull(RUN, '{"marker": 999}', "operator_db__query");
    const out = buildAnswerSources(RUN, "Ads cost $500 per day.");
    expect(out.meta.unverified).toEqual(["$500"]);
  });

  it("still counts card-row figures when prose has the same run-cost digits", () => {
    recordFiguresFromPull(RUN, '{"limit": 150}', "operator_db__query");
    recordShownRows(RUN, [["150"]]);
    const out = buildAnswerSources(RUN, "The custom agent costs $1.50 per run.");
    expect(out.block).toContain("The number 150 came straight from data pulled in this run.");
    expect(out.block).toContain("Your database: a query returned 150");
    expect(out.block).not.toContain("$1.50");
    expect(out.meta).toEqual({ figures: 1, sourced: 1, unsourced: 0, unverified: [] });
    expect(out.checked).toEqual([
      { figure: "150", kind: "pulled", source: "Your database: a query", tool: "operator_db__query" },
    ]);
  });
});

describe("buildAnswerSources — plain source labels", () => {
  it("prints a plain label for a GitHub pull, never the raw tool name", () => {
    recordFiguresFromPull(RUN, '{"open_prs": 340}', "github__list_open_prs");
    const out = buildAnswerSources(RUN, "The open PR is number 340.");
    expect(out.block).toContain("1. GitHub: open pull requests returned 340");
    expect(out.block).not.toContain("github__");
    expect(out.block).not.toContain("`");
  });

  it("falls back to the server name, then to a generic label, never the raw name", () => {
    recordFiguresFromPull(RUN, '{"spend": 4210}', "meta_ads__some_new_tool");
    recordFiguresFromPull(RUN, '{"visits": 9120}', "acme_internal__weird_tool");
    const out = buildAnswerSources(RUN, "Spend was $4,210 and 9,120 visits.");
    expect(out.block).toContain("1. Meta Ads returned $4,210");
    expect(out.block).toContain("2. A connected tool returned 9,120");
    expect(out.block).not.toMatch(/__/);
  });
});

describe("buildAnswerSources — cards and worked-out rates", () => {
  const PULL = JSON.stringify([
    { month: "July 2026", signups: 1587, bookings: 120 },
    { month: "August 2026", signups: 2497, bookings: 88 },
  ]);

  it("counts the card's numbers and explains a rate worked out from its row", () => {
    recordFiguresFromPull(RUN, PULL, "operator_db__query");
    recordShownRows(RUN, [
      ["July 2026", "1587", "120", "7.6%"],
      ["August 2026", "2497", "88", "3.5%"],
    ]);
    const out = buildAnswerSources(
      RUN,
      "Sign-up to booking fell from 7.6% in July to 3.5% in August.",
    );
    expect(out.block).toContain(
      "**Sources.** 4 of 6 numbers came straight from data pulled in this run, 2 check out as arithmetic on it.",
    );
    expect(out.block).toContain("Your database: a query returned 1587, 120, 2497, 88");
    expect(out.block).toContain("Checks out against those: 7.6% = 120 / 1587 · 3.5% = 88 / 2497");
    expect(out.block).not.toContain("Not in this run's data");
    expect(out.meta).toEqual({ figures: 6, sourced: 4, unsourced: 0, unverified: [] });
  });

  it("explains a drop-off rate from pulled numbers in the prose", () => {
    recordFiguresFromPull(RUN, '{"passed_signup": 359, "booked": 75}', "operator_db__query");
    const out = buildAnswerSources(
      RUN,
      "359 passed sign up and 75 booked, so drop-off is 79.1%.",
    );
    expect(out.block).toContain("Checks out against those: 79.1% = 1 - 75 / 359");
  });

  it("does not explain a rate whose inputs came from different pulls", () => {
    recordFiguresFromPull(RUN, '{"signups": 1587}', "operator_db__query");
    recordFiguresFromPull(RUN, '{"bookings": 120}', "stripe__list");
    const out = buildAnswerSources(RUN, "1587 sign-ups, 120 bookings, 7.6% converted.");
    expect(out.meta.unverified).toEqual(["7.6%"]);
    expect(out.block).not.toContain("Worked out from those");
  });

  it("refuses a rate that more than one pair of numbers explains", () => {
    const always = () => true;
    expect(workedOutFrom("50%", ["50", "100", "25"], always)).toBeNull();
    expect(workedOutFrom("7.6%", ["120", "1587"], always)).toBe("7.6% = 120 / 1587");
    expect(workedOutFrom("7.57%", ["120", "1587"], always)).toBeNull();
  });

  it("speaks when only a card carries numbers", () => {
    recordFiguresFromPull(RUN, PULL, "operator_db__query");
    recordShownRows(RUN, [["July 2026", "1587", "120"]]);
    const out = buildAnswerSources(RUN, "Here is the monthly breakdown.");
    expect(out.block).toContain("**Sources.** All 2 numbers (1587, 120) came straight from data pulled in this run.");
  });

  it("lists a long card's numbers compactly", () => {
    const rows = Array.from({ length: 10 }, (_, i) => [String(1000 + i)]);
    recordFiguresFromPull(RUN, JSON.stringify(rows.flat()), "operator_db__query");
    recordShownRows(RUN, rows);
    const out = buildAnswerSources(RUN, "Ten months below.");
    expect(out.block).toContain("returned 1000, 1001, 1002, 1003, 1004, 1005 and 4 more");
  });

  it("keeps the sign: a negative rate is only a change, never a share", () => {
    const always = () => true;
    expect(workedOutFrom("-12%", ["88", "100"], always)).toBe("-12% = (88 - 100) / 100");
    expect(workedOutFrom("12%", ["88", "100"], always)).toBe("12% = 1 - 88 / 100");
  });

  it("judges uniqueness across every row that carries the rate", () => {
    recordFiguresFromPull(RUN, JSON.stringify([[120, 1587], [38, 500]]), "operator_db__query");
    recordShownRows(RUN, [
      ["120", "1587", "7.6%"],
      ["38", "500", "7.6%"],
    ]);
    const out = buildAnswerSources(RUN, "Both months converted at 7.6%.");
    expect(out.block).not.toContain("Worked out from those");
    expect(out.meta.unverified).toEqual(["7.6%"]);
  });

  it("stores only number cells, so a date or a label is never a figure", () => {
    recordShownRows(RUN, [["2026-09-01", "Order 123 for jane@example.com", "1,587", "$4,210", "-12%"]]);
    expect(shownRowsFor(RUN)).toEqual([["1,587", "$4,210", "-12%"]]);
  });

  it("forgets a run's cards on reset (a retry overwrites them)", () => {
    recordShownRows(RUN, [["100"]]);
    resetShownRows(RUN);
    expect(shownRowsFor(RUN)).toEqual([]);
  });

  it("pairs a row's cells even when they came from two queries", () => {
    recordFiguresFromPull(RUN, '{"signups": [1587, 2497]}', "operator_db__query");
    recordFiguresFromPull(RUN, '{"booked": [180, 166]}', "operator_db__query");
    recordShownRows(RUN, [["1,587", "180", "11.3%"]]);
    const out = buildAnswerSources(RUN, "July converted at 11.3%.");
    expect(out.block).toContain("Checks out against those: 11.3% = 180 / 1,587");
  });

  it("does not let card cells from other rows vouch for a prose rate", () => {
    recordFiguresFromPull(RUN, '{"revenue": 50, "visitors": 200}', "operator_db__query");
    recordShownRows(RUN, [["50"], ["200"]]);
    const out = buildAnswerSources(RUN, "Churn is 25%.");
    expect(out.meta.unverified).toEqual(["25%"]);
  });

  it("never credits a negative figure as returned by a pull of its absolute value", () => {
    recordFiguresFromPull(RUN, '{"x": 12}', "operator_db__query");
    const out = buildAnswerSources(RUN, "Bookings fell -12%.");
    expect(out.meta.unverified).toEqual(["-12%"]);
  });

  it("$70, 70% and 1,070 are three figures, never one key (bug #21)", () => {
    expect(answerFigures("Spend is $70 a day, 70% of budget, across 170 clicks.")).toEqual(["$70", "70%", "170"]);
    expect(answerFigures("Spend is $70 today and $70.00 yesterday.")).toEqual(["$70"]);
  });

  it("a money figure never borrows a percent's source (bug #21)", () => {
    recordFiguresFromPull(RUN, '{"ctr_pct": "70%"}', "google_ads__performance");
    const out = buildAnswerSources(RUN, "CTR was 70%. The new campaign now spends $70 a day.");
    expect(out.checked).toEqual([expect.objectContaining({ figure: "70%", kind: "pulled" })]);
    expect(out.meta.unverified).toEqual(["$70"]);
  });

  it("same digits, different number: a pull's 1070 never sources 10.70% or $10.70 (bug #21)", () => {
    recordFiguresFromPull(RUN, '{"clicks": 1070}', "google_ads__performance");
    const out = buildAnswerSources(RUN, "CTR was 10.70%, and 1,070 people clicked.");
    expect(out.checked).toEqual([expect.objectContaining({ figure: "1,070", kind: "pulled" })]);
    expect(out.meta.unverified).toEqual(["10.70%"]);
  });

  it("keeps a prose rate's minus, and not a range's dash", () => {
    expect(answerFigures("Bookings fell -12% while churn was 5-10%.")).toEqual(["-12%", "10%"]);
  });

  it("rounds a negative half away from zero", () => {
    expect(workedOutFrom("-13%", ["87.5", "100"], () => true)).toBe("-13% = (87.5 - 100) / 100");
    expect(workedOutFrom("-12%", ["87.5", "100"], () => true)).toBeNull();
  });

  it("treats one sum spelt two ways as one derivation", () => {
    recordFiguresFromPull(RUN, '{"b": 120, "s": 1587}', "operator_db__query");
    recordShownRows(RUN, [["120", "1587", "7.6%"]]);
    const out = buildAnswerSources(RUN, "120 of 1,587 booked (7.6%).");
    expect(out.block).toContain("Checks out against those: 7.6% = 120 / 1587");
  });

  it("lets the rate's own row decide before any wider search", () => {
    recordFiguresFromPull(RUN, JSON.stringify([[1587, 180], [2497, 166], [1853, 167]]), "operator_db__query");
    recordShownRows(RUN, [
      ["1,587", "180", "11.3%"],
      ["2,497", "166", "6.6%"],
      ["1,853", "167", "9.0%"],
    ]);
    const out = buildAnswerSources(RUN, "Here are the months.");
    expect(out.block).toContain("9.0% = 167 / 1,853");
    expect(out.block).not.toContain("Not in this run's data");
  });
});

describe("whole-column totals of a complete result", () => {
  const STATUS = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      ok: true,
      data: {
        collection: "trips",
        row_count: 5,
        truncated: false,
        rows: [
          { _id: "cancelled", n: 71, first: "2026-10-05T09:51:33.139Z" },
          { _id: "in_progress", n: 26, first: "2026-10-05T14:40:41.693Z" },
          { _id: "confirmed", n: 9, first: "2026-10-05T08:36:29.476Z" },
          { _id: "payout_processed", n: 2, first: "2026-10-06T16:54:31.027Z" },
          { _id: "pending", n: 2, first: "2026-10-08T10:34:29.548Z" },
        ],
        ...extra,
      },
    });
  const ANSWER =
    "**110 bookings were created this week, and 71 of them were cancelled.** " +
    "Still live: 39 bookings, which is 35% of the 110. Cancellation rate: about 65%.";

  it("credits the total and its share, keeps a partial sum flagged", () => {
    recordFiguresFromPull(RUN, STATUS(), "operator_db__query");
    const r = buildAnswerSources(RUN, ANSWER);
    const byFig = Object.fromEntries(r.checked.map((c) => [c.figure, c]));
    expect(byFig["110"]).toEqual({ figure: "110", kind: "worked_out", formula: "110 = total of n across 5 rows" });
    expect(byFig["65%"]).toEqual({ figure: "65%", kind: "worked_out", formula: "65% = 71 / 110" });
    expect(r.meta.unverified).toContain("35%");
    expect(r.meta.unverified).not.toContain("110");
    expect(r.meta.unverified).not.toContain("65%");
    expect(r.block).toContain("110 = total of n across 5 rows");
  });

  it("keeps a made-up number flagged", () => {
    recordFiguresFromPull(RUN, STATUS(), "operator_db__query");
    const r = buildAnswerSources(RUN, "We expect 412 bookings next week.");
    expect(r.meta.unverified).toEqual(["412"]);
  });

  it("never totals a truncated result", () => {
    recordFiguresFromPull(RUN, STATUS({ truncated: true }), "operator_db__query");
    expect(buildAnswerSources(RUN, ANSWER).meta.unverified).toEqual(expect.arrayContaining(["110", "65%"]));
  });

  it("never totals when row_count disagrees with the rows returned", () => {
    recordFiguresFromPull(RUN, STATUS({ row_count: 9 }), "operator_db__query");
    expect(buildAnswerSources(RUN, ANSWER).meta.unverified).toContain("110");
  });

  it("never totals a bounded count (row_count_exact false)", () => {
    recordFiguresFromPull(RUN, STATUS({ row_count_exact: false }), "operator_db__query");
    expect(buildAnswerSources(RUN, ANSWER).meta.unverified).toContain("110");
  });

  it("does not add a total to what the run read", () => {
    recordFiguresFromPull(RUN, STATUS(), "operator_db__query");
    expect(figureWasRead(RUN, "110")).toBe(false);
    expect(pullsForFigure(RUN, "110")).toEqual([]);
  });

  it("leaves a share flagged when two columns reach it", () => {
    recordFiguresFromPull(
      RUN,
      JSON.stringify({ truncated: false, rows: [{ a: 3, b: 10 }, { a: 3, b: 10 }] }),
      "operator_db__query",
    );
    expect(buildAnswerSources(RUN, "Half of them, 50%.").meta.unverified).toContain("50%");
  });

  it("never totals identifier or calendar columns", () => {
    recordFiguresFromPull(
      RUN,
      JSON.stringify({ truncated: false, rows: [{ user_id: 40, year: 2025, v: 1 }, { user_id: 60, year: 2026, v: 2 }] }),
      "operator_db__query",
    );
    expect(buildAnswerSources(RUN, "User ids add to 100.").meta.unverified).toContain("100");
  });

  it("totals a money column exactly at its decimals", () => {
    recordFiguresFromPull(
      RUN,
      JSON.stringify({ truncated: false, rows: [{ plan: "pro", mrr: 1200.5 }, { plan: "team", mrr: 340.25 }, { plan: "solo", mrr: 59.25 }] }),
      "operator_db__query",
    );
    const r = buildAnswerSources(RUN, "Total MRR is $1,600.00, and Pro is 75.0% of it.");
    const byFig = Object.fromEntries(r.checked.map((c) => [c.figure, c]));
    expect(byFig["$1,600.00"]?.kind).toBe("worked_out");
    expect(byFig["75.0%"]).toEqual({ figure: "75.0%", kind: "worked_out", formula: "75.0% = 1,200.50 / 1,600.00" });
  });

  it("compares a total by value, not by digits", () => {
    recordFiguresFromPull(RUN, STATUS(), "operator_db__query");
    expect(buildAnswerSources(RUN, "Each costs $1.10.").meta.unverified).toEqual(["$1.10"]);
  });

  it("never totals a non-database tool's rows or a rate column", () => {
    const rows = JSON.stringify({ truncated: false, rows: [{ day: 1, cpm_usd: 20 }, { day: 2, cpm_usd: 30 }] });
    recordFiguresFromPull(RUN, rows, "meta_ads__daily_series");
    recordFiguresFromPull(RUN, rows, "operator_db__query");
    expect(buildAnswerSources(RUN, "CPM was $50.00 this week.").meta.unverified).toEqual(["$50.00"]);
  });

  it("credits a named query tool, an exact total only, and a word-wise column filter", () => {
    recordFiguresFromPull(
      RUN,
      JSON.stringify({ truncated: false, rows: [{ corporate_revenue: 400, bookings_n: 12 }, { corporate_revenue: 700, bookings_n: 18 }] }),
      "operator_db__query_bookings",
    );
    const r = buildAnswerSources(RUN, "Revenue was $1,100 from 30 bookings; not $1,100.04.");
    const byFig = Object.fromEntries(r.checked.map((c) => [c.figure, c]));
    expect(byFig["$1,100"]?.kind).toBe("worked_out");
    expect(r.meta.unverified).toContain("$1,100.04");
  });
});

