import { describe, it, expect, vi } from "vitest";
import { buildDossier, parseCritique, reviewAndRevisePlan, type PlanCritique, type ReviewDeps } from "../plan-review";
import type { ParsedStrategy } from "../strategy";

const strategy = (label: string): ParsedStrategy => ({
  north_star: { metric: "bookings", why: label, provenance: "" },
  constraint: {
    statement: `constraint ${label}`,
    lever_family: "activation",
    evidence: 'Reviews repeat the same line: "setup took a full afternoon", and 60% stop at step 3.',
    confidence: "medium",
  },
  channel_bets: [],
  goal: { objective: "Reach 40 new paying customers a week by Dec 16", target_metric: "new_customers", target_value: 40, due_date: "2026-12-16" },
  gaps: [],
  unmeasured: [],
  basis_evidence: [],
});

const envelope = (label: string) => `<strategy>${JSON.stringify(strategy(label))}</strategy>`;

const critiqueOf = (overall: number, pass = false): PlanCritique => ({
  scores: { constraint: overall, target: overall, actions: overall, effects: overall, grounding: overall },
  overall,
  issues: [],
  unsupported_facts: [],
  pass,
});

function deps(scores: Record<string, PlanCritique>, over: Partial<ReviewDeps> = {}): ReviewDeps & { revisions: number } {
  let n = 0;
  const d = {
    revisions: 0,
    now: () => 0,
    critique: async ({ strategy: s }: { strategy: ParsedStrategy }) => scores[s.north_star.why],
    revise: async () => {
      n += 1;
      d.revisions = n;
      return envelope(`rev${n}`);
    },
    ...over,
  };
  return d;
}

describe("reviewAndRevisePlan", () => {
  it("returns the draft untouched when the critic passes it", async () => {
    const d = deps({ draft: critiqueOf(9, true) });
    const out = await reviewAndRevisePlan({ strategy: strategy("draft") }, d);
    expect(out.strategy.north_star.why).toBe("draft");
    expect(out.stopped).toBe("passed");
    expect(d.revisions).toBe(0);
  });

  it("revises once and keeps the passing revision", async () => {
    const d = deps({ draft: critiqueOf(5), rev1: critiqueOf(9, true) });
    const out = await reviewAndRevisePlan({ strategy: strategy("draft") }, d);
    expect(out.strategy.north_star.why).toBe("rev1");
    expect(out.stopped).toBe("passed");
    expect(out.passes.map((p) => p.overall)).toEqual([5, 9]);
  });

  it("never pays for a second revision: one revision that still fails is scored and kept if better", async () => {
    const d = deps({ draft: critiqueOf(5), rev1: critiqueOf(7), rev2: critiqueOf(9, true) });
    const out = await reviewAndRevisePlan({ strategy: strategy("draft") }, d);
    expect(d.revisions).toBe(1);
    expect(out.stopped).toBe("max_revisions");
    expect(out.strategy.north_star.why).toBe("rev1");
    expect(out.passes.map((p) => p.overall)).toEqual([5, 7]);
  });

  it("keeps the draft when its one revision scores worse", async () => {
    const d = deps({ draft: critiqueOf(6), rev1: critiqueOf(4) });
    const out = await reviewAndRevisePlan({ strategy: strategy("draft") }, d);
    expect(d.revisions).toBe(1);
    expect(out.stopped).toBe("max_revisions");
    expect(out.strategy.north_star.why).toBe("draft");
  });

  it("a plan that is only over length still gets one revision, not two", async () => {
    const { MAX_PLAN_WORDS } = await import("../plan-review");
    const long = (why: string) => {
      const s = strategy(why);
      return { ...s, constraint: { ...s.constraint, evidence: Array(MAX_PLAN_WORDS + 20).fill("word").join(" ") } };
    };
    const d = deps({ draft: critiqueOf(9, true), rev1: critiqueOf(9, true), rev2: critiqueOf(9, true) });
    d.revise = async () => {
      d.revisions += 1;
      return `<strategy>${JSON.stringify(long(`rev${d.revisions}`))}</strategy>`;
    };
    const out = await reviewAndRevisePlan({ strategy: long("draft") }, d);
    expect(d.revisions).toBe(1);
    expect(out.stopped).toBe("max_revisions");
    expect(out.passes.length).toBe(2);
  });

  it("keeps the draft when the revision cannot be parsed", async () => {
    const d = deps({ draft: critiqueOf(4) }, { revise: async () => "no envelope here" });
    const out = await reviewAndRevisePlan({ strategy: strategy("draft") }, d);
    expect(out.stopped).toBe("revision_unparseable");
    expect(out.strategy.north_star.why).toBe("draft");
  });

  it("fails open to the draft when the critic throws", async () => {
    const d = deps({}, { critique: async () => { throw new Error("no key"); } });
    const out = await reviewAndRevisePlan({ strategy: strategy("draft") }, d);
    expect(out.stopped).toBe("error");
    expect(out.strategy.north_star.why).toBe("draft");
  });

  it("stops revising once the time budget is spent", async () => {
    let t = 0;
    const d = deps({ draft: critiqueOf(5), rev1: critiqueOf(6) }, { now: () => (t += 1000) });
    const out = await reviewAndRevisePlan({ strategy: strategy("draft"), budgetMs: 1500 }, d);
    expect(out.stopped).toBe("budget");
    expect(d.revisions).toBeLessThanOrEqual(1);
  });
});

