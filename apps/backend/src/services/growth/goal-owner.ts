
import { firstGoalReviewKey, firstGoalReviewRetryKey } from "./goal-review-identity";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CHANNELS, RETIRED_CHANNEL_SLUGS, adCardTitle } from "@zavi/shared";
import { classifyMetricMode } from "@/services/autopilot/goal-metric-vocab";
import { classifyTargetMetric } from "@/services/autopilot/goal-metric-resolver";
import { canMeasureAutomatically } from "@/services/autopilot/goal-measurement-mode";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import {
  hasWorkUnderwayClaim,
  isWorkUnderwaySentence,
  removeClaimSentences,
} from "@/services/agents/side-effect-claim-reconciler";
import { writeAutopilotGoal } from "./goal-write";
import { recordWakeSkip } from "./cgo-wake-skips";
import { isInsufficientCreditsError } from "@/services/agents/credits";
import type { AlarmReason, ChannelView, FounderView, NoteKind, WatchNote } from "./cgo-watch";
import type { MetricAnomalyWake } from "@/services/analytics/anomaly";
import type { PaidTier } from "@/services/billing/tiers";
import { CGO_AD_CHANNELS, cgoAdBudget } from "./cgo-ads";
import { asksFounderForNumber, type DefaultAction, type GoalChangeFields, type OnYes, type QuestionAsk, type QuestionRow } from "./cgo-questions";
import { budgetMargin, type ActiveAdBudget } from "@/services/decisions/ad-budget";
import { deliveryDebtHigh, loadLiveForecast, loadSpendPace, type SpendPace } from "./spend-pace";
import { readOpenCards, refsFromText, refsOfRow, textNamesCard, type SubjectRefs } from "./open-advice";
import { evaluateUnattended, TYPED_NUMBER_EXPIRES_DAYS } from "./unattended-policy";
import { RESEARCH_SCOPE_REASON, withoutTenantRecordResearch } from "./research-scope";
import { confirmedRule, proposedCountRuleSchema } from "./goal-count-rule";
import { goalKind, goalMet, goalMoneyMetric, goalTrajectory, rolledPeriodStart, type Trajectory } from "./goal-trajectory";
export { goalMoneyMetric };
import { isValidTimeZone, localDateOf } from "@/services/analytics/metric-time";
import { applyReadouts, clampTest, markFindingsDelivered, parseMoveTest, readDueTests, readUndeliveredFindings, type DueTest, type SavedFinding } from "./cgo-tests";
import { REJECTED_ORDER_DAYS, cgoReplyOf, repeatsRejected, type CgoReplyStatus, type RejectedOrder } from "./cgo-brief";
import { AD_EVIDENCE_CHAR_BUDGET, CUT_HOLD_WORDS, EVIDENCE_CHAR_BUDGET, PAID_CHANNELS, budgetEvidence, cutHeldByEvidence, type CgoEvidence } from "./cgo-evidence";
import { TYPED_MEASURED_BY, gateMovesOnLedger } from "./number-gate";
import {
  BLOCKER_NOTE_KEY,
  blockedReason,
  buildNoteItems,
  channelCardNoteItem,
  cleanReason,
  cleanTitle,
  itemText,
  noteHeadline,
  noteItemsVisible,
  parseNoteItems,
  validHeadline,
  type CardBucket,
  type CardOutcome,
  type NoteItem,
} from "./cgo-note-items";
import { execVerdictOf, fixWords } from "@/services/channels/exec-failure";
import { execPlatformLabel } from "@/services/channels/exec-kill-switch";
import { moneyAtStakeUsd } from "@/services/channels/money-at-stake";
import { founderEstimateFor } from "./founder-estimate";

export const OWN_GOALS_STAGE = "own_goals";
export const CGO_CARD_CLASS = "cgo.dispatch-specialist";
export const GOAL_OWNER_DAILY_CAP = 3;
export const GOAL_OWNER_DAILY_CAP_AD_BUDGET = 12;
export const AD_BUDGET_REVIEW_NOTE_KEY = "ad_budget_review";
export { BLOCKER_NOTE_KEY };

const NOT_CHECK_IN_NOTE_KEYS = [AD_BUDGET_REVIEW_NOTE_KEY, BLOCKER_NOTE_KEY];

export function isCheckInNote(alarmKeys: readonly string[] | null | undefined): boolean {
  return !(alarmKeys ?? []).some((k) => NOT_CHECK_IN_NOTE_KEYS.includes(k));
}

export function isBlockerNote(alarmKeys: readonly string[] | null | undefined): boolean {
  return (alarmKeys ?? []).includes(BLOCKER_NOTE_KEY);
}

export function alertsSinceLastNote(notes: ReadonlyArray<Pick<WatchNote, "alarm_keys" | "created_at" | "headline">>): Array<{ at: string; what: string }> {
  const out: Array<{ at: string; what: string }> = [];
  for (const n of notes) {
    if (!isBlockerNote(n.alarm_keys)) break;
    if (n.headline) out.push({ at: n.created_at, what: n.headline });
    if (out.length >= 10) break;
  }
  return out;
}
export const REPEAT_MOVE_DAYS = 7;
export function repeatKey(goalId: string, agent: string, problem: unknown): string {
  const p = typeof problem === "string" && problem.trim() ? problem.trim().toLowerCase() : "unspecified";
  return `${goalId}:${agent}:${p}`;
}
export function adIntentKey(intent: unknown): string {
  const text = typeof intent === "string" ? intent : "";
  const ids = [...new Set(text.match(/\b\d{6,}\b/g) ?? [])].sort();
  if (ids.length) return `ids:${ids.join(",")}`;
  return `t:${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80)}`;
}
export function adOrderKey(goalId: string, target: string, intent: unknown): string {
  return `${goalId}:${target}:${adIntentKey(intent)}`;
}
export function adRepeatKey(goalId: string, target: string, problem: unknown, intent: unknown): string {
  return `${repeatKey(goalId, target, problem)}:${adIntentKey(intent)}`;
}
export const MAX_NEW_CARDS_PER_RUN = 6;
export const MAX_MOVES_PER_GOAL = 2;
export const MAX_MOVES_PER_GOAL_BEHIND = 4;
export const CGO_TARGETS: ReadonlySet<string> = new Set<string>([
  "engineer",
  "pm",
  "research",
  "content-design",
]);
export const CGO_AD_TARGETS: ReadonlySet<string> = CGO_AD_CHANNELS;
export const CGO_AUTO_RUN_TARGETS: ReadonlySet<string> = new Set<string>(["research", "content-design"]);
export const CGO_ORGANIC_TARGETS: ReadonlySet<string> = new Set<string>(
  CHANNELS.filter(
    (c) => (c.category === "organic" || c.category === "owned") && !PAID_CHANNELS.has(c.slug) && !RETIRED_CHANNEL_SLUGS.has(c.slug),
  ).map((c) => c.slug),
);

export function autoRunLine(target: string, intent: string): string {
  const short = intent.trim().replace(/\s+/g, " ");
  const name = CHANNELS.find((c) => c.slug === target)?.name ?? target;
  return `Started ${name}: ${cutAtSentence(short, 240)}`;
}
const RECENT_DAYS = 14;
const TERMINAL_RUN_STATUSES = ["success", "parse_failed", "dispatch_error", "error", "failed", "cancelled"];

export type GoalRow = {
  id: string;
  objective: string;
  target_metric: string;
  target_value: number | null;
  current_value: number | null;
  current_value_at?: string | null;
  current_value_source?: string | null;
  due_date: string | null;
  status: string;
  priority: number | null;
  measurement_mode: string | null;
  measure_source?: string | null;
  baseline_value?: number | null;
  created_at?: string | null;
  count_rule?: unknown;
  value_kind?: string | null;
  value_period_start?: string | null;
};

export type WakeReason = "goal_set" | "card_rejected" | "plan_goal_created" | "daily_check" | "ad_budget_review" | "founder_reply" | "metric_anomaly" | "reddit_ads_change";

export type FounderReply = { via: "email" | "slack" | "web" | "chat"; text: string; reply_run_id: string; cgo_reading?: string };

export function goalRev(g: Pick<GoalRow, "objective" | "target_metric" | "target_value" | "due_date">): string {
  return createHash("sha256")
    .update(`${g.objective.trim()}|${g.target_metric.trim()}|${g.target_value ?? ""}|${g.due_date ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

export const NUMBER_STALE_AFTER_DAYS = 2;

export function numberAgeDays(g: Pick<GoalRow, "current_value_at">, today: string): number | null {
  if (!g.current_value_at) return null;
  const at = Date.parse(`${g.current_value_at.slice(0, 10)}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.round((now - at) / 86_400_000));
}
export function numberTrusted(
  g: Pick<GoalRow, "current_value" | "current_value_at" | "measurement_mode"> & { count_rule?: unknown },
  today: string,
): boolean {
  if (g.current_value == null) return false;
  const age = numberAgeDays(g, today);
  if (age == null) return false;
  const rule = confirmedRule(g.count_rule);
  if (rule?.stale_reason) return false;
  if (g.measurement_mode === "auto" || rule) return age <= NUMBER_STALE_AFTER_DAYS;
  return age <= TYPED_NUMBER_EXPIRES_DAYS;
}

function staleWords(g: Pick<GoalRow, "current_value_at" | "measurement_mode"> & { count_rule?: unknown }, today: string): string {
  const age = numberAgeDays(g, today);
  const typed = g.measurement_mode !== "auto" && !confirmedRule(g.count_rule);
  if (age == null) return typed ? ", entered on an unknown date" : ", not measured recently";
  return `, ${typed ? "entered" : "last measured"} ${age} day${age === 1 ? "" : "s"} ago`;
}

export function endedReason(g: GoalRow, today: string): "met" | "due_passed" | null {
  if (g.current_value != null && g.target_value != null && numberTrusted(g, today)) {
    if (goalMet(g)) return "met";
  }
  if (g.due_date && g.due_date < today) return "due_passed";
  return null;
}

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function dayInZone(now: Date, tz: string | null | undefined): string {
  return tz && isValidTimeZone(tz) ? localDateOf(now, tz) : utcDay(now);
}

export async function goalTimeZone(tenant_id: string): Promise<string> {
  try {
    const { data } = (await tenantClient(asTenantId(tenant_id))
      .from("tenants")
      .select("reporting_timezone, timezone")
      .eq("id", tenant_id)
      .maybeSingle()) as { data: { reporting_timezone?: string | null; timezone?: string | null } | null };
    for (const tz of [data?.reporting_timezone, data?.timezone]) if (isValidTimeZone(tz)) return tz;
  } catch {
  }
  return "UTC";
}

export async function goalToday(tenant_id: string, now: Date = new Date()): Promise<string> {
  return dayInZone(now, await goalTimeZone(tenant_id));
}

export type GoalOwnerContext = {
  today: string;
  goals: Array<{
    goal_id: string;
    goal_rev: string;
    objective: string;
    target_metric: string;
    target_value: number | null;
    current_value: number | null;
    due_date: string | null;
    measured_by: string;
    behind_pace?: boolean;
    counts_as?: "gauge" | "period_total" | "ambiguous";
    projected_at_due?: number | null;
    days_left?: number | null;
    remaining?: number | null;
    required_per_day?: number | null;
    behind_required?: boolean;
    hypotheses?: import("./cgo-hypotheses").HypothesisView[];
  }>;
  ended_goals: Array<{ goal_id: string; objective: string; reason: "met" | "due_passed" }>;
  channels: ChannelView[];
  founder: FounderView;
  wake: {
    kind: NoteKind;
    reason: WakeReason;
    reddit?: { incident_id: string; issues: string[] };
    check_reasons: AlarmReason[];
    autopilot: boolean;
    anomaly?: MetricAnomalyWake;
  };
  last_note: { saw: string[]; changed: string[]; would_change: string[]; need: string[]; refused: string[]; created_at: string } | null;
  alerts_since_last_note?: Array<{ at: string; what: string }>;
  saw: string[];
  open_questions: Array<{ question_id: string; topic: string; ask: string; asked_on: string; expires_on: string | null; default_line: string | null }>;
  queued_questions?: Array<{ topic: string; ask: string }>;
  founder_reply?: { via: "email" | "slack" | "web" | "chat"; text: string; cgo_reading?: string };
  founder_orders?: import("./founder-orders-view").FounderOrdersView;
  answered_questions?: Array<{ question_id: string; ask: string; answer: string; via: string | null }>;
  allowed_agents: string[];
  plan_locked?: PlanLocked[];
  ad_budget?: {
    monthly_usd: number;
    this_month_cap_usd: number;
    spent_this_month_usd: number;
    held_rest_of_month_usd: number;
    left_usd: number;
    daily_limit_usd: number | null;
    days_left_in_month: number;
    next_month_starts: string;
    spare_daily_capacity_usd: number | null;
    in_words: string;
  };
  spend_pace?: {
    daily_target_usd: number;
    actual_today_usd: number | null;
    actual_month_usd: number;
    required_so_far_usd: number;
    delivery_debt_usd: number;
    live_ads_per_day_usd: number | null;
    days_left: number;
    behind: boolean;
    data_fresh: boolean;
  };
  open_cards: Array<{ goal_id: string; target_agent_slug: string; intent: string }>;
  decided_cards: Array<{ goal_id: string; target_agent_slug: string; intent: string; outcome: string; by: import("./cgo-watch").CardActor }>;
  finished_steps: Array<{
    goal_id: string | null;
    agent: string;
    ordered_by: "cgo";
    status: string;
    summary: string;
    reply?: CgoReplyStatus;
    reason?: string;
    question?: string;
    run_id?: string;
    problem?: string;
    report?: string;
  }>;
  evidence?: CgoEvidence;
  count_source?: import("./goal-count-review").CountSourceView;
  due_readouts?: DueTest[];
  due_readouts_more?: number;
};

const GOAL_COLUMNS =
  "id, objective, target_metric, target_value, baseline_value, current_value, current_value_at, current_value_source, due_date, status, priority, measurement_mode, created_at, count_rule, measure_source, value_kind, value_period_start";

export async function loadActiveGoals(tenant_id: string): Promise<GoalRow[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("autopilot_goals")
    .select(GOAL_COLUMNS)
    .eq("tenant_id", tenant_id)
    .eq("status", "active")
    .order("priority", { ascending: false });
  if (error) throw new Error(`goal-owner: goals read failed: ${error.message}`);
  return (data ?? []) as GoalRow[];
}

export type PlanLocked = { agent: string; needs_tier: PaidTier; price_usd: number };

export async function allowedAgents(
  tenant_id: string,
  adBudget: ActiveAdBudget | null,
  organic: { on: boolean; removed?: ReadonlySet<string> },
): Promise<{ allowed: string[]; locked: PlanLocked[] }> {
  const { getVisibleAgentSlugs } = await import("@/services/agents/visibility");
  const visible = await getVisibleAgentSlugs(tenant_id);
  const candidates = [...visible].filter((s) => CGO_TARGETS.has(s));
  if (adBudget) candidates.push(...[...CGO_AD_TARGETS].filter((s) => !organic.removed?.has(s)));
  if (organic.on) candidates.push(...[...CGO_ORGANIC_TARGETS].filter((s) => !organic.removed?.has(s)));
  const { createTierGate } = await import("@/services/agents/entitlement");
  const { isPaidTier, TIER_PRICE_USD } = await import("@/services/billing/tiers");
  const gate = createTierGate();
  const allowed: string[] = [];
  const locked: PlanLocked[] = [];
  const failed: string[] = [];
  for (const slug of [...new Set(candidates)].sort()) {
    let d: Awaited<ReturnType<typeof gate.decide>>;
    try {
      d = await gate.decide(tenant_id, slug);
    } catch (e) {
      failed.push(`${slug}: ${(e as Error).message}`);
      continue;
    }
    if (d.unverified) {
      failed.push(`${slug}: plan config unreadable`);
      continue;
    }
    if (d.allowed) allowed.push(slug);
    else if (isPaidTier(d.required_tier)) locked.push({ agent: slug, needs_tier: d.required_tier, price_usd: TIER_PRICE_USD[d.required_tier] });
  }
  if (failed.length) console.warn(`[goal-owner] plan check failed for tenant ${tenant_id}, ${failed.length} agent(s) left out: ${failed[0]}`);
  return { allowed, locked };
}

export function founderRemovedChannels(rows: ReadonlyArray<{ channel_slug: string; plan_selected: boolean | null; plan_selected_set_by: string | null }>): Set<string> {
  return new Set(
    rows
      .filter((c) => c.plan_selected_set_by === "founder_stopped" || (c.plan_selected === false && c.plan_selected_set_by === "founder"))
      .map((c) => c.channel_slug),
  );
}

async function readFounderRemoved(tenant_id: string): Promise<Set<string>> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_channels")
    .select("channel_slug, plan_selected, plan_selected_set_by")
    .eq("tenant_id", tenant_id)
    .eq("plan_selected", false)
    .in("plan_selected_set_by", ["founder", "founder_stopped"]);
  if (error) throw new Error(`goal-owner: channel plan read failed: ${error.message}`);
  return founderRemovedChannels((data ?? []) as Array<{ channel_slug: string; plan_selected: boolean | null; plan_selected_set_by: string | null }>);
}

export async function readAutorunChannels(tenant_id: string): Promise<Set<string>> {
  const { readChannelAutorunView } = await import("./channel-autorun");
  return (await readChannelAutorunView(tenant_id, "goal-owner")).effectiveSet();
}

export function unspentThisMonthUsd(b: ActiveAdBudget): number {
  return Math.max(0, b.month_cap_usd - b.spent_usd - b.creator_held_usd - b.creator_spent_usd);
}

export function adSpareDailyUsd(b: ActiveAdBudget, forecast?: { forecast_daily_usd: number } | null): number | null {
  return spareDailyCapacityUsd(
    b.left_usd,
    b.days_left,
    budgetMargin(b),
    { limit_usd: b.daily_limit_usd, held_usd: b.held_usd },
    forecast ? { daily_usd: forecast.forecast_daily_usd, unspent_usd: unspentThisMonthUsd(b) } : null,
  );
}

const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function adBudgetInWords(left_usd: number, spare_daily_usd: number | null): string {
  const left = `${usd(Math.max(0, left_usd))} of this month's ad budget is not spent or held yet`;
  if (spare_daily_usd === null) return `${left}.`;
  if (spare_daily_usd <= 0) return `${left}, but there is no room for new daily ad spend.`;
  return `${left}; up to ${usd(spare_daily_usd)} a day of new ad spend still fits.`;
}

export function adBudgetView(b: ActiveAdBudget | null, forecast?: { forecast_daily_usd: number } | null): GoalOwnerContext["ad_budget"] {
  if (!b) return undefined;
  const spare = adSpareDailyUsd(b, forecast);
  return {
    monthly_usd: b.monthly_usd,
    this_month_cap_usd: b.month_cap_usd,
    spent_this_month_usd: b.spent_usd,
    held_rest_of_month_usd: b.held_usd,
    left_usd: b.left_usd,
    daily_limit_usd: b.daily_limit_usd,
    days_left_in_month: b.days_left,
    next_month_starts: b.next_month_start,
    spare_daily_capacity_usd: spare,
    in_words: adBudgetInWords(b.left_usd, spare),
  };
}

export function spendPaceView(
  p: SpendPace | null | undefined,
  forecast?: { forecast_daily_usd: number; actual_today_usd: number } | null,
): GoalOwnerContext["spend_pace"] {
  if (!p) return undefined;
  return {
    daily_target_usd: p.daily_target_usd,
    actual_today_usd: forecast ? forecast.actual_today_usd : null,
    actual_month_usd: p.actual_month_usd,
    required_so_far_usd: p.required_cumulative_usd,
    delivery_debt_usd: p.delivery_debt_usd,
    live_ads_per_day_usd: forecast ? forecast.forecast_daily_usd : null,
    days_left: p.days_left,
    behind: deliveryDebtHigh(p),
    data_fresh: p.data_fresh,
  };
}

export async function buildGoalOwnerContext(
  tenant_id: string,
  now: Date = new Date(),
  wake: GoalOwnerContext["wake"] = { kind: "founder", reason: "goal_set", check_reasons: [], autopilot: true },
  founderReply?: FounderReply,
): Promise<GoalOwnerContext> {
  const svc = tenantClient(asTenantId(tenant_id));
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();
  const goals = await loadActiveGoals(tenant_id);
  const { readWatchState, channelViews, founderView, isOffPace } = await import("./cgo-watch");

  const adBudget = wake.autopilot ? await cgoAdBudget(tenant_id, now) : null;
  const spendPace = adBudget ? await loadSpendPace(tenant_id, now) : null;
  const forecast = adBudget ? await loadLiveForecast(tenant_id, now).catch(() => null) : null;
  const { readQuestions } = await import("./cgo-questions");
  const { readFounderOrders } = await import("./founder-orders-view");
  const [watch, cards, steps, questions, founderOrders] = await Promise.all([
    readWatchState(tenant_id, now),
    svc
      .from("decisions")
      .select("body, status, emitted_at, dispatch_error, approved_by, approved_by_source, rejected_by")
      .eq("tenant_id", tenant_id)
      .eq("decision_class", CGO_CARD_CLASS)
      .gte("emitted_at", since)
      .order("emitted_at", { ascending: false })
      .limit(60),
    svc
      .from("agent_runs")
      .select("id, agent_slug, status, payload, output_text, parsed")
      .eq("tenant_id", tenant_id)
      .eq("payload->>dispatched_by", "cgo")
      .in("status", TERMINAL_RUN_STATUSES)
      .gte("enqueued_at", since)
      .order("enqueued_at", { ascending: false })
      .limit(20),
    readQuestions(tenant_id, now),
    readFounderOrders(tenant_id, now).catch((e: Error) => {
      console.warn(`[goal-owner] founder orders unreadable for tenant ${tenant_id}: ${e.message}`);
      return null;
    }),
  ]);

  const channels = channelViews(watch, now);
  const { allowed: agents, locked } = await allowedAgents(tenant_id, adBudget, { on: wake.autopilot, removed: founderRemovedChannels(watch.channels) });
  let hypotheses: import("./cgo-hypotheses").HypothesisRow[] = [];
  try {
    const { refreshHypotheses } = await import("./cgo-hypotheses");
    hypotheses = await refreshHypotheses(tenant_id, goals, { now });
  } catch (e) {
    console.warn(`[goal-owner] hypotheses unreadable for tenant ${tenant_id}: ${(e as Error).message}`);
  }
  const today = await goalToday(tenant_id, now);
  const { loadCgoEvidence } = await import("./cgo-evidence");
  const evidence = await loadCgoEvidence({
    tenant_id,
    channelSlugs: [...channels.map((c) => c.channel_slug), ...(adBudget ? [...CGO_AD_TARGETS] : [])],
    now,
    cardClass: CGO_CARD_CLASS,
    goals: goals.filter((g) => !endedReason(g, today)),
  });

  return composeGoalOwnerContext({
    today,
    goals,
    channels,
    founder: founderView(watch, now),
    lastNote: watch.notes.find((n) => !isBlockerNote(n.alarm_keys)) ?? null,
    alertsSinceLastNote: alertsSinceLastNote(watch.notes),
    cards: (cards.data ?? []) as GoalOwnerCardRow[],
    steps: (steps.data ?? []) as GoalOwnerStepRow[],
    agents,
    locked,
    adBudget,
    spendPace,
    forecast,
    wake,
    questions: questions.filter((q) => q.status === "open"),
    queued: questions.filter((q) => q.status === "queued"),
    answered: questions.filter((q) => q.status === "answered" && !q.resolved_run_id && q.answer),
    founderReply,
    founderOrders,
    offPaceIds: new Set(watch.goals.filter((g) => isOffPace(g, now)).map((g) => g.id)),
    evidence,
    hypotheses,
    dueTests: await readDueTests(tenant_id, CGO_CARD_CLASS, now).catch((e: Error) => {
      console.warn(`[goal-owner] due tests unreadable for tenant ${tenant_id}: ${e.message}`);
      return { due: [], more: 0 };
    }),
    countSource: await (async () => {
      const { countSourceView, goalsNeedCounting } = await import("./goal-count-review");
      return countSourceView(tenant_id, goalsNeedCounting(goals, (g) => numberTrusted(g, today)));
    })(),
  });
}

export type GoalOwnerCardRow = {
  body: Record<string, unknown> | null;
  status: string;
  dispatch_error?: string | null;
  approved_by?: string | null;
  approved_by_source?: string | null;
  rejected_by?: string | null;
};

export function decisionActor(r: Pick<GoalOwnerCardRow, "approved_by" | "approved_by_source" | "rejected_by">): import("./cgo-watch").CardActor {
  if (r.approved_by_source === "cgo") return "cgo";
  if ((r.approved_by || r.rejected_by) && (!r.approved_by_source || r.approved_by_source === "email")) return "founder";
  return "unknown";
}
export type GoalOwnerStepRow = { id?: string; agent_slug: string; status: string; payload: Record<string, unknown> | null; output_text: string | null; parsed?: unknown };

