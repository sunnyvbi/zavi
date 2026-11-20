
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { causalOutcome } from "../causal";
import { CAUSAL_DENTAL, CAUSAL_SCENARIOS } from "../causal-scenarios";
import { runScenario } from "../loop";
import { REFERENCE_AGENTS } from "../reference-agents";
import { hardChecks } from "../score";
import type { AgentAdapter, CausalSpec, Scenario } from "../types";

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);

const SHEET_SHA256: Record<string, string> = {
  "dental-booking.json": "aadefe8000220c1aaf0f0d1fb81e35ecb93f1b148a90e27a10362aeed8c614f9",
  "freelancer-invoicing.json": "b0998edd6024fb93e6141a5fcd519a38cea8245076f5bc9f0b4528a30edf90b8",
  "coffee-subscription.json": "df1e4d54a548b9b3550a35859e676a559c5ca112094e4ede07cbfd35ff07881c",
  "fitness-studio.json": "2d773896947d8ac1995f239bf10e754025de48493e9c0e3cf681293a2859ad3f",
};

type Stats = { mean: number; sd: number; values: number[]; hard: string[] };

async function netUsd(scenario: Scenario, make: () => AgentAdapter): Promise<Stats> {
  const spec = scenario.causal as CausalSpec;
  const values: number[] = [];
  const hard: string[] = [];
  for (const seed of SEEDS) {
    const log = await runScenario(scenario, { seed, arm: "with", adapter: make() });
    values.push(causalOutcome(spec, log.final).netUsd);
    hard.push(...hardChecks(log));
  }
  const mean = values.reduce((a, v) => a + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1));
  return { mean, sd, values, hard };
}

describe("causal gate: c1-dental-booking", () => {
  it("the answer sheet is the frozen one", () => {
    for (const [file, sha] of Object.entries(SHEET_SHA256)) {
      const got = createHash("sha256").update(readFileSync(join(__dirname, "..", "sheets", file))).digest("hex");
      expect(got, file).toBe(sha);
    }
  });

  it("a proposed move changes nothing until it is approved and finished", async () => {
    const spec = CAUSAL_DENTAL.causal as CausalSpec;
    const log = await runScenario(CAUSAL_DENTAL, { seed: 1, arm: "with", adapter: REFERENCE_AGENTS.perfect(spec) });
    const firstShip = log.final.jobs.find((j) => j.stage === "ship" && j.worked);
    expect(firstShip).toBeTruthy();
    const liveDay = (firstShip?.doneDay as number) + spec.fix.lagDays;
    const rate = (from: number, to: number) => {
      const t = log.final.tiles.filter((x) => x.day >= from && x.day <= to);
      return t.reduce((a, x) => a + x.outcome, 0) / t.reduce((a, x) => a + x.visits, 0);
    };
    expect(rate(1, liveDay - 1)).toBeLessThan(spec.conversion.reachable * 0.6);
    expect(rate(liveDay, 30)).toBeGreaterThan(spec.conversion.reachable * 0.8);
    expect(log.final.conversion).toBeCloseTo(spec.conversion.reachable, 10);
  });

});

describe.each(CAUSAL_SCENARIOS.map((s) => [s.id, s] as const))("causal gate: %s", (id, scenario) => {
  it("ranks the reference agents as a growth lead would, outside seed noise", async () => {
    const spec = scenario.causal as CausalSpec;
    const r: Record<string, Stats> = {};
    for (const [name, make] of Object.entries(REFERENCE_AGENTS)) r[name] = await netUsd(scenario, () => make(spec));
    const line = Object.entries(r)
      .map(([n, s]) => `${n}=${Math.round(s.mean)}±${Math.round(s.sd)}`)
      .join("  ");
    console.log(`[causal-gate] ${id} netUsd over ${SEEDS.length} seeds: ${line}`);

    for (const [n, s] of Object.entries(r)) if (n !== "harmful") expect(s.hard, n).toEqual([]);

    const m = (n: string) => r[n].mean;
    expect(m("perfect")).toBeGreaterThan(m("informed"));
    for (const cheap of ["do-nothing", "sweeper", "heuristic", "channel-spammer"]) expect(m("informed"), cheap).toBeGreaterThan(m(cheap));
    for (const n of ["do-nothing", "sweeper", "heuristic"]) expect(m(n), n).toBeGreaterThan(m("harmful"));
    for (const fault of ["ship-first", "diagnose-forever"]) expect(m(fault), fault).toBeLessThan(m("informed"));

    const diffs = r.perfect.values.map((v, i) => v - r["do-nothing"].values[i]);
    const dMean = diffs.reduce((a, v) => a + v, 0) / diffs.length;
    const dSe = Math.sqrt(diffs.reduce((a, v) => a + (v - dMean) ** 2, 0) / (diffs.length - 1) / diffs.length);
    expect(dMean).toBeGreaterThanOrEqual(3 * dSe);
  });
});

