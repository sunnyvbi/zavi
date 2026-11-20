
import { readAutopilotState, resolveChannelAutorun, type AutopilotState } from "./channel-autorun";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { endedReason, goalRev, isCheckInNote, paceNumberUsable, utcDay, type GoalRow } from "./goal-owner";
import { normalizeTopic } from "./cgo-questions";
import { paceLines, readingDay, type PaceLine } from "./goal-trajectory";
import { cardSubjectRefs, mergeRefs, storedRefs } from "./open-advice";
import { execVerdictOf, type ExecBucket } from "@/services/channels/exec-failure";
import { moneyAtStakeUsd } from "@/services/channels/money-at-stake";
import { MONEY_AT_STAKE_KEY } from "@/services/channels/money-at-stake-card";
import { planLockedChannels, type PlanDeps } from "./preview-plan";
import { RETIRED_CHANNEL_SLUGS } from "@zavi/shared";

const DAY = 86_400_000;
export const UNTOUCHED_DAYS = 5;
export const SILENT_DAYS = 7;
export const SEEN_NOT_ACTED_MIN = 3;
export const OFF_PACE_SHARE = 0.25;
const RECENT_DAYS = 14;
const ALARM_MEMORY_DAYS = 30;
export const NEXT_REVIEW_MIN_DAYS = 2;
export const NEXT_REVIEW_MAX_DAYS = 14;
export const NEXT_REVIEW_DEFAULT_DAYS = 7;

export type AlarmReason = "review_due" | "cards_untouched" | "seen_not_acted" | "founder_silent" | "goal_off_pace" | "goal_over";
export type NoteKind = "scheduled" | "alarm" | "founder";

export type WatchGoal = GoalRow & { created_at: string | null };
export type CardActor = "founder" | "cgo" | "system" | "channel" | "unknown";

export function channelActionActor(a: { approved_by?: string | null; approved_by_source?: string | null }, eventActorKind: string | null | undefined): CardActor {
  if (a.approved_by_source === "cgo") return "cgo";
  if (eventActorKind === "founder") return "founder";
  if (eventActorKind === "system") return "system";
  if (eventActorKind === "channel_run") return "channel";
  if (a.approved_by && (!a.approved_by_source || a.approved_by_source === "email")) return "founder";
  return "unknown";
}

export type WatchAction = {
  id: string;
  channel_slug: string;
  status: string;
  proposed_at: string;
  by?: CardActor;
  title?: string | null;
  action_type?: string | null;
  exec_class?: string | null;
  exec_payload?: unknown;
  step_body?: string | null;
  subject_refs?: unknown;
  exec_status?: string | null;
  exec_result?: unknown;
  stake?: unknown;
  exec_bucket?: string | null;
  exec_code?: string | null;
};
export type WatchChannel = {
  channel_slug: string;
  plan_selected: boolean | null;
  plan_selected_set_by: string | null;
  autorun: boolean | null;
  autorun_set_by?: string | null;
  autorun_set_at?: string | null;
  chatgpt_autopilot_consent_at?: string | null;
  last_run_at: string | null;
  founder_seen_at: string | null;
  cgo_reason: string | null;
  cgo_set_at: string | null;
};
export type WatchNote = {
  id: string;
  kind: NoteKind;
  saw: string[];
  changed: string[];
  would_change: string[];
  need: string[];
  refused?: string[];
  alarm_keys: string[];
  next_review_at: string;
  created_at: string;
  headline?: string | null;
};
export type WatchState = {
  goals: WatchGoal[];
  pending: WatchAction[];
  recent: WatchAction[];
  channels: WatchChannel[];
  notes: WatchNote[];
  founder_last_active_at: string | null;
  last_check_run_at: string | null;
  approvals_14d: number;
  rejections_14d: number;
  metrics: Array<{ channel_slug: string; metric_key: string; value: number; unit: string | null; day: string }>;
  open_topics?: string[];
  founder_rejected_channels?: string[];
  autopilot?: AutopilotState | null;
};

export const NEXT_REVIEW_DAILY_MIN_DAYS = 1;

export function clampNextReviewDays(n: unknown, opts: { allowDaily?: boolean } = {}): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : NEXT_REVIEW_DEFAULT_DAYS;
  const min = opts.allowDaily ? NEXT_REVIEW_DAILY_MIN_DAYS : NEXT_REVIEW_MIN_DAYS;
  return Math.min(NEXT_REVIEW_MAX_DAYS, Math.max(min, v));
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

