
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import type { RuleScopeKind } from "./load";

export type RuleStatus = "suggested" | "active" | "dismissed" | "superseded" | "deleted";
export type RuleOrigin =
  | "chat_typed"
  | "slack_typed"
  | "cgo_email_reply"
  | "cgo_slack_reply"
  | "reject_reason"
  | "rules_page"
  | "feedback_command";

export interface RuleRow {
  id: string;
  scope_kind: RuleScopeKind;
  scope_slug: string | null;
  text: string;
  status: RuleStatus;
  origin: string;
  suggested_by: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  supersedes: string | null;
  created_at: string;
  excerpt: string | null;
}

export interface RuleList {
  role: "owner" | "admin" | "member" | "viewer";
  suggestions_paused: boolean;
  rules: RuleRow[];
}

export type RuleErrorCode = "forbidden" | "cap" | "sensitive" | "invalid" | "failed";

export class RuleError extends Error {
  constructor(public code: RuleErrorCode, message: string) {
    super(message);
  }
}

function toRuleError(e: { message?: string; code?: string; hint?: string } | null): RuleError {
  const raw = e?.message ?? "Something went wrong saving the rule.";
  const msg = raw.replace(/^rules:\s*/, "");
  const cap = msg.charAt(0).toUpperCase() + msg.slice(1);
  if (e?.code === "42501") return new RuleError("forbidden", cap);
  if (e?.hint === "rule_cap" || /30 active rules/.test(raw)) return new RuleError("cap", cap);
  if (e?.hint === "sensitive_number" || /card or ID number/.test(raw)) return new RuleError("sensitive", cap);
  if (e?.code === "22023") return new RuleError("invalid", cap);
  return new RuleError("failed", "Something went wrong saving the rule.");
}

async function call<T>(tenantId: string, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), fn, args);
  if (error) throw toRuleError(error as { message?: string; code?: string; hint?: string });
  return data as T;
}

export type RuleResult = { status: string; rule_id?: string; replaced?: string; count?: number };

export function listRules(tenantId: string, actor: string): Promise<RuleList> {
  return call<RuleList>(tenantId, "rule_list", { p_actor: actor });
}

export function addRule(
  tenantId: string,
  actor: string,
  input: {
    text: string;
    scope_kind: RuleScopeKind;
    scope_slug: string | null;
    origin: RuleOrigin;
    source_ref?: string | null;
    source_start?: number | null;
    source_end?: number | null;
    source_hash?: string | null;
    excerpt?: string | null;
    suggested_by?: string | null;
  },
): Promise<RuleResult> {
  return call<RuleResult>(tenantId, "rule_add", {
    p_actor: actor,
    p_text: input.text,
    p_scope_kind: input.scope_kind,
    p_scope_slug: input.scope_kind === "all" ? null : input.scope_slug,
    p_origin: input.origin,
    p_source_ref: input.source_ref ?? null,
    p_source_start: input.source_start ?? null,
    p_source_end: input.source_end ?? null,
    p_source_hash: input.source_hash ?? null,
    p_excerpt: input.excerpt ?? null,
    p_suggested_by: input.suggested_by ?? null,
  });
}

export function activateRule(tenantId: string, actor: string, ruleId: string): Promise<RuleResult> {
  return call<RuleResult>(tenantId, "rule_activate", { p_actor: actor, p_rule_id: ruleId });
}

export function editRule(
  tenantId: string,
  actor: string,
  ruleId: string,
  input: { text: string; scope_kind: RuleScopeKind; scope_slug: string | null },
): Promise<RuleResult> {
  return call<RuleResult>(tenantId, "rule_edit", {
    p_actor: actor,
    p_rule_id: ruleId,
    p_text: input.text,
    p_scope_kind: input.scope_kind,
    p_scope_slug: input.scope_kind === "all" ? null : input.scope_slug,
  });
}

export function dismissRule(tenantId: string, actor: string, ruleId: string): Promise<RuleResult> {
  return call<RuleResult>(tenantId, "rule_dismiss", { p_actor: actor, p_rule_id: ruleId });
}

export function deleteRule(tenantId: string, actor: string, ruleId: string): Promise<RuleResult> {
  return call<RuleResult>(tenantId, "rule_delete", { p_actor: actor, p_rule_id: ruleId });
}

export function deleteAllRules(tenantId: string, actor: string): Promise<RuleResult> {
  return call<RuleResult>(tenantId, "rule_delete_all", { p_actor: actor });
}

export function setSuggestionsPaused(tenantId: string, actor: string, paused: boolean): Promise<RuleResult> {
  return call<RuleResult>(tenantId, "rule_set_suggestions_paused", { p_actor: actor, p_paused: paused });
}
