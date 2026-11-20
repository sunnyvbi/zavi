
import {
  LOADING,
  goalProgress,
  metricLabel,
  shortDate,
  type GoalHypothesis,
  type GoalHypothesisStatus,
  type GoalMove,
  type GoalMoveState,
  type GoalWork,
  type GrowthGoal,
  type GrowthPlanRow,
  type ConstraintConflict,
  type MeasurementNeed,
} from "./plan";

const DAY = 86_400_000;

export type ChipTone = "good" | "bad" | "wait" | "live" | "quiet";

export type HistoryPoint = { at: string; value: number };
export type HistoryRead = "loading" | "failed" | HistoryPoint[];

export function historyPointsOf(body: unknown): HistoryPoint[] {
  const points = (body as { points?: unknown } | null)?.points;
  return Array.isArray(points) ? (points as HistoryPoint[]) : [];
}

export function historyKey(g: GrowthGoal): string {
  return `${g.id}:${g.current_value ?? ""}:${g.target_value ?? ""}:${g.due_date ?? ""}`;
}

export type HistoryPace = { expected: number; onPace: boolean; gap: number; perWeek: number; daysLeft: number };

export function historyPace(
  points: HistoryPoint[],
  goal: Pick<GrowthGoal, "target_value" | "due_date">,
  now: number,
  current: number | null,
): HistoryPace | null {
  if (goal.target_value === null || !goal.due_date || points.length === 0) return null;
  const due = Date.parse(`${goal.due_date.slice(0, 10)}T23:59:59Z`);
  const t0 = Date.parse(points[0].at);
  if (!Number.isFinite(due) || !Number.isFinite(t0) || due <= t0) return null;
  const v0 = points[0].value;
  const target = goal.target_value;
  const nowValue = current ?? points[points.length - 1].value;
  const frac = Math.min(1, Math.max(0, (now - t0) / (due - t0)));
  const expected = v0 + (target - v0) * frac;
  const up = target >= v0;
  const onPace = up ? nowValue >= expected : nowValue <= expected;
  const daysLeft = Math.max(0, Math.ceil((due - now) / DAY));
  const weeksLeft = Math.max(daysLeft / 7, 1 / 7);
  return { expected, onPace, gap: Math.abs(expected - nowValue), perWeek: (target - nowValue) / weeksLeft, daysLeft };
}

export type GoalPill = { label: "Met" | "On pace" | "Behind" | "Not counted yet" | "Past due"; tone: ChipTone };

export function goalPill(
  goal: GrowthGoal,
  fix: MeasurementNeed | null | typeof LOADING,
  history: HistoryRead | undefined,
  now: number = Date.now(),
): GoalPill | null | typeof LOADING {
  if (fix === LOADING) return LOADING;
  if (fix !== null && fix.kind !== "none") return { label: "Not counted yet", tone: "wait" };
  if (fix === null || goal.current_value === null) return null;
  if (goalProgress(goal) === 100) return { label: "Met", tone: "good" };
  const due = goal.due_date ? Date.parse(`${goal.due_date.slice(0, 10)}T23:59:59Z`) : NaN;
  if (Number.isFinite(due) && due < now) return { label: "Past due", tone: "quiet" };
  if (history === undefined || history === "loading") return LOADING;
  if (history === "failed") return null;
  const pace = historyPace(history, goal, now, goal.current_value);
  if (!pace || pace.daysLeft === 0) return null;
  return pace.onPace ? { label: "On pace", tone: "good" } : { label: "Behind", tone: "bad" };
}

export function goalStatusLine(pills: Array<GoalPill | null>): string | null {
  if (pills.length === 0) return null;
  const count = (label: GoalPill["label"]) => pills.filter((p) => p?.label === label).length;
  const parts = [
    { n: count("On pace"), one: "on pace", many: "on pace" },
    { n: count("Behind"), one: "behind", many: "behind" },
    { n: count("Met"), one: "met", many: "met" },
    { n: count("Past due"), one: "past due", many: "past due" },
    { n: count("Not counted yet"), one: "is not counted yet", many: "are not counted yet" },
  ].filter((p) => p.n > 0);
  if (parts.length === 0) return null;
  return parts
    .map((p, i) => {
      const noun = i === 0 ? ` ${p.n === 1 ? "goal" : "goals"}` : "";
      return `${p.n}${noun} ${p.n === 1 ? p.one : p.many}.`;
    })
    .join(" ");
}

export function daysLeftLabel(goal: GrowthGoal, now: number): string | null {
  if (!goal.due_date) return null;
  const due = Date.parse(`${goal.due_date.slice(0, 10)}T23:59:59Z`);
  if (!Number.isFinite(due) || due < now) return null;
  const n = Math.max(0, Math.ceil((due - now) / DAY));
  return `${n} ${n === 1 ? "day" : "days"} left`;
}

