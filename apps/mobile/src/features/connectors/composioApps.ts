import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";

export type ComposioToolkit = {
  slug: string;
  name: string;
  logo: string;
  category?: string | null;
  connectable?: boolean;
};

export const REQUESTED_NOTE = "Thanks, we'll let you know when it's ready";
export const MORE_APPS_PAGE = 50;

const key = (tenant: string) => ["composio-toolkits", tenant] as const;

export function useComposioToolkits() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: key(tenant),
    queryFn: async () => {
      const b = await apiJson<{ toolkits?: ComposioToolkit[]; requested?: string[] }>("/api/connectors/composio/toolkits");
      return { toolkits: b?.toolkits ?? [], requested: b?.requested ?? [] };
    },
    enabled: tenant !== "none",
    staleTime: 10 * 60_000,
  });
}

export function useRequestApp() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: (slug: string) =>
      apiJson(`/api/connectors/composio/${encodeURIComponent(slug)}/request`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(tenant) }),
  });
}
