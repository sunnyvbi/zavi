import { useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiFetchError, apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { ugcKey } from "./ugcHooks";
import {
  QUOTE_PATH,
  applicantsPath,
  closeBriefPath,
  offerDeclinePath,
  offerPath,
  pendingHireKey,
  readPendingHires,
  withPendingHire,
  type BookingQuote,
  type BriefApplicantsResponse,
  type OfferView,
  type PayRequest,
} from "./ugcHire";

const retryRead = (count: number, e: unknown) => count < 2 && !(e instanceof ApiFetchError && e.status < 500);

export function useBriefApplicants(briefId: string) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ugcKey(tenant, "applicants", briefId),
    enabled: tenant !== "none" && !!briefId,
    retry: retryRead,
    queryFn: () => apiJson<BriefApplicantsResponse>(applicantsPath(briefId)),
  });
}

export function useQuote(body: object | null) {
  const tenant = useActiveTenant();
  const json = body ? JSON.stringify(body) : "";
  return useQuery({
    queryKey: ugcKey(tenant, "quote", json),
    enabled: tenant !== "none" && !!body,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: retryRead,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === tenant ? previous : undefined),
    queryFn: async () => (await apiJson<{ quote: BookingQuote }>(QUOTE_PATH, { method: "POST", body: json })).quote,
  });
}

export function useOffer(offerId: string) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ugcKey(tenant, "offer", offerId),
    enabled: tenant !== "none" && !!offerId,
    retry: retryRead,
    queryFn: async () => (await apiJson<{ offer: OfferView }>(offerPath(offerId))).offer,
  });
}

export function usePayCheckout() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (r: PayRequest) => apiJson<unknown>(r.path, { method: "POST", body: JSON.stringify(r.body), retryOnNetworkError: false }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ugc", tenant] });
    },
  });
}

export function useCloseBrief() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (briefId: string) =>
      apiJson<{ undo_message?: string; declined?: number }>(closeBriefPath(briefId), { method: "POST", body: JSON.stringify({}), retryOnNetworkError: false }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ugc", tenant] });
    },
  });
}

export function useDeclineOffer() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (offerId: string) => apiJson(offerDeclinePath(offerId), { method: "POST", body: JSON.stringify({}), retryOnNetworkError: false }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ugc", tenant] });
    },
  });
}

export function usePendingHires() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ugcKey(tenant, "pending-hires"),
    enabled: tenant !== "none",
    staleTime: 0,
    queryFn: async () => readPendingHires(await AsyncStorage.getItem(pendingHireKey(tenant)).catch(() => null)),
  });
}

export function useRememberHire(): (tenant: string, applicationId: string, orderId: string) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    async (tenant: string, applicationId: string, orderId: string) => {
      try {
        const key = pendingHireKey(tenant);
        const next = withPendingHire(await AsyncStorage.getItem(key), applicationId, orderId);
        await AsyncStorage.setItem(key, next);
        queryClient.setQueryData(ugcKey(tenant, "pending-hires"), readPendingHires(next));
      } catch {
      }
    },
    [queryClient],
  );
}