describe("parseCritique", () => {
  it("clamps scores, keeps known bars, and fails a plan with unsupported facts", () => {
    const c = parseCritique(
      '```json\n{"scores":{"constraint":9,"target":12,"actions":8,"effects":8,"grounding":"8"},' +
        '"issues":[{"bar":"target","problem":"no baseline","fix":"add one"},{"bar":"vibes","problem":"x","fix":"y"}],' +
        '"unsupported_facts":["Has 50k users"]}\n```',
    );
    expect(c.scores.target).toBe(10);
    expect(c.issues).toHaveLength(1);
    expect(c.pass).toBe(false);
  });

  it("passes only when every bar clears the bar and nothing is unsupported", () => {
    expect(parseCritique('{"scores":{"constraint":8,"target":8,"actions":8,"effects":8,"grounding":8}}').pass).toBe(true);
    expect(parseCritique('{"scores":{"constraint":8,"target":7,"actions":8,"effects":8,"grounding":8}}').pass).toBe(false);
  });
});

describe("buildDossier", () => {
  it("includes the founder's answers and the research, bounded in size", () => {
    const d = buildDossier({
      interview: [{ question: "Where do you lose people?", answer: "They look but don't buy" }],
      research: { pages: ["x".repeat(100_000)] },
    });
    expect(d).toContain("They look but don't buy");
    expect(d.length).toBeLessThan(61_000);
  });
});

describe("length check", () => {
  it("counts only founder-facing text and fails a plan over the limit", async () => {
    const { founderWordCount, withStructuralChecks: withLengthCheck, MAX_PLAN_WORDS } = await import("../plan-review");
    const long = { ...strategy("draft"), summary: Array(MAX_PLAN_WORDS + 5).fill("word").join(" ") };
    expect(founderWordCount(long)).toBeGreaterThan(MAX_PLAN_WORDS);
    const passed = critiqueOf(9, true);
    const checked = withLengthCheck(passed, long);
    expect(checked.pass).toBe(false);
    expect(checked.issues[0].problem).toMatch(new RegExp(`limit is ${MAX_PLAN_WORDS}`));
    expect(withLengthCheck(passed, strategy("short")).pass).toBe(true);
  });
});

describe("failure test date check", () => {
  it("accepts calendar dates and plan-day counts, rejects an undated test", async () => {
    const { hasCheckDate, withStructuralChecks } = await import("../plan-review");
    expect(hasCheckDate("Under 10 signups by Oct 15")).toBe(true);
    expect(hasCheckDate("fewer than 5 leads on 2026-11-01")).toBe(true);
    expect(hasCheckDate("CTR below 1% at day 30")).toBe(true);
    expect(hasCheckDate("no ranking gains by week 6")).toBe(true);
    expect(hasCheckDate("fewer than 10 signups from this channel")).toBe(false);
    expect(hasCheckDate("fewer than 10 signups within 30 days")).toBe(false);

    const bet = (falsifier: string) => ({
      channel_slug: "seo", intent: "Publish comparison pages", rationale: "", expected_effect: "", falsifier,
    });
    const undated = { ...strategy("x"), channel_bets: [bet("fewer than 10 signups from this channel")] } as unknown as ParsedStrategy;
    const dated = { ...strategy("x"), channel_bets: [bet("fewer than 10 signups by Nov 1")] } as unknown as ParsedStrategy;
    const checked = withStructuralChecks(critiqueOf(9, true), undated);
    expect(checked.pass).toBe(false);
    expect(checked.issues[0].problem).toMatch(/seo failure test has no date/);
    expect(withStructuralChecks(critiqueOf(9, true), dated).pass).toBe(true);
  });
});

describe("keeping the best version", () => {
  it("prefers a shape-clean revision over a higher-scoring over-length draft", async () => {
    const { reviewAndRevisePlan, MAX_PLAN_WORDS } = await import("../plan-review");
    const longDraft = { ...strategy("draft"), summary: Array(MAX_PLAN_WORDS + 20).fill("word").join(" ") };
    const scores: Record<string, PlanCritique> = { draft: critiqueOf(8), rev1: critiqueOf(6) };
    const d = deps(scores);
    const out = await reviewAndRevisePlan({ strategy: longDraft }, d);
    expect(out.strategy.north_star.why).toBe("rev1");
  });
});

