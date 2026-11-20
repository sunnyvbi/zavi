
import {
  actionsStoreFor,
  anyChannelUsesChannelActions,
  coerceActionType,
  isActionType,
  isCustomerChannelAction,
  getChannel,
  adChangeHeadline,
  adCardTitle,
  phoneApprovesExec,
  type ActionType,
} from "@zavi/shared";
import { approveMoney, channelActionNeedsAdmin, type ApproveMoney } from "./approve-role";
import { AD_LABELS, actionLabel } from "./action-label";
import { recommendation } from "./ad-review/recommendation";
import { withAdReview } from "./ad-review-presentation";
import { actionLinkForStep } from "./action-link";
import { asksFounderForAnswer, cardPresentation, cardRole, nameCrossRefs, SITE_KINDS, type CardKind, type CardPresentation } from "./card-presentation";
import { siteBuilderFor } from "./site-builder";
import type { SiteBuilder } from "./site-builder-markers";
import { attachRunImages, loadRunImages, signActionMedia, type RunImage } from "./action-media";
import { deriveActionType } from "./action-type";
import { isValidTz, localWallToUtc, tzOffsetMinutes } from "@/services/agents/reminders";
import { DEFAULT_TENANT_TZ } from "@/services/tenants/local-day";
import {
  CARD_INTENTS,
  LONG_FORM_CONTENT_MAX,
  channelRecipeStepEnvelopeSchema,
  publishOnSchema,
  recipeStepSchema,
  type CardIntent,
  type ChannelMetric,
  type RecipeStepDecisionBody,
} from "@/agents/lib/channel-recipe-step";
import { trackChannelActionProposed } from "@/services/analytics/action-events";
import { classifyGoalMetricKey } from "@/services/analytics/metric-registry";
import { figureWasRead, ledgerIsEmpty } from "@/services/agents/engine/figure-ledger";
import { asTenantId, tenantClient, tenantRpc, type TenantId } from "@/services/tenant-client";
import { previewRunStarts } from "./preview-run-starts";
import { planIncludesChannel } from "@/services/growth/preview-plan";
import { PREVIEW_RUN_KEY_PREFIX, previewRunKey } from "@/services/billing/tiers";
import { logEvent } from "@/services/logging/logEvent";
import { isOpenAction, rankActions, splitOverCap } from "./rank-actions";
import { maxMoneyAtStake, moneyAtStakeUsd } from "./money-at-stake";
import { execVerdictOf, fixWords, type ExecBucket, type ExecFix } from "./exec-failure";
import { execPlatformLabel } from "./exec-kill-switch";
import { briefOfBody, type CardBrief } from "./card-brief";
import { actionExecReceipt, type ExecReceipt } from "./exec-receipt";
import { channelApproveNeedsAdmin } from "./approve-needs-admin";
import { COMPLETED_LOOKBACK_DAYS, COMPLETED_READ_CAP, COMPLETED_SHOW_DAYS, IN_CHUNK, ROW_PAGE, outcomeOf, pickCompleted, type CardOutcome, type OutcomeSource } from "./completed-actions";
import { testStopCardLine } from "@/services/growth/test-stops";
import { readMoveLaunches } from "@/services/growth/cgo-tests";
import { withCardTimelines, type ApprovalRow, type CardApproval, type TimelineEntry } from "./card-timeline";
import { MONEY_AT_STAKE_KEY } from "./money-at-stake-card";
import { SCORE_VERSION, scoreAction, titleKey, type ScoreInputs } from "./score-action";
import { normalizeUuid, supersededOpenCards, type OpenCard } from "./supersede-actions";
import {
  hasMatchCandidates,
  isDropped,
  isReplace,
  loadMatchPool,
  matchRunCards,
  matcherEnabled,
  summarize,
  type CardTarget,
  type MatchPool,
} from "./card-matcher";
import { targetKeyOf } from "./exec-card-identity";
import { alertRematchExhausted } from "./card-rematch";
import { SUBJECT_REFS_KEY, cardSubjectRefs, chatTwinOfExec, envelopeOfExec, pointerOfExec } from "@/services/growth/open-advice";

export async function channelSlugForRun(tid: TenantId, runId: string): Promise<string | null> {
  const { data, error } = await tenantClient(tid)
    .from("agent_runs")
    .select("channel_slug")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(`channel stamp read failed: ${error.message}`);
  const slug = (data as { channel_slug?: string | null } | null)?.channel_slug;
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}

export async function switchedChannelForRun(
  tenantId: string,
  runId: string,
): Promise<string | null> {
  if (!anyChannelUsesChannelActions()) return null;
  const slug = await channelSlugForRun(asTenantId(tenantId), runId);
  if (!slug) return null;
  return actionsStoreFor(slug) === "channel_actions" ? slug : null;
}

export type ScoreContext = {
  channel_in_plan: boolean;
  goal_metric_keys: ReadonlySet<string>;
  rejected_title_keys: ReadonlySet<string>;
  rejected_ids: ReadonlySet<string>;
};

export async function loadScoreContext(tid: TenantId, channelSlug: string): Promise<ScoreContext> {
  const sb = tenantClient(tid);
  const [plan, goals, rejected] = await Promise.all([
    sb.from("tenant_channels").select("plan_selected").eq("channel_slug", channelSlug).maybeSingle(),
    sb.from("autopilot_goals").select("target_metric").eq("status", "active").limit(50),
    sb
      .from("channel_actions")
      .select("id, title_key")
      .eq("channel_slug", channelSlug)
      .eq("status", "rejected")
      .limit(500),
  ]);
  if (plan.error || goals.error || rejected.error) {
    console.warn(
      `[channel-actions] score context partial for ${channelSlug}: ${
        plan.error?.message ?? goals.error?.message ?? rejected.error?.message
      }`,
    );
  }
  const goalKeys = new Set<string>();
  for (const g of (goals.data ?? []) as Array<{ target_metric?: string | null }>) {
    const k = typeof g.target_metric === "string" ? classifyGoalMetricKey(g.target_metric) : null;
    if (k) goalKeys.add(k);
  }
  const rows = (rejected.data ?? []) as Array<{ id: string; title_key: string }>;
  return {
    channel_in_plan: (plan.data as { plan_selected?: boolean } | null)?.plan_selected === true,
    goal_metric_keys: goalKeys,
    rejected_title_keys: new Set(rows.map((r) => r.title_key)),
    rejected_ids: new Set(rows.map((r) => r.id)),
  };
}

export function metricMatchesGoal(impactReason: string | null, goalKeys: ReadonlySet<string>): boolean {
  if (!impactReason || goalKeys.size === 0) return false;
  const k = classifyGoalMetricKey(impactReason);
  return k !== null && goalKeys.has(k);
}

export function scoreFor(
  a: {
    impact: number | null;
    impact_reason: string | null;
    position: number;
    run_of: number;
    title_key: string;
    repeat_of: string | null;
    money_at_stake_usd?: number | null;
    money_at_stake_max_usd?: number | null;
  },
  ctx: ScoreContext,
): { score: number; score_inputs: ScoreInputs } {
  return scoreAction({
    impact: a.impact,
    position: a.position,
    run_of: a.run_of,
    channel_in_plan: ctx.channel_in_plan,
    metric_matches_goal: metricMatchesGoal(a.impact_reason, ctx.goal_metric_keys),
    previously_rejected:
      ctx.rejected_title_keys.has(a.title_key) ||
      (a.repeat_of !== null && ctx.rejected_ids.has(a.repeat_of)),
    money_at_stake_usd: a.money_at_stake_usd ?? null,
    money_at_stake_max_usd: a.money_at_stake_max_usd ?? null,
  });
}

export type GroundedMetric = {
  key: string;
  value: number;
  unit?: string;
  source: string;
  window_kind: "point" | "day" | "rolling_7d" | "rolling_30d";
  grounded: boolean;
};

export type LedgerDeps = {
  figureWasRead: (runId: string, figure: string) => boolean;
  ledgerIsEmpty: (runId: string) => boolean;
};

const DEFAULT_LEDGER: LedgerDeps = { figureWasRead, ledgerIsEmpty };

export function groundMetrics(
  runId: string,
  metrics: readonly ChannelMetric[],
  deps: LedgerDeps = DEFAULT_LEDGER,
): { kept: GroundedMetric[]; dropped: number } {
  if (metrics.length === 0) return { kept: [], dropped: 0 };
  if (deps.ledgerIsEmpty(runId)) return { kept: [], dropped: metrics.length };
  const kept: GroundedMetric[] = [];
  let dropped = 0;
  for (const m of metrics) {
    const base = {
      key: m.key,
      value: m.value,
      ...(m.unit ? { unit: m.unit } : {}),
      source: m.source,
      window_kind: m.window_kind ?? "point",
    } as const;
    if (deps.figureWasRead(runId, numberAsRead(m.value))) {
      kept.push({ ...base, grounded: true });
    } else if (m.value >= 0 && m.value <= 9) {
      kept.push({ ...base, grounded: false });
    } else {
      dropped++;
    }
  }
  return { kept, dropped };
}

export function groundRunSummary<T extends { summary?: RecipeStepDecisionBody["summary"] }>(
  runId: string,
  body: T,
  deps: LedgerDeps = DEFAULT_LEDGER,
): T {
  const s = body.summary;
  if (!s) return body;
  const checked = summaryCountFigures(`${s.value} ${s.context}`);
  if (checked.length === 0) return body;
  if (!deps.ledgerIsEmpty(runId) && checked.every((f) => deps.figureWasRead(runId, f))) return body;
  const { summary: _dropped, ...rest } = body;
  return rest as T;
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NOT_A_COUNT = [
  /\b\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\b\d{1,2}:\d{2}\b/g,
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, "gi"),
  /\b\d+(?:\.\d+)?\s*-?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?|quarters?)\b/gi,
];

export function summaryCountFigures(text: string): string[] {
  const t = NOT_A_COUNT.reduce((acc, re) => acc.replace(re, " "), text);
  const out: string[] = [];
  for (const m of t.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    const f = m[0];
    const start = m.index ?? 0;
    const before = t.slice(0, start);
    const after = t.slice(start + f.length);
    if (f.includes(".")) continue;
    if (/[.\d]$/.test(before)) continue;
    if (/[$€£¥₹]\s*$|\b(?:usd|eur|gbp|inr|aud|cad|rs\.?)\s*$/i.test(before)) continue;
    if (/^\s*(?:%|x\b|×|pts?\b|pp\b|bps\b|percent\b|usd\b|eur\b|gbp\b|inr\b|dollars?\b)/i.test(after)) continue;
    if (/^\d{4}$/.test(f) && Number(f) >= 1900 && Number(f) <= 2100) continue;
    if (f.replace(/[^0-9]/g, "").length < 2) continue;
    out.push(f);
  }
  return out;
}

function numberAsRead(value: number): string {
  if (Number.isInteger(value)) return BigInt(Math.round(value)).toString();
  return String(value);
}

export type ChannelRedoTarget = {
  redo_of_action_id: string;
  origin_position?: number | null;
  origin_of?: number | null;
  note?: string | null;
};

export type RecordDeps = {
  rpc?: typeof tenantRpc;
  isPlanRow?: (tid: TenantId, id: string) => Promise<boolean>;
  loadScoreContext?: typeof loadScoreContext;
  ledger?: LedgerDeps;
  stagedPosts?: (tid: TenantId, runId: string) => Promise<StagedPost[]>;
  listOpen?: typeof listChannelActions;
  runImages?: (tid: TenantId, runId: string) => Promise<RunImage[]>;
  siteBuilder?: (tenantId: string) => Promise<SiteBuilder>;
  loadOpenCards?: (tid: TenantId, channelSlug: string, ids: readonly string[]) => Promise<OpenCard[]>;
  loadChatgptExecReferences?: typeof loadChatgptExecReferences;
  runExecs?: (tid: TenantId, runId: string, chat?: { toolCardIds: readonly string[] }) => Promise<RunExec[]>;
  loadMatchPool?: typeof loadMatchPool;
  matchCards?: typeof matchRunCards;
  log?: typeof logEvent;
  track?: typeof trackChannelActionProposed;
  displace?: typeof displaceOverCap;
};