describe("causal accounting", () => {
  it("a declined or never-run proposal costs nothing; the pass day is the day the goal was reached", async () => {
    const { scoreRun } = await import("../score");
    const spec = CAUSAL_DENTAL.causal as CausalSpec;
    const log = await runScenario(CAUSAL_DENTAL, { seed: 3, arm: "with", adapter: REFERENCE_AGENTS.sweeper(spec) });
    const reviews = log.days.filter((d) => d.applied).length;
    const ran = log.final.jobs.filter((j) => j.startedDay !== null);
    const live = log.final.jobs.filter((j) => j.stage === "ship" && j.doneDay !== null);
    const expected =
      reviews * spec.costs.review +
      ran.reduce((a, j) => a + (j.stage === "diagnose" ? spec.costs.research : spec.costs.build), 0) +
      live.length * spec.costs.ship;
    expect(log.final.credits).toBe(expected);

    const perfect = await runScenario(CAUSAL_DENTAL, { seed: 1, arm: "with", adapter: REFERENCE_AGENTS.perfect(spec) });
    const sc = scoreRun(CAUSAL_DENTAL, perfect);
    if (sc.pass) expect(sc.passedByDay).toBeGreaterThan(10);
  });
});

describe("causal levers", () => {
  it("a fix shipped twice counts once; a rate decoy stacks with the real fix", async () => {
    const { advanceJobs } = await import("../causal");
    const { initialState } = await import("../world");
    const { HOLDOUT_FITNESS, CAUSAL_INVOICING } = await import("../causal-scenarios");
    const worked = (problem: string, day: number) => ({
      id: `j-${problem}-${day}`, day, target_agent: "engineer", problem, stage: "ship" as const, status: "done" as const,
      what: "", needsApproval: true, awaitingGoLive: false, startedDay: day, doneDay: day, worked: true, report: null,
    });

    const inv = CAUSAL_INVOICING.causal as CausalSpec;
    const s1 = initialState(CAUSAL_INVOICING);
    s1.jobs.push(worked(inv.realProblem, 1), worked(inv.realProblem, 2));
    for (let d = 1; d <= 10; d++) {
      s1.day = d;
      advanceJobs(inv, s1, () => 0.99);
    }
    expect(s1.conversion).toBeCloseTo(inv.conversion.reachable, 10);

    const fit = HOLDOUT_FITNESS.causal as CausalSpec;
    const s2 = initialState(HOLDOUT_FITNESS);
    s2.jobs.push(worked(fit.realProblem, 1), worked(fit.decoyProblem, 1), worked(fit.decoyProblem, 2));
    for (let d = 1; d <= 10; d++) {
      s2.day = d;
      advanceJobs(fit, s2, () => 0.99);
    }
    expect(s2.baseVisits).toBe(fit.visits.reachable);
    expect(fit.decoyLever.kind).toBe("rate");
    if (fit.decoyLever.kind === "rate") expect(s2.conversion).toBeCloseTo(fit.decoyLever.rate, 10);
  });
});

describe("channel briefs (cgo directs organic channels)", () => {
  it("a brief to the business's own active channel starts at once and brings extra posts; a channel it lacks or paused does nothing", async () => {
    const { proposeJobs, advanceJobs, CHANNEL_BRIEF_POSTS } = await import("../causal");
    const { initialState } = await import("../world");
    const spec = CAUSAL_DENTAL.causal as CausalSpec;
    const s = initialState(CAUSAL_DENTAL);
    s.day = 1;
    s.channels.find((c) => c.slug === "x_organic")!.pausedDay = 0;
    proposeJobs(spec, s, [{ target_agent: "seo", what: "two articles on same-week appointments", problem: "traffic" }, { target_agent: "tiktok_organic", what: "x", problem: "traffic" }]);
    proposeJobs(spec, s, [{ target_agent: "x_organic", what: "paused channel", problem: "traffic" }]);
    expect(s.jobs).toHaveLength(1);
    expect(s.jobs[0]).toMatchObject({ stage: "channel", status: "running", needsApproval: false });
    const before = s.cards.filter((c) => c.channel === "seo").length;
    for (let d = 2; d <= 4; d++) {
      s.day = d;
      advanceJobs(spec, s, () => 0.99);
    }
    expect(s.cards.filter((c) => c.channel === "seo").length - before).toBe(CHANNEL_BRIEF_POSTS);
    expect(s.jobs[0].status).toBe("done");
  });
});
