
import { describe, it, expect, beforeEach } from "vitest";
import {
  clearFigures,
  figureIsDecisionSource,
  ownerTyped,
  pullsForFigure,
  recordFiguresFromPull,
  recordInputFigures,
  recordOwnerFigures,
  withholdFigures,
} from "@/services/agents/engine/figure-ledger";
import { buildAnswerSources } from "@/services/agents/answer-sources";
import { buildFigureReceipts } from "@/services/agents/figure-receipts";

const RUN = "33333333-3333-4333-8333-333333333333";
beforeEach(() => clearFigures(RUN));

describe("owner-typed figures", () => {
  const ASK = "our weekly bookings were 1,500 last month and 70% repeat. what should we do?";

  it("labels a restated owner figure 'reported', not unverified", () => {
    recordOwnerFigures(RUN, ASK);
    recordFiguresFromPull(RUN, '{"rows":[{"signups":412}]}', "operator_db__query");
    const r = buildAnswerSources(RUN, "With 1,500 bookings a week and 70% repeat, and 412 signups, push referrals.");
    expect(r.checked).toEqual(
      expect.arrayContaining([
        { figure: "1,500", kind: "reported" },
        { figure: "70%", kind: "reported" },
        expect.objectContaining({ figure: "412", kind: "pulled" }),
      ]),
    );
    expect(r.meta.unverified).toEqual([]);
    expect(r.block).toContain("From you: 1,500, 70%");
  });

  it("a pull's bare 70 or $70 does not take the owner's 70%; a pull's own 70% does", () => {
    recordOwnerFigures(RUN, ASK);
    recordFiguresFromPull(RUN, '{"orders": 70, "price": "$70"}', "operator_db__query");
    expect(buildAnswerSources(RUN, "Repeat is 70%.").checked).toEqual([{ figure: "70%", kind: "reported" }]);
    clearFigures(RUN);
    recordOwnerFigures(RUN, ASK);
    recordFiguresFromPull(RUN, '{"note": "repeat rate 70%"}', "operator_db__query");
    expect(buildAnswerSources(RUN, "Repeat is 70%.").checked[0]).toMatchObject({ figure: "70%", kind: "pulled" });
  });

  it("a tool source wins over the owner's word", () => {
    recordOwnerFigures(RUN, ASK);
    recordFiguresFromPull(RUN, '{"bookings": 1500}', "operator_db__query");
    const r = buildAnswerSources(RUN, "You had 1,500 bookings.");
    expect(r.checked).toEqual([expect.objectContaining({ figure: "1,500", kind: "pulled" })]);
  });

  it("a pull that only echoes the owner's number does not take it", () => {
    recordOwnerFigures(RUN, "Our $1,000 budget, and the target is 1000 lab tests in 6 months.");
    recordFiguresFromPull(RUN, '{"value": 2437, "inputs": {"target": {"value": 1000}}}', "growth__compute");
    recordFiguresFromPull(RUN, "Plans from $1,000 a month", "web_search__search");
    const r = buildAnswerSources(RUN, "Hitting 1,000 lab tests on a $1,000 budget needs 2,437 visits.");
    expect(r.checked).toEqual(
      expect.arrayContaining([
        { figure: "1,000", kind: "reported" },
        { figure: "$1,000", kind: "reported" },
        expect.objectContaining({ figure: "2,437", kind: "pulled", source: "A calculation" }),
      ]),
    );
    expect(r.block).toContain("From you: 1,000, $1,000");
    expect(r.block).not.toContain("connected tool");
  });

  it("an echoed input under a named key is still the owner's; a binding pull is cited alone", () => {
    recordOwnerFigures(RUN, "target is 1,000 and we had 1,500 bookings");
    recordFiguresFromPull(RUN, '{"value": 2437, "inputs": {"target": 1000}}', "growth__compute");
    recordFiguresFromPull(RUN, "1,500 locations nationwide", "web_search__search");
    recordFiguresFromPull(RUN, '{"bookings": 1500}', "operator_db__query");
    const r = buildAnswerSources(RUN, "Target is 1,000. You had 1,500 bookings.");
    expect(r.checked).toEqual([
      { figure: "1,000", kind: "reported" },
      expect.objectContaining({ figure: "1,500", kind: "pulled", tool: "operator_db__query" }),
    ]);
    expect(r.block).not.toContain("Web search");
  });

  it("a metric read's total confirms the owner's count; its row count does not", () => {
    recordOwnerFigures(RUN, "we had 8,200 clicks and 130 new customers this month");
    recordFiguresFromPull(
      RUN,
      JSON.stringify({ metric_id: "ads.clicks", unit: "count", total: 8200, series: [{ date: "2026-10-01", value: 8200 }], receipt: { row_count: 130 } }),
      "growth__get_metric",
    );
    const r = buildAnswerSources(RUN, "You had 8,200 clicks and 130 new customers.");
    expect(r.checked).toEqual([
      expect.objectContaining({ figure: "8,200", kind: "pulled", source: "Your metrics" }),
      { figure: "130", kind: "reported" },
    ]);
  });

  it("a pagination total is still not a measure", () => {
    recordOwnerFigures(RUN, "we have 1,200 users");
    recordFiguresFromPull(RUN, '{"items": [], "pagination": {"total": 1200}}', "posthog__list_people");
    expect(buildAnswerSources(RUN, "You have 1,200 users.").checked).toEqual([{ figure: "1,200", kind: "reported" }]);
  });

  it("the starter suggestion in the controls read is not the founder's saved goals", () => {
    recordOwnerFigures(RUN, "start with a $50 test, cap CPA at $25, check back in 24 hours");
    const starter = {
      max_cpa_usd: 25, min_spend_usd: 50, exploration_percent: 10, step_percent: 20, reporting_delay_hours: 24,
      explanation: "Starter CPA is $25, paired with the existing $50 no-result evidence floor. exploration: 10%; budget steps: 20%",
    };
    recordFiguresFromPull(RUN, JSON.stringify({ policy: null, recommendation: starter, experiments: [] }), "growth__read_business_controls");
    recordOwnerFigures(RUN, "exploration 10%, steps of 20%");
    const r = buildAnswerSources(RUN, "Your test budget is $50 and your CPA cap is $25.");
    expect(r.checked).toEqual([
      { figure: "$50", kind: "reported" },
      { figure: "$25", kind: "reported" },
    ]);
    expect(buildAnswerSources(RUN, "Exploration is 10% and steps are 20%.").checked).toEqual([
      { figure: "10%", kind: "reported" },
      { figure: "20%", kind: "reported" },
    ]);
    expect(r.block).not.toContain("goals and limits");
    clearFigures(RUN);
    recordOwnerFigures(RUN, "cap CPA at $40");
    recordFiguresFromPull(RUN, JSON.stringify({ policy: { ...starter, max_cpa_usd: 40 }, recommendation: starter }), "growth__read_business_controls");
    expect(buildAnswerSources(RUN, "Your CPA cap is $40.").checked[0]).toMatchObject({ figure: "$40", kind: "pulled", source: "Your goals and limits" });
  });

  it("a number only a tool returned is still the tool's", () => {
    recordOwnerFigures(RUN, "Our $1,000 budget.");
    recordFiguresFromPull(RUN, '{"value": 1000}', "growth__compute");
    expect(buildAnswerSources(RUN, "That is 1,000 tests.").checked[0]).toMatchObject({ figure: "1,000", kind: "pulled" });
  });

  it("credits the founder's saved goals as 'your goals and limits'", () => {
    recordFiguresFromPull(RUN, '{"policy": {"monthly_budget_usd": 2500, "target_orders": 2500}}', "mcp__server__growth__read_business_controls");
    expect(buildAnswerSources(RUN, "Your target is 2,500 orders.").checked[0]).toMatchObject({
      figure: "2,500",
      kind: "pulled",
      source: "Your goals and limits",
    });
  });

  it("never matches a number that only shares digits, or another unit", () => {
    recordOwnerFigures(RUN, "we did 1,500 bookings, 12.5% churn, $70 CAC");
    recordFiguresFromPull(RUN, '{"x": 9999}', "operator_db__query");
    for (const f of ["500", "15,000", "1,500,000", "125", "70%", "70"]) {
      expect(ownerTyped(RUN, f)).toBe(false);
    }
    for (const f of ["1,500", "1500", "12.5%", "$70"]) expect(ownerTyped(RUN, f)).toBe(true);
    const r = buildAnswerSources(RUN, "That is 15,000 a quarter and 125 a day.");
    expect(r.meta.unverified).toEqual(["15,000", "125"]);
  });

  it("skips ids and ambiguous comma groups", () => {
    recordOwnerFigures(RUN, "order A1500 and 1,5000 units");
    expect(ownerTyped(RUN, "1500")).toBe(false);
    expect(ownerTyped(RUN, "1,500")).toBe(false);
    expect(ownerTyped(RUN, "5000")).toBe(false);
  });

  it("is not a live pull for the decision gate", () => {
    recordInputFigures(RUN, "Goal: 612 hosts");
    recordOwnerFigures(RUN, "Goal: 612 hosts");
    withholdFigures(RUN, ["612"]);
    expect(pullsForFigure(RUN, "612")).toEqual([]);
    expect(figureIsDecisionSource(RUN, "612")).toBe(false);
  });

  it("labels owner figures even when the run pulled nothing, and calls nothing missing", () => {
    recordOwnerFigures(RUN, ASK);
    const r = buildAnswerSources(RUN, "At 1,500 bookings a week with 70% repeat, referrals beat ads. Budget 300 for a test.");
    expect(r.checked).toEqual([
      { figure: "1,500", kind: "reported" },
      { figure: "70%", kind: "reported" },
    ]);
    expect(r.block).toBeNull();
    expect(r.meta.unverified).toEqual([]);
  });

  it("skips phone numbers, dates, ranges and $1.5k instead of splitting them", () => {
    recordOwnerFigures(RUN, "call 415-555-0134 on 10/12, aim for 5-10% and $1.5k");
    for (const f of ["555", "134", "0134", "10%", "12", "$1.5", "$1", "5%"]) expect(ownerTyped(RUN, f)).toBe(false);
  });

  it("keeps real figures that only look long, and skips NBSP and +country phones", () => {
    recordOwnerFigures(RUN, "impressions 1284039281, target 1000000000, weekly signups 12 18 15 22 19 30 28, call 415 555 0134 1500 times");
    for (const f of ["1284039281", "1000000000", "18", "1500"]) expect(ownerTyped(RUN, f)).toBe(true);
    for (const f of ["415", "555", "134"]) expect(ownerTyped(RUN, f)).toBe(false);
    recordOwnerFigures(RUN, "ring 650\u00A0555\u00A00199 or +44 20 7946 0958");
    for (const f of ["650", "199", "7946", "958", "44"]) expect(ownerTyped(RUN, f)).toBe(false);
  });

  it("skips phones with wide or no gaps and a leading 1", () => {
    recordOwnerFigures(RUN, "415  555  0134, 415--555--0134, 415 - 555 - 0134, (415)555-0134, 1-800-555-0199");
    for (const f of ["415", "555", "134", "-555", "-134", "800", "199"]) expect(ownerTyped(RUN, f)).toBe(false);
  });

  it("does not treat mismatched brackets as an area code", () => {
    recordOwnerFigures(RUN, "codes (415] 555 0134 and [212) 555 0134");
    expect(ownerTyped(RUN, "415")).toBe(true);
    expect(ownerTyped(RUN, "212")).toBe(true);
  });

  it("skips bracketed and spaced phones and en-dash ranges", () => {
    recordOwnerFigures(RUN, "ring (415) 555 0134, [415] 555 0134 or 415 555 0134; target 5\u201310% and 20\u201330 orders");
    for (const f of ["415", "555", "134", "10%", "5", "20", "30"]) expect(ownerTyped(RUN, f)).toBe(false);
  });

  it("becomes an 'From you' receipt", () => {
    recordOwnerFigures(RUN, ASK);
    recordFiguresFromPull(RUN, '{"x": 9999}', "operator_db__query");
    const r = buildAnswerSources(RUN, "1,500 bookings a week.");
    expect(buildFigureReceipts("t1", RUN, r.checked)).toEqual([
      { figure: "1,500", kind: "reported", source: "From you", source_slug: "founder_reported" },
    ]);
  });
});

