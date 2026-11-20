
import type { Scenario, SimSignals, SimState, SimWorldView } from "./types";

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function initialState(s: Scenario): SimState {
  return {
    day: 0,
    goal: { objective: s.goal.objective, target: s.goal.target, dueDays: s.goal.dueDays, current: s.goal.baseline, baseline: s.goal.baseline, changes: [] },
    channels: s.channels.map((c) => ({ ...c, pausedDay: null, pausedWhy: null, carry: 0, visitsByDay: {} })),
    cards: [],
    asks: [],
    tiles: [],
    notes: [],
    moves: [],
    founderLastActiveDay: 0,
    outcomeCarry: 0,
    nextReviewDay: null,
    autopilot: s.autopilot,
    jobs: [],
    findings: [],
    conversion: s.causal?.conversion.current ?? s.world.conversion,
    baseVisits: s.causal?.visits.current ?? s.world.baseVisitsPerDay,
    fixed: { real: false, decoy: false },
    credits: 0,
  };
}

export function channelStub(state: SimState): void {
  for (const ch of state.channels) {
    if (ch.pausedDay !== null) continue;
    ch.carry += ch.cardsPerDay;
    while (ch.carry >= 1 - 1e-9) {
      ch.carry -= 1;
      state.cards.push({
        id: `${ch.slug}-${state.day}-${state.cards.length}`,
        channel: ch.slug,
        day: state.day,
        status: "pending",
        seenDay: null,
        decidedDay: null,
      });
    }
  }
}

export function founderSim(s: Scenario, state: SimState, rand: () => number): number {
  if (s.founder.silentFromDay !== undefined && state.day >= s.founder.silentFromDay) return 0;
  let visits = 0;
  let active = false;
  for (const card of state.cards) {
    if (card.status !== "pending") continue;
    const ch = state.channels.find((c) => c.slug === card.channel);
    const policy = s.founder.policy[card.channel];
    if (!ch || !policy) continue;
    if (card.seenDay === null) {
      if (rand() >= policy.seen) continue;
      card.seenDay = state.day;
      active = true;
    }
    const r = rand();
    if (r < policy.approve) {
      card.status = "approved";
      card.decidedDay = state.day;
      visits += ch.visitsPerApproved;
      ch.visitsByDay[state.day] = (ch.visitsByDay[state.day] ?? 0) + ch.visitsPerApproved;
      active = true;
    } else if (r < policy.approve + policy.reject) {
      card.status = "rejected";
      card.decidedDay = state.day;
      active = true;
    }
  }
  for (const ask of state.asks) {
    if (ask.answer !== null || ask.day >= state.day) continue;
    const key = Object.keys(s.founder.answers).find((k) => ask.key.includes(k.toLowerCase()));
    if (!key) continue;
    ask.answer = s.founder.answers[key];
    ask.answeredDay = state.day;
    active = true;
  }
  if (active) state.founderLastActiveDay = state.day;
  return visits;
}

export function worldStep(s: Scenario, state: SimState, approvedVisits: number, rand: () => number): void {
  const noise = 1 + (rand() * 2 - 1) * 0.05;
  const visits = Math.round((state.baseVisits + approvedVisits) * noise);
  const exact = visits * state.conversion + state.outcomeCarry;
  const outcome = Math.floor(exact);
  state.outcomeCarry = exact - outcome;
  if (state.goal.targetMetric === undefined) state.goal.current += outcome;
  state.tiles.push({ day: state.day, visits, outcome });
}

export function signalsOf(s: Scenario, state: SimState): SimSignals {
  const day = state.day;
  const recent = state.cards.filter((c) => day - c.day < 14);
  const last7 = state.tiles.filter((t) => day - t.day < 7);
  const visits7 = last7.reduce((a, t) => a + t.visits, 0);
  const outcome7 = last7.reduce((a, t) => a + t.outcome, 0);
  return {
    day,
    business: s.business,
    outcomeLabel: s.outcomeLabel,
    autopilotEnabled: state.autopilot,
    goal: {
      objective: state.goal.objective,
      target: state.goal.target,
      dueDays: state.goal.dueDays,
      current: state.goal.current,
      expectedByNow: Math.round(state.goal.baseline + ((state.goal.target - state.goal.baseline) * day) / state.goal.dueDays),
      changedByAgent: state.goal.changes.length > 0,
    },
    channels: state.channels.map((ch) => {
      const cs = recent.filter((c) => c.channel === ch.slug);
      const pending = cs.filter((c) => c.status === "pending");
      const seenDays = state.cards.filter((c) => c.channel === ch.slug && c.seenDay !== null).map((c) => c.seenDay as number);
      const lastSeen = seenDays.length ? Math.max(...seenDays) : null;
      return {
        slug: ch.slug,
        addedBy: ch.addedBy,
        paused: ch.pausedDay !== null,
        cards14d: {
          pending: pending.length,
          approved: cs.filter((c) => c.status === "approved").length,
          rejected: cs.filter((c) => c.status === "rejected").length,
          seenNotActed: lastSeen === null ? 0 : pending.filter((c) => c.day < lastSeen).length,
          oldestPendingAge: pending.length ? day - Math.min(...pending.map((c) => c.day)) : null,
        },
        visits7d: Object.entries(ch.visitsByDay).filter(([d]) => day - Number(d) < 7).reduce((a, [, v]) => a + v, 0),
      };
    }),
    founder: {
      lastActiveDay: state.founderLastActiveDay,
      daysSilent: day - state.founderLastActiveDay,
      answers: state.asks.filter((a) => a.answer !== null).map((a) => ({ ask: a.text, answer: a.answer as string })),
    },
    openAsks: state.asks.filter((a) => a.answer === null).map((a) => a.text),
    tiles7d: { visits: visits7, outcome: outcome7, conversionPct: visits7 ? Math.round((outcome7 / visits7) * 10000) / 100 : 0 },
    lastNote: state.notes.at(-1) ?? null,
    nextReviewDay: state.nextReviewDay,
    movesSoFar: state.moves.map((m) => ({ target_agent: m.target_agent, what: m.what })),
    ...(s.causal ? { findings: state.findings.map((f) => f.text) } : {}),
  };
}

export function viewOf(signals: SimSignals, reasons: string[], arm: "with" | "blind"): SimWorldView {
  return { ...signals, wakeReasons: arm === "blind" ? [] : reasons };
}
