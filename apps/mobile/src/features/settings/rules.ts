import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { rulesKey, type Rule, type RuleList } from "./rulesModel";

export * from "./rulesModel";

export function useRules() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: rulesKey(tenant),
    queryFn: () => apiJson<RuleList>("/api/rules"),
    enabled: tenant !== "none",
  });
}

type ScopeBody = Pick<Rule, "scope_kind" | "scope_slug">;

export type RuleAction =
  | { kind: "add"; text: string; scope: ScopeBody }
  | { kind: "edit"; id: string; text: string; scope: ScopeBody }
  | { kind: "delete"; id: string }
  | { kind: "activate"; id: string }
  | { kind: "dismiss"; id: string }
  | { kind: "deleteAll" }
  | { kind: "pause"; paused: boolean };

function send(a: RuleAction): Promise<unknown> {
  const json = (method: string, body?: unknown) => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
  const id = "id" in a ? encodeURIComponent(a.id) : "";
  switch (a.kind) {
    case "add":
      return apiJson("/api/rules", json("POST", { text: a.text, ...a.scope }));
    case "edit":
      return apiJson(`/api/rules/${id}`, json("PATCH", { text: a.text, ...a.scope }));
    case "delete":
      return apiJson(`/api/rules/${id}`, json("DELETE"));
    case "activate":
      return apiJson(`/api/rules/${id}/activate`, json("POST"));
    case "dismiss":
      return apiJson(`/api/rules/${id}/dismiss`, json("POST"));
    case "deleteAll":
      return apiJson("/api/rules", json("DELETE"));
    case "pause":
      return apiJson("/api/rules/settings", json("PUT", { suggestions_paused: a.paused }));
  }
}

export function useRuleAction() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: send,
    onSettled: () => qc.invalidateQueries({ queryKey: rulesKey(tenant) }),
  });
}
