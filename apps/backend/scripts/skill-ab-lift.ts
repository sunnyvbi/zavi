import { resolveSkills } from "../src/services/agents/skill-runtime";
import type { ReplayCase } from "./skill-runtime-replay-cases";

export type Arm = "inject" | "suppress";
export type JudgeToken = "A" | "B" | "tie" | "error";
export type Winner = "inject" | "suppress" | "tie" | "error";

export interface BlindPlacement {
  a_arm: Arm;
  b_arm: Arm;
}

export function normalizeVerdict(token: JudgeToken, placement: BlindPlacement): Winner {
  if (placement.a_arm === placement.b_arm) {
    throw new Error(`invalid BlindPlacement: a_arm and b_arm are both '${placement.a_arm}'`);
  }
  if (token === "A") return placement.a_arm;
  if (token === "B") return placement.b_arm;
  if (token === "tie") return "tie";
  return "error";
}

export interface AbTrial {
  skill: string;
  winner: Winner;
}

export type LiftVerdict = "helps" | "hurts" | "neutral" | "insufficient";

export interface SkillLift {
  skill: string;
  inject_wins: number;
  suppress_wins: number;
  ties: number;
  errors: number;
  graded: number;
  lift: number;
  verdict: LiftVerdict;
}

export interface LiftOptions {
  threshold?: number;
  minGraded?: number;
}

const DEFAULT_THRESHOLD = 0.34;
const DEFAULT_MIN_GRADED = 3;

function classify(lift: number, graded: number, threshold: number, minGraded: number): LiftVerdict {
  if (graded < minGraded) return "insufficient";
  if (lift >= threshold) return "helps";
  if (lift <= -threshold) return "hurts";
  return "neutral";
}

function tally(skill: string, trials: AbTrial[], threshold: number, minGraded: number): SkillLift {
  let inject_wins = 0, suppress_wins = 0, ties = 0, errors = 0;
  for (const t of trials) {
    if (t.winner === "inject") inject_wins++;
    else if (t.winner === "suppress") suppress_wins++;
    else if (t.winner === "tie") ties++;
    else errors++;
  }
  const graded = inject_wins + suppress_wins + ties;
  const lift = graded > 0 ? (inject_wins - suppress_wins) / graded : 0;
  return { skill, inject_wins, suppress_wins, ties, errors, graded, lift, verdict: classify(lift, graded, threshold, minGraded) };
}

export interface LiftReport {
  perSkill: SkillLift[];
  overall: SkillLift;
}

export function computeSkillLift(trials: AbTrial[], opts: LiftOptions = {}): LiftReport {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const minGraded = opts.minGraded ?? DEFAULT_MIN_GRADED;

  const bySkill = new Map<string, AbTrial[]>();
  for (const t of trials) {
    const arr = bySkill.get(t.skill);
    if (arr) arr.push(t);
    else bySkill.set(t.skill, [t]);
  }

  const perSkill = [...bySkill.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([skill, ts]) => tally(skill, ts, threshold, minGraded));

  const overall = tally("__overall__", trials, threshold, minGraded);
  return { perSkill, overall };
}

export function caseSkill(c: Pick<ReplayCase, "agent_slug" | "prompt">): string | null {
  const slugs = resolveSkills(c.agent_slug, c.prompt);
  return slugs.length === 1 ? slugs[0] : null;
}
