
import { apiFetch } from "@/lib/api";
import { ApiError, type ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { PLAN_FALLBACK, timedFetch } from "@/lib/workspace/emailPlanApi";

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } | string; message?: string };
  if (!res.ok) {
    const err = body.error;
    const message =
      res.status === 409 && err === "already_exists"
        ? "Already saved."
        : (typeof body.message === "string" && body.message) || (typeof err === "string" ? err : err?.message);
    throw new ApiError(message || PLAN_FALLBACK, res.status, body);
  }
  return body;
}

export const CHANNEL_RUN_STARTED_EVENT = "zavi:channel-run-started";

const recentRunStarts = new Map<string, { at: number; runId: string | null }>();

export function recentChannelRun(slug: string, withinMs: number): { at: number; runId: string | null } | null {
  const run = recentRunStarts.get(slug);
  return run !== undefined && Date.now() - run.at < withinMs ? run : null;
}

export function recentChannelRunStart(slug: string, withinMs: number): number | null {
  return recentChannelRun(slug, withinMs)?.at ?? null;
}

export function forgetChannelRun(slug: string, runId: string | null = null): void {
  const run = recentRunStarts.get(slug);
  if (run && (run.runId === null || runId === null || run.runId === runId)) recentRunStarts.delete(slug);
}

export function announceChannelRunStarted(slug: string, runId: string | null = null): void {
  recentRunStarts.set(slug, { at: Date.now(), runId });
  window.dispatchEvent(new CustomEvent(CHANNEL_RUN_STARTED_EVENT, { detail: { slug } }));
}

export const TOP_ACTION_AGAIN_EVENT = "zavi:top-action-again";

export function askTopActionAgain(slug: string, key: string, inputs?: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(TOP_ACTION_AGAIN_EVENT, { detail: { slug, key, ...(inputs ? { inputs } : {}) } }));
}

export const CHANNEL_ACTIONS_CHANGED_EVENT = "zavi:channel-actions-changed";

export function announceChannelActionsChanged(slug: string): void {
  window.dispatchEvent(new CustomEvent(CHANNEL_ACTIONS_CHANGED_EVENT, { detail: { slug } }));
}

export const START_UNREACHABLE = "We could not reach Zavi. Check your connection and try again.";

const base = (slug: string) => `/api/channels/${encodeURIComponent(slug)}/top-actions`;

export async function startTopAction(
  slug: string,
  key: string,
  request_id: string,
  inputs: Record<string, unknown>,
): Promise<{ run_id: string | null; duplicate?: boolean }> {
  let res: Response;
  try {
    res = await timedFetch(`${base(slug)}/${encodeURIComponent(key)}`, {
      method: "POST",
      body: JSON.stringify({ request_id, inputs }),
    });
  } catch {
    throw new ApiError(START_UNREACHABLE, 0);
  }
  return json(res);
}

export async function readTopActionRun(slug: string, run_id: string): Promise<{ status: string; actions: ChannelActionView[]; summary?: string | null; note?: string | null }> {
  const res = await apiFetch(`${base(slug)}/runs/${encodeURIComponent(run_id)}`);
  return json(res);
}

export async function readTopActionContext(slug: string, key: string): Promise<{ currency?: string; credits?: number }> {
  const res = await apiFetch(`${base(slug)}/${encodeURIComponent(key)}/context`);
  return json(res);
}

export const APPROVALS_CHANGED_EVENT = "zavi:approvals-changed";
export const TOP_ACTION_OPEN_EVENT = "zavi:top-action-open";

export async function proposeSocialPost(
  channel: string,
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ decision_id: string }> {
  const res = await apiFetch("/api/social/propose", {
    method: "POST",
    body: JSON.stringify({ channel, payload }),
    idempotent: true,
    ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
  });
  return json(res);
}

export async function sendTikTokDraft(video_path: string): Promise<{ publish_id: string }> {
  const res = await apiFetch("/api/channels/tiktok_organic/drafts", {
    method: "POST",
    body: JSON.stringify({ video_path, consent: true }),
    idempotent: true,
  });
  return json(res);
}

export async function addRedditCommunity(name: string): Promise<unknown> {
  const res = await apiFetch("/api/reddit/workspace/communities", { method: "POST", body: JSON.stringify({ name }) });
  return json(res);
}

export async function addGeoQuestion(text: string): Promise<unknown> {
  const res = await apiFetch("/api/geo/prompts", { method: "POST", body: JSON.stringify({ text }) });
  return json(res);
}

export async function addGeoRival(name: string): Promise<{ baseline_reset?: boolean; dropped?: number; rivals?: string[] }> {
  const res = await apiFetch("/api/geo/rivals", { method: "POST", body: JSON.stringify({ name }) });
  return json(res);
}

export async function startStarterVideos(): Promise<{ run_id?: string | null; duplicate?: boolean }> {
  const res = await apiFetch("/api/channels/generated_video/starters", { method: "POST", body: "{}" });
  return json(res);
}

export const CHANNEL_TAB_EVENT = "zavi:channel-tab";

export type BoostPost = {
  id: string;
  message: string | null;
  created_time: string | null;
  picture: string | null;
  permalink: string | null;
  likes: number;
  comments: number;
  shares: number;
};

export type BoostOptions =
  | {
      eligible: true;
      pages: Array<{ id: string; name: string }>;
      page_id: string;
      posts: BoostPost[];
      posts_note: string | null;
      counts_hidden?: boolean;
      ad_sets: Array<{ id: string; name: string; status: string | null }>;
    }
  | { eligible: false; reason_code: string; reason: string };

export async function readBoostOptions(page_id?: string): Promise<BoostOptions> {
  const q = page_id ? `?page_id=${encodeURIComponent(page_id)}` : "";
  const res = await apiFetch(`/api/channels/meta_ads/boost/options${q}`);
  return json(res);
}

export async function createBoostAd(body: { page_id: string; post_id: string; ad_set_id: string; request_id: string }): Promise<{ ad_id: string; status: "PAUSED"; ads_manager_url: string }> {
  const res = await apiFetch("/api/channels/meta_ads/boost", {
    method: "POST",
    body: JSON.stringify(body),
    idempotent: true,
  });
  return json(res);
}

export function mostEngaged(posts: readonly BoostPost[]): BoostPost | null {
  let best: BoostPost | null = null;
  for (const p of posts) if (!best || p.likes + p.comments + p.shares > best.likes + best.comments + best.shares) best = p;
  return best;
}

export function currencySymbol(code: string | undefined): string | null {
  if (!code) return null;
  try {
    const part = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).formatToParts(0).find((p) => p.type === "currency");
    return part?.value ?? code;
  } catch {
    return code;
  }
}
