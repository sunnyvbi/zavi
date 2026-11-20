
import { buildNoteItems, cleanReason, deriveHeadline, itemText, noteSections, validHeadline, type NoteItem } from "@/services/growth/cgo-note-items";
import {
  channelViews,
  clampNextReviewDays,
  computeAlarms,
  founderView,
  isOffPace,
  type AlarmReason,
  type NoteKind,
  type WatchNote,
  type WatchState,
} from "@/services/growth/cgo-watch";
import {
  CGO_AUTO_RUN_TARGETS,
  CGO_ORGANIC_TARGETS,
  CGO_TARGETS,
  OWN_GOALS_STAGE,
  autoRunLine,
  composeGoalOwnerContext,
  endedReason,
  goalAfterChange,
  goalRev,
  isNoteVisible,
  parseGoalMoves,
  pauseOutcomeLine,
  planChannelPauses,
  planGoalCards,
  repeatKey,
  planGoalChanges,
  planModelQuestions,
  planNote,
  planOpenCards,
  questionNoteLine,
  reviewMetaFromPayload,
  REPEAT_MOVE_DAYS,
  utcDay,
  type GoalRow,
  type GoalMoves,
} from "@/services/growth/goal-owner";
import { defaultLine, planQuestions, type QuestionAsk, type QuestionRow } from "@/services/growth/cgo-questions";
import { CHANNELS } from "@zavi/shared";
import type { AgentAdapter, SimApplied, SimDecision, SimSignals, SimState, SimWorldView } from "./types";
import {
  gainPlausible,
  makeGate,
  moveClass,
  parseEach,
  planHypotheses,
  proposedHypothesisSchema,
  readFindingSchema,
  runChecker,
  type CheckerCall,
  type CheckItem,
  type EvidenceEntry,
  type HypothesisRow,
} from "@/services/growth/cgo-hypotheses";

function simAgentName(slug: string): string {
  const ch = CHANNELS.find((c) => c.slug === slug)?.name;
  if (ch) return ch;
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : slug;
}

const DAY = 86_400_000;
export const SIM_START = Date.UTC(2026, 9, 1, 12);
export const SIM_GOAL_ID = "00000000-0000-4000-8000-000000000001";
const SIM_TENANT = "sim-tenant";

export const simNow = (day: number) => new Date(SIM_START + day * DAY);
const iso = (day: number) => simNow(day).toISOString();
const isoDate = (day: number) => iso(day).slice(0, 10);

export type CgoModelCall = (systemPrompt: string, userPrompt: string) => Promise<{ text: string; tokens: number }>;

type CgoCard = {
  id: string;
  body: Record<string, unknown>;
  status: "proposed" | "expired" | "approved" | "rejected";
  approvedDay?: number;
};
const STEP_DAYS = 2;

export function goalRowOf(state: SimState, outcomeLabel: string): GoalRow & { created_at: string } {
  return {
    id: SIM_GOAL_ID,
    objective: state.goal.objective,
    target_metric: state.goal.targetMetric ?? outcomeLabel,
    target_value: state.goal.target,
    current_value: state.goal.current,
    baseline_value: state.goal.baseline,
    due_date: isoDate(state.goal.dueDays),
    status: "active",
    priority: 1,
    measurement_mode: "auto",
    current_value_at: iso(state.day),
    current_value_source: "the business's own records (simulated)",
    created_at: iso(0),
  };
}

