import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { agentQueryKeys } from "./hooks";
import type { ThreadsResponse } from "./types";

export const THREAD_TITLE_MAX = 120;

const pinsKey = (tenant: string) => `zavi.pins.${tenant}`;

export function usePinnedThreads() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["pinned-threads", tenant],
    enabled: tenant !== "none",
    staleTime: Infinity,
    queryFn: async (): Promise<string[]> => {
      try {
        const raw = await AsyncStorage.getItem(pinsKey(tenant));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return [];
      }
    },
  });
}

export function useTogglePin() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const key = ["pinned-threads", tenant];
  return useMutation({
    mutationFn: async (threadId: string) => {
      const prev = qc.getQueryData<string[]>(key) ?? [];
      const next = prev.includes(threadId)
        ? prev.filter((id) => id !== threadId)
        : [threadId, ...prev];
      qc.setQueryData(key, next);
      await AsyncStorage.setItem(pinsKey(tenant), JSON.stringify(next));
      return next;
    },
  });
}

export function useRenameThread(slug: string) {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: ({ threadId, title }: { threadId: string; title: string }) =>
      apiJson<{ renamed: boolean; title: string }>(
        `/api/agents/${slug}/threads/${encodeURIComponent(threadId)}`,
        { method: "PATCH", body: JSON.stringify({ title: title.trim() }) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentQueryKeys.threads(tenant, slug) }),
  });
}

export function useDeleteThread(slug: string) {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const unpin = useTogglePin();
  return useMutation({
    mutationFn: (threadId: string) =>
      apiJson<{ deleted: boolean }>(`/api/agents/${slug}/threads/${encodeURIComponent(threadId)}`, {
        method: "DELETE",
      }),
    onSuccess: (_res, threadId) => {
      const pins = qc.getQueryData<string[]>(["pinned-threads", tenant]) ?? [];
      if (pins.includes(threadId)) unpin.mutate(threadId);
      qc.setQueryData<ThreadsResponse>(agentQueryKeys.threads(tenant, slug), (d) =>
        d ? { ...d, threads: d.threads.filter((t) => t.id !== threadId) } : d,
      );
      qc.removeQueries({ queryKey: agentQueryKeys.history(tenant, slug, threadId) });
      void qc.invalidateQueries({ queryKey: agentQueryKeys.threads(tenant, slug) });
    },
  });
}
