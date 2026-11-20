import { apiFetch, apiJson } from "../../lib/api";
import { isSettled } from "../../lib/status";
import { supabase } from "../../lib/supabase";
import type {
  AgentsResponse,
  ChatAttachment,
  ChatHistoryResponse,
  ChatMessage,
  RunProgressResponse,
  RunStatusResponse,
  SendChatResponse,
  ThreadsResponse,
} from "./types";

export function fetchAgents(): Promise<AgentsResponse> {
  return apiJson<AgentsResponse>("/api/agents");
}

export async function fetchChatHistory(
  slug: string,
  threadId?: string,
): Promise<ChatHistoryResponse> {
  const q = threadId ? `?thread_id=${encodeURIComponent(threadId)}` : "";
  const history = await apiJson<ChatHistoryResponse>(
    `/api/agents/${slug}/chat/history${q}`,
  );
  return { ...history, messages: await withAttachments(history) };
}

async function withAttachments(history: ChatHistoryResponse) {
  const threadId = history.thread?.id;
  if (!threadId || history.messages.length === 0) return history.messages;
  const { data, error } = await supabase
    .from("agent_thread_messages")
    .select("id, attachments, meta")
    .eq("thread_id", threadId);
  if (error || !data || data.length === 0) return history.messages;

  type Row = { id: string; attachments: ChatAttachment[] | null; meta: unknown };
  const byId = new Map<string, Pick<ChatMessage, "attachments" | "meta">>();
  for (const row of data as Row[]) {
    const extra: Pick<ChatMessage, "attachments" | "meta"> = {};
    if (Array.isArray(row.attachments) && row.attachments.length > 0) {
      extra.attachments = row.attachments;
    }
    if (row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)) {
      extra.meta = row.meta as Record<string, unknown>;
    }
    if (extra.attachments || extra.meta) byId.set(row.id, extra);
  }
  if (byId.size === 0) return history.messages;
  return history.messages.map((m) => {
    const extra = byId.get(m.id);
    return extra ? { ...m, ...extra } : m;
  });
}

export async function fetchRunUnsettled(runId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("agent_runs")
      .select("status")
      .eq("id", runId)
      .maybeSingle();
    if (error || !data) return false;
    return !isSettled(data as { status?: string | null });
  } catch {
    return false;
  }
}

export type RunDepth = "light" | "deep";

export async function fetchRunDepths(runIds: string[]): Promise<Map<string, RunDepth>> {
  const depths = new Map<string, RunDepth>();
  if (runIds.length === 0) return depths;
  try {
    const { data, error } = await supabase
      .from("agent_runs")
      .select("id, routing_decision")
      .in("id", runIds);
    if (error || !data) return depths;
    for (const row of data as { id: string; routing_decision: { picked_depth?: unknown } | null }[]) {
      const picked = row.routing_decision?.picked_depth;
      if (picked === "light" || picked === "deep") depths.set(row.id, picked);
    }
  } catch {
  }
  return depths;
}

export async function fetchThreadAgentSlug(threadId: string, tenantId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("agent_threads")
      .select("agent_slug")
      .eq("id", threadId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error || !data) return null;
    const agentSlug = (data as { agent_slug: unknown }).agent_slug;
    return typeof agentSlug === "string" ? agentSlug : null;
  } catch {
    return null;
  }
}

export function fetchThreads(slug: string): Promise<ThreadsResponse> {
  return apiJson<ThreadsResponse>(`/api/agents/${slug}/threads`);
}

export type ChatTopicFields = {
  channels?: string[];
  page_channel?: string;
  page_channel_action_id?: string;
  channel_action_id?: string;
};

export function chatTopicFields(
  topic: { channel?: string; action?: string } | null | undefined,
  slug: string,
): ChatTopicFields {
  if (!topic?.channel) return {};
  return {
    ...(slug === "operator" ? { channels: [topic.channel] } : {}),
    page_channel: topic.channel,
    ...(topic.action ? { page_channel_action_id: topic.action, channel_action_id: topic.action } : {}),
  };
}

export type ChannelThreadsResponse = { threads: { id: string; channel_action_id: string | null }[] };

export function fetchChannelThreads(channel: string, action?: string): Promise<ChannelThreadsResponse> {
  const q = `channel=${encodeURIComponent(channel)}${action ? `&action=${encodeURIComponent(action)}` : ""}`;
  return apiJson<ChannelThreadsResponse>(`/api/workspace/channel-threads?${q}`);
}

export function sendChat(
  slug: string,
  input: {
    message: string;
    thread_id?: string | null;
    image_paths?: string[];
    video_paths?: string[];
    doc_paths?: string[];
    edit_of_message_id?: string;
    depth?: "deep";
    command_slug?: string;
  } & ChatTopicFields,
): Promise<SendChatResponse> {
  return apiJson<SendChatResponse>(`/api/agents/${slug}/chat`, {
    method: "POST",
    body: JSON.stringify(input),
    idempotent: true,
  });
}

export type BuildConfirmStartBody = {
  status?: "started" | "already_started" | "failed" | string;
  run_id?: string;
  message?: string;
  error?: { code?: string; message?: string };
};

export async function startBuildConfirm(
  threadId: string,
  nonce: string,
): Promise<{ status: number; body: BuildConfirmStartBody | null }> {
  const res = await apiFetch(`/api/chat/build-confirm/${encodeURIComponent(threadId)}/start`, {
    method: "POST",
    body: JSON.stringify({ nonce }),
  });
  const text = await res.text();
  let body: BuildConfirmStartBody | null = null;
  try {
    body = text ? (JSON.parse(text) as BuildConfirmStartBody) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

export function markThreadSeen(threadId: string): Promise<void> {
  return apiFetch("/api/workspace/thread-seen", {
    method: "POST",
    body: JSON.stringify({ thread_id: threadId }),
  }).then((res) => {
    if (!res.ok) throw new Error(`thread-seen ${res.status}`);
  });
}

export function submitFeedback(slug: string, text: string): Promise<{ status: string; rule_id?: string }> {
  return apiJson("/api/agents/feedback", { method: "POST", body: JSON.stringify({ slug, text }) });
}

export function attachArtifact(
  artifactId: string,
): Promise<{ kind?: "image" | "doc"; image_path?: string; doc_path?: string; filename?: string }> {
  return apiJson("/api/chat/attach-artifact", {
    method: "POST",
    body: JSON.stringify({ artifact_id: artifactId }),
  });
}

export function fetchRunStatus(runId: string): Promise<RunStatusResponse> {
  return apiJson<RunStatusResponse>(`/api/agents/runs/${runId}`);
}

export function fetchRunProgress(runId: string): Promise<RunProgressResponse> {
  return apiJson<RunProgressResponse>(`/api/agents/runs/${runId}/progress`);
}

export type CancelRunResponse = { ok: boolean; cancelling?: boolean; already_terminal?: boolean };

export function cancelRun(runId: string): Promise<CancelRunResponse> {
  return apiJson<CancelRunResponse>(`/api/agents/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
}
