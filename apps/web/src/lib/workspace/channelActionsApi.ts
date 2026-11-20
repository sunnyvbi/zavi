
import { apiFetch } from "@/lib/api";
import { readWithRetry } from "./channelRead";
import type { ActionType } from "./actionTypes";
import type { AdReviewPresentation } from "@zavi/shared";

export type ChannelActionStatus =
  | "pending"
  | "acted"
  | "rejected"
  | "snoozed"
  | "redone"
  | "stale"
  | "displaced";

export type ExactChangeRow = { item: string; before: string; after: string };

export type StatTile = { value: string; caption: string };

export type ChannelActionBody = {
  ad_review?: AdReviewPresentation;
  step?: {
    responsibility?: "client" | "zavi";
    title?: string;
    body?: string;
    blocking?: boolean;
    effort?: "minutes" | "hours" | "days" | string;
    evidence?: string[];
    deliverable?: { kind?: string; label?: string; content?: string; parts?: Array<{ label?: string; content?: string }>; presentation?: { type: string; [key: string]: unknown } } | null;
    card_evidence?: {
      stats?: StatTile[];
      window?: { from: string; to: string };
      estimate?: StatTile[];
    } | null;
    target?: { kind?: string; ref?: string } | null;
    how_to?: string[];
    intent?: "fix_setup" | "improve" | "create" | "reach_out" | "review" | "answer" | string;
    owner?: "founder" | "developer" | string;
  };
  position?: number;
  of?: number;
  rendered_markdown?: string;
  action_key?: string;
  action_label?: string;
  kind_label?: string;
  media?: {
    kind: "image" | "video";
    url: string;
    alt?: string;
    download_url?: string;
    ai_generated?: boolean;
    artifact_id?: string;
  } | null;
  thread?: string[] | null;
  reply_to?: { author?: string; text?: string; url?: string } | null;
  recipient?: { name?: string; channel?: string } | null;
  change_sentence?: string | null;
  exact_change?: { rows: ExactChangeRow[] } | null;
  decision_evidence?: {
    stats?: StatTile[];
    window?: { from: string; to: string };
    estimate?: StatTile[];
    reason_text?: string;
  } | null;
  link?: string | null;
  intent?: "fix_setup" | "improve" | "create" | "reach_out" | "review" | "answer" | string;
  owner?: "founder" | "developer" | "zavi" | string;
  [key: string]: unknown;
};

export type ExecStatus = "queued" | "dispatching" | "executed" | "failed";
export type ExecBucket = "blocked_on_us" | "needs_founder" | "temporary" | "partial_risk";

export type CardKind = "executes" | "post" | "plan" | "message" | "ad_manual" | "copy_to_site" | "task";

export type EditedBody = import("@zavi/shared").SavedPostDraft;

export type CardOutcome = {
  readout_on: string | null;
  success_if: string;
  verdict?: "worked" | "did_not_work" | "not_measured";
  result?: string;
  spend_line?: string;
};

export type CardApproval = { by: "you" | "autopilot" | "teammate" | "zavi_team"; name: string | null; at: string };

export type CardTimelineEvent = {
  kind: "proposed" | "approved" | "sent" | "executed" | "failed" | "refused" | "revised";
  at: string;
  by?: CardApproval["by"];
};

