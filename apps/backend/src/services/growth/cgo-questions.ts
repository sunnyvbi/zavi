
import { CHANNELS } from "@zavi/shared";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { normalizeAsk, WHY_MAX } from "./question-text";

const DAY = 86_400_000;
export const QUESTION_MIN_DAYS = 2;
export const QUESTION_MAX_DAYS = 7;
export const QUESTION_DEFAULT_DAYS = 3;
export const REASK_AFTER_DAYS = 14;
export const MAX_QUEUED_QUESTIONS = 10;
export const MAX_NEW_QUESTIONS = 2;
export const HYPOTHESIS_TOPIC = "hyp:";
export const MAX_OPEN_HYPOTHESIS_QUESTIONS = 1;
export const MAX_OPEN_QUESTIONS = 2;

export type GoalChangeFields = {
  objective?: string;
  target_metric?: string;
  target_value?: number;
  due_date?: string;
};

export type DefaultAction =
  | { kind: "pause_channel"; channel_slug: string; why: string }
  | { kind: "goal_change"; goal_id: string; goal_rev: string; change: GoalChangeFields; why: string };

export type QuestionAsk = {
  required?: boolean;
  topic_key: string;
  ask: string;
  default_action: DefaultAction | null;
  days?: number;
  count_rule?: Record<string, unknown>;
  recommended?: "yes" | "no";
  why?: string;
  on_yes?: OnYes | null;
};

export type OnYes =
  | import("./ad-plan-yes").AdPlanOnYes
  | import("./ad-plan-yes").BudgetRaiseOnYes
  | import("./held-order-yes").HeldAdOrderOnYes
  | {
      kind: "hypothesis_check";
      hypothesis_id: string;
      goal_id: string;
      claim: string;
      prior_status?: string;
      written_version?: number;
      applied_at?: string;
      undone_at?: string;
    }
  | { kind: "goal_change"; goal_id: string; goal_rev: string; change: GoalChangeFields; why: string }
  | {
      kind: "goal_basis";
      goal_id: string;
      goal_rev: string;
      value_period_start: string;
      why: string;
      applied_at?: string;
      undone_at?: string;
    };

export function isYesNoAsk(ask: string): boolean {
  const sentences = ask.trim().split(/(?<=[.!?…])\s+/);
  return sentences.some((s) =>
    /^(should|shall|can|could|do|does|did|is|are|was|were|will|would|may|want|ok|okay|keep|pause|stop|switch)\b[^?]*\?$/i.test(s.trim()),
  );
}

