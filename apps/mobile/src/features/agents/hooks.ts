import { useCallback } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { isSettled } from "../../lib/status";
import {
  fetchAgents,
  fetchChatHistory,
  fetchRunDepths,
  fetchRunProgress,
  fetchRunStatus,
  fetchThreads,
  sendChat,
  type ChatTopicFields,
} from "./api";
import { mergeAgentThreads, pickerSlugs, topicLabel } from "./pickerAgents";
import { agentChannel, channelAgentSlug, channelName } from "../channels/display";
import { useChannelList } from "../channels/hooks";
import type { AgentThreadRow, ChatHistoryResponse, ChatMessage } from "./types";

export const OPERATOR_SLUG = "operator";

export const NEW_THREAD_SLOT = "__new__";

function wireThreadId(slot?: string): string | null {
  return slot && slot !== NEW_THREAD_SLOT ? slot : null;
}

const keys = {
  agents: (tenant: string) => ["agents", tenant] as const,
  history: (tenant: string, slug: string, threadId?: string) =>
    ["chat-history", tenant, slug, threadId ?? "default"] as const,
  threads: (tenant: string, slug: string) => ["threads", tenant, slug] as const,
  run: (runId: string) => ["run", runId] as const,
  runProgress: (runId: string) => ["run-progress", runId] as const,
};

function agentsQuery(tenant: string) {
  return {
    queryKey: keys.agents(tenant),
    queryFn: fetchAgents,
    staleTime: Infinity,
    gcTime: Infinity,
  };
}

export function useAgents() {
  const tenant = useActiveTenant();
  return useQuery({
    ...agentsQuery(tenant),
    select: (d) => d.agents,
    enabled: tenant !== "none",
  });
}

const WATCH_POLL_MS = 3000;

export function useChatHistory(slug: string, threadId?: string, watchUntil = 0) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: keys.history(tenant, slug, threadId),
    queryFn: () => fetchChatHistory(slug, threadId),
    refetchInterval: () => (Date.now() < watchUntil ? WATCH_POLL_MS : false),
    enabled: tenant !== "none" && !!slug && threadId !== NEW_THREAD_SLOT,
  });
}

export function useThreads(slug: string) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: keys.threads(tenant, slug),
    queryFn: () => fetchThreads(slug),
    select: (d) => d.threads,
    enabled: tenant !== "none" && !!slug,
  });
}

export type ChatThreadRow = AgentThreadRow & { slug: string; topic: string | null };

export function useChatThreads() {
  const tenant = useActiveTenant();
  const agents = useAgents();
  const channels = useChannelList();
  const channelAgents = channels
    .rowsFor()
    .filter((r) => !r.comingSoon && !r.planTier)
    .map((r) => channelAgentSlug(r.slug));
  const slugs = pickerSlugs(agents.data, channelAgents);
  const slugsKey = slugs.join(",");
  const combine = useCallback(
    (results: { data?: { threads: AgentThreadRow[] }; isLoading: boolean }[]) => ({
      data: mergeAgentThreads(
        results.map((r, i) => ({ slug: slugs[i], rows: r.data?.threads })),
      ).map((row) => ({
        ...row,
        topic: topicLabel(row.slug, row.channel_slug ?? agentChannel(row.slug), {
          channel: channelName,
          agent: (s) => agents.data?.find((a) => a.slug === s)?.name,
        }),
      })) as ChatThreadRow[],
      isLoading: results.some((r) => r.isLoading),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slugsKey, agents.data],
  );
  return useQueries({
    queries: slugs.map((slug) => ({
      queryKey: keys.threads(tenant, slug),
      queryFn: () => fetchThreads(slug),
      enabled: tenant !== "none",
    })),
    combine,
  });
}

export function useRunStatus(runId: string | null) {
  return useQuery({
    queryKey: keys.run(runId ?? "none"),
    queryFn: () => fetchRunStatus(runId as string),
    enabled: !!runId,
    refetchInterval: (q) => {
      return isSettled(q.state.data?.run) ? false : 2000;
    },
    select: (d) => d.run,
  });
}

export function useRunProgress(runId: string | null) {
  return useQuery({
    queryKey: keys.runProgress(runId ?? "none"),
    queryFn: () => fetchRunProgress(runId as string),
    enabled: !!runId,
    retry: false,
    refetchInterval: (q) =>
      isSettled(q.state.data) ? false : 2000,
  });
}

export function useRunDepths(messages: ChatMessage[], enabled: boolean) {
  const tenant = useActiveTenant();
  const runIds = Array.from(
    new Set(
      messages
        .filter((m) => m.sender_role !== "user" && m.sender_role !== "system" && m.agent_run_id)
        .map((m) => m.agent_run_id as string),
    ),
  ).sort();
  return useQuery({
    queryKey: ["run-depths", tenant, runIds],
    queryFn: () => fetchRunDepths(runIds),
    enabled: enabled && tenant !== "none" && runIds.length > 0,
  });
}

let optimisticSeq = 0;

export function useSendMessage(slug: string, threadId?: string) {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const historyKey = keys.history(tenant, slug, threadId);

  return useMutation({
    mutationFn: (input: {
      message: string;
      image_paths?: string[];
      video_paths?: string[];
      doc_paths?: string[];
      edit_of_message_id?: string;
      command_slug?: string;
    } & ChatTopicFields) =>
      sendChat(slug, { ...input, thread_id: wireThreadId(threadId) }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: historyKey });
      const prev = qc.getQueryData<ChatHistoryResponse>(historyKey);
      const optimistic: ChatMessage = {
        id: `optimistic-${++optimisticSeq}`,
        sender_role: "user",
        body: input.message,
        agent_run_id: null,
        created_at: new Date().toISOString(),
      };
      qc.setQueryData<ChatHistoryResponse>(historyKey, (old) =>
        old
          ? { ...old, messages: [...old.messages, optimistic] }
          : { thread: null, messages: [optimistic] },
      );
      return { prev };
    },
    onError: (_e, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(historyKey, ctx.prev);
      else qc.removeQueries({ queryKey: historyKey });
    },
    onSuccess: (res) => {
      if (threadId !== NEW_THREAD_SLOT) return;
      const adoptedKey = keys.history(tenant, slug, res.thread_id);
      const shown = qc.getQueryData<ChatHistoryResponse>(historyKey);
      if (shown) qc.setQueryData(adoptedKey, shown);
      void qc.invalidateQueries({ queryKey: adoptedKey });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: historyKey });
      qc.invalidateQueries({ queryKey: keys.threads(tenant, slug) });
    },
  });
}

export { keys as agentQueryKeys };
