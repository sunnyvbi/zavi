
import type { Request, Response } from "express";
import { actionsStoreFor, adChangeHeadline, CHANNELS, LINKEDIN_LAUNCH_HEADLINE_CLASS, linkedinLaunchHeadline } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { serverClientFromBearer } from "@/services/supabase";
import { cardPlatform } from "@/services/growth/cgo-blockers";
import { STUCK_AFTER_MS } from "@/services/growth/stuck-ad-changes";
import { CGO_CARD_CLASS } from "@/services/growth/goal-owner";
import { readTestsSummary } from "@/services/growth/cgo-tests";
import { FORCED_CONSTRAINT_KEY } from "@/agents/cgo/founder-overlay";
import { enqueueAgentRun, FleetHaltedError, InsufficientCreditsError } from "@/services/agents/runner";
import { draftDedupeKey, interviewPairs, researchForDraft } from "./growth-strategy-draft";
import { readNote } from "./growth-interview";
import { readTodaysResearch } from "./growth-intake-research";
import { readAndSettleDoneForYou } from "./growth-done-for-you";
import { doneForYouEligibility, type DoneForYouMode, type DoneForYouState } from "@/services/growth/done-for-you";
import { emailSendLabel, withoutFrozenPeople } from "@/services/channels/channel-actions";
import { isChannelLocked } from "@/services/channels/lock";
import { recordActivity } from "@/services/activity/recordActivity";
import { priceForJob } from "@/services/billing/job-prices";
import { isFlatJobPricingOn } from "@/services/billing/flat-pricing";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_NAME: ReadonlyMap<string, string> = new Map(CHANNELS.map((c) => [c.slug, c.name]));
const DAY_MS = 86_400_000;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

async function authorizePlanWrite(req: Request, res: Response) {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    fail(res, 403, "tenant_override_forbidden", "Not available for an overridden tenant.");
    return null;
  }
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return null;
  return auth;
}

type RpcAnswer = { ok?: boolean; code?: string } & Record<string, unknown>;

function rpcRefusal(res: Response, code: string | undefined): void {
  if (code === "no_plan") return fail(res, 409, "no_plan", "There is no plan yet. Zavi writes one first.");
  if (code === "bad_text") return fail(res, 400, "bad_text", "Write between 1 and 300 characters.");
  if (code === "no_hypothesis") return fail(res, 404, "no_hypothesis", "That guess is no longer open.");
  if (code === "not_member") return fail(res, 403, "forbidden", "Not a member of this workspace.");
  fail(res, 400, code ?? "refused", "That change could not be saved.");
}

export async function postConstraintAgree(req: Request, res: Response): Promise<void> {
  const auth = await authorizePlanWrite(req, res);
  if (!auth) return;
  const raw = (req.body as { agreed?: unknown } | undefined)?.agreed;
  if (raw !== undefined && typeof raw !== "boolean") return fail(res, 400, "bad_request", "agreed must be true or false.");
  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "set_constraint_agreed", {
    p_actor: auth.user_id,
    p_agreed: raw ?? true,
  });
  if (error) return fail(res, 500, "write_failed", "That did not save. Try again.");
  const out = (data ?? {}) as RpcAnswer;
  if (!out.ok) return rpcRefusal(res, out.code);
  res.json({ ok: true, constraint_agreed_at: (out.constraint_agreed_at as string | null) ?? null });
}

export async function postConstraintFounder(req: Request, res: Response): Promise<void> {
  const auth = await authorizePlanWrite(req, res);
  if (!auth) return;
  const body = (req.body ?? {}) as { text?: unknown };
  if (!("text" in body) || (body.text !== null && typeof body.text !== "string")) {
    return fail(res, 400, "bad_request", "text must be a string or null.");
  }
  const text = typeof body.text === "string" ? body.text.trim() : null;
  if (text !== null && (text.length < 1 || text.length > 300)) return fail(res, 400, "bad_text", "Write between 1 and 300 characters.");
  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "set_founder_constraint", {
    p_actor: auth.user_id,
    p_text: text,
  });
  if (error) return fail(res, 500, "write_failed", "That did not save. Try again.");
  const out = (data ?? {}) as RpcAnswer;
  if (!out.ok) return rpcRefusal(res, out.code);
  res.json({
    ok: true,
    founder_constraint: (out.founder_constraint as string | null) ?? null,
    founder_constraint_at: (out.founder_constraint_at as string | null) ?? null,
  });
}

