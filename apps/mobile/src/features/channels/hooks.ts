import { useCallback, useEffect, useMemo, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { pendingCountKey } from "../approvals/hooks";
import {
  approveAction,
  approveChange,
  dismissAction,
  fetchChannelHistory,
  fetchChannelMetrics,
  fetchChannelLane,
  fetchChannelApprovals,
  fetchChannels,
  redoAction,
  runChannel,
  saveActionSteps,
} from "./api";
import { getChannel } from "@zavi/shared";
import { buildChannelRows } from "./channelList";
import {
  buildChannelList,
  channelName,
  pendingCountsFrom,
  readyCountFrom,
  toChannelAction,
  type SeenCounts,
} from "./display";
import type {
  ApprovalsResponse,
  ActionSource,
  ChannelAction,
  ChannelDecision,
  ChannelsResponse,
} from "./types";

const keys = {
  all: (tenant: string) => ["channels", tenant] as const,
  approvals: (tenant: string) => ["approvals", tenant] as const,
  list: (tenant: string) => ["channels", tenant, "list"] as const,
  actions: (tenant: string, slug: string) =>
    ["channels", tenant, "actions", slug] as const,
  action: (tenant: string, id: string) =>
    ["channels", tenant, "action", id] as const,
  page: (tenant: string, slug: string, part: string) => ["channels", tenant, "page", slug, part] as const,
};

const seenKey = (tenant: string) => `zavi.channelSeen.${tenant}`;

function useSeenChannels(approvals: ApprovalsResponse | undefined) {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  const { data: seen } = useQuery({
    queryKey: ["channel-seen", tenant],
    enabled: tenant !== "none",
    staleTime: Infinity,
    queryFn: async (): Promise<SeenCounts> => {
      try {
        const raw = await AsyncStorage.getItem(seenKey(tenant));
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" ? (parsed as SeenCounts) : {};
      } catch {
        return {};
      }
    },
  });

  const save = useCallback(
    (next: SeenCounts) => {
      queryClient.setQueryData(["channel-seen", tenant], next);
      void AsyncStorage.setItem(seenKey(tenant), JSON.stringify(next)).catch(() => {});
    },
    [queryClient, tenant],
  );

  const pending = useMemo(() => pendingCountsFrom(approvals), [approvals]);

  useEffect(() => {
    if (!seen || !approvals) return;
    const lowered = Object.entries(seen).filter(([slug, count]) => (pending[slug] ?? 0) < count);
    if (lowered.length === 0) return;
    save({ ...seen, ...Object.fromEntries(lowered.map(([slug]) => [slug, pending[slug] ?? 0])) });
  }, [seen, approvals, pending, save]);

  const markSeen = useCallback(
    (slug: string) => {
      const count = pending[slug] ?? 0;
      if (!seen || seen[slug] === count) return;
      save({ ...seen, [slug]: count });
    },
    [pending, seen, save],
  );

  return { seen: seen ?? {}, markSeen };
}

function invalidateChannels(queryClient: QueryClient, tenant: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.all(tenant) }),
    queryClient.invalidateQueries({ queryKey: keys.approvals(tenant) }),
    queryClient.invalidateQueries({ queryKey: pendingCountKey(tenant) }),
  ]);
}

function useApprovals() {
  const tenant = useActiveTenant();
  return useQuery<ApprovalsResponse>({
    queryKey: keys.approvals(tenant),
    queryFn: () => fetchChannelApprovals(),
    enabled: tenant !== "none",
  });
}

export function useChannelList() {
  const tenant = useActiveTenant();
  const approvals = useApprovals();
  const channels = useQuery<ChannelsResponse>({
    queryKey: keys.list(tenant),
    queryFn: fetchChannels,
    enabled: tenant !== "none",
  });

  const { seen, markSeen } = useSeenChannels(approvals.data);

  const items = useMemo(
    () => (approvals.data ? buildChannelList(channels.data?.channels, approvals.data, seen) : []),
    [approvals.data, channels.data, seen],
  );

  const pending = useMemo(() => pendingCountsFrom(approvals.data), [approvals.data]);

  return {
    items,
    rowsFor: (order?: readonly string[]) =>
      approvals.data
        ? buildChannelRows({
            registry: (slug) => {
              const c = getChannel(slug);
              return c ? { name: channelName(slug), description: c.description, category: c.category, section: c.section } : null;
            },
            channels: channels.data?.channels,
            pending,
            seen,
            order,
          })
        : [],
    tenantTier: channels.data?.tenant_tier ?? null,
    viewOf: (slug: string) => channels.data?.channels.find((c) => c.channel_slug === slug) ?? null,
    markSeen,
    readyCount: readyCountFrom(approvals.data, seen),
    isLoading: approvals.isLoading || channels.isLoading,
    isError: approvals.isError,
    isRefetching: approvals.isRefetching || channels.isRefetching,
    refetch: () => Promise.all([approvals.refetch(), channels.refetch()]),
  };
}

export function useChannelsReadyCount(): number {
  const { data } = useApprovals();
  const { seen } = useSeenChannels(data);
  return readyCountFrom(data, seen);
}

