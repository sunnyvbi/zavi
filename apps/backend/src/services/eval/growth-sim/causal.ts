
import dentalSheet from "./sheets/dental-booking.json";
import { CGO_ORGANIC_TARGETS } from "../../growth/goal-owner";
import type { CausalSpec, Job, SimApplied, SimState } from "./types";

const STAGE: Record<string, Job["stage"]> = {
  research: "diagnose",
  pm: "diagnose",
  engineer: "ship",
  "content-design": "ship",
};
const DURATION: Record<string, number> = { research: 1, pm: 1, engineer: 3, "content-design": 2 };
const CHANNEL_DAYS = 2;
export const CHANNEL_BRIEF_POSTS = 2;
const AUTO_START = new Set(["research", "content-design"]);
const MAX_MOVES_PER_REVIEW = 2;

function pct(s: string): number {
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) throw new Error(`causal sheet: not a percentage: ${s}`);
  return n / 100;
}

type SheetFile = typeof dentalSheet;

function founderApproval(fa: { approve_prob: number; days_to_see: number; fatigue_per_week: number }): CausalSpec["founderApproval"] {
  return { approveProb: fa.approve_prob, daysToSee: fa.days_to_see, fatiguePerWeek: fa.fatigue_per_week };
}

export function specFromSheet(file: SheetFile, decoyLever: CausalSpec["decoyLever"], baseVisits: number): CausalSpec {
  const s = file.sheet;
  return {
    sheetId: file.id,
    realProblem: s.real_problem.problem,
    decoyProblem: s.decoy.problem,
    lever: "rate",
    conversion: { current: pct(s.real_problem.current), reachable: pct(s.real_problem.reachable) },
    visits: { current: baseVisits, reachable: baseVisits },
    decoyLever,
    diagnose: { onReal: s.diagnose.on_real, onDecoy: s.diagnose.on_decoy },
    fix: { lagDays: s.fix.lag_days, successProb: s.fix.success_prob },
    costs: s.costs,
    outcomeValueUsd: s.booking_value_usd.value,
    founderApproval: founderApproval(s.founder_approval),
  };
}

export interface SheetV2 {
  id: string;
  holdout?: boolean;
  addendum?: { goal_rate_current?: number };
  sheet: {
    business: {
      goal_objective: string;
      goal_target: number;
      outcome_label: string;
      base_visits_per_day: number;
      channels: Array<{ slug: string; cards_per_week: number; visits_per_post: number }>;
    };
    real_problem: { problem: string; lever: string; current: number; reachable: number };
    decoy: { problem: string; lever?: string; channel_slug?: string; visits_per_post_after_fix?: number; rate_after_fix?: number };
    diagnose: { on_real: string; on_decoy: string };
    fix: { lag_days: number; success_prob: number };
    costs: CausalSpec["costs"];
    goal_value_usd: { value: number };
    founder_approval: { approve_prob: number; days_to_see: number; fatigue_per_week: number };
  };
}

export function specFromSheetV2(file: SheetV2): CausalSpec {
  const s = file.sheet;
  const r = s.real_problem;
  const b = s.business;
  const rateNow = r.lever === "rate" ? r.current : file.addendum?.goal_rate_current;
  if (typeof rateNow !== "number") throw new Error(`causal sheet ${file.id}: no current goal rate`);
  const decoyLever: CausalSpec["decoyLever"] =
    (s.decoy.lever ?? "channel") === "rate"
      ? { kind: "rate", rate: s.decoy.rate_after_fix as number }
      : { kind: "channel", channel: s.decoy.channel_slug as string, visitsPerApproved: s.decoy.visits_per_post_after_fix as number };
  return {
    sheetId: file.id,
    realProblem: r.problem,
    decoyProblem: s.decoy.problem,
    lever: r.lever === "visits" ? "visits" : "rate",
    conversion: r.lever === "rate" ? { current: r.current, reachable: r.reachable } : { current: rateNow, reachable: rateNow },
    visits: r.lever === "visits" ? { current: r.current, reachable: r.reachable } : { current: b.base_visits_per_day, reachable: b.base_visits_per_day },
    decoyLever,
    diagnose: { onReal: s.diagnose.on_real, onDecoy: s.diagnose.on_decoy },
    fix: { lagDays: s.fix.lag_days, successProb: s.fix.success_prob },
    costs: s.costs,
    outcomeValueUsd: s.goal_value_usd.value,
    founderApproval: founderApproval(s.founder_approval),
  };
}

export const DENTAL_SPEC: CausalSpec = specFromSheet(dentalSheet, { kind: "channel", channel: "x_organic", visitsPerApproved: 100 }, 30);

export function proposeJobs(spec: CausalSpec, state: SimState, moves: SimApplied["moves"]): void {
  for (const m of moves.slice(0, MAX_MOVES_PER_REVIEW)) {
    const isChannel = CGO_ORGANIC_TARGETS.has(m.target_agent) && state.channels.some((c) => c.slug === m.target_agent && c.pausedDay === null);
    const stage: Job["stage"] | undefined = STAGE[m.target_agent] ?? (isChannel ? "channel" : undefined);
    if (!stage) continue;
    const autoStart = state.autopilot && (AUTO_START.has(m.target_agent) || isChannel);
    const job: Job = {
      id: `job-${state.day}-${state.jobs.length}`,
      day: state.day,
      target_agent: m.target_agent,
      problem: (m.problem ?? "unspecified").toLowerCase(),
      stage,
      status: autoStart ? "running" : "waiting",
      what: m.what,
      ...(m.hypothesis_id ? { hypothesis_id: m.hypothesis_id } : {}),
      needsApproval: !(autoStart && (m.target_agent === "research" || isChannel)),
      awaitingGoLive: false,
      startedDay: autoStart ? state.day : null,
      doneDay: null,
      worked: null,
      report: null,
    };
    if (autoStart) chargeStart(spec, state, job);
    state.jobs.push(job);
  }
}