export async function postConstraintSwitch(req: Request, res: Response): Promise<void> {
  const auth = await authorizePlanWrite(req, res);
  if (!auth) return;
  const hypothesis_id = (req.body as { hypothesis_id?: unknown } | undefined)?.hypothesis_id;
  if (typeof hypothesis_id !== "string" || !UUID_RE.test(hypothesis_id)) {
    return fail(res, 400, "bad_request", "hypothesis_id must be a uuid.");
  }
  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "switch_plan_constraint_to_hypothesis", {
    p_actor: auth.user_id,
    p_hypothesis_id: hypothesis_id,
  });
  if (error) return fail(res, 500, "write_failed", "That did not save. Try again.");
  const out = (data ?? {}) as RpcAnswer;
  if (!out.ok || typeof out.claim !== "string") return rpcRefusal(res, out.code);

  let interview: Array<{ question: string; answer: string }> = [];
  let research: Record<string, unknown> | null = null;
  try {
    interview = interviewPairs((await readNote(serverClientFromBearer(auth.access_token), auth.tenant_id)).metadata);
  } catch {
    interview = [];
  }
  try {
    research = researchForDraft(await readTodaysResearch(auth.tenant_id));
  } catch {
    research = null;
  }

  const dedupe = `${draftDedupeKey(auth.tenant_id, new Date())}:switch:${hypothesis_id}`;
  try {
    const run = await enqueueAgentRun({
      agent_slug: "cgo",
      tenant_id: auth.tenant_id,
      trigger: "manual",
      payload: {
        stage: "draft_strategy",
        [FORCED_CONSTRAINT_KEY]: out.claim,
        forced_constraint_why: "The founder chose this as what holds growth back. Use it as constraint.statement and plan around it.",
        ...(interview.length ? { interview } : {}),
        ...(research ? { research } : {}),
      },
      cron_dedupe_key: dedupe,
      user_access_token: auth.access_token,
    });
    if (run.run_id) {
      res.json({ ok: true, run_id: run.run_id });
      return;
    }
    const { data: rows, error: readErr } = await serverClientFromBearer(auth.access_token)
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", auth.tenant_id)
      .eq("cron_dedupe_key", dedupe)
      .limit(1);
    if (readErr) throw new Error(readErr.message);
    res.json({ ok: true, run_id: (rows?.[0] as { id?: string } | undefined)?.id ?? null });
  } catch (e) {
    if (e instanceof InsufficientCreditsError) {
      return fail(res, 402, "insufficient_credits", "Not enough credits to re-plan. Your view was cleared; top up and press Switch again.");
    }
    if (e instanceof FleetHaltedError) return fail(res, 503, "fleet_halted", "Agents are paused right now. Your view was cleared but re-planning did not start; press Switch again shortly.");
    fail(res, 500, "redraft_failed", "Your view was cleared but re-planning did not start. Press Switch again.");
  }
}

export type OpenCardKind =
  | "check" | "reconnect" | "spend" | "link" | "post" | "copy" | "message" | "question" | "task" | "connect" | "plan";