export type RunExec = {
  exec_class: string;
  exec_payload: unknown;
  twin?: "made" | "chat" | "filed";
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXEC_COLS = "exec_class, exec_payload";

function asRunExecs(data: unknown, twin: "made" | "chat" | "filed"): RunExec[] {
  return ((data ?? []) as Array<{ exec_class: string | null; exec_payload: unknown }>)
    .filter((r) => typeof r.exec_class === "string")
    .map((r) => ({ exec_class: r.exec_class as string, exec_payload: r.exec_payload, twin }));
}

export async function loadRunExecs(
  tid: TenantId,
  runId: string,
  chat?: { toolCardIds: readonly string[] },
): Promise<RunExec[]> {
  try {
    const db = tenantClient(tid);
    const made = db
      .from("channel_actions")
      .select(EXEC_COLS)
      .eq("run_id", runId)
      .not("exec_class", "is", null)
      .in("exec_status", ["queued", "dispatching", "executed"])
      .limit(50);
    const proposed = db
      .from("channel_actions")
      .select(EXEC_COLS)
      .eq("run_id", runId)
      .not("exec_class", "is", null)
      .is("exec_status", null)
      .in("status", ["pending", "snoozed"])
      .limit(50);
    if (!chat) {
      const [m, p] = await Promise.all([made, proposed]);
      const err = m.error ?? p.error;
      if (err) throw new Error(err.message);
      return [...asRunExecs(m.data, "made"), ...asRunExecs(p.data, "filed")];
    }
    const ids = [...new Set(chat.toolCardIds.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase()))].slice(0, 50);
    const kept =
      ids.length > 0
        ? db.from("channel_actions").select(EXEC_COLS).in("id", ids).not("exec_class", "is", null).limit(50)
        : Promise.resolve({ data: [], error: null });
    const [m, p, k] = await Promise.all([made, proposed, kept]);
    const err = m.error ?? p.error ?? k.error;
    if (err) throw new Error(err.message);
    return [...asRunExecs(m.data, "chat"), ...asRunExecs(p.data, "chat"), ...asRunExecs(k.data, "chat")];
  } catch (e) {
    console.warn(`[channel-actions] run ${runId} exec rows unreadable; no envelope card dropped: ${(e as Error).message}`);
    return [];
  }
}

const RECORD_ACTIONS_MAX = 20;
const RECORD_STALE_MAX = 30;

export async function loadOpenCards(
  tid: TenantId,
  channelSlug: string,
  ids: readonly string[],
): Promise<OpenCard[]> {
  if (ids.length === 0) return [];
  try {
    const { data, error } = await tenantClient(tid)
      .from("channel_actions")
      .select("id, run_id, status, snoozed_until, exec_status, approved_by, steps_done, edited_body, exec_class, body")
      .in("id", [...ids])
      .eq("channel_slug", channelSlug)
      .in("status", ["pending", "snoozed"])
      .is("exec_status", null)
      .is("approved_by", null);
    if (error) {
      console.warn(`[channel-actions] open-card read failed for ${channelSlug}: ${error.message}`);
      return [];
    }
    return ((data ?? []) as Array<Omit<OpenCard, "customer"> & { body: unknown }>).map(({ body, ...r }) => ({
      ...r,
      customer: isCustomerChannelAction(channelSlug, body),
    }));
  } catch (e) {
    console.warn(`[channel-actions] open-card read threw for ${channelSlug}: ${(e as Error).message}`);
    return [];
  }
}

export async function loadChatgptExecReferences(tid: TenantId, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  try {
    const { data, error } = await tenantClient(tid)
      .from("channel_actions")
      .select("id")
      .in("id", [...ids])
      .eq("channel_slug", "chatgpt_ads")
      .in("status", ["pending", "snoozed"])
      .not("exec_class", "is", null);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Array<{ id: string }>).map(r => r.id);
  } catch (e) {
    console.warn(`[channel-actions] ChatGPT executable references unreadable: ${(e as Error).message}`);
    return [];
  }
}

export type StagedPost = { channel: string; text: string };

export async function loadStagedPosts(tid: TenantId, runId: string): Promise<StagedPost[]> {
  try {
    const { data, error } = await tenantClient(tid)
      .from("decisions")
      .select("body")
      .eq("agent_run_id", runId)
      .eq("decision_class", "social.publish.v2")
      .limit(20);
    if (error) return [];
    const out: StagedPost[] = [];
    for (const row of (data ?? []) as Array<{ body?: Record<string, unknown> | null }>) {
      const body = row.body ?? {};
      const channel = typeof body.channel === "string" ? body.channel : null;
      const text = (body.payload as { text?: unknown } | null)?.text;
      if (channel && typeof text === "string" && text.trim()) out.push({ channel, text: text.trim() });
    }
    return out;
  } catch {
    return [];
  }
}

function copyKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

function fullCopyKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function sameCopy(a: string, b: string): boolean {
  const x = copyKey(a);
  const y = copyKey(b);
  return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
}

function sameFullCopy(a: string, b: string): boolean {
  const x = fullCopyKey(a);
  const y = fullCopyKey(b);
  return !!x && x === y;
}

function decisionPostCopies(body: Record<string, unknown> | null | undefined): string[] {
  const copies: string[] = [];
  for (const source of [body, body?.post_draft_original]) {
    const payload = (source as { payload?: { text?: unknown; thread?: unknown } } | null | undefined)?.payload;
    if (typeof payload?.text !== "string" || !payload.text.trim()) continue;
    copies.push(payload.text);
    if (Array.isArray(payload.thread) && payload.thread.every((part) => typeof part === "string" && part.trim())) {
      copies.push([payload.text, ...payload.thread].join("\n---\n"));
    }
  }
  return [...new Set(copies)];
}

const DECISION_CAN_BE_REPLANNED = new Set(["rejected", "expired", "superseded"]);

export type StagedPairing =
  | { kind: "paired"; decision_id: string; scheduled_at: string | null }
  | { kind: "ambiguous" }
  | { kind: "not_pending"; status: string };

export async function stagedPostsForCards(
  tid: TenantId,
  cards: ReadonlyArray<{ id: string; run_id: string; body: unknown }>,
  opts: { includeDecided?: boolean } = {},
): Promise<Map<string, StagedPairing>> {
  const out = new Map<string, StagedPairing>();
  const withCopy = cards
    .map((c) => {
      const content = (stepOf(c.body)?.deliverable as { content?: unknown } | undefined)?.content;
      return { c, text: typeof content === "string" ? content : "" };
    })
    .filter((x) => x.text.trim().length > 0);
  if (withCopy.length === 0) return out;
  const query = tenantClient(tid)
    .from("decisions")
    .select("id, agent_run_id, body, status")
    .in("agent_run_id", [...new Set(withCopy.map((x) => x.c.run_id))])
    .eq("decision_class", "social.publish.v2")
    .is("superseded_at", null);
  const { data, error } = await (opts.includeDecided ? query : query.eq("status", "proposed")).limit(100);
  if (error) throw new Error(`staged posts read failed: ${error.message}`);
  type Row = { id: string; agent_run_id: string; body?: Record<string, unknown> | null; status?: string | null };
  const rows = (Array.isArray(data) ? data : []) as Row[];
  const candidates = withCopy.map(({ c, text }) => ({
    c,
    pending: rows.filter((d) => {
      return d.agent_run_id === c.run_id && (d.status ?? "proposed") === "proposed" && decisionPostCopies(d.body).some((staged) => sameCopy(staged, text));
    }),
    decided: rows.filter((d) => {
      const status = d.status ?? "proposed";
      return d.agent_run_id === c.run_id
        && status !== "proposed"
        && !DECISION_CAN_BE_REPLANNED.has(status)
        && decisionPostCopies(d.body).some((staged) => sameFullCopy(staged, text));
    }),
  }));
  const claims = new Map<string, number>();
  for (const { pending } of candidates) for (const d of pending) claims.set(d.id, (claims.get(d.id) ?? 0) + 1);
  for (const { c, pending: hits, decided } of candidates) {
    if (hits.length === 0) {
      const closed = decided[0];
      if (opts.includeDecided && closed) {
        out.set(c.id, { kind: "not_pending", status: closed.status ?? "decided" });
      }
      continue;
    }
    if (hits.length > 1 || (claims.get(hits[0].id) ?? 0) > 1) {
      out.set(c.id, { kind: "ambiguous" });
      continue;
    }
    const at = hits[0].body?.scheduled_at;
    out.set(c.id, { kind: "paired", decision_id: hits[0].id, scheduled_at: typeof at === "string" ? at : null });
  }
  return out;
}

export async function tenantTimezone(tid: TenantId): Promise<string> {
  const { data, error } = (await tenantClient(tid).from("tenants").select("timezone").maybeSingle()) as {
    data: { timezone?: string | null } | null;
    error: { message?: string } | null;
  };
  if (error) throw new Error(`tenant timezone read failed: ${error.message ?? "unknown"}`);
  const tz = data?.timezone;
  return typeof tz === "string" && isValidTz(tz) ? tz : DEFAULT_TENANT_TZ;
}