describe("goal and evidence checks", () => {
  it("wants a number in the goal and something checkable as evidence", async () => {
    const { statesATargetNumber, evidenceIsSpecific } = await import("../plan-review");
    expect(statesATargetNumber("Reach 40 new paying customers a week by Dec 16")).toBe(true);
    expect(statesATargetNumber("Grow new paying customers per week to 1.5x the week-1 baseline by Dec 16")).toBe(false);
    expect(statesATargetNumber("Double weekly signups by December 16, 2026")).toBe(false);
    expect(statesATargetNumber(undefined)).toBe(false);

    expect(evidenceIsSpecific('Reviews repeat the same line: "setup took a full afternoon".')).toBe(true);
    expect(evidenceIsSpecific("The city page lists 20 cars against 17 advertised metros.")).toBe(true);
    expect(evidenceIsSpecific("Acquisition is binding: too few people reach the site.")).toBe(false);
    expect(evidenceIsSpecific("")).toBe(false);
  });
});

describe("unsourced numbers", () => {
  it("flags a figure the research never mentions and leaves sourced ones alone", async () => {
    const { unsourcedNumbers, withStructuralChecks } = await import("../plan-review");
    const dossier = "Pricing page: plans start at $19 per seat. The site says 1,200 teams use it.";
    const claimed = {
      ...strategy("x"),
      summary: "A scheduling tool with 1,200 teams on $19 seats.",
      constraint: { ...strategy("x").constraint, evidence: "Public filings show a $930000 run rate, and 60% of trials stall." },
    } as unknown as ParsedStrategy;
    expect(unsourcedNumbers(claimed, dossier)).toEqual(["930000"]);

    const checked = withStructuralChecks(critiqueOf(9, true), claimed, dossier);
    expect(checked.pass).toBe(false);
    expect(checked.issues[0].problem).toMatch(/930000 is stated as fact/);
    expect(withStructuralChecks(critiqueOf(9, true), claimed, dossier + " 930000").pass).toBe(true);
  });
});

describe("contact details", () => {
  it("flags a phone number or postcode the research never showed", async () => {
    const { inventedContactDetails } = await import("../plan-review");
    const dossier = "Contact page: call (408) 721-5956. We serve San Jose 95131.";
    const plan = {
      ...strategy("x"),
      channel_bets: [
        {
          channel_slug: "google_ads",
          intent: "Route local ads to (408) 555-0000 in 95132",
          rationale: "",
          expected_effect: "",
          falsifier: "under 10 calls by Nov 1",
        },
      ],
    } as unknown as ParsedStrategy;
    expect(inventedContactDetails(plan, dossier)).toEqual([
      "phone number (408) 555-0000",
      "postcode 95132",
    ]);

    const right = {
      ...plan,
      channel_bets: [{ ...plan.channel_bets[0], intent: "Route local ads to (408) 721-5956 in 95131" }],
    } as unknown as ParsedStrategy;
    expect(inventedContactDetails(right, dossier)).toEqual([]);
  });
});

describe("constraint evidence against the research", () => {
  it("wants a line from the research, not the claim restated or a promise to count", async () => {
    const { evidenceIsSpecific } = await import("../plan-review");
    const dossier =
      "INTAKE RESEARCH (untrusted third-party page text): customers repeatedly say the booking never confirms and the car is unavailable. Pricing: from $30 a day. The Los Angeles page lists 120 cars.";

    expect(
      evidenceIsSpecific("Reviewers say the booking never confirms and the car is unavailable.", dossier),
    ).toBe(true);
    expect(evidenceIsSpecific("The Los Angeles page shows only 120 cars against a national promise.", dossier)).toBe(true);
    expect(evidenceIsSpecific("Demand is binding: too few buyers ever reach the site to convert.", dossier)).toBe(false);
    expect(evidenceIsSpecific("Week 1 settles it: hand-count the jobs against spare capacity.", dossier)).toBe(false);
  });
});

describe("system vocabulary", () => {
  it("catches our own machinery leaking into the plan", async () => {
    const { systemWords } = await import("../plan-review");
    const leaky = {
      ...strategy("x"),
      summary: "growth__seo_audit found nothing and the operator_db is not_connected.",
    } as unknown as ParsedStrategy;
    expect(systemWords(leaky)).toEqual(["growth__seo_audit", "operator_db", "not_connected"]);
    expect(systemWords(strategy("x"))).toEqual([]);

    for (const ordinary of [
      "Shorten the intake form on the booking page from 9 fields to 4.",
      "Each agent runs their own open-house calendar, so listings go stale.",
      "Their trucks quote a 2,000 lb payload, which is the buying question.",
      "Sell the USB-C connector bundle and lead with third-party coverage.",
    ]) {
      expect(systemWords({ ...strategy("x"), summary: ordinary } as unknown as ParsedStrategy)).toEqual([]);
    }
  });
});

