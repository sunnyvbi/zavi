import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import type { ThreadMessage } from "./ugc";
import { buildCreatorInbox, inviteMessagesPath, inviteUuidOf, type CreatorEntry } from "./ugcInbox";
import { ugcKey, useJobs, useNotices, useThreads } from "./ugcHooks";

const messageOf = (e: unknown): string | null => (e ? (e instanceof Error && e.message ? e.message : "Couldn't load this.") : null);

export function useCreatorInbox(): {
  entries: CreatorEntry[] | null;
  error: string | null;
  isRefetching: boolean;
  refetch: () => Promise<unknown>;
} {
  const threads = useThreads();
  const jobs = useJobs();
  const notices = useNotices();
  const entries = threads.data && jobs.data ? buildCreatorInbox(threads.data, jobs.data, notices.data?.notifications ?? []) : null;
  const error = jobs.isError ? messageOf(jobs.error) : threads.isError ? messageOf(threads.error) : null;
  return {
    entries,
    error,
    isRefetching: threads.isRefetching || jobs.isRefetching || notices.isRefetching,
    refetch: () => Promise.all([threads.refetch(), jobs.refetch(), notices.refetch()]),
  };
}

export type InviteMessage = ThreadMessage & { emailed?: boolean };

export function useInviteMessages(memberId: string) {
  const tenant = useActiveTenant();
  const path = inviteMessagesPath(memberId);
  return useQuery({
    queryKey: ugcKey(tenant, "invite-messages", inviteUuidOf(memberId) ?? "none"),
    enabled: tenant !== "none" && !!path,
    queryFn: async () => (await apiJson<{ messages: InviteMessage[] }>(path as string)).messages ?? [],
  });
}

export function useSendInviteMessage() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (v: { memberId: string; body: string }) => {
      const path = inviteMessagesPath(v.memberId);
      if (!path) throw new Error("Couldn't send. Try again.");
      return apiJson<{ message?: InviteMessage; email_note?: string }>(path, {
        method: "POST",
        body: JSON.stringify({ body: v.body }),
        retryOnNetworkError: false,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ugc", tenant] }),
  });
}
