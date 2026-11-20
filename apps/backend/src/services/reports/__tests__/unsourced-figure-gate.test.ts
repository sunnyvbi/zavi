
import { describe, it, expect, beforeEach } from "vitest";
import {
  assertFiguresWereRead,
  unsourcedFiguresIn,
  figureGuardedText,
  unreadSourcesIn,
  unsourcedRuleClaimsIn,
  _resetRefusals,
} from "../unsourced-figure-gate";
import { recordFigures, recordUrls, clearFigures, figureWasRead } from "@/services/agents/engine/figure-ledger";

const RUN = "run-figure-gate";

const TOOL_RESULT = JSON.stringify({
  communities: [{ name: "SomeTown", subscribers: 270219 }],
  posts: [{ title: "a post", score: 4832, comments: 332 }],
});

beforeEach(() => {
  clearFigures(RUN);
  _resetRefusals(RUN);
  recordFigures(RUN, TOOL_RESULT);
});

describe("unsourced figure gate", () => {
  it("refuses the fabricated citation that shipped", () => {
    const body =
      "Ad group three targets r/HomeThings. Built from that community's tankless thread, 998 score and 1,414 comments. It has 4,832,820 subscribers.";
    const bad = unsourcedFiguresIn(RUN, body);
    expect(bad).toContain("998");
    expect(bad).toContain("1,414");
    expect(() => assertFiguresWereRead(RUN, body)).toThrowError(/artifact_unsourced_figures|Refusing to render/);
  });

  it("lets through every figure the run actually read, in either format", () => {
    const body = "r/SomeTown has 270,219 subscribers. The top post scored 4832 with 332 comments.";
    expect(unsourcedFiguresIn(RUN, body)).toEqual([]);
    expect(() => assertFiguresWereRead(RUN, body)).not.toThrow();
  });

  it("allows a rounding at the same magnitude but not a number assembled from a smaller one", () => {
    expect(figureWasRead(RUN, "270219")).toBe(true);
    expect(figureWasRead(RUN, "270,000")).toBe(true);
    expect(figureWasRead(RUN, "270,300")).toBe(false);
    expect(figureWasRead(RUN, "285,000")).toBe(false);
    expect(figureWasRead(RUN, "270,219")).toBe(true);
    expect(figureWasRead(RUN, "4,832,820")).toBe(false);
    expect(figureWasRead(RUN, "4832")).toBe(true);
    clearFigures(RUN);
    recordFigures(RUN, JSON.stringify({ impressions: 4812345 }));
    expect(figureWasRead(RUN, "4,832,820")).toBe(false);
    expect(figureWasRead(RUN, "4,800,000")).toBe(true);
  });

  it("does not judge sentences that make no outside attribution", () => {
    const body = "Start at $250 a week. Expect 1,850 impressions a day at that budget.";
    expect(unsourcedFiguresIn(RUN, body)).toEqual([]);
  });

  it("does not fire when the run recorded nothing", () => {
    clearFigures("empty-run");
    const body = "r/Anything has 4,832,820 subscribers.";
    expect(unsourcedFiguresIn("empty-run", body)).toEqual([]);
    expect(() => assertFiguresWereRead("empty-run", body)).not.toThrow();
  });

  it("ignores years and short numbers", () => {
    const body = "Their r/Somewhere account has posted since 2019 and has 12 reviews.";
    expect(unsourcedFiguresIn(RUN, body)).toEqual([]);
  });

  it("names the offending figures in the error so the model can fix them", () => {
    try {
      assertFiguresWereRead(RUN, "r/Place has 4,832,820 subscribers.");
      throw new Error("should have thrown");
    } catch (e) {
      expect(String((e as Error).message)).toContain("4,832,820");
    }
  });
});

