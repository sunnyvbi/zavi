
export const AGENT_SLUG = "content-design";
export const OLD_AGENT_SLUG = "content-seo";

export const DECISION_CLASS = "content-design.propose-change";
export const OLD_DECISION_CLASS = "content-seo.publish-content";

export const DECISION_CLASSES = [DECISION_CLASS, OLD_DECISION_CLASS] as const;

export const AGENT_SLUG_ALIASES: Readonly<Record<string, string>> = {
  [OLD_AGENT_SLUG]: AGENT_SLUG,
};

export function canonicalAgentSlug(slug: string): string {
  return AGENT_SLUG_ALIASES[slug] ?? slug;
}