export type OpenCard = {
  source: "channel_action" | "decision";
  id: string;
  channel_slug: string | null;
  kind: OpenCardKind;
  title: string;
  body: string | null;
  why: string | null;
  where: string | null;
  card_kind: string | null;
  primary_label: string | null;
  amount: number | null;
  effect: string | null;
  tone: "danger" | "warn" | null;
  snoozed_until: string | null;
  created_at: string;
  options: string[] | null;
  url: string | null;
  mins: number | null;
  campaign_id: string | null;
  platform: string | null;
  account_id: string | null;
  can_redo: boolean;
  redo_credits?: number | null;
  dfy?: DoneForYouMode | null;
  approve_blocked: string | null;
  opens_review: boolean;
  stops_live_spend: boolean;
  exec_failed_at: string | null;
  launch_usd: number | null;
  launch_ends_at: number | null;
};

const LAUNCH_UNREADABLE_TITLE = "A LinkedIn launch that would start spending: Zavi can't read its campaign, budget or end date";
const LAUNCH_UNREADABLE_BLOCK = "Zavi won't start this spend from here because it can't show you which campaign, how much or until when. Reject it and ask Zavi to file it again.";

const launchUnreadable = (cls: string | null | undefined, body: unknown): boolean =>
  cls === LINKEDIN_LAUNCH_HEADLINE_CLASS && linkedinLaunchHeadline(cls, body) === null;

function launchSpend(cls: string | null | undefined, body: unknown): { launch_usd: number | null; launch_ends_at: number | null } {
  const none = { launch_usd: null, launch_ends_at: null };
  if (cls !== LINKEDIN_LAUNCH_HEADLINE_CLASS || launchUnreadable(cls, body)) return none;
  const b = obj(body);
  const usd = typeof b.total_budget_usd === "number" && Number.isFinite(b.total_budget_usd) && b.total_budget_usd > 0 ? b.total_budget_usd : null;
  return usd === null ? none : { launch_usd: usd, launch_ends_at: b.end_time as number };
}

function accountOf(payload: unknown): string | null {
  const b = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  for (const k of ["account_id", "ad_account_id"]) {
    const v = b[k];
    if (typeof v === "string" && /^\d{1,20}$/.test(v.trim())) return v.trim();
    if (typeof v === "number" && Number.isInteger(v)) return String(v);
  }
  return null;
}

const EFFORT_MINS: Readonly<Record<string, number>> = { minutes: 5, hours: 60, days: 480 };

function campaignOf(payload: unknown): string | null {
  const b = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  for (const k of ["campaign_id", "ad_set_id", "object_id"]) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown, max = 600): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

export function budgetDelta(body: unknown): number | null {
  const b = obj(body);
  const to = typeof b.daily_budget_usd === "number" ? b.daily_budget_usd : null;
  const from = typeof b.expected_current_daily_budget_usd === "number" ? b.expected_current_daily_budget_usd : null;
  return to !== null && from !== null ? Math.round((to - from) * 100) / 100 : null;
}

const KIND_BY_CARD: Readonly<Record<string, OpenCardKind>> = {
  post: "post",
  message: "message",
  copy_to_site: "copy",
  plan: "plan",
  ad_manual: "task",
  task: "task",
  executes: "spend",
};

type ChannelActionRow = {
  id: string;
  channel_slug: string;
  status: string;
  snoozed_until: string | null;
  proposed_at: string;
  body: Record<string, unknown> | null;
  exec_class: string | null;
  exec_status: string | null;
  exec_claimed_at?: string | null;
  exec_payload: unknown;
  card_kind: string | null;
  primary_label: string | null;
  held_reason?: string | null;
};

export function isPacedHold(a: Pick<ChannelActionRow, "status" | "snoozed_until" | "held_reason">, now: number): boolean {
  return a.held_reason === "pacing" && a.status === "snoozed" && liveSnooze(a.snoozed_until, now) !== null;
}

export function liveSnooze(until: string | null | undefined, now: number): string | null {
  if (!until) return null;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now ? until : null;
}

export function channelRedoCredits(channel_slug: string, flatOn: boolean): number | null {
  if (!flatOn) return null;
  const price = priceForJob({ agent_slug: channel_slug, trigger: "channel_recipe", payload: null, cron_dedupe_key: null });
  return price && !price.free && price.credits > 0 ? price.credits : null;
}

