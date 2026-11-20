
export type RuleSuggestion = {
  rule_id: string;
  text: string;
  scope_kind: "all" | "agent" | "channel";
  scope_slug: string | null;
  agent_slug: string | null;
};

export function parseRuleSuggestion(raw: unknown): RuleSuggestion | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.rule_id !== "string" || !r.rule_id) return undefined;
  if (typeof r.text !== "string" || !r.text) return undefined;
  const scope_kind = r.scope_kind === "agent" || r.scope_kind === "channel" ? r.scope_kind : "all";
  return {
    rule_id: r.rule_id,
    text: r.text,
    scope_kind,
    scope_slug: scope_kind === "all" || typeof r.scope_slug !== "string" ? null : r.scope_slug,
    agent_slug: typeof r.agent_slug === "string" && r.agent_slug ? r.agent_slug : null,
  };
}