function chargeStart(spec: CausalSpec, state: SimState, j: Job): void {
  state.credits += j.stage === "ship" ? spec.costs.build : spec.costs.research;
}

function approvalsAskedLastWeek(state: SimState): number {
  return state.jobs.filter((j) => j.needsApproval && state.day - j.day < 7).length;
}

function goLive(spec: CausalSpec, state: SimState, j: Job, rand: () => number): void {
  j.status = "done";
  j.doneDay = state.day;
  state.credits += spec.costs.ship;
  const diagnosedFirst = state.jobs.some(
    (d) => d.stage === "diagnose" && d.problem === j.problem && d.doneDay !== null && d.doneDay <= (j.startedDay as number),
  );
  j.worked = rand() < (diagnosedFirst ? spec.fix.successProb : spec.fix.successProb / 2);
  j.report = "The change is live.";
}

export function advanceJobs(spec: CausalSpec, state: SimState, rand: () => number): void {
  const fa = spec.founderApproval;
  const tired = approvalsAskedLastWeek(state) > fa.fatiguePerWeek;
  for (const j of state.jobs) {
    if (j.status === "waiting") {
      if (rand() >= 1 / Math.max(1, fa.daysToSee)) continue;
      if (rand() >= (tired ? fa.approveProb / 2 : fa.approveProb)) {
        j.status = "rejected";
      } else if (j.awaitingGoLive) {
        goLive(spec, state, j, rand);
      } else {
        j.status = "running";
        j.startedDay = state.day;
        chargeStart(spec, state, j);
      }
      continue;
    }
    if (j.status !== "running" || j.startedDay === null) continue;
    if (state.day - j.startedDay < (j.stage === "channel" ? CHANNEL_DAYS : (DURATION[j.target_agent] ?? 1))) continue;
    if (j.stage === "channel") {
      j.status = "done";
      j.doneDay = state.day;
      for (let i = 0; i < CHANNEL_BRIEF_POSTS; i++) {
        state.cards.push({ id: `${j.target_agent}-brief-${j.id}-${i}`, channel: j.target_agent, day: state.day, status: "pending", seenDay: null, decidedDay: null });
      }
      j.report = `Drafted ${CHANNEL_BRIEF_POSTS} posts for the founder to publish.`;
    } else if (j.stage === "diagnose") {
      j.status = "done";
      j.doneDay = state.day;
      j.report =
        j.problem === spec.realProblem
          ? spec.diagnose.onReal
          : j.problem === spec.decoyProblem
            ? spec.diagnose.onDecoy
            : "Nothing unusual found in this area.";
      state.findings.push({ day: state.day, text: j.report });
    } else if (j.target_agent === "content-design" && j.startedDay === j.day) {
      j.status = "waiting";
      j.awaitingGoLive = true;
    } else {
      goLive(spec, state, j, rand);
    }
  }
  for (const j of state.jobs) {
    if (j.stage !== "ship" || !j.worked || j.doneDay === null || state.day !== j.doneDay + spec.fix.lagDays) continue;
    if (j.problem === spec.realProblem) state.fixed.real = true;
    else if (j.problem === spec.decoyProblem) state.fixed.decoy = true;
  }
  applyFixes(spec, state);
}

function applyFixes(spec: CausalSpec, state: SimState): void {
  const d = spec.decoyLever;
  let rate = spec.conversion.current;
  if (state.fixed.real && spec.lever === "rate") rate *= spec.conversion.reachable / spec.conversion.current;
  if (state.fixed.decoy && d.kind === "rate") rate *= d.rate / spec.conversion.current;
  state.conversion = rate;
  state.baseVisits = state.fixed.real && spec.lever === "visits" ? spec.visits.reachable : spec.visits.current;
  if (state.fixed.decoy && d.kind === "channel") {
    const ch = state.channels.find((c) => c.slug === d.channel);
    if (ch) ch.visitsPerApproved = d.visitsPerApproved;
  }
}

export interface CausalOutcome {
  outcome: number;
  credits: number;
  netUsd: number;
  realFixedDay: number | null;
}

export const CREDIT_USD = 0.0025;

export function causalOutcome(spec: CausalSpec, state: SimState): CausalOutcome {
  const outcome = state.tiles.reduce((a, t) => a + t.outcome, 0);
  const fixed = state.jobs.find((j) => j.stage === "ship" && j.worked && j.problem === spec.realProblem && j.doneDay !== null);
  return {
    outcome,
    credits: state.credits,
    netUsd: Math.round(outcome * spec.outcomeValueUsd - state.credits * CREDIT_USD),
    realFixedDay: fixed ? (fixed.doneDay as number) + spec.fix.lagDays : null,
  };
}
