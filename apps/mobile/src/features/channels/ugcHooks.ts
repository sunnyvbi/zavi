import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BriefRow, BriefWorkbench } from "./ugcBrief";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { useWorkspace } from "../workspaces/WorkspaceProvider";
import { putItems, type SettingItem } from "./channelSettings";
import {
  deliveryOrderIds,
  latestVideoCount,
  searchPath,
  videosDelivered,
  type CreatorCard,
  type CreatorSearchResponse,
  type FindFilters,
  type JobDetail,
  type JobSummary,
  type Brief,
  type LibraryAsset,
  type Notice,
  type ThreadMessage,
  type ThreadOffer,
  type ThreadSummary,
} from "./ugc";
import type { OfferCheck } from "./ugcOffers";

const INVITE_PREFIX = "invite:";
export const isInviteId = (id: string): boolean => id.startsWith(INVITE_PREFIX);
const inviteIdOf = (id: string): string => id.slice(INVITE_PREFIX.length);

export const enc = encodeURIComponent;
export const ugcKey = (tenant: string, ...rest: Array<string | number>) => ["ugc", tenant, ...rest] as const;
const key = ugcKey;

export function useCanWrite(): boolean {
  const { tenants, activeTenantId } = useWorkspace();
  const role = tenants.find((t) => t.tenant_id === activeTenantId)?.role;
  return (role ?? "").toLowerCase() !== "viewer";
}

export function useCreatorSearch(filters: FindFilters, enabled = true) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant, "search", searchPath(filters)),
    enabled: enabled && tenant !== "none",
    staleTime: 60_000,
    placeholderData: (previous) => previous,
    queryFn: () => apiJson<CreatorSearchResponse>(searchPath(filters)),
  });
}

export function useCreatorCard(id: string) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant, "card", id),
    enabled: tenant !== "none" && !!id,
    staleTime: 60_000,
    queryFn: async () => {
      const path = isInviteId(id)
        ? `/api/humans/creators/invites/${enc(inviteIdOf(id))}/card`
        : `/api/humans/creators/${enc(id)}/card`;
      const body = await apiJson<{ creator: CreatorCard }>(path);
      return body.creator;
    },
  });
}

export function useThreads() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant, "threads"),
    enabled: tenant !== "none",
    refetchInterval: 30_000,
    queryFn: async () => (await apiJson<{ threads: ThreadSummary[] }>("/api/creators/threads")).threads ?? [],
  });
}

export function useJobs(enabled = true) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant, "jobs"),
    enabled: enabled && tenant !== "none",
    refetchInterval: 60_000,
    queryFn: async () => (await apiJson<{ jobs: JobSummary[] }>("/api/humans/orders")).jobs ?? [],
  });
}

export function useUnreadCount(): number {
  const threads = useThreads();
  return (threads.data ?? []).reduce((n, t) => n + (t.unread_count ?? 0), 0);
}

export function useJobDetail(id: string) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant, "job", id),
    enabled: tenant !== "none" && !!id,
    queryFn: () => apiJson<JobDetail>(`/api/humans/orders/${enc(id)}`),
  });
}

export function useThreadMessages(threadId: string | null) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant, "messages", threadId ?? "none"),
    enabled: tenant !== "none" && !!threadId,
    refetchInterval: 10_000,
    queryFn: async () =>
      (await apiJson<{ messages: ThreadMessage[] }>(`/api/creators/threads/${enc(threadId ?? "")}/messages`)).messages ?? [],
  });
}

export function useThreadOffers(threadId: string | null) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant, "offers", threadId ?? "none"),
    enabled: tenant !== "none" && !!threadId,
    queryFn: async () =>
      (await apiJson<{ offers: ThreadOffer[] }>(`/api/creators/threads/${enc(threadId ?? "")}/offers`)).offers ?? [],
  });
}

export function useSendMessage() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (v: { memberId: string; threadId: string | null; body: string }) => {
      const body = JSON.stringify({ body: v.body });
      if (isInviteId(v.memberId)) {
        await apiJson(`/api/creators/invites/${enc(inviteIdOf(v.memberId))}/messages`, { method: "POST", body });
      } else if (v.threadId) {
        await apiJson(`/api/creators/threads/${enc(v.threadId)}/messages`, { method: "POST", body });
      } else {
        await apiJson(`/api/creators/${enc(v.memberId)}/threads`, { method: "POST", body });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ugc", tenant] }),
  });
}

export function useNotices() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant, "notices"),
    enabled: tenant !== "none",
    refetchInterval: 60_000,
    queryFn: () => apiJson<{ notifications: Notice[]; unread: number }>("/api/humans/notifications"),
  });
}