export function composeGoalOwnerContext(input: {
  today: string;
  goals: GoalRow[];
  channels: ChannelView[];
  founder: FounderView;
  lastNote: (Pick<WatchNote, "saw" | "changed" | "would_change" | "need" | "created_at"> & { refused?: string[] }) | null;
  alertsSinceLastNote?: Array<{ at: string; what: string }>;
  cards: GoalOwnerCardRow[];
  steps: GoalOwnerStepRow[];
  agents: string[];
  locked?: readonly PlanLocked[];
  adBudget?: ActiveAdBudget | null;
  spendPace?: SpendPace | null;
  forecast?: { forecast_daily_usd: number; actual_today_usd: number } | null;
  wake: GoalOwnerContext["wake"];
  questions?: Array<Pick<QuestionRow, "id" | "topic_key" | "ask" | "asked_at" | "expires_at" | "default_line">>;
  queued?: Array<Pick<QuestionRow, "topic_key" | "ask">>;
  answered?: Array<Pick<QuestionRow, "id" | "ask" | "answer" | "answered_via">>;
  founderReply?: FounderReply;
  founderOrders?: import("./founder-orders-view").FounderOrdersView | null;
  offPaceIds?: ReadonlySet<string>;
  evidence?: CgoEvidence;
  countSource?: GoalOwnerContext["count_source"];
  hypotheses?: readonly import("./cgo-hypotheses").HypothesisRow[];
  dueTests?: { due: DueTest[]; more: number };
}): GoalOwnerContext {
  const { today, goals, lastNote: n } = input;
  const card = (b: Record<string, unknown> | null) => ({
    goal_id: String(b?.goal_id ?? ""),
    target_agent_slug: String(b?.target_agent_slug ?? ""),
    intent: String(b?.intent ?? "").slice(0, 300),
  });

  return {
    today,
    goals: goals
      .filter((g) => !endedReason(g, today))
      .map((g) => ({
        goal_id: g.id,
        goal_rev: goalRev(g),
        objective: g.objective,
        target_metric: g.target_metric,
        target_value: g.target_value,
        current_value: g.current_value,
        due_date: g.due_date,
        measured_by: confirmedRule(g.count_rule)
          ? `counted daily: ${confirmedRule(g.count_rule)!.definition}`
          : g.measurement_mode === "auto"
            ? "a connected source"
            : TYPED_MEASURED_BY,
        ...(confirmedRule(g.count_rule)?.stale_reason ? { count_failing: true } : {}),
        measured_on: g.current_value_at ? g.current_value_at.slice(0, 10) : null,
        measured_from: g.current_value_source ?? null,
        number_trusted: numberTrusted(g, today),
        behind_pace: input.offPaceIds?.has(g.id) ?? false,
        counts_as: goalKind(g),
        projected_at_due: projectedAtDue(g, today),
        ...goalPace(g, today),
        ...(input.hypotheses ? { hypotheses: hypothesisViews(input.hypotheses, g.id) } : {}),
      })),
    ended_goals: goals
      .map((g) => ({ g, reason: endedReason(g, today) }))
      .filter((x): x is { g: GoalRow; reason: "met" | "due_passed" } => x.reason !== null)
      .map(({ g, reason }) => ({ goal_id: g.id, objective: g.objective, reason })),
    channels: input.channels,
    founder: input.founder,
    wake: input.wake,
    last_note: n
      ? { saw: n.saw, changed: n.changed, would_change: n.would_change, need: n.need, refused: n.refused ?? [], created_at: n.created_at }
      : null,
    ...(input.alertsSinceLastNote?.length ? { alerts_since_last_note: input.alertsSinceLastNote } : {}),
    saw: sawLines(goals, input.channels, input.founder, today),
    open_questions: (input.questions ?? []).map((q) => ({
      question_id: q.id,
      topic: q.topic_key,
      ask: q.ask,
      asked_on: q.asked_at.slice(0, 10),
      expires_on: q.expires_at ? q.expires_at.slice(0, 10) : null,
      default_line: q.default_line,
    })),
    ...(input.queued?.length ? { queued_questions: input.queued.slice(0, 10).map((q) => ({ topic: q.topic_key, ask: q.ask })) } : {}),
    ...(input.founderReply
      ? {
          founder_reply: {
            via: input.founderReply.via,
            text: input.founderReply.text,
            ...(input.founderReply.cgo_reading ? { cgo_reading: input.founderReply.cgo_reading } : {}),
          },
        }
      : {}),
    ...(input.founderOrders ? { founder_orders: input.founderOrders } : {}),
    ...(input.answered?.length
      ? {
          answered_questions: input.answered.slice(0, 10).map((q) => ({
            question_id: q.id,
            ask: q.ask,
            answer: String(q.answer ?? "").slice(0, 500),
            via: q.answered_via ?? null,
          })),
        }
      : {}),
    allowed_agents: input.agents,
    ...(input.locked?.length ? { plan_locked: [...input.locked] } : {}),
    ...(input.adBudget ? { ad_budget: adBudgetView(input.adBudget, input.forecast) } : {}),
    ...(input.adBudget && input.spendPace ? { spend_pace: spendPaceView(input.spendPace, input.forecast) } : {}),
    open_cards: input.cards.filter((r) => r.status === "proposed").map((r) => card(r.body)),
    decided_cards: input.cards
      .filter((r) => r.status !== "proposed")
      .slice(0, 20)
      .map((r) => ({ ...card(r.body), outcome: r.status, by: decisionActor(r) })),
    finished_steps: [...input.steps.map(finishedStep), ...input.cards.filter(refusedByServer).map(refusedStep)],
    ...(input.evidence ? { evidence: budgetEvidence(input.evidence, input.adBudget ? AD_EVIDENCE_CHAR_BUDGET : EVIDENCE_CHAR_BUDGET) } : {}),
    ...(input.countSource ? { count_source: input.countSource } : {}),
    ...(input.dueTests && input.dueTests.due.length > 0 ? { due_readouts: input.dueTests.due, ...(input.dueTests.more > 0 ? { due_readouts_more: input.dueTests.more } : {}) } : {}),
  };
}

type FinishedStep = GoalOwnerContext["finished_steps"][number];

export const STEP_REPORT_CHARS = 1500;
const REPORT_AGENTS = new Set(["research", "pm"]);

function finishedStep(s: GoalOwnerStepRow): FinishedStep {
  const reply = cgoReplyOf(s.parsed);
  const text = (s.output_text ?? "").replace(/\s+/g, " ").trim();
  const raw = text.slice(0, 300);
  const brief = (s.payload?.cgo_brief ?? null) as { problem?: unknown } | null;
  const problem = typeof s.payload?.problem === "string" ? s.payload.problem : typeof brief?.problem === "string" ? brief.problem : undefined;
  return {
    goal_id: typeof s.payload?.goal_id === "string" ? s.payload.goal_id : null,
    agent: s.agent_slug,
    ordered_by: "cgo",
    status: s.status,
    summary: reply?.summary || raw,
    ...(reply ? { reply: reply.status } : {}),
    ...(reply?.reason ? { reason: reply.reason } : {}),
    ...(reply?.question ? { question: reply.question } : {}),
    ...(s.id ? { run_id: s.id } : {}),
    ...(problem ? { problem } : {}),
    ...(REPORT_AGENTS.has(s.agent_slug) && text.length > raw.length ? { report: cutAtWord(text, STEP_REPORT_CHARS) } : {}),
  };
}

const refusedByServer = (r: GoalOwnerCardRow) => r.status === "dispatch_failed" && !!r.dispatch_error;

function refusedStep(r: GoalOwnerCardRow): FinishedStep {
  const err = String(r.dispatch_error);
  const gate = /^cgo_not_authorized:\s*/.test(err);
  return {
    goal_id: typeof r.body?.goal_id === "string" ? r.body.goal_id : null,
    agent: String(r.body?.target_agent_slug ?? ""),
    ordered_by: "cgo",
    status: "not_started",
    summary: String(r.body?.intent ?? "").replace(/\s+/g, " ").slice(0, 300),
    ...(gate ? { reply: "rejected" as const } : {}),
    reason: err.replace(/^cgo_not_authorized:\s*/, "").slice(0, 300),
  };
}

export type FounderClosedCard = { channel_slug: string; title: string; at: string };

const citeNorm = (s: string) =>
  s.toLowerCase().replace(/[“”"«»'’]/g, "").replace(/[^a-z0-9$%]+/g, " ").trim();

export function rejectionCitesCard(reason: string, title: string): boolean {
  const forms = [reason, reason.replace(/['’]s(\s+cards?\b)/gi, "$1")].map((x) => ` ${citeNorm(x)} `);
  const r = forms[1];
  const has = (x: string) => forms.some((f) => f.includes(` ${x} `));
  const t = citeNorm(title);
  if (t.length >= 8 && has(t)) return true;
  const names = refsFromText(title).names.map(citeNorm).filter((n) => n.length >= 4);
  return names.length > 0 && /\bcards?\b/.test(r) && names.every(has);
}

export function withFounderClosedCited(orders: readonly RejectedOrder[], closed: readonly FounderClosedCard[]): RejectedOrder[] {
  return orders.map((o) => {
    const rejectedAt = Date.parse(o.rejected_at ?? "");
    if (Number.isNaN(rejectedAt)) return o;
    const hit = closed.some((c) => c.channel_slug === o.target && Date.parse(c.at) > rejectedAt && rejectionCitesCard(o.reason, c.title));
    return hit ? { ...o, founder_closed_cited: true } : o;
  });
}

async function readFounderClosedCards(tenant_id: string, since: string): Promise<FounderClosedCard[]> {
  const svc = tenantClient(asTenantId(tenant_id));
  const { data: ev, error } = await svc
    .from("channel_action_events")
    .select("action_id, at")
    .eq("tenant_id", tenant_id)
    .eq("actor_kind", "founder")
    .in("event", ["acted", "rejected", "snoozed", "approved"])
    .gte("at", since)
    .limit(500);
  if (error) throw new Error(error.message);
  const events = (ev ?? []) as Array<{ action_id: string; at: string }>;
  if (!events.length) return [];
  const { data: rows, error: rErr } = await svc
    .from("channel_actions")
    .select("id, channel_slug, title")
    .eq("tenant_id", tenant_id)
    .in("id", [...new Set(events.map((e) => e.action_id))]);
  if (rErr) throw new Error(rErr.message);
  const byId = new Map(((rows ?? []) as Array<{ id: string; channel_slug: string; title: string }>).map((r) => [r.id, r]));
  return events.flatMap((e) => {
    const r = byId.get(e.action_id);
    return r ? [{ channel_slug: r.channel_slug, title: r.title ?? "", at: e.at }] : [];
  });
}

export function rejectedOrdersFrom(
  rows: ReadonlyArray<{ agent_slug: string; payload: Record<string, unknown> | null; parsed?: unknown; finished_at?: string | null }>,
): RejectedOrder[] {
  const out: RejectedOrder[] = [];
  for (const r of rows) {
    const reply = cgoReplyOf(r.parsed);
    if (reply?.status !== "rejected") continue;
    const p = r.payload ?? {};
    const brief = (p.cgo_brief ?? null) as { goal?: { current_value?: unknown } } | null;
    const v = brief?.goal?.current_value;
    out.push({
      target: r.agent_slug,
      goal_id: typeof p.goal_id === "string" ? p.goal_id : null,
      intent: typeof p.intent === "string" ? p.intent : "",
      reason: reply.reason ?? "no reason given",
      briefed_value: typeof v === "number" ? v : null,
      briefed_rev: typeof p.goal_rev === "string" ? p.goal_rev : null,
      rejected_at: r.finished_at ?? null,
    });
  }
  return out;
}

export function answerKeysFrom(
  runs: ReadonlyArray<{ agent_slug: string; payload: Record<string, unknown> | null; parsed?: unknown; finished_at?: string | null }>,
  approvals: ReadonlyArray<{ key: string; approved_at: string | null }>,
): Set<string> {
  const latest = new Map<string, { status: string | undefined; at: string }>();
  for (const r of runs) {
    const key = `${String(r.payload?.goal_id ?? "")}:${r.agent_slug}`;
    if (latest.has(key)) continue;
    latest.set(key, { status: cgoReplyOf(r.parsed)?.status, at: r.finished_at ?? "" });
  }
  const out = new Set<string>();
  for (const [key, l] of latest) {
    if (l.status !== "input_required" && l.status !== "rejected") continue;
    if (approvals.some((a) => a.key === key && (a.approved_at ?? "") > l.at)) continue;
    out.add(key);
  }
  return out;
}

export async function expireCardsOffActiveGoals(tenant_id: string, activeIds: Set<string>): Promise<void> {
  const svc = tenantClient(asTenantId(tenant_id));
  const { data, error } = await svc
    .from("decisions")
    .select("id, body")
    .eq("tenant_id", tenant_id)
    .eq("decision_class", CGO_CARD_CLASS)
    .eq("status", "proposed");
  if (error) throw new Error(`goal-owner: open cards read failed: ${error.message}`);
  for (const row of (data ?? []) as Array<{ id: string; body: Record<string, unknown> | null }>) {
    if (activeIds.has(String(row.body?.goal_id ?? ""))) continue;
    const { error: e } = await svc
      .from("decisions")
      .update({ status: "expired" })
      .eq("id", row.id)
      .eq("tenant_id", tenant_id)
      .eq("status", "proposed");
    if (e) console.warn(`[goal-owner] withdrawing card ${row.id} failed: ${e.message}`);
  }
}

export async function syncGoalWork(tenant_id: string, goal_id: string, now: Date = new Date()): Promise<void> {
  try {
    const svc = tenantClient(asTenantId(tenant_id));
    const goal = await svc
      .from("autopilot_goals")
      .select(`${GOAL_COLUMNS}, updated_at`)
      .eq("tenant_id", tenant_id)
      .eq("id", goal_id)
      .maybeSingle<GoalRow & { updated_at: string | null }>();
    if (goal.error) throw new Error(goal.error.message);
    const active = goal.data && goal.data.status === "active" ? goal.data : null;
    if (!active) return;
    const expect: Record<string, unknown> = { status: "active" };
    for (const col of ["updated_at", "target_metric", "target_value", "current_value", "current_value_at", "due_date"] as const) {
      expect[col] = active[col] ?? null;
    }
    const w = await writeAutopilotGoal(tenant_id, {
      op: "update",
      goal_id,
      values: { cgo_status_line: statusLineFor(active, await goalToday(tenant_id, now)).slice(0, 240), cgo_status_at: now.toISOString() },
      expect,
      actor: { source: "system" },
    });
    if (w.status === "error") throw new Error(w.error);
  } catch (e) {
    console.warn(`[goal-owner] goal work sync failed for goal ${goal_id}: ${(e as Error).message}`);
  }
}

export type EnqueueGoalOwnerInput = {
  reddit?: { incident_id: string; issues: string[]; quiet_ok?: boolean };
  tenant_id: string;
  reason: WakeReason;
  check?: { kind: NoteKind; reasons: AlarmReason[]; alarm_keys: string[] };
  goal_id?: string | null;
  run_id?: string | null;
  decision_id?: string | null;
  founder_reply?: FounderReply;
  require_autopilot?: boolean;
  anomaly?: MetricAnomalyWake;
  now?: Date;
};

export type EnqueueGoalOwnerResult =
  | { enqueued: true; run_id: string }
  | { enqueued: false; skipped: "no_active_goals" | "daily_cap" | "duplicate" | "autopilot_off" | "recent_review" };

export async function goalOwnerDailyCap(tenant_id: string, now: Date = new Date()): Promise<number> {
  return (await cgoAdBudget(tenant_id, now)) ? GOAL_OWNER_DAILY_CAP_AD_BUDGET : GOAL_OWNER_DAILY_CAP;
}

export const ANOMALY_WAKES_PER_DAY = 3;

export { firstGoalReviewKey, firstGoalReviewRetryKey } from "./goal-review-identity";

export async function isPaidTenant(tenant_id: string): Promise<boolean> {
  try {
    const { loadTierGateConfig, resolveTenantTier } = await import("@/services/agents/entitlement");
    const { isPaidTier } = await import("@/services/billing/tiers");
    return isPaidTier(await resolveTenantTier(tenant_id, await loadTierGateConfig()));
  } catch {
    return false;
  }
}

export const BUDGET_REVIEW_QUIET_HOURS = 3;

export async function enqueueGoalOwnerRun(input: EnqueueGoalOwnerInput): Promise<EnqueueGoalOwnerResult> {
  let r: EnqueueGoalOwnerResult;
  try {
    r = await enqueueGoalOwnerRunUnlogged(input);
  } catch (e) {
    const err = e as Error | null;
    if (err?.name === "InsufficientCreditsError" || isInsufficientCreditsError(err)) {
      void recordWakeSkip(input.tenant_id, input.reason, "no_credits");
    }
    throw e;
  }
  if (!r.enqueued) void recordWakeSkip(input.tenant_id, input.reason, r.skipped);
  return r;
}

export async function withdrawQuestionsOffGoals(tenant_id: string, liveRevs: ReadonlyMap<string, string>): Promise<void> {
  try {
    const { withdrawStaleGoalQuestions, promoteQueuedQuietly } = await import("./cgo-questions");
    if ((await withdrawStaleGoalQuestions(tenant_id, liveRevs)) > 0) await promoteQueuedQuietly(tenant_id, new Date());
  } catch (e) {
    console.warn(`[goal-owner] withdrawing questions off inactive goals failed: ${(e as Error).message}`);
  }
}

async function reviewsToday(tenant_id: string, day: string, kind: "budget" | "founder"): Promise<number> {
  let q = tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenant_id)
    .eq("agent_slug", "cgo")
    .eq("payload->>stage", OWN_GOALS_STAGE);
  q = kind === "budget"
    ? q.eq("payload->>reason", "ad_budget_review")
    : q.neq("payload->>reason", "daily_check").neq("payload->>reason", "ad_budget_review").neq("payload->>reason", "metric_anomaly");
  const { count, error } = await q.gte("enqueued_at", `${day}T00:00:00.000Z`);
  if (error) throw new Error(`goal-owner: daily count failed: ${error.message}`);
  return count ?? 0;
}

export async function chatAskAdmission(
  tenant_id: string,
  now: Date = new Date(),
): Promise<"no_active_goals" | "autopilot_off" | "daily_cap" | null> {
  if ((await loadActiveGoals(tenant_id)).length === 0) return "no_active_goals";
  const { getBoolSettingStrictResolved } = await import("@/services/settings");
  if (!(await getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id))) return "autopilot_off";
  const used = await reviewsToday(tenant_id, utcDay(now), "founder");
  return used >= (await goalOwnerDailyCap(tenant_id, now)) ? "daily_cap" : null;
}

async function enqueueGoalOwnerRunUnlogged(input: EnqueueGoalOwnerInput): Promise<EnqueueGoalOwnerResult> {
  const now = input.now ?? new Date();
  const day = utcDay(now);
  const svc = tenantClient(asTenantId(input.tenant_id));

  const goals = await loadActiveGoals(input.tenant_id);
  if (goals.length === 0) {
    await expireCardsOffActiveGoals(input.tenant_id, new Set());
    await withdrawQuestionsOffGoals(input.tenant_id, new Map());
    return { enqueued: false, skipped: "no_active_goals" };
  }

  const { getBoolSettingStrictResolved } = await import("@/services/settings");
  const autopilot = await getBoolSettingStrictResolved("cgo_autopilot_enabled", input.tenant_id);
  const isCheck = input.reason === "daily_check";
  const isReply = input.reason === "founder_reply";
  if (isReply && !input.founder_reply) return { enqueued: false, skipped: "duplicate" };
  const isAnomaly = input.reason === "metric_anomaly";
  if (isAnomaly && !input.anomaly) return { enqueued: false, skipped: "duplicate" };
  if (isAnomaly && !autopilot && !(await isPaidTenant(input.tenant_id))) return { enqueued: false, skipped: "autopilot_off" };
  if (isAnomaly) {
    const { count, error } = await svc
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", input.tenant_id)
      .eq("agent_slug", "cgo")
      .eq("payload->>stage", OWN_GOALS_STAGE)
      .eq("payload->>reason", "metric_anomaly")
      .gte("enqueued_at", `${day}T00:00:00.000Z`);
    if (error) throw new Error(`goal-owner: anomaly wake count failed: ${error.message}`);
    if ((count ?? 0) >= ANOMALY_WAKES_PER_DAY) return { enqueued: false, skipped: "daily_cap" };
  }
  if (!isCheck && !isReply && !isAnomaly && !autopilot) return { enqueued: false, skipped: "autopilot_off" };
  if (input.require_autopilot && !autopilot) return { enqueued: false, skipped: "autopilot_off" };
  const isBudgetReview = input.reason === "ad_budget_review";
  if (input.reason === "reddit_ads_change" && !input.reddit) return { enqueued: false, skipped: "duplicate" };
  let dedupe = isAnomaly
    ? `${input.tenant_id}:cgo-anomaly:${input.anomaly!.incident_id}`
    : `${input.tenant_id}:cgo-check:${day}`;
  if (isCheck) {
    const { data: prior, error: priorErr } = await svc
      .from("agent_runs")
      .select("cron_dedupe_key, enqueued_at, status")
      .eq("tenant_id", input.tenant_id)
      .eq("agent_slug", "cgo")
      .eq("payload->>stage", OWN_GOALS_STAGE)
      .eq("payload->>reason", "daily_check")
      .order("enqueued_at", { ascending: false })
      .limit(1);
    if (priorErr) throw new Error(`goal-owner: first check read failed: ${priorErr.message}`);
    const last = (prior as Array<{ cron_dedupe_key: string | null; enqueued_at: string | null; status: string | null }> | null)?.[0];
    const freeKeys = [firstGoalReviewKey(input.tenant_id), firstGoalReviewRetryKey(input.tenant_id)];
    if (!last) dedupe = firstGoalReviewKey(input.tenant_id);
    else if (freeKeys.includes(last.cron_dedupe_key ?? "") && (last.enqueued_at ?? "").slice(0, 10) === day) {
      return { enqueued: false, skipped: "duplicate" };
    } else if (last.cron_dedupe_key === firstGoalReviewKey(input.tenant_id) && last.status === "dispatch_error") {
      dedupe = firstGoalReviewRetryKey(input.tenant_id);
    }
  }
  if (!isCheck && !isAnomaly) {
    const used = await reviewsToday(input.tenant_id, day, isBudgetReview ? "budget" : "founder");
    const ownReply = isReply && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.founder_reply!.reply_run_id);
    if (!ownReply && used >= (await goalOwnerDailyCap(input.tenant_id, now))) return { enqueued: false, skipped: "daily_cap" };
    if (isBudgetReview || (input.reason === "reddit_ads_change" && input.reddit?.quiet_ok === true)) {
      const since = new Date(now.getTime() - BUDGET_REVIEW_QUIET_HOURS * 3_600_000).toISOString();
      const { count: recent, error: recentErr } = await svc
        .from("agent_runs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", input.tenant_id)
        .eq("agent_slug", "cgo")
        .eq("payload->>stage", OWN_GOALS_STAGE)
        .gte("enqueued_at", since);
      if (recentErr) throw new Error(`goal-owner: recent review read failed: ${recentErr.message}`);
      if ((recent ?? 0) > 0) return { enqueued: false, skipped: "recent_review" };
    }
    dedupe = input.reason === "reddit_ads_change" ? `${input.tenant_id}:cgo-reddit:${input.reddit!.incident_id}` : isBudgetReview
      ? `${input.tenant_id}:cgo-budget:${day}:h${now.getUTCHours()}`
      : isReply && !input.founder_reply!.reply_run_id.startsWith("chat:")
        ? `${input.tenant_id}:cgo-reply:${input.founder_reply!.reply_run_id}`
        : `${input.tenant_id}:cgo-own:${day}:${used + 1}`;
  }

  const payload = await buildGoalOwnerPayload(input, autopilot, now);
  const { enqueueAgentRun } = await import("@/services/agents/runner");
  const { run_id } = await enqueueAgentRun({
    agent_slug: "cgo",
    tenant_id: input.tenant_id,
    trigger: "a2a",
    cron_dedupe_key: dedupe,
    payload,
  });
  if (!run_id) return { enqueued: false, skipped: "duplicate" };
  return { enqueued: true, run_id };
}

export function budgetContextDegraded(context: Pick<GoalOwnerContext, "ad_budget" | "spend_pace">): boolean {
  if (!context.ad_budget) return false;
  return !context.spend_pace || context.spend_pace.live_ads_per_day_usd == null;
}

export async function buildGoalOwnerPayload(
  input: EnqueueGoalOwnerInput,
  autopilot: boolean,
  now: Date,
): Promise<Record<string, unknown>> {
  const isBudgetReview = input.reason === "ad_budget_review";
  const isAnomaly = input.reason === "metric_anomaly";
  const wake = {
    kind: input.check?.kind ?? (isBudgetReview || isAnomaly ? ("alarm" as const) : ("founder" as const)),
    reason: input.reason,
    check_reasons: input.check?.reasons ?? [],
    autopilot,
    ...(input.anomaly ? { anomaly: input.anomaly } : {}),
    ...(input.reddit ? { reddit: { incident_id: input.reddit.incident_id, issues: input.reddit.issues } } : {}),
  };
  const { signatureForPayload } = await import("./budget-review-signature");
  const signature = await signatureForPayload(input.tenant_id, now);
  const { refreshGoalNumbers } = await import("@/services/autopilot/refresh-goal-numbers");
  await refreshGoalNumbers(input.tenant_id, now);
  const context = await buildGoalOwnerContext(input.tenant_id, now, wake, input.founder_reply);
  const budget_signature = signature && !budgetContextDegraded(context) ? signature : null;
  const { readLastCheckInNote } = await import("./cgo-watch");
  const prev = await readLastCheckInNote(input.tenant_id);
  const prev_idle = prev ? !isNoteVisible(prev) : false;
  return {
    stage: OWN_GOALS_STAGE,
    reason: input.reason,
    note_kind: wake.kind,
    autopilot,
    alarm_keys:
      input.check?.alarm_keys ??
      (isBudgetReview ? [AD_BUDGET_REVIEW_NOTE_KEY] : isAnomaly ? [`metric_anomaly:${input.anomaly!.incident_id}`] : []),
    prev_idle,
    ...(budget_signature ? { budget_signature } : {}),
    ...(input.founder_reply ? { founder_reply: { via: input.founder_reply.via, reply_run_id: input.founder_reply.reply_run_id } } : {}),
    ...(input.goal_id ? { goal_id: input.goal_id } : {}),
    ...(input.run_id ? { wake_run_id: input.run_id } : {}),
    ...(input.decision_id ? { wake_decision_id: input.decision_id } : {}),
    memory: { cgo_goals: context },
  };
}

export function cutAtWord(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max - 1);
  const sp = head.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? head.slice(0, sp) : head).replace(/[\s,;:.\-]+$/, "")}…`;
}

const text = (max: number) => z.string().min(1).transform((s) => cutAtWord(s, max));

export { GROWTH_PROBLEMS, normalizeProblem, type GrowthProblem } from "./goal-owner-problems";
import { GROWTH_PROBLEMS, normalizeProblem, type GrowthProblem } from "./goal-owner-problems";
import { hypothesisViews } from "./cgo-hypotheses";

export function cutAtSentence(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const m = /^.*[.!?](?=\s|$)/.exec(t.slice(0, max));
  return m && m[0].length >= max * 0.4 ? m[0] : cutAtWord(t, max);
}

export function leftCardKey(line: string): string | null {
  const m = /^Left for you: (.*?)(?:, because .*|\.)$/.exec(line);
  return m ? m[1] : null;
}

export function leftForYouLine(title: string, reason: string): string {
  const t = cutAtWord(title.replace(/\s+/g, " "), 120);
  if (!reason.trim()) return `Left for you: ${t}.`;
  const head = `Left for you: ${t}, because `;
  const r = cutAtSentence(reason.replace(/[.\s]+$/, ""), 400 - head.length - 1).replace(/[.\s]+$/, "");
  return `${head}${r}.`;
}

const CARD_CUT_RE =
  /\b(pause|pausing|stop|turn(ing)? off|switch off|disable|shut( down)?|kill)\b|\b(lower|cut|reduce|decrease|trim|halve)\b[^.]{0,40}\b(budget|spend|bids?)\b|\b(budget|spend)\b[^.]{0,20}\b(cut|down|lower|reduc)/i;

export function channelCardCutHeld(
  card: { channel_slug: string; title: string; step: string },
  why: string,
  evidence: CgoEvidence | null | undefined,
): string | null {
  if (!CARD_CUT_RE.test(card.title)) return null;
  const held = cutHeldByEvidence({ target: card.channel_slug, intent: `${card.title} ${card.step}`, why, evidence, basisUnknown: true });
  return held ? held.reasons.map((r) => CUT_HOLD_WORDS[r]).join("; ") : null;
}

const optionalLine = (max: number) =>
  z
    .unknown()
    .transform((v) => (typeof v === "string" && v.trim() ? cutAtWord(v, max) : undefined))
    .optional();

const noteAction = z
  .unknown()
  .transform((v) => {
    const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
    return s.length >= 3 && s.length <= 60 ? s : undefined;
  })
  .optional();
const usdSchema = z
  .unknown()
  .transform((v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v) : undefined))
  .optional();

const moveSchema = z.object({
  target_agent_slug: z.string().min(1).max(64),
  action: noteAction,
  intent: text(1500),
  why: z.string().optional().default("").transform((s) => s.slice(0, 500)),
  problem: z.unknown().transform(normalizeProblem).optional(),
  moves_metric: z
    .unknown()
    .transform((v) => (typeof v === "string" && v.trim() ? cutAtWord(v, 80) : undefined))
    .optional(),
  boundaries: optionalLine(300),
  expected_output: optionalLine(300),
  hypothesis: z.unknown().transform((v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 64) : undefined)).optional(),
  expected_gain: z.unknown().transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)).optional(),
  daily_usd: z.unknown().transform((v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : undefined)).optional(),
  test: z.unknown().transform((v) => parseMoveTest(v)).optional(),
  no_test_because: optionalLine(200),
});

const questionSchema = z.object({
  topic: text(80),
  about: z.string().max(120).optional(),
  ask: text(400),
  recommended: z
    .unknown()
    .transform((v) => (typeof v === "string" && /^(yes|no)$/i.test(v.trim()) ? (v.trim().toLowerCase() as "yes" | "no") : undefined))
    .optional(),
  why: optionalLine(200),
  if_no_answer: z
    .union([
      z.object({ action: z.literal("pause_channel"), channel_slug: z.string().min(1).max(64) }),
      z.object({
        action: z.literal("goal_change"),
        goal_id: z.string().uuid(),
        objective: z.string().min(1).max(300).optional(),
        target_metric: z.string().min(1).max(120).optional(),
        target_value: z.number().finite().optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
    ])
    .optional(),
  by_days: z.number().finite().optional(),
  ad_plan: z
    .object({ channel_slug: z.string().min(1).max(64), amount_usd: z.number().positive().max(1_000_000) })
    .optional()
    .catch(undefined),
});

export const MAX_CARD_DECISIONS = 20;

const channelCardDecisionSchema = z
  .object({
    action_id: z.string().min(1).max(64),
    decision: z.enum(["approve", "reject", "leave"]),
    why: z.string().optional().default("").transform((s) => cutAtSentence(s, 300)),
    action: noteAction,
    usd_at_stake: usdSchema,
  })
  .refine((c) => c.decision !== "leave" || c.why.trim().length > 0, { message: "channel_cards: a leave needs a why" });

export function cardsToApply(cards: ReadonlyArray<{ action_id: string }>, shown: ReadonlyMap<string, unknown> | undefined): Set<string> {
  const ids = new Set<string>();
  if (!shown) return ids;
  for (const c of cards) {
    if (ids.size >= MAX_CARD_DECISIONS) break;
    if (shown.has(c.action_id)) ids.add(c.action_id);
  }
  return ids;
}

export const goalMovesSchema = z.object({
  goals: z
    .array(
      z.object({
        goal_id: z.string().uuid(),
        status_line: z.string().optional(),
        moves: z.array(moveSchema).max(10).optional().default([]),
      }),
    )
    .max(40)
    .optional()
    .default([]),
  hypotheses: z.array(z.unknown()).max(60).optional().catch(undefined),
  read_findings: z.array(z.unknown()).max(40).optional().catch(undefined),
  verify_with_founder: z
    .object({
      goal_id: z.string().uuid(),
      hypothesis: z.string().trim().min(1).max(64),
      why: z.string().trim().max(200).optional().default(""),
    })
    .optional()
    .catch(undefined),
  readouts: z.array(z.unknown()).max(20).optional().catch(undefined),
  note: z
    .object({
      saw: z.array(z.string()).optional(),
      need: z.array(text(300)).max(2).optional().default([]),
      questions: z.array(questionSchema).max(4).optional().default([]),
      headline: z.unknown().transform((v) => (typeof v === "string" ? v.slice(0, 300) : undefined)).optional(),
    })
    .optional(),
  answered: z
    .array(z.object({ question_id: z.string().uuid(), answer: z.string().optional().default("").transform((s) => s.slice(0, 500)) }))
    .max(10)
    .optional(),
  goal_count_rules: z
    .array(z.unknown())
    .optional()
    .catch(undefined)
    .transform((items) =>
      items?.flatMap((i) => {
        const p = proposedCountRuleSchema.safeParse(i);
        return p.success ? [p.data] : [];
      }).slice(0, 3),
    )
    .optional(),
  count_rules_confirmed: z.array(z.string().uuid()).max(5).optional(),
  goal_changes: z
    .array(
      z.object({
        goal_id: z.string().uuid(),
        objective: z.string().min(1).max(300).optional(),
        target_metric: z.string().min(1).max(120).optional(),
        target_value: z.number().finite().optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        why: text(300),
      }),
    )
    .max(10)
    .optional()
    .default([]),
  channel_changes: z
    .array(z.object({ channel_slug: z.string().min(1).max(64), action: z.literal("pause"), why: text(300) }))
    .max(5)
    .optional()
    .default([]),
  channel_cards: z
    .array(z.unknown())
    .transform((items) =>
      items.flatMap((i) => {
        const p = channelCardDecisionSchema.safeParse(i);
        return p.success ? [p.data] : [];
      }),
    )
    .optional(),
  channel_card_order: z.array(z.string()).optional(),
  creator_caps: z
    .object({
      per_hire_usd: z.number().finite().positive().lt(1000000),
      per_week_usd: z.number().finite().positive().lt(1000000),
      why: z.string().trim().min(1).max(300),
    })
    .optional()
    .catch(undefined),
  next_review_in_days: z.number().finite().optional(),
  next_review_why: z.string().transform((s) => s.slice(0, 300)).optional(),
  next_goal: z
    .object({
      objective: z.string().min(1).max(300),
      target_metric: z.string().min(1).max(120),
      target_value: z.number().finite(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      rationale: z.string().transform((s) => s.slice(0, 500)).optional(),
    })
    .optional(),
});
export type GoalMoves = z.infer<typeof goalMovesSchema>;

export function parseGoalMoves(text: string): { ok: true; value: GoalMoves } | { ok: false; reason: string } {
  const m = /<goal_moves>([\s\S]*?)<\/goal_moves>/.exec(text);
  if (!m) return { ok: false, reason: "no <goal_moves> block" };
  let json: unknown;
  try {
    json = JSON.parse(m[1].trim());
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${(e as Error).message}` };
  }
  const parsed = goalMovesSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => i.message).join("; ") };
  const raw = (json as { channel_cards?: unknown } | null)?.channel_cards;
  const order = Array.isArray(raw)
    ? raw.map((c) => (c && typeof c === "object" && typeof (c as { action_id?: unknown }).action_id === "string" ? (c as { action_id: string }).action_id : ""))
    : undefined;
  const { channel_card_order: _modelOrder, ...value } = parsed.data;
  return { ok: true, value: order ? { ...value, channel_card_order: order } : value };
}

