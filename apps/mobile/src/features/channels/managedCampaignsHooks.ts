import type { CampaignLocation } from "@zavi/shared";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { API_BASE, EMPTY_OPTIONS, type Campaign, type Entity, type ResourceOptions } from "./managedCampaigns";

export async function campaignFetch<T = unknown>(path: string, init?: { method?: "POST"; body?: unknown; requestId?: string }): Promise<T> {
  const write = init?.method === "POST";
  const res = await apiFetch(path, {
    method: init?.method ?? "GET",
    ...(write ? { body: JSON.stringify(init?.body ?? {}), retryOnNetworkError: false } : {}),
    ...(init?.requestId ? { headers: { "Idempotency-Key": init.requestId } } : {}),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("The server response could not be read. Refresh before retrying.");
  }
  if (!res.ok) {
    const message = (body as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(message ?? "The request could not be completed. Refresh before retrying.");
  }
  return body as T;
}

export function useEntities(campaigns: readonly Campaign[], level: "ad_group" | "ad" | null, days: number, version: number) {
  const tenant = useActiveTenant();
  const ids = campaigns.map((c) => c.id).join(",");
  return useQuery({
    queryKey: ["managed-entities", tenant, level, days, ids, version],
    enabled: tenant !== "none" && level !== null && campaigns.length > 0,
    queryFn: async (): Promise<Entity[]> => {
      const out: Entity[] = [];
      for (let i = 0; i < campaigns.length; i += 4) {
        const batch = await Promise.all(
          campaigns.slice(i, i + 4).map((c) => campaignFetch<{ rows: Entity[] }>(`${API_BASE}/campaigns/${encodeURIComponent(c.id)}/entities?level=${level}&days=${days}`)),
        );
        out.push(...batch.flatMap((b) => b.rows));
      }
      return out;
    },
  });
}

export function useCampaignDetail(id: string | null, version: number) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["managed-campaign", tenant, id, version],
    enabled: tenant !== "none" && !!id,
    queryFn: async () => (await campaignFetch<{ campaign: Campaign }>(`${API_BASE}/campaigns/${encodeURIComponent(id ?? "")}`)).campaign,
  });
}

export function useResources(enabled: boolean) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["managed-resources", tenant],
    enabled: tenant !== "none" && enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ResourceOptions> => {
      try {
        return await campaignFetch<ResourceOptions>(`${API_BASE}/resources`);
      } catch {
        return { ...EMPTY_OPTIONS, warnings: ["Zavi could not verify tracking, audiences or product feeds. Standard click and view campaigns remain available."] };
      }
    },
  });
}

export type Wallet = { balance_cents: number; reserved_cents: number; available_cents: number; pending: boolean; last_error: string | null };

export function useWallet(enabled: boolean) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["managed-wallet", tenant],
    enabled: tenant !== "none" && enabled,
    queryFn: () => campaignFetch<Wallet>(`${API_BASE}/wallet`),
  });
}

export type ReportRow = Partial<Record<"impressions" | "clicks" | "spend" | "ctr", number>> & { label: string };
export type Report = { rows: ReportRow[]; period: { from: string; to: string; timezone: string } };

export function useReport(campaignId: string | null, breakdown: "daily" | "country", days: number) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["managed-report", tenant, campaignId, breakdown, days],
    enabled: tenant !== "none" && !!campaignId,
    queryFn: async () => {
      const r = await campaignFetch<Report>(`${API_BASE}/campaigns/${encodeURIComponent(campaignId ?? "")}/report?breakdown=${breakdown}&days=${days}`);
      if (!r || !Array.isArray(r.rows) || !r.period) throw new Error("Performance response could not be read.");
      return r;
    },
  });
}

export type Place = CampaignLocation;

export async function searchLocations(query: string): Promise<Place[]> {
  const r = await campaignFetch<{ locations: Place[] }>(`${API_BASE}/locations?q=${encodeURIComponent(query)}`);
  return r.locations;
}
