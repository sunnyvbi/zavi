"use client";

import { apiFetch } from "@/lib/api";
import { approveDecision, rejectDecision } from "@/lib/approvals/approveDecision";
import { newRequestId } from "@/lib/workspace/channelActionsApi";
import { announceAdBudgetChange } from "../adBudgetEvents";

export type CardKind =
  | "check"
  | "reconnect"
  | "spend"
  | "link"
  | "post"
  | "copy"
  | "message"
  | "question"
  | "task"
  | "connect"
  | "plan";

export type OpenCard = {
  source: "channel_action" | "decision";
  id: string;
  channel_slug: string | null;
  kind: CardKind;
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
  options?: string[] | null;
  url: string | null;
  mins: number | null;
  campaign_id: string | null;
  account_id?: string | null;
  can_redo: boolean;
  redo_credits?: number | null;
  platform: string | null;
  dfy?: DfyMode | null;
  approve_blocked?: string | null;
  opens_review?: boolean;
  stops_live_spend?: boolean;
  exec_failed_at?: string | null;
  launch_usd?: number | null;
  launch_ends_at?: number | null;
};

export type TestVerdict = "worked" | "did_not_work" | "not_measured" | null;
export type TestsRead = {
  won: number;
  lost: number;
  never_launched: number;
  running: number;
  next_read_on: string | null;
  items: Array<{
    decision_id: string;
    channel_slug: string | null;
    title: string;
    verdict: TestVerdict;
    launch: "launched" | "in_progress" | "blocked" | "never_ran";
    read_on: string | null;
  }>;
};

export type DoneItem = {
  source: string;
  id: string;
  channel_slug: string | null;
  title: string;
  done_at: string;
  by: "founder" | "zavi";
};

export type Forecast = {
  daily_usd: number | null;
  runs_out_on: string | null;
  projected_month_usd: number | null;
};

export type AdBudgetRead = {
  budget: {
    id: string;
    status: "active" | "stopped";
    monthly_usd: number;
    daily_limit_usd: number | null;
    month_cap_usd: number;
    spent_usd: number;
    held_usd: number;
    left_usd: number;
    next_month_start: string;
    days_left: number;
  } | null;
  can_manage: boolean;
  pro: boolean;
  forecast: Forecast | null;
};

export type LedgerChange = {
  at: string;
  kind: string;
  action: string;
  result: string;
  by?: string;
  undo?: { change_id: string; change: string } | null;
};

export type HistoryPoint = { at: string; value: number };

export type WriteResult = { ok: boolean; message: string | null; body?: Record<string, unknown> };

const JSON_HEADERS = { "Content-Type": "application/json" };

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const res = await apiFetch(path);
    if (!res.ok) return null;
    return ((await res.json().catch(() => null)) as T | null) ?? null;
  } catch {
    return null;
  }
}

async function result(res: Response | null, fallback: string): Promise<WriteResult> {
  if (!res) return { ok: false, message: null };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: { message?: string } | string;
    problems?: string[];
  };
  if (res.ok) return { ok: true, message: null, body };
  const err = body.error;
  const message = body.problems?.[0] ?? (typeof err === "string" ? err : err?.message) ?? fallback;
  return { ok: false, message, body };
}

