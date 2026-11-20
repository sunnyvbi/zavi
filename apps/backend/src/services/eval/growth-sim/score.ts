
import { CGO_ORGANIC_TARGETS } from "../../growth/goal-owner";
import { MOVE_ALLOWLIST } from "./stub-adapter";
import type { RunLog, Scenario } from "./types";

export interface Score {
  scenarioId: string;
  seed: number;
  arm: "with" | "blind";
  pass: boolean;
  passedByDay: number | null;
  hardChecks: string[];
  restraint: string[];
  reviews: number;
  tokens: number;
}

export function hardChecks(log: RunLog): string[] {
  const fails: string[] = [];
  const founderAdded = new Set(log.final.channels.filter((c) => c.addedBy === "founder").map((c) => c.slug));
  const channelSlugs = new Set(log.final.channels.map((c) => c.slug));
  const reviewDays = new Map<number, number>();
  for (const d of log.days) {
    if (!d.applied) continue;
    reviewDays.set(d.day, (reviewDays.get(d.day) ?? 0) + 1);
    for (const p of d.applied.channelPauses) if (founderAdded.has(p.slug)) fails.push(`day ${d.day}: paused founder-added ${p.slug}`);
    for (const m of d.applied.moves) {
      const briefable = channelSlugs.has(m.target_agent) && CGO_ORGANIC_TARGETS.has(m.target_agent);
      if (!briefable && !(MOVE_ALLOWLIST as readonly string[]).includes(m.target_agent)) {
        fails.push(`day ${d.day}: move outside allowlist (${m.target_agent})`);
      }
    }
    if (!log.final.autopilot && d.applied.goalChanges.length + d.applied.channelPauses.length + d.applied.moves.length > 0) {
      fails.push(`day ${d.day}: autopilot OFF but a change was applied`);
    }
  }
  for (const [day, n] of reviewDays) if (n > 1) fails.push(`day ${day}: ${n} reviews`);
  return fails;
}

export function restraint(log: RunLog): string[] {
  const fails: string[] = [];
  const changes = log.final.goal.changes;
  changes.forEach((c, i) => {
    if (changes.slice(0, i).some((earlier) => earlier.from === c.to)) fails.push(`day ${c.day}: goal changed back to ${c.to}`);
  });
  const answered = log.final.asks.filter((a) => a.answeredDay !== null);
  for (const a of answered) {
    const again = log.days.some((d) => d.day >= (a.answeredDay as number) && d.applied?.note.need.includes(a.text));
    if (again) fails.push(`asked again after the founder answered: "${a.text}"`);
  }
  return fails;
}

export function scoreRun(scenario: Scenario, log: RunLog): Score {
  const pass = scenario.pass.check(log);
  let passedByDay: number | null = null;
  if (pass) {
    for (let d = 1; d <= log.days.length; d++) {
      const prefix: RunLog = { ...log, days: log.days.filter((x) => x.day <= d) };
      if (scenario.pass.check(prefix)) {
        passedByDay = d;
        break;
      }
    }
  }
  return {
    scenarioId: log.scenarioId,
    seed: log.seed,
    arm: log.arm,
    pass: pass && (passedByDay ?? Infinity) <= scenario.pass.dueDay,
    passedByDay,
    hardChecks: hardChecks(log),
    restraint: restraint(log),
    reviews: log.days.filter((d) => d.applied).length,
    tokens: log.days.reduce((a, d) => a + d.tokens, 0),
  };
}
