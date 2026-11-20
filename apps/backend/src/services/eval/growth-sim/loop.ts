
import type { AgentAdapter, DayLog, RunLog, Scenario, SimApplied, SimState } from "./types";
import { advanceJobs, proposeJobs } from "./causal";
import { channelStub, founderSim, initialState, rng, signalsOf, viewOf, worldStep } from "./world";

export function applyInMemory(state: SimState, applied: SimApplied): void {
  const day = state.day;
  if (applied.note.sent !== false) state.notes.push({ day, saw: applied.note.saw, changed: applied.note.changed, need: applied.note.need });
  for (const text of applied.note.need) {
    const key = text.toLowerCase();
    if (state.asks.some((a) => a.key === key && a.answer === null)) continue;
    state.asks.push({ key, text, day, answer: null, answeredDay: null });
  }
  for (const g of applied.goalChanges) {
    state.goal.changes.push({ day, from: state.goal.target, to: g.target, why: g.why, undo: g.undo ?? null });
    state.goal.target = g.target;
    if (g.dueDays !== undefined) state.goal.dueDays = g.dueDays;
    if (g.objective !== undefined) state.goal.objective = g.objective;
    if (g.targetMetric !== undefined) {
      state.goal.targetMetric = g.targetMetric;
      state.goal.current = 0;
      state.goal.baseline = 0;
    }
  }
  for (const p of applied.channelPauses) {
    const ch = state.channels.find((c) => c.slug === p.slug);
    if (!ch || ch.pausedDay !== null) continue;
    ch.pausedDay = day;
    ch.pausedWhy = p.why;
    for (const c of state.cards) if (c.channel === p.slug && c.status === "pending") c.status = "stale";
  }
  for (const m of applied.moves) state.moves.push({ day, ...m });
  state.nextReviewDay = day + applied.nextReviewInDays;
}

export async function runScenario(
  scenario: Scenario,
  opts: { seed: number; arm: "with" | "blind"; adapter: AgentAdapter },
): Promise<RunLog> {
  const state = initialState(scenario);
  const rand = rng(opts.seed);
  const leverRand = rng((opts.seed ^ 0x5bd1e995) >>> 0);
  const days: DayLog[] = [];
  for (let day = 1; day <= scenario.days; day++) {
    state.day = day;
    channelStub(state);
    const approvedVisits = founderSim(scenario, state, rand);
    if (scenario.causal) advanceJobs(scenario.causal, state, leverRand);
    worldStep(scenario, state, approvedVisits, rand);
    const signals = signalsOf(scenario, state);
    const reasons = opts.adapter.dailyCheck(signals, state);
    const log: DayLog = {
      day,
      reasons,
      view: null,
      decision: null,
      applied: null,
      tokens: 0,
      snapshot: { goalTarget: 0, goalCurrent: 0, paused: [], pendingCards: 0, openAsks: 0 },
    };
    if (reasons.length > 0) {
      const view = viewOf(signals, reasons, opts.arm);
      const out = await opts.adapter.review(view, state);
      applyInMemory(state, out.applied);
      if (scenario.causal) {
        state.credits += scenario.causal.costs.review;
        proposeJobs(scenario.causal, state, out.applied.moves);
      }
      Object.assign(log, { view, decision: out.decision, applied: out.applied, raw: out.raw, tokens: out.tokens ?? 0 });
    }
    log.snapshot = {
      goalTarget: state.goal.target,
      goalCurrent: state.goal.current,
      paused: state.channels.filter((c) => c.pausedDay !== null).map((c) => c.slug),
      pendingCards: state.cards.filter((c) => c.status === "pending").length,
      openAsks: state.asks.filter((a) => a.answer === null).length,
    };
    days.push(log);
  }
  return { scenarioId: scenario.id, seed: opts.seed, arm: opts.arm, adapter: opts.adapter.name, days, final: state };
}