export function goalNumberSource(goal: GrowthGoal, now: Date = new Date()): string | null {
  if (goal.counted_as) return `counted daily: ${goal.counted_as}${goal.count_failing ? " (last count failed)" : ""}`;
  if (goal.current_value === null || goal.measurement_mode === "auto") return null;
  const at = goal.current_value_at ? Date.parse(goal.current_value_at) : NaN;
  if (!Number.isFinite(at)) return "entered by you";
  const then = new Date(at);
  const days = Math.max(
    0,
    Math.floor(
      (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate())) /
        DAY,
    ),
  );
  return days === 0 ? "entered today by you" : `entered ${days} day${days === 1 ? "" : "s"} ago by you`;
}

export function goalMeta(goal: GrowthGoal, now: number): string {
  return [goalNumberSource(goal, new Date(now)), daysLeftLabel(goal, now)].filter(Boolean).join(" · ");
}

export function goalBarPercent(goal: GrowthGoal, measured: boolean): number | null {
  if (!measured) return null;
  const fromBaseline = goalProgress(goal);
  if (fromBaseline !== null) return Math.max(0, Math.min(100, fromBaseline));
  if (goal.current_value === null || goal.target_value === null || goal.target_value <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((goal.current_value / goal.target_value) * 100)));
}

export function goalCountLabel(activeCount: number): string {
  return `${activeCount} active`;
}

function chipFor(value: string): string | null {
  const label = metricLabel(value.trim()).trim();
  if (label.length === 0) return null;
  const lowered = /^[A-Z]{2,}/.test(label) ? label : `${label.slice(0, 1).toLowerCase()}${label.slice(1)}`;
  return `Improve ${lowered}`;
}

export function goalSuggestions(plan: GrowthPlanRow | null): string[] {
  const chips: string[] = [];
  for (const value of [plan?.north_star_metric, plan?.constraint_lever_family]) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const chip = chipFor(value);
    if (chip !== null && !chips.includes(chip)) chips.push(chip);
  }
  return chips;
}

export function suggestedGoal(items: GrowthGoal[]): GrowthGoal | null {
  return items.find((g) => g.status === "proposed" && g.source === "agent_proposed") ?? null;
}

export function goalDueLabel(goal: GrowthGoal, now: Date = new Date()): string | null {
  return goal.due_date ? `by ${shortDate(goal.due_date, now)}` : null;
}

export const HYP_LABEL: Record<GoalHypothesisStatus, string> = {
  confirmed: "Backed by evidence",
  testing: "Testing",
  listed: "To test",
  ruled_out: "Ruled out",
};

export const HYP_TONE: Record<GoalHypothesisStatus, ChipTone> = {
  confirmed: "good",
  testing: "live",
  listed: "quiet",
  ruled_out: "quiet",
};

export function bestGuess<T extends { status: string }>(hypotheses: readonly T[]): T | null {
  return (
    hypotheses.find((h) => h.status === "testing") ??
    hypotheses.find((h) => h.status === "listed") ??
    hypotheses.find((h) => h.status === "confirmed") ??
    null
  );
}

export function ideasLine(hypotheses: readonly GoalHypothesis[]): string {
  const open = hypotheses.filter((h) => h.status !== "ruled_out");
  const checking = open.filter((h) => h.research_running === true).length;
  const ruledOut = hypotheses.length - open.length;
  return [`${open.length} ${open.length === 1 ? "idea" : "ideas"}, ${checking} with a check open`, ruledOut > 0 ? `ruled out ${ruledOut}` : null]
    .filter(Boolean)
    .join(" · ");
}

export function keepConstraintKey(plan: Pick<GrowthPlanRow, "id" | "version">, hypothesisId: string): string {
  return `zavi.growth.keepConstraint:${plan.id}:${plan.version}:${hypothesisId}`;
}

export function unstop(text: string): string {
  return text.trim().replace(/\.+$/, "");
}

export function replacementGuess<T extends { id: string; status: string; claim: string }>(
  hypotheses: readonly T[],
  conflict: ConstraintConflict,
): T | null {
  const best = bestGuess(hypotheses);
  if (!best || best.id === conflict.hypothesis_id) return null;
  const same = (a: string) => unstop(a).toLowerCase();
  return same(best.claim) === same(conflict.claim) ? null : best;
}

export function updatePlanMessage(
  statement: string,
  conflict: ConstraintConflict,
  goal: Pick<GrowthGoal, "objective">,
  best?: { claim: string } | null,
): string {
  const head = `Your plan's blocker is "${unstop(statement)}", but you ruled out "${unstop(conflict.claim)}" for ${goal.objective}.`;
  return best?.claim.trim()
    ? `${head} Your best guess now is "${unstop(best.claim)}". Update the plan's blocker to what the evidence shows.`
    : `${head} Update the plan's blocker to what the evidence shows.`;
}

function goalConflict(goalId: string, plan: GrowthPlanRow | null, conflicts: readonly ConstraintConflict[]): ConstraintConflict | null {
  if (!plan || !plan.constraint_statement?.trim()) return null;
  return conflicts.find((x) => x.goal_id === goalId) ?? null;
}