describe("what the gate must never touch", () => {
  beforeEach(() => {
    clearFigures(RUN);
    recordFigures(RUN, TOOL_RESULT);
  });

  it("leaves a call to action alone", () => {
    for (const body of [
      "Call 555-0100 or visit acme.com to book today.",
      "Visit us at 1420 Oak St, Austin TX 78704 - acme.com",
      "Packages from $1,250 at acme.com.",
      "Call (555) 010-0199 today.",
      "Open 9 to 5, seven days. Serving 3 counties since 2009.",
      "Book by 12/31 for $199 off, see terms at acme.com/terms.",
    ]) {
      expect([body, unsourcedFiguresIn(RUN, body)]).toEqual([body, []]);
    }
  });

  it("still catches a count attributed to an outside surface", () => {
    expect(unsourcedFiguresIn(RUN, "That community has 4,832,820 subscribers.")).toEqual(["4,832,820"]);
    expect(unsourcedFiguresIn(RUN, "a thread with 998 score and 1,414 comments")).toEqual(["998", "1,414"]);
    expect(unsourcedFiguresIn(RUN, "They have 2,300 followers there.")).toEqual(["2,300"]);
  });

  it("accepts a count the run really read, written either way round", () => {
    expect(unsourcedFiguresIn(RUN, "r/SomeTown has 270,219 subscribers.")).toEqual([]);
    expect(unsourcedFiguresIn(RUN, "subscribers: 270219")).toEqual([]);
    expect(unsourcedFiguresIn(RUN, "The post has 332 comments.")).toEqual([]);
  });
});

describe("the refusal never becomes a dead end", () => {
  const R = "run-refusal-budget";
  beforeEach(() => {
    clearFigures(R);
    _resetRefusals(R);
    recordFigures(R, TOOL_RESULT);
  });

  const bad = "Ad group three targets that community. It has 4,832,820 subscribers. Budget stays at $5/day.";

  it("refuses twice, then strips and renders", () => {
    expect(() => figureGuardedText(R, bad)).toThrowError(/Refusing to render/);
    expect(() => figureGuardedText(R, bad)).toThrowError(/Refusing to render/);
    const out = figureGuardedText(R, bad);
    expect(out).not.toContain("4,832,820");
    expect(out).toContain("Budget stays at $5/day.");
    expect(out).toContain("Ad group three targets that community.");
  });

  it("logs what it removed when it strips", () => {
    const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const log = (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta });
    for (let i = 0; i < 2; i += 1) {
      try { figureGuardedText(R, bad, log); } catch {  }
    }
    figureGuardedText(R, bad, log);
    expect(logs.at(-1)?.meta).toMatchObject({ figures: 1 });
  });

  it("leaves clean copy untouched and costs it no budget", () => {
    const clean = "r/SomeTown has 270,219 subscribers. Budget stays at $5/day.";
    expect(figureGuardedText(R, clean)).toBe(clean);
    expect(figureGuardedText(R, clean)).toBe(clean);
    expect(figureGuardedText(R, clean)).toBe(clean);
    expect(() => figureGuardedText(R, bad)).toThrowError(/Refusing to render/);
  });
});

describe("numbers are recorded one at a time", () => {
  const R2 = "run-number-parsing";
  beforeEach(() => { clearFigures(R2); _resetRefusals(R2); });

  it("splits JSON arrays, CSV rows and space-separated lists", () => {
    recordFigures(R2, '{"stats":[4832, 332, 998]}');
    expect(unsourcedFiguresIn(R2, "That thread scored 998 with 332 comments.")).toEqual([]);
    clearFigures(R2);
    recordFigures(R2, "7,998,1414");
    expect(unsourcedFiguresIn(R2, "a post with 998 score")).toEqual([]);
    clearFigures(R2);
    recordFigures(R2, "998 4832 270219");
    expect(unsourcedFiguresIn(R2, "998 upvotes")).toEqual([]);
  });

  it("still treats a thousands separator as one number", () => {
    recordFigures(R2, '{"subscribers":"4,832,820"}');
    expect(unsourcedFiguresIn(R2, "It has 4,832,820 subscribers.")).toEqual([]);
    expect(unsourcedFiguresIn(R2, "It has 4,832 subscribers.")).toEqual(["4,832"]);
  });

  it("does not merge the numbers in a flattened table row", () => {
    recordFigures(R2, '{"rows":[["SomeTown", 270219, 84120]]}');
    expect(unsourcedFiguresIn(R2, "r/SomeTown 270,219 subscribers 84,120 posts")).toEqual([]);
  });
});

