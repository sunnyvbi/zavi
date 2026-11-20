import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { fetchChannels } from "../channels/api";
import type { ChannelsResponse } from "../channels/types";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { adsQuery, lockOf, normalizeAds, normalizeGeo, normalizeSearch, type RangeKey } from "./model";

const TIMEOUT_MS = 60_000;

async function getJson(path: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await apiJson<unknown>(path, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function useChannelLocks() {
  const tenant = useActiveTenant();
  const q = useQuery<ChannelsResponse>({
    queryKey: ["channels", tenant, "list"],
    queryFn: fetchChannels,
    enabled: tenant !== "none",
  });
  const locks = q.data?.channel_locks ?? null;
  const both = (a: string, b: string) => {
    const la = lockOf(locks, a);
    const lb = lockOf(locks, b);
    return la && lb ? la : null;
  };
  return {
    ready: q.isSuccess || q.isError,
    adsLock: both("meta_ads", "google_ads"),
    searchLock: lockOf(locks, "seo"),
    aiLock: lockOf(locks, "geo"),
    refetch: q.refetch,
  };
}

const adsKey = (tenant: string, range: RangeKey) => ["analytics-ads", tenant, range] as const;
const PERF = "/api/agents/performance-marketer/dashboard";

export function useAdsDashboard(range: RangeKey, enabled: boolean) {
  const tenant = useActiveTenant();
  const client = useQueryClient();
  const q = useQuery({
    queryKey: adsKey(tenant, range),
    enabled: enabled && tenant !== "none",
    staleTime: 5 * 60_000,
    queryFn: async () => normalizeAds(await getJson(`${PERF}?${adsQuery(range, new Date())}`)),
  });

  const healed = useRef(new Set<string>());
  useEffect(() => {
    const key = `${tenant}:${range}`;
    if (!q.data?.stale || healed.current.has(key)) return;
    healed.current.add(key);
    getJson(`${PERF}?${adsQuery(range, new Date(), true)}`)
      .then((raw) => client.setQueryData(adsKey(tenant, range), normalizeAds(raw)))
      .catch(() => {});
  }, [q.data?.stale, tenant, range, client]);

  const refresh = async () => {
    const raw = await getJson(`${PERF}?${adsQuery(range, new Date(), true)}`);
    client.setQueryData(adsKey(tenant, range), normalizeAds(raw));
  };
  return { ...q, refresh };
}

export function useSeoGeoDashboard(enabled: boolean) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["analytics-seo-geo", tenant],
    enabled: enabled && tenant !== "none",
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const raw = await getJson("/api/agents/seo-geo/dashboard");
      return { search: normalizeSearch(raw), geo: normalizeGeo(raw) };
    },
  });
}
