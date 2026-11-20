import { apiJson } from "../../lib/api";
import type {
  ActionSource,
  ApprovalsResponse,
  ApproveActionResponse,
  ChannelDecision,
  ChannelsResponse,
  RedoActionResponse,
  RunChannelResponse,
  SaveStepsResponse,
} from "./types";
import type { ChannelHistory, ChannelMetric, ChannelPlan } from "./channelPage";
import type { ReviewAction } from "../growth/review";
import { isCustomerChannelAction } from "@zavi/shared";

function decisionPath(id: string): string {
  return `/api/approvals/${encodeURIComponent(id)}`;
}

function channelActionPath(id: string): string {
  return `/api/channel-actions/${encodeURIComponent(id)}`;
}

function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function fetchChannels(): Promise<ChannelsResponse> {
  return apiJson<ChannelsResponse>("/api/channels");
}

export function fetchChannelApprovals(slug?: string): Promise<ApprovalsResponse> {
  const query = slug ? `?channel=${encodeURIComponent(slug)}` : "";
  return apiJson<ApprovalsResponse>(`/api/approvals${query}`);
}

export async function approveAction(
  id: string,
  payloadText?: string,
  source: ActionSource = "decision",
): Promise<ApproveActionResponse> {
  if (source === "channel_action") {
    await apiJson<unknown>(channelActionPath(id), {
      method: "POST",
      body: JSON.stringify({ action: "acted", request_id: newRequestId() }),
    });
    return { ok: true, decision_id: id };
  }
  const body = payloadText === undefined ? {} : { payload_text: payloadText };
  return apiJson<ApproveActionResponse>(`${decisionPath(id)}/approve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function approveChange(id: string): Promise<{ ok: true; exec_status?: string }> {
  return apiJson<{ ok: true; exec_status?: string }>(`${channelActionPath(id)}/approve`, {
    method: "POST",
    body: JSON.stringify({ request_id: newRequestId(), via: "mobile" }),
  });
}

export function emailCardUrl(id: string): string {
  return `https://www.zaviagent.com/workspace/email-cards/channel_actions/${encodeURIComponent(id)}`;
}

export async function redoAction(
  id: string,
  message: string,
  source: ActionSource = "decision",
): Promise<RedoActionResponse> {
  if (source === "channel_action") {
    await apiJson<unknown>(`${channelActionPath(id)}/redo`, {
      method: "POST",
      body: JSON.stringify({ note: message }),
      idempotent: true,
    });
    return { ok: true, run_id: "", redo_of_decision_id: id };
  }
  return apiJson<RedoActionResponse>(`${decisionPath(id)}/redo`, {
    method: "POST",
    body: JSON.stringify({ message }),
    idempotent: true,
  });
}

export function runChannel(slug: string): Promise<RunChannelResponse> {
  return apiJson<RunChannelResponse>(
    `/api/channels/${encodeURIComponent(slug)}/run`,
    { method: "POST", body: JSON.stringify({ request_id: newRequestId() }) },
  );
}

export function saveActionSteps(id: string, stepsDone: number[]): Promise<SaveStepsResponse> {
  return apiJson<SaveStepsResponse>(`${channelActionPath(id)}/steps`, {
    method: "POST",
    body: JSON.stringify({ steps_done: stepsDone }),
  });
}

export async function fetchChannelMetrics(slug: string): Promise<ChannelMetric[]> {
  const body = await apiJson<{ metrics?: ChannelMetric[] }>(`/api/channels/${encodeURIComponent(slug)}/metrics`);
  return body?.metrics ?? [];
}

export async function fetchChannelHistory(slug: string): Promise<ChannelHistory> {
  const body = await apiJson<Partial<ChannelHistory>>(`/api/channels/${encodeURIComponent(slug)}/history`);
  return { runs: body?.runs ?? [], closed: body?.closed ?? [], pre_switch: body?.pre_switch ?? [] };
}

type LaneRow = {
  id: string;
  channel_slug: string;
  title?: string | null;
  body: unknown;
  status: string;
  proposed_at: string;
  action_type?: string | null;
  executable?: boolean;
  card_kind?: string | null;
  primary_label?: string | null;
  done_label?: string | null;
  how_to?: string[];
  steps_done?: number[];
  blocking?: boolean;
  redo_of?: string | null;
  exec_status?: string | null;
  exec_fix_text?: string | null;
  exec_receipt?: { line: string; url?: string } | null;
  approve_on_phone?: boolean;
  approve_needs_admin?: boolean;
  approve_money?: ChannelDecision["approve_money"];
  email_card?: boolean;
  from_signup_preview_at?: string | null;
};

function laneRowToDecision(r: LaneRow): ChannelDecision {
  return {
    id: r.id,
    decision_class: "channel.recipe_step",
    status: r.status,
    action_source: "channel_action",
    exec_class: r.executable ? "exec" : null,
    emitted_at: r.proposed_at,
    channel_slug: r.channel_slug,
    title: r.title ?? null,
    body: (r.body ?? null) as ChannelDecision["body"],
    card_kind: r.card_kind ?? null,
    primary_label: r.primary_label ?? null,
    done_label: r.done_label ?? null,
    how_to: r.how_to ?? [],
    steps_done: r.steps_done ?? [],
    blocking: r.blocking === true,
    redo_of: r.redo_of ?? null,
    exec_status: r.exec_status ?? null,
    exec_fix_text: r.exec_fix_text ?? null,
    exec_receipt: r.exec_receipt ?? null,
    approve_on_phone: r.approve_on_phone === true,
    ...(typeof r.approve_needs_admin === "boolean" ? { approve_needs_admin: r.approve_needs_admin } : {}),
    ...(r.approve_money ? { approve_money: r.approve_money } : {}),
    email_card: r.email_card === true,
    from_signup_preview_at: r.from_signup_preview_at ?? null,
  };
}

function isCustomerRow(r: LaneRow): boolean {
  return isCustomerChannelAction(r.channel_slug, r.body);
}

export type ChannelLane = {
  plan: ChannelPlan | null;
  types: Record<string, string>;
  store: "channel_actions" | "decisions";
  decisions: ChannelDecision[];
  zaviCount: number;
  done: ChannelDecision[] | undefined;
};

export async function fetchChannelLane(slug: string): Promise<ChannelLane> {
  const body = await apiJson<{ plan?: ChannelPlan | null; actions?: LaneRow[]; completed?: LaneRow[]; store?: "channel_actions" | "decisions" }>(
    `/api/channels/${encodeURIComponent(slug)}/actions?all=1`,
  );
  const rows = body?.actions ?? [];
  const types: Record<string, string> = {};
  for (const a of rows) if (a.action_type) types[a.id] = a.action_type;
  return {
    plan: body?.plan ?? null,
    types,
    store: body?.store ?? "decisions",
    decisions: rows.filter(isCustomerRow).map(laneRowToDecision),
    zaviCount: rows.filter((r) => !isCustomerRow(r)).length,
    done: body?.completed?.filter((r) => r.exec_status === "executed" && !!r.exec_receipt).slice(0, DONE_SHOWN).map(laneRowToDecision),
  };
}

const DONE_SHOWN = 3;

export function dismissAction(id: string, reason: { action: "rejected" | "snoozed"; note?: string; until?: string }): Promise<unknown> {
  return apiJson(channelActionPath(id), {
    method: "POST",
    body: JSON.stringify({ ...reason, request_id: newRequestId() }),
  });
}

export async function fetchChannelActionRows(slug: string): Promise<{ actions: ReviewAction[]; lockedPreview: number }> {
  const body = await apiJson<{ actions?: ReviewAction[]; locked_preview?: { count?: number } }>(
    `/api/channels/${encodeURIComponent(slug)}/actions?all=1`,
  );
  return { actions: body?.actions ?? [], lockedPreview: body?.locked_preview?.count ?? 0 };
}