function maxIso(...xs: Array<string | null | undefined>): string | null {
  let best: number | null = null;
  for (const x of xs) {
    const t = ms(x);
    if (t != null && (best == null || t > best)) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}

export function isOffPace(g: WatchGoal, now: Date): boolean {
  if (g.current_value == null || g.target_value == null) return false;
  const today = utcDay(now);
  if (!paceNumberUsable(g, today)) return false;
  const day = readingDay(g, today);
  const at = day < today ? new Date(ms(`${day}T23:59:59Z`) ?? now.getTime()) : now;
  const lines = paceLines(g, today);
  return lines.length > 0 && lines.every((l) => offPaceOnLine(l, Number(g.current_value), at));
}

function offPaceOnLine(l: PaceLine, current: number, now: Date): boolean {
  const start = ms(`${l.start_day}T00:00:00Z`);
  const due = ms(`${l.due_day}T23:59:59Z`);
  if (start == null || due == null || due <= start) return false;
  const elapsed = (now.getTime() - start) / (due - start);
  if (elapsed < 0.25 || elapsed > 1) return false;
  const span = l.target - l.start_value;
  if (span === 0) return false;
  const progress = (current - l.start_value) / span;
  return progress < elapsed * (1 - OFF_PACE_SHARE);
}

function basisKey(g: WatchGoal): string {
  return g.value_kind ? `:${g.value_kind}:${g.value_period_start ?? ""}` : "";
}

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const w = Math.ceil(((t.getTime() - yearStart) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(w).padStart(2, "0")}`;
}

export type AlarmResult = {
  wake: boolean;
  kind: NoteKind;
  reasons: AlarmReason[];
  keys: string[];
};

export function computeAlarms(state: WatchState, now: Date, opts: { autopilot: boolean } = { autopilot: true }): AlarmResult {
  const t = now.getTime();
  const today = utcDay(now);
  const lastNote = state.notes.find((n) => isCheckInNote(n.alarm_keys)) ?? null;
  const recentNotes = state.notes.filter((n) => (ms(n.created_at) ?? 0) >= t - ALARM_MEMORY_DAYS * DAY);
  const already = new Set(recentNotes.flatMap((n) => n.alarm_keys));
  const byReason = new Map<AlarmReason, string[]>();
  const add = (r: AlarmReason, k: string) => byReason.set(r, [...(byReason.get(r) ?? []), k]);

  const pausedByCgo = new Set(state.channels.filter((c) => !c.plan_selected && c.cgo_reason).map((c) => c.channel_slug));
  const pending = state.pending.filter((a) => !pausedByCgo.has(a.channel_slug));

  const week = isoWeek(now);
  const untouched = new Set<string>();
  for (const a of pending) {
    const p = ms(a.proposed_at);
    if (p != null && p <= t - UNTOUCHED_DAYS * DAY) untouched.add(a.channel_slug);
  }
  const asking = new Set(state.open_topics ?? []);
  const askingAbout = (slug: string) => asking.has(normalizeTopic(`channel:${slug}`));
  for (const slug of untouched) if (!askingAbout(slug)) add("cards_untouched", `untouched:${slug}:${week}`);

  const seen = new Map(state.channels.map((c) => [c.channel_slug, ms(c.founder_seen_at)]));
  const seenIdle = pending.filter((a) => {
    const s = seen.get(a.channel_slug);
    const p = ms(a.proposed_at);
    return s != null && p != null && s > p;
  });
  if (seenIdle.length >= SEEN_NOT_ACTED_MIN) {
    for (const slug of new Set(seenIdle.map((a) => a.channel_slug))) if (!askingAbout(slug)) add("seen_not_acted", `seen:${slug}:${week}`);
  }

  const firstGoal = state.goals.map((g) => g.created_at).filter(Boolean).sort()[0] ?? null;
  const since = state.founder_last_active_at ?? firstGoal;
  const sinceMs = ms(since);
  if (sinceMs != null && sinceMs <= t - SILENT_DAYS * DAY) add("founder_silent", `silent:${since}`);

  for (const g of state.goals) {
    const over = endedReason(g, today);
    if (over) add("goal_over", `over:${g.id}:${over}`);
    else if (isOffPace(g, now) && !asking.has(normalizeTopic(`goal:${g.id}`))) add("goal_off_pace", `offpace:${g.id}:${goalRev(g)}${basisKey(g)}`);
  }

  const keys = [...byReason.values()].flat();
  const lastCheck = ms(state.last_check_run_at);
  if (lastCheck != null && lastCheck > (ms(lastNote?.created_at) ?? 0) && lastCheck > t - 7 * DAY) {
    return { wake: false, kind: "alarm", reasons: [], keys };
  }
  const due = !lastNote || (ms(lastNote.next_review_at) ?? 0) <= t;
  const reasons: AlarmReason[] = [];
  if (due) reasons.push("review_due");
  if (opts.autopilot) for (const [r, ks] of byReason) if (ks.some((k) => !already.has(k))) reasons.push(r);
  return { wake: reasons.length > 0, kind: due ? "scheduled" : "alarm", reasons, keys };
}

const NOT_CGO_APPROVAL = "approved_by_source.is.null,approved_by_source.neq.cgo";

export async function withoutPlanLockedCards<P extends { channel_slug: string }, R extends { channel_slug: string; status: string }>(
  tenant_id: string,
  pending: P[],
  recent: R[],
  deps: PlanDeps = {},
): Promise<{ pending: P[]; recent: R[] }> {
  const waiting = (r: R) => r.status === "pending";
  const slugs = [...pending.map((a) => a.channel_slug), ...recent.filter(waiting).map((a) => a.channel_slug)];
  if (slugs.length === 0) return { pending, recent };
  const locked = await planLockedChannels(tenant_id, slugs, deps);
  if (locked.size === 0) return { pending, recent };
  return {
    pending: pending.filter((a) => !locked.has(a.channel_slug)),
    recent: recent.filter((a) => !(waiting(a) && locked.has(a.channel_slug))),
  };
}

export async function readWatchState(tenant_id: string, now: Date = new Date()): Promise<WatchState> {
  const db = tenantClient(asTenantId(tenant_id));
  const since = new Date(now.getTime() - RECENT_DAYS * DAY).toISOString();
  const noteSince = new Date(now.getTime() - ALARM_MEMORY_DAYS * DAY).toISOString();

  const autopilotRead = readAutopilotState(tenant_id).catch((e: Error) => {
    console.warn(`[cgo-watch] autopilot state unreadable for ${tenant_id}: ${e.message}`);
    return null;
  });
  const [goals, pending, recent, channels, notes, founderEv, approved, rejected, approvals, rejections, metrics, lastCheck, openQs, founderRej, closeEv] = await Promise.all([
    db
      .from("autopilot_goals")
      .select("id, objective, target_metric, target_value, baseline_value, current_value, current_value_at, count_rule, due_date, status, priority, measurement_mode, created_at, value_kind, value_period_start")
      .eq("tenant_id", tenant_id)
      .eq("status", "active"),
    db
      .from("channel_actions")
      .select("id, channel_slug, status, proposed_at, title, action_type, exec_class, exec_payload, step_body:body->step->>body, subject_refs:body->subject_refs, exec_status, exec_result, stake:body->money_at_stake")
      .eq("tenant_id", tenant_id)
      .eq("status", "pending")
      .order("proposed_at", { ascending: true })
      .limit(500),
    db
      .from("channel_actions")
      .select("id, channel_slug, status, proposed_at, approved_by, approved_by_source, title, exec_status, exec_bucket:exec_result->>bucket, exec_code:exec_result->>platform_code")
      .eq("tenant_id", tenant_id)
      .gte("proposed_at", since)
      .limit(1000),
    db
      .from("tenant_channels")
      .select("channel_slug, plan_selected, plan_selected_set_by, autorun, autorun_set_by, autorun_set_at, chatgpt_autopilot_consent_at, last_run_at, founder_seen_at, cgo_reason, cgo_set_at")
      .eq("tenant_id", tenant_id),
    db
      .from("cgo_notes")
      .select("id, kind, saw, changed, would_change, need, refused, alarm_keys, next_review_at, created_at, headline")
      .eq("tenant_id", tenant_id)
      .gte("created_at", noteSince)
      .order("created_at", { ascending: false })
      .limit(500),
    db
      .from("channel_action_events")
      .select("at")
      .eq("tenant_id", tenant_id)
      .eq("actor_kind", "founder")
      .order("at", { ascending: false })
      .limit(1),
    db
      .from("decisions")
      .select("approved_at")
      .eq("tenant_id", tenant_id)
      .not("approved_by", "is", null)
      .or(NOT_CGO_APPROVAL)
      .order("approved_at", { ascending: false })
      .limit(1),
    db
      .from("decisions")
      .select("rejected_at")
      .eq("tenant_id", tenant_id)
      .not("rejected_by", "is", null)
      .order("rejected_at", { ascending: false })
      .limit(1),
    db
      .from("decisions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant_id)
      .eq("status", "approved")
      .not("approved_by", "is", null)
      .or(NOT_CGO_APPROVAL)
      .gte("approved_at", since),
    db
      .from("decisions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant_id)
      .not("rejected_by", "is", null)
      .gte("rejected_at", since),
    db
      .from("channel_metrics")
      .select("channel_slug, metric_key, value, unit, day")
      .eq("tenant_id", tenant_id)
      .gte("day", since.slice(0, 10))
      .order("day", { ascending: false })
      .limit(300),
    db
      .from("agent_runs")
      .select("enqueued_at")
      .eq("tenant_id", tenant_id)
      .eq("agent_slug", "cgo")
      .eq("payload->>reason", "daily_check")
      .neq("status", "dispatch_error")
      .order("enqueued_at", { ascending: false })
      .limit(1),
    db.from("cgo_questions").select("topic_key").eq("tenant_id", tenant_id).in("status", ["open", "queued"]).limit(100),
    db
      .from("channel_action_events")
      .select("action_id")
      .eq("tenant_id", tenant_id)
      .eq("actor_kind", "founder")
      .eq("event", "rejected")
      .gte("at", since)
      .limit(500),
    db
      .from("channel_action_events")
      .select("action_id, actor_kind, at")
      .eq("tenant_id", tenant_id)
      .in("event", ["acted", "rejected"])
      .gte("at", since)
      .order("at", { ascending: false })
      .limit(1000),
  ]);

  for (const [name, r] of Object.entries({ goals, pending, recent, channels, notes, founderEv, approved, rejected, approvals, rejections, metrics, lastCheck, openQs, founderRej, closeEv })) {
    const err = (r as { error: { message: string } | null }).error;
    if (err) throw new Error(`cgo-watch: ${name} read failed: ${err.message}`);
  }

  const chans = (channels.data ?? []) as WatchChannel[];
  const firstRow = <T,>(r: { data: unknown }) => ((r.data ?? []) as T[])[0];
  const founder_last_active_at = maxIso(
    ...chans.map((c) => c.founder_seen_at),
    firstRow<{ at: string }>(founderEv)?.at,
    firstRow<{ approved_at: string }>(approved)?.approved_at,
    firstRow<{ rejected_at: string }>(rejected)?.rejected_at,
  );

  const closeEvents = (closeEv.data ?? []) as Array<{ action_id: string; actor_kind: string }>;
  const closerOf = new Map<string, string>();
  for (const e of closeEvents) if (!closerOf.has(e.action_id)) closerOf.set(e.action_id, e.actor_kind);
  const recentRows = ((recent.data ?? []) as Array<WatchAction & { approved_by?: string | null; approved_by_source?: string | null }>).map(
    ({ approved_by, approved_by_source, ...a }) =>
      a.status === "acted" || a.status === "rejected" ? { ...a, by: channelActionActor({ approved_by, approved_by_source }, closerOf.get(a.id)) } : a,
  );

  const open = await withoutPlanLockedCards(tenant_id, (pending.data ?? []) as WatchAction[], recentRows);

  return {
    goals: (goals.data ?? []) as WatchGoal[],
    pending: open.pending,
    recent: open.recent,
    channels: chans,
    notes: ((notes.data ?? []) as WatchNote[]).map((n) => ({
      ...n,
      saw: n.saw ?? [],
      changed: n.changed ?? [],
      would_change: n.would_change ?? [],
      need: n.need ?? [],
      refused: n.refused ?? [],
      alarm_keys: n.alarm_keys ?? [],
    })),
    founder_last_active_at,
    last_check_run_at: firstRow<{ enqueued_at: string }>(lastCheck)?.enqueued_at ?? null,
    approvals_14d: approvals.count ?? 0,
    rejections_14d: rejections.count ?? 0,
    metrics: (metrics.data ?? []) as WatchState["metrics"],
    open_topics: ((openQs.data ?? []) as Array<{ topic_key: string }>).map((q) => q.topic_key),
    autopilot: await autopilotRead,
    founder_rejected_channels: (() => {
      const slugOf = new Map(((recent.data ?? []) as WatchAction[]).map((a) => [a.id, a.channel_slug]));
      const out = new Set<string>();
      for (const e of (founderRej.data ?? []) as Array<{ action_id: string }>) {
        const slug = slugOf.get(e.action_id);
        if (slug) out.add(slug);
      }
      return [...out];
    })(),
  };
}

export async function readLastCheckInNote(
  tenant_id: string,
): Promise<(Pick<WatchNote, "changed" | "would_change" | "need"> & { items: unknown[] | null }) | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("cgo_notes")
    .select("changed, would_change, need, items, alarm_keys")
    .eq("tenant_id", tenant_id)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw new Error(`cgo-watch: last note read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ changed: string[] | null; would_change: string[] | null; need: string[] | null; items?: unknown; alarm_keys: string[] | null }>;
  const n = rows.find((r) => isCheckInNote(r.alarm_keys));
  return n ? { changed: n.changed ?? [], would_change: n.would_change ?? [], need: n.need ?? [], items: Array.isArray(n.items) ? n.items : null } : null;
}

