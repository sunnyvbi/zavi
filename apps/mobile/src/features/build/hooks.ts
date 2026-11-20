import { useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import {
  fetchBuildSessions,
  fetchBuildStatus,
  fetchBuiltinUrl,
  fetchExport,
  fetchMyBuildRatings,
  fetchPublishStatus,
  fetchRefines,
  fetchSiteDesign,
  fetchSiteTemplates,
  fetchSiteTheme,
  fetchVisibility,
} from "./api";
import {
  BUILD_POLL_MS,
  builtinPollInterval,
  REFINES_POLL_MS,
  isRefineBusy,
  isTerminalBuildRun,
  shouldKeepPolling,
  type BuildPreviewKind,
} from "./logic";
import { SITE_DESIGN_POLL_MS, shouldPollDesign } from "./siteDesign";

export const buildKeys = {
  sessions: (tenant: string) => ["build-sessions", tenant] as const,
  status: (tenant: string, runId: string) => ["build-status", tenant, runId] as const,
  refines: (tenant: string, runId: string) => ["build-refines", tenant, runId] as const,
  builtin: (tenant: string) => ["build-builtin-url", tenant] as const,
  publish: (tenant: string, appHost: string) => ["build-publish-status", tenant, appHost] as const,
  visibility: (tenant: string) => ["build-visibility", tenant] as const,
  export: (tenant: string) => ["build-export", tenant] as const,
  design: (tenant: string, runId: string) => ["build-site-design", tenant, runId] as const,
  theme: (tenant: string, appId: string) => ["build-site-theme", tenant, appId] as const,
  ratings: (tenant: string, ids: string) => ["build-ratings", tenant, ids] as const,
};

const noRetryOn4xx = (count: number, err: unknown) => {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) return false;
  return count < 2;
};

export function useBuildSessions() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: buildKeys.sessions(tenant),
    enabled: tenant !== "none",
    queryFn: fetchBuildSessions,
  });
}

export function useBuildStatus(runId: string | null) {
  const tenant = useActiveTenant();
  const settleTicks = useRef(0);
  return useQuery({
    queryKey: buildKeys.status(tenant, runId ?? ""),
    enabled: tenant !== "none" && !!runId,
    queryFn: () => fetchBuildStatus(runId as string),
    retry: noRetryOn4xx,
    refetchInterval: (q) => {
      if (q.state.status === "error") return false;
      const run = q.state.data?.run ?? null;
      const status = run?.status ?? null;
      const kind: BuildPreviewKind = q.state.data?.preview?.kind ?? "none";
      if (q.state.data?.is_current === false) return false;
      settleTicks.current = isTerminalBuildRun(status) ? settleTicks.current + 1 : 0;
      return shouldKeepPolling(status, kind, settleTicks.current) ? BUILD_POLL_MS : false;
    },
  });
}

export function useBuildRefines(runId: string | null) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: buildKeys.refines(tenant, runId ?? ""),
    enabled: tenant !== "none" && !!runId,
    queryFn: () => fetchRefines(runId as string),
    retry: noRetryOn4xx,
    refetchInterval: (q) => (q.state.data && isRefineBusy(q.state.data) ? REFINES_POLL_MS : false),
  });
}

export function useBuiltinUrl(enabled: boolean) {
  const tenant = useActiveTenant();
  const tries = useRef(0);
  const q = useQuery({
    queryKey: buildKeys.builtin(tenant),
    enabled: enabled && tenant !== "none",
    queryFn: async () => {
      const res = await fetchBuiltinUrl();
      tries.current = res?.status === "verifying" ? tries.current + 1 : 0;
      return res;
    },
    retry: noRetryOn4xx,
    refetchInterval: (query) =>
      query.state.status === "error" ? false : builtinPollInterval(query.state.data, tries.current),
  });
  const { refetch } = q;
  const rearm = useCallback(() => {
    tries.current = 0;
    void refetch();
  }, [refetch]);
  return { ...q, rearm };
}

export function usePublishStatus(appHost: string | null) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: buildKeys.publish(tenant, appHost ?? ""),
    enabled: tenant !== "none" && !!appHost,
    queryFn: () => fetchPublishStatus(appHost as string),
    retry: noRetryOn4xx,
  });
}

export function useVisibility(enabled: boolean) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: buildKeys.visibility(tenant),
    enabled: enabled && tenant !== "none",
    queryFn: fetchVisibility,
    retry: noRetryOn4xx,
  });
}

export function useExportRecord(enabled: boolean, runId: string | null) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: [...buildKeys.export(tenant), runId ?? "workspace"] as const,
    enabled: enabled && tenant !== "none",
    queryFn: () => fetchExport(runId),
    retry: noRetryOn4xx,
  });
}

export function useBuildRatings(ids: string[]) {
  const tenant = useActiveTenant();
  const key = [...new Set(ids)].sort().join(",");
  return useQuery({
    queryKey: buildKeys.ratings(tenant, key),
    enabled: tenant !== "none" && key.length > 0,
    queryFn: () => fetchMyBuildRatings(key.split(",")),
    retry: noRetryOn4xx,
  });
}

export function useSiteDesign(runId: string | null, buildActive: boolean) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: buildKeys.design(tenant, runId ?? ""),
    enabled: tenant !== "none" && !!runId,
    queryFn: () => fetchSiteDesign(runId as string),
    retry: noRetryOn4xx,
    refetchInterval: (q) =>
      q.state.status !== "error" && shouldPollDesign(q.state.data ?? null, buildActive) ? SITE_DESIGN_POLL_MS : false,
  });
}

export function useSiteTemplates() {
  return useQuery({
    queryKey: ["site-templates"] as const,
    queryFn: fetchSiteTemplates,
    staleTime: 60 * 60 * 1000,
  });
}

export function useSiteTheme(appId: string | null) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: buildKeys.theme(tenant, appId ?? ""),
    enabled: tenant !== "none" && !!appId,
    queryFn: () => fetchSiteTheme(appId as string),
    retry: noRetryOn4xx,
  });
}