export function useMarkNoticesRead() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[] | "all") =>
      apiJson("/api/humans/notifications/read", { method: "POST", body: JSON.stringify(ids === "all" ? { all: true } : { ids }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(tenant, "notices") }),
  });
}

export function useBriefs(enabled = true) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant, "briefs"),
    enabled: enabled && tenant !== "none",
    refetchInterval: 60_000,
    queryFn: async () => (await apiJson<{ briefs: Brief[] }>("/api/humans/briefs")).briefs ?? [],
  });
}

export function useLibrary(enabled = true) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant, "library"),
    enabled: enabled && tenant !== "none",
    staleTime: 60_000,
    queryFn: async () => (await apiJson<{ assets: LibraryAsset[] }>("/api/creators/library")).assets ?? [],
  });
}

export async function libraryDownloadUrl(assetId: string): Promise<string> {
  const body = await apiJson<{ url: string }>(`/api/creators/library/${enc(assetId)}/download`);
  return body.url;
}

export function useChannelSettings(slug: string) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant, "settings", slug),
    enabled: tenant !== "none",
    queryFn: async () => (await apiJson<{ fields?: Record<string, SettingItem[]> }>(`/api/channels/${enc(slug)}/settings`)).fields ?? {},
  });
}

export function useSaveSetting(slug: string) {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { fieldId: string; items: SettingItem[] }) =>
      apiJson(`/api/channels/${enc(slug)}/settings/${enc(v.fieldId)}`, { method: "PUT", body: JSON.stringify({ items: putItems(v.items) }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(tenant, "settings", slug) }),
  });
}

export function useBriefWorkbench(id: string | null) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant, "workbench", id ?? "new"),
    enabled: tenant !== "none" && !!id,
    queryFn: () => apiJson<BriefWorkbench>(`/api/humans/briefs/${enc(id ?? "")}/workbench`),
  });
}

export function useSaveBrief() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string | null; input: object }): Promise<string> => {
      if (!v.id) {
        const r = await apiJson<{ brief: BriefRow }>("/api/humans/briefs", { method: "POST", body: JSON.stringify(v.input) });
        return r.brief.id;
      }
      await apiJson(`/api/humans/briefs/${enc(v.id)}`, { method: "PATCH", body: JSON.stringify(v.input) });
      return v.id;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ugc", tenant] }),
  });
}

export function usePublishBrief() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiJson(`/api/humans/briefs/${enc(id)}/publish`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ugc", tenant] }),
  });
}

export function useRepostBrief() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await apiJson<{ brief: BriefRow }>(`/api/humans/briefs/${enc(id)}/repost`, { method: "POST", body: JSON.stringify({}), idempotent: true })).brief.id,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ugc", tenant] }),
  });
}

export function useDeliveredVideos(enabled: boolean): { videos: number | null; ready: boolean } {
  const tenant = useActiveTenant();
  const jobs = useJobs(enabled);
  const library = useLibrary(enabled);
  const ids = jobs.data && library.data ? deliveryOrderIds(jobs.data, library.data) : null;
  const q = useQuery({
    queryKey: key(tenant, "delivered-videos", ids ? ids.join(",") : ""),
    enabled: enabled && tenant !== "none" && ids !== null,
    staleTime: 60_000,
    queryFn: async () => {
      const details = await Promise.all((ids as string[]).map((id) => apiJson<JobDetail>(`/api/humans/orders/${enc(id)}`).catch(() => null)));
      const counts: Record<string, number> = {};
      (ids as string[]).forEach((id, i) => {
        const d = details[i];
        if (d) counts[id] = latestVideoCount(d.submissions ?? []);
      });
      return videosDelivered(jobs.data ?? [], library.data ?? [], counts);
    },
  });
  return { videos: q.data ?? null, ready: !!jobs.data && !!library.data && !q.isLoading };
}

export function useSendOffer() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (v: { memberId: string; threadId: string | null; body: NonNullable<OfferCheck["body"]> }) => {
      const body = JSON.stringify(v.body);
      const path = v.threadId ? `/api/creators/threads/${enc(v.threadId)}/offers` : `/api/creators/${enc(v.memberId)}/offers`;
      return apiJson<{ offer?: { thread_id?: string | null } }>(path, { method: "POST", body, retryOnNetworkError: false });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ugc", tenant] }),
  });
}

export function useWithdrawOffer() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (offerId: string) => apiJson(`/api/creators/offers/${enc(offerId)}/withdraw`, { method: "POST", body: JSON.stringify({}), retryOnNetworkError: false }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ugc", tenant] }),
  });
}