export type ChannelActionView = {
  staged_draft_id?: string;
  post_revision?: string;
  ad_recommendation?: { reason: string } | null;
  id: string;
  channel_slug: string;
  run_id: string | null;
  position: number;
  run_of: number;
  blocking: boolean;
  action_type: ActionType;
  title: string;
  body: ChannelActionBody;
  status: ChannelActionStatus;
  note: string | null;
  snoozed_until: string | null;
  impact: number | null;
  impact_reason: string | null;
  score: number;
  score_inputs: Record<string, unknown>;
  proposed_at: string;
  repeat_of: string | null;
  redo_of: string | null;
  source: "channel_action";
  executable: boolean;
  approve_needs_admin?: boolean;
  exec_status: ExecStatus | null;
  exec_code?: string | null;
  exec_notice?: string | null;
  exec_bucket?: ExecBucket | null;
  exec_checkout_url?: string | null;
  exec_managed?: true;
  exec_fix_text?: string | null;
  exec_fix?: string | null;
  exec_receipt?: { line: string; url?: string } | null;
  executed_at?: string | null;
  outcome?: CardOutcome | null;
  approval?: CardApproval | null;
  exec_started_at?: string | null;
  timeline?: CardTimelineEvent[];
  exec_waiting?: "approvals" | null;
  held?: { words: string[]; evidence: string | null; wallet_short: boolean } | null;
  cap_warning?: string;
  email_card?: boolean;
  needs_contact_list?: boolean;
  edited_body: EditedBody | null;
  from_signup_preview_at?: string;
  card_kind?: CardKind | null;
  primary_label?: string | null;
  done_label?: string | null;
  how_to?: string[];
  steps_done?: number[];
  plan_day?: string | null;
  plan_day_source?: "scheduled" | "planned" | null;
  plan_time?: string | null;
  plan_timezone?: string | null;
  series?: PlanSeries | null;
  brief?: CardBrief;
};

export type CardBrief = { title: string; lead: string | null; points: string[]; steps: string[] };

export type PlanSeries = {
  id: string;
  name: string;
  format: string;
  episode: number;
  next: string[];
};

export const SIGNUP_PREVIEW_STALE_DAYS = 7;

export function signupPreviewWeeks(
  a: { from_signup_preview_at?: string | null },
  nowMs: number = Date.now(),
): number | null {
  if (!a.from_signup_preview_at) return null;
  const days = (nowMs - Date.parse(a.from_signup_preview_at)) / 86_400_000;
  if (!Number.isFinite(days) || days <= SIGNUP_PREVIEW_STALE_DAYS) return null;
  return Math.max(1, Math.floor(days / 7));
}

export type ChannelActionsList = {
  actions: ChannelActionView[];
  more: number;
  store: "channel_actions" | "decisions";
  completed?: ChannelActionView[];
  locked_preview?: { count: number; types: string[] };
  plan?: ChannelPlan;
  top_action_miss?: TopActionMiss;
  held_count?: number;
};

export type TopActionMissRepeat = { title: string; detail: string; credits: string | null; inputs: Record<string, unknown> };
export type TopActionMiss = { run_id: string; key: string; noun: string; reason: string; at: string; repeat?: TopActionMissRepeat };

export type ChannelPlan = {
  id: string;
  title: string;
  content: string;
  proposed_at: string;
  status: string;
};

const LOCKED_TYPE_LABEL: Record<string, string> = {
  fix: "Fix",
  check: "Check",
  page: "New page",
  send_message: "Message",
  video_post: "Video post",
  image_post: "Image post",
  text_post: "Post",
  reply: "Reply",
  create_ad: "New ad",
  update_ad: "Ad change",
  pause_ad: "Pause ad",
  setup: "Setup",
  other: "Action",
};

export function lockedTypeLabel(type: string): string {
  return Object.prototype.hasOwnProperty.call(LOCKED_TYPE_LABEL, type) ? LOCKED_TYPE_LABEL[type]! : "Action";
}

export type ChannelMetric = {
  key: string;
  value: number;
  unit: string | null;
  window_kind: string | null;
  day: string;
  grounded: boolean;
  prev_value: number | null;
  prev_day: string | null;
  outOf?: { max: number; of?: boolean; tail?: string };
  tone?: "good" | "warn" | "bad";
  note?: string;
  unmeasured?: string | true;
};

export type SetChannelActionInput = {
  action: "acted" | "rejected" | "snoozed" | "open";
  note?: string;
  until?: string;
  request_id?: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } | string };
  if (!res.ok) {
    const err = body.error;
    const message = typeof err === "string" ? err : err?.message;
    throw new ApiError(message ?? `HTTP ${res.status}`, res.status, body);
  }
  return body;
}

