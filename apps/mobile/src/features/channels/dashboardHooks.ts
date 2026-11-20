import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { dashboardPath } from "./dashboardRanges";

const dashKey = (tenant: string, slug: string, days: number) => ["channel-dashboard", tenant, slug, days] as const;

export function useChannelDashboard(slug: string, enabled: boolean, days = 30) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: dashKey(tenant, slug, days),
    enabled: enabled && tenant !== "none" && !!slug,
    queryFn: () => apiJson<unknown>(dashboardPath(slug, days)),
  });
}

export function useRefreshChannelDashboard(slug: string, days = 30) {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return async () => {
    const data = await apiJson<unknown>(dashboardPath(slug, days, true), { retryOnNetworkError: false });
    queryClient.setQueryData(dashKey(tenant, slug, days), data);
    return data;
  };
}