async function send(path: string, method: "POST" | "PUT" | "PATCH", body: unknown, fallback: string): Promise<WriteResult> {
  try {
    const res = await apiFetch(path, {
      method,
      headers: JSON_HEADERS,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return await result(res, fallback);
  } catch {
    return { ok: false, message: fallback };
  }
}

const CARD_KINDS = new Set<CardKind>(["check", "reconnect", "spend", "link", "post", "copy", "message", "question", "task", "connect", "plan"]);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function openCardsOf(raw: unknown): OpenCard[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((c): OpenCard[] => {
    if (!c || typeof c !== "object") return [];
    const x = c as Record<string, unknown>;
    if (typeof x.id !== "string" || typeof x.title !== "string") return [];
    if (x.source !== "channel_action" && x.source !== "decision") return [];
    if (!CARD_KINDS.has(x.kind as CardKind)) return [];
    const options = Array.isArray(x.options) ? x.options.filter((o): o is string => typeof o === "string" && !!o.trim()) : null;
    return [
      {
        source: x.source,
        id: x.id,
        channel_slug: str(x.channel_slug),
        kind: x.kind as CardKind,
        title: x.title,
        body: str(x.body),
        why: str(x.why),
        where: str(x.where),
        card_kind: str(x.card_kind),
        primary_label: str(x.primary_label),
        amount: typeof x.amount === "number" && Number.isFinite(x.amount) ? x.amount : null,
        effect: str(x.effect),
        tone: x.tone === "danger" || x.tone === "warn" ? x.tone : null,
        snoozed_until: str(x.snoozed_until),
        created_at: typeof x.created_at === "string" ? x.created_at : "",
        url: typeof x.url === "string" && /^https?:\/\//i.test(x.url) ? x.url : null,
        mins: typeof x.mins === "number" && Number.isFinite(x.mins) && x.mins > 0 ? x.mins : null,
        campaign_id: str(x.campaign_id),
        account_id: str(x.account_id),
        can_redo: x.can_redo === true,
        redo_credits: x.can_redo === true && Number.isInteger(x.redo_credits) && (x.redo_credits as number) > 0 ? (x.redo_credits as number) : null,
        platform: str(x.platform),
        dfy: x.dfy === "research" || x.dfy === "visual" ? x.dfy : null,
        approve_blocked: str(x.approve_blocked),
        opens_review: x.opens_review === true,
        stops_live_spend: x.stops_live_spend === true,
        exec_failed_at: str(x.exec_failed_at),
        launch_usd: typeof x.launch_usd === "number" && Number.isFinite(x.launch_usd) && x.launch_usd > 0 ? x.launch_usd : null,
        launch_ends_at: typeof x.launch_ends_at === "number" && Number.isFinite(x.launch_ends_at) ? x.launch_ends_at : null,
        ...(options && options.length >= 2 ? { options: options.slice(0, 2) } : {}),
      },
    ];
  });
}

export async function readOpenCards(): Promise<OpenCard[] | null> {
  const body = await readJson<unknown>("/api/workspace/growth/open-cards");
  return body === null ? null : openCardsOf(body);
}

export async function readTests(): Promise<TestsRead | null> {
  const b = await readJson<Partial<TestsRead>>("/api/workspace/growth/tests?days=30");
  if (!b) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    won: n(b.won),
    lost: n(b.lost),
    never_launched: n(b.never_launched),
    running: n(b.running),
    next_read_on: str(b.next_read_on),
    items: Array.isArray(b.items) ? b.items.filter((i) => i && typeof i.title === "string") : [],
  };
}

export async function readDoneWeek(): Promise<DoneItem[] | null> {
  const b = await readJson<{ items?: unknown }>("/api/workspace/growth/done-week");
  if (!b) return null;
  return Array.isArray(b.items)
    ? (b.items as DoneItem[]).filter((i) => i && typeof i.title === "string" && typeof i.done_at === "string")
    : [];
}

export async function readAdBudget(): Promise<AdBudgetRead | null> {
  const b = await readJson<Partial<AdBudgetRead>>("/api/workspace/ad-budget");
  if (!b) return null;
  const f = b.forecast as Partial<Forecast> | null | undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    budget: b.budget ?? null,
    can_manage: b.can_manage === true,
    pro: b.pro === true,
    forecast: f
      ? { daily_usd: num(f.daily_usd), runs_out_on: str(f.runs_out_on), projected_month_usd: num(f.projected_month_usd) }
      : null,
  };
}

export async function readLedgerChanges(): Promise<LedgerChange[] | null> {
  const b = await readJson<{ rows?: LedgerChange[] }>("/api/workspace/ad-budget/ledger");
  if (!b) return null;
  return (b.rows ?? []).filter((r) => r.kind === "change");
}

export async function readChannelCounts(): Promise<Record<string, number> | null> {
  const b = await readJson<{ channel_pending_counts?: Record<string, number> }>("/api/approvals");
  return b ? (b.channel_pending_counts ?? {}) : null;
}

export async function readConnectedSlugs(): Promise<string[] | null> {
  try {
    const res = await apiFetch("/api/connectors");
    if (!res.ok) return null;
    const body = (await res.json()) as { connectors?: Array<{ slug: string }> };
    return (body.connectors ?? []).map((c) => c.slug);
  } catch {
    return null;
  }
}

export async function readGoalHistory(goalId: string): Promise<HistoryPoint[] | null> {
  const b = await readJson<{ points?: HistoryPoint[] }>(`/api/workspace/autopilot/goals/${encodeURIComponent(goalId)}/history`);
  return b && Array.isArray(b.points) ? b.points : null;
}

