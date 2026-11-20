import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { putItems, type SettingItem } from "./channelSettings";
import { REDDIT_SLUG, scanError, sendError, withVerdict, type RedditPayload, type ThreadErrorBody } from "./reddit";

export const redditKey = (tenant: string) => ["reddit-dashboard", tenant] as const;

export function useRedditDashboard(enabled = true) {
  const tenant = useActiveTenant();
  const q = useQuery({
    queryKey: redditKey(tenant),
    enabled: enabled && tenant !== "none",
    queryFn: () => apiJson<RedditPayload>(`/api/agents/${REDDIT_SLUG}/dashboard?days=30&window=last_30d`),
    refetchInterval: (query) =>
      query.state.data?.workspace_v2 !== false && query.state.data?.insights?.sweep?.last?.status === "running" ? 20_000 : false,
  });
  return q;
}

export function useRefreshReddit() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return async () => {
    const data = await apiJson<RedditPayload>(`/api/agents/${REDDIT_SLUG}/dashboard?days=30&refresh=1&window=last_30d`);
    queryClient.setQueryData(redditKey(tenant), data);
    return data;
  };
}

async function errorBody(res: Response): Promise<{ error?: { code?: string; message?: string }; reason?: string } | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function startScan(): Promise<string | null> {
  let res: Response;
  try {
    res = await apiFetch("/api/reddit/sweep", {
      method: "POST",
      body: JSON.stringify({ trigger: "manual" }),
      retryOnNetworkError: false,
    });
  } catch {
    return scanError(null);
  }
  return res.ok ? null : scanError(res.status, await errorBody(res));
}

async function send(path: string, init: RequestInit): Promise<string | null> {
  try {
    const res = await apiFetch(path, { ...init, retryOnNetworkError: false });
    return res.ok ? null : sendError(res.status, (await errorBody(res)) as ThreadErrorBody);
  } catch {
    return sendError(null);
  }
}

export const draftReply = (threadId: string) =>
  send(`/api/reddit/threads/${encodeURIComponent(threadId)}/draft`, { method: "POST" });

export const markReplyPosted = (threadId: string) =>
  send(`/api/reddit/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    body: JSON.stringify({ draft_state: "posted" }),
  });

export const saveReplyDraft = (threadId: string, text: string) =>
  send(`/api/reddit/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    body: JSON.stringify({ draft_state: "drafted", draft_text: text.trim() }),
  });

export const dismissReplyDraft = (threadId: string) =>
  send(`/api/reddit/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    body: JSON.stringify({ draft_state: "dismissed" }),
  });

export async function saveVerdict(name: string, verdict: string | null): Promise<string | null> {
  let items: SettingItem[];
  try {
    const res = await apiFetch(`/api/channels/${REDDIT_SLUG}/settings`);
    if (!res.ok) return "Couldn't read your communities. Try again in a moment.";
    const body = (await res.json()) as { fields?: Record<string, SettingItem[]> };
    items = body.fields?.communities ?? [];
  } catch {
    return "Couldn't read your communities. Try again in a moment.";
  }
  try {
    const res = await apiFetch(`/api/channels/${REDDIT_SLUG}/settings/communities`, {
      method: "PUT",
      body: JSON.stringify({ items: putItems(withVerdict(items, name, verdict)) }),
    });
    if (res.status === 403) return "Only an owner or an admin can change this.";
    return res.ok ? null : "Couldn't save that. Try again in a moment.";
  } catch {
    return "Couldn't save that. Try again in a moment.";
  }
}