export type ChannelView = {
  channel_slug: string;
  in_plan: boolean;
  added_by: string | null;
  cgo_may_run: boolean;
  autorun_by_founder: boolean;
  paused_by_you: string | null;
  last_run_at: string | null;
  last_14_days: { proposed: number; acted: number; rejected: number; snoozed: number; still_waiting: number };
  closed_by?: Partial<Record<CardActor, number>>;
  oldest_waiting_days: number | null;
  opened_but_not_acted: number;
  founder_last_opened: string | null;
  latest_metrics: Array<{ metric: string; value: number; unit: string | null; day: string }>;
  blocked_on_you: boolean;
  founder_rejected: boolean;
  open_cards?: OpenCardView[];
  blocked_on_us?: Array<{ action_id: string; title: string; code: string | null }>;
};

export const OPEN_CARDS_PER_CHANNEL = 5;
export const BLOCKED_CARDS_PER_CHANNEL = 5;
const OPEN_CARD_STEP_CHARS = 160;

export type OpenCardView = {
  action_id: string;
  title: string;
  action_type: string | null;
  executable: boolean;
  about: string[];
  step: string;
  waiting_days: number | null;
  exec: { status: string; bucket: ExecBucket | null; code: string | null } | null;
  money_at_stake_usd: number | null;
};