export function asksFounderForNumber(ask: string): boolean {
  const a = ask.toLowerCase();
  const linkVerb = /\b(connect|link|hook up|plug in)\b/.test(a);
  const toolVerb = /\b(set ?up|configure|authori[sz]e|sign in to|log in to|integrate|install)\b/.test(a) &&
    /\b(stripe|shopify|database|analytics|ga4|search console|pixel|crm|hubspot|account|connector|integration|tracking)\b/.test(a);
  const connect = (linkVerb || toolVerb) && /\b(count|measure|track|numbers?|baseline)\b/.test(a);
  const number =
    !/\b(should|which)\b/.test(a) &&
    /\b(what is|what's|what was|what were|how many|how much)\b[^?]*\b(number|count|customers|signups|sign-ups|sales|revenue|orders|users|baseline)\b[^?]*\?/.test(a);
  return connect || number;
}

export type QuestionRow = {
  id: string;
  topic_key: string;
  ask: string;
  default_action: DefaultAction | null;
  default_line: string | null;
  status: "open" | "queued" | "answered" | "expired" | "withdrawn";
  asked_run_id?: string | null;
  asked_at: string;
  expires_at: string | null;
  answered_at: string | null;
  default_applied?: boolean;
  founder_replied_at?: string | null;
  ordinal?: number | null;
  recommended?: "yes" | "no" | null;
  why?: string | null;
  on_yes?: OnYes | null;
  answer?: string | null;
  answered_via?: string | null;
  applied_line?: string | null;
  reminded_at?: string | null;
  count_rule?: Record<string, unknown> | null;
  resolved_run_id?: string | null;
};

export function normalizeTopic(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function clampQuestionDays(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : QUESTION_DEFAULT_DAYS;
  return Math.min(QUESTION_MAX_DAYS, Math.max(QUESTION_MIN_DAYS, v));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function channelName(slug: string): string | null {
  return CHANNELS.find((c) => c.slug === slug)?.name ?? null;
}

export function defaultLine(action: DefaultAction | null, expiresAt: string | null, goalName?: string): string | null {
  if (!action || !expiresAt) return null;
  const by = shortDate(expiresAt);
  if (action.kind === "pause_channel") {
    return `If I don't hear back by ${by}, I'll pause ${channelName(action.channel_slug) ?? action.channel_slug}.`;
  }
  void goalName;
  return null;
}

export { ASK_MAX, COUNT_ASK_MAX, WHY_MAX, clipAsk } from "./question-text";

export type PlannedQuestion = QuestionAsk & {
  expires_at: string | null;
  queued?: boolean;
};

export function planQuestionsDetailed(
  asks: QuestionAsk[],
  existing: Array<Pick<QuestionRow, "topic_key" | "status" | "asked_at" | "answered_at" | "expires_at"> & { default_applied?: boolean }>,
  now: Date,
): { planned: PlannedQuestion[]; overflow: string[] } {
  const t = now.getTime();
  const blocked = new Set<string>();
  let room = Math.max(0, MAX_OPEN_QUESTIONS - existing.filter((q) => q.status === "open").length);
  let queueRoom = Math.max(0, MAX_QUEUED_QUESTIONS - existing.filter((q) => q.status === "queued").length);
  for (const q of existing) {
    if (q.status === "open" || q.status === "queued") {
      blocked.add(q.topic_key);
      continue;
    }
    const held = q.status === "answered" || (q.status === "expired" && q.default_applied === true);
    if (!held) continue;
    const closedAt = Date.parse(q.answered_at ?? q.expires_at ?? q.asked_at);
    if (Number.isFinite(closedAt) && closedAt >= t - REASK_AFTER_DAYS * DAY) blocked.add(q.topic_key);
  }
  const planned: PlannedQuestion[] = [];
  const overflow: string[] = [];
  let opened = 0;
  let hypRoom = Math.max(0, MAX_OPEN_HYPOTHESIS_QUESTIONS - existing.filter((q) => q.status === "open" && q.topic_key.startsWith(HYPOTHESIS_TOPIC)).length);
  for (const a of asks) {
    const topic = normalizeTopic(a.topic_key);
    const isHyp = a.on_yes?.kind === "hypothesis_check";
    if (!isHyp && topic.startsWith(HYPOTHESIS_TOPIC)) continue;
    const n = normalizeAsk(a.ask, a.why, { countRule: !!a.count_rule, required: !!a.required, hypothesis: isHyp });
    if (!topic || !n || blocked.has(topic)) continue;
    if (isHyp) {
      if (hypRoom <= 0) continue;
      hypRoom--;
    }
    const { why: _why, ...rest } = a;
    const base = { ...rest, topic_key: topic, ask: n.ask, ...(n.why ? { why: n.why } : {}) };
    if (a.required || (opened < MAX_NEW_QUESTIONS && room > 0)) {
      blocked.add(topic);
      const deadline = a.default_action?.kind === "pause_channel";
      planned.push({ ...base, expires_at: deadline ? new Date(t + clampQuestionDays(a.days) * DAY).toISOString() : null });
      if (!a.required) opened++;
      room = Math.max(0, room - 1);
      continue;
    }
    if (queueRoom <= 0) {
      overflow.push(n.ask);
      continue;
    }
    blocked.add(topic);
    queueRoom--;
    planned.push({ ...base, default_action: null, expires_at: null, queued: true });
  }
  return { planned, overflow };
}

export function planQuestions(
  asks: QuestionAsk[],
  existing: Array<Pick<QuestionRow, "topic_key" | "status" | "asked_at" | "answered_at" | "expires_at"> & { default_applied?: boolean }>,
  now: Date,
): PlannedQuestion[] {
  return planQuestionsDetailed(asks, existing, now).planned;
}

export async function readQuestions(tenant_id: string, now: Date): Promise<QuestionRow[]> {
  const since = new Date(now.getTime() - REASK_AFTER_DAYS * DAY).toISOString();
  const db = tenantClient(asTenantId(tenant_id));
  const [open, recent] = await Promise.all([
    db
      .from("cgo_questions")
      .select("id, topic_key, ask, default_action, default_line, status, asked_at, expires_at, answered_at, answer, answered_via, resolved_run_id, ordinal, default_applied")
      .eq("tenant_id", tenant_id)
      .in("status", ["open", "queued"])
      .order("asked_at", { ascending: true })
      .limit(50),
    db
      .from("cgo_questions")
      .select("id, topic_key, ask, default_action, default_line, status, asked_at, expires_at, answered_at, answer, answered_via, resolved_run_id, ordinal, default_applied")
      .eq("tenant_id", tenant_id)
      .not("status", "in", "(open,queued)")
      .or(`expires_at.gte.${since},answered_at.gte.${since}`)
      .limit(200),
  ]);
  if (open.error) throw new Error(`cgo-questions: open read failed: ${open.error.message}`);
  if (recent.error) throw new Error(`cgo-questions: recent read failed: ${recent.error.message}`);
  return [...((open.data ?? []) as QuestionRow[]), ...((recent.data ?? []) as QuestionRow[])];
}

export function topicGoalId(topic: string): string | null {
  const m = /^(?:goal|basis|number|count-stale):([^:]+)$/.exec(topic) ?? /^count:([^:]+):/.exec(topic);
  return m ? m[1] : null;
}

export async function withdrawStaleGoalQuestions(tenant_id: string, liveRevs: ReadonlyMap<string, string>): Promise<number> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db
    .from("cgo_questions")
    .select("id, topic_key, on_yes")
    .eq("tenant_id", tenant_id)
    .in("status", ["open", "queued"])
    .limit(100);
  if (error) throw new Error(`cgo-questions: open goal questions read failed: ${error.message}`);
  let n = 0;
  for (const q of (data ?? []) as Array<{ id: string; topic_key: string; on_yes: OnYes | null }>) {
    const a = q.on_yes;
    if (a?.kind === "hypothesis_check") continue;
    let stale = false;
    if (a?.kind === "goal_change" || a?.kind === "goal_basis") {
      const live = liveRevs.get(a.goal_id);
      stale = live === undefined || live !== a.goal_rev;
    } else {
      const goalId = topicGoalId(q.topic_key);
      stale = goalId !== null && !liveRevs.has(goalId);
    }
    if (!stale) continue;
    const { data: flipped, error: e } = await db
      .from("cgo_questions")
      .update({ status: "withdrawn" })
      .eq("id", q.id)
      .eq("tenant_id", tenant_id)
      .in("status", ["open", "queued"])
      .select("id");
    if (e) {
      console.warn(`[cgo-questions] withdrawing question ${q.id} failed: ${e.message}`);
      continue;
    }
    n += ((flipped ?? []) as unknown[]).length;
  }
  return n;
}

export function hypothesisAsk(h: { id: string; goal_id: string; claim: string }, why: string): QuestionAsk {
  const claim = h.claim
    .trim()
    .replace(/[.!?…]*\s*[\r\n]+\s*/g, "; ")
    .replace(/[.!?…]+\s+/g, "; ")
    .replace(/(?:;\s*){2,}/g, "; ")
    .replace(/[.!?…;:,\s]+$/, "");
  return {
    required: true,
    topic_key: `${HYPOTHESIS_TOPIC}${h.id}`,
    ask: `Is this true for your business: ${claim}?`,
    default_action: null,
    why,
    on_yes: { kind: "hypothesis_check", hypothesis_id: h.id, goal_id: h.goal_id, claim: h.claim },
  };
}

export async function withdrawStaleHypothesisQuestions(
  tenant_id: string,
  live: ReadonlyArray<{ id: string; status: string; claim: string }>,
): Promise<number> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db
    .from("cgo_questions")
    .select("id, on_yes")
    .eq("tenant_id", tenant_id)
    .eq("status", "open")
    .like("topic_key", `${HYPOTHESIS_TOPIC}%`)
    .limit(20);
  if (error) throw new Error(`cgo-questions: open hypothesis questions read failed: ${error.message}`);
  const byId = new Map(live.map((h) => [h.id, h]));
  const rows = (data ?? []) as Array<{ id: string; on_yes: OnYes | null }>;
  const unloaded = [...new Set(rows.flatMap((q) => (q.on_yes?.kind === "hypothesis_check" && !byId.has(q.on_yes.hypothesis_id) ? [q.on_yes.hypothesis_id] : [])))];
  const exists = new Set<string>();
  if (unloaded.length > 0) {
    const { data: found, error: findErr } = await db.from("cgo_hypotheses").select("id").eq("tenant_id", tenant_id).in("id", unloaded);
    if (findErr) throw new Error(`cgo-questions: hypothesis read failed: ${findErr.message}`);
    for (const r of (found ?? []) as Array<{ id: string }>) exists.add(r.id);
  }
  let n = 0;
  for (const q of rows) {
    const a = q.on_yes;
    if (a?.kind !== "hypothesis_check") continue;
    const h = byId.get(a.hypothesis_id);
    if (!h && exists.has(a.hypothesis_id)) continue;
    if (h && (h.status === "listed" || h.status === "testing") && h.claim === a.claim) continue;
    const { data: flipped, error: e } = await db
      .from("cgo_questions")
      .update({ status: "withdrawn" })
      .eq("id", q.id)
      .eq("tenant_id", tenant_id)
      .eq("status", "open")
      .select("id");
    if (e) {
      console.warn(`[cgo-questions] withdrawing hypothesis question ${q.id} failed: ${e.message}`);
      continue;
    }
    n += ((flipped ?? []) as unknown[]).length;
  }
  return n;
}

export async function insertQuestions(
  tenant_id: string,
  run_id: string | null,
  planned: Array<PlannedQuestion & { default_line?: string | null }>,
): Promise<Array<PlannedQuestion & { ordinal: number | null }>> {
  const db = tenantClient(asTenantId(tenant_id));
  const stored: Array<PlannedQuestion & { ordinal: number | null }> = [];
  if (planned.length === 0) return stored;
  const { data: openRows } = await db.from("cgo_questions").select("ordinal").eq("tenant_id", tenant_id).eq("status", "open").limit(100);
  const taken = new Set(((openRows ?? []) as Array<{ ordinal: number | null }>).map((r) => r.ordinal).filter((n): n is number => typeof n === "number"));
  const nextOrdinal = () => {
    let n = 1;
    while (taken.has(n)) n++;
    return n <= 99 ? n : null;
  };
  for (const q of planned) {
    const queued = q.queued === true;
    const insert = (ordinal: number | null) =>
      db.from("cgo_questions").insert({
        tenant_id,
        topic_key: q.topic_key,
        ask: q.ask,
        default_action: queued ? null : q.default_action,
        default_line: queued ? null : (q.default_line ?? null),
        status: queued ? "queued" : "open",
        asked_run_id: run_id,
        asked_at: new Date().toISOString(),
        expires_at: queued ? null : q.expires_at,
        ordinal,
        recommended: q.recommended ?? null,
        why: q.why?.trim() ? q.why.trim().replace(/\s+/g, " ").slice(0, WHY_MAX) : null,
        on_yes: q.on_yes ?? null,
        ...(q.count_rule ? { count_rule: q.count_rule } : {}),
      });
    let ordinal = queued ? null : nextOrdinal();
    let { error } = await insert(ordinal);
    if (error && (error as { code?: string }).code === "23505" && /ordinal/.test(error.message) && ordinal != null && !queued) {
      taken.add(ordinal);
      ordinal = nextOrdinal();
      ({ error } = await insert(ordinal));
    }
    if (error) {
      if ((error as { code?: string }).code === "23505") continue;
      console.warn(`[cgo-questions] insert failed for topic ${q.topic_key}: ${error.message}`);
      continue;
    }
    if (ordinal != null) taken.add(ordinal);
    stored.push({ ...q, ordinal });
  }
  return stored;
}

export async function promoteQueued(tenant_id: string, now: Date): Promise<number> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data: openRows, error: openErr } = await db.from("cgo_questions").select("ordinal").eq("tenant_id", tenant_id).eq("status", "open").limit(100);
  if (openErr) throw new Error(`cgo-questions: open read failed: ${openErr.message}`);
  const open = (openRows ?? []) as Array<{ ordinal: number | null }>;
  const room = MAX_OPEN_QUESTIONS - open.length;
  if (room <= 0) return 0;
  const { data: waiting, error } = await db
    .from("cgo_questions")
    .select("id, on_yes")
    .eq("tenant_id", tenant_id)
    .eq("status", "queued")
    .order("asked_at", { ascending: true })
    .limit(MAX_QUEUED_QUESTIONS * 2);
  if (error) throw new Error(`cgo-questions: queued read failed: ${error.message}`);
  const taken = new Set(open.map((r) => r.ordinal).filter((n): n is number => typeof n === "number"));
  const nextOrdinal = () => {
    let n = 1;
    while (taken.has(n)) n++;
    return n <= 99 ? n : null;
  };
  const today = now.toISOString().slice(0, 10);
  let n = 0;
  for (const q of (waiting ?? []) as Array<{ id: string; on_yes?: OnYes | null }>) {
    if (n >= room) break;
    const plan = q.on_yes?.kind === "ad_plan" ? q.on_yes.plan : null;
    if (typeof plan?.start === "string" && plan.start < today) {
      const w = await db.from("cgo_questions").update({ status: "withdrawn" }).eq("id", q.id).eq("tenant_id", tenant_id).eq("status", "queued").select("id");
      if (w.error) console.warn(`[cgo-questions] withdrawing stale queued ad plan ${q.id} failed: ${w.error.message}`);
      if (!w.error && ((w.data ?? []) as unknown[]).length === 0) break;
      continue;
    }
    const promote = (ordinal: number | null) =>
      db
        .from("cgo_questions")
        .update({ status: "open", ordinal, asked_at: now.toISOString() })
        .eq("id", q.id)
        .eq("tenant_id", tenant_id)
        .eq("status", "queued")
        .select("id");
    let ordinal = nextOrdinal();
    let r = await promote(ordinal);
    if (r.error && (r.error as { code?: string }).code === "23505" && ordinal != null) {
      taken.add(ordinal);
      ordinal = nextOrdinal();
      r = await promote(ordinal);
    }
    if (r.error) {
      console.warn(`[cgo-questions] opening queued question ${q.id} failed: ${r.error.message}`);
      continue;
    }
    if (ordinal != null) taken.add(ordinal);
    const opened = ((r.data ?? []) as unknown[]).length;
    if (opened === 0) break;
    n += opened;
  }
  return n;
}

