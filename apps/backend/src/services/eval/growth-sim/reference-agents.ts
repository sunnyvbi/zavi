
import { CGO_ORGANIC_TARGETS, GROWTH_PROBLEMS } from "../../growth/goal-owner";
import type { AgentAdapter, CausalSpec, SimApplied, SimDecision, SimState, SimWorldView } from "./types";

const REVIEW_EVERY = 3;

type Move = { target_agent: string; problem: string; what: string };
type Plan = { moves: Move[]; pauses?: Array<{ slug: string; why: string }> };

function scripted(name: string, decide: (view: SimWorldView, state: SimState) => Plan): AgentAdapter {
  return {
    name,
    dailyCheck: (s) => (s.day === 1 || (s.day - 1) % REVIEW_EVERY === 0 ? ["review_due"] : []),
    async review(view, state) {
      const plan = decide(view, state);
      const moves = plan.moves.slice(0, 2);
      const decision: SimDecision = {
        note: { saw: [], changed: [], need: [] },
        goalChanges: [],
        channelPauses: plan.pauses ?? [],
        moves: moves.map((m) => ({ target_agent: m.target_agent, what: m.what })),
        next_review_in_days: REVIEW_EVERY,
      };
      const applied: SimApplied = {
        note: decision.note,
        goalChanges: [],
        channelPauses: view.autopilotEnabled ? decision.channelPauses : [],
        moves: view.autopilotEnabled ? moves : [],
        nextReviewInDays: REVIEW_EVERY,
      };
      return { decision, applied };
    },
  };
}

const research = (problem: string): Move => ({ target_agent: "research", problem, what: `Find out what is going on with ${problem}` });
const ship = (problem: string): Move => ({ target_agent: "engineer", problem, what: `Build and ship the ${problem} fix` });

function proposed(state: SimState, agent: string, problem: string): number {
  return state.jobs.filter((j) => j.target_agent === agent && j.problem === problem).length;
}

function diagnosed(state: SimState, problem: string): boolean {
  return state.jobs.some((j) => j.stage === "diagnose" && j.problem === problem && j.status === "done");
}

function retry(spec: CausalSpec, view: SimWorldView, state: SimState, problem: string): boolean {
  const ships = state.jobs.filter((j) => j.stage === "ship" && j.problem === problem);
  if (ships.length === 0 || ships.length >= 2) return false;
  const moved = spec.lever === "rate" ? state.conversion > spec.conversion.current : state.baseVisits > spec.visits.current;
  return !moved && view.day - ships[ships.length - 1].day >= 10;
}

function withBriefs(plan: Plan, state: SimState, max: number): Plan {
  const free = Math.min(max, 2 - plan.moves.length);
  if (free <= 0) return plan;
  const channels = state.channels
    .filter((c) => c.pausedDay === null && CGO_ORGANIC_TARGETS.has(c.slug))
    .sort((a, b) => b.visitsPerApproved * b.cardsPerDay - a.visitsPerApproved * a.cardsPerDay)
    .slice(0, free);
  return { ...plan, moves: [...plan.moves, ...channels.map((c) => ({ target_agent: c.slug, problem: "traffic", what: `Brief ${c.slug}: more posts toward the goal` }))] };
}

export function perfectAgent(spec: CausalSpec): AgentAdapter {
  return scripted("perfect", (view, state) => withBriefs(perfectPlan(spec, view, state), state, 2));
}

function perfectPlan(spec: CausalSpec, _view: SimWorldView, state: SimState): Plan {
  const p = spec.realProblem;
  if (proposed(state, "research", p) === 0) return { moves: [research(p)] };
  if (!diagnosed(state, p)) return { moves: [] };
  if (proposed(state, "engineer", p) === 0) return { moves: [ship(p)] };
  const open = state.jobs.some((j) => j.stage === "ship" && j.problem === p && (j.status === "waiting" || j.status === "running" || j.worked));
  return { moves: open ? [] : [ship(p)] };
}

export function informedAgent(spec: CausalSpec): AgentAdapter {
  return scripted("informed", (view, state) => {
    const plan = ((): Plan => {
      if (state.jobs.filter((j) => j.stage !== "channel").length === 0) return { moves: [research(spec.decoyProblem), research(spec.realProblem)] };
      if (!diagnosed(state, spec.realProblem)) return { moves: [] };
      if (proposed(state, "engineer", spec.realProblem) === 0) return { moves: [ship(spec.realProblem)] };
      return { moves: retry(spec, view, state, spec.realProblem) ? [ship(spec.realProblem)] : [] };
    })();
    return withBriefs(plan, state, 1);
  });
}

export function doNothingAgent(): AgentAdapter {
  return scripted("do-nothing", () => ({ moves: [] }));
}

export function sweeperAgent(): AgentAdapter {
  return scripted("sweeper", (_view, state) => {
    const undiagnosed = GROWTH_PROBLEMS.filter((p) => proposed(state, "research", p) === 0);
    if (undiagnosed.length) return { moves: undiagnosed.slice(0, 2).map(research) };
    return { moves: GROWTH_PROBLEMS.filter((p) => proposed(state, "engineer", p) === 0).slice(0, 2).map(ship) };
  });
}

export function heuristicAgent(spec: CausalSpec): AgentAdapter {
  return scripted("heuristic", (view, state) => {
    const p = spec.decoyProblem;
    if (proposed(state, "research", p) === 0) return { moves: [research(p)] };
    if (proposed(state, "engineer", p) === 0 && view.day >= 4) return { moves: [ship(p)] };
    return { moves: [] };
  });
}

export function channelSpammerAgent(): AgentAdapter {
  return scripted("channel-spammer", (_view, state) => withBriefs({ moves: [] }, state, 2));
}

export function harmfulAgent(spec: CausalSpec): AgentAdapter {
  const wrong = GROWTH_PROBLEMS.find((p) => p !== spec.realProblem && p !== spec.decoyProblem) as string;
  return scripted("harmful", (view, state) => {
    const top = [...view.channels].filter((c) => !c.paused).sort((a, b) => b.visits7d - a.visits7d)[0];
    const pauses = top && (state.jobs.length === 0 || top.visits7d > 0) ? [{ slug: top.slug, why: "cut spend" }] : [];
    return { moves: state.jobs.length === 0 ? [ship(wrong)] : [], pauses };
  });
}

export function shipFirstAgent(spec: CausalSpec): AgentAdapter {
  return scripted("ship-first", (view, state) => {
    const p = spec.realProblem;
    if (proposed(state, "engineer", p) === 0) return { moves: [ship(p)] };
    return { moves: retry(spec, view, state, p) ? [ship(p)] : [] };
  });
}

export function diagnoseForeverAgent(spec: CausalSpec): AgentAdapter {
  return scripted("diagnose-forever", () => ({ moves: [research(spec.realProblem)] }));
}

export const REFERENCE_AGENTS: Record<string, (spec: CausalSpec) => AgentAdapter> = {
  perfect: perfectAgent,
  informed: informedAgent,
  "do-nothing": () => doNothingAgent(),
  sweeper: () => sweeperAgent(),
  "channel-spammer": () => channelSpammerAgent(),
  heuristic: heuristicAgent,
  harmful: harmfulAgent,
  "ship-first": shipFirstAgent,
  "diagnose-forever": diagnoseForeverAgent,
};
