const GUARD_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "data_access_refused",
  "operator_db_read_rejected",
  "tenant_tool_deny",
  "pm_operator_db_policy",
  "memory_grounding_policy",
  "web_search_policy",
  "preview_readonly",
  "cto_info_readonly",
  "best_of_n_draft_readonly",
  "connector_wall_chat_degrade_readonly",
  "sandbox_egress_blocked",
  "sandbox_secret_read_blocked",
  "egress_denied_untrusted_inbound",
]);

export function isGuardRefusal(code: unknown): boolean {
  return typeof code === "string" && GUARD_REFUSAL_CODES.has(code);
}

export function recordGuardDeny<R extends { reason?: string; hookSpecificOutput?: unknown }>(
  codes: Map<string, string>,
  input: unknown,
  result: R,
): R {
  const id = (input as { tool_use_id?: unknown } | null)?.tool_use_id;
  const decision = (result?.hookSpecificOutput as { permissionDecision?: unknown } | undefined)?.permissionDecision;
  if (typeof id === "string" && decision === "deny" && isGuardRefusal(result.reason)) codes.set(id, result.reason as string);
  return result;
}