export async function promoteQueuedQuietly(tenant_id: string, now: Date): Promise<number> {
  return promoteQueued(tenant_id, now).catch((e) => {
    console.warn(`[cgo-questions] promoting queued questions for ${tenant_id} failed: ${(e as Error).message}`);
    return 0;
  });
}

export async function markAnswered(
  tenant_id: string,
  answers: Array<{ question_id: string; answer: string }>,
  via: "email" | "slack" | "chat" | "web",
  run_id: string,
  now: Date,
): Promise<number> {
  const db = tenantClient(asTenantId(tenant_id));
  let n = 0;
  const seen = new Set<string>();
  for (const a of answers) {
    if (seen.has(a.question_id)) continue;
    seen.add(a.question_id);
    const { data, error } = await db
      .from("cgo_questions")
      .update({
        status: "answered",
        answered_at: now.toISOString(),
        answer: a.answer.trim().slice(0, 500) || null,
        answered_via: via,
        resolved_run_id: run_id,
      })
      .eq("id", a.question_id)
      .eq("tenant_id", tenant_id)
      .eq("status", "open")
      .or("on_yes.is.null,on_yes->>kind.neq.hypothesis_check")
      .select("id");
    if (error) {
      console.warn(`[cgo-questions] marking ${a.question_id} answered failed: ${error.message}`);
      continue;
    }
    n += ((data ?? []) as unknown[]).length;
  }
  return n;
}