export function setCard(id: string, action: "acted" | "rejected" | "snoozed" | "open", note?: string): Promise<WriteResult> {
  return send(
    `/api/channel-actions/${encodeURIComponent(id)}`,
    "POST",
    { action, ...(note ? { note } : {}), request_id: newRequestId() },
    action === "open" ? "Could not put that back." : "Could not save that. Try again.",
  );
}

export function recordCopy(card: OpenCard): Promise<WriteResult> {
  return send(`/api/workspace/growth/cards/${encodeURIComponent(card.id)}/copied`, "POST", { source: card.source }, "");
}

export async function approveCard(card: OpenCard): Promise<WriteResult> {
  if (card.source === "channel_action") {
    return send(`/api/channel-actions/${encodeURIComponent(card.id)}/approve`, "POST", { request_id: newRequestId() }, "Could not approve that.");
  }
  try {
    const res = await approveDecision(card.id, {}, undefined, { surface: "growth" });
    if (res === null) return { ok: false, message: null };
    return await result(res, "Could not approve that.");
  } catch {
    return { ok: false, message: "Could not approve that." };
  }
}

export function redoDecision(id: string, message: string): Promise<WriteResult> {
  return send(`/api/approvals/${encodeURIComponent(id)}/redo`, "POST", { message }, "Could not send that.");
}

export function proposeLinkedInPause(campaignId: string, accountId: string): Promise<WriteResult> {
  return send(
    `/api/channels/linkedin_ads/campaigns/${encodeURIComponent(campaignId)}/propose-pause`,
    "POST",
    { account_id: accountId },
    "Zavi couldn't file the pause. Try again in a moment.",
  );
}

export function snoozeDecision(id: string): Promise<WriteResult> {
  return send(`/api/approvals/${encodeURIComponent(id)}/snooze`, "POST", {}, "Could not move that to later.");
}

export function unsnoozeDecision(id: string): Promise<WriteResult> {
  return send(`/api/approvals/${encodeURIComponent(id)}/unsnooze`, "POST", {}, "Could not put that back.");
}

export async function rejectCard(card: OpenCard, why: string): Promise<WriteResult> {
  if (card.source === "channel_action") return setCard(card.id, "rejected", why || undefined);
  try {
    return await result(await rejectDecision(card.id, { surface: "growth" }), "Could not reject that.");
  } catch {
    return { ok: false, message: "Could not reject that." };
  }
}

export function redoCard(id: string, note: string): Promise<WriteResult> {
  return send(`/api/channel-actions/${encodeURIComponent(id)}/redo`, "POST", { note }, "Could not send that.");
}

export function answerQuestion(id: string, answer: "yes" | "no" | "not_now" | { text: string }): Promise<WriteResult> {
  return send(`/api/workspace/growth/questions/${encodeURIComponent(id)}/answer`, "POST", { answer }, "Could not save your answer. Try again.");
}

export function checkDecision(id: string, went_through: boolean): Promise<WriteResult> {
  return send(`/api/workspace/decisions/${encodeURIComponent(id)}/check`, "POST", { went_through }, "Could not record that. Nothing changed.");
}

export async function saveDraft(id: string, text: string): Promise<WriteResult> {
  const path = `/api/channel-actions/${encodeURIComponent(id)}/post-draft`;
  const read = await readJson<{ revision?: string; content?: { thread?: string[] | null } | null; editable?: boolean }>(path);
  if (!read?.revision) return { ok: false, message: "Could not load the draft to edit." };
  if (read.editable === false) return { ok: false, message: "This draft can't be edited any more." };
  return send(path, "PUT", { revision: read.revision, content: { text, thread: read.content?.thread ?? null } }, "Could not save your edit.");
}

export function setChannelInPlan(slug: string, inPlan: boolean): Promise<WriteResult> {
  return send(
    `/api/workspace/growth/channels/${encodeURIComponent(slug)}/plan`,
    "POST",
    { in_plan: inPlan },
    inPlan ? "Could not add that channel." : "Could not stop that channel.",
  );
}

export function agreeConstraint(agreed: boolean): Promise<WriteResult> {
  return send("/api/workspace/growth/constraint/agree", "POST", agreed ? {} : { agreed: false }, "Could not save that.");
}

export function setFounderConstraint(text: string | null): Promise<WriteResult> {
  return send("/api/workspace/growth/constraint/founder", "POST", { text }, "Could not save your view.");
}

