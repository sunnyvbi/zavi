
export const SHADOW_CANARY_AGENTS: ReadonlySet<string> = new Set([
  "research",
  "growth-lead",
  "performance-marketer",
]);

export const SHADOW_CANARY_CONVERSATIONAL_EXCLUDE: ReadonlySet<string> = new Set([
  "pm",
  "chief-of-staff",
  "support-lead",
  "advisor",
  "operator",
]);

export function isShadowCanaryAgent(slug: string): boolean {
  return SHADOW_CANARY_AGENTS.has((slug ?? "").trim());
}

export function isShadowCanaryConversationalExcluded(slug: string): boolean {
  return SHADOW_CANARY_CONVERSATIONAL_EXCLUDE.has((slug ?? "").trim());
}