export const NO_REPO_NOTE = "Connect GitHub so I can fix the site.";

export type ApplyGoalMovesDeps = {
  emitDecision: (decision_class: string, body: unknown) => Promise<string>;
  prepareHypotheses?: typeof import("./cgo-hypotheses").prepareHypotheses;
  readDueTests?: typeof readDueTests;
  applyReadouts?: typeof applyReadouts;
  readUndeliveredFindings?: typeof readUndeliveredFindings;
  markFindingsDelivered?: typeof markFindingsDelivered;
  gateEnforced?: boolean;
  checker?: import("./cgo-hypotheses").CheckerCall;
  resolveRepo: (tenant_id: string) => Promise<{ repo: string } | null>;
  autoRun?: (tenant_id: string, decision_id: string) => Promise<boolean>;
  autorunChannels?: (tenant_id: string) => Promise<ReadonlySet<string>>;
  autopilotNow?: (tenant_id: string) => Promise<boolean>;
  adBudget?: (tenant_id: string, now: Date) => Promise<ActiveAdBudget | null>;
  pendingRoom?: (tenant_id: string, now: Date) => Promise<import("./pending-tests").PendingRoom | null>;
  reviewedRevs?: ReadonlyMap<string, string>;
  shownCards?: ReadonlyMap<string, ShownCard>;
  approveChannelAction?: (tenant_id: string, action_id: string, opts?: { onHeld?: (reasons: string[]) => void }) => Promise<boolean>;
  replyPayload?: unknown;
  founderReplyApprovals?: typeof import("./founder-reply-approve").applyFounderReplyApprovals;
  approveAdDecision?: (
    tenant_id: string,
    decision_id: string,
    decision_class: string,
    body: unknown,
    agent_slug?: string,
    opts?: { onHeld?: (reasons: string[]) => void },
  ) => Promise<boolean>;
  newerOpenCard?: (tenant_id: string, row: LegacyAdDecision) => Promise<boolean>;
  spendPace?: (tenant_id: string, now: Date) => Promise<SpendPace | null>;
  liveForecast?: (tenant_id: string, now: Date) => Promise<{ forecast_daily_usd: number; actual_today_usd: number }>;
  evidence?: CgoEvidence | null;
  countDeps?: import("./goal-count-rule").CountDeps;
  now?: Date;
  notify?: boolean;
};

export function evidenceFromPayload(payload: unknown): CgoEvidence | undefined {
  const e = (payload as { memory?: { cgo_goals?: { evidence?: unknown } } } | null)?.memory?.cgo_goals?.evidence as Partial<CgoEvidence> | undefined;
  return e && Array.isArray(e.paid) && Array.isArray(e.organic) ? (e as CgoEvidence) : undefined;
}

export type ShownCard = { channel_slug: string; title: string };

export function shownCardsFromPayload(payload: unknown): Map<string, ShownCard> | undefined {
  const channels = (payload as { memory?: { cgo_goals?: { channels?: unknown } } } | null)?.memory?.cgo_goals?.channels;
  if (!Array.isArray(channels)) return undefined;
  const out = new Map<string, ShownCard>();
  let sawCards = false;
  for (const c of channels as Array<{ channel_slug?: unknown; open_cards?: unknown }>) {
    if (typeof c.channel_slug !== "string" || !Array.isArray(c.open_cards)) continue;
    sawCards = true;
    for (const card of c.open_cards as Array<{ action_id?: unknown; title?: unknown }>) {
      if (typeof card.action_id === "string") {
        out.set(card.action_id, { channel_slug: c.channel_slug, title: typeof card.title === "string" ? card.title : "" });
      }
    }
  }
  return sawCards ? out : undefined;
}

export function reviewedRevsFromPayload(payload: unknown): Map<string, string> | undefined {
  const goals = (payload as { memory?: { cgo_goals?: { goals?: unknown } } } | null)?.memory?.cgo_goals?.goals;
  if (!Array.isArray(goals)) return undefined;
  const out = new Map<string, string>();
  for (const g of goals as Array<{ goal_id?: unknown; goal_rev?: unknown }>) {
    if (typeof g.goal_id === "string" && typeof g.goal_rev === "string") out.set(g.goal_id, g.goal_rev);
  }
  return out.size > 0 ? out : undefined;
}

export type ApplyGoalMovesResult = {
  status_lines: number;
  cards_emitted: number;
  goals_ended: number;
  goals_changed: number;
  channels_paused: number;
  next_goal_proposed: boolean;
  note_id: string | null;
  note_visible: boolean;
  note_notify: boolean;
  creator_caps_id?: string;
};

export type ReviewMeta = {
  kind: "scheduled" | "alarm" | "founder";
  alarm_keys: string[];
  autopilot: boolean;
  prev_idle?: boolean;
  saw?: string[];
  reply_via?: "email" | "slack" | "web" | "chat";
  reply_text?: string;
  answered_ids?: string[];
  behind_pace?: boolean;
  behind_required_near?: boolean;
  never_approved?: string[];
  rejected_channels?: string[];
  founder_channels?: string[];
  last_need?: string[];
  ads_clock?: boolean;
};

export function reviewMetaFromPayload(payload: unknown): ReviewMeta {
  const p = (payload ?? {}) as {
    note_kind?: unknown;
    alarm_keys?: unknown;
    autopilot?: unknown;
    prev_idle?: unknown;
    reason?: unknown;
    founder_reply?: { via?: unknown } | null;
    memory?: {
      cgo_goals?: {
        saw?: unknown;
        goals?: unknown;
        channels?: unknown;
        last_note?: { need?: unknown } | null;
        answered_questions?: unknown;
        founder_reply?: { text?: unknown } | null;
      };
    } | null;
  };
  const kind = p.note_kind === "scheduled" || p.note_kind === "alarm" ? p.note_kind : "founder";
  const keys = Array.isArray(p.alarm_keys) ? p.alarm_keys.filter((k): k is string => typeof k === "string").slice(0, 500) : [];
  const sawRaw = p.memory?.cgo_goals?.saw;
  const saw = Array.isArray(sawRaw) ? sawRaw.filter((l): l is string => typeof l === "string").slice(0, 3) : [];
  const via = p.reason === "founder_reply" ? p.founder_reply?.via : undefined;
  const goals = Array.isArray(p.memory?.cgo_goals?.goals) ? (p.memory.cgo_goals.goals as Array<{ behind_pace?: unknown; behind_required?: unknown; days_left?: unknown }>) : [];
  const channels = Array.isArray(p.memory?.cgo_goals?.channels)
    ? (p.memory.cgo_goals.channels as Array<{ channel_slug?: unknown; last_14_days?: { proposed?: unknown; acted?: unknown; rejected?: unknown } }>)
    : [];
  const never_approved = channels
    .filter((c) => typeof c.channel_slug === "string" && Number(c.last_14_days?.proposed) > 0 && Number(c.last_14_days?.acted) === 0 && Number(c.last_14_days?.rejected) === 0)
    .map((c) => c.channel_slug as string);
  const founder_channels = channels
    .filter(
      (c) =>
        typeof c.channel_slug === "string" &&
        ((c as { added_by?: unknown }).added_by === "founder" || (c as { autorun_by_founder?: unknown }).autorun_by_founder === true),
    )
    .map((c) => c.channel_slug as string);
  const rejected_channels = channels
    .filter((c) => {
      if (typeof c.channel_slug !== "string") return false;
      const fr = (c as { founder_rejected?: unknown }).founder_rejected;
      return typeof fr === "boolean" ? fr : Number(c.last_14_days?.rejected) > 0;
    })
    .map((c) => c.channel_slug as string);
  const lastNeed = p.memory?.cgo_goals?.last_note?.need;
  const last_need = Array.isArray(lastNeed) ? lastNeed.filter((l): l is string => typeof l === "string").slice(0, 20) : [];
  return {
    kind,
    alarm_keys: keys,
    autopilot: p.autopilot === true,
    prev_idle: p.prev_idle === true,
    saw,
    behind_pace: goals.some((g) => g.behind_pace === true),
    behind_required_near: goals.some(
      (g) => g.behind_required === true && typeof g.days_left === "number" && g.days_left <= DAILY_REVIEW_MAX_DAYS_LEFT,
    ),
    never_approved,
    rejected_channels,
    founder_channels,
    last_need,
    ...(p.reason === "ad_budget_review" ? { ads_clock: true } : {}),
    ...(via === "email" || via === "slack" || via === "web" || via === "chat" ? { reply_via: via } : {}),
    ...((via === "email" || via === "slack") && typeof p.memory?.cgo_goals?.founder_reply?.text === "string" && p.memory.cgo_goals.founder_reply.text.trim()
      ? { reply_text: p.memory.cgo_goals.founder_reply.text.trim().slice(0, 4000) }
      : {}),
    ...(answeredIds(p.memory?.cgo_goals?.answered_questions).length ? { answered_ids: answeredIds(p.memory?.cgo_goals?.answered_questions) } : {}),
  };
}

function answeredIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q) => (q as { question_id?: unknown } | null)?.question_id)
    .filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))
    .slice(0, 10);
}

export const MAX_LEFT_LINES = 5;

export const ADVICE_ONLY_REVIEW_DAYS = 7;

export function isNoteVisible(note: {
  changed?: readonly string[] | null;
  need?: readonly string[] | null;
  would_change?: readonly string[] | null;
  items?: readonly unknown[] | null;
}): boolean {
  if (Array.isArray(note.items) && note.items.length > 0) return noteItemsVisible(note.items, note.would_change);
  return (note.changed?.length ?? 0) > 0 || (note.need?.length ?? 0) > 0 || (note.would_change?.length ?? 0) > 0;
}

export const ON_PACE_MIN_REVIEW_DAYS = 5;
export const IDLE_BACKOFF_DAYS = 14;

const METRIC_ACRONYM = /\b(gmv|cac|roas|ltv|mrr|arr|cpa|ctr|aov)\b/gi;
function metricWords(m: string): string {
  return m.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim().replace(METRIC_ACRONYM, (a) => a.toUpperCase());
}

export function goalValueMoney(metric: string, target: number | null): boolean {
  const words = metricWords(metric);
  if (target != null && Number.isFinite(Number(target))) {
    const forms = [...new Set([String(Number(target)), num(Number(target))])].map(escapeRe);
    const at = forms.map((f) => new RegExp(`(?:^|\\s)(\\$?)${f}(?=\\s|$)`).exec(words)).find((m) => m);
    if (at) {
      if (at[1] === "$") return true;
      const unit = goalUnitWords(metric, target);
      const head = unit.replace(/^(?:in|of|on|for|at)\s+/i, "").split(/\s+(?:at|on|for|with|from|in|of|paying|per|under|within)\s+/i)[0];
      return goalMoneyMetric(head || metric);
    }
  }
  return goalMoneyMetric(metric);
}

function goalNum(n: number | null, money: boolean): string {
  return money && n != null ? `${n < 0 ? "-" : ""}$${num(Math.abs(Number(n)))}` : num(n);
}