export function openCardFromAction(a: ChannelActionRow, now: number = Date.now(), flatOn = false): OpenCard {
  const body = obj(a.body);
  const step = obj(body.step);
  const deliverable = obj(step.deliverable);
  const headline = a.exec_class ? adChangeHeadline(a.exec_class, a.exec_payload) : null;
  const unreadable = launchUnreadable(a.exec_class, a.exec_payload);
  const presented = obj(deliverable.presentation);
  const draft = !a.exec_class && a.channel_slug === "linkedin_ads" && presented.type === "campaign_draft" && presented.channel === "linkedin_ads";
  const payload = obj(a.exec_payload);
  const stopsSpend = a.exec_class === "linkedin_ads.set_status" && payload.status === "PAUSED";
  const pauseName = text(payload.name, 120);
  let kind: OpenCardKind = a.exec_class ? "spend" : KIND_BY_CARD[a.card_kind ?? ""] ?? "task";
  if (draft) kind = "task";
  else if (!a.exec_class && body.intent === "answer") kind = "question";
  else if (!a.exec_class && /connect|authori[sz]e/i.test(String(step.action_type ?? ""))) kind = "connect";
  const can_redo =
    (a.status === "pending" || a.status === "snoozed") &&
    !a.exec_class &&
    a.exec_status !== "queued" &&
    a.exec_status !== "dispatching" &&
    actionsStoreFor(a.channel_slug as Parameters<typeof actionsStoreFor>[0]) === "channel_actions";
  return {
    source: "channel_action",
    id: a.id,
    channel_slug: a.channel_slug,
    kind,
    title: unreadable
      ? LAUNCH_UNREADABLE_TITLE
      : headline ?? text(step.title, 200) ?? (stopsSpend ? (pauseName ? `Pause the LinkedIn campaign "${pauseName}"` : "Pause a live LinkedIn campaign") : "A job on this channel"),
    body: text(deliverable.content, 4000),
    why: text((withoutFrozenPeople({ step }, a.exec_class) as { step: typeof step }).step.body),
    where: kind === "post" || kind === "copy" || kind === "message" ? CHANNEL_NAME.get(a.channel_slug) ?? null : null,
    card_kind: a.card_kind,
    primary_label: draft ? "Review and create" : emailSendLabel(a.primary_label, a.exec_class),
    amount: a.exec_class ? budgetDelta(a.exec_payload) : null,
    effect: headline ?? (stopsSpend ? text(body.change_sentence) : null),
    tone: a.exec_status === "failed" ? "warn" : null,
    snoozed_until: a.status === "snoozed" ? liveSnooze(a.snoozed_until, now) : null,
    created_at: a.proposed_at,
    options: null,
    url: text(body.link, 2000),
    mins: EFFORT_MINS[String(step.effort ?? "")] ?? null,
    campaign_id: campaignOf(a.exec_payload) ?? campaignOf(step.target),
    platform: a.exec_class ? a.exec_class.split(".")[0] : null,
    account_id: a.channel_slug === "linkedin_ads" ? accountOf(a.exec_payload) ?? accountOf(step.target) : null,
    can_redo,
    redo_credits: can_redo ? channelRedoCredits(a.channel_slug, flatOn) : null,
    approve_blocked: unreadable ? LAUNCH_UNREADABLE_BLOCK : null,
    opens_review: draft,
    stops_live_spend: stopsSpend,
    exec_failed_at: a.exec_status === "failed" ? a.exec_claimed_at ?? a.proposed_at : null,
    ...launchSpend(a.exec_class, a.exec_payload),
  };
}

type DecisionRow = {
  id: string;
  agent_run_id?: string | null;
  decision_class: string;
  status: string;
  body: Record<string, unknown> | null;
  emitted_at: string;
  snoozed_until?: string | null;
};