describe("chip source ranking", () => {
  it("credits the database over company notes that returned the same figure first", () => {
    recordFiguresFromPull(RUN, "note: average order $186", "mcp__server__memory__search");
    recordFiguresFromPull(RUN, '{"rows":[{"aov":186}]}', "mcp__server__operator_db__query");
    const r = buildAnswerSources(RUN, "Average order is $186.");
    expect(r.checked).toEqual([
      expect.objectContaining({ figure: "$186", kind: "pulled", source: "Your database: a query", tool: "mcp__server__operator_db__query" }),
    ]);
  });

  it("keeps the database even after three notes reads filled the figure's slots", () => {
    for (let i = 0; i < 3; i++) recordFiguresFromPull(RUN, "note: 186 orders", "memory__search");
    recordFiguresFromPull(RUN, '{"n":186}', "operator_db__query");
    expect(pullsForFigure(RUN, "186").map((p) => p.tool)).toContain("operator_db__query");
    expect(buildAnswerSources(RUN, "186 orders.").checked[0]).toMatchObject({ tool: "operator_db__query" });
  });

  it("falls back to company notes when nothing else returned it", () => {
    recordFiguresFromPull(RUN, "note: 186 orders", "memory__search");
    expect(buildAnswerSources(RUN, "186 orders.").checked[0]).toMatchObject({ source: "Company notes" });
  });
});