const GOAL_PHRASE_LEAD = /^(launch|reach|get|hit|grow|increase|open|expand|add|double|triple|achieve|sign|close|win|land|go|be|run|start|enter|cover|cross|beat)\b/i;
function escapeRe(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function goalUnitWords(metric: string, target: number | null): string {
  const words = metricWords(metric);
  if (target != null && Number.isFinite(Number(target))) {
    const forms = [...new Set([String(Number(target)), num(Number(target))])].map(escapeRe);
    for (const f of forms) {
      const after = new RegExp(`(?:^|\\s)\\$?${f}\\s+(.+)$`).exec(words);
      if (after) return after[1].replace(/[\s.:;!]+$/, "").trim();
    }
    if (forms.some((f) => new RegExp(`(?:^|\\s)\\$?${f}(?=\\s|$)`).test(words))) return "";
  }
  return GOAL_PHRASE_LEAD.test(words) ? "" : words;
}
const withUnit = (unit: string) => (unit ? ` ${unit}` : "");

function goalLabel(objective: string): string {
  const s = objective.trim().replace(/[\s.:;!]+$/, "");
  return s || objective.trim();
}

export function windowsLookMismatched(g: GoalRow): boolean {
  return goalKind(g) === "ambiguous";
}

export const MISMATCHED_WINDOW_WORDS =
  ", no pace yet: I can't tell if this number is this period's total or a running level. Answer my question or set it on the goal";

export function projectedAtDue(g: GoalRow, today: string): number | null {
  return trajectoryOf(g, today).projected;
}

export const PACE_TYPED_MAX_DAYS = 3;
export const DAILY_REVIEW_MAX_DAYS_LEFT = 31;

export function paceNumberUsable(g: GoalRow, today: string): boolean {
  if (!numberTrusted(g, today)) return false;
  if (g.measurement_mode === "auto" || confirmedRule(g.count_rule)) return true;
  const age = numberAgeDays(g, today);
  return age != null && age <= PACE_TYPED_MAX_DAYS;
}

export function goalTrajectoryView(
  g: Pick<GoalRow, "target_metric" | "target_value" | "baseline_value" | "current_value" | "current_value_at" | "due_date" | "measurement_mode" | "created_at" | "count_rule" | "value_kind" | "value_period_start"> & { id: string },
  today: string = utcDay(),
): Pick<Trajectory, "kind" | "progress" | "line" | "projected" | "behind_required" | "reading_day" | "pace_usable"> {
  const t = trajectoryOf({ ...g, objective: "", status: "active", priority: null }, today);
  return {
    kind: t.kind,
    progress: t.progress,
    line: t.line,
    projected: t.projected,
    behind_required: t.behind_required,
    reading_day: t.reading_day,
    pace_usable: t.pace_usable,
  };
}

export function trajectoryOf(g: GoalRow, today: string): Trajectory {
  return goalTrajectory(g, today, { paceUsable: paceNumberUsable(g, today), progressUsable: numberTrusted(g, today) });
}

export type GoalPace = {
  days_left: number | null;
  remaining: number | null;
  required_per_day: number | null;
  behind_required: boolean;
};

const DAY_MS = 86_400_000;
const dayMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

export function goalPace(g: GoalRow, today: string): GoalPace {
  const none: GoalPace = { days_left: null, remaining: null, required_per_day: null, behind_required: false };
  if (!g.due_date || g.target_value == null) return none;
  const now = dayMs(today);
  const due = dayMs(g.due_date);
  if (!Number.isFinite(now) || !Number.isFinite(due) || due < now) return none;
  const days_left = Math.round((due - now) / DAY_MS) + 1;
  const target = Number(g.target_value);
  const base = g.baseline_value == null ? 0 : Number(g.baseline_value);
  const kind = goalKind(g);
  const lowerIsBetter = kind === "gauge" && g.baseline_value != null && target < base;
  if (!paceNumberUsable(g, today) || g.current_value == null) return { ...none, days_left };
  if (kind === "ambiguous") return { ...none, days_left, behind_required: trajectoryOf(g, today).behind_required };
  const current = Number(g.current_value);
  const remaining = Math.max(0, lowerIsBetter ? current - target : target - current);
  const required_per_day = Math.round((remaining / days_left) * 100) / 100;
  const behind_required = remaining > 0 && trajectoryOf(g, today).behind_required;
  return { days_left, remaining, required_per_day, behind_required };
}

export function spareDailyCapacityUsd(
  left_usd: number,
  days_left: number,
  margin: number,
  daily?: { limit_usd: number | null; held_usd: number },
  forecast?: { daily_usd: number; unspent_usd: number } | null,
): number | null {
  if (!(days_left > 0) || !(margin >= 1) || !Number.isFinite(left_usd)) return null;
  if (forecast && Number.isFinite(forecast.daily_usd) && Number.isFinite(forecast.unspent_usd)) {
    const running = Math.max(0, forecast.daily_usd);
    let spare = Math.max(0, forecast.unspent_usd) / days_left - running;
    if (daily && daily.limit_usd != null && Number.isFinite(daily.limit_usd)) spare = Math.min(spare, daily.limit_usd - running);
    return Math.max(0, Math.floor(spare * 100) / 100);
  }
  let cap = left_usd / (days_left * margin);
  if (daily && daily.limit_usd != null && Number.isFinite(daily.limit_usd)) {
    const running = Number.isFinite(daily.held_usd) ? daily.held_usd / (days_left * margin) : Infinity;
    cap = Math.min(cap, daily.limit_usd - running);
  }
  return Math.max(0, Math.floor(cap * 100) / 100);
}

export function statusLineFor(g: GoalRow, today: string): string {
  const metric = metricWords(g.target_metric);
  const money = goalValueMoney(g.target_metric, g.target_value);
  const target = g.target_value == null ? null : goalNum(g.target_value, money);
  const unit = withUnit(goalUnitWords(g.target_metric, g.target_value));
  let where: string;
  if (g.current_value == null) where = target ? `Not counted yet (aiming for ${target}${unit})` : `Not counted yet (${metric})`;
  else where = target ? `${goalNum(g.current_value, money)} of ${target}${unit}` : `${goalNum(g.current_value, money)} ${metric}`;
  if (g.current_value != null && !numberTrusted(g, today)) where += staleWords(g, today);
  if (g.due_date) {
    const left = Math.round((Date.parse(`${g.due_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    where += left < 0 ? ", past its due date" : left === 0 ? ", due today" : `, ${left} day${left === 1 ? "" : "s"} left`;
  }
  const pace = projectedAtDue(g, today);
  if (pace != null) where += `, on pace for about ${goalNum(pace, money)} by ${humanDate(g.due_date)}`;
  else if (g.current_value != null && windowsLookMismatched(g)) where += MISMATCHED_WINDOW_WORDS;
  return where;
}

export type NoteGoalView = {
  title: string;
  current: string | null;
  not_counted?: string | null;
  target: string | null;
  progress: number | null;
  due: string | null;
  pace: string | null;
  verdict?: string | null;
  tone?: "short" | "on_pace" | null;
  aim?: string;
  source?: string | null;
  founder_estimate?: string | null;
};

export function noteGoalViews(goals: GoalRow[], today: string, founderCustomers: string | null = null, tz: string = "UTC"): NoteGoalView[] {
  return goals
    .filter((g) => !endedReason(g, today))
    .slice(0, 2)
    .map((g) => {
      const metric = metricWords(g.target_metric);
      const target = g.target_value == null ? null : Number(g.target_value);
      const current = g.current_value == null ? null : Number(g.current_value);
      const trusted = numberTrusted(g, today);
      const progress = trajectoryOf(g, today).progress;
      const stale = current != null && !trusted ? staleWords(g, today) : "";
      let due: string | null = null;
      if (g.due_date) {
        const left = Math.round((Date.parse(`${g.due_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
        due = left < 0 ? "past its due date" : left === 0 ? "due today" : `${left} day${left === 1 ? "" : "s"} left`;
      }
      const pace = projectedAtDue(g, today);
      const money = goalValueMoney(g.target_metric, target);
      const unit = target == null ? ` ${metric}` : withUnit(goalUnitWords(g.target_metric, target));
      return {
        title: goalLabel(g.objective),
        current: current == null ? null : `${goalNum(current, money)}${target == null ? "" : ` of ${goalNum(target, money)}`}${unit}${stale}`,
        not_counted: current == null ? "Not counted yet" : null,
        target: target == null ? null : `target ${goalNum(target, money)}`,
        progress,
        due,
        pace: pace == null ? null : `on pace for about ${goalNum(pace, money)} by ${humanDate(g.due_date)}`,
        founder_estimate: current == null ? founderEstimateFor(g, founderCustomers) : null,
        ...goalVerdict(g, today, metric, target, pace, due, tz),
      };
    });
}

function goalVerdict(g: GoalRow, today: string, metric: string, target: number | null, pace: number | null, due: string | null, tz: string = "UTC"): Pick<NoteGoalView, "verdict" | "tone" | "aim" | "source"> {
  const by = g.due_date ? ` by ${humanDate(g.due_date)}` : "";
  const money = goalValueMoney(g.target_metric, target);
  const unit = goalUnitWords(g.target_metric, target);
  const aim = target == null ? goalLabel(g.objective) : `${goalNum(target, money)}${withUnit(unit)}${by}`;
  const typed = g.measurement_mode !== "auto" && !confirmedRule(g.count_rule);
  const at = enteredDay(g.current_value_at, tz);
  const source = typed && g.current_value != null && at ? `From the ${goalNum(Number(g.current_value), money)} you entered ${humanDate(at)}.` : null;
  if (pace == null || target == null) return { verdict: null, tone: null, aim, source };
  const p = Math.round(pace);
  const line = trajectoryOf(g, today).line;
  const lower = line ? line.target < line.start_value : false;
  const gap = Math.round(lower ? p - target : target - p);
  const left = due && /left$/.test(due) ? `, ${due}` : "";
  const lead = unit === metric ? `${metric.charAt(0).toUpperCase()}${metric.slice(1)} is on pace for about ${goalNum(p, money)}` : `On pace for about ${goalNum(p, money)}${withUnit(unit)}`;
  const verdict = gap > 0
    ? `${lead}${by}: about ${goalNum(gap, money)} ${lower ? "over your" : "short of"} ${goalNum(target, money)}${lower ? " target" : ""}${left}.`
    : `${lead}${by}, at or past your ${goalNum(target, money)} target${left}.`;
  return { verdict, tone: gap > 0 ? "short" : "on_pace", aim, source };
}

export function isGoalSawLine(line: string, goals: GoalRow[], changed: readonly string[] = []): boolean {
  const names = [
    ...goals.map((g) => g.objective),
    ...changed.flatMap((c) => /^Goal "(.+?)": now /.exec(c)?.[1] ?? []),
  ].flatMap((n) => [n, goalLabel(n)]);
  return names.some((n) => line.startsWith(`${n}: `));
}

export function sawLines(goals: GoalRow[], channels: ChannelView[], founder: FounderView, today: string): string[] {
  const out: string[] = [];
  for (const g of goals.filter((x) => !endedReason(x, today)).slice(0, 2)) out.push(`${goalLabel(g.objective)}: ${statusLineFor(g, today)}.`);
  const names = new Map<string, string>(CHANNELS.map((c) => [c.slug, c.name]));
  const waiting = channels
    .filter((c) => c.last_14_days.still_waiting > 0 && (c.oldest_waiting_days ?? 0) >= 5)
    .sort((a, b) => (b.oldest_waiting_days ?? 0) - (a.oldest_waiting_days ?? 0))[0];
  if (waiting && out.length < 3) {
    const n = waiting.last_14_days.still_waiting;
    out.push(`${n} ${names.get(waiting.channel_slug) ?? waiting.channel_slug} card${n === 1 ? "" : "s"} waiting for you, the oldest for ${waiting.oldest_waiting_days} days.`);
  }
  if (founder.days_since_active != null && founder.days_since_active >= 7 && out.length < 3) {
    out.push(`You haven't been in Zavi for ${founder.days_since_active} days.`);
  }
  return out;
}

export function enteredDay(at: string | null | undefined, tz: string = "UTC"): string | null {
  if (!at || !/^\d{4}-\d{2}-\d{2}/.test(at)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  const t = new Date(at);
  return Number.isFinite(t.getTime()) ? dayInZone(t, tz) : at.slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function humanDate(d: string | null): string {
  if (!d) return "no date";
  const [, m, day] = d.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${day}`;
}
function num(n: number | null): string {
  if (n == null) return "none";
  const [whole, frac] = String(Number(n)).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

type GoalAsk = Pick<GoalRow, "objective" | "target_metric" | "target_value" | "due_date">;
function describeGoalChange(from: GoalAsk, to: GoalAsk): string[] {
  const parts: string[] = [];
  if (to.objective !== from.objective) parts.push(`now "${to.objective}"`);
  if (to.target_metric !== from.target_metric) parts.push(`measured by ${to.target_metric}`);
  if (Number(to.target_value) !== Number(from.target_value)) parts.push(`target ${goalNum(from.target_value, goalValueMoney(from.target_metric, from.target_value))} to ${goalNum(to.target_value, goalValueMoney(to.target_metric, to.target_value))}`);
  if (to.due_date !== from.due_date) parts.push(`due ${humanDate(from.due_date)} to ${humanDate(to.due_date)}`);
  return parts;
}

export function planGoalEnds(goals: GoalRow[], today: string, acts: boolean): Array<{ goal: GoalRow; reason: "met" | "due_passed" }> {
  if (!acts) return [];
  const out: Array<{ goal: GoalRow; reason: "met" | "due_passed" }> = [];
  for (const g of goals) {
    const reason = endedReason(g, today);
    if (reason) out.push({ goal: g, reason });
  }
  return out;
}

export type PlannedGoalChange = {
  goal: GoalRow;
  next: GoalAsk;
  metricChanged: boolean;
  patch: Record<string, unknown>;
  line: string;
};

export function heldGoalChangeLine(g: GoalRow, next: GoalAsk, today: string): string {
  const age = numberAgeDays(g, today);
  const reading =
    g.current_value == null
      ? "has no measured number yet"
      : age == null
        ? `shows ${num(g.current_value)}, and I can't tell when that was measured`
        : `shows ${num(g.current_value)}, last measured ${age} day${age === 1 ? "" : "s"} ago`;
  return `I didn't change "${g.objective}" (${describeGoalChange(g, next).join(", ")}): it ${reading}. Is that number right?`;
}

export function planGoalChanges(args: {
  changes: GoalMoves["goal_changes"];
  goals: GoalRow[];
  today: string;
  now: Date;
  run_id: string;
  acts: boolean;
  reviewedRevs?: ReadonlyMap<string, string>;
  tz?: string;
  approved?: boolean;
}): { writes: PlannedGoalChange[]; wouldLines: string[]; held: QuestionAsk[]; refused: string[] } {
  const byId = new Map(args.goals.map((g) => [g.id, g]));
  const planned = new Set<string>();
  const writes: PlannedGoalChange[] = [];
  const wouldLines: string[] = [];
  const held: QuestionAsk[] = [];
  const refused: string[] = [];
  for (const ch of args.changes ?? []) {
    const live = byId.get(ch.goal_id);
    const g = live ? { ...live } : undefined;
    if (!g || planned.has(g.id) || endedReason(g, args.today)) continue;
    if (args.reviewedRevs && args.reviewedRevs.get(g.id) !== goalRev(g)) continue;
    const next = {
      objective: ch.objective?.trim() || g.objective,
      target_metric: ch.target_metric?.trim() || g.target_metric,
      target_value: ch.target_value ?? g.target_value,
      due_date: ch.due_date ?? g.due_date,
    };
    if (next.target_value == null || !(Number(next.target_value) > 0)) continue;
    if (next.due_date && next.due_date < args.today) continue;
    if (goalRev(next) === goalRev(g)) continue;
    const metricChanged = next.target_metric !== g.target_metric;
    const fromSrc = classifyTargetMetric(g.target_metric);
    const toSrc = classifyTargetMetric(next.target_metric);
    const norm = (m: string) => m.toLowerCase().replace(/[_\-./]+/g, " ").replace(/\s+/g, " ").trim();
    const measureChanged =
      fromSrc.kind === "unresolved" && toSrc.kind === "unresolved"
        ? norm(next.target_metric) !== norm(g.target_metric)
        : JSON.stringify(fromSrc) !== JSON.stringify(toSrc);
    const movesTheBar =
      (!measureChanged && Number(next.target_value) !== Number(g.target_value)) ||
      (next.due_date ?? null) !== (g.due_date ?? null);
    const onYes = { kind: "goal_change" as const, goal_id: g.id, goal_rev: goalRev(g), change: goalChangeFields(g, next), why: ch.why.trim().slice(0, 300) };
    if (!args.approved && movesTheBar && !numberTrusted(g, args.today)) {
      held.push({ required: true, topic_key: `goal:${g.id}`, ask: heldGoalChangeLine(g, next, args.today), default_action: null, why: ch.why, on_yes: onYes });
      refused.push(`Goal change on "${g.objective}": its number is not trusted.`);
      planned.add(g.id);
      continue;
    }
    if (!args.approved && easesGoal(g, next, !measureChanged)) {
      held.push({
        required: true,
        topic_key: `goal:${g.id}`,
        ask: easedGoalAsk(g, next, ""),
        default_action: null,
        recommended: "yes",
        why: ch.why,
        on_yes: onYes,
      });
      refused.push(`Goal change on "${g.objective}": it makes the goal easier, so it is the founder's call.`);
      planned.add(g.id);
      continue;
    }
    if (!args.approved && movesTheBar) {
      held.push({
        required: true,
        topic_key: `goal:${g.id}`,
        ask: raisedGoalAsk(g, next, ""),
        default_action: null,
        recommended: "yes",
        why: ch.why,
        on_yes: onYes,
      });
      refused.push(`Goal change on "${g.objective}": it moves the founder's target or date, so it is their call.`);
      planned.add(g.id);
      continue;
    }
    const gate = evaluateUnattended(
      { kind: "goal_change", trigger: "review" },
      { goalChange: { eases: easesGoal(g, next, !measureChanged), movesBar: movesTheBar, numberTrusted: numberTrusted(g, args.today) } },
    );
    if (!args.approved && gate.verdict !== "allow") {
      refused.push(`Goal change on "${g.objective}": left for the founder (${gate.reasons.join(", ")}).`);
      planned.add(g.id);
      continue;
    }
    const line = `Goal "${g.objective}": ${describeGoalChange(g, next).join(", ")}. ${ch.why.trim()}`;
    if (!args.acts && !args.approved) {
      wouldLines.push(line);
      continue;
    }
    const undo = {
      prev: {
        objective: g.objective,
        target_metric: g.target_metric,
        target_value: g.target_value,
        due_date: g.due_date,
        current_value: g.current_value,
        baseline_value: g.baseline_value ?? null,
        measurement_mode: g.measurement_mode,
        measure_source: g.measure_source ?? null,
        value_kind: g.value_kind ?? null,
        value_period_start: g.value_period_start ?? null,
      },
      rev: goalRev(next),
      why: ch.why.trim(),
      at: args.now.toISOString(),
      run_id: args.run_id,
    };
    const rolled = metricChanged || next.due_date === g.due_date ? null : rolledPeriodStart(g, next.due_date);
    const readOn = rolled ? enteredDay(g.current_value_at ?? null, args.tz) : null;
    const dropNumber = rolled != null && (readOn == null || readOn < rolled);
    const patch: Record<string, unknown> = {
      ...next,
      ...(rolled ? { value_period_start: rolled } : {}),
      ...(dropNumber ? { current_value: null, current_value_at: null, current_value_source: null } : {}),
      cgo_undo: undo,
      updated_at: args.now.toISOString(),
      ...(metricChanged
        ? {
            measurement_mode: classifyMetricMode(next.target_metric) === "auto" && canMeasureAutomatically(next.target_metric) ? "auto" : "manual_reported",
            current_value: null,
            baseline_value: null,
            value_kind: null,
            value_period_start: null,
            measure_source: null,
          }
        : {}),
    };
    planned.add(g.id);
    writes.push({ goal: g, next, metricChanged, patch, line });
  }
  return { writes, wouldLines, held, refused };
}

export function easesGoal(g: GoalAsk & Pick<GoalRow, "baseline_value" | "current_value">, next: GoalAsk, sameMeasure = true): boolean {
  const from = Number(g.target_value);
  const to = Number(next.target_value);
  if (sameMeasure && Number.isFinite(from) && Number.isFinite(to) && to !== from) {
    const ref = g.baseline_value != null ? Number(g.baseline_value) : g.current_value != null ? Number(g.current_value) : null;
    if (ref == null || ref === from) return true;
    const lowerIsBetter = from < ref;
    if (lowerIsBetter ? to > from : to < from) return true;
  }
  if (g.due_date && next.due_date && next.due_date > g.due_date) return true;
  if (g.due_date && !next.due_date) return true;
  return false;
}

export function raisedGoalAsk(g: GoalAsk, next: GoalAsk, why: string): string {
  return cutAtSentence(`Should I raise the bar on "${g.objective}" (${describeGoalChange(g, next).join(", ")})? ${why.trim()}`.trim(), 400);
}

export function easedGoalAsk(g: GoalAsk, next: GoalAsk, why: string): string {
  return cutAtSentence(`Should I make "${g.objective}" easier (${describeGoalChange(g, next).join(", ")})? ${why.trim()}`.trim(), 400);
}

function goalChangeFields(g: GoalAsk, next: GoalAsk): GoalChangeFields {
  return {
    ...(next.objective !== g.objective ? { objective: next.objective } : {}),
    ...(next.target_metric !== g.target_metric ? { target_metric: next.target_metric } : {}),
    ...(next.target_value !== g.target_value && next.target_value != null ? { target_value: Number(next.target_value) } : {}),
    ...(next.due_date !== g.due_date && next.due_date ? { due_date: next.due_date } : {}),
  };
}

export function goalAfterChange(c: PlannedGoalChange): GoalRow {
  return { ...c.goal, ...c.next, ...(c.metricChanged ? { current_value: null, baseline_value: null } : {}) };
}

export function planOpenCards(
  openRows: Array<{ id: string; body: Record<string, unknown> | null }>,
  goalsById: ReadonlyMap<string, GoalRow>,
): Array<{ id: string; key: string; expire: boolean }> {
  return openRows.map((row) => {
    const gid = String(row.body?.goal_id ?? "");
    const g = goalsById.get(gid);
    return {
      id: row.id,
      key: `${gid}:${String(row.body?.target_agent_slug ?? "")}`,
      expire: !g || row.body?.goal_rev !== goalRev(g),
    };
  });
}

export type PlannedGoalCards = {
  goal: GoalRow;
  statusLine: string;
  cards: Array<{ target: string; body: Record<string, unknown>; note?: { action?: string; why?: string } }>;
};

export function planGoalCards(args: {
  liveGoals: GoalRow[];
  moves: GoalMoves;
  changedGoals: ReadonlySet<string>;
  acts: boolean;
  reviewedRevs?: ReadonlyMap<string, string>;
  allowed: ReadonlySet<string>;
  locked?: readonly PlanLocked[];
  openKeys: ReadonlySet<string>;
  recentKeys?: ReadonlySet<string>;
  answerKeys?: ReadonlySet<string>;
  gate?: (goal: GoalRow, move: GoalMoves["goals"][number]["moves"][number], target: string) => import("./cgo-hypotheses").GateResult;
  gateShadow?: (line: string, code: import("./cgo-hypotheses").GateCode) => void;
  rejectedOrders?: readonly RejectedOrder[];
  repo: { repo: string } | null | "unresolved";
  today: string;
  openAdvice?: ReadonlyMap<string, AdviceCard[] | "unreadable">;
  evidence?: CgoEvidence | null;
  spareDailyCapacityUsd?: number | null;
  deliveryDebtHigh?: boolean;
}): { needsRepo: true } | { needsRepo: false; goals: PlannedGoalCards[]; refused: string[]; asks: QuestionAsk[]; advice: string[] } {
  const refused: string[] = [];
  const advice: string[] = [];
  const asks: QuestionAsk[] = [];
  const reviewed = new Map(args.moves.goals.map((x) => [x.goal_id, x]));
  const openKeys = new Set(args.openKeys);
  const out: PlannedGoalCards[] = [];
  let emitted = 0;
  let dailyUsdTaken = 0;
  for (const g of args.liveGoals) {
    const review = reviewed.get(g.id);
    if (!review) continue;
    const changedNow = args.changedGoals.has(g.id);
    if (!changedNow && args.reviewedRevs && args.reviewedRevs.get(g.id) !== goalRev(g)) continue;
    let statusLine = statusLineFor(g, args.today);
    const cards: PlannedGoalCards["cards"] = [];

    let perGoal = 0;
    const perGoalCap = goalPace(g, args.today).behind_required ? MAX_MOVES_PER_GOAL_BEHIND : MAX_MOVES_PER_GOAL;
    if (!args.acts && !changedNow) {
      for (const mv of review.moves.slice(0, perGoalCap)) {
        const why = cleanReason(mv.why);
        advice.push(`${agentName(mv.target_agent_slug.trim())}: ${itemText(mv.action, mv.intent)}${why ? `. ${why}` : ""}`);
      }
    }
    for (const mv of changedNow || !args.acts ? [] : review.moves) {
      if (perGoal >= perGoalCap || emitted >= MAX_NEW_CARDS_PER_RUN) break;
      const target = mv.target_agent_slug.trim();
      if (!args.allowed.has(target) && args.locked?.some((l) => l.agent === target)) {
        refused.push(`Work for ${target} on "${g.objective}": ${PLAN_LOCKED_REASON}.`);
        continue;
      }
      if (!args.allowed.has(target)) {
        refused.push(`Work for ${target} on "${g.objective}": not an agent you can hand work to right now.`);
        continue;
      }
      const adTarget = CGO_AD_CHANNELS.has(target);
      if (openKeys.has(adTarget ? adOrderKey(g.id, target, mv.intent) : `${g.id}:${target}`)) {
        refused.push(`Work for ${target} on "${g.objective}": ${OPEN_CARD_WAITING}.`);
        continue;
      }
      const gated = args.gate?.(g, mv, target);
      let wouldRefuse: import("./cgo-hypotheses").GateCode | undefined;
      if (gated && !gated.ok) {
        const line = `Work for ${target} on "${g.objective}": ${gated.reason}.`;
        if (args.gateShadow) {
          args.gateShadow(line, gated.code);
          wouldRefuse = gated.code;
        } else {
          refused.push(line);
          continue;
        }
      }
      const advice = args.openAdvice?.get(target);
      if (advice === "unreadable") {
        refused.push(`Work for ${target} on "${g.objective}": its open cards could not be read, so nothing started.`);
        continue;
      }
      const named = advice?.find((c) => textNamesCard(mv.intent, c));
      if (named) {
        refused.push(`Work for ${target} on "${g.objective}": ${OPEN_CARD_NAMED} "${named.title}".`);
        continue;
      }
      const held = cutHeldByEvidence({ target, intent: mv.intent, why: mv.why, evidence: args.evidence });
      if (held) {
        const what = held.object ? `"${cutAtWord(held.object, 80)}"` : "it";
        refused.push(`Cut for ${target} on "${g.objective}": not judged yet, ${what}: ${held.reasons.map((r) => CUT_HOLD_WORDS[r]).join("; ")}.`);
        continue;
      }
      const rej = args.rejectedOrders?.length
        ? repeatsRejected({ target, goal_id: g.id, intent: mv.intent }, { current_value: g.current_value, rev: goalRev(g) }, args.rejectedOrders)
        : null;
      if (rej) {
        refused.push(`Work for ${target} on "${g.objective}": ${target} rejected this order (${cutAtWord(rej.reason, 160)}) and nothing has changed since.`);
        continue;
      }
      const recent = adTarget ? !args.deliveryDebtHigh && !!args.recentKeys?.has(adRepeatKey(g.id, target, mv.problem, mv.intent)) : !!args.recentKeys?.has(repeatKey(g.id, target, mv.problem));
      if (recent && !args.answerKeys?.has(`${g.id}:${target}`)) {
        refused.push(`Work for ${target} on "${g.objective}": it already ran on this problem this week; wait for its result.`);
        continue;
      }

      let budgetLine: string | undefined;
      let claimUsd = 0;
      if (CGO_AD_CHANNELS.has(target) && args.spareDailyCapacityUsd != null) {
        const left = Math.max(0, Math.floor((args.spareDailyCapacityUsd - dailyUsdTaken) * 100) / 100);
        if (typeof mv.daily_usd === "number" && mv.daily_usd > left) {
          refused.push(`Work for ${target} on "${g.objective}": it asked for $${mv.daily_usd}/day of new ads and only $${Math.floor(left)}/day fits this month.`);
          continue;
        }
        claimUsd = typeof mv.daily_usd === "number" ? mv.daily_usd : left;
        budgetLine = `New daily ad budget for this order, all new ad sets together: at most $${claimUsd}.`;
      }

      let repo_hint: string | undefined;
      if (target === "engineer") {
        if (args.repo === "unresolved") return { needsRepo: true };
        if (!args.repo) {
          if (!statusLine.includes(NO_REPO_NOTE)) statusLine = `${statusLine} ${NO_REPO_NOTE}`;
          continue;
        }
        repo_hint = args.repo.repo;
      }

      cards.push({
        target,
        body: {
          target_agent_slug: target,
          intent: mv.intent.trim().slice(0, 2000),
          dispatched_by: "cgo",
          source_agent: "cgo",
          goal_id: g.id,
          goal_rev: goalRev(g),
          ...(mv.why ? { context_summary: mv.why.trim().slice(0, 500) } : {}),
          problem: mv.problem ?? "unspecified",
          ...(mv.moves_metric ? { moves_metric: mv.moves_metric } : {}),
          ...(mv.boundaries || budgetLine ? { boundaries: [budgetLine, mv.boundaries].filter(Boolean).join(" ") } : {}),
          ...(mv.expected_output ? { expected_output: mv.expected_output } : {}),
          ...(repo_hint ? { repo_hint } : {}),
          ...(gated?.hypothesis_id ? { hypothesis_id: gated.hypothesis_id } : {}),
          ...(wouldRefuse ? { gate_would_refuse: wouldRefuse } : {}),
          ...(gated?.ok && typeof mv.expected_gain === "number" ? { expected_gain: mv.expected_gain } : {}),
          ...(mv.test
            ? { test: clampTest(mv.test, args.today) }
            : mv.no_test_because
              ? { test_exempt: mv.no_test_because }
              : { test_missing: true }),
        },
        note: { ...(mv.action ? { action: mv.action } : {}), ...(mv.why?.trim() ? { why: mv.why.trim() } : {}) },
      });
      openKeys.add(`${g.id}:${target}`);
      if (adTarget) openKeys.add(adOrderKey(g.id, target, mv.intent));
      dailyUsdTaken += claimUsd;
      perGoal++;
      emitted++;
    }
    out.push({ goal: g, statusLine, cards });
  }
  return { needsRepo: false, goals: out, refused, asks, advice };
}

export type AdviceCard = { id: string; title: string; refs: SubjectRefs };

export function shouldProposeNextGoal(acts: boolean, endedCount: number, moves: GoalMoves, suggestionWaiting: boolean): boolean {
  return acts && endedCount > 0 && !!moves.next_goal && !suggestionWaiting;
}

export function planChannelPauses(
  changes: GoalMoves["channel_changes"],
  acts: boolean,
  neverApproved: ReadonlySet<string> = new Set(),
  founderOwned: ReadonlySet<string> = new Set(),
  rejected: ReadonlySet<string> = new Set(),
): { pauses: Array<{ slug: string; name: string; why: string }>; wouldLines: string[]; asks: QuestionAsk[] } {
  const names = new Map<string, string>(CHANNELS.map((c) => [c.slug, c.name]));
  const seen = new Set<string>();
  const pauses: Array<{ slug: string; name: string; why: string }> = [];
  const wouldLines: string[] = [];
  const asks: QuestionAsk[] = [];
  for (const cc of changes ?? []) {
    const slug = cc.channel_slug.trim();
    const name = names.get(slug);
    if (!name || seen.has(slug)) continue;
    seen.add(slug);
    if (rejected.has(slug)) {
      asks.push({
        required: true,
        topic_key: `channel:${slug}`,
        ask: `You've been rejecting the ${name} cards. Should I keep ${name} running with a different approach, or stop it?`,
        default_action: null,
      });
      continue;
    }
    if (neverApproved.has(slug)) {
      asks.push({
        required: true,
        topic_key: `channel:${slug}`,
        ask: `None of the ${name} posts have been approved yet, so it hasn't really been tried. Keep it running, or pause it?`,
        default_action: acts && !founderOwned.has(slug) && !CGO_AD_CHANNELS.has(slug) ? { kind: "pause_channel", channel_slug: slug, why: `No ${name} post was approved.` } : null,
      });
      continue;
    }
    if (!acts) wouldLines.push(`Pause ${name}. ${cc.why.trim()}`);
    else pauses.push({ slug, name, why: cc.why.trim() });
  }
  return { pauses, wouldLines, asks };
}

export async function clearCgoPauseReasons(tenant_id: string, channel_slug?: string): Promise<void> {
  try {
    let q = tenantClient(asTenantId(tenant_id))
      .from("tenant_channels")
      .update({ cgo_reason: null, cgo_set_at: null, cgo_run_id: null })
      .eq("tenant_id", tenant_id)
      .not("cgo_reason", "is", null);
    if (channel_slug) q = q.eq("channel_slug", channel_slug);
    const { error } = await q;
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn(`[goal-owner] clearing pause reasons for ${tenant_id} failed: ${(e as Error).message}`);
  }
}

export function pauseOutcomeLine(
  outcome: string,
  p: { name: string; why: string },
): { changed?: string; need?: string; refused?: string } {
  if (outcome === "ok") return { changed: `Paused ${p.name}. ${p.why}` };
  if (outcome === "founder_owned") return { need: `${p.name}: ${p.why} You added it, so I left it running. Pause it if you agree.` };
  if (outcome === "founder_stopped") return {};
  return { refused: `Pause ${p.name}: the pause did not go through.` };
}

export function planModelQuestions(args: {
  moves: GoalMoves;
  goals: GoalRow[];
  today: string;
  acts: boolean;
  reviewedRevs?: ReadonlyMap<string, string>;
  rejected?: ReadonlySet<string>;
  neverApproved?: ReadonlySet<string>;
  adPlan?: { left_usd: number; days_left: number; margin: number; connected: readonly string[] };
}): { asks: QuestionAsk[]; refused: string[] } {
  const asks: QuestionAsk[] = [];
  const refused: string[] = [];
  const known = new Set<string>(CHANNELS.map((c) => c.slug));
  const byId = new Map(args.goals.map((g) => [g.id, g]));
  for (const q of args.moves.note?.questions ?? []) {
    if (asksFounderForNumber(q.ask)) {
      refused.push(`Question "${q.topic}" dropped: never ask the founder for a number or to connect a tool so Zavi can count. The goal shows "Not counted yet".`);
      continue;
    }
    if (q.ad_plan && args.adPlan) {
      const a = adPlanQuestion(q, args.goals, args.today, args.adPlan, byId);
      if (a) asks.push(a);
      continue;
    }
    let def: DefaultAction | null = null;
    const d = q.if_no_answer;
    if (d && args.acts) {
      if (d.action === "pause_channel") {
        const slug = d.channel_slug.trim();
        if (known.has(slug) && !args.rejected?.has(slug) && !CGO_AD_CHANNELS.has(slug) && args.neverApproved?.has(slug)) {
          def = { kind: "pause_channel", channel_slug: slug, why: q.ask.trim().slice(0, 300) };
        }
      }
      if (!def) refused.push(`Default for "${q.topic}" dropped: cgo may only pause an untried non-ad channel on silence, never change a goal.`);
    }
    asks.push({
      topic_key: questionTopic(q, known, byId),
      ask: q.ask,
      default_action: def,
      days: q.by_days,
      ...(q.recommended ? { recommended: q.recommended } : {}),
      ...(q.why ? { why: q.why } : {}),
    });
  }
  for (const line of args.moves.note?.need ?? []) {
    if (asksFounderForNumber(line)) refused.push(`Question dropped: "${line}" asks the founder for a number or a connection (Ravi 2026-10-29).`);
    else asks.push({ topic_key: line, ask: line, default_action: null });
  }
  return { asks, refused };
}

async function adPlanContext(tenant_id: string, moves: GoalMoves, today: string): Promise<{ left_usd: number; days_left: number; margin: number; connected: string[] } | undefined> {
  if (!(moves.note?.questions ?? []).some((q) => q.ad_plan)) return undefined;
  const { adsNoFrictionEnabled } = await import("./ads-no-friction-flag");
  if (!(await adsNoFrictionEnabled())) return undefined;
  const { readActiveAdBudget } = await import("@/services/decisions/ad-budget");
  let budget: ActiveAdBudget | null;
  try {
    budget = await readActiveAdBudget(tenant_id);
  } catch {
    return undefined;
  }
  const { readConnectedAdChannels } = await import("./ad-plan-yes");
  const connected = await readConnectedAdChannels(tenant_id);
  const end = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1));
  const daysLeft = Math.round((end.getTime() - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return budget
    ? { left_usd: budget.left_usd, days_left: budget.days_left, margin: budgetMargin(budget), connected }
    : { left_usd: Number.POSITIVE_INFINITY, days_left: daysLeft, margin: 1, connected };
}

export function adPlanQuestion(
  q: { ad_plan?: { channel_slug: string; amount_usd: number }; about?: string; why?: string },
  goals: readonly GoalRow[],
  today: string,
  ctx: { left_usd: number; days_left: number; margin: number; connected: readonly string[] },
  byId: ReadonlyMap<string, GoalRow>,
): QuestionAsk | null {
  const goal = (q.about ? byId.get(q.about.trim()) : undefined) ?? goals.find((g) => g.status === "active" && endedReason(g, today) === null);
  if (!q.ad_plan || !goal) return null;
  const r = shapeAdPlan({ want_usd: q.ad_plan.amount_usd, preferred: q.ad_plan.channel_slug.trim(), connected: ctx.connected, left_usd: ctx.left_usd, days_left: ctx.days_left, margin: ctx.margin, today });
  if (r.kind === "none") return { topic_key: "ad_plan:none", ask: noFitNote(r), default_action: null };
  const onYes = { kind: "ad_plan" as const, goal_id: goal.id, goal_rev: goalRev(goal), plan: r.plan };
  return {
    topic_key: `ad_plan:${r.plan.channel_slug}`,
    ask: adPlanAsk(r.plan),
    default_action: null,
    recommended: "yes",
    ...(q.why ? { why: q.why } : {}),
    on_yes: onYes,
  };
}

export function questionTopic(
  q: { topic: string; about?: string; if_no_answer?: { action: string; channel_slug?: string; goal_id?: string } },
  channels: ReadonlySet<string>,
  goals: ReadonlyMap<string, unknown>,
): string {
  const d = q.if_no_answer;
  if (d?.action === "pause_channel" && d.channel_slug && channels.has(d.channel_slug.trim())) return `channel:${d.channel_slug.trim()}`;
  if (d?.action === "goal_change" && d.goal_id && goals.has(d.goal_id)) return `goal:${d.goal_id}`;
  const about = (q.about ?? "").trim();
  if (channels.has(about)) return `channel:${about}`;
  if (goals.has(about)) return `goal:${about}`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(about)) return `action:${about.toLowerCase()}`;
  if (/^ad[\s_-]?budget$/i.test(about)) return "ad_budget";
  return q.topic;
}

export function questionNoteLine(ask: string, defaultLine: string | null, why?: string | null): string {
  const w = why?.replace(/\s+/g, " ").trim() ?? "";
  const full = w && !ask.includes(w) ? `${w}${/[.!?…]$/.test(w) ? "" : "."} ${ask}` : ask;
  const d = defaultLine?.trim() ? cutAtWord(defaultLine, 200) : "";
  return d ? `${cutKeepingQuestion(full, 400 - d.length - 1)} ${d}` : cutKeepingQuestion(full, 400);
}

export { cutKeepingQuestion } from "./question-text";
import { cutKeepingQuestion } from "./question-text";
import { adPlanAsk, noFitNote, shapeAdPlan } from "./ad-plan-shape";

export function planNote(args: {
  meta: ReviewMeta;
  moves: GoalMoves;
  saw: string[];
  changedLines: string[];
  wouldLines: string[];
  needLines: string[];
  leftLines?: string[];
  refused: string[];
  now: Date;
  reviewDays: number;
  items?: NoteItem[] | null;
  headline?: string | null;
}) {
  const acts = args.meta.autopilot;
  const body = {
    changed: args.changedLines.map((l) => cutAtSentence(l, 400)),
    would_change: args.wouldLines.slice(0, 5).map((l) => cutAtSentence(l, 400)),
    need: [...args.needLines.map((l) => cutAtWord(l, 400)), ...(args.leftLines ?? []).slice(0, MAX_LEFT_LINES)],
  };
  const questions = body.need.slice(0, args.needLines.length);
  const items = args.items?.length ? args.items.map(({ approved: _a, ...i }) => i) : null;
  const behind = args.meta.behind_pace === true || args.meta.behind_required_near === true;
  const idleAgain = args.meta.prev_idle && !isNoteVisible({ ...body, items }) && !behind;
  const days = idleAgain
    ? IDLE_BACKOFF_DAYS
    : acts
      ? behind
        ? args.reviewDays
        : Math.max(args.reviewDays, ON_PACE_MIN_REVIEW_DAYS)
      : ADVICE_ONLY_REVIEW_DAYS;
  return {
    kind: args.meta.kind,
    saw: args.saw.slice(0, 3).map((l) => cutAtSentence(l, 300)),
    ...body,
    questions,
    items,
    headline: items && args.headline ? args.headline.slice(0, 200) : null,
    refused: args.refused.slice(0, 20).map((l) => l.slice(0, 300)),
    alarm_keys: acts ? args.meta.alarm_keys : [],
    next_review_at: new Date(args.now.getTime() + days * 86_400_000).toISOString(),
    next_review_why: idleAgain
      ? "Nothing new in the last two check-ins."
      : acts
        ? args.moves.next_review_why?.trim().slice(0, 300) || null
        : null,
  };
}

async function writeGoalChange(tenant_id: string, c: PlannedGoalChange, run_id: string): Promise<boolean> {
  const g = c.goal;
  const why = String((c.patch.cgo_undo as { why?: unknown } | undefined)?.why ?? "").trim() || c.line;
  const w = await writeAutopilotGoal(tenant_id, {
    op: "update",
    goal_id: g.id,
    values: c.patch,
    expect: {
      status: "active",
      objective: g.objective,
      target_metric: g.target_metric,
      target_value: g.target_value ?? null,
      due_date: g.due_date ?? null,
    },
    actor: { source: "cgo", run_id, why },
  });
  if (w.status !== "written") {
    if (w.status === "error") console.warn(`[goal-owner] goal change failed for ${g.id}: ${w.error}`);
    return false;
  }
  return true;
}

export async function applyApprovedGoalChange(
  tenant_id: string,
  run_id: string,
  a: OnYes,
  now: Date,
): Promise<string | null> {
  if (a.kind !== "goal_change") return null;
  const goals = await loadActiveGoals(tenant_id);
  const g = goals.find((x) => x.id === a.goal_id);
  if (!g || goalRev(g) !== a.goal_rev) return null;
  const tz = await goalTimeZone(tenant_id);
  const plan = planGoalChanges({
    changes: [{ goal_id: g.id, ...a.change, why: a.why }],
    goals: [g],
    tz,
    today: dayInZone(now, tz),
    now,
    run_id,
    acts: true,
    approved: true,
    reviewedRevs: new Map([[g.id, a.goal_rev]]),
  });
  const c = plan.writes[0];
  if (!c || !(await writeGoalChange(tenant_id, c, run_id))) return null;
  return `Goal "${c.goal.objective}": ${describeGoalChange(c.goal, c.next).join(", ")}.`;
}

const LIVE_AD_CLASSES: ReadonlySet<string> = new Set([
  "chatgpt_ads.create_and_launch",
  "chatgpt_ads.update_campaign_budget",
  "meta_ads.update_ad_set_budget",
  "meta_ads.update_campaign_budget",
  "google_ads.update_campaign_budget",
  "meta_ads.duplicate_ad_set",
  "meta_ads.duplicate_campaign",
  "meta_ads.create_ad",
  "meta_ads.launch_campaign",
  "google_ads.create_campaign",
  "google_ads.create_ad",
  "reddit_ads.launch_campaign",
]);

export function producedLiveAd(exec_class: string | null | undefined, payload: unknown): boolean {
  if (!exec_class) return false;
  if (LIVE_AD_CLASSES.has(exec_class)) return true;
  if (/^(meta_ads|google_ads|chatgpt_ads)\.set_status(_review)?$/.test(exec_class) || exec_class === "reddit_ads.set_object_status") {
    const st = String((payload as { status?: unknown } | null)?.status ?? "").toUpperCase();
    return st === "ACTIVE" || st === "ENABLED";
  }
  return false;
}

const NO_RUN_GRACE_MS = 2 * 3_600_000;

export function ordersWithoutLiveAd(args: {
  orders: ReadonlyArray<{ id: string; approved_at: string | null }>;
  runs: ReadonlyArray<{ id: string; status: string; source_decision_id: string | null }>;
  live: ReadonlySet<string>;
  now: Date;
}): Set<string> {
  const out = new Set<string>();
  for (const o of args.orders) {
    const runs = args.runs.filter((r) => r.source_decision_id === o.id);
    if (runs.some((r) => args.live.has(r.id))) continue;
    if (runs.length === 0) {
      const t = o.approved_at ? Date.parse(o.approved_at) : NaN;
      if (Number.isFinite(t) && args.now.getTime() - t >= NO_RUN_GRACE_MS) out.add(o.id);
      continue;
    }
    if (runs.every((r) => TERMINAL_RUN_STATUSES.includes(r.status))) out.add(o.id);
  }
  return out;
}

async function readOrdersWithoutLiveAd(
  tenant_id: string,
  orders: ReadonlyArray<{ id: string; approved_at: string | null }>,
  now: Date,
): Promise<Set<string>> {
  if (orders.length === 0) return new Set();
  const svc = tenantClient(asTenantId(tenant_id));
  const { data: runRows, error: runErr } = await svc
    .from("agent_runs")
    .select("id, status, payload")
    .eq("tenant_id", tenant_id)
    .in("payload->>source_decision_id", orders.map((o) => o.id))
    .limit(200);
  if (runErr) throw new Error(`goal-owner: order runs read failed: ${runErr.message}`);
  const runs = ((runRows ?? []) as Array<{ id: string; status: string; payload: Record<string, unknown> | null }>).map((r) => ({
    id: r.id,
    status: r.status,
    source_decision_id: typeof r.payload?.source_decision_id === "string" ? r.payload.source_decision_id : null,
  }));
  const live = new Set<string>();
  const runIds = runs.map((r) => r.id);
  if (runIds.length) {
    const [acts, decs] = await Promise.all([
      svc
        .from("channel_actions")
        .select("run_id, exec_class, exec_payload")
        .eq("tenant_id", tenant_id)
        .in("run_id", runIds)
        .eq("exec_status", "executed")
        .limit(500),
      svc
        .from("decisions")
        .select("agent_run_id, decision_class, body")
        .eq("tenant_id", tenant_id)
        .in("agent_run_id", runIds)
        .eq("status", "acted")
        .limit(500),
    ]);
    if (acts.error) throw new Error(`goal-owner: order actions read failed: ${acts.error.message}`);
    if (decs.error) throw new Error(`goal-owner: order decisions read failed: ${decs.error.message}`);
    for (const a of (acts.data ?? []) as Array<{ run_id: string; exec_class: string | null; exec_payload: unknown }>) {
      if (producedLiveAd(a.exec_class, a.exec_payload)) live.add(a.run_id);
    }
    for (const d of (decs.data ?? []) as Array<{ agent_run_id: string | null; decision_class: string; body: unknown }>) {
      if (d.agent_run_id && producedLiveAd(d.decision_class, d.body)) live.add(d.agent_run_id);
    }
  }
  return ordersWithoutLiveAd({ orders, runs, live, now });
}

export const LEGACY_AD_DECISION_STALE_DAYS = 7;
const MAX_LEGACY_AD_DECISIONS = 10;

export type LegacyAdDecision = {
  id: string;
  decision_class: string;
  body: unknown;
  emitted_at: string | null;
  agent_run_id: string | null;
};

export function legacyDecisionKey(d: LegacyAdDecision): string {
  const b = (d.body ?? {}) as Record<string, unknown>;
  const ids = refsFromText(JSON.stringify(b)).ids;
  const name = typeof b.name === "string" ? b.name.trim().toLowerCase() : "";
  const verb = (d.decision_class.split(".")[1] ?? "").replace(/_review$/, "");
  if (/^create_/.test(verb) && name) return `${d.decision_class}:n:${name}`;
  const obj = ["object_id", "ad_group_id", "ad_set_id", "source_ad_set_id", "source_campaign_id", "campaign_id"].map((k) => b[k]).find((v) => typeof v === "string" && v);
  if (obj) return `${d.decision_class}:${obj}`;
  if (name) return `${d.decision_class}:n:${name}`;
  return `${d.decision_class}:${ids.sort().join(",")}`;
}

export function planLegacyAdDecisions(rows: readonly LegacyAdDecision[], now: Date): Array<{ row: LegacyAdDecision; act: "approve" } | { row: LegacyAdDecision; act: "withdraw"; why: "duplicate" | "stale" }> {
  const out: Array<{ row: LegacyAdDecision; act: "approve" } | { row: LegacyAdDecision; act: "withdraw"; why: "duplicate" | "stale" }> = [];
  const seen = new Set<string>();
  const sorted = [...rows].sort((a, b) => String(b.emitted_at ?? "").localeCompare(String(a.emitted_at ?? "")));
  for (const row of sorted) {
    const origin = (row.body as { origin?: unknown } | null)?.origin;
    if (origin === "user_initiated_chat" || origin === "user_initiated_ledger") continue;
    const key = legacyDecisionKey(row);
    if (seen.has(key)) {
      out.push({ row, act: "withdraw", why: "duplicate" });
      continue;
    }
    seen.add(key);
    const t = row.emitted_at ? Date.parse(row.emitted_at) : NaN;
    if (Number.isFinite(t) && now.getTime() - t > LEGACY_AD_DECISION_STALE_DAYS * DAY_MS) {
      out.push({ row, act: "withdraw", why: "stale" });
      continue;
    }
    out.push({ row, act: "approve" });
  }
  return out.slice(0, MAX_LEGACY_AD_DECISIONS);
}

const LEGACY_WITHDRAW_WHY = {
  duplicate: "a newer proposal for the same change is waiting",
  stale: "it waited more than a week and the account has changed since",
  card: "a newer card about the same campaign is waiting for you",
} as const;

function legacyDecisionLabel(d: LegacyAdDecision): string {
  const b = (d.body ?? {}) as Record<string, unknown>;
  const verb = (d.decision_class.split(".")[1] ?? "change").replace(/_review$/, "").replace(/_/g, " ");
  const name = typeof b.name === "string" && b.name.trim() ? ` "${cutAtWord(b.name.trim(), 80)}"` : "";
  return `${execPlatformLabel(d.decision_class)} proposal to ${verb}${name}`;
}

async function workLegacyAdDecisions(
  args: { tenant_id: string; approveAdDecision?: ApplyGoalMovesDeps["approveAdDecision"]; newerOpenCard?: ApplyGoalMovesDeps["newerOpenCard"]; now: Date },
  out: WorkedCards,
): Promise<void> {
  const svc = tenantClient(asTenantId(args.tenant_id));
  const reads = await Promise.all(
    ["meta_ads.%", "google_ads.%", "chatgpt_ads.%"].map((pattern) =>
      svc
        .from("decisions")
        .select("id, decision_class, body, emitted_at, agent_run_id")
        .eq("tenant_id", args.tenant_id)
        .eq("status", "proposed")
        .like("decision_class", pattern)
        .order("emitted_at", { ascending: false })
        .limit(25),
    ),
  );
  if (reads.some((r) => r.error)) {
    console.warn(`[goal-owner] proposed ad decisions unreadable for ${args.tenant_id}; none worked this review`);
    return;
  }
  const { adShape } = await import("./unattended-policy");
  const rows = reads
    .flatMap((r) => (r.data ?? []) as LegacyAdDecision[])
    .filter((r) => adShape(r.decision_class, r.body).cls !== "never");
  if (rows.length === 0) return;
  const runIds = [...new Set(rows.map((r) => r.agent_run_id).filter((x): x is string => !!x))];
  const slugs = new Map<string, string>();
  if (runIds.length) {
    const { data } = await svc.from("agent_runs").select("id, agent_slug").eq("tenant_id", args.tenant_id).in("id", runIds);
    for (const r of (data ?? []) as Array<{ id: string; agent_slug: string }>) slugs.set(r.id, r.agent_slug);
  }
  const approve = args.approveAdDecision ?? (await import("./cgo-ads")).cgoApproveAdDecision;
  const newerCard = args.newerOpenCard ?? newerOpenCardFor;
  for (const p of planLegacyAdDecisions(rows, args.now)) {
    const label = legacyDecisionLabel(p.row);
    const withdraw = async (why: keyof typeof LEGACY_WITHDRAW_WHY) => {
      const { data, error } = await svc
        .from("decisions")
        .update({ status: "expired" })
        .eq("id", p.row.id)
        .eq("tenant_id", args.tenant_id)
        .eq("status", "proposed")
        .select("id")
        .maybeSingle();
      if (error || !data) return;
      out.changed.push(`Withdrew the waiting ${label}: ${LEGACY_WITHDRAW_WHY[why]}.`);
      out.items.push({ section: "changed", text: `Withdrew the waiting ${label}`, reason: LEGACY_WITHDRAW_WHY[why] });
    };
    if (p.act === "withdraw") {
      await withdraw(p.why);
      continue;
    }
    if (await newerCard(args.tenant_id, p.row).catch(() => false)) {
      await withdraw("card");
      continue;
    }
    const agent = p.row.agent_run_id ? slugs.get(p.row.agent_run_id) : undefined;
    let heldFor: string[] | null = null;
    if (await approve(args.tenant_id, p.row.id, p.row.decision_class, p.row.body, agent, { onHeld: (r) => (heldFor = r) })) {
      out.changed.push(`Approved the waiting ${label}.`);
      out.items.push({ section: "working_on", text: `Applying: ${label}` });
      out.ad_changed = true;
    } else {
      out.refused.push(`The waiting ${label}: Autopilot's checks left it for the founder.`);
      if (heldFor) {
        const { heldReasonWords } = await import("./unattended-policy");
        const words = heldReasonWords(heldFor);
        const reason = words.length ? words.join("; ") : "my checks did not clear it";
        out.left.push(leftForYouLine(label, reason));
        out.items.push({ section: "needs_you", text: `Left for you: the waiting ${label}`, reason });
      }
    }
  }
}

export async function newerOpenCardFor(tenant_id: string, row: LegacyAdDecision): Promise<boolean> {
  const oa = await import("./open-advice");
  const object = await oa.adObjectFor(tenant_id, row.decision_class, row.body);
  if (object.nameUnknown) return false;
  if (object.ids.length === 0 && !(object.name && oa.normName(object.name).length >= oa.MIN_NAME_CHARS)) return false;
  const rows = await oa.readOpenCards(tenant_id, oa.channelsForAdClass(row.decision_class));
  const cards = oa.contradictingCards(rows, { object, exclude: { action_id: null, run_id: row.agent_run_id ?? null } });
  if (cards.length === 0) return false;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("id, created_at")
    .eq("tenant_id", tenant_id)
    .in("id", cards.map((c) => c.id))
    .limit(20);
  if (error) throw new Error(error.message);
  const since = row.emitted_at ? Date.parse(row.emitted_at) : NaN;
  if (!Number.isFinite(since)) return false;
  return ((data ?? []) as Array<{ created_at: string }>).some((c) => Date.parse(c.created_at) > since);
}

const LEANS_ON_PREVIOUS_RE = /^\s*(?:if|once|when|until|unless|as\s+soon\s+as)\s+(?:it|they|he|she)\b/i;

const REASON_SPLIT_RE = /^(.*?)[,;]?\s+\b(?:because|since|due\s+to)\s+(.+?)\s*([.!]?)\s*$/i;

const asSentence = (text: string, end: string): string => {
  const t = text.trim().replace(/[,;:\s]+$/, "");
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${end || "."}`;
};

function keepReasonOf(sentence: string): string {
  if (!isWorkUnderwaySentence(sentence)) return sentence;
  const m = REASON_SPLIT_RE.exec(sentence.trim());
  if (!m) return sentence;
  const [, head, tail, end] = m;
  const headClaims = isWorkUnderwaySentence(head);
  const tailClaims = isWorkUnderwaySentence(tail);
  if (headClaims && !tailClaims && tail.trim().length >= 3) return asSentence(tail, end);
  if (tailClaims && !headClaims && head.trim().length >= 3) return asSentence(head, end);
  return sentence;
}

export function cardWhyWithoutWorkClaim(why: string, ctx: { tenant_id: string; run_id: string; channel_slug: string }): string {
  if (!why || !hasWorkUnderwayClaim(why)) return why;
  const kept = why
    .split("\n")
    .map((line) => line.split(/(?<=[.!?])\s+/).map(keepReasonOf).join(" "))
    .join("\n");
  let previousRemoved = false;
  const r = removeClaimSentences(kept, (sentence) => {
    const remove = isWorkUnderwaySentence(sentence) || (previousRemoved && LEANS_ON_PREVIOUS_RE.test(sentence));
    previousRemoved = remove;
    return remove;
  });
  if (r.removed > 0 || kept !== why) {
    console.info(`[goal-owner] event=card_work_claim_dropped tenant=${ctx.tenant_id} run=${ctx.run_id} channel=${ctx.channel_slug} sentences=${r.removed}`);
  }
  return r.removed > 0 ? r.text : kept;
}

export async function workChannelCards(args: {
  tenant_id: string;
  run_id: string;
  moves: GoalMoves;
  shown: ReadonlyMap<string, ShownCard> | undefined;
  acts: boolean;
  adBudget: ActiveAdBudget | null;
  goal: GoalRow | null;
  openKeys: Set<string>;
  emitDecision: ApplyGoalMovesDeps["emitDecision"];
  autoRun?: ApplyGoalMovesDeps["autoRun"];
  approveChannelAction?: ApplyGoalMovesDeps["approveChannelAction"];
  evidence?: CgoEvidence | null;
  approveAdDecision?: ApplyGoalMovesDeps["approveAdDecision"];
  newerOpenCard?: ApplyGoalMovesDeps["newerOpenCard"];
  now?: Date;
}): Promise<WorkedCards> {
  const out: WorkedCards = {
    changed: [],
    would: [],
    refused: [],
    asks: [],
    decided: new Set<string>(),
    left: [],
    ad_changed: false,
    items: [],
    blocked: new Set<string>(),
    leftKeys: new Map<string, string>(),
    held: new Set<string>(),
  };
  if (args.acts && args.adBudget) {
    try {
      await workLegacyAdDecisions({ tenant_id: args.tenant_id, approveAdDecision: args.approveAdDecision, newerOpenCard: args.newerOpenCard, now: args.now ?? new Date() }, out);
    } catch (e) {
      console.warn(`[goal-owner] proposed ad decisions not worked for ${args.tenant_id}: ${(e as Error).message}`);
    }
  }
  const wanted = args.moves.channel_cards ?? [];
  if (wanted.length === 0 || !args.shown) return out;
  const seen = new Set<string>();
  const order = { reject: 0, leave: 1, approve: 2 } as const;
  const list = wanted
    .filter((c) => args.shown!.has(c.action_id) && !seen.has(c.action_id) && seen.add(c.action_id));
  const capped = list
    .slice(0, MAX_CARD_DECISIONS)
    .sort((a, b) => order[a.decision] - order[b.decision]);
  const svc = tenantClient(asTenantId(args.tenant_id));
  const name = (slug: string) => CHANNELS.find((c) => c.slug === slug)?.name ?? slug;
  const redispatched = new Set<string>();
  for (const c of capped) {
    const shownOn = args.shown.get(c.action_id)!.channel_slug;
    const why = cardWhyWithoutWorkClaim(c.why.trim(), { tenant_id: args.tenant_id, run_id: args.run_id, channel_slug: shownOn });
    if (!args.acts) {
      if (c.decision !== "leave") out.would.push(`${c.decision === "approve" ? "Approve" : "Reject"} the ${name(shownOn)} card "${args.shown.get(c.action_id)!.title}". ${why}`.trim());
      continue;
    }
    const { data, error } = await svc
      .from("channel_actions")
      .select("id, run_id, channel_slug, title, exec_class, exec_payload, exec_status, exec_result, status, body, proposed_at")
      .eq("id", c.action_id)
      .eq("tenant_id", args.tenant_id)
      .eq("channel_slug", shownOn)
      .eq("status", "pending")
      .maybeSingle();
    if (error) {
      out.refused.push(`${name(shownOn)} card ${c.action_id}: it could not be read, so nothing was done.`);
      continue;
    }
    const row = data as {
      id: string;
      run_id: string | null;
      channel_slug: string;
      title: string;
      exec_class: string | null;
      exec_payload: unknown;
      exec_status: string | null;
      exec_result?: unknown;
      body: unknown;
      proposed_at?: string | null;
    } | null;
    if (!row) {
      out.refused.push(`${name(shownOn)} card ${c.action_id}: it is no longer open.`);
      continue;
    }
    const ch = row.channel_slug;
    const cardTitle = adCardTitle(row);
    const label = `${name(ch)} card "${cutAtWord(cardTitle, 120)}"`;
    const verdict = execVerdictOf(row.exec_status, row.exec_result ?? null);
    const bucket: CardBucket | null = verdict?.bucket ?? null;
    const platform = row.exec_class ? execPlatformLabel(row.exec_class) : name(ch);
    const priced = moneyAtStakeUsd(row.exec_class, row.exec_payload, row.body);
    const usd = c.usd_at_stake ?? (priced ? Math.round(priced.monthly_usd) : null);
    const fixText = bucket === "needs_founder" ? fixWords(verdict!.fix, platform, verdict!.platform_code) : null;
    const leftOutcome: CardOutcome = bucket && bucket !== "blocked_on_us" ? "approve_failed" : "leave";
    const item = (outcome: CardOutcome, itemWhy: string = why) =>
      out.items.push(channelCardNoteItem({ outcome, row, bucket, action: c.action, why: itemWhy, usd, platform, fixText, delivered: row.exec_status === "executed", making: row.exec_status === "queued" || row.exec_status === "dispatching" }));
    const leave = (reason: string) => {
      const line = leftForYouLine(cardTitle, reason);
      out.left.push(line);
      const key = leftCardKey(line);
      if (key !== null) out.leftKeys.set(row.id, key);
      item(leftOutcome, reason);
    };
    if (bucket === "blocked_on_us") {
      out.blocked.add(row.id);
      if (c.decision !== "reject") {
        out.refused.push(`${c.decision === "approve" ? "Approve" : "Leave"} the ${label}: ${platform} refused it; it is ours to fix, nothing for the founder.`);
        item("leave");
        continue;
      }
    }
    if (c.decision === "leave") {
      out.refused.push(`Left the ${label} for the founder.`);
      leave(why);
      continue;
    }
    if (c.decision === "approve" && (bucket === "needs_founder" || bucket === "partial_risk")) {
      out.refused.push(
        bucket === "needs_founder" ? `Approve the ${label}: it needs the founder's fix first.` : `Approve the ${label}: part of it may already be live, so it is never re-run.`,
      );
      const line = leftForYouLine(cardTitle, fixText ? `it needs your fix first: ${fixText}` : "part of it may already be live; check it first");
      out.left.push(line);
      const key = leftCardKey(line);
      if (key !== null) out.leftKeys.set(row.id, key);
      item("approve_failed");
      continue;
    }
    if (!CGO_AD_CHANNELS.has(ch) || !args.adBudget) {
      out.refused.push(`The ${label} waits for the founder: cgo works only ad cards, and only under an ad budget.`);
      leave(CGO_AD_CHANNELS.has(ch) ? "Autopilot has no ad budget to approve it under" : "only you approve what goes out on this channel");
      continue;
    }
    if (c.decision === "reject") {
      const { data: approvals, error: aErr } = await svc
        .from("channel_action_events")
        .select("id")
        .eq("tenant_id", args.tenant_id)
        .eq("action_id", row.id)
        .eq("event", "approved")
        .eq("actor_kind", "founder")
        .limit(1);
      if (aErr || (approvals ?? []).length > 0) {
        out.refused.push(`Reject the ${label}: ${aErr ? "its approvals could not be read" : "the founder approved it"}, so it stays open.`);
        leave(aErr ? "I could not check whether you approved it" : fixText ? `you approved this; it is waiting on you to ${fixText}` : "you approved this, so it stays yours");
        continue;
      }
      const { data: r, error: rErr } = await tenantRpc(asTenantId(args.tenant_id), "set_channel_action", {
        p_tenant_id: args.tenant_id,
        p_action_id: row.id,
        p_status: "rejected",
        p_note: why || "Rejected by Autopilot.",
        p_snoozed_until: null,
        p_event_key: `cgo-reject:${args.run_id}:${row.id}`,
        p_actor_user_id: null,
        p_source: "cgo",
      });
      if (rErr || (r as { ok?: boolean } | null)?.ok !== true) {
        out.refused.push(`Reject the ${label}: it did not go through.`);
        leave("my reject did not go through");
        continue;
      }
      out.decided.add(row.id);
      out.changed.push(`Rejected the ${label}. ${why}`.trim());
      if (CGO_AD_CHANNELS.has(ch)) out.ad_changed = true;
      item(bucket === "blocked_on_us" ? "leave" : "reject");
      continue;
    }
    const { isExecutableAdClass } = await import("./unattended-policy");
    if (row.exec_class && isExecutableAdClass(row.exec_class)) {
      const { findContradictingOpenAdvice, adObjectFor } = await import("./open-advice");
      const check = await findContradictingOpenAdvice({
        tenant_id: args.tenant_id,
        channels: [ch],
        object: await adObjectFor(args.tenant_id, row.exec_class, row.exec_payload),
        exclude: { action_id: row.id, run_id: row.run_id },
        exec: { exec_class: row.exec_class, exec_payload: row.exec_payload },
      });
      if (check.status === "error") {
        out.refused.push(`Approve the ${label}: the channel's other cards could not be read, so it waits for the founder.`);
        leave("I could not check the channel's other cards");
        continue;
      }
      if (check.status === "conflict") {
        const other = check.cards[0];
        out.refused.push(`Approve the ${label}: the channel's open card "${other.title}" names the same object.`);
        continue;
      }
      const approve = args.approveChannelAction ?? (await import("./cgo-ads")).cgoApproveChannelAction;
      let heldFor: string[] | null = null;
      if (!(await approve(args.tenant_id, row.id, { onHeld: (r) => (heldFor = r) }))) {
        out.refused.push(`Approve the ${label}: Autopilot's checks left it for the founder.`);
        if (heldFor) out.held?.add(row.id);
        const { heldReasonWords } = await import("./unattended-policy");
        const words = heldReasonWords(heldFor ?? []);
        leave(words.length ? words.join("; ") : "my checks did not clear it");
        continue;
      }
      out.decided.add(row.id);
      out.changed.push(`Approved the ${label}. ${why}`.trim());
      if (CGO_AD_CHANNELS.has(ch)) out.ad_changed = true;
      item("approve_queued");
      continue;
    }
    const step = ((row.body as { step?: { body?: unknown } } | null)?.step?.body ?? "") as unknown;
    const stepText = typeof step === "string" ? step.replace(/\s+/g, " ").trim() : "";
    const words = channelCardCutHeld({ channel_slug: ch, title: cardTitle, step: stepText }, why, args.evidence);
    if (words) {
      out.refused.push(`Approve the ${label}: not judged yet: ${words}.`);
      leave(words);
      continue;
    }
    if (redispatched.has(ch)) {
      out.refused.push(`Approve the ${label}: one card per channel is sent back each review.`);
      continue;
    }
    const g = args.goal;
    if (!g) {
      out.refused.push(`Approve the ${label}: no live goal to run it under.`);
      leave("there is no live goal to build it under");
      continue;
    }
    if (args.openKeys.has(`${g.id}:${ch}`)) {
      out.refused.push(`Approve the ${label}: a ${ch} card is already waiting.`);
      continue;
    }
    const intent = `Build your own open card "${row.title}" now and propose the exact changes it needs. ${stepText}`.slice(0, 2000);
    const decision_id = await args.emitDecision(CGO_CARD_CLASS, {
      target_agent_slug: ch,
      intent,
      dispatched_by: "cgo",
      source_agent: "cgo",
      goal_id: g.id,
      goal_rev: goalRev(g),
      origin_action_id: row.id,
      ...(why ? { context_summary: why.slice(0, 500) } : {}),
    });
    args.openKeys.add(`${g.id}:${ch}`);
    redispatched.add(ch);
    const autoRun = args.autoRun ?? (await import("./cgo-auto-run")).autoRunCgoCard;
    if (!decision_id || !(await autoRun(args.tenant_id, decision_id))) {
      out.refused.push(`Approve the ${label}: the channel run did not start; the card waits for the founder.`);
      leave(`${name(ch)} could not be started to build it`);
      continue;
    }
    const { data: m, error: mErr } = await tenantRpc(asTenantId(args.tenant_id), "set_channel_action", {
      p_tenant_id: args.tenant_id,
      p_action_id: row.id,
      p_status: "acted",
      p_note: `Autopilot sent this to ${name(ch)} to build.`,
      p_snoozed_until: null,
      p_event_key: `cgo-act:${args.run_id}:${row.id}`,
      p_actor_user_id: null,
      p_source: "cgo",
    });
    if (mErr || (m as { ok?: boolean } | null)?.ok !== true) {
      console.warn(`[goal-owner] marking card ${row.id} acted failed: ${mErr?.message ?? "refused"}`);
    }
    out.decided.add(row.id);
    out.changed.push(`Sent ${name(ch)} its card "${cutAtWord(row.title, 120)}" to build. ${why}`.trim());
    if (CGO_AD_CHANNELS.has(ch)) out.ad_changed = true;
    item("sent_back");
  }
  return out;
}

export type WorkedCards = {
  changed: string[];
  would: string[];
  refused: string[];
  asks: QuestionAsk[];
  decided: Set<string>;
  left: string[];
  ad_changed: boolean;
  items: NoteItem[];
  blocked: Set<string>;
  leftKeys: Map<string, string>;
  held?: Set<string>;
};

export const NUMBER_GATE_ITEM_REASON =
  "A number in my reason wasn't in the data I read, so I'll re-check it in the next review";

const NUMBER_GATE_LINE = /^(Work for|Pause|Goal change on|Approve card) (\S+): its reason cites (?:a figure|\d+ figures) nothing that run read\./;

function numberGateItem(line: string): NoteItem | null {
  const m = NUMBER_GATE_LINE.exec(line);
  if (!m) return null;
  const [, what, subject] = m;
  const text =
    what === "Work for"
      ? `Did not start the ${agentName(subject)} ${CGO_AD_CHANNELS.has(subject) ? "change" : "work"}`
      : what === "Pause"
        ? `Did not pause ${agentName(subject)}`
        : what === "Goal change on"
          ? "Did not change your goal"
          : "Did not approve a card";
  const channel = what === "Work for" || what === "Pause" ? subject : undefined;
  return { section: "blocked", text, reason: NUMBER_GATE_ITEM_REASON, ...(channel ? { channel_slug: channel } : {}) };
}

const OPEN_CARD_WAITING = "a card for it is already waiting";
const OPEN_CARD_NAMED = "it names the object of the channel's open card";
const isOpenCardClash = (why: string) => why === OPEN_CARD_WAITING || why.startsWith(OPEN_CARD_NAMED);

export function refusedMoveItems(refused: readonly string[]): NoteItem[] {
  const out: NoteItem[] = [];
  const seen = new Set<string>();
  const add = (item: NoteItem) => {
    if (seen.has(item.text)) return;
    seen.add(item.text);
    out.push(item);
  };
  for (const line of refused) {
    const gated = numberGateItem(line);
    if (gated) {
      add(gated);
      continue;
    }
    const m = /^Work for (\S+) on "(.+?)": (.+?)\.?$/.exec(line);
    const scope = !!m && m[1] === "research" && m[3].startsWith(RESEARCH_SCOPE_REASON);
    if (!m || (!CGO_AD_CHANNELS.has(m[1]) && !scope) || m[3].trim() === PLAN_LOCKED_REASON || isOpenCardClash(m[3].trim())) continue;
    const why = m[3].trim();
    add({
      section: "blocked",
      text: `Did not start ${agentName(m[1])} work for "${cutAtWord(m[2], 120)}"`,
      ...(why ? { reason: `${why[0].toUpperCase()}${why.slice(1)}` } : {}),
      ...(scope ? {} : { channel_slug: m[1] }),
    });
  }
  return out.slice(0, 5);
}

export const PLAN_LOCKED_REASON = "not in this workspace's plan";
export const PLAN_LINE_QUIET_DAYS = 14;

const isCgoChannel = (slug: string) => CGO_ORGANIC_TARGETS.has(slug) || CGO_AD_CHANNELS.has(slug);

export function pickPlanLineChannels(locked: readonly PlanLocked[], selected: ReadonlySet<string> = new Set()): PlanLocked[] {
  const channels = locked.filter((l) => isCgoChannel(l.agent));
  if (!channels.length) return [];
  const lowest = Math.min(...channels.map((l) => l.price_usd));
  const order = (slug: string) => {
    const i = CHANNELS.findIndex((c) => c.slug === slug);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return channels
    .filter((l) => l.price_usd === lowest)
    .sort((a, b) => Number(selected.has(b.agent)) - Number(selected.has(a.agent)) || order(a.agent) - order(b.agent))
    .slice(0, 2);
}

export function planLockedLine(named: readonly PlanLocked[]): string | null {
  const channels = named.filter((l) => isCgoChannel(l.agent)).slice(0, 2);
  if (!channels.length) return null;
  const top = channels.reduce((a, b) => (b.price_usd > a.price_usd ? b : a));
  const plan = `${top.needs_tier[0].toUpperCase()}${top.needs_tier.slice(1)}`;
  const names = channels.map((l) => agentName(l.agent));
  const lead = names.length === 2 ? `${names[0]} and ${names[1]} would help most. Both are` : `${names[0]} would help most. It's`;
  return `To reach more people for this goal, ${lead} in the ${plan} plan ($${top.price_usd}/mo); meanwhile I'm working the channels you have`;
}

export async function planLockedItem(tenant_id: string, locked: readonly PlanLocked[], now: Date): Promise<NoteItem | null> {
  if (!locked.some((l) => isCgoChannel(l.agent))) return null;
  const svc = tenantClient(asTenantId(tenant_id));
  const since = new Date(now.getTime() - PLAN_LINE_QUIET_DAYS * 86_400_000).toISOString();
  const { data, error } = await svc
    .from("cgo_notes")
    .select("id")
    .eq("tenant_id", tenant_id)
    .gte("created_at", since)
    .filter("items", "cs", JSON.stringify([{ plans: true }]))
    .limit(1);
  if (error) throw new Error(`earlier plan line read failed: ${error.message}`);
  if ((data ?? []).length) return null;
  const { data: picked, error: pickErr } = await svc
    .from("tenant_channels")
    .select("channel_slug")
    .eq("tenant_id", tenant_id)
    .eq("plan_selected", true);
  if (pickErr) console.warn(`[goal-owner] channel plan unreadable for ${tenant_id}, plan line in registry order: ${pickErr.message}`);
  const selected = new Set(((pickErr ? [] : picked) ?? []).map((r) => String((r as { channel_slug: unknown }).channel_slug)));
  const text = planLockedLine(pickPlanLineChannels(locked, selected));
  return text ? { section: "working_on", text, plans: true } : null;
}

function agentName(slug: string): string {
  const ch = CHANNELS.find((c) => c.slug === slug)?.name;
  if (ch) return ch;
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : slug;
}

const BLOCKED_SINCE_LIMIT = 20;
const BLOCKED_FIRST_WINDOW_DAYS = 14;
const BLOCKED_OVERLAP_MS = 30 * 60_000;
const SHOWN_NOTE_FILTER = "items.not.is.null,changed.neq.{},need.neq.{},would_change.neq.{}";

export async function readEmailOutcomesSinceLastNote(tenant_id: string, now: Date): Promise<NoteItem[]> {
  try {
    const { data: lastRows, error } = await tenantClient(asTenantId(tenant_id))
      .from("cgo_notes")
      .select("created_at, alarm_keys")
      .eq("tenant_id", tenant_id)
      .or(SHOWN_NOTE_FILTER)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    const last = ((lastRows ?? []) as Array<{ created_at: string; alarm_keys?: string[] | null }>).find((n) => !isBlockerNote(n.alarm_keys));
    const since = last?.created_at ?? new Date(now.getTime() - BLOCKED_FIRST_WINDOW_DAYS * 86_400_000).toISOString();
    const { readEmailOutcomesSince } = await import("@/services/email-cards/outcome");
    const rows = await readEmailOutcomesSince(tenant_id, since);
    return rows.map((r): NoteItem => ({ section: r.outcome === "sent" ? "changed" : "needs_you", text: r.line, channel_slug: "email_marketing" }));
  } catch (e) {
    console.warn(`[goal-owner] email outcomes skipped for ${tenant_id}: ${(e as Error).message}`);
    return [];
  }
}

export async function readBlockedSinceLastNote(tenant_id: string, now: Date): Promise<NoteItem[]> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data: lastRows, error: lastErr } = await db
    .from("cgo_notes")
    .select("created_at, alarm_keys")
    .eq("tenant_id", tenant_id)
    .or(SHOWN_NOTE_FILTER)
    .order("created_at", { ascending: false })
    .limit(30);
  if (lastErr) throw new Error(`blocked cards: last shown note read failed: ${lastErr.message}`);
  const last = ((lastRows ?? []) as Array<{ created_at: string; alarm_keys?: string[] | null }>).find((n) => !isBlockerNote(n.alarm_keys));
  const lastAt = last?.created_at ? Date.parse(last.created_at) : NaN;
  const since = Number.isFinite(lastAt)
    ? new Date(lastAt - BLOCKED_OVERLAP_MS).toISOString()
    : new Date(now.getTime() - BLOCKED_FIRST_WINDOW_DAYS * 86_400_000).toISOString();
  const told = new Set<string>();
  if (Number.isFinite(lastAt)) {
    const { data: recent, error: recentErr } = await db
      .from("cgo_notes")
      .select("items")
      .eq("tenant_id", tenant_id)
      .or(SHOWN_NOTE_FILTER)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(50);
    if (recentErr) throw new Error(`blocked cards: recent notes read failed: ${recentErr.message}`);
    for (const n of (recent ?? []) as Array<{ items: unknown }>) {
      for (const i of parseNoteItems(n.items) ?? []) if (i.section === "blocked" && i.action_id) told.add(i.action_id);
    }
  }
  const { data, error } = await db
    .from("channel_actions")
    .select("id, channel_slug, title, exec_class, exec_payload, status_at")
    .eq("tenant_id", tenant_id)
    .eq("status", "stale")
    .eq("exec_status", "failed")
    .eq("exec_result->>bucket", "blocked_on_us")
    .gt("status_at", since)
    .order("status_at", { ascending: false })
    .limit(BLOCKED_SINCE_LIMIT + told.size);
  if (error) throw new Error(`blocked cards: read failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; channel_slug: string; title: string; exec_class: string | null; exec_payload?: unknown }>)
    .filter((r) => !told.has(r.id))
    .slice(0, BLOCKED_SINCE_LIMIT)
    .map((r) => ({
      section: "blocked" as const,
      text: cleanTitle(adCardTitle(r)) || "A change",
      reason: blockedReason(r.exec_class ? execPlatformLabel(r.exec_class) : agentName(r.channel_slug)),
      action_id: r.id,
      channel_slug: r.channel_slug,
    }));
}

export async function markNoteBlockers(tenant_id: string, items: NoteItem[], stored: ReadonlyArray<{ topic_key: string }>, now: Date, alreadyShown: ReadonlySet<string> = new Set()): Promise<NoteItem[]> {
  try {
    const { markReviewBlockers, readToldNotes, toldMemory } = await import("./cgo-blockers");
    const ids = [...new Set(items.filter((i) => i.section === "needs_you" && i.action_id && i.question_ordinal == null).map((i) => i.action_id!))];
    const cards = new Map<string, { exec_class: string | null; exec_status: string | null; exec_result: unknown; exec_payload: unknown }>();
    if (ids.length) {
      const { data, error } = await tenantClient(asTenantId(tenant_id)).from("channel_actions").select("id, exec_class, exec_status, exec_result, exec_payload").eq("tenant_id", tenant_id).in("id", ids);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<{ id: string; exec_class: string | null; exec_status: string | null; exec_result: unknown; exec_payload: unknown }>) cards.set(r.id, r);
    }
    const told = toldMemory(await readToldNotes(tenant_id, now, true));
    const topicByOrdinal = new Map<number, string>();
    stored.forEach((q, i) => {
      const o = (q as { ordinal?: number | null }).ordinal;
      topicByOrdinal.set(typeof o === "number" ? o : 100 + i, q.topic_key);
    });
    const withQuestions = items.map((i): NoteItem => {
      const topic = i.section === "needs_you" && i.question_ordinal != null ? topicByOrdinal.get(i.question_ordinal) : undefined;
      return topic ? { ...i, blocker_id: `question:${topic}`, blocker_severity: "normal" } : i;
    });
    return markReviewBlockers(withQuestions, cards, told, alreadyShown);
  } catch (e) {
    console.warn(`[goal-owner] blocker marks skipped for ${tenant_id}: ${(e as Error).message}`);
    return items.filter((i) => !i.action_id || !alreadyShown.has(i.action_id));
  }
}

export async function finalizeApprovedItems(tenant_id: string, items: NoteItem[]): Promise<void> {
  const ids = [...new Set(items.filter((i) => i.approved && i.action_id).map((i) => i.action_id!))];
  if (!ids.length) return;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("id, channel_slug, exec_class, exec_status, exec_result")
    .eq("tenant_id", tenant_id)
    .in("id", ids);
  if (error) throw new Error(`approved cards: re-read failed: ${error.message}`);
  const byId = new Map(((data ?? []) as Array<{ id: string; channel_slug: string; exec_class: string | null; exec_status: string | null; exec_result: unknown }>).map((r) => [r.id, r]));
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (!it.approved || !it.action_id) continue;
    const row = byId.get(it.action_id);
    if (!row) continue;
    const base = it.text.replace(/^Applying: /, "");
    if (row.exec_status === "executed") {
      items[k] = { ...it, section: "changed", text: `Applied: ${base}` };
      continue;
    }
    if (row.exec_status !== "failed") continue;
    const v = execVerdictOf(row.exec_status, row.exec_result);
    const platform = row.exec_class ? execPlatformLabel(row.exec_class) : agentName(row.channel_slug);
    items[k] = channelCardNoteItem({
      outcome: "approve_failed",
      row: { id: it.action_id, channel_slug: it.channel_slug ?? row.channel_slug, title: base, proposed_at: it.waiting_since ?? null },
      bucket: v?.bucket ?? null,
      action: base,
      why: it.reason,
      usd: it.usd_at_stake,
      platform,
      fixText: v?.bucket === "needs_founder" ? fixWords(v.fix, platform, v.platform_code) : null,
    });
  }
}

const CHAIN_MAX_HOPS = 5;

export async function readChainRoots(tenant_id: string, ids: readonly string[]): Promise<Map<string, string>> {
  const start = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  const parent = new Map<string, string | null>();
  const asked = new Set<string>();
  let frontier = start;
  const db = tenantClient(asTenantId(tenant_id));
  for (let hop = 0; hop <= CHAIN_MAX_HOPS && frontier.length; hop++) {
    for (const id of frontier) asked.add(id);
    const { data, error } = await db.from("channel_actions").select("id, repeat_of").eq("tenant_id", tenant_id).in("id", frontier);
    if (error) throw new Error(`card chains: read failed: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string; repeat_of: string | null }>) {
      parent.set(r.id, r.repeat_of && r.repeat_of !== r.id ? r.repeat_of : null);
    }
    frontier = [...new Set([...parent.values()].filter((p): p is string => !!p && !asked.has(p)))];
  }
  const roots = new Map<string, string>();
  for (const id of start) {
    let cur = id;
    const seen = new Set<string>([cur]);
    for (let hop = 0; hop < CHAIN_MAX_HOPS; hop++) {
      const p = parent.get(cur);
      if (!p || !parent.has(p) || seen.has(p)) break;
      seen.add(p);
      cur = p;
    }
    roots.set(id, cur);
  }
  return roots;
}