export function openCardView(a: WatchAction, t: number): OpenCardView {
  const refs = mergeRefs(storedRefs(a.subject_refs), cardSubjectRefs({ title: a.title, stepBody: a.step_body, execPayload: a.exec_payload }));
  const step = (a.step_body ?? "").replace(/\s+/g, " ").trim();
  const p = ms(a.proposed_at);
  return {
    action_id: a.id,
    title: (a.title ?? "").slice(0, 200),
    action_type: a.action_type ?? null,
    executable: typeof a.exec_class === "string" && a.exec_class.length > 0,
    about: [...refs.names.map((n) => `"${n}"`), ...refs.ids].slice(0, 6),
    step: step.length > OPEN_CARD_STEP_CHARS ? `${step.slice(0, OPEN_CARD_STEP_CHARS - 1)}…` : step,
    waiting_days: p == null ? null : Math.floor((t - p) / DAY),
    exec: execView(a.exec_status, a.exec_result),
    money_at_stake_usd: moneyOf(a),
  };
}

function execView(status: unknown, result: unknown): OpenCardView["exec"] {
  if (typeof status !== "string" || status.length === 0) return null;
  const v = execVerdictOf(status, result);
  const r = (result && typeof result === "object" && !Array.isArray(result) ? result : {}) as Record<string, unknown>;
  const code = v?.platform_code ?? (typeof r.code === "string" ? r.code : null);
  return { status, bucket: v?.bucket ?? null, code: code ? code.slice(0, 120) : null };
}