export function watchStateOf(
  state: SimState,
  outcomeLabel: string,
  notes: WatchNote[],
  lastCheckRunAt: string | null,
  openTopics: string[] = [],
): WatchState {
  const day = state.day;
  const recent = state.cards.filter((c) => day - c.day < 14);
  const decided = (status: "approved" | "rejected") =>
    state.cards.filter((c) => c.status === status && c.decidedDay !== null && day - c.decidedDay < 14).length;
  return {
    goals: [goalRowOf(state, outcomeLabel)],
    pending: state.cards
      .filter((c) => c.status === "pending")
      .map((c) => ({ id: c.id, channel_slug: c.channel, status: "pending", proposed_at: iso(c.day) })),
    recent: recent.map((c) => ({
      id: c.id,
      channel_slug: c.channel,
      status: c.status === "approved" ? "acted" : c.status,
      proposed_at: iso(c.day),
    })),
    channels: state.channels.map((ch) => {
      const cs = state.cards.filter((c) => c.channel === ch.slug);
      const seen = cs.map((c) => c.seenDay).filter((d): d is number => d !== null);
      return {
        channel_slug: ch.slug,
        plan_selected: ch.pausedDay === null,
        plan_selected_set_by: ch.addedBy,
        autorun: true,
        last_run_at: cs.length ? iso(Math.max(...cs.map((c) => c.day))) : null,
        founder_seen_at: seen.length ? iso(Math.max(...seen)) : null,
        cgo_reason: ch.pausedWhy,
        cgo_set_at: ch.pausedDay === null ? null : iso(ch.pausedDay),
      };
    }),
    notes,
    founder_last_active_at: state.founderLastActiveDay > 0 ? iso(state.founderLastActiveDay) : null,
    last_check_run_at: lastCheckRunAt,
    approvals_14d: decided("approved"),
    rejections_14d: decided("rejected"),
    metrics: state.channels.map((ch) => ({
      channel_slug: ch.slug,
      metric_key: "visits_7d",
      value: Object.entries(ch.visitsByDay).filter(([d]) => day - Number(d) < 7).reduce((a, [, v]) => a + v, 0),
      unit: "visits",
      day: isoDate(day),
    })),
    open_topics: openTopics,
    autopilot: { enabled: state.autopilot, on_at: null },
    founder_rejected_channels: [...new Set(state.cards.filter((c) => c.status === "rejected" && day - c.day < 14).map((c) => c.channel))],
  };
}

export function simulatedStepResult(state: SimState, intent: string): string {
  const day = state.day;
  const per = state.channels
    .map((ch) => ({
      slug: ch.slug,
      visits: Object.entries(ch.visitsByDay)
        .filter(([d]) => day - Number(d) < 7)
        .reduce((a, [, v]) => a + v, 0),
      approved: state.cards.filter((c) => c.channel === ch.slug && c.status === "approved").length,
    }))
    .sort((a, b) => b.visits - a.visits);
  const recent = state.tiles.filter((t) => day - t.day < 7);
  const visits = recent.reduce((a, t) => a + t.visits, 0);
  const outcome = recent.reduce((a, t) => a + t.outcome, 0);
  const conv = visits ? ((outcome / visits) * 100).toFixed(2) : "0";
  const chans = per.map((p) => `${p.slug} ${p.visits} visits (${p.approved} posts approved)`).join(", ");
  return `Simulated result. Last 7 days: ${visits} site visits, ${outcome} outcomes, ${conv}% conversion. By channel: ${chans}; the rest came from sources no channel tracks. Task was: ${intent.slice(0, 160)}`;
}

export function runContextBlock(payload: Record<string, unknown>): string {
  return [
    "## Run context",
    "Run context (JSON):",
    "```json",
    JSON.stringify({ tenant_id: SIM_TENANT, recent_runs: [], payload }, null, 2),
    "```",
    "",
    "Follow your spec. If you have tools, use them. Produce your final output now.",
  ].join("\n");
}

function decisionOf(moves: GoalMoves): SimDecision {
  return {
    note: {
      saw: moves.note?.saw ?? [],
      changed: [],
      need: [...(moves.note?.questions ?? []).map((q) => q.ask), ...(moves.note?.need ?? [])],
    },
    goalChanges: (moves.goal_changes ?? []).map((g) => ({ target: g.target_value, why: g.why })),
    channelPauses: (moves.channel_changes ?? []).map((c) => ({ slug: c.channel_slug, why: c.why })),
    moves: moves.goals.flatMap((g) => g.moves.map((m) => ({ target_agent: m.target_agent_slug, what: m.intent }))),
    next_review_in_days: moves.next_review_in_days,
  };
}

