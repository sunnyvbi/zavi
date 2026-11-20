import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import {
  deleteArtifact,
  fetchArtifactDownloadUrl,
  fetchArtifactPreviewUrl,
  fetchArtifacts,
  renameArtifact,
} from "./api";
import type { ArtifactListParams } from "./api";
import type {
  Artifact,
  ArtifactFilter,
  ArtifactsResponse,
  SignedArtifactUrlResponse,
  SiteArtifact,
} from "./types";

const ARTIFACTS_REFRESH_MS = 8 * 60 * 1000;
const NO_SITES: SiteArtifact[] = [];

const keys = {
  all: (tenant: string) => ["artifacts", tenant] as const,
  list: (tenant: string, params: ArtifactListParams) =>
    ["artifacts", tenant, params.q?.trim() ?? "", params.type ?? "all"] as const,
  previewUrl: (tenant: string, id: string) =>
    ["artifact-preview-url", tenant, id] as const,
};

function invalidateArtifacts(queryClient: ReturnType<typeof useQueryClient>, tenant: string) {
  return queryClient.invalidateQueries({ queryKey: keys.all(tenant) });
}

export function useArtifacts(query = "", type: ArtifactFilter = "all") {
  const tenant = useActiveTenant();
  const params = { q: query.trim(), type };
  const result = useQuery<ArtifactsResponse>({
    queryKey: keys.list(tenant, params),
    queryFn: () => fetchArtifacts(params),
    enabled: tenant !== "none",
    retry: 2,
    placeholderData: keepPreviousData,
    refetchOnMount: "always",
    refetchInterval: ARTIFACTS_REFRESH_MS,
  });

  return {
    ...result,
    artifacts: result.data?.artifacts ?? [],
    sites: result.data?.sites ?? NO_SITES,
    expiresIn: result.data?.expires_in,
    retry: result.refetch,
    refresh: result.refetch,
  };
}

export type RenameArtifactInput = {
  id: string;
  title: string;
};

export function useRenameArtifact() {
  const queryClient = useQueryClient();
  const tenant = useActiveTenant();
  const result = useMutation({
    mutationFn: ({ id, title }: RenameArtifactInput) => renameArtifact(id, title),
    onSuccess: () => invalidateArtifacts(queryClient, tenant),
  });

  return { ...result, busy: result.isPending };
}

export function useDeleteArtifact() {
  const queryClient = useQueryClient();
  const tenant = useActiveTenant();
  const result = useMutation({
    mutationFn: (id: string) => deleteArtifact(id),
    onSuccess: () => invalidateArtifacts(queryClient, tenant),
  });

  return { ...result, busy: result.isPending };
}

export function useArtifactPreviewUrl(id: string | null) {
  const tenant = useActiveTenant();
  return useQuery<SignedArtifactUrlResponse>({
    queryKey: keys.previewUrl(tenant, id ?? "none"),
    queryFn: () => fetchArtifactPreviewUrl(id as string),
    enabled: tenant !== "none" && !!id,
  });
}

export function useArtifactDownloadUrl() {
  return useMutation({
    mutationFn: (id: string) => fetchArtifactDownloadUrl(id),
  });
}

export type { Artifact };

export { keys as artifactQueryKeys };