export async function markFounderReplied(tenant_id: string, now: Date): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("cgo_questions")
    .update({ founder_replied_at: now.toISOString() })
    .eq("tenant_id", tenant_id)
    .eq("status", "open");
  if (error) throw new Error(`cgo-questions: marking the founder's reply failed: ${error.message}`);
}

export type ExpiryOutcome = { expired: number; applied: string[] };

export async function sweepExpiredQuestions(
  tenant_id: string,
  now: Date,
  deps: {
    autopilot: boolean;
    autopilotNow?: () => Promise<boolean>;
  },
): Promise<ExpiryOutcome> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db
    .from("cgo_questions")
    .select("id, topic_key, ask, default_action, default_line, status, asked_run_id, asked_at, expires_at, answered_at, founder_replied_at")
    .eq("tenant_id", tenant_id)
    .eq("status", "open")
    .lte("expires_at", now.toISOString())
    .limit(50);
  if (error) throw new Error(`cgo-questions: overdue read failed: ${error.message}`);
  const out: ExpiryOutcome = { expired: 0, applied: [] };
  for (const q of (data ?? []) as QuestionRow[]) {
    const { data: flipped, error: flipErr } = await db
      .from("cgo_questions")
      .update({ status: "expired" })
      .eq("id", q.id)
      .eq("tenant_id", tenant_id)
      .eq("status", "open")
      .select("id");
    if (flipErr || ((flipped ?? []) as unknown[]).length === 0) continue;
    out.expired++;
    const act = q.default_action;
    if (q.founder_replied_at) continue;
    const run_id = q.asked_run_id;
    if (!deps.autopilot || !act || !run_id) continue;
    if (deps.autopilotNow && !(await deps.autopilotNow())) continue;
    let line: string | null = null;
    if (act.kind === "pause_channel") {
      const { evaluateUnattended } = await import("./unattended-policy");
      const { CGO_AD_CHANNELS } = await import("./cgo-ads");
      const silence = await pauseSilenceFacts(tenant_id, q, act.channel_slug);
      const gate = evaluateUnattended(
        { kind: "channel_pause", channel_slug: act.channel_slug, trigger: "question_expiry", defaultStated: silence.told },
        { paidChannel: CGO_AD_CHANNELS.has(act.channel_slug), founderActedSince: silence.acted },
      );
      if (gate.verdict !== "allow") continue;
    }
    if (act.kind === "pause_channel") {
      const name = channelName(act.channel_slug);
      if (!name) continue;
      const { data: outcome, error: pErr } = await tenantRpc(asTenantId(tenant_id), "pause_channel_by_cgo", {
        p_tenant_id: tenant_id,
        p_channel_slug: act.channel_slug,
        p_reason: act.why,
        p_run_id: run_id,
      });
      if (pErr || String(outcome) !== "ok") continue;
      const { error: cErr } = await tenantRpc(asTenantId(tenant_id), "close_channel_actions_on_cgo_pause", {
        p_tenant_id: tenant_id,
        p_channel_slug: act.channel_slug,
        p_run_id: run_id,
        p_why: act.why,
      });
      if (cErr) console.warn(`[cgo-questions] closing ${act.channel_slug} cards failed: ${cErr.message}`);
      line = `No answer on "${q.ask}", so I paused ${name} as I said I would.`;
    }
    if (!line) continue;
    const { error: aErr } = await db.from("cgo_questions").update({ default_applied: true }).eq("id", q.id).eq("tenant_id", tenant_id);
    if (aErr) console.warn(`[cgo-questions] marking default applied failed for ${q.id}: ${aErr.message}`);
    out.applied.push(line.slice(0, 400));
  }
  if (out.expired > 0) await promoteQueuedQuietly(tenant_id, now);
  return out;
}

