import { useQuery } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";

export type AgentInboxAddress = { agent_slug: string; address: string; from_name: string | null };

export const addressLabel = (a: AgentInboxAddress): string => a.from_name ?? a.agent_slug;

export function useInboxAddresses() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["inbox-addresses", tenant],
    enabled: tenant !== "none",
    queryFn: async () => (await apiJson<{ addresses?: AgentInboxAddress[] }>("/api/workspace/inbox-addresses")).addresses ?? [],
  });
}