function decisionChannel(d: DecisionRow): string | null {
  const b = obj(d.body);
  for (const v of [b.channel_slug, b.target_agent_slug, d.decision_class.split(".")[0]]) {
    if (typeof v === "string" && CHANNEL_NAME.has(v)) return v;
  }
  return null;
}

export function openCardFromDecision(d: DecisionRow, check = false, now: number = Date.now()): OpenCard {
  const b = obj(d.body);
  const headline = adChangeHeadline(d.decision_class, b);
  const unreadable = !check && launchUnreadable(d.decision_class, b);
  const channel = decisionChannel(d);
  const kind: OpenCardKind = check ? "check" : d.decision_class === CGO_CARD_CLASS ? "plan" : cardPlatform(d.decision_class) || /_ads\./.test(d.decision_class) ? "spend" : "task";
  const platform = channel ? CHANNEL_NAME.get(channel) ?? channel : "your ad account";
  return {
    source: "decision",
    id: d.id,
    channel_slug: channel,
    kind,
    title: check
      ? `Check ${platform}: a change Zavi sent may or may not have gone through`
      : unreadable
        ? LAUNCH_UNREADABLE_TITLE
        : headline ?? text(b.title, 200) ?? text(b.intent, 200) ?? text(b.summary, 200) ?? "A decision for you",
    body: check ? null : text(b.body) ?? text(b.description),
    why: check ? "Zavi won't send it again until you check." : text(b.context_summary) ?? text(b.rationale) ?? text(b.why),
    where: null,
    card_kind: null,
    primary_label: check ? "Check" : kind === "plan" || kind === "spend" ? "Approve" : null,
    amount: kind === "spend" ? budgetDelta(b) : null,
    effect: kind === "spend" ? headline : null,
    tone: check ? "danger" : null,
    snoozed_until: liveSnooze(d.snoozed_until, now),
    created_at: d.emitted_at,
    options: null,
    url: null,
    mins: null,
    campaign_id: kind === "spend" || check ? campaignOf(b) : null,
    platform: kind === "spend" || check ? d.decision_class.split(".")[0] : null,
    account_id: d.decision_class.startsWith("linkedin_ads.") ? accountOf(b) : null,
    can_redo: !check && d.decision_class === "channel.recipe_step" && d.status === "proposed" && !!d.agent_run_id,
    approve_blocked: unreadable ? LAUNCH_UNREADABLE_BLOCK : null,
    opens_review: false,
    stops_live_spend: false,
    exec_failed_at: null,
    ...(check ? { launch_usd: null, launch_ends_at: null } : launchSpend(d.decision_class, b)),
  };
}

