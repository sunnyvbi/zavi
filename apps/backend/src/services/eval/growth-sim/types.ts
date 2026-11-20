
import type { NoteItem, NoteSectionView } from "@/services/growth/cgo-note-items";

export type AddedBy = "plan" | "founder";
export type CardStatus = "pending" | "approved" | "rejected" | "stale";

export interface ChannelSpec {
  slug: string;
  addedBy: AddedBy;
  cardsPerDay: number;
  visitsPerApproved: number;
}

export interface FounderChannelPolicy {
  seen: number;
  approve: number;
  reject: number;
}

export interface Scenario {
  id: string;
  business: string;
  outcomeLabel: string;
  goal: { objective: string; target: number; dueDays: number; baseline: number };
  channels: ChannelSpec[];
  founder: {
    policy: Record<string, FounderChannelPolicy>;
    silentFromDay?: number;
    answers: Record<string, string>;
  };
  world: { baseVisitsPerDay: number; conversion: number };
  autopilot: boolean;
  days: number;
  holdout?: boolean;
  causal?: CausalSpec;
  pass: { dueDay: number; describe: string; check: (log: RunLog) => boolean };
}

export interface CausalSpec {
  sheetId: string;
  realProblem: string;
  decoyProblem: string;
  lever: "rate" | "visits";
  conversion: { current: number; reachable: number };
  visits: { current: number; reachable: number };
  decoyLever: { kind: "channel"; channel: string; visitsPerApproved: number } | { kind: "rate"; rate: number };
  diagnose: { onReal: string; onDecoy: string };
  fix: { lagDays: number; successProb: number };
  costs: { review: number; research: number; build: number; ship: number };
  outcomeValueUsd: number;
  founderApproval: { approveProb: number; daysToSee: number; fatiguePerWeek: number };
}

export type JobStage = "diagnose" | "ship" | "channel";
export type JobStatus = "waiting" | "running" | "done" | "rejected";

export interface Job {
  id: string;
  day: number;
  target_agent: string;
  problem: string;
  stage: JobStage;
  status: JobStatus;
  what: string;
  hypothesis_id?: string;
  needsApproval: boolean;
  awaitingGoLive: boolean;
  startedDay: number | null;
  doneDay: number | null;
  worked: boolean | null;
  report: string | null;
}

export interface Card {
  id: string;
  channel: string;
  day: number;
  status: CardStatus;
  seenDay: number | null;
  decidedDay: number | null;
}

export interface Ask {
  key: string;
  text: string;
  day: number;
  answer: string | null;
  answeredDay: number | null;
}

export interface Tile {
  day: number;
  visits: number;
  outcome: number;
}

export interface GoalState {
  objective: string;
  target: number;
  dueDays: number;
  current: number;
  baseline: number;
  targetMetric?: string;
  changes: Array<{ day: number; from: number; to: number; why: string; undo: { target: number } | null }>;
}

export interface ChannelState extends ChannelSpec {
  pausedDay: number | null;
  pausedWhy: string | null;
  carry: number;
  visitsByDay: Record<number, number>;
}

export interface Note {
  day: number;
  saw: string[];
  changed: string[];
  need: string[];
  by?: "silence";
}

export interface Move {
  day: number;
  target_agent: string;
  what: string;
}

export interface SimState {
  day: number;
  goal: GoalState;
  channels: ChannelState[];
  cards: Card[];
  asks: Ask[];
  tiles: Tile[];
  notes: Note[];
  moves: Move[];
  founderLastActiveDay: number;
  outcomeCarry: number;
  nextReviewDay: number | null;
  autopilot: boolean;
  jobs: Job[];
  findings: Array<{ day: number; text: string }>;
  conversion: number;
  baseVisits: number;
  fixed: { real: boolean; decoy: boolean };
  credits: number;
}

export interface SimWorldView {
  day: number;
  business: string;
  outcomeLabel: string;
  autopilotEnabled: boolean;
  goal: {
    objective: string;
    target: number;
    dueDays: number;
    current: number;
    expectedByNow: number;
    changedByAgent: boolean;
  };
  channels: Array<{
    slug: string;
    addedBy: AddedBy;
    paused: boolean;
    cards14d: { pending: number; approved: number; rejected: number; seenNotActed: number; oldestPendingAge: number | null };
    visits7d: number;
  }>;
  founder: { lastActiveDay: number; daysSilent: number; answers: Array<{ ask: string; answer: string }> };
  openAsks: string[];
  tiles7d: { visits: number; outcome: number; conversionPct: number };
  lastNote: Note | null;
  nextReviewDay: number | null;
  wakeReasons: string[];
  findings?: string[];
  movesSoFar: Array<{ target_agent: string; what: string }>;
}

export type SimSignals = Omit<SimWorldView, "wakeReasons">;

export interface SimDecision {
  note: { saw: string[]; changed: string[]; need: string[] };
  goalChanges: Array<{ target?: number; why: string }>;
  channelPauses: Array<{ slug: string; why: string }>;
  moves: Array<{ target_agent: string; what: string }>;
  next_review_in_days?: number;
}

export interface SimApplied {
  note: SimDecision["note"] & {
    would?: string[];
    sent?: boolean;
    items?: NoteItem[];
    headline?: string | null;
    sections?: NoteSectionView[];
  };
  goalChanges: Array<{ target: number; why: string; undo?: { target: number }; dueDays?: number; objective?: string; targetMetric?: string }>;
  channelPauses: Array<{ slug: string; why: string }>;
  moves: Array<{
    target_agent: string;
    what: string;
    problem?: string;
    hypothesis_id?: string;
    declared?: string;
    verdict?: "match" | "mismatch" | "ambiguous";
    verifiers?: [string, string];
  }>;
  nextReviewInDays: number;
}

export interface AgentAdapter {
  name: string;
  dailyCheck(signals: SimSignals, state: SimState): string[];
  review(view: SimWorldView, state: SimState): Promise<{ decision: SimDecision; applied: SimApplied; tokens?: number; raw?: string }>;
}

export interface DayLog {
  day: number;
  reasons: string[];
  view: SimWorldView | null;
  decision: SimDecision | null;
  applied: SimApplied | null;
  raw?: string;
  tokens: number;
  snapshot: { goalTarget: number; goalCurrent: number; paused: string[]; pendingCards: number; openAsks: number };
}

export interface RunLog {
  scenarioId: string;
  seed: number;
  arm: "with" | "blind";
  adapter: string;
  days: DayLog[];
  final: SimState;
}
