
import type { GoalMove, GrowthPlan, Pending } from "./plan";

export type SourceState = "loading" | "ready" | "failed";

export type WaitingQuestion = {
  id: string;
  ordinal: number | null;
  ask: string;
  recommended: "yes" | "no" | null;
  why: string | null;
  yes_no: boolean;
  fact_check: boolean;
};

export function questionsOf(body: unknown): { questions: WaitingQuestion[]; canAnswer: boolean } {
  const j = (body ?? {}) as { can_answer?: unknown; questions?: unknown };
  const questions = (Array.isArray(j.questions) ? j.questions : []).flatMap((q): WaitingQuestion[] => {
    const x = (q ?? {}) as Record<string, unknown>;
    if (typeof x.id !== "string" || typeof x.ask !== "string") return [];
    return [
      {
        id: x.id,
        ordinal: typeof x.ordinal === "number" ? x.ordinal : null,
        ask: x.ask,
        recommended: x.recommended === "yes" || x.recommended === "no" ? x.recommended : null,
        why: typeof x.why === "string" && x.why.trim() ? x.why : null,
        yes_no: x.yes_no === true,
        fact_check: x.fact_check === true,
      },
    ];
  });
  return { questions, canAnswer: j.can_answer === true };
}

export const QUESTIONS_SHOWN = 2;

export function foldQuestions<T>(questions: readonly T[], all: boolean): { shown: readonly T[]; hidden: number } {
  const hidden = Math.max(0, questions.length - QUESTIONS_SHOWN);
  return { shown: all || hidden === 0 ? questions : questions.slice(0, QUESTIONS_SHOWN), hidden };
}

export function questionText(q: WaitingQuestion): { ask: string; recommend: string | null } {
  const rec = q.recommended === "yes" ? "Yes" : q.recommended === "no" ? "No" : null;
  return { ask: `${q.ordinal != null ? `${q.ordinal}. ` : ""}${q.ask}`, recommend: rec ? ` (I recommend: ${rec})` : null };
}

export type Answer = "yes" | "no";

export function answerButtons(q: WaitingQuestion): Array<{ answer: Answer; label: string; primary: boolean }> {
  return (["yes", "no"] as const).map((a) => ({
    answer: a,
    label: a === "yes" ? "Yes" : "No",
    primary: q.recommended === a || (!q.recommended && !q.fact_check && a === "yes"),
  }));
}

export type Answered = { label: string; note: string | null };

export const ANSWER_ERROR = "Could not save your answer. Try again.";

function answeredLabel(answer: unknown): string {
  if (answer === "yes") return "Yes";
  if (answer === "no") return "No";
  if (answer === "not_now") return "Not now";
  if (answer && typeof answer === "object" && typeof (answer as { text?: unknown }).text === "string") {
    return `"${(answer as { text: string }).text}"`;
  }
  if (typeof answer === "string" && answer.trim()) return `"${answer.replace(/^My words: /, "")}"`;
  return "answered";
}

function viaLabel(via: unknown): string {
  return via === "slack" ? "Slack" : via === "email" ? "email" : "the web";
}

export function answeredOf(body: unknown, sent: Answer): Answered {
  const j = (body ?? {}) as { outcome?: unknown; answer?: unknown; via?: unknown; applied?: unknown; note?: unknown };
  const label = answeredLabel(j.answer ?? sent);
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  if (j.outcome === "already_answered") return { label: `Already answered: ${label} via ${viaLabel(j.via)}`, note: null };
  if (j.outcome === "closed") return { label: "No longer open", note: "Nothing changed." };
  const note = text(j.note);
  if (note) return { label: `Not applied: ${label}`, note };
  return { label: `Answered: ${label}`, note: text(j.applied) };
}

export type LeftRow = { line: string; url: string | null };

export function leftForYou(plan: GrowthPlan): { rows: LeftRow[]; label: string; more: { count: number; url: string; line: string } | null } {
  const note = plan.head_of_growth.note;
  if (note?.sections) {
    const needs = note.sections.find((s) => s.key === "needs_you") ?? null;
    return {
      rows: (needs?.rows ?? []).filter((r) => r.question_ordinal == null).map((r) => ({ line: r.line, url: r.url })),
      label: "Needs you",
      more: needs?.more ?? null,
    };
  }
  return {
    rows: note && Array.isArray(note.questions) ? note.need.map((line) => ({ line, url: null })) : [],
    label: "Left for you",
    more: null,
  };
}

export function waitingMoves(plan: GrowthPlan): Array<{ move: GoalMove; actsOn: string | null }> {
  const out: Array<{ move: GoalMove; actsOn: string | null }> = [];
  const seen = new Set<string>();
  for (const w of Object.values(plan.goal_work)) {
    const claims = new Map((w.hypotheses ?? []).map((h) => [h.id, h.claim]));
    for (const m of w.moves) {
      if (m.state !== "waiting" || seen.has(m.decision_id)) continue;
      seen.add(m.decision_id);
      out.push({ move: m, actsOn: m.hypothesis_id ? claims.get(m.hypothesis_id) ?? null : null });
    }
  }
  return out;
}

export type Needs = {
  state: SourceState;
  total: number;
  count: string;
  aside: string | null;
  footer: string | null;
  reviewLabel: string | null;
  showPill: boolean;
  empty: boolean;
};

export function needsModel(input: {
  questions: { state: SourceState; open: number; listed: number };
  pending: Pending | null;
  approvalsSettled: boolean;
  goalWorkUnreadable: boolean;
  hogUnreadable: boolean;
  left: number;
  more: number;
  waitingMoves: number;
  countless: boolean;
}): Needs {
  const sources: SourceState[] = [
    input.questions.state,
    !input.approvalsSettled ? "loading" : input.pending === null ? "failed" : "ready",
    input.goalWorkUnreadable ? "failed" : "ready",
    input.hogUnreadable ? "failed" : "ready",
  ];
  const state: SourceState = sources.includes("loading") ? "loading" : sources.includes("failed") ? "failed" : "ready";
  const pending = input.pending;
  const total = input.questions.open + input.left + input.more + input.waitingMoves + (pending?.total ?? 0);
  const capped = pending?.capped ?? false;
  const count = `${total}${capped ? "+" : ""}`;
  const forYou = pending ? Math.max(0, pending.total - pending.toApprove) : 0;
  const aside =
    state === "ready" && total > 0
      ? input.countless
        ? "Waiting for you"
        : [
            `${count} waiting`,
            pending && pending.toApprove > 0 ? `${pending.toApprove}${pending.capped ? "+" : ""} to approve` : null,
            forYou > 0 ? `${forYou} for you` : null,
          ]
            .filter(Boolean)
            .join(" · ")
      : null;
  const waits = !!pending && pending.total > 0;
  return {
    state,
    total,
    count,
    aside,
    footer: waits
      ? input.countless
        ? "Nothing runs until you OK it."
        : pending.total === 1 && !pending.capped
          ? "1 action waits for your OK."
          : `${pending.total}${pending.capped ? "+" : ""} actions wait for your OK.`
      : null,
    reviewLabel: waits ? (input.countless ? "Review" : `Review all ${pending.total}${pending.capped ? "+" : ""}`) : null,
    showPill: state === "ready" && total > 0 && !input.countless,
    empty: state === "ready" && total === 0 && input.questions.listed === 0,
  };
}