describe("the founder-facing checks, end to end", () => {
  const dossier =
    "INTAKE RESEARCH (untrusted third-party page text): call (408) 721-5956. Customers repeatedly say the booking never confirms and the car is unavailable.";

  const withEvidence = (evidence: string): ParsedStrategy =>
    ({ ...strategy("x"), constraint: { ...strategy("x").constraint, evidence } }) as unknown as ParsedStrategy;

  it("rejects a promise even when it quotes the research, which the quote check alone would pass", async () => {
    const { withStructuralChecks, evidenceIsSpecific } = await import("../plan-review");
    const mixed =
      "Customers repeatedly say the booking never confirms, and week 1 settles it once we hand-count the drop-offs.";
    expect(evidenceIsSpecific(mixed, dossier)).toBe(true);

    const checked = withStructuralChecks(critiqueOf(9, true), withEvidence(mixed), dossier);
    expect(checked.pass).toBe(false);
    expect(checked.issues.some((i) => /promise to measure/.test(i.problem))).toBe(true);
  });

  it("fails a plan whose text carries our own machinery, and says which word", async () => {
    const { withStructuralChecks } = await import("../plan-review");
    const leaky = {
      ...withEvidence("Customers repeatedly say the booking never confirms and the car is unavailable."),
      summary: "The operator_db is not_connected.",
    } as unknown as ParsedStrategy;
    const checked = withStructuralChecks(critiqueOf(9, true), leaky, dossier);
    expect(checked.pass).toBe(false);
    expect(checked.issues[0].problem).toMatch(/"operator_db"/);
  });

  it("passes a constraint whose evidence quotes the research and promises nothing", async () => {
    const { withStructuralChecks } = await import("../plan-review");
    const good = withEvidence("Customers repeatedly say the booking never confirms and the car is unavailable.");
    expect(withStructuralChecks(critiqueOf(9, true), good, dossier).pass).toBe(true);
  });
});

describe("evidence when the research pass never ran", () => {
  it("keeps the lenient bar, because the run read things the dossier never holds", async () => {
    const { evidenceIsSpecific } = await import("../plan-review");
    const interviewOnly = "FOUNDER ANSWERS:\nQ: where do you lose people?\nA: they never call back";
    expect(
      evidenceIsSpecific('Their page promises "we answer in 90 minutes", yet three reviews say nobody called.', interviewOnly),
    ).toBe(true);
  });
});

it("includes uploaded facts and successful read evidence without failed calls or credentials", () => {
 const text=buildDossier({past_work:[{fact:"431 paid customers"}]}, [
 {name:"mcp__server__growth__read_ads_perf",status:"ok",output_preview:'{"spend":8291,"email":"person@example.com"}'},
 {name:"mcp__server__growth__read_cohort",status:"tool_error",output_preview:"99999 customers"},
 {name:"mcp__server__growth__propose_change",status:"ok",output_preview:"88888 customers"},
 ]);
 expect(text).toContain("431");expect(text).toContain("8291");
 expect(text).not.toContain("99999");expect(text).not.toContain("88888");expect(text).not.toContain("person@example.com");
});
it("aborts a slow revision at the shared deadline and keeps the scored draft", async()=>{
 vi.useFakeTimers();vi.setSystemTime(0);
 try {
  let signal:AbortSignal|undefined;
  const pending=reviewAndRevisePlan({strategy:strategy("draft"),budgetMs:540000},{
   now:()=>Date.now(),critique:async()=>{await new Promise(r=>setTimeout(r,180000));return critiqueOf(5)},
   revise:async(input)=>{signal=input.signal;return new Promise(()=>{})},
  });
  await vi.advanceTimersByTimeAsync(540000);
  expect(signal?.aborted).toBe(true);
  const result=await pending;expect(result.stopped).toBe("budget");expect(result.strategy.north_star.why).toBe("draft");
 } finally {vi.useRealTimers()}
});

describe("parseCritique keeps every unsupported fact a real plan gets", () => {
  it("does not cut a 20-flag critique to 10", () => {
    const flags = Array.from({ length: 20 }, (_, i) => `claim ${i}`);
    const c = parseCritique(JSON.stringify({ scores: {}, issues: [], unsupported_facts: flags }));
    expect(c.unsupported_facts).toHaveLength(20);
  });
});