export function proposedMovesUntested(moves: GoalMoves): number {
  return (moves.goals ?? []).reduce((n, g) => n + (g.moves ?? []).filter((m) => !m.test && !m.no_test_because).length, 0);
}

export async function applyGoalMoves(
  tenant_id: string,
  run_id: string,
  proposed: GoalMoves,
  deps: ApplyGoalMovesDeps & { meta?: ReviewMeta },
): Promise<ApplyGoalMovesResult> {
  const svc = tenantClient(asTenantId(tenant_id));
  const now = deps.now ?? new Date();
  const tz = await goalTimeZone(tenant_id);
  const today = dayInZone(now, tz);
  const result: ApplyGoalMovesResult = {
    status_lines: 0,
    cards_emitted: 0,
    goals_ended: 0,
    goals_changed: 0,
    channels_paused: 0,
    next_goal_proposed: false,
    note_id: null,
    note_visible: false,
    note_notify: false,
  };
  const readPriorNote = () => svc.from("cgo_notes")
    .select("id, items, changed, need, would_change, notification_key, notified")
    .eq("tenant_id", tenant_id)
    .eq("run_id", run_id)
    .maybeSingle<{ id: string; items: unknown[] | null; changed: string[]; need: string[]; would_change: string[]; notification_key: string | null; notified: boolean | null }>();
  const prior = await readPriorNote();
  if (prior.error) throw new Error(`goal-owner: prior note read failed: ${prior.error.message}`);
  const reuseNote = (note: NonNullable<typeof prior.data>) => ({ ...result, note_id: note.id, note_visible: isNoteVisible(note), note_notify: !!note.notification_key && note.notified !== true });
  if (prior.data) return reuseNote(prior.data);
  const meta: ReviewMeta = deps.meta ?? { kind: "founder", alarm_keys: [], autopilot: true };
  const acts = meta.autopilot;
  const changedLines: string[] = [];
  const items: NoteItem[] = [];
  let adMoved = false;
  const wouldLines: string[] = [];
  const serverAsks: QuestionAsk[] = [];
  const refused: string[] = [];
  const applyAdPlanYesHere = async (
    q: { id: string; ordinal: number | null; on_yes: OnYes | null },
    approver: string | null,
    surface: "email" | "slack" | "web_button",
    amount_usd: number | null,
  ) => {
    if (q.on_yes?.kind === "budget_raise") {
      const { applyBudgetRaiseYes } = await import("./ad-plan-yes");
      const r = await applyBudgetRaiseYes(tenant_id, q.on_yes, approver).catch((e: Error) => ({ line: null, refused: e.message }));
      if (r.line) {
        changedLines.push(r.line);
        items.push({ section: "changed", text: r.line });
        await svc.from("cgo_questions").update({ applied_line: r.line.slice(0, 400) }).eq("id", q.id).eq("tenant_id", tenant_id);
      } else if (r.refused) refused.push(`Budget not raised: ${r.refused}`);
      return;
    }
    if (q.on_yes?.kind !== "ad_plan") return;
    const { applyAdPlanYes } = await import("./ad-plan-yes");
    const end = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1));
    const r = await applyAdPlanYes(
      { tenant_id, question: { id: q.id, ordinal: q.ordinal, on_yes: q.on_yes }, approver_user_id: approver, surface, amount_usd, days_left: Math.round((end.getTime() - Date.parse(`${today}T00:00:00Z`)) / 86_400_000), now },
      { emitDecision: deps.emitDecision },
    ).catch((e: Error) => ({ line: null, refused: e.message }));
    if (r.line) {
      changedLines.push(r.line);
      items.push({ section: "changed", text: r.line });
      adMoved = true;
      const { error: lineErr } = await svc.from("cgo_questions").update({ applied_line: r.line.slice(0, 400) }).eq("id", q.id).eq("tenant_id", tenant_id);
      if (lineErr) console.warn(`[goal-owner] recording the ad plan yes failed: ${lineErr.message}`);
    } else if (r.refused) {
      refused.push(`Ad test not started: ${r.refused}`);
    }
  };

  const gated = gateMovesOnLedger(run_id, proposed);
  const moves = gated.moves;
  refused.push(...gated.refused);

  if (meta.reply_via && (moves.answered?.length ?? 0) > 0) {
    const { markAnswered } = await import("./cgo-questions");
    await markAnswered(tenant_id, moves.answered ?? [], meta.reply_via === "web" ? "web" : meta.reply_via, run_id, now);
    if (meta.reply_text && (meta.reply_via === "email" || meta.reply_via === "slack")) {
      const ids = [...new Set((moves.answered ?? []).map((a) => a.question_id))];
      const via = meta.reply_via;
      const recorded = await (async () => {
        const { data: hypQs, error: hypErr } = await svc
          .from("cgo_questions")
          .select("id, ask, on_yes")
          .eq("tenant_id", tenant_id)
          .eq("status", "open")
          .in("id", ids);
        if (hypErr) throw new Error(hypErr.message);
        const own = ((hypQs ?? []) as Array<{ id: string; ask: string; on_yes: OnYes | null }>).filter((q) => q.on_yes?.kind === "hypothesis_check");
        if (own.length === 0) return;
        const { answerQuestions } = await import("./cgo-answers");
        await answerQuestions(
          { tenant_id, answers: own.map((q) => ({ question_id: q.id, answer: { text: meta.reply_text! } })), via, actor_user_id: null, now },
          { wake: async () => undefined },
        );
      })().then(
        () => true,
        (e: Error) => {
          console.error(`[goal-owner] run ${run_id}: recording the founder's words on a hypothesis failed: ${e.message}`);
          return false;
        },
      );
      if (!recorded) {
        items.push({
          section: "needs_you",
          text: "Answer my question about your own records again",
          reason: "I could not save your reply to it. It is still open on your Growth page",
        });
      }
    }
  }

  if ((meta.reply_via === "email" || meta.reply_via === "slack") && meta.reply_text && (moves.answered?.length ?? 0) > 0) {
    const ids = [...new Set((moves.answered ?? []).map((a) => a.question_id))];
    const { data: adQs } = await svc
      .from("cgo_questions")
      .select("id, ordinal, on_yes, applied_line")
      .eq("tenant_id", tenant_id)
      .eq("resolved_run_id", run_id)
      .in("id", ids);
    const own = ((adQs ?? []) as Array<{ id: string; ordinal: number | null; on_yes: OnYes | null; applied_line: string | null }>).filter((q) => (q.on_yes?.kind === "ad_plan" || q.on_yes?.kind === "budget_raise") && !q.applied_line);
    if (own.length > 0) {
      const { adPlanReply, loadReplyReader } = await import("./ad-plan-yes");
      await loadReplyReader();
      const numbered = /^\s*\d{1,2}\s*[.):-]?\s+/.test(meta.reply_text);
      if (own.length > 1 && !numbered) {
        refused.push("A yes to more than one ad test: reply with the number of the test to run.");
      } else {
        const { tenantOwnerId } = await import("./cgo-auto-run");
        const owner = await tenantOwnerId(tenant_id);
        for (const q of own) {
          const r = adPlanReply(meta.reply_text, own.length > 1 ? q.ordinal : null);
          if (r && (q.on_yes?.kind === "ad_plan" || r.amount_usd == null)) await applyAdPlanYesHere(q, owner, meta.reply_via, r.amount_usd);
        }
      }
    }
  }

  {
    const { envelopeFollowUps } = await import("./ad-plan-yes");
    for (const f of await envelopeFollowUps(tenant_id, now)) {
      items.push({ section: "needs_you", text: f.text, action_id: f.action_id, channel_slug: f.channel_slug });
    }
  }

  const confirmedCounts = new Set(meta.reply_via ? (moves.count_rules_confirmed ?? []) : []);
  if ((meta.answered_ids?.length ?? 0) > 0) {
    const { data: claimed, error: claimErr } = await svc
      .from("cgo_questions")
      .update({ resolved_run_id: run_id })
      .eq("tenant_id", tenant_id)
      .eq("status", "answered")
      .is("resolved_run_id", null)
      .in("id", meta.answered_ids ?? [])
      .select("id, topic_key, answer, on_yes, applied_line, asked_run_id, ordinal, answered_by, answered_via");
    if (claimErr) console.warn(`[goal-owner] claiming answered questions failed: ${claimErr.message}`);
    for (const q of (claimed ?? []) as Array<{ id: string; topic_key: string; answer: string | null; on_yes: OnYes | null; applied_line: string | null; asked_run_id: string | null; ordinal: number | null; answered_by: string | null; answered_via: string | null }>) {
      if (q.topic_key.startsWith("count:") && q.answer === "yes") confirmedCounts.add(q.id);
      if ((q.on_yes?.kind === "ad_plan" || q.on_yes?.kind === "budget_raise") && !q.applied_line && q.answer) {
        const { adPlanReply, loadReplyReader } = await import("./ad-plan-yes");
        await loadReplyReader();
        const r = q.answer === "yes" ? { yes: true as const, amount_usd: null } : adPlanReply(q.answer, null);
        const surface = q.answered_via === "slack" ? "slack" : q.answered_via === "email" ? "email" : "web_button";
        if (r && (q.on_yes?.kind === "ad_plan" || r.amount_usd == null)) await applyAdPlanYesHere(q, q.answered_by, surface, r.amount_usd);
      }
      if ((q.answer === "yes" || q.answer === "no") && q.on_yes?.kind === "goal_basis" && !q.applied_line && !q.on_yes.undone_at) {
        const { applyGoalBasis } = await import("./goal-basis");
        const onYes = q.on_yes;
        const stored = await applyGoalBasis(tenant_id, onYes, q.answer, { source: "system", why: "The founder's answer, stored on retry" }, now).catch(() => null);
        if (stored) {
          changedLines.push(stored.line);
          items.push({ section: "changed", text: stored.line, goal_id: onYes.goal_id });
          const { error: lineErr } = await svc
            .from("cgo_questions")
            .update({ applied_line: stored.line.slice(0, 400), on_yes: { ...onYes, applied_at: stored.applied_at } })
            .eq("id", q.id)
            .eq("tenant_id", tenant_id);
          if (lineErr) console.warn(`[goal-owner] recording the retried answer failed: ${lineErr.message}`);
        }
      }
      if (q.answer === "yes" && q.on_yes?.kind === "goal_change" && !q.applied_line && q.asked_run_id) {
        const line = await applyApprovedGoalChange(tenant_id, q.asked_run_id, q.on_yes, now).catch(() => null);
        if (line) {
          changedLines.push(line);
          items.push({ section: "changed", text: line, goal_id: q.on_yes.goal_id, undoable: true });
          const { error: lineErr } = await svc.from("cgo_questions").update({ applied_line: line.slice(0, 400) }).eq("id", q.id).eq("tenant_id", tenant_id);
          if (lineErr) console.warn(`[goal-owner] recording the retried change failed: ${lineErr.message}`);
        }
      }
    }
  }

  if (confirmedCounts.size > 0) {
    const { applyCountRuleConfirmations } = await import("./goal-count-review");
    const c = await applyCountRuleConfirmations({
      tenant_id,
      run_id,
      question_ids: [...confirmedCounts],
      via: meta.reply_via ?? "web",
      goals: await loadActiveGoals(tenant_id),
      now,
      deps: deps.countDeps,
    });
    changedLines.push(...c.changed);
    items.push(...c.changed.map((line) => ({ section: "changed" as const, text: line })));
    refused.push(...c.refused);
  }

  const goals = await loadActiveGoals(tenant_id);
  const byId = new Map(goals.map((g) => [g.id, g]));

  const ended: GoalRow[] = [];
  for (const { goal: g, reason } of planGoalEnds(goals, today, acts)) {
    if (reason === "met") {
      const flipped = await writeAutopilotGoal(tenant_id, {
        op: "update",
        goal_id: g.id,
        values: { status: "met", status_changed_by: "cgo", status_changed_at: now.toISOString(), updated_at: now.toISOString() },
        expect: { status: "active", current_value: g.current_value, target_value: g.target_value, baseline_value: g.baseline_value ?? null },
        actor: { source: "cgo", run_id, why: `The number reached the target: ${num(g.current_value)} against ${num(g.target_value)}.` },
      });
      if (flipped.status !== "written") {
        if (flipped.status === "error") console.warn(`[goal-owner] met write failed for goal ${g.id}: ${flipped.error}`);
        continue;
      }
    }
    ended.push(g);
    const { error: wErr } = await svc
      .from("decisions")
      .update({ status: "expired" })
      .eq("tenant_id", tenant_id)
      .eq("decision_class", CGO_CARD_CLASS)
      .eq("status", "proposed")
      .eq("body->>goal_id", g.id);
    if (wErr) console.warn(`[goal-owner] withdraw failed for goal ${g.id}: ${wErr.message}`);
    result.goals_ended++;
  }

  const changedGoals = new Set<string>();
  const plannedChanges = planGoalChanges({
    changes: moves.goal_changes,
    goals,
    today,
    tz,
    now,
    run_id,
    acts,
    reviewedRevs: deps.reviewedRevs,
  });
  wouldLines.push(...plannedChanges.wouldLines);
  serverAsks.push(...plannedChanges.held);
  refused.push(...plannedChanges.refused);
  for (const c of plannedChanges.writes) {
    const g = c.goal;
    if (!(await writeGoalChange(tenant_id, c, run_id))) continue;
    changedGoals.add(g.id);
    result.goals_changed++;
    changedLines.push(c.line);
    items.push({ section: "changed", text: c.line, goal_id: g.id, undoable: true });
    const updated = goalAfterChange(c);
    byId.set(g.id, updated);
    const i = goals.findIndex((x) => x.id === g.id);
    if (i >= 0) goals[i] = updated;
  }

  const { data: openRows, error: openErr } = await svc
    .from("decisions")
    .select("id, body")
    .eq("tenant_id", tenant_id)
    .eq("decision_class", CGO_CARD_CLASS)
    .eq("status", "proposed");
  if (openErr) throw new Error(`goal-owner: open cards read failed: ${openErr.message}`);
  const openKeys = new Set<string>();
  const { data: ownApproved, error: ownErr } = await svc
    .from("decisions")
    .select("body")
    .eq("tenant_id", tenant_id)
    .eq("decision_class", CGO_CARD_CLASS)
    .eq("agent_run_id", run_id)
    .in("status", ["approved", "dispatching", "acted"]);
  if (ownErr) throw new Error(`goal-owner: own approved cards read failed: ${ownErr.message}`);
  const addAdKey = (body: Record<string, unknown> | null) => {
    const target = String(body?.target_agent_slug ?? "");
    if (CGO_AD_CHANNELS.has(target)) openKeys.add(adOrderKey(String(body?.goal_id ?? ""), target, body?.intent));
  };
  for (const r of (ownApproved ?? []) as Array<{ body: Record<string, unknown> | null }>) {
    openKeys.add(`${String(r.body?.goal_id ?? "")}:${String(r.body?.target_agent_slug ?? "")}`);
    addAdKey(r.body);
  }
  const openBodies = new Map(((openRows ?? []) as Array<{ id: string; body: Record<string, unknown> | null }>).map((r) => [r.id, r.body]));
  for (const row of planOpenCards((openRows ?? []) as Array<{ id: string; body: Record<string, unknown> | null }>, byId)) {
    if (row.expire) {
      const { error } = await svc
        .from("decisions")
        .update({ status: "expired" })
        .eq("id", row.id)
        .eq("tenant_id", tenant_id)
        .eq("status", "proposed");
      if (!error) continue;
      console.warn(`[goal-owner] expiring stale card ${row.id} failed: ${error.message}`);
    }
    openKeys.add(row.key);
    addAdKey(openBodies.get(row.id) ?? null);
  }
  try {
    const { withdrawStaleGoalQuestions } = await import("./cgo-questions");
    const live = goals.filter((g) => endedReason(g, today) === null);
    await withdrawStaleGoalQuestions(tenant_id, new Map(live.map((g) => [g.id, goalRev(g)])));
  } catch (e) {
    console.warn(`[goal-owner] withdrawing stale goal questions failed: ${(e as Error).message}`);
  }

  const adBudget = acts ? await (deps.adBudget ?? cgoAdBudget)(tenant_id, now) : null;
  const pace = adBudget ? await (deps.spendPace ?? loadSpendPace)(tenant_id, now).catch(() => null) : null;
  const forecast = adBudget ? await (deps.liveForecast ?? loadLiveForecast)(tenant_id, now).catch(() => null) : null;
  const debtHigh = deliveryDebtHigh(pace);
  const { data: recentRows, error: recentErr } = await svc
    .from("decisions")
    .select("id, body, approved_at")
    .eq("tenant_id", tenant_id)
    .eq("decision_class", CGO_CARD_CLASS)
    .in("status", ["approved", "dispatching", "acted"])
    .gte("approved_at", new Date(now.getTime() - REPEAT_MOVE_DAYS * 86_400_000).toISOString());
  if (recentErr) throw new Error(`goal-owner: recent cards read failed: ${recentErr.message}`);
  const recentBodies = (recentRows ?? []) as Array<{ id?: string; body: Record<string, unknown> | null; approved_at?: string | null }>;
  const recentCards = recentBodies.map((r) => ({
    key: `${String(r.body?.goal_id ?? "")}:${String(r.body?.target_agent_slug ?? "")}`,
    approved_at: r.approved_at ?? null,
  }));
  const isAdOrder = (r: (typeof recentBodies)[number]) => CGO_AD_CHANNELS.has(String(r.body?.target_agent_slug ?? ""));
  let noLiveAd = new Set<string>();
  const adOrders = recentBodies.filter((r) => isAdOrder(r) && typeof r.id === "string").map((r) => ({ id: r.id as string, approved_at: r.approved_at ?? null }));
  if (adOrders.length) {
    try {
      noLiveAd = await readOrdersWithoutLiveAd(tenant_id, adOrders, now);
    } catch (e) {
      console.warn(`[goal-owner] earlier ad orders unreadable; the week rule holds: ${(e as Error).message}`);
    }
  }
  const recentKeys = new Set(
    recentBodies
      .filter((r) => !(isAdOrder(r) && r.id && noLiveAd.has(r.id)))
      .map((r) => {
        const goal = String(r.body?.goal_id ?? "");
        const target = String(r.body?.target_agent_slug ?? "");
        return isAdOrder(r) ? adRepeatKey(goal, target, r.body?.problem, r.body?.intent) : repeatKey(goal, target, r.body?.problem);
      }),
  );
  const { data: replyRows, error: replyErr } = await svc
    .from("agent_runs")
    .select("agent_slug, payload, parsed, finished_at")
    .eq("tenant_id", tenant_id)
    .eq("payload->>dispatched_by", "cgo")
    .in("status", TERMINAL_RUN_STATUSES)
    .gte("enqueued_at", new Date(now.getTime() - REJECTED_ORDER_DAYS * 86_400_000).toISOString())
    .order("enqueued_at", { ascending: false })
    .limit(50);
  if (replyErr) throw new Error(`goal-owner: cgo run replies read failed: ${replyErr.message}`);
  const replies = (replyRows ?? []) as Array<{ agent_slug: string; payload: Record<string, unknown> | null; parsed?: unknown; finished_at?: string | null }>;
  let rejectedOrders = rejectedOrdersFrom(replies);
  const since = rejectedOrders.map((r) => r.rejected_at).filter((x): x is string => !!x).sort()[0];
  if (since) {
    try {
      rejectedOrders = withFounderClosedCited(rejectedOrders, await readFounderClosedCards(tenant_id, since));
    } catch (e) {
      console.warn(`[goal-owner] founder-closed cards unreadable; rejections stay held: ${(e as Error).message}`);
    }
  }
  const answerKeys = answerKeysFrom(replies, recentCards);
  const liveGoals = goals.filter((g) => endedReason(g, today) === null);
  const replied =
    deps.replyPayload !== undefined
      ? await (deps.founderReplyApprovals ?? (await import("./founder-reply-approve")).applyFounderReplyApprovals)({
          tenant_id,
          payload: deps.replyPayload,
          wanted: moves.channel_cards ?? [],
        })
      : null;
  if (replied) {
    changedLines.push(...replied.changed);
    items.push(...replied.items);
    if (replied.ad_changed) adMoved = true;
  }
  const listedIds = proposed.channel_card_order ?? (proposed.channel_cards ?? []).map((c) => c.action_id);
  const applicable = cardsToApply(listedIds.map((action_id) => ({ action_id })), deps.shownCards);
  const shownListed = new Set(listedIds.filter((id) => deps.shownCards?.has(id))).size;
  if (shownListed > applicable.size) {
    console.warn(`[goal-owner] goal review listed ${shownListed} shown cards; deciding the first ${applicable.size}, ${shownListed - applicable.size} stay open`);
  }
  const worked = await workChannelCards({
    tenant_id,
    run_id,
    moves: {
      ...moves,
      channel_cards: (moves.channel_cards ?? []).filter(
        (c) => applicable.has(c.action_id) && !(replied && (replied.handled.has(c.action_id) || (c.decision === "approve" && replied.withhold(c.action_id)))),
      ),
    },
    shown: deps.shownCards,
    acts,
    adBudget,
    goal: liveGoals.find((g) => !deps.reviewedRevs || deps.reviewedRevs.get(g.id) === goalRev(g)) ?? null,
    openKeys,
    emitDecision: deps.emitDecision,
    autoRun: deps.autoRun,
    approveChannelAction: deps.approveChannelAction,
    approveAdDecision: deps.approveAdDecision,
    newerOpenCard: deps.newerOpenCard,
    evidence: deps.evidence ?? null,
    now,
  });
  changedLines.push(...worked.changed);
  items.push(...worked.items);
  if (worked.ad_changed) adMoved = true;
  wouldLines.push(...worked.would);
  refused.push(...worked.refused);
  serverAsks.push(...worked.asks);

  const openAdvice = new Map<string, AdviceCard[] | "unreadable">();
  if (acts && adBudget) {
    const targets = new Set(moves.goals.flatMap((g) => g.moves.map((m) => m.target_agent_slug.trim())).filter((t) => CGO_AD_TARGETS.has(t)));
    for (const ch of targets) {
      try {
        const rows = await readOpenCards(tenant_id, [ch]);
        openAdvice.set(
          ch,
          rows.filter((r) => !worked.decided.has(r.id)).map((r) => ({ id: r.id, title: r.title, refs: refsOfRow(r).refs })),
        );
      } catch (e) {
        console.warn(`[goal-owner] open cards of ${ch} unreadable; no move for it: ${(e as Error).message}`);
        openAdvice.set(ch, "unreadable");
      }
    }
  }

  const fresh: SavedFinding[] = moves.readouts?.length
    ? (
        await (deps.applyReadouts ?? applyReadouts)({
          tenant_id,
          run_id,
          readouts: moves.readouts,
          due: (await (deps.readDueTests ?? readDueTests)(tenant_id, CGO_CARD_CLASS, now).catch(() => ({ due: [] as DueTest[], more: 0 }))).due,
          cardClass: CGO_CARD_CLASS,
          now,
        }).catch(() => ({ saved: 0, findings: [] as SavedFinding[] }))
      ).findings
    : [];
  const pendingFindings = await (deps.readUndeliveredFindings ?? readUndeliveredFindings)(tenant_id, CGO_CARD_CLASS).catch(() => [] as SavedFinding[]);
  const testFindings = [...fresh, ...pendingFindings.filter((p) => !fresh.some((f) => f.decision_id === p.decision_id))];
  let hypSaved = true;
  const hyp = await (deps.prepareHypotheses ?? (await import("./cgo-hypotheses")).prepareHypotheses)({
    tenant_id,
    run_id,
    proposed: moves.hypotheses,
    findings: [...(moves.read_findings ?? []), ...testFindings.map(({ hypothesis, finding }) => ({ hypothesis, finding }))],
    goals: liveGoals,
    now,
  }).catch((e: Error) => {
    hypSaved = false;
    console.warn(`[goal-owner] run ${run_id}: hypotheses unavailable, no work starts this review: ${e.message}`);
    return {
      rows: [],
      gate: () => ({ ok: false as const, code: "list_unreadable" as const, reason: "its hypotheses could not be read" }),
      resolve: () => undefined,
      readNow: async () => null,
      refused: [],
      dropped: 0,
    };
  });
  if (hypSaved && testFindings.length > 0) {
    const delivered = testFindings.filter((f) => {
      const row = hyp.rows.find((r) => r.id === f.hypothesis);
      if (!row || row.status === "ruled_out" || row.status === "confirmed") return true;
      return row.evidence.some((e) => e.excerpt === f.finding);
    });
    await (deps.markFindingsDelivered ?? markFindingsDelivered)(tenant_id, CGO_CARD_CLASS, delivered.map((f) => f.decision_id)).catch(() => undefined);
  }
  const untested = proposedMovesUntested(moves);
  if (untested > 0) console.info(`[goal-owner] run ${run_id}: ${untested} move(s) with neither a test nor a reason (cgo.move_untested)`);
  refused.push(...hyp.refused);
  if (hyp.dropped > 0) console.warn(`[goal-owner] run ${run_id}: ${hyp.dropped} malformed hypothesis item(s) dropped`);
  const hypById = new Map(hyp.rows.map((h) => [h.id, h]));
  let enforceGate = deps.gateEnforced ?? false;
  if (deps.gateEnforced === undefined) {
    try {
      enforceGate = await (await import("@/services/settings")).getBoolSetting("cgo_hypothesis_gate_enforced", tenant_id);
    } catch {
      enforceGate = false;
    }
  }
  const wouldBlock: Array<{ line: string; code: import("./cgo-hypotheses").GateCode }> = [];
  const shadow = (line: string, code: import("./cgo-hypotheses").GateCode) => wouldBlock.push({ line, code });

  const live = await allowedAgents(tenant_id, adBudget, { on: acts, removed: acts ? await readFounderRemoved(tenant_id) : new Set() });
  const spareDaily = adBudget
    ? await (await import("./pending-tests")).spareAfterPendingTests(adSpareDailyUsd(adBudget, forecast), tenant_id, now, deps.pendingRoom)
    : null;
  const baseCountDeps = deps.countDeps ?? (await import("./goal-count-rule")).defaultCountDeps;
  let catalogOnce: ReturnType<typeof baseCountDeps.catalog> | null = null;
  const readCatalog = () => (catalogOnce ??= baseCountDeps.catalog(tenant_id));
  const countDeps = { ...baseCountDeps, catalog: (t: string) => (t === tenant_id ? readCatalog() : baseCountDeps.catalog(t)) };
  const scoped = (moves.goals ?? []).some((g) => (g.moves ?? []).some((m) => String(m.target_agent_slug ?? "").trim() === "research"))
    ? withoutTenantRecordResearch(
        moves,
        (id) => liveGoals.find((g) => g.id === id)?.objective ?? "this goal",
        await readCatalog()
          .then((c) => (c?.catalog?.tables ?? []).map((t) => t.name))
          .catch(() => []),
      )
    : { moves, refused: [] as string[], refusedMoves: [] as Array<{ goal_id: string; hypothesis: string | undefined }> };
  refused.push(...scoped.refused);
  if (hypSaved && hyp.resolve) {
    const { hypothesisAsk, withdrawStaleHypothesisQuestions } = await import("./cgo-questions");
    await withdrawStaleHypothesisQuestions(tenant_id, hyp.rows).catch((e: Error) =>
      console.warn(`[goal-owner] run ${run_id}: withdrawing stale hypothesis questions failed: ${e.message}`),
    );
    const candidates = [
      ...scoped.refusedMoves.map((r) => ({ row: hyp.resolve!(r.goal_id, r.hypothesis), why: "Research reads the public web, not your own records, so only you can tell me." })),
      ...(moves.verify_with_founder
        ? [{ row: hyp.resolve(moves.verify_with_founder.goal_id, moves.verify_with_founder.hypothesis), why: "Only your own records can settle this, so only you can tell me." }]
        : []),
    ];
    const pick = candidates.find((c) => c.row && (c.row.status === "listed" || c.row.status === "testing") && liveGoals.some((g) => g.id === c.row!.goal_id));
    if (pick?.row) serverAsks.push(hypothesisAsk(pick.row, pick.why));
  }
  const cardArgs = {
    gate: hyp.gate,
    ...(enforceGate ? {} : { gateShadow: shadow }),
    liveGoals,
    moves: scoped.moves,
    changedGoals,
    acts,
    reviewedRevs: deps.reviewedRevs,
    allowed: new Set(live.allowed),
    locked: live.locked,
    openKeys,
    recentKeys,
    answerKeys,
    rejectedOrders,
    openAdvice,
    evidence: deps.evidence ?? null,
    spareDailyCapacityUsd: spareDaily,
    deliveryDebtHigh: debtHigh,
  };
  let planned = planGoalCards({ ...cardArgs, repo: "unresolved", today });
  if (planned.needsRepo) planned = planGoalCards({ ...cardArgs, repo: await deps.resolveRepo(tenant_id), today });
  if (planned.needsRepo) throw new Error("goal-owner: repo resolved but still needed");
  refused.push(...planned.refused);
  const planItem = await planLockedItem(tenant_id, live.locked, now).catch((e: Error) => {
    console.warn(`[goal-owner] plan line skipped for ${tenant_id}: ${e.message}`);
    return null;
  });
  const startsNow = acts
    ? await (deps.autopilotNow ?? (async (t: string) => (await import("@/services/settings")).getBoolSettingStrictResolved("cgo_autopilot_enabled", t)))(tenant_id).catch((e: Error) => {
        console.warn(`[goal-owner] live autopilot read failed for ${tenant_id}, nothing starts itself: ${e.message}`);
        return false;
      })
    : false;
  if (acts && !startsNow) console.info(JSON.stringify({ evt: "cgo.review_autopilot_off_at_apply", tenant_id, run_id }));
  const autorunOn: ReadonlySet<string> = startsNow
    ? await (deps.autorunChannels ?? readAutorunChannels)(tenant_id).catch((e: Error) => {
        console.warn(`[goal-owner] autorun read failed for ${tenant_id}, no channel starts itself: ${e.message}`);
        return new Set<string>();
      })
    : new Set<string>();
  serverAsks.push(...planned.asks);

  for (const pg of planned.goals) {
    for (const c of pg.cards) {
      const h = typeof c.body.hypothesis_id === "string" ? hypById.get(c.body.hypothesis_id) : undefined;
      const { moveClass, claimResearch, setResearchCard, gainPlausible, gateMove } = await import("./cgo-hypotheses");
      const cls = moveClass(c.target);
      if (cls === "build" && h) {
        const gap = pg.goal.target_value != null && pg.goal.current_value != null ? pg.goal.target_value - pg.goal.current_value : null;
        const live = (hyp.readNow ? await hyp.readNow(h.id) : null) ?? h;
        if (!(await gainPlausible(live, Number(c.body.expected_gain), pg.goal.target_metric, gap, deps.checker))) {
          const line = `Work for ${c.target} on "${pg.goal.objective}": the checker did not agree its expected gain follows from the evidence.`;
          if (enforceGate) {
            refused.push(line);
            continue;
          }
          shadow(line, "gain_not_plausible");
          c.body.gate_would_refuse ??= "gain_not_plausible";
        }
      }
      if (h && hyp.readNow) {
        const { foundersNo } = await import("./cgo-hypotheses");
        const gap = pg.goal.target_value != null && pg.goal.current_value != null ? pg.goal.target_value - pg.goal.current_value : null;
        const nowRow = await hyp.readNow(h.id);
        const again = nowRow
          ? gateMove({ target: c.target, hyp: nowRow, expectedGain: Number(c.body.expected_gain), gap, researchSlotFree: true })
          : ({ ok: false, code: "list_unreadable", reason: "its hypothesis could not be read again" } as const);
        if (!again.ok) {
          const line = `Work for ${c.target} on "${pg.goal.objective}": ${again.reason}.`;
          if (enforceGate || (nowRow && foundersNo(nowRow))) {
            refused.push(line);
            continue;
          }
          shadow(line, again.code);
          c.body.gate_would_refuse ??= again.code;
        }
        if (nowRow) hypById.set(h.id, nowRow);
      }
      let claimed = false;
      if (cls === "research" && h) {
        claimed = await claimResearch(tenant_id, hypById.get(h.id) ?? h);
        if (!claimed) {
          const line = `Work for ${c.target} on "${pg.goal.objective}": a research task is already running for this goal.`;
          if (enforceGate) {
            refused.push(line);
            continue;
          }
          shadow(line, "research_running");
          c.body.gate_would_refuse ??= "research_running";
        }
      }
      let decision_id: string;
      try {
        decision_id = await deps.emitDecision(CGO_CARD_CLASS, c.body);
      } catch (e) {
        if (claimed && h) await setResearchCard(tenant_id, h.id, null);
        throw e;
      }
      if (claimed && h) await setResearchCard(tenant_id, h.id, decision_id || null);
      if (typeof c.body.gate_would_refuse === "string") {
        const { logEvent } = await import("@/services/logging/logEvent");
        await logEvent({
          level: "info",
          source: "cgo.gate",
          code: "would_refuse",
          tenant_id,
          run_id: /^[0-9a-f-]{36}$/i.test(run_id) ? run_id : null,
          meta: {
            gate_reason: c.body.gate_would_refuse,
            target_agent_slug: c.target,
            object_id: decision_id || null,
            hypothesis_ref: typeof c.body.hypothesis_id === "string" ? c.body.hypothesis_id : null,
          },
        });
      }
      const channelRuns = (CGO_ORGANIC_TARGETS.has(c.target) || (adBudget !== null && CGO_AD_TARGETS.has(c.target))) && autorunOn.has(c.target);
      const autoRuns = CGO_AUTO_RUN_TARGETS.has(c.target) || channelRuns;
      if (acts && startsNow && autoRuns && decision_id) {
        const autoRun = deps.autoRun ?? (await import("./cgo-auto-run")).autoRunCgoCard;
        if (await autoRun(tenant_id, decision_id)) {
          changedLines.push(autoRunLine(c.target, String(c.body.intent)));
          const reason = cleanReason(c.note?.why);
          items.push({
            section: "working_on",
            text: `${agentName(c.target)}: ${itemText(c.note?.action, String(c.body.intent))}`,
            ...(reason ? { reason } : {}),
            channel_slug: c.target,
          });
          if (CGO_AD_TARGETS.has(c.target)) adMoved = true;
        }
      }
    }
    const line = pg.statusLine.slice(0, 240);
    const w = await writeAutopilotGoal(tenant_id, {
      op: "update",
      goal_id: pg.goal.id,
      values: { cgo_status_line: line, cgo_status_at: now.toISOString() },
      actor: { source: "cgo", run_id, why: line || "status line" },
    });
    if (w.status === "error") console.warn(`[goal-owner] status line write failed for goal ${pg.goal.id}: ${w.error}`);
    else result.status_lines++;
  }

  for (const w of wouldBlock) console.info(`[cgo-gate-shadow] tenant=${tenant_id} run=${run_id} ${w.code}: ${w.line}`);

  let suggestionWaiting = false;
  if (ended.length > 0 && moves.next_goal) {
    const { count: waiting } = await svc
      .from("autopilot_goals")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant_id)
      .eq("status", "proposed");
    suggestionWaiting = (waiting ?? 0) > 0;
  }
  if (shouldProposeNextGoal(acts, ended.length, moves, suggestionWaiting) && moves.next_goal) {
    const n = moves.next_goal;
    const { error } = await tenantRpc(asTenantId(tenant_id), "propose_next_autopilot_goal", {
      p_tenant_id: tenant_id,
      p_objective: n.objective,
      p_target_metric: n.target_metric,
      p_target_value: n.target_value,
      p_due_date: n.due_date ?? null,
      p_rationale: n.rationale ?? null,
    });
    if (error) console.warn(`[goal-owner] next goal proposal failed: ${error.message}`);
    else result.next_goal_proposed = true;
  }

  if (moves.creator_caps) {
    const { recordCreatorCaps } = await import("@/services/decisions/creator-hire-budget");
    const c = await recordCreatorCaps(tenant_id, { ...moves.creator_caps, run_id: run_id || null });
    if (c.status === "recorded") result.creator_caps_id = c.id;
    else refused.push(`Creator caps: not stored (${c.error}).`);
  }

  const pauseChanges: GoalMoves["channel_changes"] = [];
  for (const cc of moves.channel_changes ?? []) {
    const slug = cc.channel_slug.trim();
    const undecided = CGO_AD_CHANNELS.has(slug)
      ? [...(deps.shownCards ?? new Map<string, ShownCard>())].filter(([id, c]) => c.channel_slug === slug && !worked.decided.has(id))
      : [];
    if (acts && undecided.length > 0) {
      const n = undecided.length;
      refused.push(`Pause ${slug}: ${n} of its open card${n === 1 ? "" : "s"} still wait${n === 1 ? "s" : ""} for a decision.`);
      continue;
    }
    pauseChanges.push(cc);
  }
  const neverApproved = new Set(meta.never_approved ?? []);
  const plannedPauses = planChannelPauses(
    pauseChanges,
    acts,
    neverApproved,
    new Set(meta.founder_channels ?? []),
    new Set(meta.rejected_channels ?? []),
  );
  wouldLines.push(...plannedPauses.wouldLines);
  wouldLines.push(...planned.advice);
  serverAsks.push(...plannedPauses.asks);
  for (const a of plannedPauses.asks) refused.push(`Pause ${a.topic_key.slice("channel:".length)}: it became a question for the founder.`);
  for (const p of plannedPauses.pauses) {
    const { authorizeUnattended } = await import("./unattended-policy");
    const gate = await authorizeUnattended(
      tenant_id,
      { kind: "channel_pause", channel_slug: p.slug, trigger: "review" },
      { channelNeverApproved: neverApproved.has(p.slug), evidence: deps.evidence ?? null, why: p.why, where: "review" },
    );
    if (gate.verdict !== "allow") {
      refused.push(`Pause ${p.name}: left for the founder (${gate.reasons.join(", ")}).`);
      if (gate.verdict === "ask_founder") {
        serverAsks.push({
          required: true,
          topic_key: `channel:${p.slug}`,
          ask: `I think ${p.name} should be paused: ${cutAtWord(p.why, 200)} Pausing it is your call. Should I?`,
          default_action: null,
        });
      }
      continue;
    }
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "pause_channel_by_cgo", {
      p_tenant_id: tenant_id,
      p_channel_slug: p.slug,
      p_reason: p.why,
      p_run_id: run_id,
    });
    if (error) {
      console.warn(`[goal-owner] pause ${p.slug} failed: ${error.message}`);
      continue;
    }
    if (String(data) === "not_plan") {
      const { data: closed, error: cErr } = await tenantRpc(asTenantId(tenant_id), "close_channel_actions_on_cgo_pause", {
        p_tenant_id: tenant_id,
        p_channel_slug: p.slug,
        p_run_id: run_id,
        p_why: p.why,
      });
      if (cErr) {
        console.warn(`[goal-owner] closing ${p.slug} cards failed: ${cErr.message}`);
        refused.push(`Pause ${p.name}: closing its waiting cards failed, try again next review.`);
        continue;
      }
      const n = Number(closed ?? 0);
      if (n > 0) {
        changedLines.push(`Closed ${n} waiting ${p.name} card${n === 1 ? "" : "s"}. ${p.why}`);
        const reason = cleanReason(p.why);
        items.push({ section: "changed", text: `Closed ${n} waiting ${p.name} card${n === 1 ? "" : "s"}`, ...(reason ? { reason } : {}), channel_slug: p.slug });
      }
      else refused.push(`Pause ${p.name}: it is not in the plan and has no waiting cards.`);
      continue;
    }
    const line = pauseOutcomeLine(String(data), p);
    if (line.changed) {
      result.channels_paused++;
      const { error: cErr } = await tenantRpc(asTenantId(tenant_id), "close_channel_actions_on_cgo_pause", {
        p_tenant_id: tenant_id,
        p_channel_slug: p.slug,
        p_run_id: run_id,
        p_why: p.why,
      });
      if (cErr) console.warn(`[goal-owner] closing ${p.slug} cards failed: ${cErr.message}`);
      changedLines.push(line.changed);
      items.push({ section: "changed", text: line.changed, channel_slug: p.slug, undoable: true });
    } else if (line.need) {
      serverAsks.push({ required: true, topic_key: `channel:${p.slug}`, ask: line.need, default_action: null });
      refused.push(`Pause ${p.name}: the founder added it.`);
    } else if (line.refused) {
      refused.push(line.refused);
    }
  }

  const { readQuestions, planQuestionsDetailed, insertQuestions, defaultLine, promoteQueuedQuietly, MAX_QUEUED_QUESTIONS } = await import("./cgo-questions");
  const noPauseDefault = new Set([...(meta.rejected_channels ?? []), ...(meta.founder_channels ?? [])]);
  const modelAsks = planModelQuestions({ moves, goals, today, acts, reviewedRevs: deps.reviewedRevs, rejected: noPauseDefault, neverApproved, adPlan: await adPlanContext(tenant_id, moves, today) });
  refused.push(...modelAsks.refused);
  await promoteQueuedQuietly(tenant_id, now);
  const existingQuestions = await readQuestions(tenant_id, now);
  const { countRuleAsks } = await import("./goal-count-review");
  const liveForCount = goals.filter((g) => endedReason(g, today) === null);
  const needsPaceNumber = (g: GoalRow) => {
    const p = goalPace(g, today);
    return p.days_left != null && p.days_left <= DAILY_REVIEW_MAX_DAYS_LEFT && !paceNumberUsable(g, today);
  };
  const counting = await countRuleAsks({
    tenant_id,
    proposals: moves.goal_count_rules ?? [],
    goals: liveForCount,
    today,
    now,
    openTopics: new Set(existingQuestions.filter((q) => q.status === "open" || q.status === "queued").map((q) => q.topic_key)),
    trusted: (g) => numberTrusted(g, today),
    ageDays: (g) => numberAgeDays(g, today),
    deps: countDeps,
    needsPaceNumber: (g) => needsPaceNumber(g as GoalRow),
  });
  refused.push(...counting.refused);
  const { basisAsk } = await import("./goal-basis");
  const basisAsks = liveForCount.map((g) => basisAsk(g, today, goalRev(g))).filter((q): q is QuestionAsk => q !== null);
  const questionPlan = planQuestionsDetailed([...serverAsks, ...basisAsks, ...counting.asks, ...modelAsks.asks], existingQuestions, now);
  for (const ask of questionPlan.overflow) refused.push(`Question not asked, ${MAX_QUEUED_QUESTIONS} already wait on the founder: "${ask}"`);
  const plannedAsks = questionPlan.planned.map((q) => ({
    ...q,
    default_line: defaultLine(
      q.default_action,
      q.expires_at,
      q.default_action?.kind === "goal_change" ? byId.get(q.default_action.goal_id)?.objective : undefined,
    ),
  }));
  const stored = (await insertQuestions(tenant_id, run_id, plannedAsks)).filter((q) => !q.queued);
  const needLines = stored.map((q) => questionNoteLine(q.ask, (q as { default_line?: string | null }).default_line ?? null, q.why ?? null));
  const saidBefore = new Set((meta.last_need ?? []).map(leftCardKey).filter((k): k is string => k !== null));
  const leftLines = [...new Set(worked.left)].filter((l) => !saidBefore.has(leftCardKey(l) ?? ""));
  const toldBefore = new Set([...worked.leftKeys].filter(([, k]) => saidBefore.has(k)).map(([id]) => id));
  stored.forEach((q, i) => {
    const line = needLines[i];
    const ordinal = (q as { ordinal?: number | null }).ordinal;
    if (line) items.push({ section: "needs_you", text: line, question_ordinal: typeof ordinal === "number" ? ordinal : 100 + i });
  });

  let locationRows: Awaited<ReturnType<typeof import("@/services/ad-locations/service").locationNoteItems>> = [];
  try {
    const { locationNoteItems, countryPhrase } = await import("@/services/ad-locations/service");
    locationRows = await locationNoteItems(tenant_id);
    for (const l of locationRows) {
      items.push({
        section: "needs_you",
        text: `Pick where your ${l.label} show`,
        reason: `Your new campaign runs across ${countryPhrase(l.country)} until you do`,
        channel_slug: l.channel,
        locations: true,
      });
    }
  } catch (e) {
    console.warn(`[goal-owner] ad location rows skipped for ${tenant_id}: ${(e as Error).message}`);
  }

  let noteItems: NoteItem[] | null = null;
  let headline: string | null = null;
  const toldAgain = new Set<string>();
  let day7Told: Array<{ id: string; version: number; text: string }> = [];
  try {
    const cardItems = [...(planItem ? [planItem] : []), ...items];
    const blockedRows = await readBlockedSinceLastNote(tenant_id, now);
    cardItems.push(...blockedRows);
    cardItems.push(...(await readEmailOutcomesSinceLastNote(tenant_id, now)));
    const { day7NoteLines } = await import("@/services/email-results/note");
    const day7 = await day7NoteLines(tenant_id);
    cardItems.push(...day7.lines.map((text): NoteItem => ({ section: "changed", text, channel_slug: "email_marketing" })));
    day7Told = day7.marks.map((m, i) => ({ ...m, text: day7.lines[i] }));
    cardItems.push(...refusedMoveItems(refused));
    if (replied) await replied.settleAndAnswer();
    await finalizeApprovedItems(tenant_id, cardItems);
    const { annotateBudgetNeeds } = await import("./ad-budget-shortfall");
    await annotateBudgetNeeds(tenant_id, cardItems);
    const roots = await readChainRoots(tenant_id, cardItems.flatMap((i) => (i.action_id ? [i.action_id] : [])));
    noteItems = buildNoteItems(
      cardItems.map((i) => (i.action_id ? { ...i, chain_root_id: roots.get(i.action_id) ?? i.action_id } : i)),
      new Set([...worked.blocked, ...blockedRows.flatMap((b) => (b.action_id ? [b.action_id] : []))]),
    );
    const built = noteItems;
    noteItems = await markNoteBlockers(tenant_id, built, stored, now, toldBefore);
    const kept = new Set(noteItems.flatMap((i) => (i.action_id ? [i.action_id] : [])));
    for (const i of built) if (i.section === "needs_you" && i.action_id && !kept.has(i.action_id)) toldAgain.add(i.action_id);
    const own = replied?.unfulfilled || scoped.refused.length > 0 ? null : validHeadline(moves.note?.headline);
    headline = noteHeadline(own, noteItems);
  } catch (e) {
    noteItems = null;
    headline = null;
    const msg = (e as Error).message ?? String(e);
    const { logEvent } = await import("@/services/logging/logEvent");
    await logEvent({
      level: "error",
      source: "cgo.note",
      code: "note_items_failed",
      tenant_id,
      run_id: /^[0-9a-f-]{36}$/i.test(run_id) ? run_id : null,
      error: e,
      meta: { error_class: e instanceof Error ? e.constructor.name : typeof e },
    }).catch(() => undefined);
    const { error: alertErr } = await tenantRpc(asTenantId(tenant_id), "enqueue_ops_alert", {
      p_dedupe_key: `note_items:${run_id}`,
      p_source: "cgo.note",
      p_code: "note_items_failed",
      p_tenant_id: tenant_id,
      p_msg: `run=${run_id}: ${msg.slice(0, 300)}`,
    }).then(
      (r) => r,
      (err: Error) => ({ error: { message: err.message } }),
    );
    if (alertErr) console.warn(`[goal-owner] run ${run_id}: note items alert enqueue failed: ${alertErr.message}`);
  }

  const { clampNextReviewDays } = await import("./cgo-watch");
  const note = planNote({
    meta: debtHigh ? { ...meta, behind_pace: true } : meta,
    moves,
    saw: meta.saw ?? [],
    changedLines,
    wouldLines,
    needLines,
    leftLines: leftLines.filter((l) => {
      const key = leftCardKey(l);
      return !key || ![...toldAgain].some((id) => worked.leftKeys.get(id) === key);
    }),
    refused,
    now,
    reviewDays: clampNextReviewDays(moves.next_review_in_days, { allowDaily: meta.behind_required_near === true || debtHigh }),
    items: noteItems,
    headline,
  });
  result.note_visible = isNoteVisible(note);
  const refusedTexts = new Set(refusedMoveItems(refused).map((i) => i.text));
  const blockedToTell = (note.items ?? []).some((i) => i.section === "blocked" && !refusedTexts.has(i.text));
  const heldToTell = [...(worked.held ?? [])].some((id) => !toldBefore.has(id));
  result.note_notify =
    deps.notify !== false && result.note_visible &&
    (!meta.ads_clock || adMoved || stored.length > 0 || result.channels_paused > 0 || result.goals_changed > 0 || result.goals_ended > 0 || blockedToTell || heldToTell);
  const { data: noteRow, error: noteErr } = await svc
    .from("cgo_notes")
    .insert({ tenant_id, run_id, ...note, notified: false, notification_key: result.note_notify ? `review:${run_id}` : null })
    .select("id")
    .maybeSingle<{ id: string }>();
  if (noteErr?.code === "23505") {
    const existing = await readPriorNote();
    if (existing.error) throw new Error(`goal-owner: prior note read failed: ${existing.error.message}`);
    if (existing.data) return reuseNote(existing.data);
  }
  if (noteErr) throw new Error(`goal-owner: note write failed: ${noteErr.message}`);
  result.note_id = noteRow?.id ?? null;
  const toldLocations = locationRows.filter((l) => (note.items ?? []).some((i) => i.locations === true && i.channel_slug === l.channel));
  if (toldLocations.length) {
    const { markLocationsNoted } = await import("@/services/ad-locations/service");
    await markLocationsNoted(tenant_id, toldLocations);
  }
  const day7InNote = day7Told.filter((d) => (note.items ?? []).some((i) => i.text === d.text));
  if (day7InNote.length) {
    const { markDay7Told } = await import("@/services/email-results/note");
    await markDay7Told(tenant_id, day7InNote.map((d) => ({ id: d.id, version: d.version })));
  }

  const { count } = await svc
    .from("decisions")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenant_id)
    .eq("agent_run_id", run_id)
    .eq("decision_class", CGO_CARD_CLASS)
    .eq("status", "proposed");
  result.cards_emitted = count ?? 0;
  return result;
}