export function conflictFor(
  goalId: string,
  plan: GrowthPlanRow | null,
  conflicts: readonly ConstraintConflict[],
  savedKept: ReadonlySet<string>,
): ConstraintConflict | null {
  const c = goalConflict(goalId, plan, conflicts);
  return c && !c.kept_at && !savedKept.has(c.hypothesis_id) ? c : null;
}

export function keptConflictFor(
  goalId: string,
  plan: GrowthPlanRow | null,
  conflicts: readonly ConstraintConflict[],
  savedKept: ReadonlySet<string>,
): (ConstraintConflict & { kept_at: string }) | null {
  const c = goalConflict(goalId, plan, conflicts);
  if (!c) return null;
  if (c.kept_at) return { ...c, kept_at: c.kept_at };
  return savedKept.has(c.hypothesis_id) ? { ...c, kept_at: new Date().toISOString() } : null;
}

export function keptDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export const askWhy = (statement: string) =>
  `You think "${statement}". How sure are you, and what would change your mind?`;
export const askChangeConstraint = (statement: string) =>
  `I'm not sure "${statement}" is what's in the way. Let's talk.`;
export const askAboutChannel = (name: string) =>
  `Talk me through ${name} in my plan: why it's there, how it's doing, and what you'd change.`;

export const STATE_LABEL: Record<GoalMoveState, string> = {
  waiting: "Waiting for you",
  declined: "You said not now",
  starting: "Starting",
  running: "Running",
  done: "Done",
  blocked: "Ran, but the change failed",
  failed: "Didn't finish",
};

export const STATE_TONE: Record<GoalMoveState, ChipTone> = {
  waiting: "wait",
  declined: "quiet",
  starting: "live",
  running: "live",
  done: "good",
  blocked: "bad",
  failed: "bad",
};

export function foldFailedRetries(moves: GoalMove[]): Array<{ move: GoalMove; tries: number }> {
  const out: Array<{ move: GoalMove; tries: number }> = [];
  const failedAt = new Map<string, number>();
  for (const move of moves) {
    if (move.state === "failed") {
      const at = failedAt.get(move.agent);
      if (at !== undefined) {
        out[at].tries += 1;
        continue;
      }
      failedAt.set(move.agent, out.length);
    }
    out.push({ move, tries: 1 });
  }
  return out;
}

export function weekMomentum(work: Record<string, GoalWork> | undefined, now: Date = new Date()): Array<{ tone: ChipTone; label: string }> {
  const since = now.getTime() - 7 * DAY;
  const seen = new Set<string>();
  const count = { done: 0, running: 0, waiting: 0, failed: 0 };
  for (const goal of Object.values(work ?? {})) {
    for (const m of goal.moves) {
      if (seen.has(m.decision_id)) continue;
      seen.add(m.decision_id);
      const at = Date.parse(m.emitted_at);
      if (!Number.isFinite(at) || at < since) continue;
      if (m.state === "done") count.done += 1;
      else if (m.state === "running" || m.state === "starting") count.running += 1;
      else if (m.state === "waiting") count.waiting += 1;
      else if (m.state === "failed" || m.state === "blocked") count.failed += 1;
    }
  }
  const out: Array<{ tone: ChipTone; label: string }> = [];
  if (count.done) out.push({ tone: "good", label: `${count.done} done` });
  if (count.running) out.push({ tone: "live", label: `${count.running} running` });
  if (count.waiting) out.push({ tone: "wait", label: `${count.waiting} waiting for you` });
  if (count.failed) out.push({ tone: "bad", label: `${count.failed} didn't finish` });
  return out;
}

export function happenedMoves(work: Record<string, GoalWork> | undefined): Array<{ move: GoalMove; tries: number }> {
  const seen = new Set<string>();
  const all: GoalMove[] = [];
  for (const goal of Object.values(work ?? {})) {
    for (const m of goal.moves) {
      if (seen.has(m.decision_id) || m.state === "waiting") continue;
      seen.add(m.decision_id);
      all.push(m);
    }
  }
  all.sort((a, b) => (Date.parse(b.emitted_at) || 0) - (Date.parse(a.emitted_at) || 0));
  return foldFailedRetries(all);
}

export const HAPPENED_SHOWN = 6;

export type YouAsked = { question: string; at: string; answer: string | null };

export function youAskedOf(body: unknown): YouAsked | null {
  const a = (body as { asked?: unknown } | null)?.asked as Partial<YouAsked> | null | undefined;
  return a && typeof a.question === "string" && a.question.trim()
    ? {
        question: a.question,
        at: typeof a.at === "string" ? a.at : "",
        answer: typeof a.answer === "string" && a.answer.trim() ? a.answer : null,
      }
    : null;
}

export function answerLines(answer: string | null | undefined): string[] {
  return (answer ?? "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
}