export function useChannelActions(slug: string, enabled: boolean) {
  const tenant = useActiveTenant();
  const lane = useChannelLane(slug);
  const ranked = lane.data?.store === "channel_actions";
  const approvals = useQuery<ApprovalsResponse>({
    queryKey: keys.actions(tenant, slug),
    queryFn: () => fetchChannelApprovals(slug),
    enabled: enabled && tenant !== "none" && !!lane.data && !ranked,
  });

  const actions = useMemo(
    () =>
      (ranked ? lane.data?.decisions ?? [] : approvals.data?.decisions ?? [])
        .map((d) => toChannelAction({ ...d, channel_slug: d.channel_slug ?? slug }))
        .filter((a): a is ChannelAction => a !== null),
    [ranked, lane.data, approvals.data, slug],
  );

  const doneKey = `${tenant}:${slug}`;
  const lastDone = useRef<{ key: string; rows: ChannelDecision[] }>({ key: doneKey, rows: [] });
  if (lane.data?.done) lastDone.current = { key: doneKey, rows: lane.data.done };
  const doneRows = lastDone.current.key === doneKey ? lastDone.current.rows : [];
  const done = useMemo(
    () =>
      doneRows
        .map((d) => toChannelAction({ ...d, channel_slug: d.channel_slug ?? slug }))
        .filter((a): a is ChannelAction => a !== null),
    [doneRows, slug],
  );

  if (__DEV__ && lane.data) console.log(`[next-steps] ${slug} store=${lane.data.store} lane=${lane.data.decisions.length} approvals=${approvals.data?.decisions.length ?? "-"} shown=${actions.length}`);
  const laneRefetch = lane.refetch;
  const approvalsRefetch = approvals.refetch;
  const refetch = useCallback(async () => {
    await laneRefetch();
    if (!ranked) await approvalsRefetch();
  }, [laneRefetch, approvalsRefetch, ranked]);

  return {
    actions,
    isLoading: lane.isLoading || (!ranked && !!lane.data && approvals.isLoading),
    isError: lane.isError || (!ranked && approvals.isError),
    refetch,
    ranked,
    zaviCount: lane.data?.zaviCount ?? 0,
    done,
  };
}

function findCachedDecision(
  queryClient: QueryClient,
  tenant: string,
  id: string,
): ChannelDecision | undefined {
  const cached = [
    ...queryClient.getQueriesData<ApprovalsResponse>({ queryKey: keys.approvals(tenant) }),
    ...queryClient.getQueriesData<ApprovalsResponse>({ queryKey: keys.all(tenant) }),
  ];
  for (const [, data] of cached) {
    const found = Array.isArray(data?.decisions)
      ? data.decisions.find((d) => d.id === id)
      : undefined;
    if (found) return found;
  }
  return undefined;
}

export function useChannelAction(id: string) {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  const cached = findCachedDecision(queryClient, tenant, id);

  const result = useQuery<ChannelDecision | null>({
    queryKey: keys.action(tenant, id),
    queryFn: async () => {
      const all = await fetchChannelApprovals();
      const found = all.decisions.find((d) => d.id === id);
      if (found || !cached?.channel_slug) return found ?? null;
      const byChannel = await fetchChannelApprovals(cached.channel_slug);
      return byChannel.decisions.find((d) => d.id === id) ?? null;
    },
    initialData: cached,
    initialDataUpdatedAt: 0,
    enabled: tenant !== "none" && !!id,
  });

  const action = useMemo(
    () => (result.data ? toChannelAction(result.data) : null),
    [result.data],
  );

  return {
    action,
    isLoading: result.isLoading,
    isError: result.isError,
    refetch: result.refetch,
  };
}

export type ApproveActionInput = {
  id: string;
  payloadText?: string;
  source?: ActionSource;
};

export function useApproveAction() {
  const queryClient = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: ({ id, payloadText, source }: ApproveActionInput) => approveAction(id, payloadText, source),
    onSuccess: () => invalidateChannels(queryClient, tenant),
  });
}

export function useApproveChange() {
  const queryClient = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: (id: string) => approveChange(id),
    onSuccess: () => invalidateChannels(queryClient, tenant),
  });
}

export type RedoActionInput = {
  id: string;
  message: string;
  source?: ActionSource;
};

export function useRedoAction() {
  const queryClient = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: ({ id, message, source }: RedoActionInput) => redoAction(id, message, source),
    onSuccess: () => invalidateChannels(queryClient, tenant),
  });
}

export function useRunChannel() {
  const queryClient = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: (slug: string) => runChannel(slug),
    onSuccess: () => invalidateChannels(queryClient, tenant),
  });
}

export type SaveStepsInput = { id: string; stepsDone: number[] };

export function useSaveActionSteps() {
  const queryClient = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: ({ id, stepsDone }: SaveStepsInput) => saveActionSteps(id, stepsDone),
    onSuccess: () => invalidateChannels(queryClient, tenant),
  });
}

export { keys as channelQueryKeys };

export function useChannelMetrics(slug: string) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: keys.page(tenant, slug, "metrics"),
    queryFn: () => fetchChannelMetrics(slug),
    enabled: tenant !== "none" && !!slug,
  });
}

export function useChannelHistory(slug: string, working: boolean) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: keys.page(tenant, slug, "history"),
    queryFn: () => fetchChannelHistory(slug),
    enabled: tenant !== "none" && !!slug,
    refetchInterval: working ? 20_000 : false,
  });
}

function useChannelLane(slug: string) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: keys.page(tenant, slug, "plan"),
    queryFn: () => fetchChannelLane(slug),
    enabled: tenant !== "none" && !!slug,
  });
}

export function useChannelPlan(slug: string) {
  const lane = useChannelLane(slug);
  return { ...lane, data: lane.data?.plan ?? null };
}

export function useChannelKinds(slug: string): Record<string, string> {
  return useChannelLane(slug).data?.types ?? {};
}

export function useDismissChannelAction() {
  const queryClient = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: { action: "rejected" | "snoozed"; note?: string; until?: string } }) =>
      dismissAction(id, reason),
    onSuccess: () => invalidateChannels(queryClient, tenant),
  });
}