async function pauseSilenceFacts(
  tenant_id: string,
  q: QuestionRow,
  channel_slug: string,
): Promise<{ told: boolean; acted: boolean | null }> {
  const db = tenantClient(asTenantId(tenant_id));
  let told = false;
  if (q.asked_run_id) {
    const { data, error } = await db.from("cgo_notes").select("id").eq("tenant_id", tenant_id).eq("run_id", q.asked_run_id).limit(1);
    told = !error && ((data ?? []) as unknown[]).length > 0;
  }
  const { data: ev, error: evErr } = await db
    .from("channel_action_events")
    .select("action_id")
    .eq("tenant_id", tenant_id)
    .eq("actor_kind", "founder")
    .gte("at", q.asked_at)
    .limit(500);
  if (evErr || ((ev ?? []) as unknown[]).length >= 500) return { told, acted: null };
  const ids = new Set(((ev ?? []) as Array<{ action_id: string }>).map((e) => e.action_id));
  if (ids.size === 0) return { told, acted: false };
  const { data: acts, error: aErr } = await db
    .from("channel_actions")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("channel_slug", channel_slug)
    .limit(1000);
  if (aErr || ((acts ?? []) as unknown[]).length >= 1000) return { told, acted: null };
  return { told, acted: ((acts ?? []) as Array<{ id: string }>).some((a) => ids.has(a.id)) };
}
