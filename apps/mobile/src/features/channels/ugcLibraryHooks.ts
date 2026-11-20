import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { IDEMPOTENCY_HEADER, newIdempotencyKey } from "../../lib/apiRetry";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { ugcKey } from "./ugcHooks";
import { keepMetaAdKey, libraryPaths, metaAdBody, youtubeVideoBody, type MetaAdResult, type MetaEligibility, type YoutubeEligibility } from "./ugcLibrary";

export function useMetaEligibility(assetId: string, enabled: boolean) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ugcKey(tenant, "meta-eligibility", assetId),
    enabled: enabled && tenant !== "none" && !!assetId,
    queryFn: () => apiJson<MetaEligibility>(libraryPaths.metaEligibility(assetId)),
  });
}

const metaAdKey = (tenant: string, assetId: string) => ugcKey(tenant, "meta-ad", assetId);

const openKeys = new Map<string, { key: string; body: string }>();

export function useCreateMetaAd(assetId: string) {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  const slot = `${tenant}:${assetId}`;
  return useMutation({
    mutationKey: metaAdKey(tenant, assetId),
    mutationFn: (v: { adSetId: string; message: string }) => {
      const open = openKeys.get(slot) ?? { key: newIdempotencyKey(), body: JSON.stringify(metaAdBody(v.adSetId, v.message)) };
      openKeys.set(slot, open);
      return apiJson<MetaAdResult>(libraryPaths.metaAd(assetId), {
        method: "POST",
        body: open.body,
        headers: { [IDEMPOTENCY_HEADER]: open.key },
        idempotent: true,
      });
    },
    onSuccess: () => {
      openKeys.delete(slot);
      return queryClient.invalidateQueries({ queryKey: ["ugc", tenant] });
    },
    onError: (e) => {
      if (!keepMetaAdKey(e)) openKeys.delete(slot);
      void queryClient.invalidateQueries({ queryKey: ugcKey(tenant, "meta-eligibility", assetId) });
    },
  });
}

export function useMetaAdOpenBody(assetId: string): { ad_set_id: string; message?: string } | null {
  const tenant = useActiveTenant();
  const open = openKeys.get(`${tenant}:${assetId}`);
  if (!open) return null;
  try {
    return JSON.parse(open.body) as { ad_set_id: string; message?: string };
  } catch {
    return null;
  }
}

export function useMetaAdPending(assetId: string): boolean {
  const tenant = useActiveTenant();
  return useIsMutating({ mutationKey: metaAdKey(tenant, assetId) }) > 0;
}

export function useYoutubeEligibility(assetId: string, enabled: boolean) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ugcKey(tenant, "youtube-eligibility", assetId),
    enabled: enabled && tenant !== "none" && !!assetId,
    queryFn: () => apiJson<YoutubeEligibility>(libraryPaths.youtubeEligibility(assetId)),
  });
}

export function useSaveYoutubeVideo(assetId: string) {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paste: string) =>
      apiJson<{ youtube_video_id?: string; note?: string }>(libraryPaths.youtubeVideo(assetId), {
        method: "POST",
        body: JSON.stringify(youtubeVideoBody(paste)),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ugc", tenant] }),
  });
}