describe("a source said to be read this run must have been read", () => {
  const R = "run-provenance";
  beforeEach(() => {
    clearFigures(R);
    _resetRefusals(R);
    recordUrls(R, JSON.stringify({ final_url: "https://acme.test/services/", links: ["https://acme.test/contact"] }));
  });

  it("refuses a page the run never read but claims it did", () => {
    const text = "Per the client's post at https://acme.test/blog/2027-rule/, confirmed on site this run, the rule starts in 2027.";
    expect(unreadSourcesIn(R, text)).toEqual(["https://acme.test/blog/2027-rule/"]);
    expect(() => figureGuardedText(R, text)).toThrowError(/did not read|Refusing/);
  });

  it("accepts a page the run did read, in any spelling", () => {
    for (const u of ["https://acme.test/services/", "http://www.acme.test/services", "https://acme.test/services/?utm=x"]) {
      expect([u, unreadSourcesIn(R, `We read ${u} this run and confirmed the hours.`)]).toEqual([u, []]);
    }
  });

  it("accepts a deeper path under a page the run read", () => {
    expect(unreadSourcesIn(R, "Confirmed this run at https://acme.test/services/drains.")).toEqual([]);
  });

  it("says nothing about a URL that makes no provenance claim", () => {
    expect(unreadSourcesIn(R, "Send traffic to https://acme.test/book-now for the campaign.")).toEqual([]);
  });

  it("does not judge a run that recorded no URLs at all", () => {
    clearFigures("no-urls");
    expect(unreadSourcesIn("no-urls", "Confirmed this run at https://anything.test/x.")).toEqual([]);
  });
});

describe("a law, ban or mandate must cite a page this run read", () => {
  const R = "run-rules";
  beforeEach(() => {
    clearFigures(R);
    _resetRefusals(R);
    recordUrls(R, JSON.stringify({ final_url: "https://airdistrict.test/rule-9-6/" }));
  });

  it("refuses a bare regulatory claim with a date", () => {
    const text = "The Bay Area just banned gas water heaters starting in 2027, so homeowners must replace theirs.";
    expect(unsourcedRuleClaimsIn(R, text)).toHaveLength(1);
    expect(() => figureGuardedText(R, text)).toThrowError(/Refusing to render/);
  });

  it("accepts the same claim when it cites a page the run read", () => {
    const text = "Per https://airdistrict.test/rule-9-6/, the rule takes effect in 2027 for replacements.";
    expect(unsourcedRuleClaimsIn(R, text)).toEqual([]);
  });

  it("ignores ordinary copy that happens to contain a year", () => {
    for (const s of [
      "Serving San Jose homeowners since 2009.",
      "Book by December for the winter tune-up.",
      "Our licence was renewed in 2026.",
      "We replaced 40 water heaters in 2025.",
    ]) {
      expect([s, unsourcedRuleClaimsIn(R, s)]).toEqual([s, []]);
    }
  });

  it("ignores a rule claim with no date, which other rules already govern", () => {
    expect(unsourcedRuleClaimsIn(R, "Local code requires a permit for this work.")).toEqual([]);
  });

  it("strips the claim rather than stranding the run, after the refusal budget", () => {
    const text = "Intro line. The county banned these units from 2027. Book a free estimate today.";
    for (let i = 0; i < 2; i += 1) {
      try { figureGuardedText(R, text); } catch {  }
    }
    const out = figureGuardedText(R, text);
    expect(out).not.toContain("banned");
    expect(out).toContain("Book a free estimate today.");
  });
});
