import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { GADS_SLUG, type GadsPayload } from "./googleAds";

const gadsKey = (tenant: string, days: number) => ["google-ads-dashboard", tenant, days] as const;

export function useGoogleAdsDashboard(days: number, enabled = true) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: gadsKey(tenant, days),
    enabled: enabled && tenant !== "none",
    queryFn: () => apiJson<GadsPayload>(`/api/agents/${GADS_SLUG}/dashboard?days=${days}`),
  });
}

export function useRefreshGoogleAds(days: number) {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return async () => {
    const data = await apiJson<GadsPayload>(`/api/agents/${GADS_SLUG}/dashboard?days=${days}&refresh=1`);
    queryClient.setQueryData(gadsKey(tenant, days), data);
    return data;
  };
}

export async function saveMonthlyPlan(usd: number | null): Promise<string | null> {
  try {
    const res = await apiFetch(`/api/channels/${GADS_SLUG}/monthly-budget`, {
      method: "PUT",
      body: JSON.stringify({ usd }),
      retryOnNetworkError: false,
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return body.error?.message ?? `Could not save (${res.status}).`;
  } catch {
    return "Could not save. Check your connection and try again.";
  }
}
