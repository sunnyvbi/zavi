import { describe, expect, it } from "vitest";
import { isProposalAt, proposalKey } from "./proposals";

function judge(text: string): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  const proposed = new Set<string>();
  for (const m of text.matchAll(/\$\s?\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s?%/g)) {
    const yes = isProposalAt(text, m.index ?? 0, m[0], proposed);
    const key = proposalKey(m[0]);
    if (yes && key) proposed.add(key);
    out.push([m[0], yes]);
  }
  return out;
}

describe("isProposalAt", () => {
  it("the 2026-10-17 cgo recommendation: proposed budgets yes, totals and caps no", () => {
    const text =
      "**Recommended next action:** Cut Google Atlanta to $10 a day and block the other companies' names. " +
      "Raise Meta Atlanta to **$50** a day. Total spend stays at $60 a day, and the stop lines stay the same " +
      "($300 on Meta, $200 on Google). At $50 a day, Meta hits $300 around Oct 21.";
    expect(judge(text)).toEqual([
      ["$10", true],
      ["$50", true],
      ["$60", false],
      ["$300", false],
      ["$200", false],
      ["$50", true],
      ["$300", false],
    ]);
  });

  it("modal and recommendation phrasing count", () => {
    expect(judge("I'd raise the Meta budget to $50 a day.")).toEqual([["$50", true]]);
    expect(judge("We should lower the bid to $2.50.")).toEqual([["$2.50", true]]);
    expect(judge("I recommend you cut the cap to 20%.")).toEqual([["20%", true]]);
    expect(judge("If you say yes, I'll move Google to $15 a day.")).toEqual([["$15", true]]);
  });

  it("reported changes, negations and plain claims keep their mark", () => {
    expect(judge("We cut spend to $10 last week.")).toEqual([["$10", false]]);
    expect(judge("Cut spend to $10 yesterday.")).toEqual([["$10", false]]);
    expect(judge("Don't raise Meta to $50 yet.")).toEqual([["$50", false]]);
    expect(judge("Meta spent $50 yesterday.")).toEqual([["$50", false]]);
    expect(judge("Spend went up to $50 on Tuesday.")).toEqual([["$50", false]]);
    expect(judge("Up to $50 of spend went to competitor searches.")).toEqual([["$50", false]]);
    expect(judge("The budget was raised to $40 on Oct 14.")).toEqual([["$40", false]]);
    expect(judge("Google set the CPC to $3.09 automatically.")).toEqual([["$3.09", false]]);
    expect(judge("Of the spend, $17.31 of $38.24 went to people searching for other companies.")).toEqual([
      ["$17.31", false],
      ["$38.24", false],
    ]);
  });

  it("a change from a measured value keeps the measured value marked", () => {
    expect(judge("Raise Meta from $40 to $50 a day.")).toEqual([
      ["$40", false],
      ["$50", true],
    ]);
  });

  it("the scenario echo needs the same value proposed earlier in the reply", () => {
    expect(judge("At $50 a day, Meta hits $300 around Oct 21.")).toEqual([
      ["$50", false],
      ["$300", false],
    ]);
    expect(judge("Raise Meta to $40 a day. At $50 a day, Meta hits $300.")).toEqual([
      ["$40", true],
      ["$50", false],
      ["$300", false],
    ]);
  });

  it("a clause ends at a sentence boundary, not at a decimal point", () => {
    expect(judge("CPC is $1.14. Raise Meta to $50.")).toEqual([
      ["$1.14", false],
      ["$50", true],
    ]);
  });

  it("a change verb that does not govern the 'to' is not a proposal", () => {
    expect(judge("I recommend investigating why Google cut the budget to $10.")).toEqual([["$10", false]]);
    expect(judge("Raise a ticket if spend goes to $50.")).toEqual([["$50", false]]);
    expect(judge("Set a reminder when CPA goes to $50.")).toEqual([["$50", false]]);
    expect(judge("Double-check spend to $50 before Friday.")).toEqual([["$50", false]]);
  });

  it("fix-delta inputs: subordinate clauses and 'that' after a modal", () => {
    expect(judge("I recommend we raise awareness, since Google cut budget to $10.")).toEqual([["$10", false]]);
    expect(judge("Raise a ticket about spend to $50.")).toEqual([["$50", false]]);
    expect(judge("I recommend that you raise the budget to $50.")).toEqual([["$50", true]]);
  });

  it("a change word used as a noun does not block the proposal", () => {
    expect(judge("Raise the daily spend cap to $50.")).toEqual([["$50", true]]);
  });

  it("a condition or another subject's verb inside the object blocks it", () => {
    expect(judge("Raise an alert should spend drop to $50.")).toEqual([["$50", false]]);
    expect(judge("We should raise bids wherever competitors cut to $8.")).toEqual([["$8", false]]);
  });

  it("list items, quotes and chained instructions", () => {
    expect(judge("- Cut Google to $10 a day.")).toEqual([["$10", true]]);
    expect(judge("1. Raise Meta to $50 a day.")).toEqual([["$50", true]]);
    expect(judge("> Lower the bid to $2 now.")).toEqual([["$2", true]]);
    expect(judge("Cut Google to $10 a day and raise Meta to $50.")).toEqual([
      ["$10", true],
      ["$50", true],
    ]);
  });

  it("stays linear on a long clause with no punctuation", () => {
    const text = "$10 ".repeat(6000);
    const t0 = Date.now();
    judge(text);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("counts are never proposals", () => {
    expect(isProposalAt("Raise clicks to 500 a day.", 18, "500")).toBe(false);
  });
});
