import { describe, expect, it } from "vitest";
import { runScenario } from "../loop";
import { parseRaterReply, raterPrompt, RATERS } from "../raters";
import { SCENARIOS } from "../scenarios";
import { hardChecks, restraint, scoreRun } from "../score";
import { createStubAdapter } from "../stub-adapter";
import { reportMarkdown, transcriptMarkdown } from "../transcript";
import type { AgentAdapter, RunLog } from "../types";

const byId = (id: string) => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};
const run = (id: string, seed = 1, arm: "with" | "blind" = "with", adapter: AgentAdapter = createStubAdapter()) =>
  runScenario(byId(id), { seed, arm, adapter });
const trace = (log: RunLog) => JSON.stringify(log.days);

describe("growth-sim", () => {
  it("replays: the same scenario and seed give the same 14 days", async () => {
    for (const s of SCENARIOS) {
      const a = await runScenario(s, { seed: 7, arm: "with", adapter: createStubAdapter() });
      const b = await runScenario(s, { seed: 7, arm: "with", adapter: createStubAdapter() });
      expect(a.days).toHaveLength(14);
      expect(trace(a)).toBe(trace(b));
    }
  });

  it("different seeds change the world", async () => {
    const a = await run("1-saas-reddit-ignored", 1);
    const b = await run("1-saas-reddit-ignored", 2);
    expect(a.final.tiles.map((t) => t.visits)).not.toEqual(b.final.tiles.map((t) => t.visits));
  });

  it("the stub passes every scenario on 3 seeds, both arms, with clean hard checks", async () => {
    for (const s of SCENARIOS) {
      for (const arm of ["with", "blind"] as const) {
        for (const seed of [1, 2, 3]) {
          const score = scoreRun(s, await runScenario(s, { seed, arm, adapter: createStubAdapter() }));
          expect({ id: s.id, arm, seed, pass: score.pass, hard: score.hardChecks, restraint: score.restraint })
            .toEqual({ id: s.id, arm, seed, pass: true, hard: [], restraint: [] });
        }
      }
    }
  });

  it("an agent that does nothing fails the planted-problem scenarios but passes the control", async () => {
    const idle: AgentAdapter = {
      name: "idle",
      dailyCheck: (s) => (s.lastNote ? [] : ["review_due"]),
      review: async () => {
        const note = { saw: [], changed: [], need: [] };
        return {
          decision: { note, goalChanges: [], channelPauses: [], moves: [] },
          applied: { note, goalChanges: [], channelPauses: [], moves: [], nextReviewInDays: 30 },
        };
      },
    };
    for (const s of SCENARIOS) {
      const score = scoreRun(s, await runScenario(s, { seed: 1, arm: "with", adapter: idle }));
      expect({ id: s.id, pass: score.pass }).toEqual({ id: s.id, pass: s.id === "C-healthy-control" });
    }
  });

  it("hard checks catch a founder-channel pause and a move outside the allowlist; a brief to the business's own channel is allowed", async () => {
    const reckless: AgentAdapter = {
      name: "reckless",
      dailyCheck: (s) => (s.lastNote ? [] : ["review_due"]),
      review: async () => {
        const note = { saw: ["x"], changed: [], need: [] };
        const d = { note, goalChanges: [], channelPauses: [{ slug: "reddit_organic", why: "x" }], moves: [{ target_agent: "reddit_organic", what: "x" }, { target_agent: "browser-operator", what: "x" }] };
        return { decision: d, applied: { ...d, nextReviewInDays: 7 } };
      },
    };
    const fails = hardChecks(await run("1b-saas-reddit-founder-added", 1, "with", reckless));
    expect(fails.some((f) => f.includes("paused founder-added reddit_organic"))).toBe(true);
    expect(fails.some((f) => f.includes("move outside allowlist (browser-operator)"))).toBe(true);
    expect(fails.some((f) => f.includes("reddit_organic)"))).toBe(false);
  });

  it("autopilot OFF: the stub's guards apply nothing", async () => {
    const log = await run("1c-saas-reddit-autopilot-off");
    for (const d of log.days) {
      if (!d.applied) continue;
      expect(d.applied.goalChanges.length + d.applied.channelPauses.length + d.applied.moves.length).toBe(0);
    }
    expect(log.days.some((d) => d.decision && d.decision.channelPauses.length > 0)).toBe(true);
  });

  it("the blind arm hides wake reasons from the agent", async () => {
    const log = await run("1-saas-reddit-ignored", 1, "blind");
    const reviewed = log.days.filter((d) => d.view);
    expect(reviewed.length).toBeGreaterThan(0);
    for (const d of reviewed) {
      expect(d.view?.wakeReasons).toEqual([]);
      expect(d.reasons.length).toBeGreaterThan(0);
    }
  });

  it("the rater transcript never contains the answer key", async () => {
    for (const s of SCENARIOS) {
      const md = transcriptMarkdown(s, await runScenario(s, { seed: 1, arm: "with", adapter: createStubAdapter() }));
      expect(md).not.toContain(s.pass.describe);
      for (const r of RATERS) expect(raterPrompt(r, md)).not.toContain(s.pass.describe);
    }
  });

  it("a pass needs the planted evidence: pausing Reddit on day 1 (one card showing) does not count", async () => {
    const early: AgentAdapter = {
      name: "early",
      dailyCheck: (s) => (s.lastNote ? [] : ["review_due"]),
      review: async () => {
        const note = { saw: ["reddit looks weak"], changed: [], need: [] };
        const d = { note, goalChanges: [], channelPauses: [{ slug: "reddit_organic", why: "guess" }], moves: [] };
        return { decision: d, applied: { ...d, nextReviewInDays: 30 } };
      },
    };
    expect(scoreRun(byId("1-saas-reddit-ignored"), await run("1-saas-reddit-ignored", 1, "with", early)).pass).toBe(false);
  });

  it("scenario 4: mentioning channel 'activity' is not noticing the founder went quiet", async () => {
    const vague: AgentAdapter = {
      name: "vague",
      dailyCheck: (s) => (s.founder.daysSilent >= 7 && !s.lastNote?.saw.length ? ["founder_silent"] : s.lastNote ? [] : ["review_due"]),
      review: async (v) => {
        const note = v.founder.daysSilent >= 7 ? { saw: ["linkedin_organic activity is flat"], changed: [], need: ["Post twice this week?"] } : { saw: [], changed: [], need: [] };
        return { decision: { note, goalChanges: [], channelPauses: [], moves: [] }, applied: { note, goalChanges: [], channelPauses: [], moves: [], nextReviewInDays: 30 } };
      },
    };
    expect(scoreRun(byId("4-marketplace-founder-silent"), await run("4-marketplace-founder-silent", 1, "with", vague)).pass).toBe(false);
  });

  it("scenario 4: changing things on the first silent day fails even if a later note is clean", async () => {
    const acting: AgentAdapter = {
      name: "acting",
      dailyCheck: (s) => (!s.lastNote ? ["review_due"] : s.founder.daysSilent >= 7 && s.day <= 11 ? ["founder_silent"] : []),
      review: async (v) => {
        const first = v.founder.daysSilent >= 7 && !v.lastNote?.saw.length;
        const note = v.founder.daysSilent >= 7 ? { saw: first ? ["Traffic is steady"] : ["You have been silent for a week"], changed: [], need: ["Approve the waiting cards?"] } : { saw: [], changed: [], need: [] };
        const moves = first ? [{ target_agent: "research", what: "Look into tutors" }] : [];
        return { decision: { note, goalChanges: [], channelPauses: [], moves }, applied: { note, goalChanges: [], channelPauses: [], moves, nextReviewInDays: 1 } };
      },
    };
    expect(scoreRun(byId("4-marketplace-founder-silent"), await run("4-marketplace-founder-silent", 1, "with", acting)).pass).toBe(false);
  });

  it("a report cell with a missing seed is incomplete, never a pass", () => {
    const one = { scenarioId: "x", seed: 1, arm: "with" as const, pass: true, passedByDay: 3, hardChecks: [], restraint: [], reviews: 2, tokens: 0 };
    expect(reportMarkdown([one], 3)).toContain("| x | with | 1/3 | incomplete |");
    expect(reportMarkdown([one, { ...one, seed: 2 }, { ...one, seed: 3 }], 3)).toContain("| x | with | 3/3 | PASS |");
  });

  it("the dental decoy channel really produces its one card", async () => {
    const log = await run("3-dental-landing-page");
    expect(log.final.cards.filter((c) => c.channel === "x_organic")).toHaveLength(1);
  });

  it("two honest goal edits in one direction are not a reversal; going back is", () => {
    const base = { scenarioId: "x", seed: 1, arm: "with" as const, adapter: "t", days: [] };
    const withChanges = (pairs: Array<[number, number]>) =>
      ({ ...base, final: { goal: { changes: pairs.map(([from, to], i) => ({ day: i + 1, from, to, why: "w", undo: null })) }, asks: [] } }) as unknown as RunLog;
    expect(restraint(withChanges([[2000, 500], [500, 600]]))).toEqual([]);
    expect(restraint(withChanges([[2000, 500], [500, 2000]]))).toHaveLength(1);
  });

  it("rater replies need a 1-10 score and a quote that is really in the transcript", () => {
    const md = "## Day 1\n**What I saw:** reddit_organic: 5 cards untouched";
    expect(parseRaterReply("r", '{"score": 7, "quote": "reddit_organic: 5 cards untouched", "why": "ok"}', md).score).toBe(7);
    expect(() => parseRaterReply("r", '{"score": 11, "quote": "reddit_organic"}', md)).toThrow(/1-10/);
    expect(() => parseRaterReply("r", '{"score": 5, "quote": "d"}', md)).toThrow(/too short/);
    expect(() => parseRaterReply("r", "{score: 5}", md)).toThrow(/does not parse/);
    expect(() => parseRaterReply("r", '{"score": 5, "quote": "invented line"}', md)).toThrow(/not in the transcript/);
    expect(() => parseRaterReply("r", "no json", md)).toThrow(/no JSON/);
  });
});
