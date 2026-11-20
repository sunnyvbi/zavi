
export type PlaceholderSlug = "ops" | "policies" | "disputes" | "support";

const PLACEHOLDER_TOPICS: Record<PlaceholderSlug, [heading: string, topics: string]> = {
  ops: ["Operating priorities", "which work comes first, spend caps per decision and per day, and who we escalate to"],
  policies: ["Policies", "our refund window, KYC requirements, dispute defaults, and anything we never do"],
  disputes: ["Disputes", "when we refund, when we chargeback-defend, when we ban a user, and 1-2 example scenarios"],
  support: ["Support", "response-time targets, our most common issues, and what gets escalated to the founder"],
};

export function placeholderBody(slug: PlaceholderSlug, shape: string): string {
  const [heading, topics] = PLACEHOLDER_TOPICS[slug];
  return `# ${heading}\n\nWe haven't written this yet. Edit this anchor to add: ${topics}. Until you fill this in, the agent fleet will fall back to category defaults for ${shape}.`;
}