function moneyOf(a: WatchAction): number | null {
  const m = moneyAtStakeUsd(a.exec_class, a.exec_payload, { [MONEY_AT_STAKE_KEY]: a.stake });
  return m ? Math.round(m.monthly_usd) : null;
}

export type FounderView = {
  last_active_at: string | null;
  days_since_active: number | null;
  approved_14d: number;
  rejected_14d: number;
};

function cgoMayRun(state: WatchState, slug: string, c: WatchChannel | undefined): boolean {
  if (state.autopilot === undefined) return !!c?.autorun;
  if (state.autopilot === null) return false;
  return resolveChannelAutorun(state.autopilot, slug, c ?? null).effective;
}

export function channelViews(state: WatchState, now: Date): ChannelView[] {
  const t = now.getTime();
  const live = state.channels.filter((c) => !RETIRED_CHANNEL_SLUGS.has(c.channel_slug));
  const slugs = new Set<string>([
    ...live.filter((c) => c.plan_selected || c.cgo_reason).map((c) => c.channel_slug),
    ...state.pending.map((a) => a.channel_slug),
    ...state.recent.map((a) => a.channel_slug),
  ]);
  const chan = new Map(live.map((c) => [c.channel_slug, c]));
  const asking = new Set(state.open_topics ?? []);
  return [...slugs].sort().map((slug) => {
    const c = chan.get(slug);
    const recent = state.recent.filter((a) => a.channel_slug === slug);
    const waiting = state.pending.filter((a) => a.channel_slug === slug);
    const oldest = waiting.map((a) => ms(a.proposed_at)).filter((x): x is number => x != null).sort((a, b) => a - b)[0];
    const seenAt = ms(c?.founder_seen_at);
    const perKey = new Map<string, ChannelView["latest_metrics"][number]>();
    for (const m of state.metrics) {
      if (m.channel_slug !== slug || perKey.has(m.metric_key) || perKey.size >= 5) continue;
      perKey.set(m.metric_key, { metric: m.metric_key, value: Number(m.value), unit: m.unit, day: m.day });
    }
    return {
      channel_slug: slug,
      in_plan: !!c?.plan_selected,
      added_by: c?.plan_selected_set_by ?? null,
      cgo_may_run: !RETIRED_CHANNEL_SLUGS.has(slug) && cgoMayRun(state, slug, c),
      autorun_by_founder: c?.autorun_set_by === "founder",
      paused_by_you: c && !c.plan_selected ? c.cgo_reason ?? null : null,
      last_run_at: c?.last_run_at ?? null,
      last_14_days: {
        proposed: recent.length,
        acted: recent.filter((a) => a.status === "acted").length,
        rejected: recent.filter((a) => a.status === "rejected").length,
        snoozed: recent.filter((a) => a.status === "snoozed").length,
        still_waiting: waiting.length,
      },
      ...closedBy(recent),
      oldest_waiting_days: oldest == null ? null : Math.floor((t - oldest) / DAY),
      opened_but_not_acted: seenAt == null ? 0 : waiting.filter((a) => (ms(a.proposed_at) ?? Infinity) < seenAt).length,
      founder_last_opened: c?.founder_seen_at ?? null,
      latest_metrics: [...perKey.values()],
      blocked_on_you: asking.has(normalizeTopic(`channel:${slug}`)),
      founder_rejected: (state.founder_rejected_channels ?? []).includes(slug),
      open_cards: waiting.slice(0, OPEN_CARDS_PER_CHANNEL).map((a) => openCardView(a, t)),
      ...blockedCards(recent),
    };
  });
}