describe("the owner's prices in a list (comma after each price)", () => {
  it("prices the owner typed read 'From you', never 'check them before acting'", () => {
    recordFiguresFromPull(RUN, "note: 186 orders", "memory__search");
    recordOwnerFigures(RUN, "Our prices: standard clean $140, deep clean $280, move-out clean $420.");
    const r = buildAnswerSources(RUN, "Lead with the deep clean at $280, keep standard at $140, and push move-out at $420.");
    expect(r.meta.unverified).toEqual([]);
    expect(r.checked).toEqual([
      { figure: "$280", kind: "reported" },
      { figure: "$140", kind: "reported" },
      { figure: "$420", kind: "reported" },
    ]);
    expect(r.block).toContain("From you: $280, $140, $420");
    expect(r.block).toContain("3 are yours");
    expect(r.block ?? "").not.toMatch(/check them/i);
  });

  it("a figure with a trailing comma, stop or bracket still matches what the owner typed", () => {
    recordOwnerFigures(RUN, "We charge $140 and $1,200 for a month.");
    for (const f of ["$140,", "$140.", "$140;", "$140)", "$1,200,"]) expect(ownerTyped(RUN, f)).toBe(true);
    expect(ownerTyped(RUN, "$1,20")).toBe(false);
  });

  it("a price the owner never typed is still flagged", () => {
    recordFiguresFromPull(RUN, "note: 186 orders", "memory__search");
    recordOwnerFigures(RUN, "Our prices: standard clean $140, deep clean $280.");
    const r = buildAnswerSources(RUN, "Charge $140, $280, and $999 for move-out.");
    expect(r.meta.unverified).toEqual(["$999"]);
  });
});