export function createCgoAdapter(opts: {
  outcomeLabel: string;
  systemPrompt: string;
  callModel: CgoModelCall;
  arm: "with" | "blind";
  causal?: boolean;
  hypotheses?: { checker: CheckerCall };
}): AgentAdapter {
  const notes: WatchNote[] = [];
  const cards: CgoCard[] = [];
  let lastCheckRunAt: string | null = null;
  let pending: { kind: NoteKind; keys: string[] } = { kind: "scheduled", keys: [] };
  let seq = 0;
  const questions: Array<QuestionRow & { asked_run_id: string; note_line: string }> = [];
  let reply: { text: string } | null = null;

  function sweepExpired(state: SimState): void {
    const now = simNow(state.day);
    const lines: string[] = [];
    for (const q of questions) {
      if (q.status !== "open" || !q.expires_at || Date.parse(q.expires_at) > now.getTime()) continue;
      q.status = "expired";
      const act = q.default_action;
      if (!state.autopilot || !act || q.founder_replied_at) continue;
      if (act.kind === "pause_channel") {
        const ch = state.channels.find((c) => c.slug === act.channel_slug);
        if (!ch || ch.pausedDay !== null || ch.addedBy === "founder") continue;
        if (state.cards.some((c) => c.channel === ch.slug && c.status === "rejected" && state.day - c.day < 14)) continue;
        ch.pausedDay = state.day;
        ch.pausedWhy = act.why;
        for (const c of state.cards) if (c.channel === ch.slug && c.status === "pending") c.status = "stale";
        lines.push(`No answer on "${q.ask}", so I paused ${CHANNELS.find((c) => c.slug === ch.slug)?.name ?? ch.slug} as I said I would.`);
      } else {
        const g = goalRowOf(state, opts.outcomeLabel);
        if (goalRev(g) !== act.goal_rev) continue;
        const plan = planGoalChanges({
          changes: [{ goal_id: g.id, ...act.change, why: act.why }],
          goals: [g],
          today: utcDay(now),
          now,
          run_id: q.asked_run_id,
          acts: true,
          reviewedRevs: new Map([[g.id, act.goal_rev]]),
        });
        const w = plan.writes[0];
        if (!w) continue;
        const after = goalAfterChange(w);
        state.goal.changes.push({ day: state.day, from: state.goal.target, to: Number(after.target_value), why: act.why, undo: null });
        state.goal.target = Number(after.target_value);
        lines.push(`No answer on "${q.ask}", so I made the change I said I would.`);
      }
      q.default_applied = true;
    }
    if (lines.length > 0) {
      state.notes.push({ day: state.day, saw: [], changed: lines, need: [], by: "silence" });
      notes.unshift({
        id: `sweep-${state.day}`,
        kind: "alarm",
        saw: [],
        changed: lines,
        would_change: [],
        need: [],
        alarm_keys: [],
        next_review_at: notes[0]?.next_review_at ?? simNow(state.day + 7).toISOString(),
        created_at: now.toISOString(),
      });
    }
  }

  const jobOf = new Map<string, string>();
  function syncCausalCards(state: SimState): void {
    const taken = new Set(jobOf.values());
    for (const c of cards) {
      if (!jobOf.has(c.id)) {
        const j = state.jobs.find(
          (x) => !taken.has(x.id) && x.day === Number(c.body.proposed_day) && x.target_agent === String(c.body.target_agent_slug),
        );
        if (!j) continue;
        jobOf.set(c.id, j.id);
        taken.add(j.id);
      }
      const j = state.jobs.find((x) => x.id === jobOf.get(c.id));
      if (!j) continue;
      if (j.status === "rejected") c.status = "rejected";
      else if (j.status === "running" || j.status === "done" || j.awaitingGoLive) {
        c.status = "approved";
        c.approvedDay = j.startedDay ?? state.day;
      }
    }
  }
  function causalSteps(state: SimState): Array<{ agent_slug: string; status: string; payload: Record<string, unknown>; output_text: string }> {
    return state.jobs
      .filter((j) => j.status === "done" && j.report)
      .map((j) => ({ agent_slug: j.target_agent, status: "success", payload: { goal_id: SIM_GOAL_ID }, output_text: j.report as string }));
  }

  let hyps: HypothesisRow[] = [];
  const reportsSeen = new Set<string>();
  const hypRow = (over: Partial<HypothesisRow> & Pick<HypothesisRow, "id" | "goal_id" | "problem" | "claim">): HypothesisRow => ({
    tenant_id: "sim",
    refute_if: null,
    rank: 5,
    status: "listed",
    evidence: [],
    evidence_version: 0,
    expected_gain: null,
    research_open: false,
    research_card_id: null,
    created_at: "",
    status_at: "",
    ...over,
  });
  async function refreshSimHypotheses(state: SimState, goal: GoalRow, at: string): Promise<void> {
    if (!opts.hypotheses) return;
    for (const j of state.jobs) {
      if (!j.hypothesis_id || j.stage !== "diagnose" || reportsSeen.has(j.id)) continue;
      const h = hyps.find((x) => x.id === j.hypothesis_id);
      if (!h) continue;
      if (j.status === "rejected") {
        reportsSeen.add(j.id);
        h.research_open = false;
      } else if (j.status === "done" && j.report) {
        reportsSeen.add(j.id);
        h.research_open = false;
        h.evidence = [...h.evidence, { at, kind: "run", ref: j.id, excerpt: j.report } satisfies EvidenceEntry];
      }
    }
    const pending = hyps.filter((h) => (h.status === "listed" || h.status === "testing") && h.evidence.some((e) => !e.verdict));
    if (pending.length === 0) return;
    const numbers = `Goal "${goal.objective}": ${goal.current_value ?? "unknown"} of ${goal.target_value ?? "unknown"} so far (server numbers).`;
    const items: CheckItem[] = pending.map((h) => ({
      id: h.id,
      claim: h.claim,
      refute_if: h.refute_if,
      evidence: [{ source: "numbers", text: numbers }, ...h.evidence.map((e) => ({ source: e.kind, text: e.excerpt }))],
    }));
    const verdicts = await runChecker(items, opts.hypotheses.checker);
    if (verdicts === null) return;
    for (const v of verdicts) {
      const h = hyps.find((x) => x.id === v.id);
      if (!h) continue;
      h.evidence = h.evidence.map((e) => (e.verdict ? e : { ...e, verdict: v.verdict, why: v.why, quote: v.quote, checker: "gpt" }));
      const status = v.verdict === "testing" ? (h.status === "listed" ? "testing" : h.status) : v.verdict;
      if (status !== h.status) {
        h.status = status;
        h.status_at = at;
      }
    }
  }

  const allowedSim = (state: SimState): ReadonlySet<string> =>
    new Set([
      ...CGO_TARGETS,
      ...(state.autopilot ? state.channels.filter((c) => c.pausedDay === null && CGO_ORGANIC_TARGETS.has(c.slug)).map((c) => c.slug) : []),
    ]);

  return {
    name: "cgo",

    dailyCheck(_signals: SimSignals, state: SimState) {
      const live = goalRowOf(state, opts.outcomeLabel);
      const liveOk = endedReason(live, utcDay(simNow(state.day))) === null;
      if (opts.causal) syncCausalCards(state);
      else if (state.founderLastActiveDay === state.day && liveOk) {
        for (const c of cards) {
          if (c.status === "proposed" && Number(c.body.proposed_day) < state.day && c.body.goal_rev === goalRev(live)) {
            c.status = "approved";
            c.approvedDay = state.day;
          }
        }
      }
      const now = simNow(state.day);
      sweepExpired(state);
      for (const a of state.asks) {
        if (a.answer === null || a.answeredDay !== state.day) continue;
        const q = questions.find((x) => x.status === "open" && x.note_line.toLowerCase() === a.key);
        if (q) {
          reply = { text: a.answer };
          for (const o of questions) if (o.status === "open") o.founder_replied_at = now.toISOString();
        }
      }
      const openTopics = questions.filter((q) => q.status === "open").map((q) => q.topic_key);
      const r = computeAlarms(watchStateOf(state, opts.outcomeLabel, notes, lastCheckRunAt, openTopics), now, { autopilot: state.autopilot });
      pending = { kind: r.kind, keys: r.keys };
      if (reply) return [...(r.wake ? r.reasons : []), "founder_reply"];
      return r.wake ? r.reasons : [];
    },

    async review(view: SimWorldView, state: SimState) {
      const now = simNow(state.day);
      const run_id = `sim-run-${++seq}`;
      lastCheckRunAt = now.toISOString();
      const acts = state.autopilot;
      const watch = watchStateOf(state, opts.outcomeLabel, notes, lastCheckRunAt);
      const goals: GoalRow[] = [goalRowOf(state, opts.outcomeLabel)];
      const reviewedRevs = new Map(goals.map((g) => [g.id, goalRev(g)]));
      const thisReply = reply;
      reply = null;
      const wake = {
        kind: pending.kind,
        reason: thisReply ? ("founder_reply" as const) : ("daily_check" as const),
        check_reasons: view.wakeReasons.filter((r) => r !== "founder_reply") as AlarmReason[],
        autopilot: acts,
      };
      await refreshSimHypotheses(state, goals[0], now.toISOString());
      const context = composeGoalOwnerContext({
        ...(opts.hypotheses ? { hypotheses: hyps } : {}),
        today: utcDay(now),
        goals,
        channels: channelViews(watch, now),
        founder: founderView(watch, now),
        lastNote: notes[0] ?? null,
        cards: cards.map((c) => ({ body: c.body, status: c.status })),
        steps: opts.causal
          ? causalSteps(state)
          : cards
          .filter((c) => c.status === "approved" && state.day - (c.approvedDay as number) >= STEP_DAYS)
          .map((c) => ({
            agent_slug: String(c.body.target_agent_slug),
            status: "success",
            payload: { goal_id: c.body.goal_id },
            output_text: simulatedStepResult(state, String(c.body.intent)),
          })),
        agents: [...allowedSim(state)].sort(),
        wake,
        questions: questions.filter((q) => q.status === "open"),
        offPaceIds: new Set(watch.goals.filter((g) => isOffPace(g, now)).map((g) => g.id)),
        ...(thisReply ? { founderReply: { via: "email" as const, text: thisReply.text, reply_run_id: `sim-reply-${state.day}` } } : {}),
      });
      const prevNote = notes[0];
      const prevIdle = prevNote ? !isNoteVisible(prevNote) : false;
      const payload = {
        stage: OWN_GOALS_STAGE,
        reason: "daily_check",
        note_kind: wake.kind,
        autopilot: acts,
        alarm_keys: opts.arm === "blind" ? [] : pending.keys,
        memory: { cgo_goals: context },
      };
      const { text, tokens } = await opts.callModel(opts.systemPrompt, runContextBlock(payload));
      const parsed = parseGoalMoves(text);
      if (!parsed.ok) {
        const none: SimApplied = { note: { saw: [], changed: [], need: [] }, goalChanges: [], channelPauses: [], moves: [], nextReviewInDays: 0 };
        return { decision: { note: { saw: [`(unparseable review: ${parsed.reason})`], changed: [], need: [] }, goalChanges: [], channelPauses: [], moves: [] }, applied: none, tokens, raw: text };
      }
      const moves = parsed.value;
      const today = utcDay(now);
      const meta = {
        ...reviewMetaFromPayload({
          ...payload,
          prev_idle: prevIdle,
          reason: thisReply ? "founder_reply" : "daily_check",
          ...(thisReply ? { founder_reply: { via: "email" } } : {}),
        }),
        kind: wake.kind,
        alarm_keys: pending.keys,
      };
      const changedLines: string[] = [];
      const items: NoteItem[] = [];
      const serverAsks: QuestionAsk[] = [];
      const refused: string[] = [];
      if (meta.reply_via) {
        for (const a of moves.answered ?? []) {
          const q = questions.find((x) => x.id === a.question_id && x.status === "open");
          if (q) {
            q.status = "answered";
            q.answered_at = now.toISOString();
          }
        }
      }
      const applied: SimApplied = { note: { saw: [], changed: [], need: [] }, goalChanges: [], channelPauses: [], moves: [], nextReviewInDays: 7 };

      const gc = planGoalChanges({ changes: moves.goal_changes, goals, today, now, run_id, acts, reviewedRevs });
      serverAsks.push(...gc.held);
      refused.push(...gc.refused);
      const changedGoals = new Set<string>();
      for (const w of gc.writes) {
        const after = goalAfterChange(w);
        changedGoals.add(w.goal.id);
        changedLines.push(w.line);
        items.push({ section: "changed", text: w.line, goal_id: w.goal.id, undoable: true });
        goals[0] = after;
        const dueDays = after.due_date ? Math.round((Date.parse(`${after.due_date}T12:00:00Z`) - SIM_START) / DAY) : undefined;
        applied.goalChanges.push({
          target: Number(after.target_value),
          why: String((w.patch.cgo_undo as { why: string }).why),
          undo: { target: Number(w.goal.target_value) },
          ...(dueDays !== undefined && dueDays !== state.goal.dueDays ? { dueDays } : {}),
          ...(after.objective !== w.goal.objective ? { objective: after.objective } : {}),
          ...(after.target_metric !== w.goal.target_metric ? { targetMetric: after.target_metric } : {}),
        });
      }

      const byId = new Map(goals.map((g) => [g.id, g]));
      const openKeys = new Set<string>();
      for (const row of planOpenCards(cards.filter((c) => c.status === "proposed").map((c) => ({ id: c.id, body: c.body })), byId)) {
        const c = cards.find((x) => x.id === row.id);
        if (row.expire && c) c.status = "expired";
        else openKeys.add(row.key);
      }

      let gate: ReturnType<typeof makeGate> | undefined;
      if (opts.hypotheses) {
        const liveIds = new Set(goals.filter((g) => endedReason(g, today) === null).map((g) => g.id));
        const plan = planHypotheses({
          existing: hyps,
          proposed: parseEach(proposedHypothesisSchema, moves.hypotheses).ok,
          goalIds: liveIds,
          finishedRuns: new Map(),
        });
        refused.push(...plan.refused);
        const refMap = new Map<string, string>();
        for (const ins of plan.inserts) {
          const id = `00000000-0000-4000-a000-${String(hyps.length + 1).padStart(12, "0")}`;
          hyps.push(hypRow({ id, goal_id: ins.goal_id, problem: ins.problem, segment: ins.segment, claim: ins.claim, refute_if: ins.refute_if, rank: ins.rank, created_at: now.toISOString(), status_at: now.toISOString() }));
          refMap.set(`${ins.goal_id}:${ins.ref}`, id);
        }
        for (const up of plan.updates) {
          const h = hyps.find((x) => x.id === up.id);
          if (h) Object.assign(h, { claim: up.claim, refute_if: up.refute_if, rank: up.rank });
        }
        for (const f of parseEach(readFindingSchema, moves.read_findings).ok) {
          const id = hyps.some((h) => h.id === f.hypothesis) ? f.hypothesis : [...refMap.entries()].find(([k]) => k.endsWith(`:${f.hypothesis}`))?.[1];
          const h = id ? hyps.find((x) => x.id === id) : undefined;
          if (!h || h.status === "ruled_out" || h.status === "confirmed") continue;
          h.evidence = [...h.evidence, { at: now.toISOString(), kind: "cgo_read", ref: run_id, excerpt: f.finding }];
          if (h.status === "listed") h.status = "testing";
        }
        gate = makeGate(hyps, refMap);
      }

      const planned = planGoalCards({
        ...(gate ? { gate } : {}),
        liveGoals: goals.filter((g) => endedReason(g, today) === null),
        moves,
        changedGoals,
        acts,
        reviewedRevs,
        allowed: allowedSim(state),
        openKeys,
        recentKeys: new Set(
          cards
            .filter((c) => c.status === "approved" && state.day - (c.approvedDay as number) < REPEAT_MOVE_DAYS)
            .map((c) => repeatKey(String(c.body.goal_id), String(c.body.target_agent_slug), c.body.problem)),
        ),
        repo: { repo: "sim/site" },
        today,
      });
      if (!planned.needsRepo) {
        for (const pg of planned.goals) {
          for (const c of pg.cards) {
            const hypId = typeof c.body.hypothesis_id === "string" ? c.body.hypothesis_id : undefined;
            const h = hypId ? hyps.find((x) => x.id === hypId) : undefined;
            if (opts.hypotheses && h && moveClass(c.target) === "build") {
              const g = pg.goal;
              const gap = g.target_value != null && g.current_value != null ? g.target_value - g.current_value : null;
              if (!(await gainPlausible(h, Number(c.body.expected_gain), g.target_metric, gap, opts.hypotheses.checker))) {
                refused.push(`Work for ${c.target} on "${g.objective}": the checker did not agree its expected gain follows from the evidence.`);
                continue;
              }
            }
            if (opts.hypotheses && h && moveClass(c.target) === "research") {
              if (hyps.some((x) => x.goal_id === h.goal_id && x.research_open)) continue;
              h.research_open = true;
              if (h.status === "listed") h.status = "testing";
            }
            const auto = acts && (CGO_AUTO_RUN_TARGETS.has(c.target) || CGO_ORGANIC_TARGETS.has(c.target));
            cards.push({
              id: `${run_id}-${cards.length}`,
              body: { ...c.body, proposed_day: state.day },
              status: auto ? "approved" : "proposed",
              ...(auto ? { approvedDay: state.day } : {}),
            });
            if (auto) {
              changedLines.push(autoRunLine(c.target, String(c.body.intent)));
              const reason = cleanReason(c.note?.why);
              items.push({ section: "working_on", text: `${simAgentName(c.target)}: ${itemText(c.note?.action, String(c.body.intent))}`, ...(reason ? { reason } : {}), channel_slug: c.target });
            }
            applied.moves.push({
              target_agent: c.target,
              what: String(c.body.intent),
              problem: String(c.body.problem ?? "unspecified"),
              ...(hypId ? { hypothesis_id: hypId } : {}),
            });
          }
        }
      }

      const pp = planChannelPauses(
        moves.channel_changes,
        acts,
        new Set(meta.never_approved ?? []),
        new Set(meta.founder_channels ?? []),
        new Set(meta.rejected_channels ?? []),
      );
      serverAsks.push(...pp.asks);
      for (const p of pp.pauses) {
        const ch = state.channels.find((c) => c.slug === p.slug);
        if (!ch || ch.pausedDay !== null) continue;
        const line = pauseOutcomeLine(ch.addedBy === "founder" ? "founder_owned" : "ok", p);
        if (line.changed) {
          changedLines.push(line.changed);
          items.push({ section: "changed", text: line.changed, channel_slug: p.slug, undoable: true });
          applied.channelPauses.push({ slug: p.slug, why: p.why });
        } else if (line.need) {
          serverAsks.push({ required: true, topic_key: `channel:${p.slug}`, ask: line.need, default_action: null });
        }
      }

      const modelAsks = planModelQuestions({
        moves,
        goals,
        today,
        acts,
        reviewedRevs,
        rejected: new Set([...(meta.rejected_channels ?? []), ...(meta.founder_channels ?? [])]),
        neverApproved: new Set(meta.never_approved ?? []),
      });
      refused.push(...modelAsks.refused);
      const needLines: string[] = [];
      for (const q of planQuestions([...serverAsks, ...modelAsks.asks], questions, now)) {
        const dl = defaultLine(q.default_action, q.expires_at, goals[0]?.objective);
        const line = questionNoteLine(q.ask, dl, q.why ?? null);
        if (q.queued) {
          questions.push({
            id: `00000000-0000-4000-9000-${String(questions.length + 1).padStart(12, "0")}`,
            topic_key: q.topic_key,
            ask: q.ask,
            default_action: null,
            default_line: null,
            status: "queued",
            asked_at: now.toISOString(),
            expires_at: null,
            answered_at: null,
            asked_run_id: run_id,
            note_line: line,
          });
          continue;
        }
        questions.push({
          id: `00000000-0000-4000-9000-${String(questions.length + 1).padStart(12, "0")}`,
          topic_key: q.topic_key,
          ask: q.ask,
          default_action: q.default_action,
          default_line: dl,
          status: "open",
          asked_at: now.toISOString(),
          expires_at: q.expires_at,
          answered_at: null,
          asked_run_id: run_id,
          note_line: line,
        });
        needLines.push(line);
        items.push({ section: "needs_you", text: line, question_ordinal: needLines.length });
      }

      const noteItems = buildNoteItems(items);
      const reviewDays = clampNextReviewDays(moves.next_review_in_days, { allowDaily: meta.behind_required_near === true });
      const note = planNote({
        meta,
        moves,
        saw: context.saw,
        changedLines,
        wouldLines: [...gc.wouldLines, ...pp.wouldLines],
        needLines,
        refused,
        now,
        reviewDays,
        items: noteItems,
        headline: validHeadline(moves.note?.headline) ?? deriveHeadline(noteItems),
      });
      notes.unshift({ id: `${run_id}-note`, ...note, created_at: now.toISOString() });
      applied.note = {
        saw: note.saw,
        changed: note.changed,
        need: note.need,
        would: note.would_change,
        sent: isNoteVisible(note),
        items: note.items ?? [],
        headline: note.headline,
        sections: note.items
          ? noteSections(note.items, { wouldChange: note.would_change, link: () => null, moreUrl: "" }).map((sec) => ({
              ...sec,
              rows: sec.rows.map(({ item: _i, ...r }) => r),
            }))
          : [],
      };
      applied.nextReviewInDays = Math.round((Date.parse(note.next_review_at) - now.getTime()) / DAY);
      return { decision: decisionOf(moves), applied, tokens, raw: text };
    },
  };
}