function blockedCards(recent: readonly WatchAction[]): Pick<ChannelView, "blocked_on_us"> {
  const blocked = recent
    .filter((a) => a.exec_status === "failed" && a.exec_bucket === "blocked_on_us")
    .sort((a, b) => (ms(b.proposed_at) ?? 0) - (ms(a.proposed_at) ?? 0))
    .slice(0, BLOCKED_CARDS_PER_CHANNEL)
    .map((a) => ({ action_id: a.id, title: (a.title ?? "").slice(0, 200), code: a.exec_code ? a.exec_code.slice(0, 120) : null }));
  return blocked.length ? { blocked_on_us: blocked } : {};
}

function closedBy(recent: readonly WatchAction[]): { closed_by?: Partial<Record<CardActor, number>> } {
  const out: Partial<Record<CardActor, number>> = {};
  for (const a of recent) {
    if (a.status !== "acted" && a.status !== "rejected") continue;
    const by = a.by ?? "unknown";
    out[by] = (out[by] ?? 0) + 1;
  }
  return Object.keys(out).length ? { closed_by: out } : {};
}

export function founderView(state: WatchState, now: Date): FounderView {
  const last = ms(state.founder_last_active_at);
  return {
    last_active_at: state.founder_last_active_at,
    days_since_active: last == null ? null : Math.floor((now.getTime() - last) / DAY),
    approved_14d: state.approvals_14d,
    rejected_14d: state.rejections_14d,
  };
}