export function dayInZone(iso: string, tz: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function timeInZone(iso: string, tz: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

export const MOVED_POST_LEAD_MINUTES = 15;

function strictLocalWallToUtc(local: string, tz: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(local);
  if (!match) return null;
  const [year, month, day] = match[1].split("-").map(Number);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const wallMs = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (const deltaHours of [-36, -12, 0, 12, 36]) {
    offsets.add(tzOffsetMinutes(tz, new Date(wallMs + deltaHours * 60 * 60_000)));
  }
  const candidates = [...offsets]
    .map((offset) => new Date(wallMs - offset * 60_000))
    .filter((candidate) => dayInZone(candidate.toISOString(), tz) === match[1] && timeInZone(candidate.toISOString(), tz) === `${match[2]}:${match[3]}`);
  const unique = [...new Map(candidates.map((candidate) => [candidate.getTime(), candidate])).values()];
  return unique.length === 1 ? unique[0] : null;
}

export function scheduledAtForDay(day: string, tz: string, nowMs: number = Date.now(), time?: string): string | null {
  const wallTime = time ?? "09:00";
  const at = time === undefined ? localWallToUtc(`${day}T${wallTime}`, tz) : strictLocalWallToUtc(`${day}T${wallTime}`, tz);
  if (at && at.getTime() > nowMs) return at.toISOString();
  return time === undefined ? new Date(nowMs + MOVED_POST_LEAD_MINUTES * 60_000).toISOString() : null;
}

export function stagedChannelForStep(
  deliverableContent: string | null,
  staged: readonly StagedPost[],
): string | null {
  if (!deliverableContent || staged.length === 0) return null;
  const key = copyKey(deliverableContent);
  if (!key) return null;
  const hit = staged.find((s) => {
    const k = copyKey(s.text);
    return k === key || k.startsWith(key) || key.startsWith(k);
  });
  return hit?.channel ?? null;
}

export type RecordResult = {
  inserted: number;
  metrics: number;
  metrics_dropped: number;
  stale_accepted: number;
  stale_dropped: number;
  coerced: number;
  ids: Array<{ position: number; id: string }>;
  kept: Array<{ position: number; id: string }>;
  redone: boolean;
  displaced: number;
};

function capOrder(channelSlug: string, runId: string, actions: ChannelActionView[]): ChannelActionView[] {
  const blocker = (a: ChannelActionView) =>
    a.blocking || (a.exec_status === "failed" && a.exec_bucket === "needs_founder");
  if (channelSlug !== "generated_video" && channelSlug !== "youtube_organic") {
    return [...actions.filter(blocker), ...actions.filter((a) => !blocker(a))];
  }
  const video = (a: ChannelActionView) => channelSlug === "generated_video" || a.action_type === "video_post";
  const rendering = (a: ChannelActionView) => video(a) && (a.exec_status === "queued" || a.exec_status === "dispatching");
  const awaiting = (a: ChannelActionView) => video(a) && !blocker(a) && a.run_id === runId && a.executable && !a.exec_status;
  const rest = actions.filter((a) => !rendering(a));
  return [...rest.filter(blocker), ...rest.filter(awaiting), ...rest.filter((a) => !blocker(a) && !awaiting(a))];
}

export function overCapLoserIds(
  channelSlug: string,
  runId: string,
  actions: ChannelActionView[],
  keep: ReadonlySet<string> = new Set(),
): string[] {
  if (getChannel(channelSlug)?.retain_action_overflow) return [];
  return splitOverCap(
    capOrder(channelSlug, runId, actions.filter((a) => !keep.has(a.id))).filter((a) => isCustomerChannelAction(channelSlug, a.body)),
  ).over.map((a) => a.id);
}

function isLinkedInCampaignDraft(step: RecipeStepDecisionBody["step"]): boolean {
  const p = step.deliverable?.presentation as { type?: unknown; channel?: unknown } | undefined;
  return p?.type === "campaign_draft" && p.channel === "linkedin_ads";
}

const CREATOR_HIRE_EXEC_CLASS = "creator.hire";

async function openCreatorHireIds(tid: TenantId, channelSlug: string): Promise<Set<string>> {
  const { data, error } = await tenantClient(tid)
    .from("channel_actions")
    .select("id")
    .eq("channel_slug", channelSlug)
    .eq("exec_class", CREATOR_HIRE_EXEC_CLASS)
    .in("status", ["pending", "snoozed"]);
  if (error) throw new Error(error.message);
  return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
}

async function founderLinkedInDraftIds(tid: TenantId, actions: ChannelActionView[]): Promise<Set<string>> {
  const drafts = actions.filter((a) => {
    const step = (a.body as Partial<RecipeStepDecisionBody> | null)?.step;
    return !!step && isLinkedInCampaignDraft(step);
  });
  const keep = new Set(drafts.filter((a) => a.executable).map((a) => a.id));
  const runIds = [...new Set(drafts.filter((a) => !a.executable).map((a) => a.run_id))];
  if (runIds.length === 0) return keep;
  const { FOUNDER_DRAFT_RUN_STAGE } = await import("@/services/connectors/linkedin-ads/propose-campaign-draft");
  const { data, error } = await tenantClient(tid)
    .from("agent_runs")
    .select("id")
    .in("id", runIds)
    .eq("agent_definition_hash", FOUNDER_DRAFT_RUN_STAGE);
  if (error) throw new Error(error.message);
  const founderRuns = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
  for (const a of drafts) if (founderRuns.has(a.run_id)) keep.add(a.id);
  return keep;
}

export async function displaceOverCap(
  tid: TenantId,
  channelSlug: string,
  runId: string,
  winnerTitle: string | null,
  deps: {
    rpc?: typeof tenantRpc;
    listOpen?: typeof listChannelActions;
    creatorHireIds?: typeof openCreatorHireIds;
    founderDraftIds?: typeof founderLinkedInDraftIds;
    nowMs?: number;
  } = {},
): Promise<number> {
  if (getChannel(channelSlug)?.retain_action_overflow) return 0;
  const rpc = deps.rpc ?? tenantRpc;
  const listOpen = deps.listOpen ?? listChannelActions;
  try {
    const { actions } = await listOpen(tid, channelSlug, { all: true, nowMs: deps.nowMs ?? Date.now() });
    if (overCapLoserIds(channelSlug, runId, actions).length === 0) return 0;
    const hires = await (deps.creatorHireIds ?? openCreatorHireIds)(tid, channelSlug);
    if (channelSlug === "linkedin_ads") {
      for (const id of await (deps.founderDraftIds ?? founderLinkedInDraftIds)(tid, actions)) hires.add(id);
    }
    const losers = overCapLoserIds(channelSlug, runId, actions, hires);
    if (losers.length === 0) return 0;

    const { data, error } = await rpc(tid, "displace_channel_actions", {
      p_channel_slug: channelSlug,
      p_run_id: runId,
      p_loser_ids: losers,
      p_winner_title: winnerTitle,
    });
    if (error) {
      console.warn(`[channel-actions] displace failed for ${channelSlug}: ${error.message}`);
      return 0;
    }
    const out = (data ?? {}) as { displaced?: number; skipped?: number };
    const n = Number(out.displaced ?? 0);
    if (n > 0 || Number(out.skipped ?? 0) > 0) {
      void logEvent({
        level: "info",
        source: "channel_actions.displace",
        code: "channel.actions_displaced",
        message: `channel=${channelSlug} displaced=${n} skipped=${Number(out.skipped ?? 0)} open_before=${actions.length}`,
        run_id: runId,
        meta: { count: n, total: actions.length },
      });
    }
    return n;
  } catch (e) {
    console.warn(`[channel-actions] displace threw for ${channelSlug}: ${(e as Error).message}`);
    return 0;
  }
}

export async function recordChannelRunActions(
  args: {
    tenantId: string;
    runId: string;
    channelSlug: string;
    envelope: unknown;
    bodies: ReadonlyArray<RecipeStepDecisionBody>;
    redo: ChannelRedoTarget | null;
    topAction?: "rewrite_bio";
    chat?: { toolCardIds: readonly string[] };
  },
  deps: RecordDeps = {},
): Promise<RecordResult> {
  const tid = asTenantId(args.tenantId);
  const rpc = deps.rpc ?? tenantRpc;
  const parsed = channelRecipeStepEnvelopeSchema.safeParse(args.envelope);
  const env = parsed.success ? parsed.data : null;

  const grounded = groundMetrics(args.runId, env?.metrics ?? [], deps.ledger);
  const [ctx, staged] = await Promise.all([
    (deps.loadScoreContext ?? loadScoreContext)(tid, args.channelSlug),
    (deps.stagedPosts ?? loadStagedPosts)(tid, args.runId),
  ]);

  let bodies: ReadonlyArray<RecipeStepDecisionBody>;
  if (args.redo) {
    const planRedo = await (deps.isPlanRow ?? isPlanRow)(tid, args.redo.redo_of_action_id);
    if (planRedo) {
      const plan = args.bodies.find((b) => isPlanBody(b));
      if (!plan) throw new Error("plan redo produced no plan; the current plan is kept");
      bodies = [plan];
    } else {
      bodies = args.bodies.slice(0, 1);
    }
  } else {
    bodies = numberTasksBeforePlans(args.bodies);
  }
  {
    const titles = args.bodies.map((b) => b.step.title);
    bodies = bodies.map((b) => {
      const st = b.step as RecipeStepDecisionBody["step"];
      const title = nameCrossRefs(st.title, titles);
      const body = nameCrossRefs(st.body, titles);
      const how_to = Array.isArray(st.how_to) ? st.how_to.map((l) => nameCrossRefs(l, titles)) : st.how_to;
      const same =
        title === st.title && body === st.body && (how_to === st.how_to || how_to!.every((l, k) => l === st.how_to![k]));
      return same ? b : { ...b, step: { ...st, title, body, ...(how_to ? { how_to } : {}) } };
    });
  }
  const types = bodies.map((b) => {
    const step = b.step as RecipeStepDecisionBody["step"] & { action_type?: string };
    return typeof step.action_type === "string"
      ? coerceActionType(args.channelSlug, step.action_type)
      : deriveActionType(
          args.channelSlug,
          step,
          stagedChannelForStep(step.deliverable?.content ?? null, staged),
        );
  });
  const wantsImage = types.some((t) => t.action_type === "image_post");
  const images = wantsImage ? await (deps.runImages ?? loadRunImages)(tid, args.runId) : [];
  const runMedia = attachRunImages(
    bodies.map((b, i) => {
      const step = b.step as RecipeStepDecisionBody["step"];
      return types[i].action_type === "image_post" ? { content: step.deliverable?.content ?? null, alt: step.title } : null;
    }),
    images,
  );
  const present = (b: RecipeStepDecisionBody, i: number, siteBuilder: SiteBuilder): CardPresentation => {
    const step = b.step as RecipeStepDecisionBody["step"];
    const hasContent = typeof step.deliverable?.content === "string" && step.deliverable.content.trim().length > 0;
    const stepBody = typeof step.body === "string" ? step.body : null;
    const input = {
      channelSlug: args.channelSlug,
      action_type: types[i].action_type,
      executable: false,
      deliverableKind: step.deliverable?.kind ?? null,
      presentationType: step.deliverable?.presentation?.type,
      hasContent,
      deliverableContent: hasContent ? step.deliverable!.content : null,
      stepBody,
      link: actionLinkForStep(args.channelSlug, step),
      siteBuilder,
      structuredSteps: step.how_to ?? null,
      targetKind: step.target?.kind ?? null,
      stepIntent: step.intent ?? null,
      stepOwner: step.owner ?? null,
      title: step.title ?? null,
    };
    const card = cardPresentation(input);
    const answer = asksFounderForAnswer({ intent: card.intent, hasContent, title: step.title, body: stepBody, howTo: step.how_to ?? null });
    return answer ? cardPresentation({ ...input, stepIntent: "answer" }) : card;
  };
  let cards = bodies.map((b, i) => present(b, i, "unknown"));
  const onSite = bodies.some(
    (b, i) =>
      b.step.deliverable?.kind === "code" ||
      cards[i].owner === "developer" ||
      (cards[i].card_kind === "copy_to_site" && SITE_KINDS.has(b.step.deliverable?.kind ?? "")),
  );
  if (onSite) {
    const builder = await (deps.siteBuilder ?? siteBuilderFor)(args.tenantId);
    if (builder !== "unknown") cards = bodies.map((b, i) => present(b, i, builder));
  }
  let coerced = 0;
  const adChannel = args.channelSlug.endsWith("_ads");
  const built = bodies.map((b, i) => {
    const step = b.step as RecipeStepDecisionBody["step"] & {
      action_type?: string;
      impact?: { value: number; reason: string };
      repeat_of?: string;
    };
    const t = types[i];
    if (t.coerced) coerced++;
    const position =
      args.redo && typeof args.redo.origin_position === "number" ? args.redo.origin_position : b.position;
    const run_of = args.redo && typeof args.redo.origin_of === "number" ? args.redo.origin_of : b.of;
    const impact = step.impact && step.impact.reason.trim() ? step.impact.value : null;
    const impact_reason = impact !== null ? step.impact!.reason.trim() : null;
    const key = titleKey(step.title);
    const repeat_of = typeof step.repeat_of === "string" ? step.repeat_of : null;
    const { score, score_inputs } = scoreFor(
      { impact, impact_reason, position, run_of, title_key: key, repeat_of },
      ctx,
    );
    const link = actionLinkForStep(args.channelSlug, step);
    const media = runMedia[i];
    const refs = adChannel ? cardSubjectRefs({ title: step.title, stepBody: step.body, evidence: step.evidence }) : null;
    const hasRefs = !!refs && (refs.ids.length > 0 || refs.names.length > 0);
    return {
      position,
      run_of,
      blocking: step.blocking === true,
      action_type: t.action_type satisfies ActionType,
      title: step.title,
      title_key: key,
      body: {
        ...(args.channelSlug === "email_marketing" ? groundRunSummary(args.runId, b, deps.ledger) : b),
        ...(isLinkedInCampaignDraft(step) && step.responsibility !== "client" ? { step: { ...b.step, responsibility: "client" as const } } : {}),
        ...(link ? { link } : {}),
        ...(media ? { media } : {}),
        ...(hasRefs ? { [SUBJECT_REFS_KEY]: refs } : {}),
        intent: cards[i].intent,
        owner: cards[i].owner,
      },
      impact,
      impact_reason,
      repeat_of,
      redo_of: args.redo?.redo_of_action_id ?? null,
      target_key: targetKeyOf((step as { target?: CardTarget }).target ?? null),
      score,
      score_inputs,
      score_version: SCORE_VERSION,
      card_kind: cards[i].card_kind,
      primary_label: cards[i].primary_label,
      done_label: cards[i].done_label,
      how_to: cards[i].how_to,
    };
  });

  let envelopesDropped = 0;
  let pointersDropped = 0;
  let actions = built;
  if (adChannel && !args.redo) {
    const execs = await (deps.runExecs ?? loadRunExecs)(tid, args.runId, args.chat);
    if (execs.length > 0) {
      actions = built.filter((_a, i) => {
        const step = bodies[i].step as RecipeStepDecisionBody["step"] & { evidence?: unknown };
        const card = { title: step.title, stepBody: typeof step.body === "string" ? step.body : null, evidence: step.evidence };
        const stale = execs.some((e) => (e.twin === "chat" ? chatTwinOfExec(card, e) : e.twin === "filed" ? false : envelopeOfExec(card, e)));
        const hasContent = typeof step.deliverable?.content === "string" && step.deliverable.content.trim().length > 0;
        const pointer =
          !stale &&
          cards[i].intent === "review" &&
          cards[i].owner === "founder" &&
          !hasContent &&
          execs.some((e) => e.twin === "filed" && pointerOfExec({ ...card, targetRef: (step as { target?: CardTarget | null }).target?.ref ?? null }, e));
        if (stale) envelopesDropped++;
        if (pointer) pointersDropped++;
        return !stale && !pointer;
      });
    }
  }

  const base = actions;
  const prepare = async () => {
    let acts = base.map((a) => ({ ...a, judged_ids: null as string[] | null, repeat_matched: false }));
    const matched = new Set<object>();
    if (!args.redo && matcherEnabled()) {
      const eligible = acts
        .map((a, i) => ({ a, ref: `n${i}` }))
        .filter(({ a }) => a.repeat_of === null && !isPlanBody(a.body))
        .filter(({ a }) => !(args.channelSlug === "instagram_organic" && args.topAction === "rewrite_bio" &&
          a.body.step.deliverable?.kind === "page_copy"));
      if (eligible.length > 0) {
        const keys = eligible.map(({ a }) => a.target_key).filter((k): k is string => typeof k === "string");
        const pool: MatchPool = await (deps.loadMatchPool ?? loadMatchPool)(tid, args.channelSlug, Date.now(), keys);
        const fresh = eligible.map(({ a, ref }) => ({
          ref,
          title: a.title,
          summary: summarize(a.body.step.body, a.body.step.deliverable?.label),
          action_type: a.action_type,
          target: (a.body.step as { target?: CardTarget }).target ?? null,
        }));
        const match =
          pool.length > 0 || eligible.length > 1 ? await (deps.matchCards ?? matchRunCards)(args.channelSlug, fresh, pool) : null;
        const judged = pool.readFailed !== true && (match !== null || !hasMatchCandidates(fresh, pool));
        if (judged) {
          for (const { a } of eligible) {
            if (a.target_key === null) continue;
            a.judged_ids = pool.filter((p) => p.status === "open" && targetKeyOf(p.target) === a.target_key).map((p) => p.id);
          }
        }
        if (match) {
          const drop = new Set(match.verdicts.filter(isDropped).map((v) => v.ref));
          const byRef = new Map(eligible.map(({ a, ref }) => [a, ref]));
          if (drop.size > 0) {
            acts = acts.filter((a) => !drop.has(byRef.get(a) ?? ""));
          }
          const replaces = new Map(match.verdicts.filter(isReplace).map((v) => [v.ref, v.match_id as string]));
          for (const a of acts) {
            const oldId = replaces.get(byRef.get(a) ?? "");
            if (oldId === undefined) continue;
            a.repeat_of = oldId;
            a.repeat_matched = true;
            matched.add(a);
          }
          void (deps.log ?? logEvent)({
            level: "info",
            source: "channel_actions.match",
            code: "channel.cards_repeat_dropped",
            message: `channel=${args.channelSlug} checked=${eligible.length} dropped=${drop.size} pool=${pool.length}`,
            run_id: args.runId,
            meta: {
              count: drop.size,
              total: eligible.length,
              input_tokens: match.input_tokens,
              output_tokens: match.output_tokens,
            },
          });
        }
      }
    }

    const incoming = args.redo
      ? []
      : acts
          .slice(0, RECORD_ACTIONS_MAX)
          .filter((a) => a.repeat_of !== null && typeof a.title === "string" && a.title.trim().length > 0)
          .map((a) => ({
            title: a.title,
            repeat_of: normalizeUuid(a.repeat_of),
            customer: isCustomerChannelAction(args.channelSlug, a.body),
            matched: matched.has(a),
          }));
    const referencedIds = [
      ...new Set(incoming.map((n) => n.repeat_of).filter((id): id is string => id !== null)),
    ];
    const open = referencedIds.length === 0 ? [] : await (deps.loadOpenCards ?? loadOpenCards)(tid, args.channelSlug, referencedIds);
    const execIds = new Set(args.channelSlug === "chatgpt_ads" && referencedIds.length > 0
      ? (await (deps.loadChatgptExecReferences ?? loadChatgptExecReferences)(tid, referencedIds)).map(normalizeUuid)
      : []);
    acts = acts.filter(a => a.repeat_of === null || !execIds.has(normalizeUuid(a.repeat_of)));
    const superseded = supersededOpenCards(args.runId, incoming.filter(n => n.repeat_of === null || !execIds.has(n.repeat_of)), open);
    const guarded = new Set(superseded.map((x) => x.action_id));
    const matchedIds = new Set(acts.filter((a) => matched.has(a)).map((a) => normalizeUuid(a.repeat_of)));
    const modelStale = (env?.stale ?? []).filter((s) => {
      const id = normalizeUuid(s.action_id);
      return !matchedIds.has(id) || guarded.has(id);
    });
    const stale = [
      ...modelStale,
      ...superseded.filter((x) => !modelStale.some((s) => normalizeUuid(s.action_id) === x.action_id)),
    ].slice(0, RECORD_STALE_MAX);
    const supersededSent = Math.max(0, stale.length - modelStale.length);
    const retired = new Set(stale.map((x) => normalizeUuid(x.action_id)).filter((id) => guarded.has(id)));
    const replacingPositions = new Set<number>();
    if (matched.size > 0) {
      acts = acts.filter((a) => {
        if (!matched.has(a)) return true;
        const kept = a.repeat_of !== null && retired.has(normalizeUuid(a.repeat_of));
        if (kept) replacingPositions.add(a.position);
        return kept;
      });
    }
    return { actions: acts, stale, supersededSent, replacingPositions };
  };

  const record = (p: Awaited<ReturnType<typeof prepare>>) =>
    rpc(tid, "record_channel_run_actions", {
      p_run_id: args.runId,
      p_actions: p.actions,
      p_metrics: grounded.kept,
      p_stale: p.stale,
    }).then(({ data, error }) => {
      if (error) throw new Error(`record_channel_run_actions failed: ${error.message}`);
      return data;
    });
  const rematchOf = (d: unknown): number[] | null => {
    const r = (d ?? {}) as { rematch?: unknown; positions?: unknown };
    if (r.rematch !== true) return null;
    return Array.isArray(r.positions) ? r.positions.filter((x): x is number => typeof x === "number") : [];
  };

  let planned = await prepare();
  let data = await record(planned);
  let rematches = 0;
  if (rematchOf(data) !== null) {
    rematches++;
    void (deps.log ?? logEvent)({
      level: "info",
      source: "channel_actions.match",
      code: "channel.card_rematch",
      message: `channel=${args.channelSlug} positions=${rematchOf(data)!.join(",")} attempt=1`,
      tenant_id: args.tenantId,
      run_id: args.runId,
    });
    planned = await prepare();
    data = await record(planned);
  }
  const contested = new Set<number>();
  while (rematchOf(data) !== null) {
    rematches++;
    const positions = rematchOf(data)!.filter((p) => !contested.has(p));
    if (positions.length === 0) {
      throw new Error("record_channel_run_actions: re-match named no new position");
    }
    if (contested.size === 0) {
      await alertRematchExhausted({ tenantId: args.tenantId, runId: args.runId, channelSlug: args.channelSlug, scope: "run", positions }, { rpc, ...(deps.log ? { log: deps.log } : {}) });
    }
    positions.forEach((p) => contested.add(p));
    const unmatched = new Set(
      planned.actions
        .filter((a) => contested.has(a.position) && a.repeat_matched && a.repeat_of !== null)
        .map((a) => normalizeUuid(a.repeat_of as string)),
    );
    const modelFlagged = new Set((env?.stale ?? []).map((x) => normalizeUuid(x.action_id)));
    const keptStale = planned.stale.filter((x) => {
      const id = normalizeUuid(x.action_id);
      return !unmatched.has(id) || modelFlagged.has(id);
    });
    planned = {
      ...planned,
      supersededSent: planned.supersededSent - (planned.stale.length - keptStale.length),
      actions: planned.actions.map((a) =>
        contested.has(a.position)
          ? { ...a, judged_ids: null, repeat_matched: false, repeat_of: a.repeat_matched ? null : a.repeat_of }
          : a,
      ),
      stale: keptStale,
      replacingPositions: new Set([...planned.replacingPositions].filter((pos) => !contested.has(pos))),
    };
    data = await record(planned);
  }
  actions = planned.actions;
  const { supersededSent, replacingPositions } = planned;
  const out = (data ?? {}) as Partial<RecordResult> & {
    coerced?: number;
    metrics_dropped?: number;
    replacements_refused?: number;
    replaced?: number;
  };
  const rows = (Array.isArray(out.ids) ? out.ids : []) as Array<{ position: number; id: string; kept?: boolean }>;
  const replacementsRefused = Number(out.replacements_refused ?? 0);
  const result: RecordResult = {
    inserted: Number(out.inserted ?? 0),
    metrics: Number(out.metrics ?? 0),
    metrics_dropped: grounded.dropped + Number(out.metrics_dropped ?? 0),
    stale_accepted: Number(out.stale_accepted ?? 0),
    stale_dropped: Number(out.stale_dropped ?? 0),
    coerced: coerced + Number(out.coerced ?? 0),
    ids: rows.filter((r) => r.kept !== true).map((r) => ({ position: r.position, id: r.id })),
    kept: rows.filter((r) => r.kept === true).map((r) => ({ position: r.position, id: r.id })),
    redone: false,
    displaced: 0,
  };
  const replaced = result.ids.filter((row) => replacingPositions.has(row.position)).length;

  if (result.inserted > 0 && result.inserted === result.ids.length) {
    const typeByPosition = new Map(actions.map((a) => [a.position, a.action_type]));
    for (const row of result.ids) {
      const action_type = typeByPosition.get(row.position);
      if (!action_type) continue;
      (deps.track ?? trackChannelActionProposed)({
        tenant_id: args.tenantId,
        channel_slug: args.channelSlug,
        action_type,
      });
    }
  }

  const newId = result.ids[0]?.id;
  if (args.redo && newId) {
    const res = await rpc(tid, "mark_channel_action_redone", {
      p_old_action_id: args.redo.redo_of_action_id,
      p_new_action_id: newId,
      p_note: args.redo.note ?? null,
    });
    if (res.error) {
      console.warn(`[channel-actions] mark redone failed for ${args.redo.redo_of_action_id}: ${res.error.message}`);
    } else {
      result.redone = (res.data as { ok?: boolean } | null)?.ok === true;
    }
  }

  let planDropped = 0;
  let planDroppedOk = true;
  try {
    const closed = await rpc(tid, "close_dropped_channel_run_cards", { p_run_id: args.runId });
    if (closed.error) throw new Error(closed.error.message);
    planDropped = typeof closed.data === "number" ? closed.data : 0;
  } catch (e) {
    planDroppedOk = false;
    void (deps.log ?? logEvent)({
      level: "warn",
      source: "channel_actions.record",
      code: "channel.plan_dropped_close_failed",
      message: `channel=${args.channelSlug} ${(e as Error).message}`.slice(0, 500),
      tenant_id: args.tenantId,
      run_id: args.runId,
    });
  }

  const displaced = planDroppedOk
    ? await (deps.displace ?? displaceOverCap)(tid, args.channelSlug, args.runId, actions[0]?.title ?? null, {
        rpc,
        listOpen: deps.listOpen,
      })
    : 0;
  result.displaced = displaced;

  void (deps.log ?? logEvent)({
    level: "info",
    source: "channel_actions.record",
    code: "channel.actions_recorded",
    message:
      `channel=${args.channelSlug} inserted=${result.inserted} other_coerced=${result.coerced} ` +
      `metrics=${result.metrics} metrics_dropped=${result.metrics_dropped} ` +
      `stale_accepted=${result.stale_accepted} stale_dropped=${result.stale_dropped} ` +
      `displaced=${result.displaced} superseded_sent=${supersededSent} ` +
      `replaced=${replaced} replacements_refused=${replacementsRefused} ` +
      `layer1_replaced=${Number(out.replaced ?? 0)} kept=${result.kept.length} rematches=${rematches} ` +
      `executed_envelopes_dropped=${envelopesDropped} pointer_cards_dropped=${pointersDropped} plan_dropped=${planDropped}`,
    tenant_id: args.tenantId,
    run_id: args.runId,
    meta: { count: result.inserted, total: actions.length },
  });
  return result;
}

const HISTORY_DAYS = 60;
const HISTORY_ACTIONS = 30;
const HISTORY_METRIC_ROWS = 200;
const HISTORY_METRIC_KEYS = 12;
const HISTORY_RUNS = 6;

type HistoryAction = {
  id: string;
  run_id: string;
  position: number;
  title: string;
  status: string;
  status_at: string | null;
  note: string | null;
  snoozed_until: string | null;
  proposed_at: string;
  intent?: string | null;
  exec_class?: string | null;
  exec_payload?: unknown;
};

type MetricRow = {
  metric_key: string;
  value: number | string;
  unit: string | null;
  window_kind: string;
  day: string;
  grounded: boolean;
};

export type HistoryEvent = {
  action_id: string;
  event: string;
  note: string | null;
  at: string;
  snoozed_until?: string | null;
};

const byNewest = (a: HistoryEvent, b: HistoryEvent): number => Date.parse(b.at) - Date.parse(a.at);

function eventsFor(actionId: string, events: readonly HistoryEvent[]): HistoryEvent[] {
  return events.filter((e) => e.action_id === actionId).sort(byNewest);
}

export function noteShownForClosedAction(
  status: string,
  stateNote: string | null,
  events: readonly HistoryEvent[],
): string | null {
  const evts = [...events].sort(byNewest);
  if (status === "displaced") return evts.find((e) => e.event === "displaced")?.note ?? stateNote;
  if (status === "stale") return evts.find((e) => e.event === "stale_flagged")?.note ?? stateNote;
  if (status === "redone") {
    return (
      evts.find((e) => e.event === "redo_requested")?.note ??
      evts.find((e) => e.event === "redone")?.note ??
      stateNote
    );
  }
  if (status === "rejected" || status === "acted") {
    const hit = evts.find((e) => e.event === status);
    if (hit) return hit.note;
    if (status === "acted" && evts.some((e) => e.event === "executed" || e.event === "exec_failed")) return null;
  }
  return stateNote;
}

function approvalTail(evts: readonly HistoryEvent[]): string | null {
  const approved = evts.find((e) => e.event === "approved");
  const failed = evts.find((e) => e.event === "exec_failed");
  const executed = evts.find((e) => e.event === "executed");
  if (!approved || executed) return null;
  if (failed && Date.parse(failed.at) >= Date.parse(approved.at)) {
    return failed.note ? `OPEN, approved, change failed: ${quoted(failed.note)}` : "OPEN, approved, change failed";
  }
  return "OPEN, approved, change still running";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mmdd = (iso: string | null): string => {
  const m = iso?.match(/^\d{4}-(\d{2})-(\d{2})/);
  const month = m ? MONTHS[Number(m[1]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[2])}` : "?";
};

const quoted = (s: string | null, max = 200): string => JSON.stringify((s ?? "").slice(0, max));

export function latestTwoPerKey(rows: readonly MetricRow[], maxKeys = HISTORY_METRIC_KEYS) {
  const byKey = new Map<string, MetricRow[]>();
  const sorted = [...rows].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  for (const r of sorted) {
    const k = `${r.metric_key}|${r.window_kind}`;
    const list = byKey.get(k) ?? [];
    if (list.length < 2) list.push(r);
    byKey.set(k, list);
  }
  return [...byKey.values()].slice(0, maxKeys).map(([latest, prev]) => ({ latest, prev: prev ?? null }));
}

export function renderChannelHistory(input: {
  actions: readonly HistoryAction[];
  metrics: readonly MetricRow[];
  runs: ReadonlyArray<{ run_id: string; enqueued_at: string }>;
  currentRunId: string;
  events?: readonly HistoryEvent[];
}): string[] {
  const priorRuns = input.runs.filter((r) => r.run_id !== input.currentRunId);
  const lines: string[] = [];
  for (const a of input.actions) {
    const evts = eventsFor(a.id, input.events ?? []);
    const head = `[${a.id}] ${mmdd(a.proposed_at)} #${a.position} ${quoted(adCardTitle(a), 160)}`;
    let tail: string;
    switch (a.status) {
      case "pending":
      case "snoozed": {
        const approval = approvalTail(evts);
        if (approval) {
          tail = a.status === "snoozed" ? `${approval} (snoozed until ${mmdd(a.snoozed_until)})` : approval;
          break;
        }
        if (a.status === "pending" && evts.some((e) => e.event === "approved") && evts.some((e) => e.event === "executed")) {
          tail = "MADE, approved and executed, nothing is waiting on the founder";
          break;
        }
        if (a.status === "snoozed") {
          tail = `OPEN (snoozed until ${mmdd(a.snoozed_until)})`;
          break;
        }
        const proposed = Date.parse(a.proposed_at);
        const since = priorRuns.filter(
          (r) => r.run_id !== a.run_id && Date.parse(r.enqueued_at) > proposed,
        ).length;
        tail = `OPEN, ${since >= HISTORY_RUNS - 1 ? "5+" : since} runs since`;
        break;
      }
      case "acted": {
        const applied = evts.some((e) => e.event === "executed") && !evts.some((e) => e.event === "acted");
        const snooze = evts.find((e) => e.event === "snoozed" && e.snoozed_until);
        const extras: string[] = [];
        if (applied) extras.push("approved change applied");
        if (snooze?.snoozed_until) extras.push(`snoozed until ${mmdd(snooze.snoozed_until)}`);
        tail = `acted ${mmdd(a.status_at)}`;
        if (extras.length > 0) tail += ` (${extras.join("; ")})`;
        break;
      }
      case "rejected": {
        const hit = evts.find((e) => e.event === "rejected");
        const note = hit ? hit.note : a.note;
        tail = note ? `rejected: ${quoted(note)}` : "rejected";
        break;
      }
      case "stale":
        tail = `stale: ${quoted(a.note)}`;
        break;
      case "displaced":
        tail = `displaced ${mmdd(a.status_at)} (outranked, not rejected)`;
        break;
      case "redone": {
        const ask = evts.find((e) => e.event === "redo_requested");
        const verb = a.intent === "answer" ? "answered" : "redone";
        tail = ask?.note ? `${verb} ${mmdd(a.status_at)}: ${quoted(ask.note)}` : `${verb} ${mmdd(a.status_at)}`;
        break;
      }
      default:
        tail = a.status;
    }
    lines.push(`${head}  ${tail}`);
  }
  const pairs = latestTwoPerKey(input.metrics);
  if (pairs.length > 0) {
    const fmt = (r: MetricRow) =>
      `${String(r.value)}${r.unit ? ` ${r.unit}` : ""} (${mmdd(r.day)})${r.grounded ? "" : " (unverified)"}`;
    lines.push(
      `metrics: ${pairs
        .map(({ latest, prev }) => `${latest.metric_key} ${prev ? `${fmt(prev)} -> ` : ""}${fmt(latest)}`)
        .join(" · ")}`,
    );
  }
  return lines;
}

export async function loadChannelHistory(
  tenantId: string,
  channelSlug: string,
  currentRunId: string,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const sb = tenantClient(asTenantId(tenantId));
  const since = new Date(nowMs - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [actions, metrics, runs] = await Promise.all([
    sb
      .from("channel_actions")
      .select("id, run_id, position, title, status, status_at, note, snoozed_until, proposed_at, exec_class, exec_payload, intent:body->>intent")
      .eq("channel_slug", channelSlug)
      .gte("proposed_at", since)
      .order("proposed_at", { ascending: false })
      .limit(HISTORY_ACTIONS),
    sb
      .from("channel_metrics")
      .select("metric_key, value, unit, window_kind, day, grounded")
      .eq("channel_slug", channelSlug)
      .gte("day", since.slice(0, 10))
      .order("day", { ascending: false })
      .limit(HISTORY_METRIC_ROWS),
    sb
      .from("channel_runs")
      .select("run_id, enqueued_at")
      .eq("channel_slug", channelSlug)
      .order("enqueued_at", { ascending: false })
      .limit(HISTORY_RUNS),
  ]);
  if (actions.error || metrics.error || runs.error) {
    throw new Error(
      `channel history read failed: ${actions.error?.message ?? metrics.error?.message ?? runs.error?.message}`,
    );
  }
  const actionRows = (actions.data ?? []) as HistoryAction[];
  const ids = actionRows.map((a) => a.id);
  let events: HistoryEvent[] = [];
  if (ids.length > 0) {
    const ev = await sb
      .from("channel_action_events")
      .select("action_id, event, note, at, snoozed_until")
      .in("action_id", ids)
      .order("at", { ascending: false });
    if (ev.error) throw new Error(`channel history read failed: ${ev.error.message}`);
    events = (ev.data ?? []) as HistoryEvent[];
  }
  const lines = renderChannelHistory({
    actions: actionRows,
    metrics: (metrics.data ?? []) as MetricRow[],
    runs: (runs.data ?? []) as Array<{ run_id: string; enqueued_at: string }>,
    currentRunId,
    events,
  });
  if (channelSlug === BLOG_SLUG) return [...lines, ...(await loadBlogMemory(tenantId))];
  if (channelSlug === "seo") {
    const { loadProofPageLine } = await import("./proof-page");
    return [...lines, await loadProofPageLine(tenantId, nowMs)];
  }
  return lines;
}

const BLOG_SLUG = "blog";
const BLOG_TITLES_CAP = 150;
const BLOG_STRATEGY_CHARS = LONG_FORM_CONTENT_MAX;
const BLOG_STRATEGY_DEAD: ReadonlySet<string> = new Set(["rejected", "redone"]);
const BLOG_KIND = "body->step->deliverable->>kind";
export const BLOG_MEMORY_UNAVAILABLE =
  "blog_memory: could not be read this run. Do not write a new strategy; draft from the clusters you can infer, and say the run could not check for repeats.";

export type BlogTitleRow = {
  title: string;
  status: string;
  note: string | null;
  content: string | null;
  proposed_at: string;
};

export function blogPostTitle(row: Pick<BlogTitleRow, "title" | "content">): string {
  const h1 = row.content?.match(/^#\s+(.+?)\s*$/m)?.[1];
  return h1 && h1.trim() ? h1.trim().slice(0, 200) : row.title;
}
export type BlogStrategyRow = { status: string; proposed_at: string; body: unknown; edited_body: unknown };

function deliverableContent(body: unknown): string | null {
  const d = (body as { step?: { deliverable?: { content?: unknown } } } | null)?.step?.deliverable;
  return typeof d?.content === "string" && d.content.trim() ? d.content : null;
}

export function renderBlogMemory(strategies: BlogStrategyRow[], titles: BlogTitleRow[]): string[] {
  const out: string[] = [];
  const live = strategies.find((r) => !BLOG_STRATEGY_DEAD.has(r.status));
  const text = live ? deliverableContent(live.edited_body) ?? deliverableContent(live.body) : null;
  if (live && text) {
    out.push(
      `blog_strategy (${live.status === "acted" ? "approved" : "not yet approved, still the plan"}, ` +
        `${live.proposed_at.slice(5, 10)}): ${JSON.stringify(text.slice(0, BLOG_STRATEGY_CHARS))}`,
    );
  } else {
    out.push("blog_strategy: none yet. Write one this run.");
  }
  const seen = new Set<string>();
  const seenPrefixes: string[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const clamped = (cardTitle: string) => /\u2026$/.test(cardTitle) && cardTitle.length > 70;
  const unclamp = (s: string) => norm(s).replace(/\u2026$/, "").trim();
  const posts = titles.filter((t) => {
    const refreshOf = t.title.match(/^refresh:\s*(.+)$/i)?.[1];
    if (refreshOf && clamped(t.title)) {
      const prefix = unclamp(refreshOf);
      if ([...seen].some((k) => k.startsWith(prefix)) || seenPrefixes.includes(prefix)) return false;
      seenPrefixes.push(prefix);
      return true;
    }
    const key = norm(refreshOf ?? blogPostTitle(t));
    if (seen.has(key) || seenPrefixes.some((p) => key.startsWith(p))) return false;
    seen.add(key);
    return true;
  });
  if (posts.length > 0) {
    out.push(`blog_titles_so_far (${posts.length}, newest first, date last written; never repeat or near-repeat one):`);
    for (const t of posts) {
      const note = t.note ? ` note=${JSON.stringify(t.note.slice(0, 160))}` : "";
      const refreshOf = t.title.match(/^refresh:\s*(.+)$/i)?.[1];
      const refreshed = /^refresh\b/i.test(t.title) ? " refreshed" : "";
      const was =
        refreshOf && (clamped(t.title) || norm(refreshOf) !== norm(blogPostTitle(t)))
          ? ` was=${JSON.stringify(refreshOf)}`
          : "";
      out.push(`- [${t.status}${refreshed}] ${t.proposed_at.slice(0, 10)} ${JSON.stringify(blogPostTitle(t))}${was}${note}`);
    }
  }
  return out;
}

export async function loadBlogMemory(tenantId: string): Promise<string[]> {
  try {
    const sb = tenantClient(asTenantId(tenantId));
    const [strategies, titles] = await Promise.all([
      sb
        .from("channel_actions")
        .select("status, proposed_at, body, edited_body")
        .eq("channel_slug", BLOG_SLUG)
        .eq(BLOG_KIND, "strategy")
        .order("proposed_at", { ascending: false })
        .limit(10),
      sb
        .from("channel_actions")
        .select("title, status, note, proposed_at, content:body->step->deliverable->>content")
        .eq("channel_slug", BLOG_SLUG)
        .eq(BLOG_KIND, "article")
        .order("proposed_at", { ascending: false })
        .limit(BLOG_TITLES_CAP),
    ]);
    if (strategies.error || titles.error) {
      throw new Error(strategies.error?.message ?? titles.error?.message ?? "read failed");
    }
    return renderBlogMemory(
      (strategies.data ?? []) as BlogStrategyRow[],
      (titles.data ?? []) as BlogTitleRow[],
    );
  } catch (err) {
    console.warn(`[channel-actions] blog memory unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return [BLOG_MEMORY_UNAVAILABLE];
  }
}

export function numberTasksBeforePlans(
  bodies: ReadonlyArray<RecipeStepDecisionBody>,
): RecipeStepDecisionBody[] {
  const tasks = bodies.filter((b) => !isPlanBody(b));
  if (tasks.length === bodies.length) return [...bodies];
  const plans = bodies.filter((b) => isPlanBody(b));
  const of = Math.max(1, tasks.length);
  return [...tasks, ...plans].map((b, i) => ({ ...b, position: i + 1, of }));
}

async function isPlanRow(tid: TenantId, id: string): Promise<boolean> {
  const { data, error } = await tenantClient(tid).from("channel_actions").select("body").eq("id", id).maybeSingle();
  if (error) throw new Error(`redo target read failed: ${error.message}`);
  return isPlanBody((data as { body?: unknown } | null)?.body);
}

export const PLAN_KINDS: ReadonlySet<string> = new Set(["strategy"]);

export function isPlanBody(body: unknown): boolean {
  const kind = (body as { step?: { deliverable?: { kind?: unknown } } } | null)?.step?.deliverable?.kind;
  return typeof kind === "string" && PLAN_KINDS.has(kind);
}

export type ChannelPlan = {
  id: string;
  title: string;
  content: string;
  proposed_at: string;
  status: string;
};

export async function readChannelPlan(tid: TenantId, channelSlug: string): Promise<ChannelPlan | null> {
  try {
    const { data, error } = await tenantClient(tid)
      .from("channel_actions")
      .select("id, title, status, proposed_at, body, edited_body")
      .eq("channel_slug", channelSlug)
      .in(BLOG_KIND, [...PLAN_KINDS])
      .not("status", "in", "(rejected,redone)")
      .order("proposed_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const row = (data ?? [])[0] as
      | { id: string; title: string; status: string; proposed_at: string; body: unknown; edited_body: unknown }
      | undefined;
    if (!row) return null;
    const content = deliverableContent(row.edited_body) ?? deliverableContent(row.body);
    if (!content) return null;
    return { id: row.id, title: row.title, content, proposed_at: row.proposed_at, status: row.status };
  } catch (err) {
    console.warn(`[channel-actions] plan read failed for ${channelSlug}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export type ChannelActionView = {
  ad_recommendation?: { reason: string } | null;
  id: string;
  channel_slug: string;
  run_id: string;
  position: number;
  run_of: number;
  blocking: boolean;
  action_type: ActionType;
  title: string;
  body: unknown;
  status: string;
  note: string | null;
  snoozed_until: string | null;
  impact: number | null;
  impact_reason: string | null;
  score: number;
  score_inputs: unknown;
  proposed_at: string;
  repeat_of: string | null;
  redo_of: string | null;
  executable: boolean;
  exec_status: "queued" | "dispatching" | "executed" | "failed" | null;
  executed_at?: string | null;
  approval?: CardApproval | null;
  timeline?: TimelineEntry[];
  exec_started_at?: string | null;
  outcome?: CardOutcome | null;
  exec_code?: string | null;
  exec_notice?: string | null;
  exec_bucket?: ExecBucket | null;
  exec_checkout_url?: string | null;
  exec_managed?: true;
  exec_fix_text?: string | null;
  exec_fix?: ExecFix | null;
  exec_receipt?: ExecReceipt | null;
  exec_waiting?: "approvals" | null;
  held?: CardHeld | null;
  cap_warning?: string;
  email_card?: boolean;
  approve_on_phone?: boolean;
  approve_needs_admin?: boolean;
  approve_money?: ApproveMoney;
  needs_contact_list?: boolean;
  edited_body: unknown;
  source: "channel_action";
  card_kind: CardKind | null;
  primary_label: string | null;
  done_label: string | null;
  how_to: string[];
  steps_done: number[];
  from_signup_preview_at?: string;
  plan_day: string | null;
  plan_day_source: "scheduled" | "planned" | null;
  plan_time?: string | null;
  plan_timezone?: string | null;
  series: CardSeries | null;
  brief?: CardBrief;
};

export type CardHeld = { words: string[]; evidence: string | null; wallet_short: boolean };

export function heldOf(cgo_hold: unknown, status: string, exec_status: string | null | undefined): CardHeld | null {
  if (status !== "pending" || exec_status != null) return null;
  if (!cgo_hold || typeof cgo_hold !== "object" || Array.isArray(cgo_hold)) return null;
  const h = cgo_hold as { words?: unknown; evidence?: unknown; reasons?: unknown };
  const words = Array.isArray(h.words) ? h.words.filter((w): w is string => typeof w === "string" && w.trim().length > 0).slice(0, 2) : [];
  if (words.length === 0) return null;
  const evidence = typeof h.evidence === "string" && h.evidence.trim() ? h.evidence.trim().slice(0, 300) : null;
  const wallet_short = Array.isArray(h.reasons) && h.reasons.includes("chatgpt_wallet_insufficient");
  return { words, evidence, wallet_short };
}

export type CardSeries = { id: string; name: string; format: string; episode: number; next: string[] };

function stepOf(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const step = (body as { step?: unknown }).step;
  return step && typeof step === "object" && !Array.isArray(step) ? (step as Record<string, unknown>) : null;
}

export function planDay(
  body: unknown,
  scheduledAt: string | null = null,
  tz: string = DEFAULT_TENANT_TZ,
): { plan_day: string | null; plan_day_source: "scheduled" | "planned" | null } {
  if (scheduledAt) {
    const day = dayInZone(scheduledAt, tz);
    if (day) return { plan_day: day, plan_day_source: "scheduled" };
  }
  const p = publishOnSchema.safeParse(stepOf(body)?.publish_on);
  return p.success ? { plan_day: p.data, plan_day_source: "planned" } : { plan_day: null, plan_day_source: null };
}

export function seriesOf(body: unknown): CardSeries | null {
  const raw = stepOf(body)?.series;
  if (raw === undefined || raw === null) return null;
  const r = recipeStepSchema.shape.series.safeParse(raw);
  return r.success && r.data ? { ...r.data, next: r.data.next ?? [] } : null;
}

const ACTION_COLUMNS =
  "id, channel_slug, run_id, position, run_of, blocking, action_type, title, title_key, body, status, note, snoozed_until, impact, impact_reason, score, score_inputs, proposed_at, repeat_of, redo_of, exec_class, exec_payload, exec_status, exec_result, edited_body, card_kind, primary_label, done_label, how_to, steps_done, cgo_hold, approved_by, approved_by_source, exec_claimed_at";

function withStepTitle(body: unknown, title: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const step = b.step && typeof b.step === "object" && !Array.isArray(b.step) ? (b.step as Record<string, unknown>) : null;
  return step ? { ...b, step: { ...step, title } } : b;
}

export function toActionView(
  r: Omit<
    ChannelActionView,
    | "source"
    | "executable"
    | "approve_needs_admin"
    | "exec_status"
    | "exec_code"
    | "exec_notice"
    | "exec_bucket"
    | "exec_checkout_url"
    | "exec_fix_text"
    | "exec_fix"
    | "exec_receipt"
    | "exec_waiting"
    | "held"
    | "edited_body"
    | "card_kind"
    | "primary_label"
    | "done_label"
    | "how_to"
    | "steps_done"
    | "plan_day"
    | "plan_day_source"
    | "series"
    | "approval"
    | "timeline"
    | "exec_started_at"
    | "executed_at"
  > & {
    approved_by?: string | null;
    approved_by_source?: string | null;
    exec_claimed_at?: string | null;
    executed_at?: string | null;
    exec_result?: unknown;
    card_kind?: CardKind | null;
    primary_label?: string | null;
    done_label?: string | null;
    how_to?: unknown;
    steps_done?: unknown;
    title_key?: string;
    exec_class?: string | null;
    exec_payload?: unknown;
    exec_status?: ChannelActionView["exec_status"];
    edited_body?: unknown;
    cgo_hold?: unknown;
  },
  score: number,
  score_inputs: unknown,
): ChannelActionView {
  const {
    title_key: _k,
    exec_payload: previewPayload,
    exec_class,
    exec_status,
    exec_result,
    edited_body,
    card_kind,
    primary_label,
    done_label,
    how_to,
    steps_done,
    cgo_hold,
    approved_by: _by,
    approved_by_source: _src,
    exec_claimed_at: _claimed,
    executed_at,
    ...rest
  } = r;
  void _k;
  void _by;
  void _src;
  void _claimed;
  const verdict = execVerdictOf(exec_status, exec_result);
  const adRecommendation = getChannel(rest.channel_slug)?.category === "paid" ? recommendation({ ...rest, score, score_inputs, exec_status: exec_status ?? null }) : null;
  const adTitle = typeof exec_class === "string" ? adChangeHeadline(exec_class, previewPayload) : null;
  const words = servedCardWords(card_kind, primary_label, done_label, how_to, rest.action_type, rest.body, exec_class);
  const servedBody = withAdReview(withExecResponsibility(withRole(
    withActionLabel(withoutFrozenPeople(withoutSubjectRefs(withoutMoneyAtStake(adTitle ? withStepTitle(rest.body, adTitle) : rest.body)), exec_class), rest.action_type, adTitle ?? rest.title, exec_class),
    rest.action_type,
    typeof exec_class === "string" && exec_class.length > 0,
  ), exec_class), exec_class, previewPayload);
  return {
    ...rest,
    ...(adTitle ? { title: adTitle } : {}),
    body: servedBody,
    score,
    score_inputs,
    ...(adRecommendation ? { ad_recommendation: adRecommendation } : {}),
    executable: typeof exec_class === "string" && exec_class.length > 0,
    ...(typeof exec_class === "string" && channelApproveNeedsAdmin(exec_class, previewPayload) ? { approve_needs_admin: true } : {}),
    exec_status: exec_status ?? null,
    ...(exec_status === "executed" && executed_at ? { executed_at } : {}),
    exec_code:
      exec_status === "failed" && exec_result && typeof exec_result === "object" &&
      typeof (exec_result as { code?: unknown }).code === "string"
        ? (exec_result as { code: string }).code
        : null,
    ...(exec_status === "executed" && exec_class === "linkedin_ads.set_status" && exec_result && typeof exec_result === "object" &&
    typeof (exec_result as { notice?: unknown }).notice === "string"
      ? { exec_notice: (exec_result as { notice: string }).notice }
      : {}),
    exec_bucket: verdict?.bucket ?? null,
    exec_checkout_url:
      exec_status === "failed" && exec_result && typeof exec_result === "object" &&
      typeof (exec_result as { checkout_url?: unknown }).checkout_url === "string" &&
      (exec_result as { checkout_url: string }).checkout_url.startsWith("https://checkout.stripe.com/")
        ? (exec_result as { checkout_url: string }).checkout_url
        : null,
    ...(exec_status === "failed" && exec_result && typeof exec_result === "object" && (exec_result as { managed?: unknown }).managed === true ? { exec_managed: true as const } : {}),
    exec_fix_text:
      verdict?.bucket === "needs_founder" ? fixWords(verdict.fix, execPlatformLabel(typeof exec_class === "string" ? exec_class : ""), verdict.platform_code) : null,
    exec_fix: verdict?.bucket === "needs_founder" ? verdict.fix : null,
    exec_receipt:
      exec_status === "executed" && exec_result && typeof exec_result === "object"
        ? actionExecReceipt(exec_class, exec_result)
        : null,
    exec_waiting:
      exec_status === "dispatching" && exec_result && typeof exec_result === "object" &&
      (exec_result as { site_pr_waiting?: unknown }).site_pr_waiting === "approvals"
        ? "approvals"
        : null,
    held: heldOf(cgo_hold, rest.status, exec_status),
    edited_body: edited_body ?? null,
    ...(exec_class === "email_campaign.create_and_send" ? { email_card: true } : {}),
    ...(typeof exec_class === "string" && phoneApprovesExec(exec_class) ? phoneApproveFields(exec_class, previewPayload, rest.body, rest.channel_slug) : {}),
    source: "channel_action",
    ...words,
    brief: briefOfBody(adTitle ?? rest.title, servedBody, words.how_to),
    steps_done: Array.isArray(steps_done) ? steps_done.filter((x): x is number => Number.isInteger(x)) : [],
    ...planDay(rest.body),
    series: seriesOf(rest.body),
  };
}

const EMAIL_SEND_CLASS = "email_campaign.create_and_send";
const EMAIL_SEND_LABEL = "Send email";
const FROZEN_PEOPLE_LABEL = /^Send to [\d,]+ (?:person|people)$/;

export function emailSendLabel(primary_label: string | null, exec_class: string | null | undefined): string | null {
  return exec_class === EMAIL_SEND_CLASS && primary_label !== null && FROZEN_PEOPLE_LABEL.test(primary_label) ? EMAIL_SEND_LABEL : primary_label;
}

export function withoutFrozenPeople<T>(body: T, exec_class: string | null | undefined): T {
  if (exec_class !== EMAIL_SEND_CLASS || !body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const clean = (v: unknown) => (typeof v === "string" ? v.replace(/, [\d,]+ (?:person|people) today\./, ".") : v);
  const ec = b.exact_change as { rows?: unknown } | null | undefined;
  const step = b.step as Record<string, unknown> | null | undefined;
  return {
    ...b,
    ...("change_sentence" in b ? { change_sentence: clean(b.change_sentence) } : {}),
    ...(ec && Array.isArray(ec.rows) ? { exact_change: { ...ec, rows: ec.rows.filter((r) => (r as { item?: unknown } | null)?.item !== "People") } } : {}),
    ...(step && typeof step === "object" ? { step: { ...step, body: clean(step.body) } } : {}),
  } as T;
}

export function servedCardWords(
  card_kind: CardKind | null | undefined,
  primary_label: string | null | undefined,
  done_label: string | null | undefined,
  how_to: unknown,
  action_type: string,
  body: unknown,
  exec_class: string | null | undefined,
): { card_kind: CardKind | null; primary_label: string | null; done_label: string | null; how_to: string[] } {
  const steps = Array.isArray(how_to) ? how_to.filter((x): x is string => typeof x === "string") : [];
  if (!(card_kind && primary_label && done_label)) return { card_kind: null, primary_label: null, done_label: null, how_to: steps };
  if (exec_class === EMAIL_SEND_CLASS && FROZEN_PEOPLE_LABEL.test(primary_label)) {
    return { card_kind, primary_label: EMAIL_SEND_LABEL, done_label, how_to: steps.map((line) => line.replace(`Press ${primary_label}.`, `Press ${EMAIL_SEND_LABEL}.`)) };
  }
  if (card_kind !== "executes" || !exec_class || !AD_LABELS.has(primary_label)) return { card_kind, primary_label, done_label, how_to: steps };
  const ec = (body as { exact_change?: { rows?: Array<{ item: string; before: string; after: string }> } } | null)?.exact_change;
  const live = actionLabel({ action_type, title: "", rows: ec?.rows ?? null, exec_class });
  if (live === primary_label) return { card_kind, primary_label, done_label, how_to: steps };
  return { card_kind, primary_label: live, done_label, how_to: steps.map((line) => line.replace(`Press ${primary_label}.`, `Press ${live}.`)) };
}

function withActionLabel(body: unknown, action_type: string, title: string, exec_class?: string | null): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const ec = b.exact_change as { rows?: Array<{ item: string; before: string; after: string }> } | null | undefined;
  return { ...b, action_label: actionLabel({ action_type, title, rows: ec?.rows ?? null, exec_class: exec_class ?? null }) };
}

function withExecResponsibility(body: unknown, execClass: unknown): unknown {
  if (typeof execClass !== "string" || !execClass.startsWith("chatgpt_ads.")) return body;
  const b = (body ?? {}) as { step?: Record<string, unknown> };
  return { ...b, step: { ...b.step, responsibility: "client" } };
}

function withRole(body: unknown, action_type: string, executable: boolean): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  if (typeof b.intent === "string" && typeof b.owner === "string") return body;
  const step = (b.step ?? {}) as {
    deliverable?: { kind?: unknown } | null;
    target?: { kind?: unknown } | null;
    intent?: unknown;
    owner?: unknown;
  };
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const role = cardRole({
    action_type,
    executable,
    deliverableKind: str(step.deliverable?.kind),
    targetKind: str(step.target?.kind),
    stepIntent: (CARD_INTENTS as readonly string[]).includes(str(step.intent) ?? "") ? (step.intent as CardIntent) : null,
    stepOwner: step.owner === "founder" || step.owner === "developer" ? step.owner : null,
    siteBuilder: "unknown",
  });
  return { ...b, intent: role.intent, owner: role.owner };
}

function withoutSubjectRefs(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  if (!(SUBJECT_REFS_KEY in b)) return body;
  const { [SUBJECT_REFS_KEY]: _refs, ...rest } = b;
  void _refs;
  return rest;
}

function withoutMoneyAtStake(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  if (!(MONEY_AT_STAKE_KEY in b)) return body;
  const { [MONEY_AT_STAKE_KEY]: _stake, ...rest } = b;
  void _stake;
  return rest;
}

const LIST_READ_CAP = 500;

export type PanelRow = Omit<ChannelActionView, "source" | "executable" | "plan_day" | "plan_day_source" | "series" | "held" | "approval" | "timeline" | "exec_started_at"> & {
  title_key: string;
  exec_class: string | null;
  exec_payload: unknown;
  cgo_hold?: unknown;
  approved_by?: string | null;
  approved_by_source?: string | null;
  exec_claimed_at?: string | null;
};

export function projectChannelPanel(
  channelSlug: string,
  openRows: ReadonlyArray<PanelRow>,
  ctx: ScoreContext,
  rankOpts: { nowMs: number; all?: boolean },
): { actions: ChannelActionView[]; more: number } {
  const raw = openRows.filter((r) => !isPlanBody(r.body));
  const priced = raw.map((r) => moneyAtStakeUsd(r.exec_class, r.exec_payload, r.body));
  const moneyMax = maxMoneyAtStake(priced);
  const rows = raw.map((r, i) => {
    const { score, score_inputs } = scoreFor(
      {
        impact: r.impact,
        impact_reason: r.impact_reason,
        position: r.position,
        run_of: r.run_of,
        title_key: r.title_key,
        repeat_of: r.repeat_of,
        money_at_stake_usd: priced[i]?.monthly_usd ?? null,
        money_at_stake_max_usd: moneyMax,
      },
      ctx,
    );
    return toActionView(r, score, score_inputs);
  });
  const customer = rankActions(rows.filter(r => isCustomerChannelAction(channelSlug, r.body)), rankOpts);
  const notes = rankActions(rows.filter(r => !isCustomerChannelAction(channelSlug, r.body)), { ...rankOpts, all: true });
  return { actions: [...customer.actions, ...notes.actions], more: customer.more };
}

const CGO_MOVE_CLASS = "cgo.dispatch-specialist";

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function readDoneOutcomes(
  tid: TenantId,
  rows: ReadonlyArray<{ id: string; run_id: string; executed_at: string | null }>,
): Promise<Map<string, ReturnType<typeof outcomeOf>>> {
  const out = new Map<string, ReturnType<typeof outcomeOf>>();
  const runIds = [...new Set(rows.map((r) => r.run_id).filter(Boolean))];
  if (runIds.length === 0) return out;
  const db = tenantClient(tid);
  const moveOfRun = new Map<string, string>();
  for (const ids of chunks(runIds, IN_CHUNK)) {
    const runs = await db.from("agent_runs").select("id, source_decision_id").eq("tenant_id", tid).in("id", ids);
    if (runs.error) throw new Error(`done card runs: ${runs.error.message}`);
    for (const r of (runs.data ?? []) as Array<{ id: string; source_decision_id: string | null }>) {
      if (r.source_decision_id) moveOfRun.set(r.id, r.source_decision_id);
    }
  }
  const moveIds = [...new Set(moveOfRun.values())];
  const moves = new Map<string, OutcomeSource & { status: string; target_agent_slug: unknown }>();
  for (const ids of chunks(moveIds, IN_CHUNK)) {
    const m = await db
      .from("decisions")
      .select("id, status, decision_class, emitted_at, dispatched_by:body->>dispatched_by, target_agent_slug:body->>target_agent_slug, test:body->test, test_readout:body->test_readout")
      .eq("tenant_id", tid)
      .eq("decision_class", CGO_MOVE_CLASS)
      .in("id", ids);
    if (m.error) throw new Error(`done card moves: ${m.error.message}`);
    for (const d of (m.data ?? []) as Array<{ id: string; status: string; decision_class: string; emitted_at: string; dispatched_by: unknown; target_agent_slug: unknown; test: unknown; test_readout: unknown }>) {
      moves.set(d.id, { id: d.id, status: d.status, decision_class: d.decision_class, emitted_at: d.emitted_at, target_agent_slug: d.target_agent_slug, body: { dispatched_by: d.dispatched_by, test: d.test, test_readout: d.test_readout } });
    }
  }
  const tested = [...moves.values()].filter((m) => outcomeOf(m, CGO_MOVE_CLASS, null) !== null);
  const launches = tested.length > 0
    ? await readMoveLaunches(tid, tested.map((m) => ({ id: m.id, status: m.status, emitted_at: m.emitted_at, body: { target_agent_slug: m.target_agent_slug } })))
    : new Map<string, string | null>();
  const spend = new Map<string, string>();
  const createdIds = rows.map((r) => r.id);
  for (const ids of chunks(createdIds, IN_CHUNK)) {
    const st = await db.from("growth_experiment_controls").select("source_action_id, envelope, state").eq("tenant_id", tid).eq("kind", "test_stop").in("source_action_id", ids);
    if (st.error) throw new Error(`done card test stops: ${st.error.message}`);
    for (const x of (st.data ?? []) as Array<{ source_action_id: string; envelope: unknown; state: string }>) {
      const line = testStopCardLine(x.envelope, x.state);
      if (line) spend.set(x.source_action_id, line);
    }
  }
  for (const r of rows) {
    const moveId = moveOfRun.get(r.run_id);
    const o = moveId ? outcomeOf(moves.get(moveId), CGO_MOVE_CLASS, launches.get(moveId) ?? null) : null;
    const line = spend.get(r.id);
    out.set(r.id, o && line ? { ...o, spend_line: line } : o);
  }
  return out;
}

export async function listCompletedChannelActions(
  tenantId: string,
  channelSlug: string,
  nowMs: number,
  viewerUserId?: string,
): Promise<ChannelActionView[]> {
  const tid = asTenantId(tenantId);
  const db = tenantClient(tid);
  const since = new Date(nowMs - COMPLETED_LOOKBACK_DAYS * 86_400_000).toISOString();
  type DoneRow = { id: string; run_id: string; executed_at: string | null; body: unknown };
  const readRan = async (): Promise<DoneRow[]> => {
    const rows: DoneRow[] = [];
    for (let from = 0; from < COMPLETED_READ_CAP; from += ROW_PAGE) {
      const { data, error } = await db
        .from("channel_actions")
        .select("id, run_id, executed_at, body")
        .eq("tenant_id", tid)
        .eq("channel_slug", channelSlug)
        .eq("status", "acted")
        .eq("exec_status", "executed")
        .gte("executed_at", since)
        .order("executed_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, Math.min(from + ROW_PAGE, COMPLETED_READ_CAP) - 1);
      if (error) throw new Error(`done channel actions read failed: ${error.message}`);
      const page = (data ?? []) as typeof rows;
      rows.push(...page);
      if (page.length < ROW_PAGE) break;
    }
    return rows;
  };
  const readRefused = async () => db
    .from("channel_actions")
    .select("id, run_id, status_at, body")
    .eq("tenant_id", tid)
    .eq("channel_slug", channelSlug)
    .eq("status", "stale")
    .eq("exec_status", "failed")
    .eq("exec_result->>bucket", "blocked_on_us")
    .gte("status_at", new Date(nowMs - COMPLETED_SHOW_DAYS * 86_400_000).toISOString())
    .order("status_at", { ascending: false })
    .limit(ROW_PAGE);
  const readPosted = async () => (await import("./post-live")).readPostedCards(tenantId, channelSlug, { sinceIso: since });
  const [rows, refused, postedAll] = await Promise.all([readRan(), readRefused(), readPosted()]);
  if (refused.error) throw new Error(`refused channel actions read failed: ${refused.error.message}`);
  const shown = (r: { body: unknown }) => !isPlanBody(r.body) && isCustomerChannelAction(channelSlug, r.body);
  const candidates = rows.filter(shown);
  const refusedRows = ((refused.data ?? []) as Array<{ id: string; run_id: string; status_at: string | null; body: unknown }>)
    .filter(shown)
    .map((r) => ({ id: r.id, run_id: r.run_id, executed_at: null, refused_at: r.status_at, body: r.body }));
  const posted = postedAll.filter(shown);
  const postedById = new Map(posted.map((p) => [p.id, p]));
  const postedRows = posted.map((p) => ({ id: p.id, run_id: p.run_id, executed_at: p.posted_at, body: p.body }));
  if (candidates.length === 0 && refusedRows.length === 0 && postedRows.length === 0) return [];
  const outcomes = candidates.length > 0 ? await readDoneOutcomes(tid, candidates) : new Map<string, ReturnType<typeof outcomeOf>>();
  const picked = pickCompleted([...candidates, ...refusedRows, ...postedRows], outcomes, nowMs);
  if (picked.length === 0) return [];
  const full = await db
    .from("channel_actions")
    .select(`${ACTION_COLUMNS}, executed_at`)
    .eq("tenant_id", tid)
    .in("id", picked.map((p) => p.id));
  if (full.error) throw new Error(`done channel actions read failed: ${full.error.message}`);
  const byId = new Map(((full.data ?? []) as Array<PanelRow & { executed_at: string | null }>).map((r) => [r.id, r]));
  const views = picked.flatMap(({ id, outcome }) => {
    const r = byId.get(id);
    if (!r) return [];
    const { executed_at, ...row } = r;
    const view = { ...toActionView(row, typeof row.score === "number" ? row.score : 0, row.score_inputs ?? null), executed_at, outcome };
    const post = postedById.get(id);
    if (!post) return [view];
    return [{ ...view, exec_status: "executed" as const, executed_at: post.posted_at, exec_receipt: post.url ? { line: post.line, url: post.url } : { line: post.line } }];
  });
  const decorated = viewerUserId ? await withCardTimelines(tenantId, views, approvalRows(byId.values()), viewerUserId) : views;
  return signActionMedia(tenantId, decorated);
}

const HISTORY_CARD_STATUSES = new Set(["acted", "rejected", "redone", "stale", "displaced"]);

export async function readHistoryChannelActionCard(tenantId: string, id: string, viewerUserId: string): Promise<ChannelActionView | null> {
  const tid = asTenantId(tenantId);
  const { data, error } = await tenantClient(tid)
    .from("channel_actions")
    .select(`${ACTION_COLUMNS}, executed_at`)
    .eq("tenant_id", tid)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`history channel action read failed: ${error.message}`);
  const r = data as (PanelRow & { executed_at: string | null }) | null;
  if (!r || !HISTORY_CARD_STATUSES.has(r.status) || isPlanBody(r.body) || !isCustomerChannelAction(r.channel_slug, r.body)) return null;
  const { executed_at, ...row } = r;
  const view = { ...toActionView(row, typeof row.score === "number" ? row.score : 0, row.score_inputs ?? null), executed_at };
  const decorated = await withCardTimelines(tenantId, [view], approvalRows([r]), viewerUserId);
  const [card] = await signActionMedia(tenantId, decorated);
  return card ?? null;
}

function approvalRows(rows: Iterable<{ id: string } & ApprovalRow>): Map<string, ApprovalRow> {
  const out = new Map<string, ApprovalRow>();
  for (const r of rows) {
    out.set(r.id, { approved_by: r.approved_by ?? null, approved_by_source: r.approved_by_source ?? null, exec_claimed_at: r.exec_claimed_at ?? null });
  }
  return out;
}

export function heldCount(rows: ReadonlyArray<{ status: string; snoozed_until: string | null; held_reason?: string | null; body: unknown }>, nowMs: number): number {
  return rows.filter((r) => r.held_reason === "pacing" && r.status === "snoozed" && !isOpenAction(r, nowMs) && !isPlanBody(r.body)).length;
}

export function mergeDecorations<T extends object>(base: readonly T[], primary: readonly T[], layers: ReadonlyArray<readonly T[]>): T[] {
  if (primary.length !== base.length) return [...primary];
  return primary.map((p, i) => {
    const orig = base[i] as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const layer of layers) {
      if (layer.length !== base.length) continue;
      const dec = layer[i] as Record<string, unknown>;
      if (dec === orig) continue;
      for (const k of Object.keys(dec)) {
        if (k === "body" || dec[k] === orig[k]) continue;
        out ??= { ...(p as Record<string, unknown>) };
        out[k] = dec[k];
      }
    }
    return (out ?? p) as T;
  });
}

export async function listChannelActions(
  tenantId: string,
  channelSlug: string,
  opts: {
    all?: boolean;
    nowMs?: number;
    withCompleted?: boolean;
    viewerUserId?: string;
  } = {},
): Promise<{
  actions: ChannelActionView[];
  more: number;
  store: "channel_actions" | "decisions";
  completed?: ChannelActionView[];
  locked_preview?: LockedPreview;
  plan?: ChannelPlan;
  held_count?: number;
}> {
  const store = actionsStoreFor(channelSlug);
  if (store !== "channel_actions") return { actions: [], more: 0, store };
  const tid = asTenantId(tenantId);
  const [{ data, error }, ctx, locked_preview, plan] = await Promise.all([
    tenantClient(tid)
      .from("channel_actions")
      .select(`${ACTION_COLUMNS}, executed_at, held_reason`)
      .eq("channel_slug", channelSlug)
      .in("status", ["pending", "snoozed"])
      .order("proposed_at", { ascending: true })
      .limit(LIST_READ_CAP),
    loadScoreContext(tid, channelSlug),
    readLockedPreview(tid, channelSlug),
    readChannelPlan(tid, channelSlug),
  ]);
  if (error) throw new Error(`channel actions read failed: ${error.message}`);
  const completed = opts.withCompleted
    ? await listCompletedChannelActions(tenantId, channelSlug, opts.nowMs ?? Date.now(), opts.viewerUserId).catch((e: unknown) => {
        console.warn(`[channel-actions] done cards read failed for ${channelSlug}: ${(e as Error).message}`);
        return undefined;
      })
    : undefined;
  const doneIds = new Set((completed ?? []).map((a) => a.id));
  const openRows = ((data ?? []) as PanelRow[]).filter((r) => !doneIds.has(r.id));
  const ranked = projectChannelPanel(channelSlug, openRows, ctx, {
    nowMs: opts.nowMs ?? Date.now(),
    all: opts.all,
  });
  const held_count = heldCount(openRows as Array<PanelRow & { held_reason?: string | null }>, opts.nowMs ?? Date.now());
  const [starts, stagedRead] = await Promise.all([
    (async () => previewRunStarts(tenantId, [...new Set(ranked.actions.map((a) => a.run_id).filter(Boolean))]))().catch(
      () => new Map<string, string>(),
    ),
    (async () => stagedPostsForCards(tid, ranked.actions))().then(
      (staged) => ({ staged, failed: null as Error | null }),
      (e: unknown) => ({ staged: null, failed: e as Error }),
    ),
  ]);
  const dated =
    starts.size > 0
      ? ranked.actions.map((a) => {
          const at = starts.get(a.run_id);
          return at ? { ...a, from_signup_preview_at: at } : a;
        })
      : ranked.actions;
  const days = await (async () => {
    if (stagedRead.failed) throw stagedRead.failed;
    const staged = stagedRead.staged!;
    const timed = (a: ChannelActionView) => {
      const s = staged.get(a.id);
      return s?.kind === "paired" && s.scheduled_at ? s.scheduled_at : null;
    };
    const paired = (a: ChannelActionView) => staged.get(a.id)?.kind === "paired";
    if (!dated.some(paired)) return dated;
    const tz = await tenantTimezone(tid).catch(() => DEFAULT_TENANT_TZ);
    return dated.map((a) => {
      if (!paired(a)) return a;
      const at = timed(a);
      return at
        ? { ...a, ...planDay(a.body, at, tz), plan_time: timeInZone(at, tz), plan_timezone: tz }
        : { ...a, plan_time: null, plan_timezone: tz };
    });
  })().catch((e: unknown) => {
    console.warn(`[channel-actions] staged-day read failed for ${channelSlug}: ${(e as Error).message}`);
    return dated;
  });
  const funded = channelSlug === "chatgpt_ads"
    ? await (await import("./chatgpt-ads/proposal-readiness")).decorateProposalFunding(tenantId, days, (data ?? []) as PanelRow[])
    : days;
  const priced = channelSlug === "generated_video" || channelSlug === "youtube_organic"
    ? await (await import("@/services/tools/generated-video/card-price")).repriceVideoCards(funded, (data ?? []) as PanelRow[])
    : funded;
  const doored = channelSlug === "email_marketing"
    ? await (await import("./contact-list-door")).withContactListDoor(tenantId, priced)
    : priced;
  const [warned, timed, signed] = await Promise.all([
    (async () => (await import("./cap-warning")).withCapWarnings(tenantId, doored, (data ?? []) as PanelRow[]))(),
    opts.viewerUserId
      ? withCardTimelines(tenantId, doored, approvalRows((data ?? []) as PanelRow[]), opts.viewerUserId)
      : Promise.resolve(doored),
    signActionMedia(tenantId, doored),
  ]);
  const actions = mergeDecorations(doored, signed, [warned, timed]);
  return {
    actions,
    more: ranked.more,
    store,
    ...(held_count > 0 ? { held_count } : {}),
    ...(completed ? { completed } : {}),
    ...(locked_preview ? { locked_preview } : {}),
    ...(plan ? { plan } : {}),
  };
}

export async function listActionViewsForRun(
  tenantId: string,
  runId: string,
  channelSlug: string,
): Promise<ChannelActionView[]> {
  const tid = asTenantId(tenantId);
  const { data, error } = await tenantClient(tid)
    .from("channel_actions")
    .select(ACTION_COLUMNS)
    .eq("run_id", runId)
    .eq("channel_slug", channelSlug)
    .order("proposed_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`channel actions read failed: ${error.message}`);
  const rows = ((data ?? []) as Array<PanelRow & { score?: number | null; score_inputs?: unknown }>).filter((r) => !isPlanBody(r.body));
  const views = rows.map((r) => toActionView(r, typeof r.score === "number" ? r.score : 0, r.score_inputs ?? null));
  const funded = channelSlug === "chatgpt_ads"
    ? await (await import("./chatgpt-ads/proposal-readiness")).decorateProposalFunding(tenantId, views, rows)
    : views;
  return signActionMedia(tenantId, funded);
}

export function previewActionTypes(
  channelSlug: string,
  bodies: ReadonlyArray<RecipeStepDecisionBody>,
): ActionType[] {
  return bodies.slice(0, LOCKED_PREVIEW_CAP).map((b) => {
    const step = b.step as RecipeStepDecisionBody["step"] & { action_type?: string };
    const t =
      typeof step.action_type === "string"
        ? coerceActionType(channelSlug, step.action_type)
        : deriveActionType(channelSlug, step, null);
    return t.action_type;
  });
}

export type LockedPreview = { count: number; types: ActionType[] };

export const LOCKED_PREVIEW_CAP = 20;

async function readLockedPreview(tid: TenantId, channelSlug: string): Promise<LockedPreview | null> {
  if (await planIncludesChannel(tid, channelSlug)) return null;
  const { data, error } = await tenantClient(tid)
    .from("agent_runs")
    .select("preview_action_types")
    .eq("cron_dedupe_key", previewRunKey(tid, channelSlug))
    .not("preview_action_types", "is", null)
    .maybeSingle();
  if (error) throw new Error(`locked preview read failed: ${error.message}`);
  const raw = (data as { preview_action_types?: unknown } | null)?.preview_action_types;
  const types = (Array.isArray(raw) ? raw : [])
    .slice(0, LOCKED_PREVIEW_CAP)
    .map((t) => (isActionType(t) ? t : "other"));
  return types.length > 0 ? { count: types.length, types } : null;
}

export async function lockedPreviewCounts(tenantId: string): Promise<Record<string, number>> {
  try {
    return await readLockedPreviewCounts(tenantId);
  } catch {
    return {};
  }
}

async function readLockedPreviewCounts(tenantId: string): Promise<Record<string, number>> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("agent_runs")
    .select("agent_slug, preview_action_types")
    .like("cron_dedupe_key", `${PREVIEW_RUN_KEY_PREFIX}${tenantId}:%`)
    .not("preview_action_types", "is", null)
    .limit(50);
  if (error) return {};
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as Array<{ agent_slug: string; preview_action_types: unknown }>) {
    const n = Array.isArray(r.preview_action_types) ? Math.min(r.preview_action_types.length, LOCKED_PREVIEW_CAP) : 0;
    if (n === 0) continue;
    if (await planIncludesChannel(tenantId, r.agent_slug)) continue;
    out[r.agent_slug] = (out[r.agent_slug] ?? 0) + n;
  }
  return out;
}

export type ChannelMetricView = {
  key: string;
  value: number;
  unit: string | null;
  window_kind: string;
  day: string;
  grounded: boolean;
  prev_value: number | null;
  prev_day: string | null;
};

export async function listChannelMetrics(
  tenantId: string,
  channelSlug: string,
  nowMs: number = Date.now(),
  emailMetrics?: (tenantId: string, nowMs: number) => Promise<ChannelMetricView[]>,
): Promise<ChannelMetricView[]> {
  const since = new Date(nowMs - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("channel_metrics")
    .select("metric_key, value, unit, window_kind, day, grounded")
    .eq("channel_slug", channelSlug)
    .gte("day", since)
    .order("day", { ascending: false })
    .limit(HISTORY_METRIC_ROWS);
  if (error) throw new Error(`channel metrics read failed: ${error.message}`);
  const visible = (data ?? []) as MetricRow[];
  const stored = latestTwoPerKey(visible).map(({ latest, prev }) => ({
    key: latest.metric_key,
    value: Number(latest.value),
    unit: latest.unit,
    window_kind: latest.window_kind,
    day: latest.day,
    grounded: latest.grounded,
    prev_value: prev ? Number(prev.value) : null,
    prev_day: prev ? prev.day : null,
  }));
  if (channelSlug !== "email_marketing") return stored;
  const sent = await (emailMetrics ?? (async (t: string, now: number) => (await import("@/services/email-results/channel-metrics")).readEmailChannelMetrics(t, now)))(tenantId, nowMs).catch(() => []);
  if (sent.length === 0) return stored;
  const keys = new Set(sent.map((m) => m.key as string));
  return [...sent, ...stored.filter((m) => !keys.has(m.key))];
}

function phoneApproveFields(exec_class: string, payload: unknown, rawBody: unknown, channel_slug: string): Pick<ChannelActionView, "approve_on_phone" | "approve_needs_admin" | "approve_money"> {
  const money = approveMoney(exec_class, payload, rawBody);
  return {
    approve_on_phone: true,
    approve_needs_admin: channelActionNeedsAdmin(exec_class, payload, channel_slug),
    ...(money ? { approve_money: money } : {}),
  };
}
