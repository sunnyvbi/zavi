
export type ScopeKind = "all" | "agent" | "channel";

export type Rule = {
  id: string;
  scope_kind: ScopeKind;
  scope_slug: string | null;
  text: string;
  status: "active" | "suggested";
  origin: string;
  created_by: string | null;
  approved_at: string | null;
  created_at: string;
  excerpt: string | null;
};

export type RuleList = { role: string; suggestions_paused: boolean; rules: Rule[] };

export const RULE_MAX = 280;
export const RULE_CAP = 30;

export const rulesKey = (tenant: string) => ["rules", tenant] as const;

const ORIGIN_LABEL: Record<string, string> = {
  chat_typed: "From a chat",
  slack_typed: "From Slack",
  cgo_email_reply: "From an email reply",
  cgo_slack_reply: "From a Slack reply",
  reject_reason: "From a rejected action",
  rules_page: "Added here",
  feedback_command: "From /feedback",
  imported_rules_tab: "From an agent's old Rules tab",
  moved_from_personalization: "Moved from Personalization",
};

export function scopeKey(kind: ScopeKind, slug: string | null): string {
  return kind === "all" ? "all" : `${kind}:${slug}`;
}

export function parseScope(key: string): { scope_kind: ScopeKind; scope_slug: string | null } {
  if (key === "all") return { scope_kind: "all", scope_slug: null };
  const i = key.indexOf(":");
  return { scope_kind: key.slice(0, i) as ScopeKind, scope_slug: key.slice(i + 1) };
}

export function scopeLabel(
  key: string,
  names: { channel: (slug: string) => string | undefined; agent: (slug: string) => string },
): string {
  const { scope_kind, scope_slug } = parseScope(key);
  if (scope_kind === "all") return "All agents";
  if (scope_kind === "channel") return names.channel(scope_slug ?? "") ?? scope_slug ?? "";
  return names.agent(scope_slug ?? "");
}

export function ruleMeta(r: Rule, scope: string, now: Date = new Date()): string {
  const fallback = r.status === "active" ? "Saved" : "Suggested";
  const iso = r.status === "active" ? r.approved_at ?? r.created_at : r.created_at;
  return [scope, ORIGIN_LABEL[r.origin] ?? fallback, ruleDay(iso, now)].filter(Boolean).join(" · ");
}

export function ruleDay(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const month = d.toLocaleDateString("en-US", { month: "long" });
  return d.getFullYear() === now.getFullYear() ? `${month} ${d.getDate()}` : `${month} ${d.getDate()}, ${d.getFullYear()}`;
}

export function splitRules(list: RuleList | undefined): { active: Rule[]; pending: Rule[] } {
  const rules = list?.rules ?? [];
  return { active: rules.filter((r) => r.status === "active"), pending: rules.filter((r) => r.status === "suggested") };
}

export function ruleRights(role: string | null | undefined): { canManage: boolean; canSuggest: boolean } {
  const canManage = role === "owner" || role === "admin";
  return { canManage, canSuggest: canManage || role === "member" };
}

export function scopeOptions(
  agentSlugs: readonly string[],
  channels: readonly { slug: string; name: string }[],
  agentName: (slug: string) => string,
): { agents: { key: string; label: string }[]; channels: { key: string; label: string }[] } {
  const channelSlugs = new Set(channels.map((c) => c.slug));
  const agents = [...new Set(agentSlugs)]
    .filter((s) => !channelSlugs.has(s))
    .map((s) => ({ key: `agent:${s}`, label: agentName(s) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { agents, channels: channels.map((c) => ({ key: `channel:${c.slug}`, label: c.name })) };
}