export async function getGrowthOpenCards(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const tenant_id = auth.tenant_id;
  const db = tenantClient(asTenantId(tenant_id));
  try {
    const now = Date.now();
    const [actions, decisions, stuck, stoppedRows] = await Promise.all([
      db
        .from("channel_actions")
        .select("id, channel_slug, status, snoozed_until, proposed_at, body, exec_class, exec_status, exec_claimed_at, exec_payload, card_kind, primary_label, held_reason")
        .eq("tenant_id", tenant_id)
        .in("status", ["pending", "snoozed"])
        .order("proposed_at", { ascending: false })
        .limit(200),
      db
        .from("decisions")
        .select("id, agent_run_id, decision_class, status, body, emitted_at, snoozed_until, autonomy_at_emit")
        .eq("tenant_id", tenant_id)
        .eq("status", "proposed")
        .eq("autonomy_at_emit", "approval")
        .order("emitted_at", { ascending: false })
        .limit(100),
      db
        .from("decisions")
        .select("id, decision_class, status, body, emitted_at, dispatched_at, dispatch_error")
        .eq("tenant_id", tenant_id)
        .eq("status", "dispatching")
        .gte("dispatched_at", new Date(now - 14 * DAY_MS).toISOString())
        .limit(20),
      db
        .from("tenant_channels")
        .select("channel_slug")
        .eq("tenant_id", tenant_id)
        .eq("plan_selected_set_by", "founder_stopped"),
    ]);
    for (const r of [actions, decisions, stuck, stoppedRows]) if (r.error) throw new Error(r.error.message);
    const stopped = new Set(((stoppedRows.data ?? []) as Array<{ channel_slug: string }>).map((r) => r.channel_slug));

    let dfyState: DoneForYouState = "unavailable";
    let dfyRunId: string | null = null;
    let dfyActionId: string | null = null;
    let dfyEligible: ((a: ChannelActionRow) => DoneForYouMode | null) | null = null;
    let dfyDoneCard: string | null = null;
    try {
      const dfy = await readAndSettleDoneForYou(tenant_id, now);
      dfyState = dfy.summary.state;
      dfyRunId = dfy.summary.current?.run_id ?? null;
      dfyActionId = dfy.summary.current?.action_id ?? null;
      if (dfyState === "done") dfyDoneCard = dfy.summary.winner?.action_id ?? null;
      if (dfyState === "available") {
        const locked = new Map<string, boolean>();
        for (const slug of new Set(((actions.data ?? []) as ChannelActionRow[]).map((a) => a.channel_slug))) {
          locked.set(slug, await isChannelLocked(slug));
        }
        dfyEligible = (a) => {
          if (locked.get(a.channel_slug) !== false) return null;
          const e = doneForYouEligibility(a, now, dfy.summary.priorCantDo, dfy.facts);
          return e.eligible ? e.mode : null;
        };
      }
    } catch (e) {
      console.warn(`[growth-j6] done-for-you unreadable for tenant ${tenant_id}: ${(e as Error).message}`);
      dfyState = "unavailable";
    }

    const flatOn = await isFlatJobPricingOn();
    const items: OpenCard[] = [];
    for (const a of (actions.data ?? []) as ChannelActionRow[]) {
      if (a.exec_status === "queued" || a.exec_status === "dispatching" || a.exec_status === "executed") continue;
      if (obj(obj(obj(a.body).step).deliverable).kind === "strategy") continue;
      if (a.id === dfyDoneCard) continue;
      if (isPacedHold(a, now)) continue;
      items.push({ ...openCardFromAction(a, now, flatOn), dfy: dfyEligible ? dfyEligible(a) : null });
    }
    for (const d of (decisions.data ?? []) as DecisionRow[]) {
      const card = openCardFromDecision(d, false, now);
      if (card.channel_slug && stopped.has(card.channel_slug)) continue;
      items.push(card);
    }
    for (const d of (stuck.data ?? []) as Array<DecisionRow & { dispatched_at: string; dispatch_error: string | null }>) {
      if (String(d.dispatch_error ?? "").startsWith("founder_checked")) continue;
      if (!cardPlatform(d.decision_class) || now - Date.parse(d.dispatched_at) <= STUCK_AFTER_MS) continue;
      items.push(openCardFromDecision(d, true, now));
    }
    res.json({ items, done_for_you: { state: dfyState, attempt_run_id: dfyRunId, action_id: dfyActionId } });
  } catch (e) {
    console.warn(`[growth-j6] open cards unreadable for tenant ${tenant_id}: ${(e as Error).message}`);
    fail(res, 503, "open_cards_unavailable", "Could not load today's cards.");
  }
}

