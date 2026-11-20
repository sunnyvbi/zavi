
import { apiFetch } from "@/lib/api";
import { EmailSettingsError } from "./emailCampaignSettingsApi";

export type Learning = {
  id: string;
  text: string;
  origin: "zavi" | "founder";
  status: "active" | "stale" | "suggested";
  split: string | null;
  route?: string | null;
  list_id: string | null;
  list_name: string | null;
  metric: "clicks" | "visitors" | null;
  stats: { n_a?: number; n_b?: number } & Record<string, unknown>;
  strength: "early" | "firm" | null;
  note: string | null;
  cant_recheck: boolean;
  from_zavi: boolean;
  version: number;
  updated_at: string;
  is_new: boolean;
};
export type SourceState = { route: string; status: "ok" | "partial" | "could_not_read" | "busy"; count: number; read_at: string };
export type LearningsView = {
  items: Learning[];
  dismissed: number;
  state: {
    last_run_at: string | null;
    full_skipped: number;
    kept_stronger: number;
    sources: Record<string, SourceState>;
    seeded_at: string | null;
    seed_requested_at?: string | null;
    updated_at: string | null;
  } | null;
  tools_connected?: boolean | null;
};
export type RemovedLearning = { id: string; text: string; origin: "zavi" | "founder"; version: number };
export type LearningAction = "add" | "edit" | "dismiss" | "restore" | "activate";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, init);
  } catch {
    throw new EmailSettingsError("network", "We could not reach Zavi. Check your connection and try again.", 0);
  }
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) throw new EmailSettingsError(body?.error?.code ?? "error", body?.error?.message ?? "Something went wrong. Try again.", res.status);
  return body as T;
}

export const getLearnings = () => request<LearningsView>("/api/workspace/email-learnings");
export const getRemovedLearnings = () => request<{ items: RemovedLearning[] }>("/api/workspace/email-learnings/removed");
export const setLearning = (a: { action: LearningAction; id?: string; text?: string; version?: number }) =>
  request<{ ok: true; id: string; version: number; status: string }>("/api/workspace/email-learnings", { method: "POST", body: JSON.stringify(a) });
export const lookAgain = () => request<{ ok: true; status: "queued" | "pending" | "done" | "failed_today"; queued: boolean; message: string }>("/api/workspace/email-learnings/look-again", { method: "POST" });
export const markLearningsSeen = (items: Array<{ id: string; version: number }>) =>
  request<{ ok: true; marked: number }>("/api/workspace/email-learnings/seen", { method: "POST", body: JSON.stringify({ items }) });

export const unseenCount = (v: LearningsView | null) => (v ? v.items.filter((l) => l.is_new).length : 0);

export const LEARNINGS_SEEN_EVENT = "zavi:email-learnings-seen";
