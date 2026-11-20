import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";

export type Decision = {
  id: string;
  decision_class: string;
  body: unknown;
  status: string;
  agent_slug: string | null;
  thread_id: string | null;
};

function fetchApprovals(): Promise<{ decisions: Decision[] }> {
  return apiJson<{ decisions: Decision[] }>("/api/approvals");
}

export function usePendingApprovals() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["approvals", tenant],
    queryFn: fetchApprovals,
    select: (d) => d.decisions,
    enabled: tenant !== "none",
  });
}

export const pendingCountKey = (tenant: string) => ["status-counters", tenant] as const;

export function usePendingCount() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: pendingCountKey(tenant),
    queryFn: () => apiJson<{ approvals_pending?: number }>("/api/workspace/status-counters"),
    select: (d) => d.approvals_pending ?? 0,
    enabled: tenant !== "none",
    refetchInterval: 30_000,
  });
}

export function usePendingCountBySlug(): Record<string, number> {
  const { data } = usePendingApprovals();
  return useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of data ?? []) {
      if (d.agent_slug) m[d.agent_slug] = (m[d.agent_slug] ?? 0) + 1;
    }
    return m;
  }, [data]);
}

function useInvalidateAfterDecision() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return (decision: Pick<Decision, "agent_slug">) => {
    qc.invalidateQueries({ queryKey: ["approvals", tenant] });
    qc.invalidateQueries({ queryKey: pendingCountKey(tenant) });
    if (decision.agent_slug) {
      qc.invalidateQueries({ queryKey: ["chat-history", tenant, decision.agent_slug] });
      qc.invalidateQueries({ queryKey: ["threads", tenant, decision.agent_slug] });
    }
  };
}

export function useApproveDecision() {
  const invalidate = useInvalidateAfterDecision();
  return useMutation({
    mutationFn: (decision: Decision) =>
      apiJson<unknown>(`/api/approvals/${decision.id}/approve`, { method: "POST" }),
    onSuccess: (_d, decision) => invalidate(decision),
  });
}

export function useRejectDecision() {
  const invalidate = useInvalidateAfterDecision();
  return useMutation({
    mutationFn: (decision: Decision) =>
      apiJson<unknown>(`/api/approvals/${decision.id}/reject`, { method: "POST" }),
    onSuccess: (_d, decision) => invalidate(decision),
  });
}
