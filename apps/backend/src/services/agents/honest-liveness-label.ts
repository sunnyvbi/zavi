
export type HonestLivenessTier = "shipped" | "answered" | "plan_only" | "empty" | null | undefined;

export type LabeledTier = "plan_only" | "empty";

export const HONEST_LABEL_EXCLUDED_AGENTS: ReadonlySet<string> = new Set<string>(["engineer"]);

export function shouldHonestLabel(args: {
  enabled: boolean;
  agentSlug: string | null | undefined;
  tier: HonestLivenessTier;
  isError: boolean;
}): args is { enabled: true; agentSlug: string | null | undefined; tier: LabeledTier; isError: false } {
  if (!args.enabled) return false;
  if (args.isError) return false;
  if (args.agentSlug && HONEST_LABEL_EXCLUDED_AGENTS.has(args.agentSlug)) return false;
  return args.tier === "plan_only" || args.tier === "empty";
}
