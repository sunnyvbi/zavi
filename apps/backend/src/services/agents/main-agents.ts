export const MAIN_AGENT_SLUGS: readonly string[] = [
  "operator",
  "pm",
  "engineer",
  "cgo",
] as const;

export function isMainAgentSlug(slug: string): boolean {
  return MAIN_AGENT_SLUGS.includes(slug);
}