export async function postGrowthCardCopied(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params?.id;
  const source = (req.body as { source?: unknown } | undefined)?.source;
  if (typeof id !== "string" || !UUID_RE.test(id) || (source !== "channel_action" && source !== "decision")) {
    return fail(res, 400, "bad_request", "A card id and its source are required.");
  }
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.json({ ok: true, recorded: false });
    return;
  }
  const tenant_id = auth.tenant_id;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from(source === "channel_action" ? "channel_actions" : "decisions")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("id", id)
    .limit(1);
  if (error) return fail(res, 500, "read_failed", "Could not record that.");
  if (!Array.isArray(data) || data.length === 0) return fail(res, 404, "not_found", "No such card.");
  const outcome = await recordActivity({
    tenant_id,
    verb: "card.copy_clicked",
    actor_type: "operator",
    actor_id: auth.user_id,
    object_type: source,
    object_id: id,
    source: "web",
    dedupe_key: `card.copy_clicked:${id}:${auth.user_id}`,
  });
  if (outcome === "failed") return fail(res, 500, "write_failed", "Could not record that.");
  res.json({ ok: true, recorded: outcome === "inserted" });
}

export type DoneItem = {
  source: "channel_action" | "decision";
  id: string;
  channel_slug: string | null;
  title: string;
  done_at: string;
  by: "founder" | "zavi";
};

export async function getGrowthDoneWeek(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const tenant_id = auth.tenant_id;
  const db = tenantClient(asTenantId(tenant_id));
  const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
  try {
    const [actions, decisions] = await Promise.all([
      db
        .from("channel_actions")
        .select("id, channel_slug, status, status_at, body, exec_class, exec_status, exec_payload")
        .eq("tenant_id", tenant_id)
        .eq("status", "acted")
        .gte("status_at", since)
        .order("status_at", { ascending: false })
        .limit(200),
      db
        .from("decisions")
        .select("id, decision_class, status, body, emitted_at, approved_at")
        .eq("tenant_id", tenant_id)
        .eq("status", "acted")
        .gte("approved_at", since)
        .order("approved_at", { ascending: false })
        .limit(100),
    ]);
    for (const r of [actions, decisions]) if (r.error) throw new Error(r.error.message);
    const rows = (actions.data ?? []) as Array<ChannelActionRow & { status_at: string }>;

    const plain = rows.filter((a) => a.exec_status !== "executed").map((a) => a.id);
    const systemActed = new Set<string>();
    if (plain.length > 0) {
      const ev = await db
        .from("channel_action_events")
        .select("action_id, actor_kind")
        .eq("tenant_id", tenant_id)
        .eq("event", "acted")
        .in("action_id", plain);
      if (ev.error) throw new Error(ev.error.message);
      for (const e of (ev.data ?? []) as Array<{ action_id: string; actor_kind: string }>) {
        if (e.actor_kind !== "founder") systemActed.add(e.action_id);
      }
    }

    const items: DoneItem[] = [
      ...rows.map((a) => ({
        source: "channel_action" as const,
        id: a.id,
        channel_slug: a.channel_slug,
        title: openCardFromAction(a).title,
        done_at: a.status_at,
        by: a.exec_status === "executed" || systemActed.has(a.id) ? ("zavi" as const) : ("founder" as const),
      })),
      ...((decisions.data ?? []) as Array<DecisionRow & { approved_at: string }>).map((d) => ({
        source: "decision" as const,
        id: d.id,
        channel_slug: decisionChannel(d),
        title: openCardFromDecision(d).title,
        done_at: d.approved_at,
        by: "zavi" as const,
      })),
    ].sort((x, y) => y.done_at.localeCompare(x.done_at));
    res.json({ items });
  } catch (e) {
    console.warn(`[growth-j6] done-week unreadable for tenant ${tenant_id}: ${(e as Error).message}`);
    fail(res, 503, "done_week_unavailable", "Could not load what was done this week.");
  }
}

export async function getGrowthTests(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const raw = Number(req.query.days ?? 30);
  const days = Number.isInteger(raw) && raw >= 1 && raw <= 90 ? raw : 30;
  try {
    res.json(await readTestsSummary(auth.tenant_id, CGO_CARD_CLASS, new Date(), days));
  } catch (e) {
    console.warn(`[growth-j6] tests unreadable for tenant ${auth.tenant_id}: ${(e as Error).message}`);
    fail(res, 503, "tests_unavailable", "Could not load the tests.");
  }
}