export function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function listChannelActions(slug: string, opts: { all?: boolean } = {}): Promise<ChannelActionsList> {
  const q = opts.all ? "?all=1" : "";
  const res = await readWithRetry(`/api/channels/${encodeURIComponent(slug)}/actions${q}`, { read: "actions", slug });
  const body = await readJson<Partial<ChannelActionsList>>(res);
  return {
    actions: body.actions ?? [],
    more: body.more ?? 0,
    store: body.store ?? "decisions",
    ...(Array.isArray(body.completed) ? { completed: body.completed } : {}),
    ...(body.locked_preview ? { locked_preview: body.locked_preview } : {}),
    ...(body.plan ? { plan: body.plan } : {}),
    ...(body.top_action_miss ? { top_action_miss: body.top_action_miss } : {}),
    ...(typeof body.held_count === "number" && body.held_count > 0 ? { held_count: body.held_count } : {}),
  };
}

export async function releaseHeldChannelActions(slug: string): Promise<{ released: number }> {
  const res = await apiFetch(`/api/channels/${encodeURIComponent(slug)}/actions/release-held`, { method: "POST", body: "{}" });
  return readJson<{ released: number }>(res);
}

export async function setChannelAction(id: string, input: SetChannelActionInput): Promise<unknown> {
  const res = await apiFetch(`/api/channel-actions/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ ...input, request_id: input.request_id ?? newRequestId() }),
  });
  return readJson<unknown>(res);
}

export type RedoKind = "answer";

export async function redoChannelAction(id: string, note: string, kind?: RedoKind): Promise<unknown> {
  const res = await apiFetch(`/api/channel-actions/${encodeURIComponent(id)}/redo`, {
    method: "POST",
    body: JSON.stringify(kind ? { note, kind } : { note }),
    idempotent: true,
  });
  return readJson<unknown>(res);
}

export async function readRedoRunStatus(runId: string): Promise<string | null> {
  const res = await apiFetch(`/api/agents/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { run?: { status?: unknown } } | null;
  return typeof body?.run?.status === "string" ? body.run.status : null;
}

export async function setChannelActionSteps(id: string, steps_done: number[]): Promise<{ ok: boolean; steps_done: number[] }> {
  const res = await apiFetch(`/api/channel-actions/${encodeURIComponent(id)}/steps`, {
    method: "POST",
    body: JSON.stringify({ steps_done }),
  });
  return readJson<{ ok: boolean; steps_done: number[] }>(res);
}

export async function approve(id: string, request_id: string = newRequestId()): Promise<unknown> {
  const res = await apiFetch(`/api/channel-actions/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify({ request_id }),
  });
  return readJson<unknown>(res);
}

export async function createLinkedInAudiences(id: string, content: string | null): Promise<{ line: string; replayed?: boolean }> {
  const res = await apiFetch(`/api/channels/linkedin_ads/actions/${encodeURIComponent(id)}/create-audiences`, {
    method: "POST",
    body: JSON.stringify(content ? { content } : {}),
  });
  return readJson<{ line: string; replayed?: boolean }>(res);
}

export type ChannelVideoCard = Pick<ChannelActionView, "id" | "title" | "body" | "status" | "note" | "exec_status" | "exec_code" | "exec_bucket" | "proposed_at">;

export async function readChannelVideoCard(id: string): Promise<ChannelVideoCard> {
  const res = await apiFetch(`/api/channel-actions/${encodeURIComponent(id)}/video-card`);
  return (await readJson<{ card: ChannelVideoCard }>(res)).card;
}

export async function readHistoryCard(id: string): Promise<ChannelActionView> {
  const res = await apiFetch(`/api/channel-actions/${encodeURIComponent(id)}/card`);
  return (await readJson<{ card: ChannelActionView }>(res)).card;
}

export async function listChannelMetrics(slug: string): Promise<ChannelMetric[]> {
  const res = await readWithRetry(`/api/channels/${encodeURIComponent(slug)}/metrics`, { read: "metrics", slug });
  const body = await readJson<{ metrics?: ChannelMetric[] }>(res);
  return body.metrics ?? [];
}