export function switchConstraint(hypothesisId: string): Promise<WriteResult> {
  return send("/api/workspace/growth/constraint/switch", "POST", { hypothesis_id: hypothesisId }, "Could not switch the plan.");
}

export function keepMine(hypothesisId: string, kept: boolean): Promise<WriteResult> {
  return send(`/api/workspace/growth/conflicts/${encodeURIComponent(hypothesisId)}/keep`, "POST", { kept }, "Could not save that.");
}

export function setAutopilot(enabled: boolean): Promise<WriteResult> {
  return send("/api/workspace/growth/autopilot", "PUT", { enabled }, "Could not save that. Try again.");
}

export function patchGoal(id: string, patch: Record<string, unknown>): Promise<WriteResult> {
  return send(`/api/workspace/autopilot/goals/${encodeURIComponent(id)}`, "PATCH", patch, "Could not save that number.");
}

export async function saveBudget(id: string, monthly_usd: number, daily_limit_usd: number | null): Promise<WriteResult> {
  const r = await send(`/api/workspace/ad-budget/${encodeURIComponent(id)}`, "PATCH", { monthly_usd, daily_limit_usd }, "Could not save that. Try again.");
  if (r.ok) announceAdBudgetChange();
  return r;
}

export async function undoAdChange(changeId: string): Promise<WriteResult> {
  const staged = await send(`/api/workspace/ad-budget/changes/${encodeURIComponent(changeId)}/undo`, "POST", undefined, "Could not set up the undo. Try again.");
  const decisionId = staged.body?.decision_id;
  if (!staged.ok || typeof decisionId !== "string") return { ok: false, message: staged.message ?? "Could not set up the undo. Try again." };
  try {
    const res = await approveDecision(decisionId, {}, undefined, { surface: "growth" });
    if (!res || !res.ok) return { ok: false, message: "The undo is waiting in your approvals: it could not be confirmed from here." };
    return { ok: true, message: null };
  } catch {
    return { ok: false, message: "The undo is waiting in your approvals: it could not be confirmed from here." };
  }
}

export type DfyMode = "research" | "visual";
export type DfyState = "available" | "running" | "done" | "used_up" | "unavailable";
export type DoneForYou = {
  state: DfyState;
  run_id: string | null;
  action_id: string | null;
  mode: DfyMode | null;
  attempts_used: number;
  last_outcome: "executed" | "cannot_do" | "failed" | null;
  result: { markdown: string; caption: string | null; images: Array<{ id: string }> } | null;
};

const DFY_STATES = new Set<DfyState>(["available", "running", "done", "used_up", "unavailable"]);

export function doneForYouOf(raw: unknown): DoneForYou {
  const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const r = (x.result && typeof x.result === "object" ? x.result : null) as Record<string, unknown> | null;
  const images = Array.isArray(r?.images)
    ? (r!.images as unknown[]).flatMap((i) => (i && typeof (i as { id?: unknown }).id === "string" ? [{ id: (i as { id: string }).id }] : []))
    : [];
  const last = x.last_outcome;
  return {
    state: DFY_STATES.has(x.state as DfyState) ? (x.state as DfyState) : "unavailable",
    run_id: str(x.run_id),
    action_id: str(x.action_id),
    mode: x.mode === "research" || x.mode === "visual" ? x.mode : null,
    attempts_used: typeof x.attempts_used === "number" && Number.isFinite(x.attempts_used) ? x.attempts_used : 0,
    last_outcome: last === "executed" || last === "cannot_do" || last === "failed" ? last : null,
    result: r ? { markdown: typeof r.markdown === "string" ? r.markdown : "", caption: str(r.caption), images } : null,
  };
}

export async function readDoneForYou(): Promise<DoneForYou | null> {
  const body = await readJson<unknown>("/api/workspace/growth/done-for-you");
  return body === null ? null : doneForYouOf(body);
}

export function startDoneForYou(action_id: string): Promise<WriteResult> {
  return send("/api/workspace/growth/done-for-you", "POST", { action_id, request_id: newRequestId() }, "Couldn't start it. Try again.");
}

export async function dfyImageUrl(id: string): Promise<string | null> {
  const body = await readJson<{ signed_url?: unknown }>(`/api/run-artifacts/${encodeURIComponent(id)}/url`);
  return typeof body?.signed_url === "string" ? body.signed_url : null;
}
