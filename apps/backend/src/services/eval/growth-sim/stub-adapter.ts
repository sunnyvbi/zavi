
import type { AgentAdapter, SimApplied, SimDecision, SimSignals, SimWorldView } from "./types";

export const MOVE_ALLOWLIST = ["engineer", "pm", "research", "content-design"] as const;

const PENDING_DAYS = 5;
const SILENT_DAYS = 7;
const OFF_PACE = 0.75;

function conditions(s: SimSignals): string[] {
  const out: string[] = [];
  if (s.channels.some((c) => !c.paused && (c.cards14d.oldestPendingAge ?? 0) >= PENDING_DAYS)) out.push("cards_untouched");
  if (s.founder.daysSilent >= SILENT_DAYS) out.push("founder_silent");
  if (s.goal.current < s.goal.expectedByNow * OFF_PACE) out.push("goal_off_pace");
  return out;
}

export function createStubAdapter(): AgentAdapter {
  const conditionsAtLastReview = new Map<number, string[]>();
  const askedAt = new Map<string, number>();
  return {
  name: "stub",

  dailyCheck(s) {
    const reasons: string[] = [];
    if (s.lastNote === null || (s.nextReviewDay !== null && s.day >= s.nextReviewDay)) reasons.push("review_due");
    const lastDay = s.lastNote?.day ?? 0;
    const woke = s.lastNote ? conditionsAtLastReview.get(lastDay) ?? [] : [];
    for (const c of conditions(s)) if (!woke.includes(c)) reasons.push(c);
    return reasons;
  },

  async review(view: SimWorldView) {
    conditionsAtLastReview.set(view.day, conditions(view));
    const d: SimDecision = { note: { saw: [], changed: [], need: [] }, goalChanges: [], channelPauses: [], moves: [], next_review_in_days: 7 };
    const asked = new Set([...view.openAsks, ...view.founder.answers.map((a) => a.ask)]);
    const ask = (text: string) => {
      if (!asked.has(text) && d.note.need.length < 2) d.note.need.push(text);
    };

    for (const ch of view.channels) {
      if (ch.paused) continue;
      const k = ch.cards14d;
      const acted = k.approved + k.rejected;
      if (k.pending >= PENDING_DAYS && acted === 0) {
        d.note.saw.push(`${ch.slug}: ${k.pending} cards untouched`);
        if (ch.addedBy === "plan") {
          const at = askedAt.get(ch.slug);
          if (at === undefined) {
            ask(`${ch.slug}: none of its cards were approved. Keep it, or pause it?`);
            askedAt.set(ch.slug, view.day);
          } else if (view.day - at >= 2) d.channelPauses.push({ slug: ch.slug, why: `${k.pending} cards untouched, no answer` });
        }
        else ask(`You added ${ch.slug}; its cards sit untouched. Keep it?`);
      }
      if (k.rejected >= 3 && k.approved === 0) {
        d.note.saw.push(`${ch.slug}: every card rejected`);
        ask(`Every ${ch.slug} card was rejected. Is the budget wrong?`);
      }
    }

    const t = view.tiles7d;
    if (t.visits >= 100 && t.conversionPct < 1 && !view.movesSoFar.some((m) => m.target_agent === "engineer")) {
      d.note.saw.push(`conversion is ${t.conversionPct}% on ${t.visits} visits: the landing page is the constraint`);
      d.moves.push({ target_agent: "engineer", what: "Fix the landing page; conversion is far below normal" });
    }

    const g = view.goal;
    if (!g.changedByAgent && view.day >= 7 && g.current < g.expectedByNow * OFF_PACE) {
      const projected = Math.round((g.current / view.day) * g.dueDays);
      if (projected < g.target * OFF_PACE) {
        const target = Math.max(1, Math.round(projected * 1.25));
        d.note.saw.push(`on pace for ${projected} of ${g.target}`);
        ask(`At this pace the goal reaches about ${projected} of ${g.target}. Should I lower the target to ${target}?`);
      }
    }

    if (view.founder.daysSilent >= SILENT_DAYS) {
      d.note.saw.push(`no activity from you for ${view.founder.daysSilent} days`);
      ask("Nothing from you in a week. The one thing: approve or reject the waiting cards.");
    }

    return { decision: d, applied: applyGuards(d, view) };
  },
  };
}

export function applyGuards(d: SimDecision, view: SimWorldView): SimApplied {
  const autopilot = view.autopilotEnabled;
  const planned = new Set(view.channels.filter((c) => c.addedBy === "plan").map((c) => c.slug));
  const channelSlugs = new Set(view.channels.map((c) => c.slug));
  const days = Math.min(14, Math.max(2, d.next_review_in_days ?? 7));
  return {
    note: d.note,
    goalChanges: autopilot
      ? d.goalChanges
          .slice(0, 1)
          .filter((g): g is { target: number; why: string } => typeof g.target === "number")
          .map((g) => ({ ...g, undo: { target: view.goal.target } }))
      : [],
    channelPauses: autopilot ? d.channelPauses.filter((p) => planned.has(p.slug)) : [],
    moves: autopilot
      ? d.moves.filter((m) => (MOVE_ALLOWLIST as readonly string[]).includes(m.target_agent) && !channelSlugs.has(m.target_agent))
      : [],
    nextReviewInDays: days,
  };
}
